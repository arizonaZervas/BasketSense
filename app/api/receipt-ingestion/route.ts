import {
  extractReceiptWithGemini,
  ReceiptExtractionError,
  receiptExtractionErrorCode,
  RECEIPT_EXTRACTION_SCHEMA_VERSION,
} from "../../../workers/receipt-ingestion/src/extraction";
import {
  PRODUCT_UNDERSTANDING_SCHEMA_VERSION,
  understandReceiptProducts,
} from "../../../workers/receipt-ingestion/src/product-understanding";
import { ensureBasketSenseSchemaUpgrades } from "../../database-schema-upgrades";
import { isReceiptUploadContentType } from "../../receipt-upload-formats";

export const dynamic = "force-dynamic";

const MAX_RECEIPT_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
interface RuntimeEnv {
  DB?: D1Database;
  RECEIPTS?: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_RECOVERY_MODEL?: string;
}

type Authorization = {
  householdId: string;
  memberId: string;
  tripId: string | null;
  receiptId: string | null;
};

type IngestionRow = {
  id: string;
  household_id: string;
  trip_id: string | null;
  client_request_id: string;
  source_storage_key: string;
  source_content_type: string;
  source_byte_size: number;
  status: string;
  revision: number;
  attempt_count: number;
  workflow_instance_id: string | null;
  extraction_artifact_key: string | null;
  recovery_manifest_key: string | null;
  receipt_transaction_id: string | null;
  error_code: string | null;
  provider_response_id: string | null;
  provider_finish_reason: string | null;
  provider_duration_ms: number | null;
  extraction_pass: number | null;
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
    geminiRecoveryModel:
      workersRuntime.env.GEMINI_RECOVERY_MODEL?.trim() ||
      workersRuntime.env.GEMINI_MODEL?.trim() ||
      DEFAULT_GEMINI_MODEL,
  };
}

async function ensureIngestionSchema(db: D1Database) {
  await ensureBasketSenseSchemaUpgrades(db);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS receipt_ingestions (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      trip_id TEXT,
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
      recovery_manifest_key TEXT,
      extraction_artifact_key TEXT,
      receipt_transaction_id TEXT,
      error_code TEXT,
      provider_response_id TEXT,
      provider_finish_reason TEXT,
      provider_duration_ms INTEGER,
      extraction_pass INTEGER,
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
      `SELECT trips.household_id AS householdId, household_members.id AS memberId,
              trips.id AS tripId
       FROM trips
       INNER JOIN household_members
         ON household_members.household_id = trips.household_id
       WHERE trips.id = ? AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(tripId, email)
    .first<Authorization>();
  if (!row) throw new IngestionApiError(404, "Trip not found");
  return { ...row, receiptId: null };
}

async function authorizeStandaloneReceipt(
  db: D1Database,
  email: string,
  receiptId: string,
) {
  const row = await db
    .prepare(
      `SELECT receipt_transactions.household_id AS householdId,
              household_members.id AS memberId,
              receipt_transactions.id AS receiptId
       FROM receipt_transactions
       INNER JOIN household_members
         ON household_members.household_id = receipt_transactions.household_id
       WHERE receipt_transactions.id = ?
         AND receipt_transactions.trip_id IS NULL
         AND receipt_transactions.source_type = 'receipt_photo'
         AND receipt_transactions.transaction_type IN ('warehouse', 'return')
         AND receipt_transactions.parse_status = 'needs_review'
         AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(receiptId, email)
    .first<Omit<Authorization, "tripId">>();
  if (!row) throw new IngestionApiError(404, "Standalone receipt not found");
  return { ...row, tripId: null };
}

async function authorizeHistoricalReceiptCorrection(
  db: D1Database,
  email: string,
  receiptId: string,
) {
  const row = await db
    .prepare(
      `SELECT receipt_transactions.household_id AS householdId,
              household_members.id AS memberId,
              receipt_transactions.trip_id AS tripId,
              receipt_transactions.id AS receiptId
       FROM receipt_transactions
       INNER JOIN trips ON trips.id = receipt_transactions.trip_id
       INNER JOIN household_members
         ON household_members.household_id = receipt_transactions.household_id
       WHERE receipt_transactions.id = ?
         AND receipt_transactions.trip_id IS NOT NULL
         AND receipt_transactions.source_type = 'receipt_photo'
         AND receipt_transactions.parse_status != 'rejected'
         AND trips.status = 'completed'
         AND household_members.role = 'owner'
         AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(receiptId, email)
    .first<Authorization>();
  if (!row) throw new IngestionApiError(404, "Completed trip receipt not found");
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

export function receiptIngestionUploadTarget(form: FormData):
  | { tripId: string; receiptId: null }
  | { tripId: null; receiptId: string } {
  const rawTripId = form.get("tripId");
  const rawReceiptId = form.get("receiptId");
  const tripId = typeof rawTripId === "string" && rawTripId.trim()
    ? requiredText(rawTripId, "tripId", 128)
    : null;
  const receiptId = typeof rawReceiptId === "string" && rawReceiptId.trim()
    ? requiredText(rawReceiptId, "receiptId", 128)
    : null;
  if ((tripId === null) === (receiptId === null)) {
    throw new IngestionApiError(400, "Choose either tripId or receiptId for this upload");
  }
  return tripId ? { tripId, receiptId: null } : { tripId: null, receiptId: receiptId as string };
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
  const errorMessages: Record<string, string> = {
    provider_http: "The private receipt reader was temporarily unavailable.",
    empty_output: "The receipt reader returned no usable draft.",
    invalid_json: "The receipt reader returned an incomplete draft.",
    output_truncated: "The receipt reader ran out of room while reading this long receipt.",
    schema_validation: "The receipt reader could not safely validate the extracted values.",
    unreadable_image: "No reliable totals or product lines were readable from this file.",
    source_missing: "The saved private receipt file could not be reopened.",
    unknown: "The receipt reader could not produce a reliable draft.",
  };
  const providerConfigurationRejected =
    row.error_code === "provider_http" &&
    row.provider_finish_reason?.startsWith("HTTP_400");
  return {
    id: row.id,
    tripId: row.trip_id,
    receiptId: row.receipt_transaction_id,
    status: row.status,
    attemptCount: row.attempt_count,
    canRetry: row.status === "failed",
    error:
      row.status === "failed"
        ? providerConfigurationRejected
          ? "The receipt reader rejected its current configuration."
          : errorMessages[row.error_code ?? "unknown"] ?? errorMessages.unknown
        : null,
    errorCode: row.status === "failed" ? row.error_code : null,
    extractionPass: row.extraction_pass,
    updatedAt: row.updated_at,
    draft,
  };
}

export function receiptIngestionRetryDisposition(status: string) {
  if (status === "awaiting_review") return "ready" as const;
  if (status === "extracting") return "busy" as const;
  if (status === "uploaded" || status === "failed") return "retry" as const;
  return "unavailable" as const;
}

export function parseArtifact(value: unknown) {
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
        understanding?: {
          canonicalName?: string | null;
          brand?: string | null;
          productFamily?: string | null;
          variant?: string | null;
          categoryHint?: string | null;
          confidenceBps?: number | null;
          source?: "catalog" | "gemini";
          model?: string | null;
        };
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
      interpretedName: line.understanding?.canonicalName ?? null,
      interpretedBrand: line.understanding?.brand ?? null,
      interpretedProductFamily: line.understanding?.productFamily ?? null,
      interpretedVariant: line.understanding?.variant ?? null,
      interpretationCategoryHint: line.understanding?.categoryHint ?? null,
      interpretationConfidenceBps: line.understanding?.confidenceBps ?? null,
      interpretationSource: line.understanding?.source ?? null,
      interpretationModel: line.understanding?.model ?? null,
      kind:
        (line.discountCents ?? 0) > 0 &&
        (line.netAmountCents ?? line.lineSubtotalCents ?? 0) < 0
          ? "discount"
          : "item",
    })),
  };
}

async function readArtifact(bucket: R2Bucket, row: IngestionRow) {
  if (row.status !== "awaiting_review" || !row.extraction_artifact_key) return undefined;
  const object = await bucket.get(row.extraction_artifact_key);
  if (!object) throw new IngestionApiError(502, "Receipt draft is no longer available; please retry the upload");
  return parseArtifact(await object.json());
}

type RecoveryManifest = {
  assets: Array<{ key: string; contentType: string; byteSize: number }>;
};

async function readRecoverySources(bucket: R2Bucket, ingestion: IngestionRow) {
  if (!ingestion.recovery_manifest_key) return [];
  const manifestObject = await bucket.get(ingestion.recovery_manifest_key);
  if (!manifestObject) return [];
  const manifest = (await manifestObject.json()) as RecoveryManifest;
  if (!Array.isArray(manifest.assets)) return [];
  const sources: Array<{ contentType: string; bytes: ArrayBuffer }> = [];
  for (const asset of manifest.assets.slice(0, 7)) {
    if (!asset || typeof asset.key !== "string" || typeof asset.contentType !== "string") continue;
    const object = await bucket.get(asset.key);
    if (!object) continue;
    sources.push({ contentType: asset.contentType, bytes: await object.arrayBuffer() });
  }
  return sources;
}

async function nativeExtractReceipt({
  db,
  bucket,
  ingestion,
  apiKey,
  model,
  recoveryModel,
}: {
  db: D1Database;
  bucket: R2Bucket;
  ingestion: IngestionRow;
  apiKey: string;
  model: string;
  recoveryModel: string;
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
    if (!source) {
      throw new ReceiptExtractionError("source_missing", "Receipt source is missing");
    }
    const originalBytes = await source.arrayBuffer();
    let firstPass: Awaited<ReturnType<typeof extractReceiptWithGemini>> | null = null;
    let firstError: unknown = null;
    try {
      firstPass = await extractReceiptWithGemini({
        apiKey,
        model,
        contentType: ingestion.source_content_type,
        bytes: originalBytes,
      });
    } catch (error) {
      firstError = error;
    }

    let extracted = firstPass;
    let extractionPass = 1;
    let usedModel = model;
    if (!firstPass || firstPass.draft.lines.length === 0) {
      const recoverySources = await readRecoverySources(bucket, ingestion);
      try {
        extracted = await extractReceiptWithGemini({
          apiKey,
          model: recoveryModel,
          contentType: ingestion.source_content_type,
          bytes: originalBytes,
          sources: recoverySources.length
            ? recoverySources
            : [{ contentType: ingestion.source_content_type, bytes: originalBytes }],
          recovery: true,
        });
        extractionPass = 2;
        usedModel = recoveryModel;
      } catch (recoveryError) {
        if (!firstPass) throw recoveryError ?? firstError;
        extracted = {
          ...firstPass,
          draft: {
            ...firstPass.draft,
            warnings: [
              ...firstPass.draft.warnings,
              "The printed totals were saved, but the product lines still need a clearer receipt or manual review.",
            ],
          },
        };
      }
    }
    if (!extracted) throw firstError ?? new Error("receipt_extraction_failed");
    let understoodDraft = extracted.draft;
    let productUnderstandingStatus: "completed" | "unavailable" = "completed";
    try {
      understoodDraft = await understandReceiptProducts({
        db,
        householdId: ingestion.household_id,
        apiKey,
        model: usedModel,
        draft: extracted.draft,
      });
    } catch (error) {
      productUnderstandingStatus = "unavailable";
      console.warn("BasketSense optional product understanding was unavailable", {
        ingestionId: ingestion.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const artifactKey = `households/${ingestion.household_id}/receipt-ingestions/${ingestion.id}/gemini-draft.json`;
    await bucket.put(
      artifactKey,
      JSON.stringify({
        provider: "gemini",
        model: usedModel,
        schemaVersion: RECEIPT_EXTRACTION_SCHEMA_VERSION,
        productUnderstandingSchemaVersion: PRODUCT_UNDERSTANDING_SCHEMA_VERSION,
        productUnderstandingStatus,
        responseId: extracted.responseId,
        finishReason: extracted.finishReason,
        durationMs: extracted.durationMs,
        extractionPass,
        draft: understoodDraft,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const now = new Date().toISOString();
    await db
      .prepare(`UPDATE receipt_ingestions
        SET status = 'awaiting_review', provider = 'gemini', model = ?,
            prompt_version = 'costco-receipt-extraction-v1',
            schema_version = ?, extraction_artifact_key = ?,
            error_code = NULL, provider_response_id = ?,
            provider_finish_reason = ?, provider_duration_ms = ?,
            extraction_pass = ?, completed_at = ?, updated_at = ?
        WHERE id = ?`)
      .bind(
        usedModel,
        RECEIPT_EXTRACTION_SCHEMA_VERSION,
        artifactKey,
        extracted.responseId,
        extracted.finishReason,
        extracted.durationMs,
        extractionPass,
        now,
        now,
        ingestion.id,
      )
      .run();
  } catch (error) {
    const code = receiptExtractionErrorCode(error);
    const details = error instanceof ReceiptExtractionError ? error.details : {};
    await db
      .prepare(`UPDATE receipt_ingestions
        SET status = 'failed', error_code = ?, provider_response_id = ?,
            provider_finish_reason = ?, provider_duration_ms = ?, updated_at = ?
        WHERE id = ?`)
      .bind(
        code,
        details.responseId ?? null,
        details.finishReason ?? null,
        details.durationMs ?? null,
        new Date().toISOString(),
        ingestion.id,
      )
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
  console.error("BasketSense receipt ingestion API error", {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
  return responseJson({ error: "Unable to save the receipt for review" }, 500);
}

export async function POST(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const { db, bucket, geminiApiKey, geminiModel, geminiRecoveryModel } = await runtime();
    await ensureIngestionSchema(db);
    if (request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || body.action !== "reprocess_saved_receipt") {
        throw new IngestionApiError(400, "Unsupported saved receipt action");
      }
      const receiptId = requiredText(
        typeof body.receiptId === "string" ? body.receiptId : null,
        "receiptId",
        128,
      );
      const clientRequestId = requiredText(
        typeof body.clientRequestId === "string" ? body.clientRequestId : null,
        "clientRequestId",
        128,
      );
      const authorization = await authorizeHistoricalReceiptCorrection(db, email, receiptId);
      const existing = await db
        .prepare(`SELECT * FROM receipt_ingestions
          WHERE household_id = ? AND client_request_id = ? LIMIT 1`)
        .bind(authorization.householdId, clientRequestId)
        .first<IngestionRow>();
      if (existing) {
        if (existing.receipt_transaction_id !== authorization.receiptId) {
          throw new IngestionApiError(409, "This saved receipt request is linked to another receipt");
        }
        const processed = geminiApiKey
          ? await nativeExtractReceipt({
              db,
              bucket,
              ingestion: existing,
              apiKey: geminiApiKey,
              model: geminiModel,
              recoveryModel: geminiRecoveryModel,
            })
          : existing;
        return responseJson({
          ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
          reused: true,
          queued: false,
          configurationMissing: !geminiApiKey,
        }, 202);
      }

      const saved = await db
        .prepare(`SELECT receipt_uploads.storage_key, receipt_uploads.content_type,
                         receipt_uploads.byte_size,
                         receipt_ingestions.source_sha256,
                         receipt_ingestions.recovery_manifest_key
          FROM receipt_uploads
          LEFT JOIN receipt_ingestions
            ON receipt_ingestions.receipt_transaction_id = receipt_uploads.receipt_transaction_id
           AND receipt_ingestions.source_storage_key = receipt_uploads.storage_key
          WHERE receipt_uploads.household_id = ?
            AND receipt_uploads.receipt_transaction_id = ?
            AND receipt_uploads.status = 'stored'
          ORDER BY receipt_ingestions.created_at DESC
          LIMIT 1`)
        .bind(authorization.householdId, authorization.receiptId)
        .first<{
          storage_key: string;
          content_type: string;
          byte_size: number;
          source_sha256: string | null;
          recovery_manifest_key: string | null;
        }>();
      if (!saved) {
        throw new IngestionApiError(404, "The saved original receipt file is unavailable; choose a replacement instead");
      }
      const savedObject = await bucket.head(saved.storage_key);
      if (!savedObject) {
        throw new IngestionApiError(404, "The saved original receipt file is unavailable; choose a replacement instead");
      }
      const ingestionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db
        .prepare(`INSERT INTO receipt_ingestions (
          id, household_id, trip_id, requested_by_member_id, client_request_id,
          source_storage_key, source_sha256, source_content_type, source_byte_size,
          receipt_transaction_id, recovery_manifest_key, status, revision,
          attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 1, 0, ?, ?)`)
        .bind(
          ingestionId,
          authorization.householdId,
          authorization.tripId,
          authorization.memberId,
          clientRequestId,
          saved.storage_key,
          saved.source_sha256 ?? `saved:${authorization.receiptId}`,
          saved.content_type,
          saved.byte_size,
          authorization.receiptId,
          saved.recovery_manifest_key,
          now,
          now,
        )
        .run();
      const created = await authorizeIngestion(db, email, ingestionId);
      const processed = geminiApiKey
        ? await nativeExtractReceipt({
            db,
            bucket,
            ingestion: created,
            apiKey: geminiApiKey,
            model: geminiModel,
            recoveryModel: geminiRecoveryModel,
          })
        : created;
      return responseJson({
        ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
        reusedSavedOriginal: true,
        queued: false,
        configurationMissing: !geminiApiKey,
      }, 202);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new IngestionApiError(400, "Upload must be a receipt file");
    }
    const { tripId, receiptId } = receiptIngestionUploadTarget(form);
    const correctionRequested = form.get("correction") === "1";
    const deferExtraction = form.get("deferExtraction") === "1";
    if (correctionRequested && tripId) {
      throw new IngestionApiError(400, "Historical correction requires a receiptId");
    }
    const clientRequestId = requiredText(form.get("clientRequestId"), "clientRequestId", 128);
    const receiptFile = form.get("file") ?? form.get("image");
    if (!(receiptFile instanceof File)) {
      throw new IngestionApiError(400, "Choose a receipt photo or PDF");
    }
    const contentType = receiptFile.type.toLowerCase();
    if (!isReceiptUploadContentType(contentType)) {
      throw new IngestionApiError(415, "Receipt file must be a PDF, JPEG, PNG, HEIC, or WebP");
    }
    if (receiptFile.size <= 0 || receiptFile.size > MAX_RECEIPT_FILE_BYTES) {
      throw new IngestionApiError(413, "Receipt file must be 8 MB or smaller");
    }
    const authorization = tripId
      ? await authorizeTrip(db, email, tripId)
      : correctionRequested
        ? await authorizeHistoricalReceiptCorrection(db, email, receiptId as string)
        : await authorizeStandaloneReceipt(db, email, receiptId as string);
    const existing = await db
      .prepare(`SELECT * FROM receipt_ingestions
        WHERE household_id = ? AND client_request_id = ? LIMIT 1`)
      .bind(authorization.householdId, clientRequestId)
      .first<IngestionRow>();
    if (existing) {
      if (
        existing.trip_id !== authorization.tripId ||
        existing.receipt_transaction_id !== authorization.receiptId
      ) {
        throw new IngestionApiError(409, "This receipt upload is already linked to another receipt context");
      }
      const processed = geminiApiKey && !deferExtraction
        ? await nativeExtractReceipt({
            db,
            bucket,
            ingestion: existing,
            apiKey: geminiApiKey,
            model: geminiModel,
            recoveryModel: geminiRecoveryModel,
          })
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
          receipt_transaction_id, status, revision, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', 1, 0, ?, ?)`)
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
          authorization.receiptId,
          now,
          now,
        )
        .run();
    } catch (error) {
      await bucket.delete(storageKey);
      throw error;
    }
    const created = await authorizeIngestion(db, email, ingestionId);
    const processed = geminiApiKey && !deferExtraction
      ? await nativeExtractReceipt({
          db,
          bucket,
          ingestion: created,
          apiKey: geminiApiKey,
          model: geminiModel,
          recoveryModel: geminiRecoveryModel,
        })
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
    const { db, bucket, geminiApiKey, geminiModel, geminiRecoveryModel } = await runtime();
    await ensureIngestionSchema(db);
    if (request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      if (!form || form.get("action") !== "add_recovery_asset") {
        throw new IngestionApiError(400, "Unsupported receipt recovery action");
      }
      const ingestionId = requiredText(form.get("ingestionId"), "ingestionId", 128);
      const ingestion = await authorizeIngestion(db, email, ingestionId);
      if (ingestion.status !== "uploaded") {
        throw new IngestionApiError(409, "Receipt recovery evidence can only be added before reading starts");
      }
      const asset = form.get("file");
      if (!(asset instanceof File) || !isReceiptUploadContentType(asset.type.toLowerCase())) {
        throw new IngestionApiError(415, "Recovery evidence must be a supported receipt image");
      }
      if (!asset.type.toLowerCase().startsWith("image/") || asset.size <= 0 || asset.size > MAX_RECEIPT_FILE_BYTES) {
        throw new IngestionApiError(413, "Recovery image must be 8 MB or smaller");
      }
      const rawIndex = Number(form.get("assetIndex"));
      if (!Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex > 6) {
        throw new IngestionApiError(400, "Recovery image index is invalid");
      }
      const manifestKey = ingestion.recovery_manifest_key ??
        `households/${ingestion.household_id}/receipt-ingestions/${ingestion.id}/recovery-manifest.json`;
      const existingManifestObject = await bucket.get(manifestKey);
      const existingManifest = existingManifestObject
        ? (await existingManifestObject.json()) as RecoveryManifest
        : { assets: [] };
      const assetKey = `households/${ingestion.household_id}/receipt-ingestions/${ingestion.id}/recovery-${rawIndex}.jpg`;
      await bucket.put(assetKey, asset.stream(), {
        httpMetadata: { contentType: asset.type.toLowerCase() },
        customMetadata: {
          householdId: ingestion.household_id,
          ingestionId: ingestion.id,
          recoveryIndex: String(rawIndex),
        },
      });
      const assets = (Array.isArray(existingManifest.assets) ? existingManifest.assets : [])
        .filter((entry) => entry?.key !== assetKey);
      assets.push({ key: assetKey, contentType: asset.type.toLowerCase(), byteSize: asset.size });
      assets.sort((left, right) => left.key.localeCompare(right.key));
      await bucket.put(manifestKey, JSON.stringify({ assets }), {
        httpMetadata: { contentType: "application/json" },
      });
      await db
        .prepare(`UPDATE receipt_ingestions SET recovery_manifest_key = ?, updated_at = ? WHERE id = ?`)
        .bind(manifestKey, new Date().toISOString(), ingestion.id)
        .run();
      const refreshed = await authorizeIngestion(db, email, ingestion.id);
      const processed = form.get("final") === "1" && geminiApiKey
        ? await nativeExtractReceipt({
            db,
            bucket,
            ingestion: refreshed,
            apiKey: geminiApiKey,
            model: geminiModel,
            recoveryModel: geminiRecoveryModel,
          })
        : refreshed;
      return responseJson({
        ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
        recoveryAssetStored: true,
        queued: false,
        configurationMissing: !geminiApiKey,
      }, 202);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || (body.action !== "link_receipt" && body.action !== "retry_extraction")) {
      throw new IngestionApiError(400, "Unsupported receipt upload action");
    }
    const ingestionId = requiredText(typeof body.ingestionId === "string" ? body.ingestionId : null, "ingestionId", 128);
    const ingestion = await authorizeIngestion(db, email, ingestionId);
    if (body.action === "retry_extraction") {
      const disposition = receiptIngestionRetryDisposition(ingestion.status);
      if (disposition === "unavailable") {
        throw new IngestionApiError(409, "This receipt upload can no longer be read again");
      }
      if (!geminiApiKey && disposition === "retry") {
        throw new IngestionApiError(503, "The receipt reader is temporarily unavailable; the saved file is safe");
      }
      const processed = disposition === "retry"
        ? await nativeExtractReceipt({
            db,
            bucket,
            ingestion,
            apiKey: geminiApiKey as string,
            model: geminiModel,
            recoveryModel: geminiRecoveryModel,
          })
        : ingestion;
      return responseJson(
        {
          ingestion: publicIngestion(processed, await readArtifact(bucket, processed)),
          retried: disposition === "retry",
          queued: receiptIngestionRetryDisposition(processed.status) === "busy",
        },
        202,
      );
    }
    const receiptId = requiredText(typeof body.receiptId === "string" ? body.receiptId : null, "receiptId", 128);
    const receipt = await db
      .prepare(`SELECT receipt_transactions.id, receipt_transactions.household_id, receipt_transactions.trip_id,
                receipt_transactions.source_type, receipt_transactions.transaction_type,
                household_members.id AS member_id
         FROM receipt_transactions
         INNER JOIN household_members ON household_members.household_id = receipt_transactions.household_id
         WHERE receipt_transactions.id = ? AND lower(household_members.user_email) = ?
         LIMIT 1`)
      .bind(receiptId, email)
      .first<{
        id: string;
        household_id: string;
        trip_id: string | null;
        source_type: string;
        transaction_type: string;
        member_id: string;
      }>();
    if (
      !receipt ||
      receipt.household_id !== ingestion.household_id ||
      receipt.trip_id !== ingestion.trip_id ||
      (ingestion.trip_id === null &&
        (receipt.trip_id !== null ||
          receipt.source_type !== "receipt_photo" ||
          !["warehouse", "return"].includes(receipt.transaction_type)))
    ) {
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
