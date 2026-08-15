import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { categoryPresentation, classifyReceiptItem } from "../app/product-categories.ts";

test("standalone purchase and return flow uses receiptId ingestion and preserves primary states", async () => {
  const source = await readFile(new URL("../app/receipt-review-flow.tsx", import.meta.url), "utf8");

  assert.match(source, /standalone\s*\?\s*receiptId\s*\?\s*"update_ad_hoc_receipt"/);
  assert.match(source, /"create_ad_hoc_receipt"/);
  assert.match(source, /async function ensureStandaloneReceiptForUpload/);
  assert.match(source, /captureMode: "totals_only"/);
  assert.match(source, /await ensureStandaloneReceiptForUpload\(\)/);
  assert.match(source, /"finalize_ad_hoc_receipt"/);
  assert.match(
    source,
    /if \(standalone\) onStandaloneReceiptIdChange\?\.\(null\);/,
    "A finalized standalone receipt must not remain resumable as the next receipt",
  );
  assert.match(source, /"discard_ad_hoc_receipt"/);
  assert.match(source, /form\.append\("receiptId", targetReceiptId\)/);
  assert.match(source, /Costco purchase draft saved/);
  assert.match(source, /Costco purchase saved to household spending and product history/);
  assert.match(source, /Costco return saved\. Its refund now reduces household spending/);
  assert.match(source, /transactionType: draft\.transactionType/);
  assert.match(source, /setStandaloneTransactionType\("return"\)/);
  assert.match(source, /reduction in spending/);
  assert.match(source, /receipt-flow-error" role="alert"/);
  assert.match(source, /role="status" aria-live="polite"/);
  assert.match(source, /standalone && receiptFile && !receiptIngestionId/);
  assert.match(source, /action: "retry_extraction"/);
  assert.match(source, /Try reading the saved receipt again/);
  assert.match(source, /Retrying the saved receipt — attempt/);
  assert.match(source, /async function retryReceiptUpload/);
  assert.match(source, /form\.append\("clientRequestId", requestId\)/);
  assert.match(source, /Try saving and reading this receipt again/);
  assert.match(source, /setPollReceiptIngestion\(false\)/);
});

test("standalone purchase and return copy stays separate from Saturday-list comparison", async () => {
  const source = await readFile(new URL("../app/receipt-review-flow.tsx", import.meta.url), "utf8");

  assert.match(source, /Purchases add to Costco spending; returns subtract from it/);
  assert.match(source, /Costco\.com orders, tires, jewelry, other separate purchases, or returns/);
  assert.match(source, /No Saturday-list comparison was created/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /capture="environment"/);
});

test("Insights exposes an accessible ad hoc receipt action and badges return context", async () => {
  const source = await readFile(new URL("../app/basket-sense-dashboard.tsx", import.meta.url), "utf8");

  assert.match(source, /Add Costco receipt/);
  assert.match(source, /onAddCostcoPurchase/);
  assert.match(source, /purchaseContext === "ad_hoc"/);
  assert.match(source, /purchase-context-badge/);
  assert.match(source, /transactionKind === "return"/);
  assert.match(source, /AD_HOC_RECEIPT_STORAGE_KEY/);
  assert.match(source, /sandboxMode \? "sandbox" : "household"/);
  assert.match(source, /onStandaloneReceiptIdChange/);
  assert.match(
    source,
    /\$\{receiptFlowScope\}:\$\{receiptFlowInitialStep\}:\$\{selectedReviewReceiptId \?\? "current"\}/,
    "each receipt-flow opening must remount at the requested step instead of flashing a prior completion state",
  );
});

test("automotive and precious-metal purchases participate in existing category contracts", () => {
  assert.equal(categoryPresentation("automotive_tires").label, "Automotive & tires");
  assert.equal(categoryPresentation("jewelry_precious_metals").label, "Jewelry & precious metals");
  assert.equal(
    classifyReceiptItem({
      channel: "warehouse",
      itemNumber: "",
      rawDescription: "MICHELIN TIRE INSTALLATION",
      canonicalName: "Michelin tires",
      taxStatus: "taxable",
    }).key,
    "automotive_tires",
  );
  assert.equal(
    classifyReceiptItem({
      channel: "warehouse",
      itemNumber: "",
      rawDescription: "1 OZ GOLD BAR",
      canonicalName: "Gold bar",
      taxStatus: "taxable",
    }).key,
    "jewelry_precious_metals",
  );
});
