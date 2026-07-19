import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestampDefault = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const households = sqliteTable(
  "households",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    timeZone: text("time_zone").notNull().default("America/Los_Angeles"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [uniqueIndex("households_slug_unique").on(table.slug)]
);

export const householdMembers = sqliteTable(
  "household_members",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    lastSeenAt: text("last_seen_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("household_members_household_email_unique").on(
      table.householdId,
      table.userEmail
    ),
    index("household_members_household_idx").on(table.householdId),
  ]
);

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    costcoItemNumber: text("costco_item_number"),
    canonicalName: text("canonical_name").notNull(),
    category: text("category"),
    brand: text("brand"),
    unitDescription: text("unit_description"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("products_household_item_number_unique").on(
      table.householdId,
      table.costcoItemNumber
    ),
    index("products_household_name_idx").on(
      table.householdId,
      table.canonicalName
    ),
  ]
);

export const trips = sqliteTable(
  "trips",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status", { enum: ["planning", "frozen", "completed"] })
      .notNull()
      .default("planning"),
    targetCents: integer("target_cents"),
    discoveryAllowanceCents: integer("discovery_allowance_cents"),
    estimatedListTotalAtFreezeCents: integer(
      "estimated_list_total_at_freeze_cents"
    ),
    estimatedPricedItemCountAtFreeze: integer(
      "estimated_priced_item_count_at_freeze"
    ),
    estimatedUnpricedItemCountAtFreeze: integer(
      "estimated_unpriced_item_count_at_freeze"
    ),
    frozenAt: text("frozen_at"),
    completedAt: text("completed_at"),
    createdByMemberId: text("created_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("trips_household_scheduled_for_unique").on(
      table.householdId,
      table.scheduledFor
    ),
    index("trips_household_status_idx").on(table.householdId, table.status),
  ]
);

export const tripListItems = sqliteTable(
  "trip_list_items",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    section: text("section", {
      enum: ["essentials", "suggested", "check_first", "consider"],
    })
      .notNull()
      .default("essentials"),
    source: text("source", {
      enum: ["manual", "recurring", "predicted", "consider", "in_store"],
    })
      .notNull()
      .default("manual"),
    recommendationReason: text("recommendation_reason"),
    confidenceBps: integer("confidence_bps"),
    included: integer("included", { mode: "boolean" })
      .notNull()
      .default(true),
    checked: integer("checked", { mode: "boolean" })
      .notNull()
      .default(false),
    includedAtFreeze: integer("included_at_freeze", { mode: "boolean" }),
    addedAfterFreeze: integer("added_after_freeze", { mode: "boolean" })
      .notNull()
      .default(false),
    estimatedPriceCents: integer("estimated_price_cents"),
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    sortOrder: integer("sort_order").notNull().default(0),
    addedByMemberId: text("added_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("trip_list_items_trip_sort_idx").on(table.tripId, table.sortOrder),
    index("trip_list_items_product_idx").on(table.productId),
  ]
);

export const receiptTransactions = sqliteTable(
  "receipt_transactions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id").references(() => trips.id, {
      onDelete: "set null",
    }),
    sourceTransactionKey: text("source_transaction_key").notNull(),
    transactionType: text("transaction_type", {
      enum: ["warehouse", "fuel", "optical", "return"],
    })
      .notNull()
      .default("warehouse"),
    sourceType: text("source_type", {
      enum: ["digital_receipt", "fuel_receipt", "receipt_photo"],
    }).notNull(),
    purchasedAt: text("purchased_at").notNull(),
    itemGrossCents: integer("item_gross_cents").notNull(),
    itemCount: integer("item_count").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    taxCents: integer("tax_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    householdFundedCents: integer("household_funded_cents").notNull(),
    externalFundingCents: integer("external_funding_cents")
      .notNull()
      .default(0),
    auditFlag: text("audit_flag").notNull().default("none"),
    parseStatus: text("parse_status", {
      enum: ["needs_review", "reconciled", "rejected"],
    })
      .notNull()
      .default("needs_review"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("receipt_transactions_household_source_key_unique").on(
      table.householdId,
      table.sourceTransactionKey
    ),
    index("receipt_transactions_household_purchased_idx").on(
      table.householdId,
      table.purchasedAt
    ),
    index("receipt_transactions_trip_idx").on(table.tripId),
  ]
);

export const receiptItems = sqliteTable(
  "receipt_items",
  {
    id: text("id").primaryKey(),
    receiptTransactionId: text("receipt_transaction_id")
      .notNull()
      .references(() => receiptTransactions.id, { onDelete: "cascade" }),
    productId: text("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    sourceLineNumber: integer("source_line_number").notNull(),
    costcoItemNumber: text("costco_item_number"),
    rawDescription: text("raw_description").notNull(),
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    unitPriceCents: integer("unit_price_cents"),
    unitPriceMills: integer("unit_price_mills"),
    lineSubtotalCents: integer("line_subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    netAmountCents: integer("net_amount_cents").notNull(),
    taxStatus: text("tax_status", {
      enum: ["taxable", "non_taxable"],
    }).notNull(),
    normalizationStatus: text("normalization_status", {
      enum: ["receipt_abbreviation", "normalized_from_history"],
    }).notNull(),
    isReturn: integer("is_return", { mode: "boolean" })
      .notNull()
      .default(false),
    matchConfidenceBps: integer("match_confidence_bps"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("receipt_items_transaction_line_unique").on(
      table.receiptTransactionId,
      table.sourceLineNumber
    ),
    index("receipt_items_product_idx").on(table.productId),
  ]
);

export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id").references(() => trips.id, {
      onDelete: "cascade",
    }),
    receiptTransactionId: text("receipt_transaction_id").references(
      () => receiptTransactions.id,
      { onDelete: "cascade" }
    ),
    listItemId: text("list_item_id").references(() => tripListItems.id, {
      onDelete: "set null",
    }),
    receiptItemId: text("receipt_item_id").references(() => receiptItems.id, {
      onDelete: "set null",
    }),
    kind: text("kind", {
      enum: [
        "trip_enjoyment",
        "recommendation_response",
        "discovery_outcome",
        "duplicate_signal",
        "waste_signal",
        "regret_signal",
      ],
    }).notNull(),
    value: text("value").notNull(),
    rating: integer("rating"),
    note: text("note"),
    createdByMemberId: text("created_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    index("feedback_household_created_idx").on(
      table.householdId,
      table.createdAt
    ),
    index("feedback_trip_idx").on(table.tripId),
    index("feedback_receipt_transaction_idx").on(
      table.receiptTransactionId
    ),
    index("feedback_receipt_item_idx").on(table.receiptItemId),
  ]
);

export type Household = typeof households.$inferSelect;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Trip = typeof trips.$inferSelect;
export type TripListItem = typeof tripListItems.$inferSelect;
export type ReceiptTransaction = typeof receiptTransactions.$inferSelect;
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
