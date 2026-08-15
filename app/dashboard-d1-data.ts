import {
  buildDashboardViewDataFromHistory,
} from "./basketsense-dashboard-data";
import { emptyDashboardViewData } from "./empty-dashboard-view";
import {
  categoryPresentation,
  classifyReceiptItem,
  type ClassificationStatus,
  type ProductCategoryKey,
} from "./product-categories";
import { isProductCategoryKey } from "./dashboard-product-metadata";
import type {
  DashboardReceiptLine,
  DashboardTransaction,
  DashboardViewData,
} from "./dashboard-types";

type DashboardTransactionRow = {
  id: string;
  purchased_at: string;
  transaction_type: "warehouse" | "fuel" | "optical" | "return";
  item_count: number;
  total_cents: number;
  household_funded_cents: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  external_funding_cents: number;
  source_type: DashboardTransaction["sourceType"];
  audit_flag: string;
};

type DashboardReceiptLineRow = {
  id: string;
  receipt_transaction_id: string;
  transaction_type: "warehouse" | "fuel" | "optical" | "return";
  costco_item_number: string | null;
  product_id: string | null;
  canonical_name: string | null;
  category: string | null;
  category_status: string | null;
  raw_description: string;
  normalization_status: string;
  quantity_milli: number;
  unit_price_cents: number | null;
  line_subtotal_cents: number;
  discount_cents: number;
  net_amount_cents: number;
  tax_status: string;
};

type DashboardHistoryRevisionRow = {
  history_revision: string;
};

export function dashboardHistoryRevisionStatement(
  db: D1Database,
  householdId: string,
) {
  return db
    .prepare(
      `WITH scoped(household_id) AS (VALUES (?)),
            history_changes(changed_at) AS (
              SELECT receipt_transactions.updated_at
              FROM receipt_transactions, scoped
              WHERE receipt_transactions.household_id = scoped.household_id
              UNION ALL
              SELECT receipt_items.updated_at
              FROM receipt_items
              INNER JOIN receipt_transactions
                ON receipt_transactions.id = receipt_items.receipt_transaction_id
              INNER JOIN scoped
                ON scoped.household_id = receipt_transactions.household_id
              UNION ALL
              SELECT products.updated_at
              FROM products, scoped
              WHERE products.household_id = scoped.household_id
              UNION ALL
              SELECT product_images.updated_at
              FROM product_images
              INNER JOIN products ON products.id = product_images.product_id
              INNER JOIN scoped ON scoped.household_id = products.household_id
            )
       SELECT COALESCE(
                MAX(changed_at),
                '1970-01-01T00:00:00.000Z'
              ) AS history_revision
       FROM history_changes`,
    )
    .bind(householdId);
}

function dashboardChannel(
  transactionType: DashboardTransactionRow["transaction_type"],
): DashboardTransaction["channel"] {
  if (transactionType === "fuel") return "gas";
  if (transactionType === "return") return "warehouse";
  return transactionType;
}

function dashboardTaxStatus(
  value: string,
): DashboardReceiptLine["taxStatus"] {
  if (value === "non_taxable") return "non_taxable";
  if (value === "taxable") return "taxable";
  return "unknown";
}

function dashboardClassification(
  row: DashboardReceiptLineRow,
): { key: ProductCategoryKey; status: ClassificationStatus } {
  if (isProductCategoryKey(row.category)) {
    return {
      key: row.category,
      status:
        row.category_status === "reviewed" ||
        row.category_status === "rule_based" ||
        row.category_status === "needs_review"
          ? row.category_status
          : "needs_review",
    };
  }

  const taxStatus = dashboardTaxStatus(row.tax_status);
  if (taxStatus === "unknown") {
    return { key: "needs_review", status: "needs_review" };
  }

  return classifyReceiptItem({
    channel: dashboardChannel(row.transaction_type),
    itemNumber: row.costco_item_number ?? row.product_id ?? row.id,
    rawDescription: row.raw_description,
    canonicalName: row.canonical_name ?? row.raw_description,
    taxStatus,
  });
}

function dashboardItemNumber(row: DashboardReceiptLineRow): string {
  return row.costco_item_number ?? row.product_id ?? `unresolved-${row.id}`;
}

function dashboardNormalizationStatus(
  value: string,
): DashboardReceiptLine["normalizationStatus"] {
  return value === "normalized_from_history"
    ? "normalized_from_history"
    : "receipt_abbreviation";
}

function receiptDiscountSummaryLineIds(
  rows: readonly DashboardReceiptLineRow[],
  transactions: readonly DashboardTransaction[],
): ReadonlySet<string> {
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const candidatesByTransaction = new Map<string, DashboardReceiptLineRow[]>();

  for (const row of rows) {
    if (
      row.transaction_type !== "warehouse" ||
      row.costco_item_number !== "0000" ||
      row.net_amount_cents <= 0
    ) {
      continue;
    }
    const candidates =
      candidatesByTransaction.get(row.receipt_transaction_id) ?? [];
    candidates.push(row);
    candidatesByTransaction.set(row.receipt_transaction_id, candidates);
  }

  const summaryLineIds = new Set<string>();
  for (const [transactionId, candidates] of candidatesByTransaction) {
    const transaction = transactionById.get(transactionId);
    const candidateTotalCents = candidates.reduce(
      (sum, row) => sum + row.net_amount_cents,
      0,
    );
    if (
      transaction &&
      transaction.discountCents > 0 &&
      candidateTotalCents === Math.abs(transaction.discountCents)
    ) {
      for (const candidate of candidates) summaryLineIds.add(candidate.id);
    }
  }

  return summaryLineIds;
}

/**
 * Builds the exact view model consumed by the existing dashboard from
 * reconciled household evidence. Draft/rejected receipts remain visible in
 * Review, but never silently change historical actuals.
 */
export async function buildDashboardViewStateFromD1(
  db: D1Database,
  householdId: string,
): Promise<{ dashboard: DashboardViewData; historyRevision: string }> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT id, purchased_at, transaction_type, item_count, total_cents,
                household_funded_cents, discount_cents, subtotal_cents,
                tax_cents, external_funding_cents, source_type, audit_flag
         FROM receipt_transactions
         WHERE household_id = ?
           AND parse_status = 'reconciled'
           AND transaction_type IN ('warehouse', 'fuel', 'optical', 'return')
           AND (
             source_type <> 'receipt_photo'
             OR receipt_transactions.trip_id IS NULL
             OR EXISTS (
               SELECT 1 FROM trips
               WHERE trips.id = receipt_transactions.trip_id
                 AND trips.household_id = receipt_transactions.household_id
                 AND trips.status = 'completed'
             )
           )
         ORDER BY purchased_at DESC, id DESC`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT receipt_items.id, receipt_items.receipt_transaction_id,
                receipt_transactions.transaction_type,
                receipt_items.costco_item_number, receipt_items.product_id,
                products.canonical_name, products.category,
                products.category_status, receipt_items.raw_description,
                receipt_items.normalization_status, receipt_items.quantity_milli,
                receipt_items.unit_price_cents, receipt_items.line_subtotal_cents,
                receipt_items.discount_cents, receipt_items.net_amount_cents,
                receipt_items.tax_status
         FROM receipt_items
         INNER JOIN receipt_transactions
           ON receipt_transactions.id = receipt_items.receipt_transaction_id
         LEFT JOIN products ON products.id = receipt_items.product_id
         WHERE receipt_transactions.household_id = ?
           AND receipt_transactions.parse_status = 'reconciled'
           AND receipt_transactions.transaction_type IN ('warehouse', 'fuel', 'optical', 'return')
           AND (
             receipt_transactions.source_type <> 'receipt_photo'
             OR receipt_transactions.trip_id IS NULL
             OR EXISTS (
               SELECT 1 FROM trips
               WHERE trips.id = receipt_transactions.trip_id
                 AND trips.household_id = receipt_transactions.household_id
                 AND trips.status = 'completed'
             )
           )
         ORDER BY receipt_transactions.purchased_at ASC,
                  receipt_transactions.id ASC,
                  receipt_items.source_line_number ASC,
                  receipt_items.id ASC`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM receipt_transactions
         WHERE household_id = ?
           AND parse_status <> 'reconciled'
           AND transaction_type IN ('warehouse', 'fuel', 'optical', 'return')
           AND NOT (
             source_type = 'receipt_photo'
             AND trip_id IS NULL
             AND audit_flag LIKE 'ad_hoc_%'
           )`,
      )
      .bind(householdId),
    dashboardHistoryRevisionStatement(db, householdId),
  ]);

  const transactionRows = results[0].results as DashboardTransactionRow[];
  const receiptLineRows = results[1].results as DashboardReceiptLineRow[];
  const unresolved = results[2].results[0] as { count?: number } | undefined;
  const historyRevision = (
    results[3].results[0] as DashboardHistoryRevisionRow | undefined
  )?.history_revision ?? "1970-01-01T00:00:00.000Z";

  const transactions: DashboardTransaction[] = transactionRows.map((row) => ({
    id: row.id,
    purchasedOn: row.purchased_at.slice(0, 10),
    channel: dashboardChannel(row.transaction_type),
    itemCount: row.item_count,
    receiptTotalCents: row.total_cents,
    householdFundedCents: row.household_funded_cents,
    discountCents: row.discount_cents,
    merchandiseSubtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    externalFundingCents: row.external_funding_cents,
    sourceType: row.source_type,
    auditFlag: row.audit_flag,
    purchaseContext: row.audit_flag.startsWith("ad_hoc_") ? "ad_hoc" : "trip",
    transactionKind: row.transaction_type === "return" ? "return" : "purchase",
  }));

  // Some imported receipts include a positive item-0000 summary equal to the
  // receipt-level discount. It is an arithmetic duplicate, not merchandise or
  // a product the household can categorize.
  const discountSummaryLineIds = receiptDiscountSummaryLineIds(
    receiptLineRows,
    transactions,
  );

  const receiptLines: DashboardReceiptLine[] = receiptLineRows
    .filter((row) => !discountSummaryLineIds.has(row.id))
    .map((row) => {
      const classification = dashboardClassification(row);
      return {
        id: row.id,
        transactionId: row.receipt_transaction_id,
        itemNumber: dashboardItemNumber(row),
        name: row.canonical_name ?? row.raw_description,
        rawDescription: row.raw_description,
        normalizationStatus: dashboardNormalizationStatus(
          row.normalization_status,
        ),
        quantity: row.quantity_milli / 1_000,
        unitPriceCents: row.unit_price_cents,
        grossAmountCents: row.line_subtotal_cents,
        discountCents: row.discount_cents,
        netAmountCents: row.net_amount_cents,
        taxStatus: dashboardTaxStatus(row.tax_status),
        categoryKey: classification.key,
        categoryLabel: categoryPresentation(classification.key).label,
        classificationStatus: classification.status,
      };
    });

  const through = transactions.at(0)?.purchasedOn;
  if (!through) {
    return { dashboard: emptyDashboardViewData(), historyRevision };
  }

  return {
    dashboard: buildDashboardViewDataFromHistory({
      through,
      reconciliationIssueCount: unresolved?.count ?? 0,
      transactions,
      receiptLines,
    }),
    historyRevision,
  };
}

export async function buildDashboardViewDataFromD1(
  db: D1Database,
  householdId: string,
): Promise<DashboardViewData> {
  return (await buildDashboardViewStateFromD1(db, householdId)).dashboard;
}
