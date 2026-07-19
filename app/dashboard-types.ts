export type DashboardMonth = {
  key: string;
  label: string;
  householdFundedCents: number;
  transactionCount: number;
};

export type DashboardChannel = {
  key: "warehouse" | "gas" | "optical";
  label: string;
  householdFundedCents: number;
  grossReceiptTotalCents: number;
  transactionCount: number;
  color: string;
};

export type DashboardTransaction = {
  id: string;
  purchasedOn: string;
  channel: "warehouse" | "gas" | "optical";
  itemCount: number;
  receiptTotalCents: number;
  householdFundedCents: number;
  discountCents: number;
  merchandiseSubtotalCents: number;
  taxCents: number;
  externalFundingCents: number;
  sourceType: "digital_receipt" | "fuel_receipt" | "receipt_photo";
  auditFlag:
    | "none"
    | "external_funding_split"
    | "page_overlap_deduped"
    | "photo_value_inferred";
};

export type DashboardReceiptLine = {
  id: string;
  transactionId: string;
  itemNumber: string;
  name: string;
  rawDescription: string;
  normalizationStatus: "receipt_abbreviation" | "normalized_from_history";
  quantity: number;
  unitPriceCents: number | null;
  grossAmountCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: "taxable" | "non_taxable";
  categoryKey: ProductCategoryKey;
  categoryLabel: string;
  classificationStatus: ClassificationStatus;
};

export type DashboardProductCategory = {
  key: ProductCategoryKey;
  label: string;
  shortLabel: string;
  color: string;
  householdViewCents: number;
  transactionCount: number;
  itemCount: number;
  classificationBasis:
    | "warehouse_merchandise_before_tax"
    | "household_funded_channel";
};

export type DashboardProduct = {
  id: string;
  itemNumber: string;
  name: string;
  rawDescription: string;
  categoryKey: ProductCategoryKey;
  categoryLabel: string;
  classificationStatus: ClassificationStatus;
  purchaseCount: number;
  totalUnits: number;
  medianIntervalDays: number | null;
  firstPurchasedOn: string;
  lastPurchasedOn: string;
  totalSpendCents: number;
  lastPriceCents: number | null;
  previousPriceCents: number | null;
  priceHistory: readonly {
    transactionId: string;
    purchasedOn: string;
    quantity: number;
    unitPriceCents: number | null;
    grossAmountCents: number;
    discountCents: number;
    netAmountCents: number;
  }[];
};

export type DashboardSuggestion = {
  id: string;
  itemNumber: string;
  name: string;
  section: "essentials" | "suggested" | "check_first" | "consider";
  confidence: "High" | "Medium" | "Check first";
  confidenceBps: number;
  purchaseCount: number;
  medianIntervalDays: number;
  daysSinceLastPurchase: number;
  lastPurchasedOn: string;
  estimatedPriceCents: number | null;
  reason: string;
};

export type DashboardViewData = {
  audit: {
    through: string;
    householdFundedCents: number;
    grossReceiptTotalCents: number;
    externalFundingCents: number;
    transactionCount: number;
    warehouseTransactionCount: number;
    gasTransactionCount: number;
    opticalTransactionCount: number;
    averageWarehouseCents: number;
    reconciliationIssueCount: number;
  };
  months: readonly DashboardMonth[];
  channels: readonly DashboardChannel[];
  productCategories: readonly DashboardProductCategory[];
  warehouseTaxCents: number;
  classifiedWarehouseCents: number;
  needsReviewWarehouseCents: number;
  transactions: readonly DashboardTransaction[];
  receiptLines: readonly DashboardReceiptLine[];
  recentTransactions: readonly DashboardTransaction[];
  products: readonly DashboardProduct[];
  suggestions: readonly DashboardSuggestion[];
  suggestionPlanDate: string;
  latestWarehouseTransaction: DashboardTransaction;
};
import type {
  ClassificationStatus,
  ProductCategoryKey,
} from "./product-categories";
