import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboardViewData,
  buildDashboardViewDataFromHistory,
} from "../app/basketsense-dashboard-data.ts";
import { mergeHouseholdProductMetadata } from "../app/dashboard-product-metadata.ts";
import { productIllustrationManifest } from "../app/product-illustration-manifest.ts";

test("product history keeps friendly names and gross, discount, and paid amounts", () => {
  const viewData = buildDashboardViewData();
  const huggies = viewData.products.find(
    (product) => product.itemNumber === "1935002",
  );
  assert.ok(huggies);
  assert.equal(huggies.name, "Huggies Pull-Ups diapers, 4T–5T");
  assert.equal(huggies.rawDescription, "HUG PU 4T-5T");

  const discountedPurchase = huggies.priceHistory.find(
    (purchase) => purchase.purchasedOn === "2026-06-27",
  );
  assert.ok(discountedPurchase);
  assert.equal(discountedPurchase.grossAmountCents, 3999);
  assert.equal(discountedPurchase.discountCents, 800);
  assert.equal(discountedPurchase.netAmountCents, 3199);

  assert.equal(
    viewData.products.find((product) => product.itemNumber === "27003")?.name,
    "Strawberries",
  );
  assert.equal(
    viewData.products.find((product) => product.itemNumber === "512515")?.name,
    "Organic strawberries",
  );
  assert.equal(viewData.needsReviewWarehouseCents, 3997);
});

test("product price uses an exact receipt subtotal when OCR omits the unit price", () => {
  const source = buildDashboardViewData();
  const receiptLines = source.receiptLines.map((line) =>
    line.itemNumber === "1977696"
      ? { ...line, unitPriceCents: null }
      : line,
  );

  const viewData = buildDashboardViewDataFromHistory({
    through: source.audit.through,
    reconciliationIssueCount: source.audit.reconciliationIssueCount,
    transactions: source.transactions,
    receiptLines,
  });
  const tractorWheels = viewData.products.find(
    (product) => product.itemNumber === "1977696",
  );

  assert.ok(tractorWheels);
  assert.equal(tractorWheels.lastPriceCents, 1369);
  assert.equal(tractorWheels.priceHistory.at(-1)?.unitPriceCents, 1369);
  assert.equal(tractorWheels.totalSpendCents, 1369);
});

test("household metadata changes labels and categories without rewriting old receipt text", () => {
  const viewData = buildDashboardViewData();
  const cottageCheeseRawNames = viewData.receiptLines
    .filter((line) => line.itemNumber === "289660")
    .map((line) => line.rawDescription);
  assert.deepEqual(new Set(cottageCheeseRawNames), new Set(["COTTAGE CHSE", "CHSE"]));

  const householdBefore = viewData.productCategories.find(
    (category) => category.key === "household_supplies",
  ).householdViewCents;
  const merged = mergeHouseholdProductMetadata(viewData, [
    {
      costcoItemNumber: "289660",
      canonicalName: "Cottage cheese",
      category: "groceries_beverages",
      categoryStatus: "reviewed",
      latestRawDescription: "CHSE",
    },
    {
      costcoItemNumber: "1901772",
      canonicalName: "Household-confirmed two-pack combo",
      category: "household_supplies",
      categoryStatus: "reviewed",
      latestRawDescription: "2PKCOMBO",
    },
  ]);

  assert.deepEqual(
    new Set(
      merged.receiptLines
        .filter((line) => line.itemNumber === "289660")
        .map((line) => line.rawDescription),
    ),
    new Set(["COTTAGE CHSE", "CHSE"]),
    "Every trip keeps the original Costco abbreviation",
  );
  assert.equal(
    merged.products.find((product) => product.itemNumber === "289660")
      .rawDescription,
    "CHSE",
    "The product summary may use the latest receipt abbreviation",
  );
  assert.equal(merged.needsReviewWarehouseCents, 2498);
  assert.equal(
    merged.productCategories.find(
      (category) => category.key === "household_supplies",
    ).householdViewCents,
    householdBefore + 1499,
  );
  assert.equal(
    merged.classifiedWarehouseCents + merged.needsReviewWarehouseCents,
    viewData.classifiedWarehouseCents + viewData.needsReviewWarehouseCents,
  );
});

test("a missing catalog line stays visible as needs-review evidence", () => {
  const source = buildDashboardViewData();
  const omittedLine = source.receiptLines.find(
    (line) => line.transactionId === source.latestWarehouseTransaction.id,
  );
  assert.ok(omittedLine);

  const viewData = buildDashboardViewDataFromHistory({
    through: source.audit.through,
    reconciliationIssueCount: 1,
    transactions: source.transactions,
    receiptLines: source.receiptLines.filter((line) => line.id !== omittedLine.id),
  });

  assert.equal(
    viewData.classifiedWarehouseCents + viewData.needsReviewWarehouseCents,
    source.transactions
      .filter((transaction) => transaction.channel === "warehouse")
      .reduce((sum, transaction) => sum + transaction.merchandiseSubtotalCents, 0),
  );
  assert.ok(
    viewData.needsReviewWarehouseCents >= source.needsReviewWarehouseCents + omittedLine.netAmountCents,
  );
});

test("finalized returns reduce net spend and categories without becoming purchases", () => {
  const source = buildDashboardViewData();
  const productBefore = source.products.find((product) => product.itemNumber === "1868328");
  const sourceLine = source.receiptLines.find((line) => line.itemNumber === "1868328");
  assert.ok(productBefore);
  assert.ok(sourceLine);

  const returnTransaction = {
    id: "ad-hoc-return-dashboard-test",
    purchasedOn: "2026-08-15",
    channel: "warehouse",
    itemCount: 1,
    receiptTotalCents: -1500,
    householdFundedCents: -1500,
    discountCents: 0,
    merchandiseSubtotalCents: -1500,
    taxCents: 0,
    externalFundingCents: 0,
    sourceType: "receipt_photo",
    auditFlag: "ad_hoc_return_reconciled",
    purchaseContext: "ad_hoc",
    transactionKind: "return",
  };
  const returnLine = {
    ...sourceLine,
    id: "ad-hoc-return-line-dashboard-test",
    transactionId: returnTransaction.id,
    quantity: 1,
    unitPriceCents: -1500,
    grossAmountCents: -1500,
    discountCents: 0,
    netAmountCents: -1500,
  };

  const viewData = buildDashboardViewDataFromHistory({
    through: "2026-08-15",
    reconciliationIssueCount: source.audit.reconciliationIssueCount,
    transactions: [...source.transactions, returnTransaction],
    receiptLines: [...source.receiptLines, returnLine],
  });
  const productAfter = viewData.products.find((product) => product.itemNumber === "1868328");
  const categoryBefore = source.productCategories.find(
    (category) => category.key === sourceLine.categoryKey,
  );
  const categoryAfter = viewData.productCategories.find(
    (category) => category.key === sourceLine.categoryKey,
  );
  assert.ok(categoryBefore);
  assert.ok(categoryAfter);

  assert.equal(
    viewData.audit.householdFundedCents,
    source.audit.householdFundedCents - 1500,
  );
  assert.equal(productAfter.purchaseCount, productBefore.purchaseCount);
  assert.equal(productAfter.totalSpendCents, productBefore.totalSpendCents);
  assert.equal(
    categoryAfter.householdViewCents,
    categoryBefore.householdViewCents - 1500,
  );
  assert.equal(viewData.recentTransactions[0].transactionKind, "return");
});

test("the second illustration batch covers purchase ranks 151 through 175", () => {
  const acceptedItems = new Set(
    productIllustrationManifest()
      .filter((entry) => entry.acceptanceStatus === "accepted")
      .map((entry) => entry.itemNumber),
  );

  for (const itemNumber of [
    "2034800", "1851746", "1992399", "1943125", "1974258",
    "1962938", "2029201", "1919326", "1851481", "1901810",
    "1901772", "1868328", "1955439", "1899482", "1854748",
    "1863710", "1963239", "1985993", "1861502", "1959114",
    "1896154", "1796303", "1851163", "1957935", "1796314",
  ]) {
    assert.ok(acceptedItems.has(itemNumber), `missing illustration for ${itemNumber}`);
  }
});

test("the third illustration batch covers purchase ranks 176 through 200", () => {
  const acceptedItems = new Set(
    productIllustrationManifest()
      .filter((entry) => entry.acceptanceStatus === "accepted")
      .map((entry) => entry.itemNumber),
  );

  for (const itemNumber of [
    "1898148", "2056026", "2016761", "1851588", "1934959",
    "1859936", "1951107", "1989442", "1902104", "2031674",
    "2727590", "2062456", "1852806", "1920008", "2065441",
    "2022263", "1833829", "1955377", "2033331", "2004358",
    "1993845", "1957651", "1873251", "1955429", "1928295",
  ]) {
    assert.ok(acceptedItems.has(itemNumber), `missing illustration for ${itemNumber}`);
  }
});
