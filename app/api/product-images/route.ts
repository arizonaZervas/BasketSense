import {
  isTrustedOpenFoodFactsImageUrl,
  licensedOpenFoodFactsCandidates,
  type OpenFoodFactsProduct,
} from "../../product-image-matching";

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
  source_type: "household_upload" | "open_food_facts" | "manufacturer";
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
       WHERE product_id = ? AND status != 'rejected'
       ORDER BY is_primary DESC, status = 'approved' DESC,
                confidence_bps DESC, updated_at DESC`,
    )
    .bind(productId)
    .all<ProductImageRow>();
  return result.results.map(imageSummary);
}

async function readJsonBody(request: Request) {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ProductImageApiError(400, "A JSON request body is required");
  }
}

async function discoverCandidates(
  db: D1Database,
  product: AuthorizedProductRow,
  fetchImpl: typeof fetch,
  force = false,
) {
  const existing = await listProductImages(db, product.id);
  if (!force && existing.some((image) => image.status === "candidate")) return existing;

  const url = new URL("https://search.openfoodfacts.org/search");
  const query = `${product.brand ?? ""} ${product.canonical_name}`.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent":
          "BasketSense/0.1 (https://basket-sense-household.nysha-enterp-3913.chatgpt.site)",
      },
      body: JSON.stringify({
        q: query,
        page_size: 8,
        langs: ["en"],
        boost_phrase: true,
        fields: [
          "code",
          "product_name",
          "brands",
          "quantity",
          "image_front_url",
          "image_front_small_url",
          "image_front_width",
          "image_front_height",
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    throw new ProductImageApiError(502, "Licensed image search is temporarily unavailable");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new ProductImageApiError(502, "Licensed image search is temporarily unavailable");
  }
  const payload = (await response.json().catch(() => null)) as {
    hits?: OpenFoodFactsProduct[];
  } | null;
  const candidates = licensedOpenFoodFactsCandidates({
    canonicalName: product.canonical_name,
    brand: product.brand,
    products: Array.isArray(payload?.hits) ? payload.hits : [],
  });
  if (!candidates.length) return existing;

  const now = new Date().toISOString();
  await db.batch(
    candidates.map((candidate) =>
      db
        .prepare(
          `INSERT INTO product_images (
             id, household_id, product_id, source_type, source_page_url,
             source_image_url, source_external_id, source_product_name,
             source_brand, source_quantity, attribution_text, license_code,
             confidence_bps, status, is_primary, width_px, height_px,
             created_by_member_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'open_food_facts', ?, ?, ?, ?, ?, ?,
                     'Open Food Facts contributors', 'CC BY-SA 3.0', ?,
                     'candidate', 0, ?, ?, ?, ?, ?)
           ON CONFLICT(product_id, source_image_url) DO UPDATE SET
             source_page_url = excluded.source_page_url,
             source_product_name = excluded.source_product_name,
             source_brand = excluded.source_brand,
             source_quantity = excluded.source_quantity,
             confidence_bps = excluded.confidence_bps,
             width_px = excluded.width_px,
             height_px = excluded.height_px,
             updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          product.household_id,
          product.id,
          candidate.sourcePageUrl,
          candidate.sourceImageUrl,
          candidate.externalId,
          candidate.productName,
          candidate.brand,
          candidate.quantity,
          candidate.confidenceBps,
          candidate.widthPx,
          candidate.heightPx,
          product.member_id,
          now,
          now,
        ),
    ),
  );
  return await listProductImages(db, product.id);
}

function extensionForContentType(contentType: string) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function downloadImage(fetchImpl: typeof fetch, sourceUrl: string) {
  if (!isTrustedOpenFoodFactsImageUrl(sourceUrl)) {
    throw new ProductImageApiError(400, "That image source is not approved");
  }
  const response = await fetchImpl(sourceUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/png,image/jpeg",
      "User-Agent": "BasketSense/0.1 private-household-product-imagery",
    },
  });
  if (!response.ok) {
    throw new ProductImageApiError(502, "The selected image could not be downloaded");
  }
  const contentType = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLocaleLowerCase("en-US");
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new ProductImageApiError(415, "The selected source is not a supported image");
  }
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageApiError(413, "The selected image is larger than 10 MB");
  }
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageApiError(413, "The selected image is larger than 10 MB");
  }
  return { bytes, contentType };
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function approveCandidate({
  db,
  bucket,
  image,
  memberId,
  fetchImpl,
}: {
  db: D1Database;
  bucket: R2Bucket;
  image: ProductImageRow;
  memberId: string;
  fetchImpl: typeof fetch;
}) {
  let storageKey = image.storage_key;
  let uploadedStorageKey: string | null = null;
  let contentType = image.content_type;
  let byteSize = image.byte_size;
  let contentSha256 = image.content_sha256;

  if (!storageKey) {
    if (!image.source_image_url) {
      throw new ProductImageApiError(400, "This candidate has no source image");
    }
    const downloaded = await downloadImage(fetchImpl, image.source_image_url);
    contentType = downloaded.contentType;
    byteSize = downloaded.bytes.byteLength;
    contentSha256 = await sha256Hex(downloaded.bytes);
    storageKey = `households/${image.household_id}/product-images/${image.product_id}/${crypto.randomUUID()}.${extensionForContentType(contentType)}`;
    await bucket.put(storageKey, downloaded.bytes, {
      httpMetadata: {
        contentType,
        cacheControl: "private, max-age=86400",
      },
      customMetadata: {
        householdId: image.household_id,
        productId: image.product_id,
        source: image.source_type,
      },
    });
    uploadedStorageKey = storageKey;
  }

  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE product_images SET is_primary = 0, updated_at = ?
           WHERE product_id = ? AND is_primary = 1`,
        )
        .bind(now, image.product_id),
      db
        .prepare(
          `UPDATE product_images
           SET status = 'approved', is_primary = 1, storage_key = ?,
               content_type = ?, byte_size = ?, content_sha256 = ?,
               reviewed_by_member_id = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND household_id = ?`,
        )
        .bind(
          storageKey,
          contentType,
          byteSize,
          contentSha256,
          memberId,
          now,
          now,
          image.id,
          image.household_id,
        ),
    ]);
  } catch (error) {
    if (uploadedStorageKey) await bucket.delete(uploadedStorageKey);
    throw error;
  }
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
  fetchImpl: typeof fetch = fetch,
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
      if (!image.source_image_url) {
        throw new ProductImageApiError(404, "Product image not found");
      }
      const remote = await downloadImage(fetchImpl, image.source_image_url);
      return new Response(remote.bytes, {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=300",
          "Content-Type": remote.contentType,
          "Content-Length": String(remote.bytes.byteLength),
          "X-Content-Type-Options": "nosniff",
        },
      });
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
  fetchImpl: typeof fetch = fetch,
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

    const body = await readJsonBody(request);
    const action = requiredId(body.action, "action");
    if (action === "discover") {
      const productId = requiredId(body.productId, "productId");
      const product = await authorizedProduct(db, email, productId);
      const images = await discoverCandidates(db, product, fetchImpl, body.force === true);
      return responseJson({ images });
    }
    if (action === "approve" || action === "reject") {
      const imageId = requiredId(body.imageId, "imageId");
      const image = await authorizedImage(db, email, imageId);
      const product = await authorizedProduct(db, email, image.product_id);
      if (action === "approve") {
        await approveCandidate({
          db,
          bucket,
          image,
          memberId: product.member_id,
          fetchImpl,
        });
      } else {
        await db
          .prepare(
            `UPDATE product_images
             SET status = 'rejected', is_primary = 0,
                 reviewed_by_member_id = ?, reviewed_at = ?, updated_at = ?
             WHERE id = ? AND household_id = ?`,
          )
          .bind(
            product.member_id,
            new Date().toISOString(),
            new Date().toISOString(),
            image.id,
            image.household_id,
          )
          .run();
      }
      return responseJson({ images: await listProductImages(db, image.product_id) });
    }
    throw new ProductImageApiError(400, "Unsupported product image action");
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
