export type ReceiptTaxStatus = "taxable" | "non_taxable" | "unknown";

export interface ReceiptParseWarning {
  code:
    | "ambiguous_amount"
    | "ambiguous_item"
    | "conflicting_summary"
    | "decimal_separator_normalized"
    | "quantity_total_mismatch";
  lineNumber: number;
  rawLine: string;
  message: string;
}

export interface ReceiptMoneyCandidate {
  cents: number;
  lineNumber: number;
  rawLine: string;
}

export interface ParsedReceiptItem {
  sourceLineNumber: number;
  rawLine: string;
  costcoItemNumber: string | null;
  rawDescription: string;
  normalizedDescription: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  lineSubtotalCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: ReceiptTaxStatus;
  isReturn: boolean;
  kind: "item" | "discount";
  parseConfidenceBps: number;
}

export interface ParsedCostcoReceiptDraft {
  items: ParsedReceiptItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  discountCents: number | null;
  candidates: {
    subtotal: ReceiptMoneyCandidate[];
    tax: ReceiptMoneyCandidate[];
    total: ReceiptMoneyCandidate[];
    discount: ReceiptMoneyCandidate[];
  };
  warnings: ReceiptParseWarning[];
}

interface ParsedMoney {
  cents: number;
  normalizedComma: boolean;
}

const SUMMARY_LABELS = /^(SUB\s*TOTAL|TAX|GRAND\s+TOTAL|TOTAL|DISCOUNTS?|COUPONS?)\b/i;
const NON_ITEM_LABELS = /^(?:VISA|MASTERCARD|AMEX|CASH|CHANGE|TENDER|APPROVED|BALANCE|PAYMENT|MEMBER|ITEMS?\s+SOLD|NUMBER\s+OF\s+ITEMS|THANK\s+YOU)\b/i;
const DISCOUNT_LABELS = /\b(?:COUPON|DISCOUNT|INSTANT\s+SAVINGS|REBATE|MFR)\b/i;
const TRAILING_MONEY = /(?:^|\s)(\(?-?\$?\d[\d,]*(?:[.,]\d{2})\)?-?)(?:\s*([A-Za-z*]+))?\s*$/;

export function normalizeReceiptDescription(value: string): string {
  return String(value ?? "")
    .replace(/[™®©]/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9%]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseMoneyToken(value: string): ParsedMoney | null {
  let token = value.trim().replace(/\$/g, "");
  let sign = 1;

  if (token.startsWith("(") && token.endsWith(")")) {
    sign = -1;
    token = token.slice(1, -1);
  }
  if (token.startsWith("-")) {
    sign = -1;
    token = token.slice(1);
  }
  if (token.endsWith("-")) {
    sign = -1;
    token = token.slice(0, -1);
  }

  let normalizedComma = false;
  if (/^\d+,\d{2}$/.test(token)) {
    token = token.replace(",", ".");
    normalizedComma = true;
  } else if (/^\d{1,3}(?:,\d{3})+\.\d{2}$/.test(token)) {
    token = token.replace(/,/g, "");
  }

  const match = token.match(/^(\d+)\.(\d{2})$/);
  if (!match) return null;

  const dollars = Number(match[1]);
  const cents = Number(match[2]);
  if (!Number.isSafeInteger(dollars) || dollars > 100_000_000) return null;
  return { cents: sign * (dollars * 100 + cents), normalizedComma };
}

function taxStatusFromSuffix(suffix: string | undefined): ReceiptTaxStatus {
  if (!suffix) return "unknown";
  const normalized = suffix.toUpperCase();
  if (/^[ATY*]+$/.test(normalized)) return "taxable";
  if (normalized === "N") return "non_taxable";
  return "unknown";
}

function resolveSummaryCandidate(
  label: string,
  values: ReceiptMoneyCandidate[],
  warnings: ReceiptParseWarning[],
): number | null {
  const uniqueValues = [...new Set(values.map((candidate) => candidate.cents))];
  if (uniqueValues.length === 0) return null;
  if (uniqueValues.length === 1) return uniqueValues[0];

  const last = values.at(-1)!;
  warnings.push({
    code: "conflicting_summary",
    lineNumber: last.lineNumber,
    rawLine: last.rawLine,
    message: `Conflicting ${label} values need review.`,
  });
  return null;
}

function parseQuantity(
  description: string,
  totalCents: number,
): {
  description: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  mismatch: boolean;
} {
  const patterns = [
    /^(.*?)\s+(\d+(?:\.\d{1,3})?)\s*[@xX]\s*\$?(\d+[.,]\d{2})$/,
    /^(\d+(?:\.\d{1,3})?)\s*[xX]\s+(.+?)\s+@\s*\$?(\d+[.,]\d{2})$/,
  ] as const;

  const trailing = description.match(patterns[0]);
  const leading = trailing ? null : description.match(patterns[1]);
  if (!trailing && !leading) {
    return {
      description: description.trim(),
      quantityMilli: 1000,
      unitPriceCents: null,
      mismatch: false,
    };
  }

  const descriptionValue = (trailing ? trailing[1] : leading![2]).trim();
  const quantityValue = Number(trailing ? trailing[2] : leading![1]);
  const unitPrice = parseMoneyToken(trailing ? trailing[3] : leading![3]);
  if (
    !descriptionValue ||
    !Number.isFinite(quantityValue) ||
    quantityValue <= 0 ||
    quantityValue > 1_000 ||
    !unitPrice ||
    unitPrice.cents < 0
  ) {
    return {
      description: "",
      quantityMilli: 1000,
      unitPriceCents: null,
      mismatch: false,
    };
  }

  const quantityMilli = Math.round(quantityValue * 1000);
  const calculatedTotal = Math.round((unitPrice.cents * quantityMilli) / 1000);
  return {
    description: descriptionValue,
    quantityMilli,
    unitPriceCents: unitPrice.cents,
    mismatch: Math.abs(calculatedTotal - Math.abs(totalCents)) > 5,
  };
}

export function parseCostcoOcrText(text: string): ParsedCostcoReceiptDraft {
  const items: ParsedReceiptItem[] = [];
  const warnings: ReceiptParseWarning[] = [];
  const candidates = {
    subtotal: [] as ReceiptMoneyCandidate[],
    tax: [] as ReceiptMoneyCandidate[],
    total: [] as ReceiptMoneyCandidate[],
    discount: [] as ReceiptMoneyCandidate[],
  };

  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((sourceLine, index) => {
    const lineNumber = index + 1;
    const rawLine = sourceLine.trim().replace(/\s+/g, " ");
    if (!rawLine) return;

    const amountMatch = rawLine.match(TRAILING_MONEY);
    const money = amountMatch ? parseMoneyToken(amountMatch[1]) : null;
    const summaryMatch = rawLine.match(SUMMARY_LABELS);

    if (summaryMatch) {
      if (!money) {
        warnings.push({
          code: "ambiguous_amount",
          lineNumber,
          rawLine,
          message: "This summary amount could not be read safely.",
        });
        return;
      }
      const normalizedLabel = summaryMatch[1].replace(/\s+/g, " ").toUpperCase();
      const candidate: ReceiptMoneyCandidate = {
        cents: normalizedLabel.startsWith("DISCOUNT") || normalizedLabel.startsWith("COUPON")
          ? Math.abs(money.cents)
          : money.cents,
        lineNumber,
        rawLine,
      };
      if (normalizedLabel.startsWith("SUB")) candidates.subtotal.push(candidate);
      else if (normalizedLabel === "TAX") candidates.tax.push(candidate);
      else if (normalizedLabel.startsWith("DISCOUNT") || normalizedLabel.startsWith("COUPON")) {
        candidates.discount.push(candidate);
      } else candidates.total.push(candidate);

      if (money.normalizedComma) {
        warnings.push({
          code: "decimal_separator_normalized",
          lineNumber,
          rawLine,
          message: "A comma decimal separator was normalized; please verify the amount.",
        });
      }
      return;
    }

    if (NON_ITEM_LABELS.test(rawLine)) return;
    if (!money || !amountMatch) {
      if (/\d[\dOoIl]*[.,]?\d{2}\s*[A-Za-z*-]*$/.test(rawLine)) {
        warnings.push({
          code: "ambiguous_amount",
          lineNumber,
          rawLine,
          message: "A possible amount was present, but no line amount was invented.",
        });
      }
      return;
    }

    let descriptionPart = rawLine.slice(0, amountMatch.index).trim();
    let costcoItemNumber: string | null = null;
    const itemNumberMatch = descriptionPart.match(/^(\d{4,8})\s+(.+)$/);
    if (itemNumberMatch) {
      costcoItemNumber = itemNumberMatch[1];
      descriptionPart = itemNumberMatch[2].trim();
    }

    const quantity = parseQuantity(descriptionPart, money.cents);
    if (!quantity.description) {
      warnings.push({
        code: "ambiguous_item",
        lineNumber,
        rawLine,
        message: "The amount was readable, but the product description was not.",
      });
      return;
    }
    if (quantity.mismatch) {
      warnings.push({
        code: "quantity_total_mismatch",
        lineNumber,
        rawLine,
        message: "Quantity times unit price does not match the printed line total.",
      });
    }
    if (money.normalizedComma) {
      warnings.push({
        code: "decimal_separator_normalized",
        lineNumber,
        rawLine,
        message: "A comma decimal separator was normalized; please verify the amount.",
      });
    }

    const normalizedDescription = normalizeReceiptDescription(quantity.description);
    if (!normalizedDescription) {
      warnings.push({
        code: "ambiguous_item",
        lineNumber,
        rawLine,
        message: "The product description could not be normalized safely.",
      });
      return;
    }

    const isDiscount = money.cents < 0 && DISCOUNT_LABELS.test(quantity.description);
    const isReturn = money.cents < 0 && !isDiscount;
    items.push({
      sourceLineNumber: lineNumber,
      rawLine,
      costcoItemNumber,
      rawDescription: quantity.description,
      normalizedDescription,
      quantityMilli: quantity.quantityMilli,
      unitPriceCents: quantity.unitPriceCents,
      lineSubtotalCents: isDiscount ? 0 : money.cents,
      discountCents: isDiscount ? Math.abs(money.cents) : 0,
      netAmountCents: money.cents,
      taxStatus: taxStatusFromSuffix(amountMatch[2]),
      isReturn,
      kind: isDiscount ? "discount" : "item",
      parseConfidenceBps:
        (costcoItemNumber ? 400 : 0) +
        (quantity.unitPriceCents !== null ? 200 : 0) +
        (money.normalizedComma ? 8_700 : 9_300),
    });
  });

  const explicitDiscountCents = items.reduce(
    (sum, item) => sum + (item.kind === "discount" ? item.discountCents : 0),
    0,
  );
  const candidateDiscount = resolveSummaryCandidate(
    "discount",
    candidates.discount,
    warnings,
  );

  return {
    items,
    subtotalCents: resolveSummaryCandidate("subtotal", candidates.subtotal, warnings),
    taxCents: resolveSummaryCandidate("tax", candidates.tax, warnings),
    totalCents: resolveSummaryCandidate("total", candidates.total, warnings),
    discountCents: candidateDiscount ?? (explicitDiscountCents > 0 ? explicitDiscountCents : null),
    candidates,
    warnings,
  };
}

export interface ReceiptArithmeticItem {
  lineSubtotalCents?: number | null;
  discountCents?: number | null;
  netAmountCents?: number | null;
  kind?: "item" | "discount";
}

export interface ReceiptReconciliation {
  itemNetCents: number;
  subtotalDeltaCents: number | null;
  totalDeltaCents: number | null;
  representedDiscountCents: number;
  appliedReceiptLevelDiscountCents: number;
  isReconciled: boolean;
  explanations: string[];
}

export function reconcileReceipt(input: {
  items: ReceiptArithmeticItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  discountCents?: number | null;
}): ReceiptReconciliation {
  let representedDiscountCents = 0;
  let rawItemNetCents = 0;

  for (const item of input.items) {
    const itemDiscount = Number.isInteger(item.discountCents)
      ? Math.max(0, item.discountCents ?? 0)
      : 0;
    const net = Number.isInteger(item.netAmountCents)
      ? (item.netAmountCents as number)
      : (Number.isInteger(item.lineSubtotalCents) ? (item.lineSubtotalCents as number) : 0) -
        itemDiscount;
    rawItemNetCents += net;
    representedDiscountCents +=
      item.kind === "discount" && itemDiscount === 0
        ? Math.abs(Math.min(0, net))
        : itemDiscount;
  }

  const receiptDiscountCents = Number.isInteger(input.discountCents)
    ? Math.abs(input.discountCents ?? 0)
    : representedDiscountCents;
  const appliedReceiptLevelDiscountCents = Math.max(
    0,
    receiptDiscountCents - representedDiscountCents,
  );
  const itemNetCents = rawItemNetCents - appliedReceiptLevelDiscountCents;
  const subtotalDeltaCents = Number.isInteger(input.subtotalCents)
    ? itemNetCents - (input.subtotalCents as number)
    : null;
  const totalDeltaCents =
    Number.isInteger(input.subtotalCents) &&
    Number.isInteger(input.taxCents) &&
    Number.isInteger(input.totalCents)
      ? (input.subtotalCents as number) +
        (input.taxCents as number) -
        (input.totalCents as number)
      : null;
  const isReconciled =
    subtotalDeltaCents !== null &&
    totalDeltaCents !== null &&
    Math.abs(subtotalDeltaCents) <= 5 &&
    Math.abs(totalDeltaCents) <= 5;

  const explanations: string[] = [];
  if (appliedReceiptLevelDiscountCents > 0) {
    explanations.push(
      `${appliedReceiptLevelDiscountCents} cents of receipt-level discounts were not already represented by item lines.`,
    );
  }
  explanations.push(
    subtotalDeltaCents === null
      ? "A subtotal is required to reconcile item lines."
      : `Item lines differ from the printed subtotal by ${subtotalDeltaCents} cents.`,
  );
  explanations.push(
    totalDeltaCents === null
      ? "Subtotal, tax, and total are all required to reconcile the final total."
      : `Subtotal plus tax differs from the printed total by ${totalDeltaCents} cents.`,
  );
  explanations.push(
    isReconciled
      ? "Both arithmetic checks are within the five-cent trust threshold."
      : "The receipt remains provisional until both arithmetic checks are within five cents.",
  );

  return {
    itemNetCents,
    subtotalDeltaCents,
    totalDeltaCents,
    representedDiscountCents,
    appliedReceiptLevelDiscountCents,
    isReconciled,
    explanations,
  };
}

export interface ReceiptIntentItem {
  id: string;
  productId?: string | null;
  costcoItemNumber?: string | null;
  label?: string | null;
  frozenLabel?: string | null;
  section?: string | null;
  source?: string | null;
  includedAtFreeze?: boolean | null;
  addedAfterFreeze?: boolean;
  quantityMilli?: number | null;
  estimatedPriceCents?: number | null;
}

export interface MatchableReceiptItem {
  id: string;
  productId?: string | null;
  costcoItemNumber?: string | null;
  rawDescription?: string | null;
  canonicalName?: string | null;
  quantityMilli?: number | null;
  netAmountCents?: number | null;
  lineSubtotalCents?: number | null;
  discountCents?: number | null;
  kind?: "item" | "discount";
  isReturn?: boolean;
  parseConfidenceBps?: number | null;
}

export interface ConfirmedProductAlias {
  alias?: string | null;
  rawDescription?: string | null;
  normalizedDescription?: string | null;
  productId?: string | null;
  targetProductId?: string | null;
  costcoItemNumber?: string | null;
  targetCostcoItemNumber?: string | null;
  canonicalName?: string | null;
  confirmed?: boolean;
}

export interface ReceiptIntentMatch {
  intentItemId: string;
  receiptItemId: string;
  status: "auto_matched" | "candidate";
  confidenceBps: number;
  reason:
    | "exact_item_number"
    | "confirmed_alias"
    | "exact_product"
    | "normalized_exact"
    | "fuzzy_candidate";
  expectedQuantityMilli: number;
  actualQuantityMilli: number;
  quantityRatioBps: number;
}

export interface ReceiptMatchingResult {
  matches: ReceiptIntentMatch[];
  unmatchedIntentItemIds: string[];
  unmatchedReceiptItemIds: string[];
}

function labelForIntent(item: ReceiptIntentItem): string {
  return item.frozenLabel ?? item.label ?? "";
}

function labelForReceipt(item: MatchableReceiptItem): string {
  return item.canonicalName ?? item.rawDescription ?? "";
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function aliasTargetsIntent(
  alias: ConfirmedProductAlias,
  intent: ReceiptIntentItem,
): boolean {
  const targetProductId = alias.targetProductId ?? alias.productId;
  const targetItemNumber = alias.targetCostcoItemNumber ?? alias.costcoItemNumber;
  if (targetProductId && intent.productId && targetProductId === intent.productId) return true;
  if (
    targetItemNumber &&
    intent.costcoItemNumber &&
    targetItemNumber === intent.costcoItemNumber
  ) {
    return true;
  }
  return Boolean(
    alias.canonicalName &&
      normalizeReceiptDescription(alias.canonicalName) ===
        normalizeReceiptDescription(labelForIntent(intent)),
  );
}

function scorePair(
  intent: ReceiptIntentItem,
  receipt: MatchableReceiptItem,
  aliases: ConfirmedProductAlias[],
): Pick<ReceiptIntentMatch, "confidenceBps" | "reason"> | null {
  if (
    intent.costcoItemNumber &&
    receipt.costcoItemNumber &&
    intent.costcoItemNumber === receipt.costcoItemNumber
  ) {
    return { confidenceBps: 10_000, reason: "exact_item_number" };
  }

  const normalizedReceipt = normalizeReceiptDescription(labelForReceipt(receipt));
  const confirmedAlias = aliases.find((alias) => {
    if (alias.confirmed === false) return false;
    const aliasLabel =
      alias.normalizedDescription ?? alias.alias ?? alias.rawDescription ?? "";
    return (
      normalizeReceiptDescription(aliasLabel) === normalizedReceipt &&
      aliasTargetsIntent(alias, intent)
    );
  });
  if (confirmedAlias) {
    return { confidenceBps: 9_900, reason: "confirmed_alias" };
  }

  if (intent.productId && receipt.productId && intent.productId === receipt.productId) {
    return { confidenceBps: 9_800, reason: "exact_product" };
  }

  const normalizedIntent = normalizeReceiptDescription(labelForIntent(intent));
  if (normalizedIntent && normalizedIntent === normalizedReceipt) {
    return { confidenceBps: 9_400, reason: "normalized_exact" };
  }

  const similarity = tokenSimilarity(normalizedIntent, normalizedReceipt);
  if (similarity < 0.4) return null;
  return {
    confidenceBps: Math.min(9_200, Math.round(6_500 + similarity * 2_500)),
    reason: "fuzzy_candidate",
  };
}

export function matchReceiptItemsToIntent(input: {
  intentItems: ReceiptIntentItem[];
  receiptItems: MatchableReceiptItem[];
  aliases?: ConfirmedProductAlias[];
}): ReceiptMatchingResult {
  const aliases = input.aliases ?? [];
  const possible: Array<ReceiptIntentMatch & { quantityDistance: number }> = [];

  for (const intent of input.intentItems) {
    for (const receipt of input.receiptItems) {
      if (receipt.kind === "discount") continue;
      const score = scorePair(intent, receipt, aliases);
      if (!score) continue;
      const expectedQuantityMilli =
        Number.isFinite(intent.quantityMilli) && (intent.quantityMilli ?? 0) > 0
          ? (intent.quantityMilli as number)
          : 1000;
      const actualQuantityMilli =
        Number.isFinite(receipt.quantityMilli) && (receipt.quantityMilli ?? 0) > 0
          ? (receipt.quantityMilli as number)
          : 1000;
      const quantityRatioBps = Math.round(
        (Math.min(expectedQuantityMilli, actualQuantityMilli) /
          Math.max(expectedQuantityMilli, actualQuantityMilli)) *
          10_000,
      );
      possible.push({
        intentItemId: intent.id,
        receiptItemId: receipt.id,
        status: score.confidenceBps >= 9_300 ? "auto_matched" : "candidate",
        confidenceBps: score.confidenceBps,
        reason: score.reason,
        expectedQuantityMilli,
        actualQuantityMilli,
        quantityRatioBps,
        quantityDistance: Math.abs(expectedQuantityMilli - actualQuantityMilli),
      });
    }
  }

  possible.sort(
    (left, right) =>
      right.confidenceBps - left.confidenceBps ||
      left.quantityDistance - right.quantityDistance ||
      left.intentItemId.localeCompare(right.intentItemId) ||
      left.receiptItemId.localeCompare(right.receiptItemId),
  );

  const usedIntent = new Set<string>();
  const usedReceipt = new Set<string>();
  const matches: ReceiptIntentMatch[] = [];
  for (const candidate of possible) {
    if (usedIntent.has(candidate.intentItemId) || usedReceipt.has(candidate.receiptItemId)) {
      continue;
    }
    usedIntent.add(candidate.intentItemId);
    usedReceipt.add(candidate.receiptItemId);
    matches.push({
      intentItemId: candidate.intentItemId,
      receiptItemId: candidate.receiptItemId,
      status: candidate.status,
      confidenceBps: candidate.confidenceBps,
      reason: candidate.reason,
      expectedQuantityMilli: candidate.expectedQuantityMilli,
      actualQuantityMilli: candidate.actualQuantityMilli,
      quantityRatioBps: candidate.quantityRatioBps,
    });
  }

  return {
    matches,
    unmatchedIntentItemIds: input.intentItems
      .filter((item) => !usedIntent.has(item.id))
      .map((item) => item.id),
    unmatchedReceiptItemIds: input.receiptItems
      .filter((item) => item.kind !== "discount" && !usedReceipt.has(item.id))
      .map((item) => item.id),
  };
}

export const deterministicMatchReceiptItems = matchReceiptItemsToIntent;

export interface ComparisonEntry {
  intentItem: ReceiptIntentItem | null;
  receiptItem: MatchableReceiptItem | null;
  match: ReceiptIntentMatch | null;
  reason?: string;
}

export interface TripComparison {
  buckets: {
    savedAndPurchased: ComparisonEntry[];
    savedNotFound: ComparisonEntry[];
    addedDuringTripAndPurchased: ComparisonEntry[];
    considerOrCheckFirstPurchased: ComparisonEntry[];
    receiptOnlyAdditions: ComparisonEntry[];
    possibleSubstitutions: ComparisonEntry[];
    unresolved: ComparisonEntry[];
  };
  bridge: {
    estimatedCents: number | null;
    actualTotalCents: number | null;
    estimatedToActualDeltaCents: number | null;
    matchedPlannedEstimatedCents: number;
    matchedPlannedActualCents: number;
    priceAndQuantityVarianceCents: number;
    unpricedPlannedActualCents: number;
    skippedPlannedEstimateCents: number;
    inStoreAdditionsCents: number;
    considerOrCheckFirstActualCents: number;
    receiptOnlyAdditionsCents: number;
    substitutionActualCents: number;
    substitutionVarianceCents: number;
    discountsCents: number;
    taxCents: number;
    unresolvedCents: number;
  };
}

function receiptAmount(item: MatchableReceiptItem): number {
  if (Number.isInteger(item.netAmountCents)) return item.netAmountCents as number;
  return (
    (Number.isInteger(item.lineSubtotalCents) ? (item.lineSubtotalCents as number) : 0) -
    (Number.isInteger(item.discountCents) ? Math.max(0, item.discountCents as number) : 0)
  );
}

function intentEstimate(item: ReceiptIntentItem): number | null {
  if (!Number.isInteger(item.estimatedPriceCents)) return null;
  return Math.round(
    ((item.estimatedPriceCents as number) * (item.quantityMilli ?? 1000)) / 1000,
  );
}

export function buildTripComparison(input: {
  intentItems: ReceiptIntentItem[];
  receiptItems: MatchableReceiptItem[];
  matches: ReceiptIntentMatch[];
  estimatedTotalCents?: number | null;
  actualTotalCents?: number | null;
  discountCents?: number | null;
  taxCents?: number | null;
}): TripComparison {
  const buckets: TripComparison["buckets"] = {
    savedAndPurchased: [],
    savedNotFound: [],
    addedDuringTripAndPurchased: [],
    considerOrCheckFirstPurchased: [],
    receiptOnlyAdditions: [],
    possibleSubstitutions: [],
    unresolved: [],
  };
  const intentById = new Map(input.intentItems.map((item) => [item.id, item]));
  const receiptById = new Map(input.receiptItems.map((item) => [item.id, item]));
  const matchedIntentIds = new Set<string>();
  const matchedReceiptIds = new Set<string>();

  let matchedPlannedEstimatedCents = 0;
  let matchedPlannedActualCents = 0;
  let priceAndQuantityVarianceCents = 0;
  let unpricedPlannedActualCents = 0;
  let inStoreAdditionsCents = 0;
  let considerOrCheckFirstActualCents = 0;
  let substitutionActualCents = 0;
  let substitutionVarianceCents = 0;

  for (const match of input.matches) {
    const intentItem = intentById.get(match.intentItemId) ?? null;
    const receiptItem = receiptById.get(match.receiptItemId) ?? null;
    if (!intentItem || !receiptItem) {
      buckets.unresolved.push({
        intentItem,
        receiptItem,
        match,
        reason: "match_reference_missing",
      });
      continue;
    }
    matchedIntentIds.add(intentItem.id);
    matchedReceiptIds.add(receiptItem.id);
    const entry = { intentItem, receiptItem, match };
    const actualCents = receiptAmount(receiptItem);
    const estimateCents = intentEstimate(intentItem);

    if (match.status === "candidate") {
      buckets.possibleSubstitutions.push(entry);
      substitutionActualCents += actualCents;
      if (estimateCents !== null) {
        substitutionVarianceCents += actualCents - estimateCents;
      }
      continue;
    }
    if (intentItem.addedAfterFreeze || intentItem.source === "in_store") {
      buckets.addedDuringTripAndPurchased.push(entry);
      inStoreAdditionsCents += actualCents;
      continue;
    }
    if (intentItem.section === "consider" || intentItem.section === "check_first") {
      buckets.considerOrCheckFirstPurchased.push(entry);
      if (!intentItem.includedAtFreeze) {
        considerOrCheckFirstActualCents += actualCents;
      }
    } else {
      buckets.savedAndPurchased.push(entry);
    }

    if (intentItem.includedAtFreeze) {
      matchedPlannedActualCents += actualCents;
      if (estimateCents === null) {
        unpricedPlannedActualCents += actualCents;
      } else {
        matchedPlannedEstimatedCents += estimateCents;
        priceAndQuantityVarianceCents += actualCents - estimateCents;
      }
    }
  }

  let skippedPlannedEstimateCents = 0;
  for (const intentItem of input.intentItems) {
    if (!matchedIntentIds.has(intentItem.id) && intentItem.includedAtFreeze) {
      buckets.savedNotFound.push({ intentItem, receiptItem: null, match: null });
      skippedPlannedEstimateCents += intentEstimate(intentItem) ?? 0;
    }
  }

  let receiptOnlyAdditionsCents = 0;
  let parsedDiscountCents = 0;
  let unresolvedCents = 0;
  for (const receiptItem of input.receiptItems) {
    if (matchedReceiptIds.has(receiptItem.id)) continue;
    const amountCents = receiptAmount(receiptItem);
    if (receiptItem.kind === "discount") {
      parsedDiscountCents += Math.abs(amountCents);
      continue;
    }
    if (
      receiptItem.isReturn ||
      (Number.isInteger(receiptItem.parseConfidenceBps) &&
        (receiptItem.parseConfidenceBps as number) < 7_000)
    ) {
      buckets.unresolved.push({
        intentItem: null,
        receiptItem,
        match: null,
        reason: receiptItem.isReturn ? "return_line" : "low_parse_confidence",
      });
      unresolvedCents += amountCents;
      continue;
    }
    buckets.receiptOnlyAdditions.push({
      intentItem: null,
      receiptItem,
      match: null,
    });
    receiptOnlyAdditionsCents += amountCents;
  }

  const estimatedCents = Number.isInteger(input.estimatedTotalCents)
    ? (input.estimatedTotalCents as number)
    : input.intentItems.reduce(
        (sum, item) =>
          sum + (item.includedAtFreeze ? intentEstimate(item) ?? 0 : 0),
        0,
      );
  const actualTotalCents = Number.isInteger(input.actualTotalCents)
    ? (input.actualTotalCents as number)
    : null;

  return {
    buckets,
    bridge: {
      estimatedCents,
      actualTotalCents,
      estimatedToActualDeltaCents:
        actualTotalCents === null ? null : actualTotalCents - estimatedCents,
      matchedPlannedEstimatedCents,
      matchedPlannedActualCents,
      priceAndQuantityVarianceCents,
      unpricedPlannedActualCents,
      skippedPlannedEstimateCents,
      inStoreAdditionsCents,
      considerOrCheckFirstActualCents,
      receiptOnlyAdditionsCents,
      substitutionActualCents,
      substitutionVarianceCents,
      discountsCents: Math.max(Math.abs(input.discountCents ?? 0), parsedDiscountCents),
      taxCents: input.taxCents ?? 0,
      unresolvedCents,
    },
  };
}

export interface ReviewQuestionOption {
  value: string;
  label: string;
  effect: string;
}

export interface ReviewQuestionCandidate {
  id: string;
  kind: "data_quality" | "behavioral";
  priority: number;
  prompt: string;
  purpose: string;
  options: ReviewQuestionOption[];
  effectTarget:
    | "receipt_record"
    | "receipt_match"
    | "next_saturday_list"
    | "product_insight";
  intentItemId?: string;
  receiptItemId?: string;
}

function displayReceiptItem(item: MatchableReceiptItem | null): string {
  return item ? labelForReceipt(item) || "this receipt line" : "this receipt line";
}

function formatDollars(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function buildReviewQuestionCandidates(input: {
  comparison: TripComparison;
  isReconciled: boolean;
  receiptTotalCents?: number | null;
  parseWarnings?: ReceiptParseWarning[];
  maxQuestions?: number;
}): ReviewQuestionCandidate[] {
  const questions: ReviewQuestionCandidate[] = [];
  const maxQuestions = Math.min(3, Math.max(0, input.maxQuestions ?? 3));

  if (!input.isReconciled) {
    questions.push({
      id: "verify-receipt-arithmetic",
      kind: "data_quality",
      priority: 0,
      prompt: "The item lines and printed totals do not fully agree. What should we check?",
      purpose: "Keep the trip total and every downstream insight trustworthy.",
      options: [
        {
          value: "review_lines",
          label: "Review item lines",
          effect: "Opens the receipt lines for correction.",
        },
        {
          value: "review_totals",
          label: "Review totals",
          effect: "Opens subtotal, tax, discounts, and total for correction.",
        },
        {
          value: "keep_provisional",
          label: "Finish later",
          effect: "Keeps insights clearly marked as provisional.",
        },
      ],
      effectTarget: "receipt_record",
    });
  }

  const unresolved = [...input.comparison.buckets.unresolved].sort((left, right) => {
    const amountDifference =
      Math.abs(receiptAmount(right.receiptItem ?? { id: "" })) -
      Math.abs(receiptAmount(left.receiptItem ?? { id: "" }));
    return (
      amountDifference ||
      (left.receiptItem?.id ?? "").localeCompare(right.receiptItem?.id ?? "")
    );
  })[0];
  const hasParseWarning = (input.parseWarnings?.length ?? 0) > 0;
  if (unresolved?.receiptItem || hasParseWarning) {
    const receiptItem = unresolved?.receiptItem ?? null;
    questions.push({
      id: `verify-receipt-line-${receiptItem?.id ?? "warning"}`,
      kind: "data_quality",
      priority: 10,
      prompt: `Can you help us identify ${displayReceiptItem(receiptItem)}?`,
      purpose: "Correct or classify an uncertain receipt line before using it in insights.",
      options: [
        {
          value: "correct_product",
          label: "Correct the product",
          effect: "Updates this receipt and remembers the confirmed alias.",
        },
        {
          value: "discount_or_return",
          label: "Discount or return",
          effect: "Moves the amount out of purchase additions.",
        },
        {
          value: "leave_unresolved",
          label: "Not sure yet",
          effect: "Keeps this amount visible as unresolved.",
        },
      ],
      effectTarget: "receipt_record",
      receiptItemId: receiptItem?.id,
    });
  }

  const missingEssential = [...input.comparison.buckets.savedNotFound]
    .filter((entry) => entry.intentItem?.section === "essentials")
    .sort((left, right) => {
      const estimateDifference =
        (intentEstimate(right.intentItem!) ?? 0) -
        (intentEstimate(left.intentItem!) ?? 0);
      return (
        estimateDifference ||
        labelForIntent(left.intentItem!).localeCompare(labelForIntent(right.intentItem!))
      );
    })[0];
  if (missingEssential?.intentItem) {
    const item = missingEssential.intentItem;
    questions.push({
      id: `missing-essential-${item.id}`,
      kind: "behavioral",
      priority: 20,
      prompt: `We could not match ${labelForIntent(item)} to the receipt. What happened?`,
      purpose: "Distinguish a skipped item from a substitution or receipt-reading issue.",
      options: [
        {
          value: "skipped",
          label: "Skipped this time",
          effect: "Uses this as a recent exception, not a permanent preference.",
        },
        {
          value: "substituted",
          label: "Bought an alternative",
          effect: "Lets you connect the matching receipt item.",
        },
        {
          value: "receipt_needs_fix",
          label: "It is on the receipt",
          effect: "Returns to receipt matching so the record can be corrected.",
        },
      ],
      effectTarget: "next_saturday_list",
      intentItemId: item.id,
    });
  }

  const substitution = [...input.comparison.buckets.possibleSubstitutions].sort(
    (left, right) =>
      Math.abs(receiptAmount(right.receiptItem!)) -
        Math.abs(receiptAmount(left.receiptItem!)) ||
      (left.receiptItem?.id ?? "").localeCompare(right.receiptItem?.id ?? ""),
  )[0];
  if (substitution?.intentItem && substitution.receiptItem) {
    questions.push({
      id: `possible-substitution-${substitution.intentItem.id}-${substitution.receiptItem.id}`,
      kind: "behavioral",
      priority: 30,
      prompt: `Was ${displayReceiptItem(substitution.receiptItem)} the alternative for ${labelForIntent(substitution.intentItem)}?`,
      purpose: "Confirm a possible substitution without guessing from similar names.",
      options: [
        {
          value: "yes_substitution",
          label: "Yes",
          effect: "Confirms the match and learns the household substitution.",
        },
        {
          value: "separate_purchase",
          label: "No, separate item",
          effect: "Keeps the plan item missing and the receipt item separate.",
        },
        {
          value: "not_sure",
          label: "Not sure",
          effect: "Leaves the pair unresolved without affecting future suggestions.",
        },
      ],
      effectTarget: "receipt_match",
      intentItemId: substitution.intentItem.id,
      receiptItemId: substitution.receiptItem.id,
    });
  }

  const receiptTotalCents = Math.abs(
    input.receiptTotalCents ?? input.comparison.bridge.actualTotalCents ?? 0,
  );
  const largestReceiptOnly = [...input.comparison.buckets.receiptOnlyAdditions]
    .filter((entry) => {
      const amount = Math.abs(receiptAmount(entry.receiptItem!));
      return amount >= 1_500 || (receiptTotalCents > 0 && amount / receiptTotalCents >= 0.1);
    })
    .sort(
      (left, right) =>
        Math.abs(receiptAmount(right.receiptItem!)) -
          Math.abs(receiptAmount(left.receiptItem!)) ||
        (left.receiptItem?.id ?? "").localeCompare(right.receiptItem?.id ?? ""),
    )[0];
  if (largestReceiptOnly?.receiptItem) {
    const item = largestReceiptOnly.receiptItem;
    questions.push({
      id: `receipt-only-${item.id}`,
      kind: "behavioral",
      priority: 40,
      prompt: `${displayReceiptItem(item)} (${formatDollars(receiptAmount(item))}) was not on the saved plan. How should we remember it?`,
      purpose: "Learn whether a material plan addition was useful, exceptional, or worth checking later.",
      options: [
        {
          value: "worthwhile_discovery",
          label: "Worthwhile discovery",
          effect: "Adds a positive discovery signal for future planning.",
        },
        {
          value: "seasonal_or_exceptional",
          label: "Seasonal or one-time",
          effect: "Keeps it out of routine replenishment suggestions.",
        },
        {
          value: "ask_later",
          label: "Ask after we use it",
          effect: "Schedules a later usefulness check without judging it now.",
        },
      ],
      effectTarget: "product_insight",
      receiptItemId: item.id,
    });
  }

  return questions
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .slice(0, maxQuestions);
}
