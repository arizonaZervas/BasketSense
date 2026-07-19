import type {
  DashboardProduct,
  DashboardProductCategory,
  DashboardReceiptLine,
  DashboardTransaction,
  DashboardViewData,
} from "./dashboard-types";
import {
  PRODUCT_CATEGORY_PRESENTATION,
  categoryPresentation,
  type ClassificationStatus,
  type ProductCategoryKey,
} from "./product-categories";

export type HouseholdCatalogProductMetadata = {
  costcoItemNumber: string | null;
  canonicalName: string;
  category: string | null;
  categoryStatus: ClassificationStatus;
  latestRawDescription: string | null;
};

export function isProductCategoryKey(
  value: string | null,
): value is ProductCategoryKey {
  return PRODUCT_CATEGORY_PRESENTATION.some((category) => category.key === value);
}

export function scopedCategories(
  viewData: DashboardViewData,
  transactions: readonly DashboardTransaction[],
) {
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));
  const lines = viewData.receiptLines.filter((line) =>
    transactionIds.has(line.transactionId),
  );

  return viewData.productCategories.map((category) => {
    const channel =
      category.key === "fuel"
        ? "gas"
        : category.key === "optical_services"
          ? "optical"
          : null;
    const categoryLines = lines.filter((line) => line.categoryKey === category.key);
    const householdViewCents = channel
      ? transactions
          .filter((transaction) => transaction.channel === channel)
          .reduce((sum, transaction) => sum + transaction.householdFundedCents, 0)
      : categoryLines.reduce((sum, line) => sum + line.netAmountCents, 0);

    return {
      ...category,
      householdViewCents,
      itemCount: categoryLines.reduce((sum, line) => sum + line.quantity, 0),
      transactionCount: channel
        ? transactions.filter((transaction) => transaction.channel === channel).length
        : new Set(categoryLines.map((line) => line.transactionId)).size,
    } satisfies DashboardProductCategory;
  });
}

export function mergeHouseholdProductMetadata(
  viewData: DashboardViewData,
  catalogProducts: readonly HouseholdCatalogProductMetadata[],
): DashboardViewData {
  if (!catalogProducts.length) return viewData;
  const catalogByItemNumber = new Map(
    catalogProducts
      .filter((product) => product.costcoItemNumber)
      .map((product) => [product.costcoItemNumber!, product]),
  );

  const receiptLines = viewData.receiptLines.map((line) => {
    const catalogProduct = catalogByItemNumber.get(line.itemNumber);
    if (!catalogProduct) return line;
    const categoryKey = isProductCategoryKey(catalogProduct.category)
      ? catalogProduct.category
      : line.categoryKey;
    return {
      ...line,
      name: catalogProduct.canonicalName,
      categoryKey,
      categoryLabel: categoryPresentation(categoryKey).label,
      classificationStatus: catalogProduct.categoryStatus,
    } satisfies DashboardReceiptLine;
  });
  const products = viewData.products.map((product) => {
    const catalogProduct = catalogByItemNumber.get(product.itemNumber);
    if (!catalogProduct) return product;
    const categoryKey = isProductCategoryKey(catalogProduct.category)
      ? catalogProduct.category
      : product.categoryKey;
    return {
      ...product,
      name: catalogProduct.canonicalName,
      rawDescription: catalogProduct.latestRawDescription ?? product.rawDescription,
      categoryKey,
      categoryLabel: categoryPresentation(categoryKey).label,
      classificationStatus: catalogProduct.categoryStatus,
    } satisfies DashboardProduct;
  });
  const merged = { ...viewData, receiptLines, products };
  const productCategories = scopedCategories(merged, merged.transactions);
  const warehouseTransactionIds = new Set(
    merged.transactions
      .filter((transaction) => transaction.channel === "warehouse")
      .map((transaction) => transaction.id),
  );
  const warehouseLines = receiptLines.filter((line) =>
    warehouseTransactionIds.has(line.transactionId),
  );
  const needsReviewWarehouseCents = warehouseLines
    .filter((line) => line.categoryKey === "needs_review")
    .reduce((sum, line) => sum + line.netAmountCents, 0);
  const classifiedWarehouseCents = warehouseLines
    .filter((line) => line.categoryKey !== "needs_review")
    .reduce((sum, line) => sum + line.netAmountCents, 0);

  return {
    ...merged,
    productCategories,
    needsReviewWarehouseCents,
    classifiedWarehouseCents,
  };
}
