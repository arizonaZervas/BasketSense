import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseArtifact,
  receiptIngestionRetryDisposition,
  receiptIngestionUploadTarget,
} from "../app/api/receipt-ingestion/route.ts";
import {
  isReceiptImageContentType,
  isReceiptUploadContentType,
  receiptUploadContentType,
  RECEIPT_UPLOAD_CONTENT_TYPES,
} from "../app/receipt-upload-formats.ts";
import { prepareReceiptUpload } from "../app/receipt-review-flow.tsx";

test("receipt ingestion accepts one authorized context: a trip or a standalone receipt", () => {
  const tripUpload = new FormData();
  tripUpload.set("tripId", "trip-123");
  assert.deepEqual(receiptIngestionUploadTarget(tripUpload), {
    tripId: "trip-123",
    receiptId: null,
  });

  const standaloneUpload = new FormData();
  standaloneUpload.set("receiptId", "receipt-123");
  assert.deepEqual(receiptIngestionUploadTarget(standaloneUpload), {
    tripId: null,
    receiptId: "receipt-123",
  });
});

test("receipt ingestion rejects ambiguous or targetless uploads", () => {
  assert.throws(
    () => receiptIngestionUploadTarget(new FormData()),
    /either tripId or receiptId/i,
  );
  const ambiguous = new FormData();
  ambiguous.set("tripId", "trip-123");
  ambiguous.set("receiptId", "receipt-123");
  assert.throws(
    () => receiptIngestionUploadTarget(ambiguous),
    /either tripId or receiptId/i,
  );
});

test("receipt retry reuses terminal failures and never starts a competing extraction", () => {
  assert.equal(receiptIngestionRetryDisposition("failed"), "retry");
  assert.equal(receiptIngestionRetryDisposition("uploaded"), "retry");
  assert.equal(receiptIngestionRetryDisposition("extracting"), "busy");
  assert.equal(receiptIngestionRetryDisposition("awaiting_review"), "ready");
  assert.equal(receiptIngestionRetryDisposition("completed"), "unavailable");
});

test("receipt ingestion exposes product understanding without replacing the printed label", () => {
  const parsed = parseArtifact({
    draft: {
      lines: [{
        itemNumber: "1234567",
        rawDescription: "ZIPLC SLIDER",
        netAmountCents: 1499,
        understanding: {
          canonicalName: "Ziploc Slider Storage Bags",
          productFamily: "Storage bags",
          confidenceBps: 9300,
          source: "gemini",
          model: "test-model",
        },
      }],
    },
  });

  assert.equal(parsed.items[0].rawDescription, "ZIPLC SLIDER");
  assert.equal(parsed.items[0].interpretedName, "Ziploc Slider Storage Bags");
  assert.equal(parsed.items[0].interpretedProductFamily, "Storage bags");
  assert.equal(parsed.items[0].interpretationConfidenceBps, 9300);
});

test("standalone return receipts can be uploaded, retried, and linked", async () => {
  const source = await readFile(
    new URL("../app/api/receipt-ingestion/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /transaction_type IN \('warehouse', 'return'\)/);
  assert.match(source, /body\.action !== "retry_extraction"/);
  assert.match(source, /nativeExtractReceipt\(\{/);
  assert.match(source, /\["warehouse", "return"\]\.includes\(receipt\.transaction_type\)/);
  assert.match(source, /latestAuthorizedIngestionForReceipt/);
  assert.match(source, /receipt_ingestions\.receipt_transaction_id = \?/);
  assert.match(source, /Choose either id or receiptId/);
});

test("receipt upload contract accepts PDFs and the supported image formats", () => {
  assert.deepEqual(RECEIPT_UPLOAD_CONTENT_TYPES, [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "image/webp",
  ]);
  for (const contentType of RECEIPT_UPLOAD_CONTENT_TYPES) {
    assert.equal(isReceiptUploadContentType(contentType), true, contentType);
  }
  assert.equal(isReceiptImageContentType("application/pdf"), false);
  assert.equal(isReceiptImageContentType("image/jpeg"), true);
  assert.equal(isReceiptUploadContentType("text/plain"), false);
  assert.equal(isReceiptUploadContentType("image/svg+xml"), false);
});

test("receipt upload infers camera formats when mobile browsers omit or vary MIME types", () => {
  assert.equal(receiptUploadContentType({ name: "IMG_4800.JPG", type: "" }), "image/jpeg");
  assert.equal(receiptUploadContentType({ name: "camera.jpg", type: "image/jpg" }), "image/jpeg");
  assert.equal(receiptUploadContentType({ name: "camera.HEIC", type: "application/octet-stream" }), "image/heic");
  assert.equal(receiptUploadContentType({ name: "order.PDF", type: "" }), "application/pdf");
  assert.equal(receiptUploadContentType({ name: "notes.txt", type: "" }), null);
});

test("receipt preparation passes PDFs and safe images through without decoding", async () => {
  const pdf = new File(["%PDF synthetic"], "costco-order.pdf", {
    type: "application/pdf",
  });
  assert.equal(await prepareReceiptUpload(pdf), pdf);

  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let decodeCalls = 0;
  globalThis.createImageBitmap = async () => {
    decodeCalls += 1;
    throw new Error("safe images should not be decoded");
  };
  try {
    const photo = new File([new Uint8Array(1_024)], "costco-receipt.jpg", {
      type: "image/jpeg",
    });
    assert.equal(await prepareReceiptUpload(photo), photo);
    assert.equal(decodeCalls, 0);
  } finally {
    if (originalCreateImageBitmap) {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    } else {
      delete globalThis.createImageBitmap;
    }
  }
});
