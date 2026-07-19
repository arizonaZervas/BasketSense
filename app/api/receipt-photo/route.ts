export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

interface RuntimeEnv {
  DB?: D1Database;
  RECEIPTS?: R2Bucket;
}

interface AuthorizedReceiptRow {
  receipt_id: string;
  household_id: string;
  member_id: string;
}

interface UploadRow {
  id: string;
  storage_key: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
}

class PhotoApiError extends Error {
  constructor(
    readonly status: number,
    message: string
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
  if (!email) throw new PhotoApiError(401, "ChatGPT sign-in is required");
  return email.slice(0, 320);
}

async function runtime() {
  const workersRuntime = (await import("cloudflare:workers")) as unknown as {
    env: RuntimeEnv;
  };
  if (!workersRuntime.env.DB) {
    throw new PhotoApiError(503, "Household storage is unavailable");
  }
  if (!workersRuntime.env.RECEIPTS) {
    throw new PhotoApiError(503, "Private receipt photo storage is unavailable");
  }
  return { db: workersRuntime.env.DB, bucket: workersRuntime.env.RECEIPTS };
}

async function ensureUploadSchema(db: D1Database) {
  await db.batch([
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
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
      FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_receipt_unique
      ON receipt_uploads (receipt_transaction_id)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_storage_key_unique
      ON receipt_uploads (storage_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS receipt_uploads_household_idx
      ON receipt_uploads (household_id)`),
  ]);
}

async function authorizedReceipt(
  db: D1Database,
  email: string,
  receiptId: string
) {
  const row = await db
    .prepare(
      `SELECT receipt_transactions.id AS receipt_id,
              receipt_transactions.household_id AS household_id,
              household_members.id AS member_id
       FROM receipt_transactions
       INNER JOIN household_members
         ON household_members.household_id = receipt_transactions.household_id
       WHERE receipt_transactions.id = ?
         AND lower(household_members.user_email) = ?
       LIMIT 1`
    )
    .bind(receiptId, email)
    .first<AuthorizedReceiptRow>();
  if (!row) throw new PhotoApiError(404, "Receipt not found");
  return row;
}

function requiredReceiptId(value: FormDataEntryValue | string | null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PhotoApiError(400, "receiptId is required");
  }
  const receiptId = value.trim();
  if (receiptId.length > 128) {
    throw new PhotoApiError(400, "receiptId is too long");
  }
  return receiptId;
}

function safeFilename(value: string) {
  const cleaned = value.replace(/[\r\n\0]/g, " ").trim();
  return (cleaned || "costco-receipt").slice(0, 180);
}

function handleError(error: unknown) {
  if (error instanceof PhotoApiError) {
    return responseJson({ error: error.message }, error.status);
  }
  console.error("BasketSense receipt photo API error", error);
  return responseJson({ error: "Unable to store the receipt photo" }, 500);
}

export async function POST(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const { db, bucket } = await runtime();
    await ensureUploadSchema(db);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new PhotoApiError(400, "Upload must be multipart form data");
    }
    const receiptId = requiredReceiptId(form.get("receiptId"));
    const image = form.get("file") ?? form.get("image");
    if (!(image instanceof File)) {
      throw new PhotoApiError(400, "file is required");
    }
    const contentType = image.type.toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new PhotoApiError(
        415,
        "Receipt photo must be JPEG, PNG, HEIC, or WebP"
      );
    }
    if (image.size <= 0 || image.size > MAX_IMAGE_BYTES) {
      throw new PhotoApiError(413, "Receipt photo must be 12 MB or smaller");
    }
    const authorization = await authorizedReceipt(db, email, receiptId);
    const previous = await db
      .prepare(
        `SELECT * FROM receipt_uploads
         WHERE receipt_transaction_id = ? LIMIT 1`
      )
      .bind(receiptId)
      .first<UploadRow>();
    const storageKey = `households/${authorization.household_id}/receipts/${receiptId}/${crypto.randomUUID()}`;
    const filename = safeFilename(image.name);
    await bucket.put(storageKey, image.stream(), {
      httpMetadata: { contentType },
      customMetadata: {
        receiptId,
        householdId: authorization.household_id,
      },
    });
    const now = new Date().toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO receipt_uploads (
            id, household_id, receipt_transaction_id, storage_key,
            original_filename, content_type, byte_size, status,
            uploaded_by_member_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'stored', ?, ?, ?)
          ON CONFLICT(receipt_transaction_id) DO UPDATE SET
            storage_key = excluded.storage_key,
            original_filename = excluded.original_filename,
            content_type = excluded.content_type,
            byte_size = excluded.byte_size,
            status = 'stored',
            uploaded_by_member_id = excluded.uploaded_by_member_id,
            updated_at = excluded.updated_at`
        )
        .bind(
          previous?.id ?? crypto.randomUUID(),
          authorization.household_id,
          receiptId,
          storageKey,
          filename,
          contentType,
          image.size,
          authorization.member_id,
          now,
          now
        )
        .run();
    } catch (error) {
      await bucket.delete(storageKey);
      throw error;
    }
    if (previous?.storage_key && previous.storage_key !== storageKey) {
      await bucket.delete(previous.storage_key);
    }
    return responseJson(
      {
        upload: {
          receiptId,
          originalFilename: filename,
          contentType,
          byteSize: image.size,
          imageUrl: `/api/receipt-photo?receiptId=${encodeURIComponent(
            receiptId
          )}`,
        },
      },
      201
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: Request) {
  try {
    const email = authenticatedEmail(request);
    const { db, bucket } = await runtime();
    await ensureUploadSchema(db);
    const receiptId = requiredReceiptId(
      new URL(request.url).searchParams.get("receiptId")
    );
    await authorizedReceipt(db, email, receiptId);
    const upload = await db
      .prepare(
        `SELECT * FROM receipt_uploads
         WHERE receipt_transaction_id = ? AND status != 'deleted'
         LIMIT 1`
      )
      .bind(receiptId)
      .first<UploadRow>();
    if (!upload) throw new PhotoApiError(404, "Receipt photo not found");
    const object = await bucket.get(upload.storage_key);
    if (!object) throw new PhotoApiError(404, "Receipt photo not found");
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Type": upload.content_type,
      "Content-Length": String(upload.byte_size),
      "Content-Disposition": `inline; filename="${safeFilename(
        upload.original_filename
      ).replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
    });
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return handleError(error);
  }
}
