import assert from "node:assert/strict";
import test from "node:test";

import { buildDashboardViewData } from "../app/basketsense-dashboard-data.ts";
import { mergeHouseholdProductMetadata } from "../app/dashboard-product-metadata.ts";

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
