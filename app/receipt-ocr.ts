import {
  parseCostcoOcrText,
  type ParsedCostcoReceiptDraft,
} from "./receipt-logic";

export const MAX_RECEIPT_IMAGE_BYTES = 12 * 1024 * 1024;

export const RECEIPT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ReceiptImageInput {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MarkdownConversionResult {
  format: "markdown" | "text" | "error";
  data?: string;
  error?: string;
}

export interface ReceiptOcrProvider {
  toMarkdown(
    file: { name: string; blob: Blob },
    options: { conversionOptions: { output: { format: "text" } } },
  ): Promise<MarkdownConversionResult | MarkdownConversionResult[]>;
}

export class ReceiptOcrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerReceiptDraft {
  source: "cloudflare_workers_ai_markdown";
  parsed: ParsedCostcoReceiptDraft;
  extractedItemCount: number;
}

export function validateReceiptImage(file: ReceiptImageInput) {
  const contentType = file.type.toLowerCase();
  if (!RECEIPT_IMAGE_TYPES.has(contentType)) {
    throw new ReceiptOcrError(
      415,
      "For automatic reading, use a JPEG, PNG, or WebP receipt photo. You can still enter totals from another photo format.",
    );
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_RECEIPT_IMAGE_BYTES) {
    throw new ReceiptOcrError(413, "Receipt photo must be 12 MB or smaller");
  }
}

function firstConversionResult(
  result: MarkdownConversionResult | MarkdownConversionResult[],
) {
  return Array.isArray(result) ? result[0] : result;
}

/**
 * Runs the provider's OCR/markdown conversion and then applies our deterministic
 * Costco parser. This deliberately returns structured evidence, not a product
 * catalog mutation: unfamiliar lines still require household confirmation.
 */
export async function extractReceiptDraft(
  provider: ReceiptOcrProvider,
  file: ReceiptImageInput,
): Promise<ServerReceiptDraft> {
  validateReceiptImage(file);

  let converted: MarkdownConversionResult | MarkdownConversionResult[];
  try {
    converted = await provider.toMarkdown(
      {
        name: file.name || "costco-receipt",
        blob: new Blob([await file.arrayBuffer()], { type: file.type }),
      },
      { conversionOptions: { output: { format: "text" } } },
    );
  } catch {
    throw new ReceiptOcrError(
      502,
      "The receipt reader is temporarily unavailable. Try again in a moment.",
    );
  }

  const result = firstConversionResult(converted);
  const text = result?.format === "text" ? result.data?.trim() : "";
  if (!text) {
    throw new ReceiptOcrError(
      422,
      "We could not read receipt text from that photo. Try a brighter, flatter photo or enter the totals manually.",
    );
  }

  const parsed = parseCostcoOcrText(text.slice(0, 50_000));
  return {
    source: "cloudflare_workers_ai_markdown",
    parsed,
    extractedItemCount: parsed.items.length,
  };
}
