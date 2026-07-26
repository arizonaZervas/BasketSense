import {
  parseCostcoOcrText,
  type ParsedCostcoReceiptDraft,
} from "./receipt-logic";

export const MAX_RECEIPT_DOCUMENT_BYTES = 12 * 1024 * 1024;
// Kept as an alias so existing callers do not need to know whether the
// selected receipt came from a camera or Costco's PDF download.
export const MAX_RECEIPT_IMAGE_BYTES = MAX_RECEIPT_DOCUMENT_BYTES;

export const RECEIPT_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const RECEIPT_IMAGE_TYPES = RECEIPT_DOCUMENT_TYPES;

export interface ReceiptDocumentInput {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ReceiptImageInput = ReceiptDocumentInput;

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

type ReceiptOcrFetch = typeof fetch;

interface CloudflareRestOcrOptions {
  accountId: string;
  apiToken: string;
  fetchImpl?: ReceiptOcrFetch;
}

/**
 * Sites does not currently expose an AI binding configuration surface for this
 * Worker. This adapter is a narrow fallback for Workers AI Markdown
 * Conversion: the API token remains in the server runtime and raw OCR text
 * never crosses the browser boundary.
 */
export function createCloudflareRestOcrProvider({
  accountId,
  apiToken,
  fetchImpl = fetch,
}: CloudflareRestOcrOptions): ReceiptOcrProvider {
  const normalizedAccountId = accountId.trim();
  const normalizedToken = apiToken.trim();
  if (!/^[a-f0-9]{32}$/i.test(normalizedAccountId) || !normalizedToken) {
    throw new ReceiptOcrError(
      503,
      "Server receipt reading is not configured yet. You can still enter the receipt totals manually.",
    );
  }

  return {
    async toMarkdown(file, options) {
      const form = new FormData();
      form.append("files", file.blob, file.name || "costco-receipt");
      form.append("conversionOptions", JSON.stringify(options.conversionOptions));

      const response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${normalizedAccountId}/ai/tomarkdown`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${normalizedToken}` },
          body: form,
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; result?: MarkdownConversionResult | MarkdownConversionResult[] }
        | null;
      if (!response.ok || payload?.success === false || !payload?.result) {
        throw new Error("Cloudflare Workers AI conversion failed");
      }
      return payload.result;
    },
  };
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

export function validateReceiptDocument(file: ReceiptDocumentInput) {
  const contentType = file.type.toLowerCase();
  if (!RECEIPT_DOCUMENT_TYPES.has(contentType)) {
    throw new ReceiptOcrError(
      415,
      "For automatic reading, use a Costco PDF or a JPEG, PNG, or WebP receipt photo.",
    );
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_RECEIPT_DOCUMENT_BYTES) {
    throw new ReceiptOcrError(413, "Receipt file must be 12 MB or smaller");
  }
}

export const validateReceiptImage = validateReceiptDocument;

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
  file: ReceiptDocumentInput,
): Promise<ServerReceiptDraft> {
  validateReceiptDocument(file);

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
      "We could not read receipt text from that file. Try a clearer photo, Costco PDF, or enter the totals manually.",
    );
  }

  const parsed = parseCostcoOcrText(text.slice(0, 50_000));
  return {
    source: "cloudflare_workers_ai_markdown",
    parsed,
    extractedItemCount: parsed.items.length,
  };
}
