/** Retrieval only: these terms must never be used to merge SKU identities. */
export type CatalogSearchProduct = {
  canonicalName: string;
  costcoItemNumber: string | null;
  latestRawDescription: string | null;
  searchTerms?: readonly string[];
};

export function normalizeCatalogSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function boundedSearchTerms(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0,
  ).map((value) => value.trim().slice(0, 100)))].slice(0, 32);
}

export function searchTermsFromJson(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? boundedSearchTerms(parsed) : [];
  } catch {
    return [];
  }
}

/** Lower is better; null means no match. Every query word must be present. */
export function catalogSearchScore(product: CatalogSearchProduct, query: string): number | null {
  const normalized = normalizeCatalogSearch(query);
  if (!normalized) return 0;
  const name = normalizeCatalogSearch(product.canonicalName);
  const sku = normalizeCatalogSearch(product.costcoItemNumber ?? "");
  const raw = normalizeCatalogSearch(product.latestRawDescription ?? "");
  const terms = (product.searchTerms ?? []).map(normalizeCatalogSearch);
  if (normalized === sku || normalized === name) return 0;
  if (normalized === raw || terms.includes(normalized)) return 1;
  const values = [name, sku, raw, ...terms];
  if (!normalized.split(/\s+/).every((word) => values.some((value) => value.includes(word)))) return null;
  if (name.startsWith(normalized)) return 2;
  return values.some((value) => value.startsWith(normalized)) ? 3 : 4;
}

export function searchCatalog<T extends CatalogSearchProduct>(products: readonly T[], query: string): T[] {
  return products.map((product) => ({ product, score: catalogSearchScore(product, query) }))
    .filter((entry): entry is { product: T; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score)
    .map(({ product }) => product);
}
