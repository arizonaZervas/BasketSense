export const RECEIPT_EXTRACTION_SCHEMA_VERSION = "costco-receipt-v1";
export const MAX_RECEIPT_SOURCE_BYTES = 8 * 1024 * 1024;
export const MAX_RECEIPT_OUTPUT_TOKENS = 16_384;

export type ReceiptExtractionErrorCode =
  | "provider_http"
  | "empty_output"
  | "invalid_json"
  | "output_truncated"
  | "schema_validation"
  | "unreadable_image"
  | "source_missing"
  | "unknown";

export class ReceiptExtractionError extends Error {
  constructor(
    readonly code: ReceiptExtractionErrorCode,
    message: string,
    readonly details: {
      responseId?: string | null;
      finishReason?: string | null;
      durationMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "ReceiptExtractionError";
  }
}

export function receiptExtractionErrorCode(error: unknown): ReceiptExtractionErrorCode {
  return error instanceof ReceiptExtractionError ? error.code : "unknown";
}

export type ExtractedReceiptLine = {
  itemNumber: string | null;
  rawDescription: string;
  quantityMilli: number;
  lineSubtotalCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: "taxable" | "non_taxable" | "unknown";
  confidenceBps: number;
  needsReview: boolean;
};

export type ExtractedReceiptDraft = {
  purchasedAt: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  discountCents: number;
  lines: ExtractedReceiptLine[];
  warnings: string[];
};

type GeminiGenerateContentResponse = {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
};

const receiptDraftSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "purchasedAt",
    "subtotalCents",
    "taxCents",
    "totalCents",
    "discountCents",
    "lines",
    "warnings",
  ],
  properties: {
    purchasedAt: { type: ["string", "null"] },
    subtotalCents: { type: ["integer", "null"] },
    taxCents: { type: ["integer", "null"] },
    totalCents: { type: ["integer", "null"] },
    discountCents: { type: "integer", minimum: 0 },
    warnings: { type: "array", items: { type: "string" }, maxItems: 12 },
    lines: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "itemNumber",
          "rawDescription",
          "quantityMilli",
          "lineSubtotalCents",
          "discountCents",
          "netAmountCents",
          "taxStatus",
          "confidenceBps",
          "needsReview",
        ],
        properties: {
          itemNumber: { type: ["string", "null"] },
          rawDescription: { type: "string", minLength: 1, maxLength: 180 },
          quantityMilli: { type: "integer", minimum: 1, maximum: 100000000 },
          lineSubtotalCents: { type: "integer", minimum: -100000000, maximum: 100000000 },
          discountCents: { type: "integer", minimum: 0, maximum: 100000000 },
          netAmountCents: { type: "integer", minimum: -100000000, maximum: 100000000 },
          taxStatus: { type: "string", enum: ["taxable", "non_taxable", "unknown"] },
          confidenceBps: { type: "integer", minimum: 0, maximum: 10000 },
          needsReview: { type: "boolean" },
        },
      },
    },
  },
} as const;

const instructions = `You extract Costco warehouse receipts for a private household app.
Return only information visibly supported by the supplied receipt. Use integer cents, never dollar strings or floating point. Preserve the abbreviated printed label exactly in rawDescription; do not invent a catalog name. Use null for unreadable totals or dates. A line with ambiguous text, amount, quantity, tax treatment, discount, or item number must have needsReview true and a conservative confidenceBps. Identify every visible coupon, instant saving, and discount: set its discountCents to the positive saved amount and netAmountCents to its negative effect. When an item has an attached discount, preserve its pre-discount lineSubtotalCents, record its positive discountCents, and make netAmountCents equal the paid amount. Attach savings only when the receipt visibly pairs them with a product; keep receipt-level rewards separate. Do not silently turn discounts into purchases or omit them from the receipt-level discountCents total. This is an advisory draft only: do not decide household value, planned status, categories, or accounting outcomes.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integerOrNull(value: unknown, field: string) {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer or null`);
  return value as number;
}

function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} is outside the permitted range`);
  }
  return value as number;
}

function boundedString(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isAttachedCostcoDiscountLine(
  previous: ExtractedReceiptLine | undefined,
  current: ExtractedReceiptLine
) {
  const descriptionLooksAttached =
    /^\d+\s*\/\s*\d+$/.test(current.rawDescription) ||
    /\b(?:coupon|discount|instant\s+savings|rebate|mfr)\b/i.test(
      current.rawDescription
    );
  const itemNumberLinksToPrevious = Boolean(
    previous?.itemNumber &&
      (current.itemNumber === previous.itemNumber ||
        current.rawDescription.includes(previous.itemNumber))
  );
  const canonicalDiscountShape =
    current.lineSubtotalCents <= 0 && current.netAmountCents < 0;
  const zeroNetSavingsShape =
    current.lineSubtotalCents === current.discountCents &&
    current.netAmountCents === 0 &&
    descriptionLooksAttached;
  return Boolean(
    previous &&
      previous.lineSubtotalCents > 0 &&
      current.discountCents > 0 &&
      (canonicalDiscountShape || zeroNetSavingsShape) &&
      (itemNumberLinksToPrevious ||
        (!current.itemNumber && descriptionLooksAttached))
  );
}

function foldAttachedCostcoDiscountLines(lines: ExtractedReceiptLine[]) {
  const folded: ExtractedReceiptLine[] = [];
  let foldedCount = 0;
  for (const line of lines) {
    const previous = folded.at(-1);
    if (isAttachedCostcoDiscountLine(previous, line) && previous) {
      previous.discountCents += line.discountCents;
      previous.netAmountCents = previous.lineSubtotalCents - previous.discountCents;
      previous.confidenceBps = Math.min(previous.confidenceBps, line.confidenceBps);
      previous.needsReview ||= line.needsReview;
      foldedCount += 1;
      continue;
    }
    folded.push(line);
  }
  return { lines: folded, foldedCount };
}

export function parseExtractedReceiptDraft(value: unknown): ExtractedReceiptDraft {
  if (!isRecord(value)) throw new Error("Receipt provider did not return a receipt object");
  const purchasedAt = value.purchasedAt;
  if (purchasedAt !== null && (typeof purchasedAt !== "string" || purchasedAt.length > 64)) {
    throw new Error("purchasedAt must be a date string or null");
  }
  if (!Array.isArray(value.lines) || value.lines.length > 100) {
    throw new Error("lines must contain at most 100 receipt lines");
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string" || warning.length > 240)) {
    throw new Error("warnings must be a short string array");
  }
  const parsedLines = value.lines.map((line, index) => {
    if (!isRecord(line)) throw new Error(`lines[${index}] must be an object`);
    const itemNumber = line.itemNumber;
    if (itemNumber !== null && (typeof itemNumber !== "string" || itemNumber.length > 64)) {
      throw new Error(`lines[${index}].itemNumber is invalid`);
    }
    if (line.taxStatus !== "taxable" && line.taxStatus !== "non_taxable" && line.taxStatus !== "unknown") {
      throw new Error(`lines[${index}].taxStatus is invalid`);
    }
    if (typeof line.needsReview !== "boolean") {
      throw new Error(`lines[${index}].needsReview must be boolean`);
    }
    return {
      itemNumber,
      rawDescription: boundedString(line.rawDescription, `lines[${index}].rawDescription`, 180),
      quantityMilli: boundedInteger(line.quantityMilli, `lines[${index}].quantityMilli`, 1, 100000000),
      lineSubtotalCents: boundedInteger(line.lineSubtotalCents, `lines[${index}].lineSubtotalCents`, -100000000, 100000000),
      discountCents: boundedInteger(line.discountCents, `lines[${index}].discountCents`, 0, 100000000),
      netAmountCents: boundedInteger(line.netAmountCents, `lines[${index}].netAmountCents`, -100000000, 100000000),
      taxStatus: line.taxStatus as ExtractedReceiptLine["taxStatus"],
      confidenceBps: boundedInteger(line.confidenceBps, `lines[${index}].confidenceBps`, 0, 10000),
      needsReview: line.needsReview,
    };
  });
  const folded = foldAttachedCostcoDiscountLines(parsedLines);
  return {
    purchasedAt,
    subtotalCents: integerOrNull(value.subtotalCents, "subtotalCents"),
    taxCents: integerOrNull(value.taxCents, "taxCents"),
    totalCents: integerOrNull(value.totalCents, "totalCents"),
    discountCents: boundedInteger(value.discountCents, "discountCents", 0, 100000000),
    warnings: [
      ...value.warnings.map((warning) => warning.trim()),
      ...(folded.foldedCount
        ? [`Applied ${folded.foldedCount} Costco instant discount line${folded.foldedCount === 1 ? "" : "s"} to the matching preceding product.`]
        : []),
    ],
    lines: folded.lines,
  };
}

function arrayBufferToBase64(bytes: ArrayBuffer) {
  const values = new Uint8Array(bytes);
  let result = "";
  const chunkSize = 0x8000;
  for (let start = 0; start < values.length; start += chunkSize) {
    result += String.fromCharCode(...values.subarray(start, start + chunkSize));
  }
  return btoa(result);
}

function geminiOutputText(response: GeminiGenerateContentResponse) {
  const text = response.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!text) {
    const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
    throw new ReceiptExtractionError(
      "empty_output",
      "Receipt provider returned no structured draft",
      {
        responseId: response.responseId ?? null,
        finishReason: reason ?? null,
      },
    );
  }
  return text;
}

export function buildGeminiGenerateContentRequest({
  contentType,
  bytes,
  sources,
  recovery = false,
}: {
  contentType: string;
  bytes: ArrayBuffer;
  sources?: Array<{ contentType: string; bytes: ArrayBuffer }>;
  recovery?: boolean;
}) {
  const receiptSources = sources?.length ? sources : [{ contentType, bytes }];
  return {
    contents: [
      {
        role: "user",
        parts: [
          ...receiptSources.map((source) => ({
            inlineData: {
              mimeType: source.contentType,
              data: arrayBufferToBase64(source.bytes),
            },
          })),
          {
            text: `${instructions}${recovery ? "\nThe first read was incomplete. The attachments may include an enhanced full image and overlapping top-to-bottom sections of the same receipt. Merge duplicated lines from overlaps and use the full receipt for totals." : ""}\n\nReturn one compact JSON object with exactly this contract and no prose or markdown:\n${JSON.stringify(receiptDraftSchema)}\n\nExtract this Costco receipt into that contract. Return empty lines and warnings when the file is not a readable Costco receipt.`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: MAX_RECEIPT_OUTPUT_TOKENS,
    },
  };
}

export async function extractReceiptWithGemini({
  apiKey,
  model,
  contentType,
  bytes,
  sources,
  recovery = false,
}: {
  apiKey: string;
  model: string;
  contentType: string;
  bytes: ArrayBuffer;
  sources?: Array<{ contentType: string; bytes: ArrayBuffer }>;
  recovery?: boolean;
}): Promise<{
  draft: ExtractedReceiptDraft;
  responseId: string | null;
  finishReason: string | null;
  durationMs: number;
}> {
  const receiptSources = sources?.length ? sources : [{ contentType, bytes }];
  if (receiptSources.some((source) => source.bytes.byteLength > MAX_RECEIPT_SOURCE_BYTES)) {
    throw new ReceiptExtractionError(
      "schema_validation",
      "Receipt exceeds the BasketSense extraction limit",
    );
  }
  const startedAt = Date.now();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGeminiGenerateContentRequest({
      contentType,
      bytes,
      sources: receiptSources,
      recovery,
    })),
    signal: AbortSignal.timeout(90_000),
    }
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { status?: unknown; code?: unknown; message?: unknown };
    } | null;
    const providerCode = [body?.error?.status, body?.error?.code]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(":");
    const providerMessage =
      typeof body?.error?.message === "string"
        ? body.error.message.replace(/[\r\n]+/g, " ").slice(0, 240)
        : "";
    throw new ReceiptExtractionError(
      "provider_http",
      `Receipt provider failed with HTTP ${response.status}` +
        (providerCode ? ` (${providerCode.slice(0, 120)})` : "") +
        (providerMessage ? `: ${providerMessage}` : ""),
      {
        finishReason: [`HTTP_${response.status}`, providerCode]
          .filter(Boolean)
          .join(":")
          .slice(0, 120),
        durationMs: Date.now() - startedAt,
      },
    );
  }
  const body = (await response.json()) as GeminiGenerateContentResponse;
  let parsed: unknown;
  try {
    parsed = JSON.parse(geminiOutputText(body));
  } catch (error) {
    if (error instanceof ReceiptExtractionError) throw error;
    const finishReason = body.candidates?.[0]?.finishReason ?? null;
    throw new ReceiptExtractionError(
      finishReason === "MAX_TOKENS" ? "output_truncated" : "invalid_json",
      finishReason === "MAX_TOKENS"
        ? "Receipt provider ran out of output room before completing the draft"
        : "Receipt provider returned invalid structured data",
      {
        responseId: body.responseId ?? null,
        finishReason,
        durationMs: Date.now() - startedAt,
      },
    );
  }
  let draft: ExtractedReceiptDraft;
  try {
    draft = parseExtractedReceiptDraft(parsed);
  } catch {
    throw new ReceiptExtractionError(
      "schema_validation",
      "Receipt provider draft did not match the safe receipt contract",
      {
        responseId: body.responseId ?? null,
        finishReason: body.candidates?.[0]?.finishReason ?? null,
        durationMs: Date.now() - startedAt,
      },
    );
  }
  if (
    draft.lines.length === 0 &&
    draft.subtotalCents === null &&
    draft.taxCents === null &&
    draft.totalCents === null
  ) {
    throw new ReceiptExtractionError(
      "unreadable_image",
      "No receipt totals or product lines were readable",
      {
        responseId: body.responseId ?? null,
        finishReason: body.candidates?.[0]?.finishReason ?? null,
        durationMs: Date.now() - startedAt,
      },
    );
  }
  return {
    draft,
    responseId: typeof body.responseId === "string" ? body.responseId : null,
    finishReason: body.candidates?.[0]?.finishReason ?? null,
    durationMs: Date.now() - startedAt,
  };
}
