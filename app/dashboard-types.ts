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
};

export type DashboardProduct = {
  id: string;
  itemNumber: string;
  name: string;
  rawDescription: string;
  purchaseCount: number;
  medianIntervalDays: number;
  firstPurchasedOn: string;
  lastPurchasedOn: string;
  totalSpendCents: number;
  lastPriceCents: number;
  previousPriceCents: number;
  priceHistory: readonly {
    purchasedOn: string;
    unitPriceCents: number;
  }[];
};

export type DashboardSuggestion = {
  id: string;
  itemNumber: string;
  name: string;
  section: "essentials" | "suggested" | "check_first";
  confidence: "High" | "Medium" | "Check first";
  confidenceBps: number;
  purchaseCount: number;
  medianIntervalDays: number;
  daysSinceLastPurchase: number;
  lastPurchasedOn: string;
  estimatedPriceCents: number;
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
  recentTransactions: readonly DashboardTransaction[];
  products: readonly DashboardProduct[];
  suggestions: readonly DashboardSuggestion[];
  latestWarehouseTransaction: DashboardTransaction;
};
