export type CatalogIntentCandidate = {
  id: string;
  canonicalName: string;
  brand?: string | null;
  productFamily?: string | null;
  variant?: string | null;
  searchAliases?: string[];
  confidenceBps?: number | null;
};

export type CatalogIntentResolution = {
  candidate: CatalogIntentCandidate;
  confidenceBps: number;
  reason: "canonical_exact" | "alias_exact" | "descriptive_subset";
};

const GENERIC_PRODUCT_FAMILY_WORDS = new Set([
  "BAG",
  "BAGS",
  "BREAD",
  "DRINK",
  "DRINKS",
  "FOOD",
  "JUICE",
  "MILK",
  "SHOT",
  "SHOTS",
  "SNACK",
  "SNACKS",
  "WATER",
]);

export function normalizeProductIntent(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bBAGS\b/g, "BAG")
    .replace(/\bSHOTS\b/g, "SHOT");
}

function tokens(value: string) {
  return value.split(" ").filter(Boolean);
}

function isGenericFamilyPhrase(value: string, productFamily?: string | null) {
  const normalized = normalizeProductIntent(value);
  const family = normalizeProductIntent(productFamily ?? "");
  const words = tokens(normalized);
  return (
    normalized === family ||
    (words.length === 1 && GENERIC_PRODUCT_FAMILY_WORDS.has(words[0] ?? ""))
  );
}

function descriptiveSubset(left: string, right: string) {
  const leftTokens = tokens(left);
  if (leftTokens.length < 2) return false;
  const rightTokens = new Set(tokens(right));
  return leftTokens.every((token) => rightTokens.has(token));
}

function scoreCandidate(
  label: string,
  candidate: CatalogIntentCandidate,
): Omit<CatalogIntentResolution, "candidate"> | null {
  if ((candidate.confidenceBps ?? 10_000) < 9_000) return null;
  const normalizedLabel = normalizeProductIntent(label);
  if (!normalizedLabel) return null;
  const canonical = normalizeProductIntent(candidate.canonicalName);
  if (normalizedLabel === canonical) {
    return { confidenceBps: 10_000, reason: "canonical_exact" };
  }

  const aliases = [...new Set(candidate.searchAliases ?? [])]
    .filter((alias) => !isGenericFamilyPhrase(alias, candidate.productFamily))
    .map(normalizeProductIntent)
    .filter(Boolean);
  if (aliases.includes(normalizedLabel)) {
    return { confidenceBps: 9_900, reason: "alias_exact" };
  }

  const descriptiveNames = [
    canonical,
    normalizeProductIntent(
      [candidate.brand, candidate.productFamily, candidate.variant]
        .filter(Boolean)
        .join(" "),
    ),
    ...aliases,
  ].filter(Boolean);
  const normalizedVariant = normalizeProductIntent(candidate.variant ?? "");
  const labelTokens = new Set(tokens(normalizedLabel));
  const includesMeaningfulVariant =
    !normalizedVariant ||
    tokens(normalizedVariant).every((token) => labelTokens.has(token));
  if (
    includesMeaningfulVariant &&
    descriptiveNames.some((name) => descriptiveSubset(normalizedLabel, name))
  ) {
    return { confidenceBps: 9_500, reason: "descriptive_subset" };
  }
  return null;
}

export function resolveSpecificCatalogProduct(
  label: string,
  candidates: CatalogIntentCandidate[],
): CatalogIntentResolution | null {
  const scored = candidates
    .map((candidate) => {
      const score = scoreCandidate(label, candidate);
      return score ? { candidate, ...score } : null;
    })
    .filter((entry): entry is CatalogIntentResolution => Boolean(entry))
    .sort(
      (left, right) =>
        right.confidenceBps - left.confidenceBps ||
        left.candidate.id.localeCompare(right.candidate.id),
    );
  const best = scored[0];
  if (!best) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.confidenceBps - runnerUp.confidenceBps < 100) return null;
  return best;
}
