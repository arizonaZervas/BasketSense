import {
  extractReceiptWithGemini,
  RECEIPT_EXTRACTION_SCHEMA_VERSION,
} from "../../../workers/receipt-ingestion/src/extraction";

export const dynamic = "force-dynamic";

const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const ALLOWED_RECEIPT_FILE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

interface RuntimeEnv {
  DB?: D1Database;
  RECEIPTS?: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

type Authorization = {
  householdId: string;
  memberId: string;
  tripId: string;
};

type IngestionRow = {
  id: string;
  household_id: string;
  trip_id: string;
  client_request_id: string;
  source_storage_key: string;
  source_content_type: string;
  source_byte_size: number;
  status: string;
  revision: number;
  attempt_count: number;
  workflow_instance_id: string | null;
  extraction_artifact_key: string | null;
  receipt_transaction_id: string | null;
  error_code: string | null;
  updated_at: string;
};

type ReceiptUploadRow = {
  id: string;
  storage_key: string;
};

class IngestionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function responseJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function authenticatedEmail(request: Request) {
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();
  if (!email) throw new IngestionApiError(401, "ChatGPT sign-in is required");
  return email.slice(0, 320);
}

async function runtime() {
  const workersRuntime = (await import("cloudflare:workers")) as unknown as {
    env: RuntimeEnv;
  };
  if (!workersRuntime.env.DB) {
    throw new IngestionApiError(503, "Household storage is unavailable");
  }
  if (!workersRuntime.env.RECEIPTS) {
    throw new IngestionApiError(503, "Private receipt file storage is unavailable");
  }
  return {
    db: workersRuntime.env.DB,
    bucket: workersRuntime.env.RECEIPTS,
    geminiApiKey: workersRuntime.env.GEMINI_API_KEY?.trim() || null,
    geminiModel: workersRuntime.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
  };
}

async function ensureIngestionSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS receipt_ingestions (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      requested_by_member_id TEXT,
      client_request_id TEXT NOT NULL,
      source_storage_key TEXT NOT NULL,
      source_sha256 TEXT,
      source_content_type TEXT NOT NULL,
      source_byte_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      revision INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      workflow_instance_id TEXT,
      provider TEXT,
      model TEXT,
      prompt_version TEXT,
      schema_version TEXT,
      extraction_artifact_key TEXT,
      receipt_transaction_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_ingestions_household_request_unique
      ON receipt_ingestions (household_id, client_request_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_ingestions_source_key_unique
      ON receipt_ingestions (source_storage_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS receipt_ingestions_household_status_idx
      ON receipt_ingestions (household_id, status, updated_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS receipt_ingestions_trip_idx
      ON receipt_ingestions (trip_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS receipt_ingestions_receipt_idx
      ON receipt_ingestions (receipt_transaction_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS receipt_uploads (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      receipt_transaction_id TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'stored',
      uploaded_by_member_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_receipt_unique
      ON receipt_uploads (receipt_transaction_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_storage_key_unique
      ON receipt_uploads (storage_key)`),
  ]);
}

async function authorizeTrip(db: D1Database, email: string, tripId: string) {
  const row = await db
    .prepare(
      `SELECT trips.household_id AS household_id, household_members.id AS member_id,
              trips.id AS trip_id
       FROM trips
       INNER JOIN household_members
         ON household_members.household_id = trips.household_id
       WHERE trips.id = ? AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(tripId, email)
    .first<Authorization>();
  if (!row) throw new IngestionApiError(404, "Trip not found");
  return row;
}

async function authorizeIngestion(db: D1Database, email: string, ingestionId: string) {
  const row = await db
    .prepare(
      `SELECT receipt_ingestions.*
       FROM receipt_ingestions
       INNER JOIN household_members
         ON household_members.household_id = receipt_ingestions.household_id
       WHERE receipt_ingestions.id = ?
         AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(ingestionId, email)
    .first<IngestionRow>();
  if (!row) throw new IngestionApiError(404, "Receipt upload not found");
  return row;
}

function requiredText(value: FormDataEntryValue | string | null, field: string, max = 180) {
  if (typeof value !== "string" || !value.trim()) {
    throw new IngestionApiError(400, `${field} is required`);
  }
  const cleaned = value.trim();
  if (cleaned.length > max) throw new IngestionApiError(400, `${field} is too long`);
  return cleaned;
}

function safeFilename(value: string) {
  const cleaned = value.replace(/[\r\n\0]/g, " ").trim();
  return (cleaned || "costco-receipt").slice(0, 180);
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicIngestion(row: IngestionRow, draft?: unknown) {
  return {
    id: row.id,
    tripId: row.trip_id,
    status: row.status,
    attemptCount: row.attempt_count,
    canRetry: row.status === "failed",
    error: row.status === "failed" ? row.error_code : null,
    updatedAt: row.updated_at,
    draft,
  };
}

function parseArtifact(value: unknown) {
  const artifact = value as {
    draft?: {
      purchasedAt?: string | null;
      subtotalCents?: number | null;
      taxCents?: number | null;
      totalCents?: number | null;
      discountCents?: number | null;
      warnings?: unknown;
      lines?: Array<{
        itemNumber?: string | null;
        rawDescription?: string;
        quantityMilli?: number;
        lineSubtotalCents?: number;
        netAmountCents?: number;
        discountCents?: number;
        taxStatus?: "taxable" | "non_taxable" | "unknown";
      }>;
    };
  };
  if (!artifact.draft || !Array.isArray(artifact.draft.lines)) {
    throw new IngestionApiError(502, "Receipt draft is incomplete; please retry the upload");
  }
  return {
    purchasedAt: artifact.draft.purchasedAt ?? null,
    subtotalCents: artifact.draft.subtotalCents ?? null,
    taxCents: artifact.draft.taxCents ?? null,
    totalCents: artifact.draft.totalCents ?? null,
    discountCents: artifact.draft.discountCents ?? 0,
    warnings: Array.isArray(artifact.draft.warnings)
      ? artifact.draft.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 12)
      : [],
    items: artifact.draft.lines.map((line) => ({
      itemNumber: line.itemNumber ?? null,
      rawDescription: line.rawDescription ?? "Unlabeled receipt line",
      quantityMilli: line.quantityMilli ?? 1000,
      lineSubtotalCents: line.lineSubtotalCents ?? line.netAmountCents ?? 0,
      netAmountCents: line.netAmountCents ?? line.lineSubtotalCents ?? 0,
      discountCents: line.discountCents ?? 0,
      taxStatus: line.taxStatus ?? "unknown",
      kind: (line.discountCents ?? 0) > 0 && (line.lineSubtotalCents ?? 0) === 0 ? "discount" : "item",
    })),
  };
}

async function readArtifact(bucket: R2Bucket, row: IngestionRow) {
  if (row.status !== "awaiting_review" || !row.extraction_artifact_key) return undefined;
  const object = await bucket.get(row.extraction_artifact_key);
  if (!object) throw new IngestionApiError(502, "Receipt draft is no longer available; please retry the upload");
  return parseArtifact(await object.json());
}

async function nativeExtractReceipt({
  db,
  bucket,
  ingestion,
  apiKey,
  model,
}: {
  db: D1Database;
  bucket: R2Bucket;
  ingestion: IngestionRow;
  apiKey: string;
  model: string;
}) {
  if (ingestion.status === "awaiting_review") return ingestion;
  const claimed = await db
    .prepare(`UPDATE receipt_ingestions
      SET status = 'extracting', attempt_count = attempt_count + 1,
          error_code = NULL, updated_at = ?
      WHERE id = ? AND status IN ('uploaded', 'failed')`)
    .bind(new Date().toISOString(), ingestion.id)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) {
    return (await db
      .prepare(`SELECT * FROM receipt_ingestions WHERE id = ? LIMIT 1`)
      .bind(ingestion.id)
      .first<IngestionRow>()) ?? ingestion;
  }

  try {
    const source = await bucket.get(ingestion.source_storage_key);
    if (!source) throw new Error("source_missing");
    const extracted = await extractReceiptWithGemini({
      apiKey,
      model,
      contentType: ingestion.source_content_type,
      bytes: await source.arrayBuffer(),
    });
    const artifactKey = `households/${ingestion.household_id}/receipt-ingestions/${ingestion.id}/gemini-draft.json`;
    await bucket.put(
      artifactKey,
      JSON.stringify({
        provider: "gemini",
        model,
        schemaVersion: RECEIPT_EXTRACTION_SCHEMA_VERSION,
        responseId: extracted.responseId,
        draft: extracted.draft,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const now = new Date().toISOString();
    await db
      .prepare(`UPDATE receipt_ingestions
        SET status = 'awaiting_review', provider = 'gemini', model = ?,
            prompt_version = 'costco-receipt-extraction-v1',
            schema_version = ?, extraction_artifact_key = ?,
            error_code = NULL, completed_at = ?, updated_at = ?
        WHERE id = ?`)
      .bind(model, RECEIPT_EXTRACTION_SCHEMA_VERSION, artifactKey, now, now, ingestion.id)
      .run();
  } catch {
    await db
      .prepare(`UPDATE receipt_ingestions
        SET status = 'failed', error_code = 'Receipt reader could not produce a reliable draft',
            updated_at = ?
        WHERE id = ?`)
      .bind(new Date().toISOString(), ingestion.id)
      .run();
  }

  return (await db
    .prepare(`SELECT * FROM receipt_ingestions WHERE id = ? LIMIT 1`)
    .bind(ingestion.id)
    .first<IngestionRow>()) ?? ingestion;
}

function handleError(error: unknown) {
  if (error instanceof IngestionApiError) {
    return responseJson({ error: error.message }, error.status);
  }
  console.error("BasketSense receipt ingestion API error");
  return responseJson({ error: "Unable to save the receipt for review" }, 500);
}

export async function POST(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const { db, bucket, geminiApiKey, geminiModel } = await runtime();
    await ensureIngestionSchema(db);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new IngestionApiError(400, "Upload must be a receipt file");
    }
    const tripId = requiredText(form.get("tripId"), "tripId", 128);
    const clientRequestId = requiredText(form.get("clientRequestId"), "clientRequestId", 128);
    const receiptFile = form.get("file") ?? form.get("image");
    if (!(receiptFile instanceof File)) {
      throw new IngestionApiError(400, "Choose a receipt photo or PDF");
    }
    const contentType = receiptFile.type.toLowerCase();
    if (!ALLOWED_RECEIPT_FILE_TYPES.has(contentType)) {
      throw new IngestionApiError(415, "Receipt file must be a PDF, JPEG, PNG, HEIC, or WebP");
    }
    if (receiptFile.size <= 0 || receiptFile.size > MAX_RECEIPT_FILE_BYTES) {
      throw new IngestionApiError(413, "Receipt file must be 8 MB or smaller");
    }
    const authorization = await authorizeTrip(db, email, tripId);
    const existing = await db
      .prepare(`SELECT * FROM receipt_ingestions
        WHERE household_id = ? AND client_request_id = ? LIMIT 1`)
      .bind(authorization.householdId, clientRequestId)
      .first<IngestionRow>();
    if (existing) {
      if (existing.trip_id !== authorization.tripId) {
        throw new IngestionApiError(409, "This receipt upload is already linked to another trip");
      }
      const processed = geminiApiKey
        ? await nativeExtractReceipt({ db, bucket, ingestion: existing, apiKey: geminiApiKey, model: geminiModel })
        : existing;
      return responseJson({
        ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
        reused: true,
        queued: false,
        configurationMissing: !geminiApiKey,
      }, 202);
    }
    const ingestionId = crypto.randomUUID();
    const storageKey = `households/${authorization.householdId}/receipt-ingestions/${ingestionId}/source`;
    const sourceSha256 = await sha256Hex(receiptFile);
    const now = new Date().toISOString();
    await bucket.put(storageKey, receiptFile.stream(), {
      httpMetadata: { contentType },
      customMetadata: {
        householdId: authorization.householdId,
        ingestionId,
        sourceFilename: safeFilename(receiptFile.name),
      },
    });
    try {
      await db
        .prepare(`INSERT INTO receipt_ingestions (
          id, household_id, trip_id, requested_by_member_id, client_request_id,
          source_storage_key, source_sha256, source_content_type, source_byte_size,
          status, revision, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 1, 0, ?, ?)`)
        .bind(
          ingestionId,
          authorization.householdId,
          authorization.tripId,
          authorization.memberId,
          clientRequestId,
          storageKey,
          sourceSha256,
          contentType,
          receiptFile.size,
          now,
          now,
        )
        .run();
    } catch (error) {
      await bucket.delete(storageKey);
      throw error;
    }
    const created = await authorizeIngestion(db, email, ingestionId);
    const processed = geminiApiKey
      ? await nativeExtractReceipt({ db, bucket, ingestion: created, apiKey: geminiApiKey, model: geminiModel })
      : created;
    return responseJson(
      {
        ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
        queued: false,
        configurationMissing: !geminiApiKey,
      },
      202,
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const ingestionId = requiredText(new URL(request.url).searchParams.get("id"), "id", 128);
    const { db, bucket } = await runtime();
    await ensureIngestionSchema(db);
    const ingestion = await authorizeIngestion(db, email, ingestionId);
    const draft = await readArtifact(bucket, ingestion);
    return responseJson({ ingestion: publicIngestion(ingestion, draft) });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const { db } = await runtime();
    await ensureIngestionSchema(db);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.action !== "link_receipt") {
      throw new IngestionApiError(400, "Unsupported receipt upload action");
    }
    const ingestionId = requiredText(typeof body.ingestionId === "string" ? body.ingestionId : null, "ingestionId", 128);
    const receiptId = requiredText(typeof body.receiptId === "string" ? body.receiptId : null, "receiptId", 128);
    const ingestion = await authorizeIngestion(db, email, ingestionId);
    const receipt = await db
      .prepare(`SELECT receipt_transactions.id, receipt_transactions.household_id, receipt_transactions.trip_id,
                household_members.id AS member_id
         FROM receipt_transactions
         INNER JOIN household_members ON household_members.household_id = receipt_transactions.household_id
         WHERE receipt_transactions.id = ? AND lower(household_members.user_email) = ?
         LIMIT 1`)
      .bind(receiptId, email)
      .first<{ id: string; household_id: string; trip_id: string | null; member_id: string }>();
    if (!receipt || receipt.household_id !== ingestion.household_id || receipt.trip_id !== ingestion.trip_id) {
      throw new IngestionApiError(404, "Receipt not found");
    }
    const existingUpload = await db
      .prepare(`SELECT * FROM receipt_uploads WHERE receipt_transaction_id = ? LIMIT 1`)
      .bind(receipt.id)
      .first<ReceiptUploadRow>();
    if (existingUpload?.storage_key && existingUpload.storage_key !== ingestion.source_storage_key) {
      throw new IngestionApiError(409, "This receipt already has a different original file");
    }
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`INSERT INTO receipt_uploads (
        id, household_id, receipt_transaction_id, storage_key, original_filename,
        content_type, byte_size, status, uploaded_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?)
      ON CONFLICT(receipt_transaction_id) DO UPDATE SET
        storage_key = excluded.storage_key,
        original_filename = excluded.original_filename,
        content_type = excluded.content_type,
        byte_size = excluded.byte_size,
        status = 'stored',
        uploaded_by_member_id = excluded.uploaded_by_member_id,
        updated_at = excluded.updated_at`)
        .bind(
          existingUpload?.id ?? crypto.randomUUID(),
          ingestion.household_id,
          receipt.id,
          ingestion.source_storage_key,
          "costco-receipt",
          ingestion.source_content_type,
          ingestion.source_byte_size,
          receipt.member_id,
          now,
          now,
        ),
      db.prepare(`UPDATE receipt_ingestions
        SET receipt_transaction_id = ?, updated_at = ?
        WHERE id = ? AND household_id = ?`)
        .bind(receipt.id, now, ingestion.id, ingestion.household_id),
    ]);
    return responseJson({ linked: true, receiptId: receipt.id });
  } catch (error) {
    return handleError(error);
  }
}
