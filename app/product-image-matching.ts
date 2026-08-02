export interface OpenFoodFactsProduct {
  code?: unknown;
  product_name?: unknown;
  brands?: unknown;
  quantity?: unknown;
  image_front_url?: unknown;
  image_front_small_url?: unknown;
  image_front_width?: unknown;
  image_front_height?: unknown;
}

export interface LicensedProductImageCandidate {
  externalId: string;
  productName: string;
  brand: string | null;
  quantity: string | null;
  sourcePageUrl: string;
  sourceImageUrl: string;
  confidenceBps: number;
  widthPx: number | null;
  heightPx: number | null;
}

const LOW_SIGNAL_WORDS = new Set([
  "and",
  "for",
  "from",
  "the",
  "with",
  "pack",
  "count",
  "ct",
  "oz",
  "lb",
  "lbs",
  "kg",
  "g",
  "ml",
  "l",
]);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizedProductTokens(value: string) {
  return new Set(
    value
      .normalize("NFKD")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !LOW_SIGNAL_WORDS.has(token)),
  );
}

export function scoreOpenFoodFactsProduct({
  canonicalName,
  brand,
  candidate,
}: {
  canonicalName: string;
  brand: string | null;
  candidate: OpenFoodFactsProduct;
}) {
  const queryTokens = normalizedProductTokens(`${brand ?? ""} ${canonicalName}`);
  const candidateTokens = normalizedProductTokens(
    `${text(candidate.brands)} ${text(candidate.product_name)}`,
  );
  if (!queryTokens.size || !candidateTokens.size) return 0;

  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token));
  const coverage = overlap.length / queryTokens.size;
  const precision = overlap.length / candidateTokens.size;
  const requestedBrand = normalizedProductTokens(brand ?? "");
  const brandMatched =
    requestedBrand.size > 0 &&
    [...requestedBrand].every((token) => candidateTokens.has(token));

  const score = Math.round(
    coverage * 6_000 + precision * 2_000 + (brandMatched ? 1_000 : 0),
  );
  return Math.max(0, Math.min(9_500, score));
}

export function isTrustedOpenFoodFactsImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "images.openfoodfacts.org" ||
        url.hostname === "static.openfoodfacts.org")
    );
  } catch {
    return false;
  }
}

export function licensedOpenFoodFactsCandidates({
  canonicalName,
  brand,
  products,
  limit = 4,
}: {
  canonicalName: string;
  brand: string | null;
  products: OpenFoodFactsProduct[];
  limit?: number;
}): LicensedProductImageCandidate[] {
  const seen = new Set<string>();
  return products
    .map((candidate) => {
      const externalId = text(candidate.code);
      const productName = text(candidate.product_name);
      const sourceImageUrl = text(
        candidate.image_front_url || candidate.image_front_small_url,
      );
      if (
        !externalId ||
        !productName ||
        !isTrustedOpenFoodFactsImageUrl(sourceImageUrl)
      ) {
        return null;
      }
      const confidenceBps = scoreOpenFoodFactsProduct({
        canonicalName,
        brand,
        candidate,
      });
      if (confidenceBps < 4_000 || seen.has(sourceImageUrl)) return null;
      seen.add(sourceImageUrl);
      return {
        externalId,
        productName,
        brand: text(candidate.brands) || null,
        quantity: text(candidate.quantity) || null,
        sourcePageUrl: `https://world.openfoodfacts.org/product/${encodeURIComponent(externalId)}`,
        sourceImageUrl,
        confidenceBps,
        widthPx: positiveInteger(candidate.image_front_width),
        heightPx: positiveInteger(candidate.image_front_height),
      } satisfies LicensedProductImageCandidate;
    })
    .filter((candidate): candidate is LicensedProductImageCandidate => Boolean(candidate))
    .sort((left, right) => right.confidenceBps - left.confidenceBps)
    .slice(0, Math.max(1, Math.min(limit, 8)));
}
