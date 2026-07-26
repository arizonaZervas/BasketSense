import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareRestOcrProvider,
  extractReceiptDraft,
  ReceiptOcrError,
} from "../app/receipt-ocr.ts";
import { handleReceiptOcr } from "../app/api/receipt-ocr/route.ts";

function receiptPhoto() {
  return new File(["not-an-actual-image"], "costco.jpg", {
    type: "image/jpeg",
  });
}

function receiptPdf() {
  return new File(["Costco receipt PDF"], "costco-receipt.pdf", {
    type: "application/pdf",
  });
}

test("server OCR requests plain text and returns a deterministic Costco draft", async () => {
  const calls = [];
  const provider = {
    async toMarkdown(file, options) {
      calls.push({ file, options });
      return {
        format: "text",
        data: `
          1234567 KS ORG 2% MK 13.99
          MINI CUKES 6.49
          SUBTOTAL 20.48
          TAX 0.00
          TOTAL 20.48
        `,
      };
    },
  };

  const draft = await extractReceiptDraft(provider, receiptPhoto());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file.blob.type, "image/jpeg");
  assert.deepEqual(calls[0].options, {
    conversionOptions: { output: { format: "text" } },
  });
  assert.equal(draft.source, "cloudflare_workers_ai_markdown");
  assert.equal(draft.extractedItemCount, 2);
  assert.equal(draft.parsed.items[0].rawDescription, "KS ORG 2% MK");
  assert.equal(draft.parsed.totalCents, 2048);
});

test("server OCR does not invent receipt lines when the provider has no text", async () => {
  await assert.rejects(
    () =>
      extractReceiptDraft(
        { async toMarkdown() { return { format: "error", error: "blur" }; } },
        receiptPhoto(),
      ),
    (error) =>
      error instanceof ReceiptOcrError &&
      error.status === 422 &&
      /could not read receipt text/i.test(error.message),
  );
});

test("server OCR rejects unsupported uploads before sending them to the provider", async () => {
  let called = false;
  await assert.rejects(
    () =>
      extractReceiptDraft(
        { async toMarkdown() { called = true; return { format: "text", data: "TOTAL 1.00" }; } },
        new File(["text"], "receipt.txt", { type: "text/plain" }),
      ),
    (error) => error instanceof ReceiptOcrError && error.status === 415,
  );
  assert.equal(called, false);
});

test("server OCR accepts Costco PDFs and applies the same deterministic parser", async () => {
  const draft = await extractReceiptDraft(
    {
      async toMarkdown() {
        return { format: "text", data: "BASMATI RICE 24.99\nSUBTOTAL 24.99\nTOTAL 24.99" };
      },
    },
    receiptPdf(),
  );

  assert.equal(draft.parsed.items[0].rawDescription, "BASMATI RICE");
  assert.equal(draft.parsed.totalCents, 2499);
});

test("Cloudflare REST receipt provider sends the file and conversion options server-side", async () => {
  const calls = [];
  const provider = createCloudflareRestOcrProvider({
    accountId: "a".repeat(32),
    apiToken: "server-only-token",
    async fetchImpl(input, init) {
      calls.push({ input: String(input), init });
      return new Response(
        JSON.stringify({
          success: true,
          result: { format: "text", data: "TOTAL 20.48" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await provider.toMarkdown(
    { name: "costco-receipt.pdf", blob: new Blob(["pdf"], { type: "application/pdf" }) },
    { conversionOptions: { output: { format: "text" } } },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].input, /\/ai\/tomarkdown$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer server-only-token");
  const form = calls[0].init.body;
  assert.equal(form.get("files").name, "costco-receipt.pdf");
  assert.equal(form.get("conversionOptions"), '{"output":{"format":"text"}}');
  assert.deepEqual(result, { format: "text", data: "TOTAL 20.48" });
});

test("authenticated OCR route returns only the structured server draft", async () => {
  const form = new FormData();
  form.append("file", receiptPhoto());
  const request = new Request("https://basket-sense.test/api/receipt-ocr", {
    method: "POST",
    headers: { "oai-authenticated-user-email": "owner@example.test" },
    body: form,
  });
  const response = await handleReceiptOcr(request, {
    async toMarkdown() {
      return { format: "text", data: "MINI CUKES 6.49\nSUBTOTAL 6.49\nTOTAL 6.49" };
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.draft.extractedItemCount, 1);
  assert.equal(body.draft.parsed.items[0].rawDescription, "MINI CUKES");
  assert.equal("data" in body.draft, false);
});
