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
  DashboardProductCategory,
  DashboardReceiptLine,
  DashboardSuggestion,
  DashboardTransaction,
  DashboardViewData,
} from "./dashboard-types";
import {
  PRODUCT_CATEGORY_PRESENTATION,
  categoryPresentation,
  classifyReceiptItem,
  type ClassificationStatus,
  type ProductCategoryKey,
} from "./product-categories";
import {
  JULY_25_PLAN_DATE,
  buildSaturdayRecommendations,
} from "./recommendation-engine";

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

function assertEqual(
  actual: number,
  expected: number,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `Dashboard reconciliation failed for ${label}: expected ${expected}, received ${actual}`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  assertEqual(new Set(values).size, values.length, `${label} uniqueness`);
}

function daysBetween(first: string, second: string): number {
  return Math.round(
    (Date.parse(`${second}T00:00:00Z`) -
      Date.parse(`${first}T00:00:00Z`)) /
      DAY_MS,
  );
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function validateSourceFacts(): void {
  if (AUDIT_RECONCILIATION_ISSUES_2026.length > 0) {
    throw new Error(
      `Dashboard source audit has unresolved issues: ${AUDIT_RECONCILIATION_ISSUES_2026.join("; ")}`,
    );
  }

  assertEqual(
    AUDITED_RECEIPT_TRANSACTIONS_2026.length,
    AUDITED_2026_SUMMARY.transactionCount,
    "source transaction count",
  );
  assertUnique(
    AUDITED_RECEIPT_TRANSACTIONS_2026.map((transaction) => transaction.id),
    "source transaction IDs",
  );
  assertUnique(
    AUDITED_RECEIPT_ITEMS_2026.map((item) => item.id),
    "source receipt-line IDs",
  );

  const transactionIds = new Set(
    AUDITED_RECEIPT_TRANSACTIONS_2026.map((transaction) => transaction.id),
  );
  const orphanedLine = AUDITED_RECEIPT_ITEMS_2026.find(
    (item) => !transactionIds.has(item.transactionId),
  );
  if (orphanedLine) {
    throw new Error(
      `Dashboard source join failed: ${orphanedLine.id} references missing transaction ${orphanedLine.transactionId}`,
    );
  }
}

function buildTransactions(): readonly DashboardTransaction[] {
  const transactions = AUDITED_RECEIPT_TRANSACTIONS_2026.map(
    (transaction): DashboardTransaction => ({
      id: transaction.id,
      purchasedOn: transaction.purchasedOn,
      channel: transaction.category,
      itemCount: transaction.itemCount,
      receiptTotalCents: transaction.receiptTotalCents,
      householdFundedCents: transaction.householdFundedCents,
      discountCents: transaction.discountCents,
      merchandiseSubtotalCents: transaction.subtotalCents,
      taxCents: transaction.taxCents,
      externalFundingCents: transaction.externalFundingCents,
      sourceType: transaction.sourceType,
      auditFlag: transaction.auditFlag,
    }),
  ).sort(
    (first, second) =>
      second.purchasedOn.localeCompare(first.purchasedOn) ||
      second.id.localeCompare(first.id),
  );

  assertEqual(
    transactions.length,
    AUDITED_2026_SUMMARY.transactionCount,
    "dashboard transaction count",
  );
  assertEqual(
    transactions.reduce(
      (sum, transaction) => sum + transaction.householdFundedCents,
      0,
    ),
    AUDITED_2026_SUMMARY.householdFundedCents,
    "dashboard household-funded total",
  );
  assertEqual(
    transactions.reduce(
      (sum, transaction) => sum + transaction.externalFundingCents,
      0,
    ),
    AUDITED_2026_SUMMARY.externalFundingCents,
    "dashboard external-funding total",
  );

  return transactions;
}

function buildReceiptLines(
  transactionById: ReadonlyMap<string, DashboardTransaction>,
): readonly DashboardReceiptLine[] {
  const receiptLines = AUDITED_RECEIPT_ITEMS_2026.map(
    (item): DashboardReceiptLine => {
      const transaction = transactionById.get(item.transactionId);
      if (!transaction) {
        throw new Error(
          `Dashboard receipt-line join failed: ${item.id} references missing transaction ${item.transactionId}`,
        );
      }

      const classification = classifyReceiptItem({
        channel: transaction.channel,
        itemNumber: item.itemNumber,
        rawDescription: item.rawDescription,
        canonicalName: item.canonicalName,
        taxStatus: item.taxStatus,
      });

      return {
        id: item.id,
        transactionId: item.transactionId,
        itemNumber: item.itemNumber,
        name: item.canonicalName,
        rawDescription: item.rawDescription,
        normalizationStatus: item.normalizationStatus,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        grossAmountCents: item.grossAmountCents,
        discountCents: item.discountCents,
        netAmountCents: item.netAmountCents,
        taxStatus: item.taxStatus,
        categoryKey: classification.key,
        categoryLabel: categoryPresentation(classification.key).label,
        classificationStatus: classification.status,
      };
    },
  );

  assertEqual(
    receiptLines.length,
    AUDITED_RECEIPT_ITEMS_2026.length,
    "dashboard receipt-line count",
  );
  assertUnique(
    receiptLines.map((line) => line.id),
    "dashboard receipt-line IDs",
  );

  return receiptLines;
}

type ProductPriceEvent = DashboardProduct["priceHistory"][number];

function buildProducts(
  receiptLines: readonly DashboardReceiptLine[],
  transactionById: ReadonlyMap<string, DashboardTransaction>,
): readonly DashboardProduct[] {
  const warehouseLinesByItem = new Map<string, DashboardReceiptLine[]>();

  for (const line of receiptLines) {
    const transaction = transactionById.get(line.transactionId);
    if (!transaction) {
      throw new Error(
        `Dashboard product join failed: ${line.id} references missing transaction ${line.transactionId}`,
      );
    }
    if (transaction.channel !== "warehouse") continue;

    const lines = warehouseLinesByItem.get(line.itemNumber) ?? [];
    lines.push(line);
    warehouseLinesByItem.set(line.itemNumber, lines);
  }

  const products = [...warehouseLinesByItem.entries()].map(
    ([itemNumber, itemLines]): DashboardProduct => {
      const sortedLines = [...itemLines].sort((first, second) => {
        const firstTransaction = transactionById.get(first.transactionId);
        const secondTransaction = transactionById.get(second.transactionId);
        if (!firstTransaction || !secondTransaction) {
          throw new Error(
            `Dashboard product date join failed for item ${itemNumber}`,
          );
        }
        return (
          firstTransaction.purchasedOn.localeCompare(
            secondTransaction.purchasedOn,
          ) ||
          first.transactionId.localeCompare(second.transactionId) ||
          first.id.localeCompare(second.id)
        );
      });
      const categoryKeys = new Set(
        sortedLines.map((line) => line.categoryKey),
      );
      const classificationStatuses = new Set(
        sortedLines.map((line) => line.classificationStatus),
      );
      const names = new Set(sortedLines.map((line) => line.name));

      if (
        categoryKeys.size !== 1 ||
        classificationStatuses.size !== 1 ||
        names.size !== 1
      ) {
        throw new Error(
          `Dashboard product aggregation is ambiguous for warehouse item ${itemNumber}`,
        );
      }

      const eventsByTransaction = new Map<
        string,
        ProductPriceEvent & { purchasedOn: string }
      >();
      for (const line of sortedLines) {
        const transaction = transactionById.get(line.transactionId);
        if (!transaction) {
          throw new Error(
            `Dashboard product event join failed for line ${line.id}`,
          );
        }
        const existing = eventsByTransaction.get(line.transactionId);
        if (
          existing &&
          existing.unitPriceCents !== line.unitPriceCents
        ) {
          throw new Error(
            `Dashboard product event has conflicting unit prices for ${itemNumber} in ${line.transactionId}`,
          );
        }
        eventsByTransaction.set(line.transactionId, {
          transactionId: line.transactionId,
          purchasedOn: transaction.purchasedOn,
          quantity: (existing?.quantity ?? 0) + line.quantity,
          unitPriceCents: line.unitPriceCents,
          netAmountCents: (existing?.netAmountCents ?? 0) + line.netAmountCents,
        });
      }

      const priceHistory = [...eventsByTransaction.values()].sort(
        (first, second) =>
          first.purchasedOn.localeCompare(second.purchasedOn) ||
          first.transactionId.localeCompare(second.transactionId),
      );
      const intervals = priceHistory.slice(1).map((event, index) =>
        daysBetween(priceHistory[index].purchasedOn, event.purchasedOn),
      );
      const latestLine = sortedLines.at(-1);
      const latestEvent = priceHistory.at(-1);
      const previousEvent = priceHistory.at(-2);
      const categoryKey = [...categoryKeys][0] as ProductCategoryKey;
      const classificationStatus = [
        ...classificationStatuses,
      ][0] as ClassificationStatus;

      if (!latestLine || !latestEvent) {
        throw new Error(
          `Dashboard product aggregation produced no events for ${itemNumber}`,
        );
      }

      return {
        id: itemNumber,
        itemNumber,
        name: latestLine.name,
        rawDescription: latestLine.rawDescription,
        categoryKey,
        categoryLabel: categoryPresentation(categoryKey).label,
        classificationStatus,
        purchaseCount: priceHistory.length,
        totalUnits: priceHistory.reduce(
          (sum, event) => sum + event.quantity,
          0,
        ),
        medianIntervalDays: median(intervals),
        firstPurchasedOn: priceHistory[0].purchasedOn,
        lastPurchasedOn: latestEvent.purchasedOn,
        totalSpendCents: priceHistory.reduce(
          (sum, event) => sum + event.netAmountCents,
          0,
        ),
        lastPriceCents: latestEvent.unitPriceCents,
        previousPriceCents: previousEvent?.unitPriceCents ?? null,
        priceHistory,
      };
    },
  );

  products.sort(
    (first, second) =>
      second.purchaseCount - first.purchaseCount ||
      second.totalSpendCents - first.totalSpendCents ||
      first.name.localeCompare(second.name),
  );

  assertEqual(
    products.length,
    warehouseLinesByItem.size,
    "distinct warehouse products",
  );
  assertEqual(
    products.reduce((sum, product) => sum + product.totalSpendCents, 0),
    receiptLines
      .filter(
        (line) =>
          transactionById.get(line.transactionId)?.channel === "warehouse",
      )
      .reduce((sum, line) => sum + line.netAmountCents, 0),
    "warehouse product net spend",
  );

  return products;
}

function buildProductCategories(
  receiptLines: readonly DashboardReceiptLine[],
  transactions: readonly DashboardTransaction[],
  transactionById: ReadonlyMap<string, DashboardTransaction>,
): {
  productCategories: readonly DashboardProductCategory[];
  warehouseTaxCents: number;
  classifiedWarehouseCents: number;
  needsReviewWarehouseCents: number;
} {
  const warehouseCategoryAmounts = new Map<ProductCategoryKey, number>();
  const warehouseCategoryItems = new Map<ProductCategoryKey, number>();
  const warehouseCategoryTransactions = new Map<
    ProductCategoryKey,
    Set<string>
  >();

  for (const line of receiptLines) {
    const transaction = transactionById.get(line.transactionId);
    if (!transaction) {
      throw new Error(
        `Dashboard category join failed: ${line.id} references missing transaction ${line.transactionId}`,
      );
    }
    if (transaction.channel !== "warehouse") continue;
    if (line.categoryKey === "fuel" || line.categoryKey === "optical_services") {
      throw new Error(
        `Warehouse receipt line ${line.id} was classified as ${line.categoryKey}`,
      );
    }

    warehouseCategoryAmounts.set(
      line.categoryKey,
      (warehouseCategoryAmounts.get(line.categoryKey) ?? 0) +
        line.netAmountCents,
    );
    warehouseCategoryItems.set(
      line.categoryKey,
      (warehouseCategoryItems.get(line.categoryKey) ?? 0) + line.quantity,
    );
    const transactionIds =
      warehouseCategoryTransactions.get(line.categoryKey) ?? new Set<string>();
    transactionIds.add(line.transactionId);
    warehouseCategoryTransactions.set(line.categoryKey, transactionIds);
  }

  const channelTransactions = {
    fuel: transactions.filter((transaction) => transaction.channel === "gas"),
    optical_services: transactions.filter(
      (transaction) => transaction.channel === "optical",
    ),
  } as const;

  const productCategories = PRODUCT_CATEGORY_PRESENTATION.map(
    (presentation): DashboardProductCategory => {
      if (
        presentation.key === "fuel" ||
        presentation.key === "optical_services"
      ) {
        const sourceTransactions = channelTransactions[presentation.key];
        return {
          ...presentation,
          householdViewCents: sourceTransactions.reduce(
            (sum, transaction) => sum + transaction.householdFundedCents,
            0,
          ),
          transactionCount: sourceTransactions.length,
          itemCount: sourceTransactions.reduce(
            (sum, transaction) => sum + transaction.itemCount,
            0,
          ),
          classificationBasis: "household_funded_channel",
        };
      }

      return {
        ...presentation,
        householdViewCents:
          warehouseCategoryAmounts.get(presentation.key) ?? 0,
        transactionCount:
          warehouseCategoryTransactions.get(presentation.key)?.size ?? 0,
        itemCount: warehouseCategoryItems.get(presentation.key) ?? 0,
        classificationBasis: "warehouse_merchandise_before_tax",
      };
    },
  );

  const warehouseTransactions = transactions.filter(
    (transaction) => transaction.channel === "warehouse",
  );
  const warehouseMerchandiseCents = warehouseTransactions.reduce(
    (sum, transaction) => sum + transaction.merchandiseSubtotalCents,
    0,
  );
  const warehouseTaxCents = warehouseTransactions.reduce(
    (sum, transaction) => sum + transaction.taxCents,
    0,
  );
  const needsReviewWarehouseCents =
    warehouseCategoryAmounts.get("needs_review") ?? 0;
  const classifiedWarehouseCents = [...warehouseCategoryAmounts.entries()]
    .filter(([key]) => key !== "needs_review")
    .reduce((sum, [, amount]) => sum + amount, 0);

  assertEqual(
    classifiedWarehouseCents + needsReviewWarehouseCents,
    warehouseMerchandiseCents,
    "classified plus needs-review warehouse merchandise",
  );
  assertEqual(
    receiptLines
      .filter(
        (line) =>
          transactionById.get(line.transactionId)?.channel === "warehouse",
      )
      .reduce((sum, line) => sum + line.netAmountCents, 0),
    warehouseMerchandiseCents,
    "warehouse receipt lines to merchandise subtotal",
  );
  assertEqual(
    productCategories.reduce(
      (sum, category) => sum + category.householdViewCents,
      0,
    ) + warehouseTaxCents,
    AUDITED_2026_SUMMARY.householdFundedCents,
    "product categories plus warehouse tax to household-funded total",
  );
  assertEqual(
    productCategories.find((category) => category.key === "optical_services")
      ?.householdViewCents ?? -1,
    5_399,
    "optical household-funded category",
  );

  return {
    productCategories,
    warehouseTaxCents,
    classifiedWarehouseCents,
    needsReviewWarehouseCents,
  };
}

function buildSuggestions(): readonly DashboardSuggestion[] {
  return buildSaturdayRecommendations(
    RECURRING_PRODUCT_HISTORIES_2026,
    JULY_25_PLAN_DATE,
  ).map((recommendation): DashboardSuggestion => ({
    id: `suggestion-${recommendation.itemNumber}`,
    itemNumber: recommendation.itemNumber,
    name: recommendation.name,
    section: recommendation.section,
    confidence:
      recommendation.confidenceBps >= 8_000
        ? "High"
        : recommendation.confidenceBps >= 6_000
          ? "Medium"
          : "Check first",
    confidenceBps: recommendation.confidenceBps,
    purchaseCount: recommendation.evidence.purchaseCount,
    medianIntervalDays: recommendation.evidence.medianIntervalDays,
    daysSinceLastPurchase: recommendation.evidence.daysSinceLastPurchase,
    lastPurchasedOn: recommendation.evidence.lastPurchasedOn,
    estimatedPriceCents: recommendation.estimatedPriceCents,
    reason: recommendation.reason,
  }));
}

export function buildDashboardViewData(): DashboardViewData {
  validateSourceFacts();

  const transactions = buildTransactions();
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const receiptLines = buildReceiptLines(transactionById);
  const products = buildProducts(receiptLines, transactionById);
  const {
    productCategories,
    warehouseTaxCents,
    classifiedWarehouseCents,
    needsReviewWarehouseCents,
  } = buildProductCategories(receiptLines, transactions, transactionById);
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
    productCategories,
    warehouseTaxCents,
    classifiedWarehouseCents,
    needsReviewWarehouseCents,
    transactions,
    receiptLines,
    recentTransactions: transactions.slice(0, 7),
    products,
    suggestions: buildSuggestions(),
    suggestionPlanDate: JULY_25_PLAN_DATE,
    latestWarehouseTransaction,
  };
}
