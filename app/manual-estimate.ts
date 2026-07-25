export const MAX_MANUAL_ESTIMATE_CENTS = 10_000_000;

export type ManualEstimateParseResult =
  | { cents: number; error: null }
  | { cents: null; error: string };

export function parseManualEstimateDollars(
  rawValue: string,
): ManualEstimateParseResult {
  const normalized = rawValue.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return {
      cents: null,
      error: "Enter a dollar amount with no more than two decimal places.",
    };
  }

  const cents = Math.round(Number(normalized) * 100);
  if (cents <= 0 || cents > MAX_MANUAL_ESTIMATE_CENTS) {
    return {
      cents: null,
      error: "Enter an amount between $0.01 and $100,000.",
    };
  }

  return { cents, error: null };
}

export function manualEstimateDraft(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}
