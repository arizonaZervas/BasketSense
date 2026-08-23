import type { ExtractedReceiptDraft, ExtractedReceiptLine } from "./extraction";

export const PRODUCT_UNDERSTANDING_SCHEMA_VERSION = "basketsense-product-understanding-v1";
export const PRODUCT_UNDERSTANDING_PROMPT_VERSION = "costco-line-understanding-v1";

export type ProductUnderstanding = {
  lookupKey: string;
  canonicalName: string;
  brand: string | null;
  productFamily: string | null;
  variant: string | null;
  categoryHint: string | null;
  confidenceBps: number;
  exactSkuKnown: boolean;
  searchAliases: string[];
  source: "catalog" | "gemini";
  model: string | null;
};

export type UnderstoodReceiptLine = ExtractedReceiptLine & {
  understanding?: ProductUnderstanding;
};

type CachedUnderstandingRow = {
  lookup_key: string;
  canonical_name: string;
  brand: string | null;
  product_family: string | null;
  variant: string | null;
  category_hint: string | null;
  confidence_bps: number;
  exact_sku_known: number;
  search_aliases_json: string;
  model: string;
};

type CatalogUnderstandingRow = {
  costco_item_number: string | null;
  canonical_name: string;
  brand: string | null;
  category: string | null;
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

const categoryHints = [
  "groceries_beverages",
  "clothing_accessories",
  "household_supplies",
  "health_personal_care",
  "home_kitchen_seasonal",
  "toys_books_activities",
  "automotive_tires",
  "jewelry_precious_metals",
] as const;

const productUnderstandingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "lookupKey",
          "canonicalName",
          "brand",
          "productFamily",
          "variant",
          "categoryHint",
          "confidenceBps",
          "exactSkuKnown",
          "searchAliases",
        ],
        properties: {
          lookupKey: { type: "string", minLength: 1, maxLength: 240 },
          canonicalName: { type: "string", minLength: 1, maxLength: 140 },
          brand: { type: ["string", "null"], maxLength: 100 },
          productFamily: { type: ["string", "null"], maxLength: 100 },
          variant: { type: ["string", "null"], maxLength: 100 },
          categoryHint: { type: ["string", "null"], enum: [...categoryHints, null] },
          confidenceBps: { type: "integer", minimum: 0, maximum: 10000 },
          exactSkuKnown: { type: "boolean" },
          searchAliases: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
  },
} as const;

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function productUnderstandingLookupKey(line: Pick<ExtractedReceiptLine, "itemNumber" | "rawDescription">) {
  return line.itemNumber?.trim()
    ? `item:${line.itemNumber.trim()}`
    : `raw:${normalize(line.rawDescription)}`;
}

function optionalText(value: unknown, max: number) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Product understanding text is invalid");
  const text = value.trim();
  if (!text || text.length > max) throw new Error("Product understanding text is invalid");
  return text;
}

function parseSearchAliases(value: unknown) {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Product understanding aliases are invalid");
  }
  return [...new Set(value.map((alias) => optionalText(alias, 100)).filter((alias): alias is string => Boolean(alias)))];
}

export function parseProductUnderstandings(
  value: unknown,
  allowedLookupKeys: ReadonlySet<string>,
  model: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Product understanding response is invalid");
  }
  const products = (value as { products?: unknown }).products;
  if (!Array.isArray(products) || products.length > 100) {
    throw new Error("Product understanding response is invalid");
  }
  const parsed = new Map<string, ProductUnderstanding>();
  for (const entry of products) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Product understanding entry is invalid");
    }
    const row = entry as Record<string, unknown>;
    const lookupKey = optionalText(row.lookupKey, 240);
    const canonicalName = optionalText(row.canonicalName, 140);
    if (!lookupKey || !canonicalName || !allowedLookupKeys.has(lookupKey)) continue;
    if (!Number.isInteger(row.confidenceBps) || (row.confidenceBps as number) < 0 || (row.confidenceBps as number) > 10000) {
      throw new Error("Product understanding confidence is invalid");
    }
    if (typeof row.exactSkuKnown !== "boolean") {
      throw new Error("Product understanding SKU evidence is invalid");
    }
    const categoryHint = optionalText(row.categoryHint, 80);
    if (categoryHint && !categoryHints.includes(categoryHint as (typeof categoryHints)[number])) {
      throw new Error("Product understanding category is invalid");
    }
    parsed.set(lookupKey, {
      lookupKey,
      canonicalName,
      brand: optionalText(row.brand, 100),
      productFamily: optionalText(row.productFamily, 100),
      variant: optionalText(row.variant, 100),
      categoryHint,
      confidenceBps: row.confidenceBps as number,
      exactSkuKnown: row.exactSkuKnown,
      searchAliases: parseSearchAliases(row.searchAliases),
      source: "gemini",
      model,
    });
  }
  return parsed;
}

export function buildProductUnderstandingRequest(
  lines: Array<Pick<ExtractedReceiptLine, "itemNumber" | "rawDescription">>,
) {
  const inputs = lines.map((line) => ({
    lookupKey: productUnderstandingLookupKey(line),
    costcoItemNumber: line.itemNumber,
    printedLabel: line.rawDescription,
  }));
  return {
    contents: [{
      role: "user",
      parts: [{
        text: `Understand these Costco receipt product labels. This step is descriptive only: do not decide whether an item was planned, recommended, valuable, or a household match. Keep meaningful variants separate (for example flavors or distinct Suja products). Use the item number as SKU evidence only when you truly know it. Prefer a concise household-readable canonical name, a broad product family useful for matching, and short search aliases. Never invent price, quantity, tax, or receipt totals.\n\nInputs:\n${JSON.stringify(inputs)}\n\nReturn exactly this JSON contract:\n${JSON.stringify(productUnderstandingSchema)}`,
      }],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0,
    },
  };
}

async function ensureProductUnderstandingTable(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS product_understandings (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      costco_item_number TEXT,
      raw_description TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      brand TEXT,
      product_family TEXT,
      variant TEXT,
      category_hint TEXT,
      confidence_bps INTEGER NOT NULL,
      exact_sku_known INTEGER NOT NULL DEFAULT 0,
      search_aliases_json TEXT NOT NULL DEFAULT '[]',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS product_understandings_household_lookup_unique
      ON product_understandings (household_id, lookup_key)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS product_understandings_item_number_idx
      ON product_understandings (household_id, costco_item_number)`),
  ]);
}

function fromCachedRow(row: CachedUnderstandingRow): ProductUnderstanding {
  let aliases: string[] = [];
  try {
    const value = JSON.parse(row.search_aliases_json);
    if (Array.isArray(value)) aliases = value.filter((entry): entry is string => typeof entry === "string").slice(0, 8);
  } catch {}
  return {
    lookupKey: row.lookup_key,
    canonicalName: row.canonical_name,
    brand: row.brand,
    productFamily: row.product_family,
    variant: row.variant,
    categoryHint: row.category_hint,
    confidenceBps: row.confidence_bps,
    exactSkuKnown: Boolean(row.exact_sku_known),
    searchAliases: aliases,
    source: "gemini",
    model: row.model,
  };
}

async function cachedUnderstandings(db: D1Database, householdId: string) {
  const [cache, catalog] = await Promise.all([
    db.prepare(`SELECT * FROM product_understandings WHERE household_id = ?`)
      .bind(householdId).all<CachedUnderstandingRow>(),
    db.prepare(`SELECT costco_item_number, canonical_name, brand, category
      FROM products WHERE household_id = ? AND active = 1 AND costco_item_number IS NOT NULL`)
      .bind(householdId).all<CatalogUnderstandingRow>(),
  ]);
  const result = new Map(cache.results.map((row) => [row.lookup_key, fromCachedRow(row)]));
  for (const product of catalog.results) {
    if (!product.costco_item_number) continue;
    const lookupKey = `item:${product.costco_item_number}`;
    result.set(lookupKey, {
      lookupKey,
      canonicalName: product.canonical_name,
      brand: product.brand,
      productFamily: null,
      variant: null,
      categoryHint: product.category,
      confidenceBps: 10000,
      exactSkuKnown: true,
      searchAliases: [],
      source: "catalog",
      model: null,
    });
  }
  return result;
}

async function requestGeminiUnderstandings({
  apiKey,
  model,
  lines,
}: {
  apiKey: string;
  model: string;
  lines: Array<Pick<ExtractedReceiptLine, "itemNumber" | "rawDescription">>;
}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(buildProductUnderstandingRequest(lines)),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Product understanding failed with HTTP ${response.status}`);
  const body = (await response.json()) as GeminiResponse;
  const text = body.candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "").join("");
  if (!text) throw new Error("Product understanding returned no structured output");
  const allowed = new Set(lines.map(productUnderstandingLookupKey));
  return parseProductUnderstandings(JSON.parse(text), allowed, model);
}

async function persistUnderstandings(
  db: D1Database,
  householdId: string,
  linesByKey: Map<string, Pick<ExtractedReceiptLine, "itemNumber" | "rawDescription">>,
  understandings: Map<string, ProductUnderstanding>,
) {
  const now = new Date().toISOString();
  const statements = [...understandings.values()].map((understanding) => {
    const line = linesByKey.get(understanding.lookupKey)!;
    return db.prepare(`INSERT INTO product_understandings (
      id, household_id, lookup_key, costco_item_number, raw_description,
      canonical_name, brand, product_family, variant, category_hint,
      confidence_bps, exact_sku_known, search_aliases_json, provider, model,
      prompt_version, schema_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gemini', ?, ?, ?, ?, ?)
    ON CONFLICT(household_id, lookup_key) DO UPDATE SET
      raw_description = excluded.raw_description,
      canonical_name = excluded.canonical_name,
      brand = excluded.brand,
      product_family = excluded.product_family,
      variant = excluded.variant,
      category_hint = excluded.category_hint,
      confidence_bps = excluded.confidence_bps,
      exact_sku_known = excluded.exact_sku_known,
      search_aliases_json = excluded.search_aliases_json,
      model = excluded.model,
      prompt_version = excluded.prompt_version,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at`)
      .bind(
        crypto.randomUUID(), householdId, understanding.lookupKey,
        line.itemNumber, line.rawDescription, understanding.canonicalName,
        understanding.brand, understanding.productFamily, understanding.variant,
        understanding.categoryHint, understanding.confidenceBps,
        understanding.exactSkuKnown ? 1 : 0, JSON.stringify(understanding.searchAliases),
        understanding.model, PRODUCT_UNDERSTANDING_PROMPT_VERSION,
        PRODUCT_UNDERSTANDING_SCHEMA_VERSION, now, now,
      );
  });
  if (statements.length) await db.batch(statements);
}

export async function understandReceiptProducts({
  db,
  householdId,
  apiKey,
  model,
  draft,
}: {
  db: D1Database;
  householdId: string;
  apiKey: string;
  model: string;
  draft: ExtractedReceiptDraft;
}): Promise<ExtractedReceiptDraft & { lines: UnderstoodReceiptLine[] }> {
  await ensureProductUnderstandingTable(db);
  const candidates = draft.lines.filter((line) => line.netAmountCents >= 0 && line.rawDescription.trim());
  const uniqueLines = new Map(candidates.map((line) => [productUnderstandingLookupKey(line), line]));
  const understood = await cachedUnderstandings(db, householdId);
  const unresolved = [...uniqueLines.entries()]
    .filter(([lookupKey]) => !understood.has(lookupKey))
    .map(([, line]) => line);
  if (unresolved.length) {
    const generated = await requestGeminiUnderstandings({ apiKey, model, lines: unresolved });
    await persistUnderstandings(db, householdId, uniqueLines, generated);
    for (const [key, value] of generated) understood.set(key, value);
  }
  return {
    ...draft,
    lines: draft.lines.map((line) => ({
      ...line,
      ...(understood.has(productUnderstandingLookupKey(line))
        ? { understanding: understood.get(productUnderstandingLookupKey(line)) }
        : {}),
    })),
  };
}
