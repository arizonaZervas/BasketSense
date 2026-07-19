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
      enum: ["taxable", "non_taxable", "unknown"],
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
        "receipt_correction",
        "fulfillment_reason",
        "product_experience",
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

export const tripIntentSnapshots = sqliteTable(
  "trip_intent_snapshots",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    evidenceLevel: text("evidence_level", {
      enum: ["pre_trip", "upload_fallback"],
    }).notNull(),
    estimatedTotalCents: integer("estimated_total_cents").notNull().default(0),
    pricedItemCount: integer("priced_item_count").notNull().default(0),
    unpricedItemCount: integer("unpriced_item_count").notNull().default(0),
    capturedByMemberId: text("captured_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    capturedAt: text("captured_at").notNull().default(timestampDefault),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("trip_intent_snapshots_trip_unique").on(table.tripId),
    index("trip_intent_snapshots_evidence_idx").on(table.evidenceLevel),
  ]
);

export const tripIntentItems = sqliteTable(
  "trip_intent_items",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => tripIntentSnapshots.id, { onDelete: "cascade" }),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    listItemId: text("list_item_id").references(() => tripListItems.id, {
      onDelete: "set null",
    }),
    productId: text("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    label: text("label").notNull(),
    section: text("section", {
      enum: ["essentials", "suggested", "check_first", "consider"],
    }).notNull(),
    source: text("source", {
      enum: ["manual", "recurring", "predicted", "consider", "in_store"],
    }).notNull(),
    recommendationReason: text("recommendation_reason"),
    confidenceBps: integer("confidence_bps"),
    included: integer("included", { mode: "boolean" }).notNull(),
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    estimatedPriceCents: integer("estimated_price_cents"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("trip_intent_items_snapshot_list_unique").on(
      table.snapshotId,
      table.listItemId
    ),
    index("trip_intent_items_trip_sort_idx").on(table.tripId, table.sortOrder),
    index("trip_intent_items_product_idx").on(table.productId),
  ]
);

export const receiptUploads = sqliteTable(
  "receipt_uploads",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    receiptTransactionId: text("receipt_transaction_id")
      .notNull()
      .references(() => receiptTransactions.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    status: text("status", { enum: ["stored", "replaced", "deleted"] })
      .notNull()
      .default("stored"),
    uploadedByMemberId: text("uploaded_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("receipt_uploads_receipt_unique").on(
      table.receiptTransactionId
    ),
    uniqueIndex("receipt_uploads_storage_key_unique").on(table.storageKey),
    index("receipt_uploads_household_idx").on(table.householdId),
  ]
);

export const productAliases = sqliteTable(
  "product_aliases",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    aliasKey: text("alias_key").notNull(),
    rawDescription: text("raw_description").notNull(),
    normalizedDescription: text("normalized_description").notNull(),
    costcoItemNumber: text("costco_item_number"),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    confirmationSource: text("confirmation_source", {
      enum: ["historical", "member"],
    }).notNull(),
    confirmedByMemberId: text("confirmed_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("product_aliases_household_key_unique").on(
      table.householdId,
      table.aliasKey
    ),
    index("product_aliases_product_idx").on(table.productId),
  ]
);

export const tripItemMatches = sqliteTable(
  "trip_item_matches",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    receiptTransactionId: text("receipt_transaction_id")
      .notNull()
      .references(() => receiptTransactions.id, { onDelete: "cascade" }),
    intentItemId: text("intent_item_id")
      .notNull()
      .references(() => tripIntentItems.id, { onDelete: "cascade" }),
    receiptItemId: text("receipt_item_id")
      .notNull()
      .references(() => receiptItems.id, { onDelete: "cascade" }),
    matchType: text("match_type", {
      enum: [
        "exact_item_number",
        "exact_product",
        "confirmed_alias",
        "exact_name",
        "member_confirmed",
      ],
    }).notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    resolutionSource: text("resolution_source", {
      enum: ["system", "member"],
    }).notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("trip_item_matches_receipt_item_unique").on(
      table.receiptItemId
    ),
    uniqueIndex("trip_item_matches_intent_item_unique").on(table.intentItemId),
    index("trip_item_matches_receipt_idx").on(table.receiptTransactionId),
    index("trip_item_matches_trip_idx").on(table.tripId),
  ]
);

export const reviewQuestions = sqliteTable(
  "review_questions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    receiptTransactionId: text("receipt_transaction_id")
      .notNull()
      .references(() => receiptTransactions.id, { onDelete: "cascade" }),
    questionKey: text("question_key").notNull(),
    purpose: text("purpose", {
      enum: ["data_quality", "intent", "outcome", "product_experience"],
    }).notNull(),
    prompt: text("prompt").notNull(),
    optionsJson: text("options_json").notNull(),
    declaredEffect: text("declared_effect").notNull(),
    effectTarget: text("effect_target"),
    listItemId: text("list_item_id").references(() => tripListItems.id, {
      onDelete: "set null",
    }),
    intentItemId: text("intent_item_id").references(() => tripIntentItems.id, {
      onDelete: "set null",
    }),
    receiptItemId: text("receipt_item_id").references(() => receiptItems.id, {
      onDelete: "set null",
    }),
    priority: integer("priority").notNull().default(100),
    status: text("status", { enum: ["open", "answered", "dismissed"] })
      .notNull()
      .default("open"),
    answerValue: text("answer_value"),
    answerNote: text("answer_note"),
    answeredByMemberId: text("answered_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    answeredAt: text("answered_at"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("review_questions_receipt_key_unique").on(
      table.receiptTransactionId,
      table.questionKey
    ),
    index("review_questions_receipt_status_idx").on(
      table.receiptTransactionId,
      table.status,
      table.priority
    ),
    index("review_questions_household_idx").on(table.householdId),
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
export type TripIntentSnapshot = typeof tripIntentSnapshots.$inferSelect;
export type TripIntentItem = typeof tripIntentItems.$inferSelect;
export type ReceiptUpload = typeof receiptUploads.$inferSelect;
export type ProductAlias = typeof productAliases.$inferSelect;
export type TripItemMatch = typeof tripItemMatches.$inferSelect;
export type ReviewQuestion = typeof reviewQuestions.$inferSelect;
