import {
  AUDITED_2026_SUMMARY,
  AUDITED_CATEGORY_TOTALS_2026,
  AUDITED_MONTHLY_TOTALS_2026,
  AUDITED_RECEIPT_ITEMS_2026,
  AUDITED_RECEIPT_TRANSACTIONS_2026,
  AUDIT_RECONCILIATION_ISSUES_2026,
  RECURRING_PRODUCT_HISTORIES_2026,
} from "./basketsense-data";
import type {
  DashboardProduct,
  DashboardSuggestion,
  DashboardViewData,
} from "./dashboard-types";

const NEXT_PLAN_DATE = "2026-07-25";
const DAY_MS = 86_400_000;

const monthLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});

const channelPresentation = {
  warehouse: { label: "Warehouse", color: "var(--sage)" },
  gas: { label: "Gas", color: "var(--apricot)" },
  optical: { label: "Optical out-of-pocket", color: "var(--lilac)" },
} as const;

function daysBetween(first: string, second: string) {
  return Math.round(
    (Date.parse(`${second}T00:00:00Z`) -
      Date.parse(`${first}T00:00:00Z`)) /
      DAY_MS,
  );
}

function buildProducts(): readonly DashboardProduct[] {
  const transactions = new Map(
    AUDITED_RECEIPT_TRANSACTIONS_2026.map((transaction) => [
      transaction.id,
      transaction,
    ]),
  );

  return RECURRING_PRODUCT_HISTORIES_2026.map((history) => {
    const latestEvent = history.events.at(-1);
    const latestItem = latestEvent
      ? AUDITED_RECEIPT_ITEMS_2026.find(
          (item) =>
            item.transactionId === latestEvent.transactionId &&
            item.itemNumber === history.itemNumber,
        )
      : undefined;

    if (!latestEvent || !latestItem || !transactions.has(latestEvent.transactionId)) {
      return null;
    }

    const priceHistory = history.events.slice(-5).map((event) => ({
      purchasedOn: event.purchasedOn,
      unitPriceCents: event.unitPriceCents,
    }));

    return {
      id: history.itemNumber,
      itemNumber: history.itemNumber,
      name: history.canonicalName,
      rawDescription: latestItem.rawDescription,
      purchaseCount: history.purchaseCount,
      medianIntervalDays: history.medianIntervalDays,
      firstPurchasedOn: history.firstPurchasedOn,
      lastPurchasedOn: history.lastPurchasedOn,
      totalSpendCents: history.events.reduce(
        (sum, event) => sum + event.netAmountCents,
        0,
      ),
      lastPriceCents: latestEvent.unitPriceCents,
      previousPriceCents:
        history.events.at(-2)?.unitPriceCents ?? latestEvent.unitPriceCents,
      priceHistory,
    } satisfies DashboardProduct;
  })
    .filter((product): product is DashboardProduct => product !== null)
    .slice(0, 12);
}

function buildSuggestions(
  products: readonly DashboardProduct[],
): readonly DashboardSuggestion[] {
  const byItemNumber = new Map(products.map((product) => [product.itemNumber, product]));
  const candidates = [
    { itemNumber: "1550393", section: "essentials", confidenceBps: 9600 },
    { itemNumber: "2619", section: "essentials", confidenceBps: 8400 },
    { itemNumber: "2023727", section: "suggested", confidenceBps: 7200 },
    { itemNumber: "1344", section: "suggested", confidenceBps: 6600 },
    {
      itemNumber: "720650",
      section: "check_first",
      confidenceBps: 4200,
      reason:
        "Previously weekly, but not purchased since Jun 6 — check whether this habit changed",
    },
    {
      itemNumber: "1068083",
      section: "check_first",
      confidenceBps: 4300,
      reason:
        "Exact item last purchased Jun 27; a different egg product appeared Jul 12 — check supply",
    },
  ] as const;

  return candidates.flatMap((candidate) => {
    const product = byItemNumber.get(candidate.itemNumber);
    if (!product) return [];

    const daysSinceLastPurchase = daysBetween(
      product.lastPurchasedOn,
      NEXT_PLAN_DATE,
    );
    const confidence =
      candidate.confidenceBps >= 8000
        ? "High"
        : candidate.confidenceBps >= 6000
          ? "Medium"
          : "Check first";
    const reason =
      "reason" in candidate
        ? candidate.reason
        : `${product.purchaseCount} purchases · usually every ${product.medianIntervalDays} days · last purchased ${product.lastPurchasedOn}`;

    return [
      {
        id: `suggestion-${candidate.itemNumber}`,
        itemNumber: candidate.itemNumber,
        name: product.name,
        section: candidate.section,
        confidence,
        confidenceBps: candidate.confidenceBps,
        purchaseCount: product.purchaseCount,
        medianIntervalDays: product.medianIntervalDays,
        daysSinceLastPurchase,
        lastPurchasedOn: product.lastPurchasedOn,
        estimatedPriceCents: product.lastPriceCents,
        reason,
      } satisfies DashboardSuggestion,
    ];
  });
}

export function buildDashboardViewData(): DashboardViewData {
  const products = buildProducts();
  const transactions = [...AUDITED_RECEIPT_TRANSACTIONS_2026]
    .sort((first, second) => second.purchasedOn.localeCompare(first.purchasedOn))
    .map((transaction) => ({
      id: transaction.id,
      purchasedOn: transaction.purchasedOn,
      channel: transaction.category,
      itemCount: transaction.itemCount,
      receiptTotalCents: transaction.receiptTotalCents,
      householdFundedCents: transaction.householdFundedCents,
      discountCents: transaction.discountCents,
    }));
  const latestWarehouseTransaction = transactions.find(
    (transaction) => transaction.id === "warehouse-2026-07-18",
  );

  if (!latestWarehouseTransaction) {
    throw new Error("The audited July 18 warehouse transaction is missing");
  }

  const warehouse = AUDITED_CATEGORY_TOTALS_2026.find(
    (category) => category.category === "warehouse",
  );
  const gas = AUDITED_CATEGORY_TOTALS_2026.find(
    (category) => category.category === "gas",
  );
  const optical = AUDITED_CATEGORY_TOTALS_2026.find(
    (category) => category.category === "optical",
  );

  if (!warehouse || !gas || !optical) {
    throw new Error("The audited channel summary is incomplete");
  }

  return {
    audit: {
      through: AUDITED_2026_SUMMARY.through,
      householdFundedCents: AUDITED_2026_SUMMARY.householdFundedCents,
      grossReceiptTotalCents: AUDITED_2026_SUMMARY.grossReceiptTotalCents,
      externalFundingCents: AUDITED_2026_SUMMARY.externalFundingCents,
      transactionCount: AUDITED_2026_SUMMARY.transactionCount,
      warehouseTransactionCount: warehouse.transactionCount,
      gasTransactionCount: gas.transactionCount,
      opticalTransactionCount: optical.transactionCount,
      averageWarehouseCents: Math.round(
        warehouse.householdFundedCents / warehouse.transactionCount,
      ),
      reconciliationIssueCount: AUDIT_RECONCILIATION_ISSUES_2026.length,
    },
    months: AUDITED_MONTHLY_TOTALS_2026.map((month) => ({
      key: month.month,
      label: monthLabel.format(new Date(`${month.month}-01T00:00:00Z`)),
      householdFundedCents: month.householdFundedCents,
      transactionCount: month.transactionCount,
    })),
    channels: AUDITED_CATEGORY_TOTALS_2026.map((channel) => ({
      key: channel.category,
      label: channelPresentation[channel.category].label,
      householdFundedCents: channel.householdFundedCents,
      grossReceiptTotalCents: channel.grossReceiptTotalCents,
      transactionCount: channel.transactionCount,
      color: channelPresentation[channel.category].color,
    })),
    recentTransactions: transactions.slice(0, 7),
    products,
    suggestions: buildSuggestions(products),
    latestWarehouseTransaction,
  };
}
