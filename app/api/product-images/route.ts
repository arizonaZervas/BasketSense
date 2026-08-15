export const dynamic = "force-dynamic";

const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface RuntimeEnv {
  DB?: D1Database;
  RECEIPTS?: R2Bucket;
}

interface AuthorizedProductRow {
  id: string;
  household_id: string;
  canonical_name: string;
  brand: string | null;
  member_id: string;
}

interface ProductImageRow {
  id: string;
  household_id: string;
  product_id: string;
  source_type:
    | "household_upload"
    | "ai_generated"
    | "open_food_facts"
    | "manufacturer";
  source_page_url: string | null;
  source_image_url: string | null;
  source_external_id: string | null;
  source_product_name: string | null;
  source_brand: string | null;
  source_quantity: string | null;
  storage_key: string | null;
  attribution_text: string | null;
  license_code: string | null;
  confidence_bps: number | null;
  status: "candidate" | "approved" | "rejected";
  is_primary: number;
  width_px: number | null;
  height_px: number | null;
  content_type: string | null;
  byte_size: number | null;
  content_sha256: string | null;
  created_at: string;
  updated_at: string;
}

class ProductImageApiError extends Error {
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
    .toLocaleLowerCase("en-US");
  if (!email) {
    throw new ProductImageApiError(401, "ChatGPT sign-in is required");
  }
  return email.slice(0, 320);
}

async function runtime() {
  const workersRuntime = (await import("cloudflare:workers")) as unknown as {
    env: RuntimeEnv;
  };
  if (!workersRuntime.env.DB) {
    throw new ProductImageApiError(503, "Household storage is unavailable");
  }
  if (!workersRuntime.env.RECEIPTS) {
    throw new ProductImageApiError(503, "Private image storage is unavailable");
  }
  return { db: workersRuntime.env.DB, bucket: workersRuntime.env.RECEIPTS };
}

const PRODUCT_IMAGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_page_url TEXT,
    source_image_url TEXT,
    source_external_id TEXT,
    source_product_name TEXT,
    source_brand TEXT,
    source_quantity TEXT,
    storage_key TEXT,
    attribution_text TEXT,
    license_code TEXT,
    confidence_bps INTEGER,
    status TEXT NOT NULL DEFAULT 'candidate',
    is_primary INTEGER NOT NULL DEFAULT 0,
    width_px INTEGER,
    height_px INTEGER,
    content_type TEXT,
    byte_size INTEGER,
    content_sha256 TEXT,
    created_by_member_id TEXT,
    reviewed_by_member_id TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_product_source_unique
    ON product_images (product_id, source_image_url)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_storage_key_unique
    ON product_images (storage_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_product_primary_unique
    ON product_images (product_id)
    WHERE is_primary = 1 AND status = 'approved'`,
  `CREATE INDEX IF NOT EXISTS product_images_household_status_idx
    ON product_images (household_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS product_images_product_status_idx
    ON product_images (product_id, status, is_primary)`,
] as const;

async function ensureProductImageSchema(db: D1Database) {
  try {
    await db.prepare("SELECT 1 FROM product_images LIMIT 1").first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table:\s*product_images/i.test(message)) throw error;
    await db.batch(PRODUCT_IMAGE_SCHEMA.map((statement) => db.prepare(statement)));
  }
}

function requiredId(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductImageApiError(400, `${label} is required`);
  }
  const id = value.trim();
  if (id.length > 128) {
    throw new ProductImageApiError(400, `${label} is too long`);
  }
  return id;
}

async function authorizedProduct(db: D1Database, email: string, productId: string) {
  const row = await db
    .prepare(
      `SELECT products.id, products.household_id, products.canonical_name,
              products.brand, household_members.id AS member_id
       FROM products
       INNER JOIN household_members
         ON household_members.household_id = products.household_id
       WHERE products.id = ?
         AND products.active = 1
         AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(productId, email)
    .first<AuthorizedProductRow>();
  if (!row) throw new ProductImageApiError(404, "Product not found");
  return row;
}

async function authorizedImage(db: D1Database, email: string, imageId: string) {
  const row = await db
    .prepare(
      `SELECT product_images.*
       FROM product_images
       INNER JOIN household_members
         ON household_members.household_id = product_images.household_id
       WHERE product_images.id = ?
         AND product_images.source_type IN ('household_upload', 'ai_generated')
         AND lower(household_members.user_email) = ?
       LIMIT 1`,
    )
    .bind(imageId, email)
    .first<ProductImageRow>();
  if (!row || row.status === "rejected") {
    throw new ProductImageApiError(404, "Product image not found");
  }
  return row;
}

function imageSummary(row: ProductImageRow) {
  return {
    id: row.id,
    productId: row.product_id,
    sourceType: row.source_type,
    sourcePageUrl: row.source_page_url,
    productName: row.source_product_name,
    brand: row.source_brand,
    quantity: row.source_quantity,
    attributionText: row.attribution_text,
    licenseCode: row.license_code,
    confidenceBps: row.confidence_bps,
    status: row.status,
    isPrimary: Boolean(row.is_primary),
    widthPx: row.width_px,
    heightPx: row.height_px,
    imageUrl: `/api/product-images?imageId=${encodeURIComponent(row.id)}`,
    updatedAt: row.updated_at,
  };
}

async function listProductImages(db: D1Database, productId: string) {
  const result = await db
    .prepare(
      `SELECT * FROM product_images
       WHERE product_id = ?
         AND source_type IN ('household_upload', 'ai_generated')
         AND status != 'rejected'
       ORDER BY is_primary DESC, status = 'approved' DESC,
                confidence_bps DESC, updated_at DESC`,
    )
    .bind(productId)
    .all<ProductImageRow>();
  return result.results.map(imageSummary);
}

function extensionForContentType(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadHouseholdImage({
  db,
  bucket,
  email,
  form,
}: {
  db: D1Database;
  bucket: R2Bucket;
  email: string;
  form: FormData;
}) {
  const productId = requiredId(form.get("productId"), "productId");
  const product = await authorizedProduct(db, email, productId);
  const file = form.get("file") ?? form.get("image");
  if (!(file instanceof File)) {
    throw new ProductImageApiError(400, "Choose a product photo first");
  }
  const contentType = file.type.toLocaleLowerCase("en-US");
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new ProductImageApiError(415, "Product photos must be JPEG, PNG, or WebP");
  }
  if (!file.size || file.size > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageApiError(413, "Product photos must be 10 MB or smaller");
  }
  const bytes = await file.arrayBuffer();
  const imageId = crypto.randomUUID();
  const storageKey = `households/${product.household_id}/product-images/${product.id}/${imageId}.${extensionForContentType(contentType)}`;
  const contentSha256 = await sha256Hex(bytes);
  await bucket.put(storageKey, bytes, {
    httpMetadata: { contentType, cacheControl: "private, max-age=86400" },
    customMetadata: {
      householdId: product.household_id,
      productId: product.id,
      source: "household_upload",
    },
  });

  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE product_images SET is_primary = 0, updated_at = ?
           WHERE product_id = ? AND is_primary = 1`,
        )
        .bind(now, product.id),
      db
        .prepare(
          `INSERT INTO product_images (
             id, household_id, product_id, source_type, storage_key,
             attribution_text, license_code, status, is_primary,
             content_type, byte_size, content_sha256,
             created_by_member_id, reviewed_by_member_id, reviewed_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'household_upload', ?, 'Household photo',
                     'household owned', 'approved', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          imageId,
          product.household_id,
          product.id,
          storageKey,
          contentType,
          file.size,
          contentSha256,
          product.member_id,
          product.member_id,
          now,
          now,
          now,
        ),
    ]);
  } catch (error) {
    await bucket.delete(storageKey);
    throw error;
  }
  return await listProductImages(db, product.id);
}

function handleError(error: unknown) {
  if (error instanceof ProductImageApiError) {
    return responseJson({ error: error.message }, error.status);
  }
  console.error("BasketSense product image API error");
  return responseJson({ error: "The product image could not be updated" }, 500);
}

export async function handleProductImagesGet(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
) {
  try {
    const email = authenticatedEmail(request);
    await ensureProductImageSchema(db);
    const url = new URL(request.url);
    const imageId = url.searchParams.get("imageId");
    if (imageId) {
      const image = await authorizedImage(db, email, requiredId(imageId, "imageId"));
      if (image.storage_key) {
        const object = await bucket.get(image.storage_key);
        if (!object) throw new ProductImageApiError(404, "Product image not found");
        const headers = new Headers({
          "Cache-Control": "private, max-age=86400",
          "Content-Type": image.content_type ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
        if (image.byte_size) headers.set("Content-Length", String(image.byte_size));
        if (object.httpEtag) headers.set("ETag", object.httpEtag);
        return new Response(object.body, { status: 200, headers });
      }
      throw new ProductImageApiError(404, "Product image not found");
    }

    const productId = requiredId(url.searchParams.get("productId"), "productId");
    await authorizedProduct(db, email, productId);
    return responseJson({ images: await listProductImages(db, productId) });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleProductImagesPost(
  request: Request,
  db: D1Database,
  bucket: R2Bucket,
) {
  try {
    const email = authenticatedEmail(request);
    await ensureProductImageSchema(db);
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData();
      return responseJson(
        { images: await uploadHouseholdImage({ db, bucket, email, form }) },
        201,
      );
    }

    throw new ProductImageApiError(
      400,
      "Suggested product photos are no longer supported. Upload a household photo instead.",
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: Request) {
  try {
    const { db, bucket } = await runtime();
    return handleProductImagesGet(request, db, bucket);
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, bucket } = await runtime();
    return handleProductImagesPost(request, db, bucket);
  } catch (error) {
    return handleError(error);
  }
}
