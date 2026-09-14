import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
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
    categoryStatus: text("category_status", {
      enum: ["reviewed", "rule_based", "needs_review"],
    })
      .notNull()
      .default("needs_review"),
    categoryReviewedAt: text("category_reviewed_at"),
    categoryReviewedByMemberId: text(
      "category_reviewed_by_member_id"
    ).references(() => householdMembers.id, { onDelete: "set null" }),
    catalogRevision: text("catalog_revision"),
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
    index("products_household_category_status_idx").on(
      table.householdId,
      table.categoryStatus
    ),
  ]
);

export const productImages = sqliteTable(
  "product_images",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sourceType: text("source_type", {
      enum: [
        "household_upload",
        "ai_generated",
        "open_food_facts",
        "manufacturer",
      ],
    }).notNull(),
    sourcePageUrl: text("source_page_url"),
    sourceImageUrl: text("source_image_url"),
    sourceExternalId: text("source_external_id"),
    sourceProductName: text("source_product_name"),
    sourceBrand: text("source_brand"),
    sourceQuantity: text("source_quantity"),
    storageKey: text("storage_key"),
    attributionText: text("attribution_text"),
    licenseCode: text("license_code"),
    confidenceBps: integer("confidence_bps"),
    status: text("status", {
      enum: ["candidate", "approved", "rejected"],
    })
      .notNull()
      .default("candidate"),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    contentSha256: text("content_sha256"),
    createdByMemberId: text("created_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" },
    ),
    reviewedByMemberId: text("reviewed_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" },
    ),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("product_images_product_source_unique")
      .on(table.productId, table.sourceImageUrl),
    uniqueIndex("product_images_storage_key_unique")
      .on(table.storageKey),
    uniqueIndex("product_images_product_primary_unique")
      .on(table.productId)
      .where(sql`is_primary = 1 AND status = 'approved'`),
    index("product_images_household_status_idx").on(
      table.householdId,
      table.status,
      table.updatedAt,
    ),
    index("product_images_product_status_idx").on(
      table.productId,
      table.status,
      table.isPrimary,
    ),
  ],
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
    // Migration 0008 installs the triggers that advance this ledger.
    listRevision: integer("list_revision").notNull().default(0),
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

export const tripSkips = sqliteTable(
  "trip_skips",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    scheduledFor: text("scheduled_for").notNull(),
    skippedByMemberId: text("skipped_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("trip_skips_household_scheduled_for_unique").on(
      table.householdId,
      table.scheduledFor
    ),
    index("trip_skips_trip_scheduled_for_idx").on(
      table.tripId,
      table.scheduledFor
    ),
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
    // Stores the exact revision assigned by the same trigger transaction.
    listRevision: integer("list_revision").notNull().default(0),
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
    uniqueIndex("receipt_transactions_household_trip_photo_unique")
      .on(table.householdId, table.tripId)
      .where(sql`source_type = 'receipt_photo'`),
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
    interpretedName: text("interpreted_name"),
    interpretedBrand: text("interpreted_brand"),
    interpretedProductFamily: text("interpreted_product_family"),
    interpretedVariant: text("interpreted_variant"),
    interpretationCategoryHint: text("interpretation_category_hint"),
    interpretationConfidenceBps: integer("interpretation_confidence_bps"),
    interpretationSource: text("interpretation_source"),
    interpretationModel: text("interpretation_model"),
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
    productId: text("product_id").references(() => products.id, {
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
    index("feedback_product_idx").on(table.productId),
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

/**
 * The durable record for an uploaded receipt before it becomes a confirmed
 * receipt transaction. The current household flow does not enqueue jobs yet;
 * this table is the migration-safe boundary required before asynchronous
 * extraction, semantic parsing, or notifications are introduced.
 */
export const receiptIngestions = sqliteTable(
  "receipt_ingestions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id").references(() => trips.id, {
      onDelete: "cascade",
    }),
    requestedByMemberId: text("requested_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    clientRequestId: text("client_request_id").notNull(),
    sourceStorageKey: text("source_storage_key").notNull(),
    sourceSha256: text("source_sha256"),
    sourceContentType: text("source_content_type").notNull(),
    sourceByteSize: integer("source_byte_size").notNull(),
    status: text("status", {
      enum: [
        "uploaded",
        "queued",
        "extracting",
        "classifying",
        "reconciling",
        "awaiting_review",
        "complete",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("uploaded"),
    revision: integer("revision").notNull().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    workflowInstanceId: text("workflow_instance_id"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    schemaVersion: text("schema_version"),
    recoveryManifestKey: text("recovery_manifest_key"),
    extractionArtifactKey: text("extraction_artifact_key"),
    receiptTransactionId: text("receipt_transaction_id").references(
      () => receiptTransactions.id,
      { onDelete: "set null" }
    ),
    errorCode: text("error_code"),
    providerResponseId: text("provider_response_id"),
    providerFinishReason: text("provider_finish_reason"),
    providerDurationMs: integer("provider_duration_ms"),
    extractionPass: integer("extraction_pass"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("receipt_ingestions_household_client_request_unique").on(
      table.householdId,
      table.clientRequestId
    ),
    uniqueIndex("receipt_ingestions_source_storage_key_unique").on(
      table.sourceStorageKey
    ),
    index("receipt_ingestions_household_status_idx").on(
      table.householdId,
      table.status,
      table.updatedAt
    ),
    index("receipt_ingestions_trip_idx").on(table.tripId),
    index("receipt_ingestions_receipt_idx").on(table.receiptTransactionId),
  ]
);

/**
 * Audit evidence for an explicitly confirmed historical receipt correction.
 * The current receipt row keeps a stable ID, while this private snapshot keeps
 * the previous authoritative values and file pointer recoverable.
 */
export const receiptCorrections = sqliteTable(
  "receipt_corrections",
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
    ingestionId: text("ingestion_id")
      .notNull()
      .references(() => receiptIngestions.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    status: text("status", { enum: ["applied", "superseded"] })
      .notNull()
      .default("applied"),
    previousReceiptJson: text("previous_receipt_json").notNull(),
    previousItemsJson: text("previous_items_json").notNull(),
    previousMatchesJson: text("previous_matches_json").notNull(),
    previousQuestionsJson: text("previous_questions_json").notNull(),
    previousUploadJson: text("previous_upload_json"),
    replacementStorageKey: text("replacement_storage_key").notNull(),
    appliedByMemberId: text("applied_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    appliedAt: text("applied_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("receipt_corrections_ingestion_unique").on(table.ingestionId),
    uniqueIndex("receipt_corrections_receipt_revision_unique").on(
      table.receiptTransactionId,
      table.revision,
    ),
    index("receipt_corrections_receipt_idx").on(
      table.receiptTransactionId,
      table.appliedAt,
    ),
    index("receipt_corrections_household_idx").on(
      table.householdId,
      table.appliedAt,
    ),
  ],
);

/**
 * Durable background work for private product reference images. Catalog
 * promotion commits first; the existing scheduled receipt Worker claims these
 * rows later so receipt finalization never waits on image generation.
 */
export const productImageJobs = sqliteTable(
  "product_image_jobs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    receiptTransactionId: text("receipt_transaction_id").references(
      () => receiptTransactions.id,
      { onDelete: "set null" },
    ),
    status: text("status", {
      enum: ["queued", "processing", "generated", "skipped", "failed"],
    })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    model: text("model"),
    errorCode: text("error_code"),
    lockedAt: text("locked_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("product_image_jobs_product_unique").on(table.productId),
    index("product_image_jobs_status_idx").on(table.status, table.updatedAt),
    index("product_image_jobs_household_status_idx").on(
      table.householdId,
      table.status,
      table.updatedAt,
    ),
    index("product_image_jobs_receipt_idx").on(table.receiptTransactionId),
  ],
);

/**
 * An idempotent, recipient-specific delivery record. A trip report is only
 * sent after confirmed receipt evidence; retries must never resend it merely
 * because a Worker execution was resumed.
 */
export const emailOutbox = sqliteTable(
  "email_outbox",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    recipientMemberId: text("recipient_member_id")
      .notNull()
      .references(() => householdMembers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["trip_summary"] })
      .notNull()
      .default("trip_summary"),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", {
      enum: ["queued", "sending", "sent", "failed", "unknown", "cancelled"],
    })
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerMessageId: text("provider_message_id"),
    lastErrorCode: text("last_error_code"),
    lockedAt: text("locked_at"),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("email_outbox_dedupe_key_unique").on(table.dedupeKey),
    index("email_outbox_household_status_idx").on(
      table.householdId,
      table.status,
      table.updatedAt
    ),
    index("email_outbox_trip_idx").on(table.tripId),
    index("email_outbox_recipient_idx").on(table.recipientMemberId),
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
      enum: ["historical", "member", "receipt"],
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

// Advisory model output is isolated from all active knowledge consumers.
export const productUnderstandingCandidates = sqliteTable(
  "product_understanding_candidates",
  {
    householdId: text("household_id").notNull().references(() => households.id, { onDelete: "cascade" }),
    lookupKey: text("lookup_key").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    proposalJson: text("proposal_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.householdId, table.lookupKey, table.promptVersion, table.schemaVersion] })],
);

export const productUnderstandings = sqliteTable(
  "product_understandings",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    lookupKey: text("lookup_key").notNull(),
    costcoItemNumber: text("costco_item_number"),
    rawDescription: text("raw_description").notNull(),
    canonicalName: text("canonical_name").notNull(),
    brand: text("brand"),
    productFamily: text("product_family"),
    variant: text("variant"),
    categoryHint: text("category_hint"),
    confidenceBps: integer("confidence_bps").notNull(),
    exactSkuKnown: integer("exact_sku_known", { mode: "boolean" })
      .notNull()
      .default(false),
    searchAliasesJson: text("search_aliases_json").notNull().default("[]"),
    intentAliasesJson: text("intent_aliases_json").notNull().default("[]"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("product_understandings_household_lookup_unique").on(
      table.householdId,
      table.lookupKey
    ),
    index("product_understandings_item_number_idx").on(
      table.householdId,
      table.costcoItemNumber
    ),
  ]
);

export const intentFulfillments = sqliteTable(
  "intent_fulfillments",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    intentKey: text("intent_key").notNull(),
    receiptKey: text("receipt_key").notNull(),
    rawIntentLabel: text("raw_intent_label").notNull(),
    rawReceiptDescription: text("raw_receipt_description").notNull(),
    costcoItemNumber: text("costco_item_number"),
    relation: text("relation", {
      enum: ["same_product", "fulfills_intent", "substitute", "not_same"],
    })
      .notNull(),
    confidenceBps: integer("confidence_bps").notNull().default(10000),
    confirmedByMemberId: text("confirmed_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("intent_fulfillments_household_pair_unique").on(
      table.householdId,
      table.intentKey,
      table.receiptKey
    ),
    index("intent_fulfillments_household_intent_idx").on(
      table.householdId,
      table.intentKey
    ),
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
        "confirmed_intent",
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
    answerClaimToken: text("answer_claim_token"),
    answerClaimedAt: text("answer_claimed_at"),
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

export const recommendationShadowRuns = sqliteTable(
  "recommendation_shadow_runs",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    asOfDate: text("as_of_date").notNull(),
    engineVersion: text("engine_version").notNull(),
    mode: text("mode", { enum: ["backtest", "live_shadow"] }).notNull(),
    attentionBudget: integer("attention_budget").notNull(),
    catalogSize: integer("catalog_size").notNull(),
    eligibleCount: integer("eligible_count").notNull(),
    metricsJson: text("metrics_json").notNull(),
    createdByMemberId: text("created_by_member_id").references(
      () => householdMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("recommendation_shadow_runs_household_cycle_unique").on(
      table.householdId,
      table.asOfDate,
      table.engineVersion,
      table.mode,
    ),
    index("recommendation_shadow_runs_household_created_idx").on(
      table.householdId,
      table.createdAt,
    ),
  ],
);

export const recommendationShadowCandidates = sqliteTable(
  "recommendation_shadow_candidates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => recommendationShadowRuns.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    rank: integer("rank"),
    scoreBps: integer("score_bps").notNull(),
    eligible: integer("eligible", { mode: "boolean" }).notNull(),
    selected: integer("selected", { mode: "boolean" }).notNull(),
    productState: text("product_state").notNull(),
    reason: text("reason").notNull(),
    componentsJson: text("components_json").notNull(),
    createdAt: text("created_at").notNull().default(timestampDefault),
  },
  (table) => [
    uniqueIndex("recommendation_shadow_candidates_run_product_unique").on(
      table.runId,
      table.productId,
    ),
    index("recommendation_shadow_candidates_run_rank_idx").on(
      table.runId,
      table.rank,
    ),
  ],
);

export const basketSenseSchemaMigrations = sqliteTable(
  "basketsense_schema_migrations",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: ["applying", "completed", "failed"] })
      .notNull(),
    startedAt: text("started_at").notNull().default(timestampDefault),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(timestampDefault),
  }
);

export type Household = typeof households.$inferSelect;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type Trip = typeof trips.$inferSelect;
export type TripListItem = typeof tripListItems.$inferSelect;
export type ReceiptTransaction = typeof receiptTransactions.$inferSelect;
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type TripIntentSnapshot = typeof tripIntentSnapshots.$inferSelect;
export type TripIntentItem = typeof tripIntentItems.$inferSelect;
export type ReceiptUpload = typeof receiptUploads.$inferSelect;
export type ReceiptIngestion = typeof receiptIngestions.$inferSelect;
export type ReceiptCorrection = typeof receiptCorrections.$inferSelect;
export type ProductImageJob = typeof productImageJobs.$inferSelect;
export type EmailOutbox = typeof emailOutbox.$inferSelect;
export type ProductAlias = typeof productAliases.$inferSelect;
export type ProductUnderstanding = typeof productUnderstandings.$inferSelect;
export type IntentFulfillment = typeof intentFulfillments.$inferSelect;
export type TripItemMatch = typeof tripItemMatches.$inferSelect;
export type ReviewQuestion = typeof reviewQuestions.$inferSelect;
export type RecommendationShadowRun = typeof recommendationShadowRuns.$inferSelect;
export type RecommendationShadowCandidate = typeof recommendationShadowCandidates.$inferSelect;
export type BasketSenseSchemaMigration =
  typeof basketSenseSchemaMigrations.$inferSelect;
