export const PRODUCT_MEMORY_PREFERENCES = [
  "buy_again",
  "pause",
  "not_for_us",
] as const;

export type ProductMemoryPreference =
  (typeof PRODUCT_MEMORY_PREFERENCES)[number];

export function isProductMemoryPreference(
  value: unknown,
): value is ProductMemoryPreference {
  return PRODUCT_MEMORY_PREFERENCES.includes(
    value as ProductMemoryPreference,
  );
}

export function productMemoryLabel(preference: ProductMemoryPreference) {
  if (preference === "buy_again") return "Buy again";
  if (preference === "pause") return "Paused";
  return "Not for us";
}

export function productMemorySuppressesSuggestion(
  preference: ProductMemoryPreference | null | undefined,
) {
  return preference === "pause" || preference === "not_for_us";
}
