import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiProductImageRequest,
  buildProductImagePrompt,
  generateProductImageWithGemini,
  parseGeminiProductImageResponse,
} from "../workers/receipt-ingestion/src/product-image-generation.ts";

const product = {
  canonicalName: "All-season tires",
  rawDescription: "MICHELIN TIRE",
  category: "automotive_tires",
  itemNumber: "99999990",
};

test("product image prompt is generic, identifiable, and packaging-safe", () => {
  const prompt = buildProductImagePrompt(product);
  assert.match(prompt, /All-season tires/);
  assert.match(prompt, /MICHELIN TIRE/);
  assert.match(prompt, /Do not include any text, price, barcode, Costco logo/i);
  assert.match(prompt, /Do not invent exact branded packaging/i);
});

test("Gemini product image request asks for a square 1K JPEG", () => {
  assert.deepEqual(buildGeminiProductImageRequest("gemini-image-test", product), {
    model: "gemini-image-test",
    input: [{ type: "text", text: buildProductImagePrompt(product) }],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: "1:1",
      image_size: "1K",
    },
  });
});

test("Gemini product image response decodes the private image bytes", () => {
  const parsed = parseGeminiProductImageResponse({
    id: "interaction-1",
    output_image: {
      data: btoa("image-bytes"),
      mime_type: "image/jpeg",
    },
  });
  assert.equal(new TextDecoder().decode(parsed.bytes), "image-bytes");
  assert.equal(parsed.contentType, "image/jpeg");
  assert.equal(parsed.responseId, "interaction-1");
  assert.throws(
    () => parseGeminiProductImageResponse({ output_image: null }),
    /did not return an image/i,
  );
});

test("Gemini product image call keeps the API key in a header", async () => {
  const result = await generateProductImageWithGemini({
    apiKey: "private-test-key",
    model: "gemini-image-test",
    product,
    fetcher: async (url, init) => {
      assert.equal(
        url,
        "https://generativelanguage.googleapis.com/v1beta/interactions",
      );
      assert.equal(new Headers(init.headers).get("x-goog-api-key"), "private-test-key");
      assert.doesNotMatch(String(url), /private-test-key/);
      assert.deepEqual(
        JSON.parse(init.body),
        buildGeminiProductImageRequest("gemini-image-test", product),
      );
      return Response.json({
        output_image: { data: btoa("generated"), mime_type: "image/jpeg" },
      });
    },
  });
  assert.equal(new TextDecoder().decode(result.bytes), "generated");
});
