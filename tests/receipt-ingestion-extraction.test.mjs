import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiGenerateContentRequest,
  MAX_RECEIPT_OUTPUT_TOKENS,
  parseExtractedReceiptDraft,
} from "../workers/receipt-ingestion/src/extraction.ts";

function validDraft() {
  return {
    purchasedAt: "2026-07-25",
    subtotalCents: 21508,
    taxCents: 337,
    totalCents: 21845,
    discountCents: 900,
    warnings: ["One abbreviated item needs household confirmation."],
    lines: [
      {
        itemNumber: "225355",
        rawDescription: "KS ORG 2% MK",
        quantityMilli: 1000,
        lineSubtotalCents: 1499,
        discountCents: 0,
        netAmountCents: 1499,
        taxStatus: "non_taxable",
        confidenceBps: 9800,
        needsReview: false,
      },
    ],
  };
}

test("Gemini receipt drafts remain advisory, integer-cent evidence", () => {
  const parsed = parseExtractedReceiptDraft(validDraft());
  assert.equal(parsed.lines[0].rawDescription, "KS ORG 2% MK");
  assert.equal(parsed.lines[0].lineSubtotalCents, 1499);
  assert.equal(parsed.lines[0].needsReview, false);
  assert.equal(parsed.totalCents, 21845);
});

test("a totals-only draft remains usable when no product lines are readable", () => {
  const draft = validDraft();
  draft.lines = [];
  draft.warnings = ["Product lines were not readable; verify the printed totals."];
  const parsed = parseExtractedReceiptDraft(draft);
  assert.equal(parsed.lines.length, 0);
  assert.equal(parsed.totalCents, 21845);
});

test("attached Costco discount lines fold into the preceding matching product", () => {
  const draft = validDraft();
  draft.lines.push({
    itemNumber: "225355",
    rawDescription: "0000386577 / 225355",
    quantityMilli: 1000,
    lineSubtotalCents: -500,
    discountCents: 500,
    netAmountCents: -500,
    taxStatus: "non_taxable",
    confidenceBps: 9500,
    needsReview: false,
  });
  const parsed = parseExtractedReceiptDraft(draft);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].lineSubtotalCents, 1499);
  assert.equal(parsed.lines[0].discountCents, 500);
  assert.equal(parsed.lines[0].netAmountCents, 999);
  assert.match(parsed.warnings.at(-1), /Applied 1 Costco instant discount line/);
});

test("adjacent instant savings fold even when the reader omits the repeated item number", () => {
  const draft = validDraft();
  draft.lines.push({
    itemNumber: null,
    rawDescription: "INSTANT SAVINGS",
    quantityMilli: 1000,
    lineSubtotalCents: 0,
    discountCents: 300,
    netAmountCents: -300,
    taxStatus: "non_taxable",
    confidenceBps: 9300,
    needsReview: false,
  });
  const parsed = parseExtractedReceiptDraft(draft);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].lineSubtotalCents, 1499);
  assert.equal(parsed.lines[0].discountCents, 300);
  assert.equal(parsed.lines[0].netAmountCents, 1199);
});

test("zero-net Gemini savings rows fold into products instead of becoming catalog lines", () => {
  const draft = validDraft();
  draft.lines.push({
    itemNumber: "225355",
    rawDescription: "0000386577 / 225355",
    quantityMilli: 1000,
    lineSubtotalCents: 300,
    discountCents: 300,
    netAmountCents: 0,
    taxStatus: "non_taxable",
    confidenceBps: 9300,
    needsReview: false,
  });
  const parsed = parseExtractedReceiptDraft(draft);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].lineSubtotalCents, 1499);
  assert.equal(parsed.lines[0].discountCents, 300);
  assert.equal(parsed.lines[0].netAmountCents, 1199);
  assert.equal(parsed.discountCents, 900);
});

test("receipt-level rewards remain separate discount evidence", () => {
  const draft = validDraft();
  draft.lines.push({
    itemNumber: null,
    rawDescription: "EXECUTIVE REWARD",
    quantityMilli: 1000,
    lineSubtotalCents: 0,
    discountCents: 200,
    netAmountCents: -200,
    taxStatus: "non_taxable",
    confidenceBps: 9300,
    needsReview: false,
  });
  const parsed = parseExtractedReceiptDraft(draft);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[1].discountCents, 200);
  assert.equal(parsed.lines[1].netAmountCents, -200);
});

test("Gemini request uses inline document data and a strict JSON field contract", () => {
  const request = buildGeminiGenerateContentRequest({
    contentType: "application/pdf",
    bytes: new TextEncoder().encode("synthetic receipt").buffer,
  });
  const parts = request.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, "application/pdf");
  assert.equal(parts[0].inlineData.data, "c3ludGhldGljIHJlY2VpcHQ=");
  assert.match(parts[1].text, /Costco receipt/i);
  assert.match(parts[1].text, /Identify every visible coupon, instant saving, and discount/i);
  assert.match(parts[1].text, /"purchasedAt"/);
  assert.match(parts[1].text, /"rawDescription"/);
  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal("responseJsonSchema" in request.generationConfig, false);
  assert.equal(request.generationConfig.maxOutputTokens, MAX_RECEIPT_OUTPUT_TOKENS);
});

test("Gemini receives PDF and image receipt bytes with their original MIME type", () => {
  for (const contentType of [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]) {
    const request = buildGeminiGenerateContentRequest({
      contentType,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    assert.equal(request.contents[0].parts[0].inlineData.mimeType, contentType);
    assert.equal(request.contents[0].parts[0].inlineData.data, "AQID");
  }
});

test("receipt extraction rejects floats, unsupported tax labels, and invented empty names", () => {
  const floatAmount = validDraft();
  floatAmount.lines[0].netAmountCents = 14.99;
  assert.throws(() => parseExtractedReceiptDraft(floatAmount), /outside the permitted range/i);

  const badTax = validDraft();
  badTax.lines[0].taxStatus = "maybe";
  assert.throws(() => parseExtractedReceiptDraft(badTax), /taxStatus/i);

  const emptyName = validDraft();
  emptyName.lines[0].rawDescription = "";
  assert.throws(() => parseExtractedReceiptDraft(emptyName), /rawDescription/i);
});
