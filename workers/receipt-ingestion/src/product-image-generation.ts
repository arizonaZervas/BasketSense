type ProductImagePromptInput = {
  canonicalName: string;
  rawDescription: string | null;
  category: string | null;
  itemNumber: string | null;
};

type GeminiInteractionResponse = {
  id?: unknown;
  output_image?: {
    data?: unknown;
    mime_type?: unknown;
  } | null;
};

const ALLOWED_OUTPUT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function promptValue(value: string | null, fallback: string) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, 180);
}

export function buildProductImagePrompt(input: ProductImagePromptInput) {
  const productName = promptValue(input.canonicalName, "Costco product");
  const receiptName = promptValue(input.rawDescription, productName);
  const category = promptValue(input.category, "general merchandise");
  const itemNumber = promptValue(input.itemNumber, "not available");
  return [
    "Create a clean, realistic reference image for a private household product catalog.",
    `Product name: ${productName}.`,
    `Receipt description: ${receiptName}.`,
    `Category: ${category}. Costco item number: ${itemNumber}.`,
    "Show one recognizable product or product type centered on a warm, neutral background with soft studio lighting.",
    "Do not include any text, price, barcode, Costco logo, other trademarks, people, hands, or a store setting.",
    "Do not invent exact branded packaging. This is a generic visual reference and should remain useful even when packaging changes.",
  ].join(" ");
}

export function buildGeminiProductImageRequest(
  model: string,
  product: ProductImagePromptInput,
) {
  return {
    model,
    input: [{ type: "text", text: buildProductImagePrompt(product) }],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "1:1",
      image_size: "1K",
    },
  };
}

export function parseGeminiProductImageResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Image provider returned an invalid response");
  }
  const response = value as GeminiInteractionResponse;
  const data = response.output_image?.data;
  const contentType = response.output_image?.mime_type ?? "image/jpeg";
  if (typeof data !== "string" || !data) {
    throw new Error("Image provider did not return an image");
  }
  if (typeof contentType !== "string" || !ALLOWED_OUTPUT_TYPES.has(contentType)) {
    throw new Error("Image provider returned an unsupported image type");
  }
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error("Image provider returned invalid image data");
  }
  if (!binary.length) throw new Error("Image provider returned an empty image");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return {
    bytes,
    contentType,
    responseId: typeof response.id === "string" ? response.id : null,
  };
}

export async function generateProductImageWithGemini({
  apiKey,
  model,
  product,
  fetcher = fetch,
}: {
  apiKey: string;
  model: string;
  product: ProductImagePromptInput;
  fetcher?: typeof fetch;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetcher(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(buildGeminiProductImageRequest(model, product)),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Image provider request failed with HTTP ${response.status}`);
    }
    return parseGeminiProductImageResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
