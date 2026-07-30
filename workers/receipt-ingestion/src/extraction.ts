export const RECEIPT_EXTRACTION_SCHEMA_VERSION = "costco-receipt-v1";
export const MAX_RECEIPT_SOURCE_BYTES = 8 * 1024 * 1024;

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
Return only information visibly supported by the supplied receipt. Use integer cents, never dollar strings or floating point. Preserve the abbreviated printed label exactly in rawDescription; do not invent a catalog name. Use null for unreadable totals or dates. A line with ambiguous text, amount, quantity, tax treatment, discount, or item number must have needsReview true and a conservative confidenceBps. Coupons and instant discounts should have discountCents > 0; do not silently turn discounts into items. This is an advisory draft only: do not decide household value, planned status, categories, or accounting outcomes.`;

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
  return Boolean(
    previous &&
      previous.itemNumber &&
      current.itemNumber === previous.itemNumber &&
      current.lineSubtotalCents < 0 &&
      current.netAmountCents < 0 &&
      current.discountCents > 0 &&
      /^\d+\s*\/\s*\d+$/.test(current.rawDescription)
  );
}

function foldAttachedCostcoDiscountLines(lines: ExtractedReceiptLine[]) {
  const folded: ExtractedReceiptLine[] = [];
  let foldedCount = 0;
  for (const line of lines) {
    const previous = folded.at(-1);
    if (isAttachedCostcoDiscountLine(previous, line) && previous) {
      previous.discountCents += line.discountCents;
      previous.netAmountCents += line.netAmountCents;
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
    throw new Error(`Gemini returned no structured receipt draft${reason ? ` (${reason})` : ""}`);
  }
  return text;
}

export function buildGeminiGenerateContentRequest({
  contentType,
  bytes,
}: {
  contentType: string;
  bytes: ArrayBuffer;
}) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: contentType,
              data: arrayBufferToBase64(bytes),
            },
          },
          {
            text: `${instructions}\n\nReturn one JSON object with exactly this contract:\n${JSON.stringify(receiptDraftSchema)}\n\nExtract this Costco receipt into that contract. Return empty lines and warnings when the file is not a readable Costco receipt.`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 3000,
    },
  };
}

export async function extractReceiptWithGemini({
  apiKey,
  model,
  contentType,
  bytes,
}: {
  apiKey: string;
  model: string;
  contentType: string;
  bytes: ArrayBuffer;
}): Promise<{ draft: ExtractedReceiptDraft; responseId: string | null }> {
  if (bytes.byteLength > MAX_RECEIPT_SOURCE_BYTES) {
    throw new Error("Receipt exceeds the 8 MB BasketSense extraction limit");
  }
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildGeminiGenerateContentRequest({ contentType, bytes })),
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
    throw new Error(
      `Gemini extraction failed with HTTP ${response.status}` +
        (providerCode ? ` (${providerCode.slice(0, 120)})` : "") +
        (providerMessage ? `: ${providerMessage}` : "")
    );
  }
  const body = (await response.json()) as GeminiGenerateContentResponse;
  return {
    draft: parseExtractedReceiptDraft(JSON.parse(geminiOutputText(body))),
    responseId: typeof body.responseId === "string" ? body.responseId : null,
  };
}
