import {
  AUDITED_RECEIPT_ITEMS_2026,
  AUDITED_RECEIPT_TRANSACTIONS_2026,
  RECURRING_PRODUCT_HISTORIES_2026,
} from "../../basketsense-data";
import { ensureBasketSenseSchemaUpgrades } from "../../database-schema-upgrades";
import { buildSaturdayRecommendations } from "../../recommendation-engine";
import {
  isProductMemoryPreference,
  productMemorySuppressesSuggestion,
  type ProductMemoryPreference,
} from "../../product-memory";
import {
  classifyReceiptItem,
  type ClassificationStatus,
  type ProductCategoryKey,
} from "../../product-categories";
import {
  matchReceiptItemsToIntent,
  normalizeReceiptDescription,
  reconcileReceipt,
  type ConfirmedProductAlias,
  type MatchableReceiptItem,
  type ReceiptIntentItem,
  type ReceiptIntentMatch,
} from "../../receipt-logic";
import {
  buildDashboardViewStateFromD1,
  dashboardHistoryRevisionStatement,
} from "../../dashboard-d1-data";

import type {
  ClosedLoopComparison,
  ClosedLoopReceiptItem,
  ClosedLoopReview,
  DataHealthFailedImport,
  DataHealthProduct,
  DataHealthReceipt,
  DataHealthRecommendationEvent,
  DataHealthResponse,
  DataHealthReviewQuestion,
  DataHealthTableCount,
  DataHealthTrip,
  DataHealthUnmatchedLine,
  FeedbackKind,
  FeedbackSummary,
  HouseholdBootstrapResponse,
  HouseholdCoreResponse,
  HouseholdListResponse,
  HouseholdMemberSummary,
  HouseholdPatchRequest,
  HouseholdPostRequest,
  ListItemSection,
  ListItemSource,
  ProductSummary,
  ReceiptTransactionSummary,
  ReviewQuestionOptionSummary,
  ReviewQuestionPurpose,
  ReviewQuestionSummary,
  TripIntentItemSummary,
  TripItemMatchSummary,
  TripListItemSummary,
  TripReviewHistoryEntry,
  TripStatus,
  TripSummary,
} from "./types";

export const dynamic = "force-dynamic";

const HOUSEHOLD_ID = "household_basketsense";
const HOUSEHOLD_SLUG = "basket-sense-household";
const HOUSEHOLD_NAME = "BasketSense household";
// This is deliberately a second household record in the existing private D1
// database, not a new Cloudflare resource. It is never seeded with the shared
// household's audited history and has exactly one member: the current owner.
const SANDBOX_HOUSEHOLD_ID = "household_basketsense_owner_sandbox";
const SANDBOX_HOUSEHOLD_SLUG = "basket-sense-owner-sandbox";
const SANDBOX_HOUSEHOLD_NAME = "BasketSense owner-only test sandbox";
const HOUSEHOLD_TIME_ZONE = "America/Los_Angeles";
const PRODUCT_CATALOG_REVISION = "audited-2026-07-18-v2";

const REVIEWABLE_PRODUCT_CATEGORIES = new Set<ProductCategoryKey>([
  "groceries_beverages",
  "clothing_accessories",
  "household_supplies",
  "health_personal_care",
  "home_kitchen_seasonal",
  "toys_books_activities",
  "automotive_tires",
  "jewelry_precious_metals",
]);

const LIST_ITEM_SOURCES = new Set<ListItemSource>([
  "manual",
  "recurring",
  "predicted",
  "consider",
  "in_store",
]);

const LIST_ITEM_SECTIONS = new Set<ListItemSection>([
  "essentials",
  "suggested",
  "check_first",
  "consider",
]);

const FEEDBACK_KINDS = new Set<FeedbackKind>([
  "trip_enjoyment",
  "recommendation_response",
  "discovery_outcome",
  "duplicate_signal",
  "waste_signal",
  "regret_signal",
  "receipt_correction",
  "fulfillment_reason",
  "product_experience",
]);

// Each entry is deliberately one SQL statement. D1 receives each entry through
// its own prepare() call, including when the statements are executed as a batch.
const RUNTIME_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    time_zone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS households_slug_unique
    ON households (slug)`,
  `CREATE TABLE IF NOT EXISTS household_members (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS household_members_household_email_unique
    ON household_members (household_id, user_email)`,
  `CREATE INDEX IF NOT EXISTS household_members_household_idx
    ON household_members (household_id)`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    costco_item_number TEXT,
    canonical_name TEXT NOT NULL,
    category TEXT,
    category_status TEXT NOT NULL DEFAULT 'needs_review',
    category_reviewed_at TEXT,
    category_reviewed_by_member_id TEXT,
    catalog_revision TEXT,
    brand TEXT,
    unit_description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (category_reviewed_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS products_household_item_number_unique
    ON products (household_id, costco_item_number)`,
  `CREATE INDEX IF NOT EXISTS products_household_name_idx
    ON products (household_id, canonical_name)`,
  `CREATE INDEX IF NOT EXISTS products_household_category_status_idx
    ON products (household_id, category_status)`,
  `CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_page_url TEXT,
    source_image_url TEXT,
    source_external_id TEXT,
    source_product_name TEXT,
    source_brand TEXT,
    source_quantity TEXT,
    storage_key TEXT,
    attribution_text TEXT,
    license_code TEXT,
    confidence_bps INTEGER,
    status TEXT NOT NULL DEFAULT 'candidate',
    is_primary INTEGER NOT NULL DEFAULT 0,
    width_px INTEGER,
    height_px INTEGER,
    content_type TEXT,
    byte_size INTEGER,
    content_sha256 TEXT,
    created_by_member_id TEXT,
    reviewed_by_member_id TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_product_source_unique
    ON product_images (product_id, source_image_url)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_storage_key_unique
    ON product_images (storage_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_images_product_primary_unique
    ON product_images (product_id)
    WHERE is_primary = 1 AND status = 'approved'`,
  `CREATE INDEX IF NOT EXISTS product_images_household_status_idx
    ON product_images (household_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS product_images_product_status_idx
    ON product_images (product_id, status, is_primary)`,
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    list_revision INTEGER NOT NULL DEFAULT 0,
    target_cents INTEGER,
    discovery_allowance_cents INTEGER,
    estimated_list_total_at_freeze_cents INTEGER,
    estimated_priced_item_count_at_freeze INTEGER,
    estimated_unpriced_item_count_at_freeze INTEGER,
    frozen_at TEXT,
    completed_at TEXT,
    created_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trips_household_scheduled_for_unique
    ON trips (household_id, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS trips_household_status_idx
    ON trips (household_id, status)`,
  `CREATE TABLE IF NOT EXISTS trip_list_items (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT NOT NULL,
    product_id TEXT,
    label TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT 'essentials',
    source TEXT NOT NULL DEFAULT 'manual',
    recommendation_reason TEXT,
    confidence_bps INTEGER,
    included INTEGER NOT NULL DEFAULT 1,
    checked INTEGER NOT NULL DEFAULT 0,
    included_at_freeze INTEGER,
    added_after_freeze INTEGER NOT NULL DEFAULT 0,
    estimated_price_cents INTEGER,
    quantity_milli INTEGER NOT NULL DEFAULT 1000,
    sort_order INTEGER NOT NULL DEFAULT 0,
    list_revision INTEGER NOT NULL DEFAULT 0,
    added_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    FOREIGN KEY (added_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS trip_list_items_trip_sort_idx
    ON trip_list_items (trip_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS trip_list_items_product_idx
    ON trip_list_items (product_id)`,
  `CREATE TRIGGER IF NOT EXISTS trip_list_items_revision_after_insert
    AFTER INSERT ON trip_list_items
    BEGIN
      UPDATE trips
      SET list_revision = list_revision + 1
      WHERE id = NEW.trip_id;
      UPDATE trip_list_items
      SET list_revision = (
        SELECT list_revision FROM trips WHERE id = NEW.trip_id
      )
      WHERE id = NEW.id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS trip_list_items_revision_after_update
    AFTER UPDATE OF
      product_id, label, section, source, recommendation_reason,
      confidence_bps, included, checked, included_at_freeze,
      added_after_freeze, estimated_price_cents, quantity_milli,
      sort_order, added_by_member_id
    ON trip_list_items
    BEGIN
      UPDATE trips
      SET list_revision = list_revision + 1
      WHERE id = NEW.trip_id;
      UPDATE trip_list_items
      SET list_revision = (
        SELECT list_revision FROM trips WHERE id = NEW.trip_id
      )
      WHERE id = NEW.id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS trip_list_items_revision_after_delete
    AFTER DELETE ON trip_list_items
    BEGIN
      UPDATE trips
      SET list_revision = list_revision + 1
      WHERE id = OLD.trip_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS trips_list_revision_after_state_update
    AFTER UPDATE OF
      status, target_cents, discovery_allowance_cents,
      estimated_list_total_at_freeze_cents,
      estimated_priced_item_count_at_freeze,
      estimated_unpriced_item_count_at_freeze,
      frozen_at, completed_at
    ON trips
    BEGIN
      UPDATE trips
      SET list_revision = list_revision + 1
      WHERE id = NEW.id;
    END`,
  `CREATE TABLE IF NOT EXISTS receipt_transactions (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT,
    source_transaction_key TEXT NOT NULL,
    transaction_type TEXT NOT NULL DEFAULT 'warehouse',
    source_type TEXT NOT NULL,
    purchased_at TEXT NOT NULL,
    item_gross_cents INTEGER NOT NULL,
    item_count INTEGER NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL,
    household_funded_cents INTEGER NOT NULL,
    external_funding_cents INTEGER NOT NULL DEFAULT 0,
    audit_flag TEXT NOT NULL DEFAULT 'none',
    parse_status TEXT NOT NULL DEFAULT 'needs_review',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_transactions_household_source_key_unique
    ON receipt_transactions (household_id, source_transaction_key)`,
  `CREATE INDEX IF NOT EXISTS receipt_transactions_household_purchased_idx
    ON receipt_transactions (household_id, purchased_at)`,
  `CREATE INDEX IF NOT EXISTS receipt_transactions_trip_idx
    ON receipt_transactions (trip_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_transactions_household_trip_photo_unique
    ON receipt_transactions (household_id, trip_id)
    WHERE source_type = 'receipt_photo'`,
  `CREATE TABLE IF NOT EXISTS receipt_items (
    id TEXT PRIMARY KEY NOT NULL,
    receipt_transaction_id TEXT NOT NULL,
    product_id TEXT,
    source_line_number INTEGER NOT NULL,
    costco_item_number TEXT,
    raw_description TEXT NOT NULL,
    quantity_milli INTEGER NOT NULL DEFAULT 1000,
    unit_price_cents INTEGER,
    unit_price_mills INTEGER,
    line_subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    net_amount_cents INTEGER NOT NULL,
    tax_status TEXT NOT NULL,
    normalization_status TEXT NOT NULL,
    is_return INTEGER NOT NULL DEFAULT 0,
    match_confidence_bps INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_items_transaction_line_unique
    ON receipt_items (receipt_transaction_id, source_line_number)`,
  `CREATE INDEX IF NOT EXISTS receipt_items_product_idx
    ON receipt_items (product_id)`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT,
    receipt_transaction_id TEXT,
    list_item_id TEXT,
    receipt_item_id TEXT,
    product_id TEXT,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    rating INTEGER,
    note TEXT,
    created_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (list_item_id) REFERENCES trip_list_items(id) ON DELETE SET NULL,
    FOREIGN KEY (receipt_item_id) REFERENCES receipt_items(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS feedback_household_created_idx
    ON feedback (household_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS feedback_trip_idx
    ON feedback (trip_id)`,
  `CREATE INDEX IF NOT EXISTS feedback_receipt_transaction_idx
    ON feedback (receipt_transaction_id)`,
  `CREATE INDEX IF NOT EXISTS feedback_receipt_item_idx
    ON feedback (receipt_item_id)`,
  `CREATE INDEX IF NOT EXISTS feedback_product_idx
    ON feedback (product_id)`,
  `CREATE TABLE IF NOT EXISTS trip_intent_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT NOT NULL,
    evidence_level TEXT NOT NULL,
    estimated_total_cents INTEGER NOT NULL DEFAULT 0,
    priced_item_count INTEGER NOT NULL DEFAULT 0,
    unpriced_item_count INTEGER NOT NULL DEFAULT 0,
    captured_by_member_id TEXT,
    captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (captured_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trip_intent_snapshots_trip_unique
    ON trip_intent_snapshots (trip_id)`,
  `CREATE INDEX IF NOT EXISTS trip_intent_snapshots_evidence_idx
    ON trip_intent_snapshots (evidence_level)`,
  `CREATE TABLE IF NOT EXISTS trip_intent_items (
    id TEXT PRIMARY KEY NOT NULL,
    snapshot_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    list_item_id TEXT,
    product_id TEXT,
    label TEXT NOT NULL,
    section TEXT NOT NULL,
    source TEXT NOT NULL,
    recommendation_reason TEXT,
    confidence_bps INTEGER,
    included INTEGER NOT NULL,
    quantity_milli INTEGER NOT NULL DEFAULT 1000,
    estimated_price_cents INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (snapshot_id) REFERENCES trip_intent_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (list_item_id) REFERENCES trip_list_items(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trip_intent_items_snapshot_list_unique
    ON trip_intent_items (snapshot_id, list_item_id)`,
  `CREATE INDEX IF NOT EXISTS trip_intent_items_trip_sort_idx
    ON trip_intent_items (trip_id, sort_order)`,
  `CREATE INDEX IF NOT EXISTS trip_intent_items_product_idx
    ON trip_intent_items (product_id)`,
  `CREATE TABLE IF NOT EXISTS receipt_uploads (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    receipt_transaction_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'stored',
    uploaded_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_receipt_unique
    ON receipt_uploads (receipt_transaction_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_uploads_storage_key_unique
    ON receipt_uploads (storage_key)`,
  `CREATE INDEX IF NOT EXISTS receipt_uploads_household_idx
    ON receipt_uploads (household_id)`,
  `CREATE TABLE IF NOT EXISTS receipt_ingestions (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT,
    requested_by_member_id TEXT,
    client_request_id TEXT NOT NULL,
    source_storage_key TEXT NOT NULL,
    source_sha256 TEXT,
    source_content_type TEXT NOT NULL,
    source_byte_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    revision INTEGER NOT NULL DEFAULT 1,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    workflow_instance_id TEXT,
    provider TEXT,
    model TEXT,
    prompt_version TEXT,
    schema_version TEXT,
    recovery_manifest_key TEXT,
    extraction_artifact_key TEXT,
    receipt_transaction_id TEXT,
    error_code TEXT,
    provider_response_id TEXT,
    provider_finish_reason TEXT,
    provider_duration_ms INTEGER,
    extraction_pass INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_ingestions_household_request_unique
    ON receipt_ingestions (household_id, client_request_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_ingestions_source_key_unique
    ON receipt_ingestions (source_storage_key)`,
  `CREATE INDEX IF NOT EXISTS receipt_ingestions_household_status_idx
    ON receipt_ingestions (household_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS receipt_ingestions_trip_idx
    ON receipt_ingestions (trip_id)`,
  `CREATE INDEX IF NOT EXISTS receipt_ingestions_receipt_idx
    ON receipt_ingestions (receipt_transaction_id)`,
  `CREATE TABLE IF NOT EXISTS receipt_corrections (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    receipt_transaction_id TEXT NOT NULL,
    ingestion_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    previous_receipt_json TEXT NOT NULL,
    previous_items_json TEXT NOT NULL,
    previous_matches_json TEXT NOT NULL,
    previous_questions_json TEXT NOT NULL,
    previous_upload_json TEXT,
    replacement_storage_key TEXT NOT NULL,
    applied_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (ingestion_id) REFERENCES receipt_ingestions(id) ON DELETE RESTRICT,
    FOREIGN KEY (applied_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_corrections_ingestion_unique
    ON receipt_corrections (ingestion_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS receipt_corrections_receipt_revision_unique
    ON receipt_corrections (receipt_transaction_id, revision)`,
  `CREATE INDEX IF NOT EXISTS receipt_corrections_receipt_idx
    ON receipt_corrections (receipt_transaction_id, applied_at)`,
  `CREATE INDEX IF NOT EXISTS receipt_corrections_household_idx
    ON receipt_corrections (household_id, applied_at)`,
  `CREATE TABLE IF NOT EXISTS product_image_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    receipt_transaction_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    error_code TEXT,
    locked_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_image_jobs_product_unique
    ON product_image_jobs (product_id)`,
  `CREATE INDEX IF NOT EXISTS product_image_jobs_status_idx
    ON product_image_jobs (status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS product_image_jobs_household_status_idx
    ON product_image_jobs (household_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS product_image_jobs_receipt_idx
    ON product_image_jobs (receipt_transaction_id)`,
  `CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    recipient_member_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'trip_summary',
    dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    last_error_code TEXT,
    locked_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_member_id) REFERENCES household_members(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_key_unique
    ON email_outbox (dedupe_key)`,
  `CREATE INDEX IF NOT EXISTS email_outbox_household_status_idx
    ON email_outbox (household_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS email_outbox_trip_idx
    ON email_outbox (trip_id)`,
  `CREATE INDEX IF NOT EXISTS email_outbox_recipient_idx
    ON email_outbox (recipient_member_id)`,
  `CREATE TABLE IF NOT EXISTS product_aliases (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    raw_description TEXT NOT NULL,
    normalized_description TEXT NOT NULL,
    costco_item_number TEXT,
    product_id TEXT NOT NULL,
    confirmation_source TEXT NOT NULL,
    confirmed_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (confirmed_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_aliases_household_key_unique
    ON product_aliases (household_id, alias_key)`,
  `CREATE INDEX IF NOT EXISTS product_aliases_product_idx
    ON product_aliases (product_id)`,
  `CREATE TABLE IF NOT EXISTS trip_item_matches (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    receipt_transaction_id TEXT NOT NULL,
    intent_item_id TEXT NOT NULL,
    receipt_item_id TEXT NOT NULL,
    match_type TEXT NOT NULL,
    confidence_bps INTEGER NOT NULL,
    resolution_source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (intent_item_id) REFERENCES trip_intent_items(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_item_id) REFERENCES receipt_items(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trip_item_matches_receipt_item_unique
    ON trip_item_matches (receipt_item_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trip_item_matches_intent_item_unique
    ON trip_item_matches (intent_item_id)`,
  `CREATE INDEX IF NOT EXISTS trip_item_matches_receipt_idx
    ON trip_item_matches (receipt_transaction_id)`,
  `CREATE INDEX IF NOT EXISTS trip_item_matches_trip_idx
    ON trip_item_matches (trip_id)`,
  `CREATE TABLE IF NOT EXISTS review_questions (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    receipt_transaction_id TEXT NOT NULL,
    question_key TEXT NOT NULL,
    purpose TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    declared_effect TEXT NOT NULL,
    effect_target TEXT,
    list_item_id TEXT,
    intent_item_id TEXT,
    receipt_item_id TEXT,
    priority INTEGER NOT NULL DEFAULT 100,
    status TEXT NOT NULL DEFAULT 'open',
    answer_value TEXT,
    answer_note TEXT,
    answered_by_member_id TEXT,
    answered_at TEXT,
    answer_claim_token TEXT,
    answer_claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (list_item_id) REFERENCES trip_list_items(id) ON DELETE SET NULL,
    FOREIGN KEY (intent_item_id) REFERENCES trip_intent_items(id) ON DELETE SET NULL,
    FOREIGN KEY (receipt_item_id) REFERENCES receipt_items(id) ON DELETE SET NULL,
    FOREIGN KEY (answered_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS review_questions_receipt_key_unique
    ON review_questions (receipt_transaction_id, question_key)`,
  `CREATE INDEX IF NOT EXISTS review_questions_receipt_status_idx
    ON review_questions (receipt_transaction_id, status, priority)`,
  `CREATE INDEX IF NOT EXISTS review_questions_household_idx
    ON review_questions (household_id)`,
] as const;

interface AuthenticatedUser {
  email: string;
  displayName: string;
}

interface HouseholdRow {
  id: string;
  slug: string;
  name: string;
  time_zone: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  id: string;
  household_id: string;
  user_email: string;
  display_name: string;
  role: "owner" | "member";
  created_at: string;
  last_seen_at: string;
}

interface TripRow {
  id: string;
  household_id: string;
  scheduled_for: string;
  status: TripStatus;
  list_revision: number;
  target_cents: number | null;
  discovery_allowance_cents: number | null;
  estimated_list_total_at_freeze_cents: number | null;
  estimated_priced_item_count_at_freeze: number | null;
  estimated_unpriced_item_count_at_freeze: number | null;
  frozen_at: string | null;
  completed_at: string | null;
  created_by_member_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  trip_id: string;
  product_id: string | null;
  label: string;
  section: ListItemSection;
  source: ListItemSource;
  recommendation_reason: string | null;
  confidence_bps: number | null;
  included: number;
  checked: number;
  included_at_freeze: number | null;
  added_after_freeze: number;
  estimated_price_cents: number | null;
  quantity_milli: number;
  sort_order: number;
  list_revision: number;
  added_by_member_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TripListEstimateRow {
  estimated_total_cents: number;
  priced_item_count: number;
  unpriced_item_count: number;
}

interface AuthorizedListItemRow extends ListItemRow {
  trip_status: TripStatus;
  household_id: string;
}

interface ProductRow {
  id: string;
  household_id: string;
  costco_item_number: string | null;
  canonical_name: string;
  category: string | null;
  category_status: ClassificationStatus;
  category_reviewed_at: string | null;
  category_reviewed_by_member_id: string | null;
  catalog_revision: string | null;
  brand: string | null;
  unit_description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  category_reviewed_by_display_name?: string | null;
  latest_raw_description?: string | null;
  latest_purchased_at?: string | null;
  latest_regular_unit_price_cents?: number | null;
  latest_paid_unit_price_cents?: number | null;
  latest_discount_unit_cents?: number | null;
  receipt_purchase_count?: number | null;
  memory_preference?: ProductMemoryPreference | null;
  memory_note?: string | null;
  memory_updated_at?: string | null;
  memory_source_purchased_at?: string | null;
  image_id?: string | null;
  image_source_type?:
    | "household_upload"
    | "ai_generated"
    | "open_food_facts"
    | "manufacturer"
    | null;
  image_source_page_url?: string | null;
  image_attribution_text?: string | null;
  image_license_code?: string | null;
  image_updated_at?: string | null;
}

interface ReceiptTransactionRow {
  id: string;
  household_id: string;
  trip_id: string | null;
  source_transaction_key: string;
  transaction_type: "warehouse" | "fuel" | "optical" | "return";
  source_type: "digital_receipt" | "fuel_receipt" | "receipt_photo";
  purchased_at: string;
  item_gross_cents: number;
  item_count: number;
  subtotal_cents: number;
  tax_cents: number;
  discount_cents: number;
  total_cents: number;
  household_funded_cents: number;
  external_funding_cents: number;
  audit_flag: string;
  parse_status: "needs_review" | "reconciled" | "rejected";
  created_at: string;
  updated_at: string;
}

interface ReceiptItemRow {
  id: string;
  receipt_transaction_id: string;
  product_id: string | null;
  source_line_number: number;
  costco_item_number: string | null;
  raw_description: string;
  quantity_milli: number;
  unit_price_cents: number | null;
  unit_price_mills: number | null;
  line_subtotal_cents: number;
  discount_cents: number;
  net_amount_cents: number;
  tax_status: "taxable" | "non_taxable" | "unknown";
  normalization_status:
    | "receipt_abbreviation"
    | "normalized_from_history";
  is_return: number;
  match_confidence_bps: number | null;
  created_at: string;
  updated_at: string;
  canonical_name?: string | null;
  category?: string | null;
}

interface IntentSnapshotRow {
  id: string;
  trip_id: string;
  evidence_level: "pre_trip" | "upload_fallback";
  estimated_total_cents: number;
  priced_item_count: number;
  unpriced_item_count: number;
  captured_by_member_id: string | null;
  captured_at: string;
  created_at: string;
}

interface IntentItemRow {
  id: string;
  snapshot_id: string;
  trip_id: string;
  list_item_id: string | null;
  product_id: string | null;
  label: string;
  section: ListItemSection;
  source: ListItemSource;
  recommendation_reason: string | null;
  confidence_bps: number | null;
  included: number;
  quantity_milli: number;
  estimated_price_cents: number | null;
  sort_order: number;
  created_at: string;
  costco_item_number?: string | null;
  product_category?: string | null;
}

interface ProductAliasRow {
  id: string;
  household_id: string;
  alias_key: string;
  raw_description: string;
  normalized_description: string;
  costco_item_number: string | null;
  product_id: string;
  confirmation_source: "historical" | "member" | "receipt";
}

interface TripItemMatchRow {
  id: string;
  household_id: string;
  trip_id: string;
  receipt_transaction_id: string;
  intent_item_id: string;
  receipt_item_id: string;
  match_type:
    | "exact_item_number"
    | "exact_product"
    | "confirmed_alias"
    | "exact_name"
    | "member_confirmed";
  confidence_bps: number;
  resolution_source: "system" | "member";
  created_at: string;
  updated_at: string;
}

interface ReviewQuestionRow {
  id: string;
  household_id: string;
  trip_id: string;
  receipt_transaction_id: string;
  question_key: string;
  purpose: ReviewQuestionPurpose;
  prompt: string;
  options_json: string;
  declared_effect: string;
  effect_target: string | null;
  list_item_id: string | null;
  intent_item_id: string | null;
  receipt_item_id: string | null;
  product_id: string | null;
  priority: number;
  status: "open" | "answered" | "dismissed";
  answer_value: string | null;
  answer_note: string | null;
  answered_by_member_id: string | null;
  answered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptUploadRow {
  id: string;
  household_id: string;
  receipt_transaction_id: string;
  storage_key: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  status: "stored" | "replaced" | "deleted";
  uploaded_by_member_id: string | null;
  created_at: string;
  updated_at: string;
}

interface FeedbackRow {
  id: string;
  household_id: string;
  trip_id: string | null;
  receipt_transaction_id: string | null;
  list_item_id: string | null;
  receipt_item_id: string | null;
  product_id: string | null;
  kind: FeedbackKind;
  value: string;
  rating: number | null;
  note: string | null;
  created_by_member_id: string | null;
  created_at: string;
}

interface ReceiptItemOwnershipRow {
  id: string;
  trip_id: string | null;
}

interface HouseholdContext {
  household: HouseholdRow;
  member: MemberRow;
  currentTrip: TripRow;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const schemaInitializations = new WeakMap<D1Database, Promise<void>>();

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

async function getD1() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new ApiError(503, "Household storage is unavailable");
  }

  return env.DB;
}

async function ensureSchema(db: D1Database) {
  const existing = schemaInitializations.get(db);
  if (existing) {
    await existing;
    return;
  }

  const initialization = ensureBasketSenseSchemaUpgrades(db)
    .then(() =>
      db.batch(RUNTIME_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement))),
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaInitializations.delete(db);
      throw error;
    });

  schemaInitializations.set(db, initialization);
  await initialization;
}

async function ensureReadableSchema(db: D1Database) {
  await ensureBasketSenseSchemaUpgrades(db);
  try {
    await db.prepare("SELECT 1 FROM households LIMIT 1").first();
    await db.prepare("SELECT 1 FROM product_images LIMIT 1").first();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table:\s*(?:households|product_images)/i.test(message)) {
      throw error;
    }
    await ensureSchema(db);
  }
}

const SEED_BATCH_SIZE = 75;

function productIdFor(itemNumber: string) {
  return `product-${itemNumber}`;
}

async function runPreparedInChunks(
  db: D1Database,
  statements: D1PreparedStatement[]
) {
  for (let index = 0; index < statements.length; index += SEED_BATCH_SIZE) {
    await db.batch(statements.slice(index, index + SEED_BATCH_SIZE));
  }
}

async function seedAuditedHistory(db: D1Database, householdId: string) {
  const productByItemNumber = new Map<string, string>();
  for (const item of AUDITED_RECEIPT_ITEMS_2026) {
    if (!productByItemNumber.has(item.itemNumber)) {
      productByItemNumber.set(item.itemNumber, productIdFor(item.itemNumber));
    }
  }
  const transactionById = new Map(
    AUDITED_RECEIPT_TRANSACTIONS_2026.map((transaction) => [
      transaction.id,
      transaction,
    ])
  );

  const requiredTransactionIds = AUDITED_RECEIPT_TRANSACTIONS_2026.map(
    (transaction) => transaction.id,
  );
  const requiredItemIds = AUDITED_RECEIPT_ITEMS_2026.map((item) => item.id);
  const requiredProductIds = [...productByItemNumber.values()];
  const [transactionSeedCount, itemSeedCount, currentCatalogSeedCount] =
    await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_transactions
           WHERE household_id = ?
             AND id IN (SELECT value FROM json_each(?))`,
        )
        .bind(householdId, JSON.stringify(requiredTransactionIds))
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_items
           WHERE receipt_transaction_id IN (
             SELECT id FROM receipt_transactions WHERE household_id = ?
           )
             AND id IN (SELECT value FROM json_each(?))`,
        )
        .bind(householdId, JSON.stringify(requiredItemIds))
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM products
           WHERE household_id = ?
             AND catalog_revision = ?
             AND id IN (SELECT value FROM json_each(?))`,
        )
        .bind(
          householdId,
          PRODUCT_CATALOG_REVISION,
          JSON.stringify(requiredProductIds),
        )
        .first<{ count: number }>(),
    ]);

  const now = nowIso();
  if ((currentCatalogSeedCount?.count ?? 0) !== requiredProductIds.length) {
    const productStatements: D1PreparedStatement[] = [];
    const seenProducts = new Set<string>();

    for (const item of AUDITED_RECEIPT_ITEMS_2026) {
      if (seenProducts.has(item.itemNumber)) continue;
      seenProducts.add(item.itemNumber);
      const transaction = transactionById.get(item.transactionId);
      if (!transaction) {
        throw new ApiError(500, `Missing audited transaction ${item.transactionId}`);
      }
      const classification = classifyReceiptItem({
        channel: transaction.category,
        itemNumber: item.itemNumber,
        rawDescription: item.rawDescription,
        canonicalName: item.canonicalName,
        taxStatus: item.taxStatus,
      });
      productStatements.push(
        db
          .prepare(
            `INSERT INTO products (
              id, household_id, costco_item_number, canonical_name,
              category, category_status, catalog_revision,
              active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              canonical_name = CASE
                WHEN products.category_reviewed_at IS NOT NULL
                  THEN products.canonical_name
                ELSE excluded.canonical_name
              END,
              category = CASE
                WHEN products.category_reviewed_at IS NOT NULL
                  THEN products.category
                ELSE excluded.category
              END,
              category_status = CASE
                WHEN products.category_reviewed_at IS NOT NULL
                  THEN 'reviewed'
                ELSE excluded.category_status
              END,
              catalog_revision = excluded.catalog_revision,
              updated_at = excluded.updated_at`
          )
          .bind(
            productIdFor(item.itemNumber),
            householdId,
            item.itemNumber,
            item.canonicalName,
            classification.key,
            classification.status,
            PRODUCT_CATALOG_REVISION,
            now,
            now
          )
      );
    }
    await runPreparedInChunks(db, productStatements);
  }

  if (
    transactionSeedCount?.count === requiredTransactionIds.length &&
    itemSeedCount?.count === requiredItemIds.length
  ) {
    return;
  }

  const transactionStatements = AUDITED_RECEIPT_TRANSACTIONS_2026.map(
    (transaction) =>
      db
        .prepare(
          `INSERT INTO receipt_transactions (
            id, household_id, trip_id, source_transaction_key,
            transaction_type, source_type, purchased_at, item_gross_cents,
            item_count, subtotal_cents, tax_cents, discount_cents, total_cents,
            household_funded_cents, external_funding_cents, audit_flag,
            parse_status, created_at, updated_at
          ) VALUES (
            ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'reconciled', ?, ?
          )
          ON CONFLICT(id) DO UPDATE SET
            item_gross_cents = excluded.item_gross_cents,
            item_count = excluded.item_count,
            subtotal_cents = excluded.subtotal_cents,
            tax_cents = excluded.tax_cents,
            discount_cents = excluded.discount_cents,
            total_cents = excluded.total_cents,
            household_funded_cents = excluded.household_funded_cents,
            external_funding_cents = excluded.external_funding_cents,
            audit_flag = excluded.audit_flag,
            parse_status = 'reconciled',
            updated_at = excluded.updated_at`
        )
        .bind(
          transaction.id,
          householdId,
          transaction.id,
          transaction.category === "gas" ? "fuel" : transaction.category,
          transaction.sourceType,
          `${transaction.purchasedOn}T12:00:00.000Z`,
          transaction.itemGrossCents,
          transaction.itemCount,
          transaction.subtotalCents,
          transaction.taxCents,
          transaction.discountCents,
          transaction.receiptTotalCents,
          transaction.householdFundedCents,
          transaction.externalFundingCents,
          transaction.auditFlag,
          now,
          now
        )
  );
  await runPreparedInChunks(db, transactionStatements);

  const lineNumberByTransaction = new Map<string, number>();
  const itemStatements = AUDITED_RECEIPT_ITEMS_2026.map((item) => {
    const sourceLineNumber =
      (lineNumberByTransaction.get(item.transactionId) ?? 0) + 1;
    lineNumberByTransaction.set(item.transactionId, sourceLineNumber);
    const unitPriceCents =
      item.unitPriceCents === null ? null : Math.round(item.unitPriceCents);

    return db
      .prepare(
        `INSERT INTO receipt_items (
          id, receipt_transaction_id, product_id, source_line_number,
          costco_item_number, raw_description, quantity_milli,
          unit_price_cents, unit_price_mills, line_subtotal_cents,
          discount_cents, net_amount_cents, tax_status,
          normalization_status, is_return, match_confidence_bps,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          product_id = excluded.product_id,
          raw_description = excluded.raw_description,
          quantity_milli = excluded.quantity_milli,
          unit_price_cents = excluded.unit_price_cents,
          unit_price_mills = excluded.unit_price_mills,
          line_subtotal_cents = excluded.line_subtotal_cents,
          discount_cents = excluded.discount_cents,
          net_amount_cents = excluded.net_amount_cents,
          tax_status = excluded.tax_status,
          normalization_status = excluded.normalization_status,
          updated_at = excluded.updated_at`
      )
      .bind(
        item.id,
        item.transactionId,
        productByItemNumber.get(item.itemNumber) ?? null,
        sourceLineNumber,
        item.itemNumber,
        item.rawDescription,
        Math.round(item.quantity * 1000),
        unitPriceCents,
        item.unitPriceMills,
        item.grossAmountCents,
        item.discountCents,
        item.netAmountCents,
        item.taxStatus,
        item.normalizationStatus,
        item.normalizationStatus === "normalized_from_history" ? 9000 : null,
        now,
        now
      );
  });
  await runPreparedInChunks(db, itemStatements);
}

async function seedSaturdayList(
  db: D1Database,
  trip: TripRow,
  now: string
) {
  const latestMemories = await db
    .prepare(
      `SELECT product_id, preference FROM (
         SELECT COALESCE(feedback.product_id, receipt_items.product_id) AS product_id,
                feedback.value AS preference,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(feedback.product_id, receipt_items.product_id)
                  ORDER BY feedback.created_at DESC, feedback.id DESC
                ) AS memory_rank
         FROM feedback
         LEFT JOIN receipt_items ON receipt_items.id = feedback.receipt_item_id
         WHERE feedback.household_id = ?
           AND feedback.kind = 'product_experience'
           AND COALESCE(feedback.product_id, receipt_items.product_id) IS NOT NULL
       )
       WHERE memory_rank = 1`
    )
    .bind(trip.household_id)
    .all<{ product_id: string; preference: string }>();
  const memoryByProductId = new Map(
    latestMemories.results.map((memory) => [
      memory.product_id,
      isProductMemoryPreference(memory.preference)
        ? memory.preference
        : null,
    ]),
  );
  const recommendations = buildSaturdayRecommendations(
    RECURRING_PRODUCT_HISTORIES_2026,
    trip.scheduled_for,
  ).filter((recommendation) => {
    const productId = productIdFor(recommendation.itemNumber);
    return !productMemorySuppressesSuggestion(
      productId ? memoryByProductId.get(productId) : null,
    );
  });
  const statements: D1PreparedStatement[] = [];

  recommendations.forEach((recommendation, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO trip_list_items (
            id, trip_id, product_id, label, section, source,
            recommendation_reason, confidence_bps, included, checked,
            included_at_freeze, added_after_freeze, estimated_price_cents,
            quantity_milli, sort_order, added_by_member_id, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
            NULL, 0, ?, 1000, ?, NULL, ?, ?
          )
          ON CONFLICT DO NOTHING`
        )
        .bind(
          `seed-${trip.scheduled_for}-${recommendation.itemNumber}`,
          trip.id,
          productIdFor(recommendation.itemNumber),
          recommendation.name,
          recommendation.section,
          recommendation.source,
          recommendation.reason,
          recommendation.confidenceBps,
          recommendation.included ? 1 : 0,
          recommendation.estimatedPriceCents,
          index,
          now,
          now
        )
    );
  });

  await runPreparedInChunks(db, statements);
}

function authenticatedUser(request: Request): AuthenticatedUser {
  const rawEmail = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!rawEmail) {
    throw new ApiError(401, "ChatGPT sign-in is required");
  }

  const email = rawEmail.toLowerCase().slice(0, 320);
  const encodedName = request.headers.get(
    "oai-authenticated-user-full-name"
  );
  const encoding = request.headers.get(
    "oai-authenticated-user-full-name-encoding"
  );
  let displayName = email;

  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      displayName = decodeURIComponent(encodedName).trim() || email;
    } catch {
      displayName = email;
    }
  }

  return { email, displayName: displayName.slice(0, 120) };
}

function nowIso() {
  return new Date().toISOString();
}

function nextSaturday(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const localDate = new Date(
    Date.UTC(value("year"), value("month") - 1, value("day"))
  );
  const offset = (6 - localDate.getUTCDay() + 7) % 7;
  const daysUntilSaturday = offset === 0 ? 7 : offset;
  localDate.setUTCDate(localDate.getUTCDate() + daysUntilSaturday);
  return localDate.toISOString().slice(0, 10);
}

function saturdayAfter(dateValue: string) {
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "scheduled date is invalid");
  }
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number
) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, `${field} is required`);
  }

  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new ApiError(400, `${field} is too long`);
  }

  return normalized;
}

function optionalId(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, 128);
}

function optionalRevision(value: string | null) {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(400, "revision must be a non-negative integer");
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new ApiError(400, "revision must be a non-negative integer");
  }
  return revision;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ApiError(400, `${field} must be an integer`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new ApiError(400, `${field} must be a boolean`);
  }
  return value;
}

async function requestBody(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Request body must be an object");
  }

  return body as Record<string, unknown>;
}

async function bootstrapHousehold(
  db: D1Database,
  user: AuthenticatedUser
): Promise<HouseholdContext> {
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO households (
        id, slug, name, time_zone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING`
    )
    .bind(
      HOUSEHOLD_ID,
      HOUSEHOLD_SLUG,
      HOUSEHOLD_NAME,
      HOUSEHOLD_TIME_ZONE,
      now,
      now
    )
    .run();

  const household = await db
    .prepare(`SELECT * FROM households WHERE slug = ? LIMIT 1`)
    .bind(HOUSEHOLD_SLUG)
    .first<HouseholdRow>();

  if (!household) {
    throw new ApiError(500, "Unable to initialize the household");
  }

  const memberCount = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM household_members WHERE household_id = ?`
    )
    .bind(household.id)
    .first<{ count: number }>();
  const existingMember = await db
    .prepare(
      `SELECT id FROM household_members
       WHERE household_id = ? AND user_email = ? LIMIT 1`
    )
    .bind(household.id, user.email)
    .first<{ id: string }>();
  if (!existingMember && (memberCount?.count ?? 0) >= 2) {
    throw new ApiError(403, "This private household already has two members");
  }
  const initialRole = (memberCount?.count ?? 0) === 0 ? "owner" : "member";

  await db
    .prepare(
      `INSERT INTO household_members (
        id, household_id, user_email, display_name, role, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(household_id, user_email) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at`
    )
    .bind(
      crypto.randomUUID(),
      household.id,
      user.email,
      user.displayName,
      initialRole,
      now,
      now
    )
    .run();

  const member = await db
    .prepare(
      `SELECT * FROM household_members
       WHERE household_id = ? AND user_email = ?
       LIMIT 1`
    )
    .bind(household.id, user.email)
    .first<MemberRow>();

  if (!member) {
    throw new ApiError(500, "Unable to initialize the household member");
  }

  await seedAuditedHistory(db, household.id);

  let currentTrip = await db
    .prepare(
      `SELECT * FROM trips
       WHERE household_id = ? AND status IN ('planning', 'frozen')
       ORDER BY scheduled_for ASC, created_at ASC
       LIMIT 1`
    )
    .bind(household.id)
    .first<TripRow>();

  if (!currentTrip) {
    let scheduledFor = nextSaturday(household.time_zone);
    const latestCompleted = await db
      .prepare(
        `SELECT scheduled_for FROM trips
         WHERE household_id = ? AND status = 'completed'
         ORDER BY scheduled_for DESC
         LIMIT 1`
      )
      .bind(household.id)
      .first<{ scheduled_for: string }>();
    if (
      latestCompleted?.scheduled_for &&
      latestCompleted.scheduled_for >= scheduledFor
    ) {
      scheduledFor = saturdayAfter(latestCompleted.scheduled_for);
    }

    await db
      .prepare(
        `INSERT INTO trips (
          id, household_id, scheduled_for, status, created_by_member_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'planning', ?, ?, ?)
        ON CONFLICT(household_id, scheduled_for) DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        household.id,
        scheduledFor,
        member.id,
        now,
        now
      )
      .run();

    currentTrip = await db
      .prepare(
        `SELECT * FROM trips
         WHERE household_id = ? AND scheduled_for = ?
           AND status IN ('planning', 'frozen')
         LIMIT 1`
      )
      .bind(household.id, scheduledFor)
      .first<TripRow>();
  }

  if (!currentTrip) {
    throw new ApiError(500, "Unable to initialize the Saturday trip");
  }

  await seedSaturdayList(db, currentTrip, now);

  const revisionedTrip = await authorizedTrip(
    db,
    household.id,
    currentTrip.id,
  );
  return { household, member, currentTrip: revisionedTrip };
}

async function bootstrapOwnerSandbox(
  db: D1Database,
  user: AuthenticatedUser
): Promise<HouseholdContext> {
  // Establish authority from the real shared household first. The sandbox does
  // not grant access merely because someone knows its URL or identifier.
  const primaryContext = await bootstrapHousehold(db, user);
  requireHouseholdOwner(primaryContext);

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO households (
        id, slug, name, time_zone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING`
    )
    .bind(
      SANDBOX_HOUSEHOLD_ID,
      SANDBOX_HOUSEHOLD_SLUG,
      SANDBOX_HOUSEHOLD_NAME,
      HOUSEHOLD_TIME_ZONE,
      now,
      now
    )
    .run();

  const household = await db
    .prepare(`SELECT * FROM households WHERE slug = ? LIMIT 1`)
    .bind(SANDBOX_HOUSEHOLD_SLUG)
    .first<HouseholdRow>();
  if (!household) throw new ApiError(500, "Unable to initialize the test sandbox");

  await db
    .prepare(
      `INSERT INTO household_members (
        id, household_id, user_email, display_name, role, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, 'owner', ?, ?)
      ON CONFLICT(household_id, user_email) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at`
    )
    .bind(
      crypto.randomUUID(),
      household.id,
      user.email,
      user.displayName,
      now,
      now
    )
    .run();

  const member = await db
    .prepare(
      `SELECT * FROM household_members
       WHERE household_id = ? AND user_email = ?
       LIMIT 1`
    )
    .bind(household.id, user.email)
    .first<MemberRow>();
  if (!member) throw new ApiError(500, "Unable to initialize the test sandbox owner");

  let currentTrip = await db
    .prepare(
      `SELECT * FROM trips
       WHERE household_id = ? AND status IN ('planning', 'frozen')
       ORDER BY scheduled_for ASC, created_at ASC
       LIMIT 1`
    )
    .bind(household.id)
    .first<TripRow>();

  if (!currentTrip) {
    let scheduledFor = nextSaturday(household.time_zone);
    const latestCompleted = await db
      .prepare(
        `SELECT scheduled_for FROM trips
         WHERE household_id = ? AND status = 'completed'
         ORDER BY scheduled_for DESC
         LIMIT 1`
      )
      .bind(household.id)
      .first<{ scheduled_for: string }>();
    if (latestCompleted?.scheduled_for && latestCompleted.scheduled_for >= scheduledFor) {
      scheduledFor = saturdayAfter(latestCompleted.scheduled_for);
    }

    await db
      .prepare(
        `INSERT INTO trips (
          id, household_id, scheduled_for, status, created_by_member_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'planning', ?, ?, ?)
        ON CONFLICT(household_id, scheduled_for) DO NOTHING`
      )
      .bind(crypto.randomUUID(), household.id, scheduledFor, member.id, now, now)
      .run();

    currentTrip = await db
      .prepare(
        `SELECT * FROM trips
         WHERE household_id = ? AND scheduled_for = ?
           AND status IN ('planning', 'frozen')
         LIMIT 1`
      )
      .bind(household.id, scheduledFor)
      .first<TripRow>();
  }

  if (!currentTrip) throw new ApiError(500, "Unable to initialize the test sandbox trip");
  return { household, member, currentTrip };
}

function sandboxRequested(value: unknown) {
  return value === true || value === "1";
}

async function requestHouseholdContext(
  db: D1Database,
  user: AuthenticatedUser,
  sandbox: boolean
) {
  return sandbox ? bootstrapOwnerSandbox(db, user) : bootstrapHousehold(db, user);
}

function memberSummary(row: MemberRow): HouseholdMemberSummary {
  return {
    id: row.id,
    email: row.user_email,
    displayName: row.display_name,
    role: row.role,
  };
}

function tripSummary(row: TripRow): TripSummary {
  return {
    id: row.id,
    scheduledFor: row.scheduled_for,
    status: row.status,
    listRevision: row.list_revision,
    targetCents: row.target_cents,
    discoveryAllowanceCents: row.discovery_allowance_cents,
    estimatedListTotalAtFreezeCents:
      row.estimated_list_total_at_freeze_cents,
    estimatedPricedItemCountAtFreeze:
      row.estimated_priced_item_count_at_freeze,
    estimatedUnpricedItemCountAtFreeze:
      row.estimated_unpriced_item_count_at_freeze,
    frozenAt: row.frozen_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listItemSummary(row: ListItemRow): TripListItemSummary {
  return {
    id: row.id,
    tripId: row.trip_id,
    productId: row.product_id,
    label: row.label,
    section: row.section,
    source: row.source,
    recommendationReason: row.recommendation_reason,
    confidenceBps: row.confidence_bps,
    included: Boolean(row.included),
    checked: Boolean(row.checked),
    includedAtFreeze:
      row.included_at_freeze === null
        ? null
        : Boolean(row.included_at_freeze),
    addedAfterFreeze: Boolean(row.added_after_freeze),
    estimatedPriceCents: row.estimated_price_cents,
    quantityMilli: row.quantity_milli,
    sortOrder: row.sort_order,
    addedByMemberId: row.added_by_member_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listMutationResponse(row: ListItemRow, status = 200) {
  return json(
    {
      item: listItemSummary(row),
      listRevision: row.list_revision,
    },
    status,
  );
}

function productSummary(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    costcoItemNumber: row.costco_item_number,
    canonicalName: row.canonical_name,
    category: row.category,
    categoryStatus: row.category_status,
    categoryReviewedAt: row.category_reviewed_at,
    categoryReviewedByDisplayName:
      row.category_reviewed_by_display_name ?? null,
    latestRawDescription: row.latest_raw_description ?? null,
    latestPurchasedAt: row.latest_purchased_at ?? null,
    latestRegularUnitPriceCents:
      row.latest_regular_unit_price_cents ?? null,
    latestPaidUnitPriceCents: row.latest_paid_unit_price_cents ?? null,
    latestDiscountUnitCents: row.latest_discount_unit_cents ?? null,
    purchaseCount: row.receipt_purchase_count ?? 0,
    memory: isProductMemoryPreference(row.memory_preference)
      ? {
          preference: row.memory_preference,
          note: row.memory_note ?? null,
          updatedAt: row.memory_updated_at ?? row.updated_at,
          sourcePurchasedAt: row.memory_source_purchased_at ?? null,
        }
      : null,
    image: row.image_id
      ? {
          id: row.image_id,
          sourceType: row.image_source_type ?? "household_upload",
          sourcePageUrl: row.image_source_page_url ?? null,
          attributionText: row.image_attribution_text ?? null,
          licenseCode: row.image_license_code ?? null,
          imageUrl: `/api/product-images?imageId=${encodeURIComponent(row.image_id)}`,
          updatedAt: row.image_updated_at ?? row.updated_at,
        }
      : null,
    brand: row.brand,
    unitDescription: row.unit_description,
    active: Boolean(row.active),
    updatedAt: row.updated_at,
  };
}

function receiptSummary(
  row: ReceiptTransactionRow
): ReceiptTransactionSummary {
  return {
    id: row.id,
    tripId: row.trip_id,
    transactionType: row.transaction_type,
    sourceType: row.source_type,
    purchasedAt: row.purchased_at,
    itemGrossCents: row.item_gross_cents,
    itemCount: row.item_count,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    householdFundedCents: row.household_funded_cents,
    externalFundingCents: row.external_funding_cents,
    auditFlag: row.audit_flag,
    parseStatus: row.parse_status,
  };
}

function feedbackSummary(row: FeedbackRow): FeedbackSummary {
  return {
    id: row.id,
    tripId: row.trip_id,
    receiptTransactionId: row.receipt_transaction_id,
    listItemId: row.list_item_id,
    receiptItemId: row.receipt_item_id,
    kind: row.kind,
    value: row.value,
    rating: row.rating,
    note: row.note,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
  };
}

async function readHouseholdCoreState(
  db: D1Database,
  context: HouseholdContext
): Promise<HouseholdCoreResponse> {
  const results = await db.batch([
    db
      .prepare(
        `SELECT * FROM household_members
         WHERE household_id = ?
         ORDER BY created_at ASC`
      )
      .bind(context.household.id),
    db
      .prepare(
        `SELECT * FROM trip_list_items
         WHERE trip_id = ?
         ORDER BY sort_order ASC, created_at ASC`
      )
      .bind(context.currentTrip.id),
    db
      .prepare(
        `SELECT products.*,
                reviewer.display_name AS category_reviewed_by_display_name,
                primary_image.id AS image_id,
                primary_image.source_type AS image_source_type,
                primary_image.source_page_url AS image_source_page_url,
                primary_image.attribution_text AS image_attribution_text,
                primary_image.license_code AS image_license_code,
                primary_image.updated_at AS image_updated_at,
                latest.raw_description AS latest_raw_description,
                latest.purchased_at AS latest_purchased_at,
                latest.regular_unit_price_cents AS latest_regular_unit_price_cents,
                latest.paid_unit_price_cents AS latest_paid_unit_price_cents,
                latest.discount_unit_cents AS latest_discount_unit_cents,
                latest.receipt_purchase_count AS receipt_purchase_count,
                memory.preference AS memory_preference,
                memory.note AS memory_note,
                memory.updated_at AS memory_updated_at,
                memory.source_purchased_at AS memory_source_purchased_at
         FROM products
         LEFT JOIN household_members AS reviewer
           ON reviewer.id = products.category_reviewed_by_member_id
         LEFT JOIN product_images AS primary_image
           ON primary_image.product_id = products.id
          AND primary_image.status = 'approved'
          AND primary_image.is_primary = 1
          AND primary_image.source_type IN ('household_upload', 'ai_generated')
         LEFT JOIN (
           SELECT ranked.* FROM (
             SELECT receipt_items.product_id,
                    receipt_items.raw_description,
                    receipt_transactions.purchased_at,
                    CAST(ROUND(
                      receipt_items.line_subtotal_cents * 1000.0 /
                      receipt_items.quantity_milli
                    ) AS INTEGER) AS regular_unit_price_cents,
                    CAST(ROUND(
                      receipt_items.net_amount_cents * 1000.0 /
                      receipt_items.quantity_milli
                    ) AS INTEGER) AS paid_unit_price_cents,
                    CAST(ROUND(
                      receipt_items.discount_cents * 1000.0 /
                      receipt_items.quantity_milli
                    ) AS INTEGER) AS discount_unit_cents,
                    COUNT(*) OVER (
                      PARTITION BY receipt_items.product_id
                    ) AS receipt_purchase_count,
                    ROW_NUMBER() OVER (
                      PARTITION BY receipt_items.product_id
                      ORDER BY receipt_transactions.purchased_at DESC,
                               receipt_items.source_line_number DESC,
                               receipt_items.id DESC
                    ) AS price_rank
             FROM receipt_items
             INNER JOIN receipt_transactions
               ON receipt_transactions.id = receipt_items.receipt_transaction_id
             WHERE receipt_items.product_id IS NOT NULL
               AND receipt_items.is_return = 0
               AND receipt_items.quantity_milli > 0
               AND NOT (
                 receipt_items.discount_cents > 0
                 AND receipt_items.line_subtotal_cents <= 0
                 AND receipt_items.net_amount_cents < 0
               )
               AND receipt_transactions.transaction_type = 'warehouse'
               AND receipt_transactions.parse_status = 'reconciled'
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
           ) AS ranked
           WHERE ranked.price_rank = 1
         ) AS latest ON latest.product_id = products.id
         LEFT JOIN (
           SELECT ranked.* FROM (
             SELECT COALESCE(feedback.product_id, receipt_items.product_id) AS product_id,
                    feedback.value AS preference,
                    feedback.note,
                    feedback.created_at AS updated_at,
                    receipt_transactions.purchased_at AS source_purchased_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(feedback.product_id, receipt_items.product_id)
                      ORDER BY feedback.created_at DESC, feedback.id DESC
                    ) AS memory_rank
             FROM feedback
             LEFT JOIN receipt_items
               ON receipt_items.id = feedback.receipt_item_id
             INNER JOIN receipt_transactions
               ON receipt_transactions.id = feedback.receipt_transaction_id
             WHERE feedback.household_id = ?
               AND feedback.kind = 'product_experience'
               AND COALESCE(feedback.product_id, receipt_items.product_id) IS NOT NULL
           ) AS ranked
           WHERE ranked.memory_rank = 1
         ) AS memory ON memory.product_id = products.id
         WHERE products.household_id = ? AND products.active = 1
         ORDER BY products.canonical_name COLLATE NOCASE ASC`
      )
      .bind(context.household.id, context.household.id),
    dashboardHistoryRevisionStatement(db, context.household.id),
  ]);

  const members = results[0].results as unknown as MemberRow[];
  const listItems = results[1].results as unknown as ListItemRow[];
  const products = results[2].results as unknown as ProductRow[];
  const historyRevision = (
    results[3].results[0] as { history_revision?: string } | undefined
  )?.history_revision ?? "1970-01-01T00:00:00.000Z";

  return {
    historyRevision,
    household: {
      id: context.household.id,
      name: context.household.name,
      timeZone: context.household.time_zone,
    },
    currentUser: memberSummary(context.member),
    members: members.map(memberSummary),
    currentTrip: tripSummary(context.currentTrip),
    listItems: listItems.map(listItemSummary),
    products: products.map(productSummary),
    closedLoop: await readClosedLoopReview(db, context.household.id),
  };
}

async function readHouseholdState(
  db: D1Database,
  context: HouseholdContext
): Promise<HouseholdBootstrapResponse> {
  const core = await readHouseholdCoreState(db, context);
  const supplemental = await db.batch([
    db
      .prepare(
        `SELECT * FROM trips
         WHERE household_id = ?
         ORDER BY scheduled_for DESC, created_at DESC
         LIMIT 12`
      )
      .bind(context.household.id),
    db
      .prepare(
        `SELECT * FROM receipt_transactions
         WHERE household_id = ?
         ORDER BY purchased_at DESC
         LIMIT 100`
      )
      .bind(context.household.id),
    db
      .prepare(
        `SELECT * FROM feedback
         WHERE household_id = ?
         ORDER BY created_at DESC
         LIMIT 100`
      )
      .bind(context.household.id),
  ]);
  const recentTrips = supplemental[0].results as unknown as TripRow[];
  const receipts = supplemental[1].results as unknown as ReceiptTransactionRow[];
  const feedbackRows = supplemental[2].results as unknown as FeedbackRow[];
  const insights = await buildDashboardViewStateFromD1(
    db,
    context.household.id,
  );
  return {
    ...core,
    historyRevision: insights.historyRevision,
    recentTrips: recentTrips.map(tripSummary),
    receiptTransactions: receipts.map(receiptSummary),
    feedback: feedbackRows.map(feedbackSummary),
    dashboard: insights.dashboard,
  };
}

function requireHouseholdOwner(context: HouseholdContext) {
  if (context.member.role !== "owner") {
    throw new ApiError(403, "Only the household owner can make this change");
  }
}

const DATA_HEALTH_TABLES = [
  { key: "households", label: "Households", sql: "SELECT COUNT(*) AS count FROM households WHERE id = ?" },
  { key: "householdMembers", label: "Household members", sql: "SELECT COUNT(*) AS count FROM household_members WHERE household_id = ?" },
  { key: "products", label: "Products", sql: "SELECT COUNT(*) AS count FROM products WHERE household_id = ?" },
  { key: "productImages", label: "Product images", sql: "SELECT COUNT(*) AS count FROM product_images WHERE household_id = ?" },
  { key: "trips", label: "Trips", sql: "SELECT COUNT(*) AS count FROM trips WHERE household_id = ?" },
  { key: "tripListItems", label: "Live list items", sql: "SELECT COUNT(*) AS count FROM trip_list_items INNER JOIN trips ON trips.id = trip_list_items.trip_id WHERE trips.household_id = ?" },
  { key: "receiptTransactions", label: "Receipt transactions", sql: "SELECT COUNT(*) AS count FROM receipt_transactions WHERE household_id = ?" },
  { key: "receiptItems", label: "Receipt lines", sql: "SELECT COUNT(*) AS count FROM receipt_items INNER JOIN receipt_transactions ON receipt_transactions.id = receipt_items.receipt_transaction_id WHERE receipt_transactions.household_id = ?" },
  { key: "feedback", label: "Feedback", sql: "SELECT COUNT(*) AS count FROM feedback WHERE household_id = ?" },
  { key: "tripIntentSnapshots", label: "Frozen intents", sql: "SELECT COUNT(*) AS count FROM trip_intent_snapshots INNER JOIN trips ON trips.id = trip_intent_snapshots.trip_id WHERE trips.household_id = ?" },
  { key: "tripIntentItems", label: "Frozen intent items", sql: "SELECT COUNT(*) AS count FROM trip_intent_items INNER JOIN trips ON trips.id = trip_intent_items.trip_id WHERE trips.household_id = ?" },
  { key: "receiptUploads", label: "Receipt uploads", sql: "SELECT COUNT(*) AS count FROM receipt_uploads WHERE household_id = ?" },
  { key: "productAliases", label: "Product aliases", sql: "SELECT COUNT(*) AS count FROM product_aliases WHERE household_id = ?" },
  { key: "tripItemMatches", label: "Intent-to-receipt matches", sql: "SELECT COUNT(*) AS count FROM trip_item_matches WHERE household_id = ?" },
  { key: "reviewQuestions", label: "Review questions", sql: "SELECT COUNT(*) AS count FROM review_questions WHERE household_id = ?" },
] as const;

function countResult(value: unknown) {
  const record = value as { count?: number | string } | null;
  return Number(record?.count ?? 0);
}

async function readDataHealth(
  db: D1Database,
  context: HouseholdContext,
): Promise<DataHealthResponse> {
  requireHouseholdOwner(context);
  const householdId = context.household.id;
  const countStatements = DATA_HEALTH_TABLES.map((entry) =>
    db.prepare(entry.sql).bind(householdId),
  );
  const results = await db.batch([
    ...countStatements,
    db
      .prepare(
        `SELECT
          COUNT(*) AS total_receipts,
          SUM(CASE WHEN parse_status = 'reconciled' THEN 1 ELSE 0 END) AS reconciled,
          SUM(CASE WHEN parse_status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
          SUM(CASE WHEN parse_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
          SUM(CASE WHEN parse_status <> 'reconciled' THEN total_cents ELSE 0 END) AS unreconciled_total_cents
         FROM receipt_transactions
         WHERE household_id = ?`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT receipt_items.id, receipt_items.receipt_transaction_id,
                receipt_transactions.purchased_at, receipt_items.source_line_number,
                receipt_items.raw_description, receipt_items.costco_item_number,
                receipt_items.net_amount_cents, receipt_items.match_confidence_bps
         FROM receipt_items
         INNER JOIN receipt_transactions
           ON receipt_transactions.id = receipt_items.receipt_transaction_id
         WHERE receipt_transactions.household_id = ?
           AND receipt_items.product_id IS NULL
           AND NOT (
             receipt_items.discount_cents > 0
             AND receipt_items.line_subtotal_cents <= 0
             AND receipt_items.net_amount_cents < 0
           )
         ORDER BY receipt_transactions.purchased_at DESC, receipt_items.source_line_number ASC
         LIMIT 100`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT products.id, products.canonical_name, products.costco_item_number,
                products.category, products.category_status, products.active,
                products.updated_at, COUNT(receipt_items.id) AS receipt_line_count
         FROM products
         LEFT JOIN receipt_items ON receipt_items.product_id = products.id
         WHERE products.household_id = ?
           AND (products.category_status = 'needs_review' OR products.category IS NULL OR products.category = '')
         GROUP BY products.id
         ORDER BY products.updated_at DESC, products.canonical_name COLLATE NOCASE ASC
         LIMIT 100`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT review_questions.id, review_questions.receipt_transaction_id,
                receipt_transactions.purchased_at, review_questions.purpose,
                review_questions.prompt, review_questions.priority,
                review_questions.status, review_questions.created_at
         FROM review_questions
         INNER JOIN receipt_transactions
           ON receipt_transactions.id = review_questions.receipt_transaction_id
         WHERE review_questions.household_id = ? AND review_questions.status = 'open'
         ORDER BY review_questions.priority ASC, review_questions.created_at ASC
         LIMIT 100`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT id, purchased_at, source_type, total_cents, parse_status, audit_flag
         FROM receipt_transactions
         WHERE household_id = ? AND parse_status = 'rejected'
         ORDER BY purchased_at DESC
         LIMIT 100`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT receipt_transactions.id, receipt_transactions.trip_id,
                trips.scheduled_for, receipt_transactions.purchased_at,
                receipt_transactions.transaction_type, receipt_transactions.source_type,
                receipt_transactions.total_cents, receipt_transactions.item_count,
                receipt_transactions.parse_status, receipt_transactions.audit_flag,
                COUNT(CASE WHEN receipt_items.product_id IS NULL THEN 1 END) AS unmatched_line_count
         FROM receipt_transactions
         LEFT JOIN trips ON trips.id = receipt_transactions.trip_id
         LEFT JOIN receipt_items ON receipt_items.receipt_transaction_id = receipt_transactions.id
         WHERE receipt_transactions.household_id = ?
         GROUP BY receipt_transactions.id
         ORDER BY receipt_transactions.purchased_at DESC
         LIMIT 250`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT trips.id, trips.scheduled_for, trips.status, trips.target_cents,
                trips.estimated_list_total_at_freeze_cents, trips.created_at,
                COUNT(DISTINCT trip_list_items.id) AS list_item_count,
                COUNT(DISTINCT receipt_transactions.id) AS receipt_count
         FROM trips
         LEFT JOIN trip_list_items ON trip_list_items.trip_id = trips.id
         LEFT JOIN receipt_transactions ON receipt_transactions.trip_id = trips.id
         WHERE trips.household_id = ?
         GROUP BY trips.id
         ORDER BY trips.scheduled_for DESC
         LIMIT 250`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT products.id, products.canonical_name, products.costco_item_number,
                products.category, products.category_status, products.active,
                products.updated_at, COUNT(receipt_items.id) AS receipt_line_count
         FROM products
         LEFT JOIN receipt_items ON receipt_items.product_id = products.id
         WHERE products.household_id = ?
         GROUP BY products.id
         ORDER BY products.canonical_name COLLATE NOCASE ASC
         LIMIT 250`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT trip_list_items.id, trip_list_items.trip_id, trips.scheduled_for,
                trips.status AS trip_status, trip_list_items.label,
                trip_list_items.source, trip_list_items.section,
                trip_list_items.included, trip_list_items.checked,
                trip_list_items.confidence_bps, trip_list_items.recommendation_reason,
                trip_list_items.estimated_price_cents, trip_list_items.created_at
         FROM trip_list_items
         INNER JOIN trips ON trips.id = trip_list_items.trip_id
         WHERE trips.household_id = ?
           AND trip_list_items.source IN ('recurring', 'predicted', 'consider')
         ORDER BY trips.scheduled_for DESC, trip_list_items.created_at DESC
         LIMIT 250`,
      )
      .bind(householdId),
  ]);

  const countResults = results.slice(0, DATA_HEALTH_TABLES.length);
  const offset = DATA_HEALTH_TABLES.length;
  const reconciliation = results[offset].results[0] as {
    total_receipts: number | null;
    reconciled: number | null;
    needs_review: number | null;
    rejected: number | null;
    unreconciled_total_cents: number | null;
  } | undefined;
  const unmatched = results[offset + 1].results as unknown as Array<{
    id: string; receipt_transaction_id: string; purchased_at: string;
    source_line_number: number; raw_description: string; costco_item_number: string | null;
    net_amount_cents: number; match_confidence_bps: number | null;
  }>;
  const productsForReview = results[offset + 2].results as unknown as Array<{
    id: string; canonical_name: string; costco_item_number: string | null;
    category: string | null; category_status: DataHealthProduct["categoryStatus"];
    active: number; receipt_line_count: number; updated_at: string;
  }>;
  const questions = results[offset + 3].results as unknown as Array<{
    id: string; receipt_transaction_id: string; purchased_at: string;
    purpose: ReviewQuestionPurpose; prompt: string; priority: number;
    status: "open" | "answered" | "dismissed"; created_at: string;
  }>;
  const failedImports = results[offset + 4].results as unknown as Array<{
    id: string; purchased_at: string; source_type: DataHealthFailedImport["sourceType"];
    total_cents: number; parse_status: "rejected"; audit_flag: string;
  }>;
  const receipts = results[offset + 5].results as unknown as Array<{
    id: string; trip_id: string | null; scheduled_for: string | null; purchased_at: string;
    transaction_type: DataHealthReceipt["transactionType"];
    source_type: DataHealthReceipt["sourceType"]; total_cents: number; item_count: number;
    parse_status: DataHealthReceipt["parseStatus"]; audit_flag: string; unmatched_line_count: number;
  }>;
  const trips = results[offset + 6].results as unknown as Array<{
    id: string; scheduled_for: string; status: TripStatus; target_cents: number | null;
    estimated_list_total_at_freeze_cents: number | null; list_item_count: number;
    receipt_count: number; created_at: string;
  }>;
  const products = results[offset + 7].results as unknown as typeof productsForReview;
  const recommendationEvents = results[offset + 8].results as unknown as Array<{
    id: string; trip_id: string; scheduled_for: string; trip_status: TripStatus;
    label: string; source: ListItemSource; section: ListItemSection; included: number;
    checked: number; confidence_bps: number | null; recommendation_reason: string | null;
    estimated_price_cents: number | null; created_at: string;
  }>;

  const mapProduct = (row: (typeof products)[number]): DataHealthProduct => ({
    id: row.id,
    canonicalName: row.canonical_name,
    costcoItemNumber: row.costco_item_number,
    category: row.category,
    categoryStatus: row.category_status,
    active: Boolean(row.active),
    receiptLineCount: Number(row.receipt_line_count),
    updatedAt: row.updated_at,
  });

  return {
    generatedAt: nowIso(),
    source: "hosted_d1",
    tableCounts: DATA_HEALTH_TABLES.map((entry, index) => ({
      key: entry.key,
      label: entry.label,
      count: countResult((countResults[index].results[0] ?? null) as unknown),
    })) as DataHealthTableCount[],
    reconciliation: {
      totalReceipts: Number(reconciliation?.total_receipts ?? 0),
      reconciled: Number(reconciliation?.reconciled ?? 0),
      needsReview: Number(reconciliation?.needs_review ?? 0),
      rejected: Number(reconciliation?.rejected ?? 0),
      unreconciledTotalCents: Number(reconciliation?.unreconciled_total_cents ?? 0),
    },
    importTracking: {
      supportsBatchJobFailures: false,
      message: "Batch import jobs are not implemented yet. Rejected receipt drafts are shown here; upload-job failures will arrive with batch ingestion.",
    },
    unmatchedReceiptLines: unmatched.map((row): DataHealthUnmatchedLine => ({
      id: row.id,
      receiptTransactionId: row.receipt_transaction_id,
      purchasedAt: row.purchased_at,
      sourceLineNumber: row.source_line_number,
      rawDescription: row.raw_description,
      costcoItemNumber: row.costco_item_number,
      netAmountCents: row.net_amount_cents,
      matchConfidenceBps: row.match_confidence_bps,
    })),
    productsNeedingReview: productsForReview.map(mapProduct),
    openReviewQuestions: questions.map((row): DataHealthReviewQuestion => ({
      id: row.id,
      receiptTransactionId: row.receipt_transaction_id,
      purchasedAt: row.purchased_at,
      purpose: row.purpose,
      prompt: row.prompt,
      priority: row.priority,
      status: row.status,
      createdAt: row.created_at,
    })),
    failedImports: failedImports.map((row) => ({
      id: row.id,
      purchasedAt: row.purchased_at,
      sourceType: row.source_type,
      totalCents: row.total_cents,
      parseStatus: row.parse_status,
      auditFlag: row.audit_flag,
    })),
    receipts: receipts.map((row): DataHealthReceipt => ({
      id: row.id,
      tripId: row.trip_id,
      scheduledFor: row.scheduled_for,
      purchasedAt: row.purchased_at,
      transactionType: row.transaction_type,
      sourceType: row.source_type,
      totalCents: row.total_cents,
      itemCount: row.item_count,
      parseStatus: row.parse_status,
      auditFlag: row.audit_flag,
      unmatchedLineCount: Number(row.unmatched_line_count),
    })),
    trips: trips.map((row): DataHealthTrip => ({
      id: row.id,
      scheduledFor: row.scheduled_for,
      status: row.status,
      targetCents: row.target_cents,
      estimatedListTotalAtFreezeCents: row.estimated_list_total_at_freeze_cents,
      listItemCount: Number(row.list_item_count),
      receiptCount: Number(row.receipt_count),
      createdAt: row.created_at,
    })),
    products: products.map(mapProduct),
    recommendationEvents: recommendationEvents.map(
      (row): DataHealthRecommendationEvent => ({
        id: row.id,
        tripId: row.trip_id,
        scheduledFor: row.scheduled_for,
        tripStatus: row.trip_status,
        label: row.label,
        source: row.source,
        section: row.section,
        included: Boolean(row.included),
        checked: Boolean(row.checked),
        confidenceBps: row.confidence_bps,
        recommendationReason: row.recommendation_reason,
        estimatedPriceCents: row.estimated_price_cents,
        createdAt: row.created_at,
      }),
    ),
  };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csvResponse(rows: DataHealthReceipt[]) {
  const headings = [
    "receipt_id", "trip_id", "trip_date", "purchased_at", "transaction_type",
    "source_type", "total_cents", "item_count", "parse_status", "audit_flag", "unmatched_line_count",
  ];
  const lines = [
    headings.join(","),
    ...rows.map((row) => [
      row.id, row.tripId, row.scheduledFor, row.purchasedAt, row.transactionType,
      row.sourceType, row.totalCents, row.itemCount, row.parseStatus, row.auditFlag, row.unmatchedLineCount,
    ].map(csvCell).join(",")),
  ];
  return new Response(lines.join("\n"), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="basketsense-receipts.csv"',
    },
  });
}

async function householdExportResponse(
  db: D1Database,
  context: HouseholdContext,
  format: string | null,
) {
  requireHouseholdOwner(context);
  const dataHealth = await readDataHealth(db, context);
  if (format === "csv") return csvResponse(dataHealth.receipts);
  if (format !== "json") {
    throw new ApiError(400, "Export format must be json or csv");
  }

  const householdId = context.household.id;
  const records = await db.batch([
    db.prepare("SELECT id, user_email, display_name, role, created_at, last_seen_at FROM household_members WHERE household_id = ? ORDER BY created_at").bind(householdId),
    db.prepare("SELECT * FROM trips WHERE household_id = ? ORDER BY scheduled_for").bind(householdId),
    db.prepare("SELECT trip_list_items.* FROM trip_list_items INNER JOIN trips ON trips.id = trip_list_items.trip_id WHERE trips.household_id = ? ORDER BY trip_list_items.created_at").bind(householdId),
    db.prepare("SELECT * FROM products WHERE household_id = ? ORDER BY canonical_name COLLATE NOCASE").bind(householdId),
    db.prepare("SELECT * FROM receipt_transactions WHERE household_id = ? ORDER BY purchased_at").bind(householdId),
    db.prepare("SELECT receipt_items.* FROM receipt_items INNER JOIN receipt_transactions ON receipt_transactions.id = receipt_items.receipt_transaction_id WHERE receipt_transactions.household_id = ? ORDER BY receipt_transactions.purchased_at, receipt_items.source_line_number").bind(householdId),
    db.prepare("SELECT * FROM feedback WHERE household_id = ? ORDER BY created_at").bind(householdId),
    db.prepare("SELECT trip_intent_snapshots.* FROM trip_intent_snapshots INNER JOIN trips ON trips.id = trip_intent_snapshots.trip_id WHERE trips.household_id = ? ORDER BY trip_intent_snapshots.created_at").bind(householdId),
    db.prepare("SELECT trip_intent_items.* FROM trip_intent_items INNER JOIN trips ON trips.id = trip_intent_items.trip_id WHERE trips.household_id = ? ORDER BY trip_intent_items.created_at").bind(householdId),
    db.prepare("SELECT id, household_id, receipt_transaction_id, original_filename, content_type, byte_size, status, uploaded_by_member_id, created_at, updated_at FROM receipt_uploads WHERE household_id = ? ORDER BY created_at").bind(householdId),
    db.prepare("SELECT * FROM product_aliases WHERE household_id = ? ORDER BY created_at").bind(householdId),
    db.prepare("SELECT * FROM trip_item_matches WHERE household_id = ? ORDER BY created_at").bind(householdId),
    db.prepare("SELECT * FROM review_questions WHERE household_id = ? ORDER BY created_at").bind(householdId),
  ]);

  return json({
    schemaVersion: 1,
    generatedAt: nowIso(),
    household: {
      id: context.household.id,
      name: context.household.name,
      timeZone: context.household.time_zone,
    },
    records: {
      members: records[0].results,
      trips: records[1].results,
      tripListItems: records[2].results,
      products: records[3].results,
      receiptTransactions: records[4].results,
      receiptItems: records[5].results,
      feedback: records[6].results,
      tripIntentSnapshots: records[7].results,
      tripIntentItems: records[8].results,
      receiptUploads: records[9].results,
      productAliases: records[10].results,
      tripItemMatches: records[11].results,
      reviewQuestions: records[12].results,
    },
    exportNotes: [
      "Receipt-image binaries and R2 storage keys are intentionally excluded.",
      "This export contains only records scoped to this household.",
    ],
  });
}

async function readExistingHouseholdContext(
  db: D1Database,
  user: AuthenticatedUser,
  requestedTripId: string | null
): Promise<HouseholdContext> {
  const household = await db
    .prepare(`SELECT * FROM households WHERE slug = ? LIMIT 1`)
    .bind(HOUSEHOLD_SLUG)
    .first<HouseholdRow>();

  if (!household) {
    throw new ApiError(403, "This private household is not available");
  }

  const member = await db
    .prepare(
      `SELECT * FROM household_members
       WHERE household_id = ? AND user_email = ?
       LIMIT 1`
    )
    .bind(household.id, user.email)
    .first<MemberRow>();

  if (!member) {
    throw new ApiError(403, "This private household is not available");
  }

  const currentTrip = requestedTripId
    ? await authorizedTrip(db, household.id, requestedTripId)
    : await db
        .prepare(
          `SELECT * FROM trips
           WHERE household_id = ? AND status IN ('planning', 'frozen')
           ORDER BY scheduled_for ASC, created_at ASC
           LIMIT 1`
        )
        .bind(household.id)
        .first<TripRow>();

  if (!currentTrip) throw new ApiError(404, "Trip not found");
  return { household, member, currentTrip };
}

async function readHouseholdListState(
  db: D1Database,
  context: HouseholdContext
): Promise<HouseholdListResponse> {
  const listItems = await db
    .prepare(
      `SELECT * FROM trip_list_items
       WHERE trip_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    )
    .bind(context.currentTrip.id)
    .all<ListItemRow>();

  return {
    currentTrip: tripSummary(context.currentTrip),
    listItems: listItems.results.map(listItemSummary),
  };
}

async function authorizedTrip(
  db: D1Database,
  householdId: string,
  tripId: string
) {
  const trip = await db
    .prepare(`SELECT * FROM trips WHERE id = ? AND household_id = ? LIMIT 1`)
    .bind(tripId, householdId)
    .first<TripRow>();

  if (!trip) throw new ApiError(404, "Trip not found");
  return trip;
}

async function authorizedListItem(
  db: D1Database,
  householdId: string,
  itemId: string
) {
  const item = await db
    .prepare(
      `SELECT trip_list_items.*, trips.status AS trip_status,
              trips.household_id AS household_id
       FROM trip_list_items
       INNER JOIN trips ON trips.id = trip_list_items.trip_id
       WHERE trip_list_items.id = ? AND trips.household_id = ?
       LIMIT 1`
    )
    .bind(itemId, householdId)
    .first<AuthorizedListItemRow>();

  if (!item) throw new ApiError(404, "List item not found");
  return item;
}

type CatalogListMatch = {
  id: string;
  canonical_name: string;
  latest_regular_unit_price_cents: number | null;
};

async function catalogMatchForListItem(
  db: D1Database,
  householdId: string,
  requestedProductId: string | null,
  label: string
): Promise<CatalogListMatch | null> {
  let product: { id: string; canonical_name: string } | null = null;

  if (requestedProductId) {
    product = await db
      .prepare(
        `SELECT id, canonical_name
         FROM products
         WHERE id = ? AND household_id = ? AND active = 1
         LIMIT 1`
      )
      .bind(requestedProductId, householdId)
      .first<{ id: string; canonical_name: string }>();
    if (!product) throw new ApiError(404, "Product not found");
  } else {
    const candidates = await db
      .prepare(
        `SELECT DISTINCT products.id, products.canonical_name
         FROM products
         LEFT JOIN receipt_items ON receipt_items.product_id = products.id
         WHERE products.household_id = ?
           AND products.active = 1
           AND (
             LOWER(TRIM(products.canonical_name)) = LOWER(TRIM(?))
             OR products.costco_item_number = TRIM(?)
             OR LOWER(TRIM(receipt_items.raw_description)) = LOWER(TRIM(?))
           )
         ORDER BY products.updated_at DESC, products.id ASC
         LIMIT 2`
      )
      .bind(householdId, label, label, label)
      .all<{ id: string; canonical_name: string }>();
    if (candidates.results.length === 1) {
      product = candidates.results[0];
    }
  }

  if (!product) return null;

  const price = await db
    .prepare(
      `SELECT CAST(ROUND(
                receipt_items.line_subtotal_cents * 1000.0 /
                receipt_items.quantity_milli
              ) AS INTEGER) AS latest_regular_unit_price_cents
       FROM receipt_items
       INNER JOIN receipt_transactions
         ON receipt_transactions.id = receipt_items.receipt_transaction_id
       WHERE receipt_items.product_id = ?
         AND receipt_items.is_return = 0
         AND receipt_items.quantity_milli > 0
         AND NOT (
           receipt_items.discount_cents > 0
           AND receipt_items.line_subtotal_cents <= 0
           AND receipt_items.net_amount_cents < 0
         )
         AND receipt_transactions.household_id = ?
         AND receipt_transactions.transaction_type = 'warehouse'
         AND receipt_transactions.parse_status = 'reconciled'
       ORDER BY receipt_transactions.purchased_at DESC,
                receipt_items.source_line_number DESC,
                receipt_items.id DESC
       LIMIT 1`
    )
    .bind(product.id, householdId)
    .first<{ latest_regular_unit_price_cents: number }>();

  return {
    ...product,
    latest_regular_unit_price_cents:
      price?.latest_regular_unit_price_cents ?? null,
  };
}

async function addListItem(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const tripId =
    optionalId(body.tripId, "tripId") ?? context.currentTrip.id;
  const trip = await authorizedTrip(db, context.household.id, tripId);
  if (trip.status === "completed") {
    throw new ApiError(409, "Completed trips cannot be changed");
  }

  const requestedLabel = requiredString(body.label, "label", 140);
  const requestedProductId = optionalId(body.productId, "productId");
  const catalogMatch = await catalogMatchForListItem(
    db,
    context.household.id,
    requestedProductId,
    requestedLabel
  );
  const label = catalogMatch?.canonical_name ?? requestedLabel;
  const productId = catalogMatch?.id ?? null;

  const sourceValue = body.source ?? "manual";
  if (
    typeof sourceValue !== "string" ||
    !LIST_ITEM_SOURCES.has(sourceValue as ListItemSource)
  ) {
    throw new ApiError(400, "source is invalid");
  }
  const requestedSource = sourceValue as ListItemSource;
  const sectionValue = body.section ?? "essentials";
  if (
    typeof sectionValue !== "string" ||
    !LIST_ITEM_SECTIONS.has(sectionValue as ListItemSection)
  ) {
    throw new ApiError(400, "section is invalid");
  }
  const section = sectionValue as ListItemSection;
  const recommendationReason =
    body.recommendationReason === undefined ||
    body.recommendationReason === null ||
    body.recommendationReason === ""
      ? null
      : requiredString(
          body.recommendationReason,
          "recommendationReason",
          320
        );
  const confidenceBps = optionalInteger(
    body.confidenceBps,
    "confidenceBps",
    0,
    10_000
  );
  const included =
    body.included === undefined
      ? true
      : requiredBoolean(body.included, "included");
  const requestedEstimatedPriceCents = optionalInteger(
    body.estimatedPriceCents,
    "estimatedPriceCents",
    0,
    10_000_000
  );
  const estimateWasProvided = Object.prototype.hasOwnProperty.call(
    body,
    "estimatedPriceCents"
  );
  if (
    estimateWasProvided &&
    requestedEstimatedPriceCents !== null &&
    requestedEstimatedPriceCents <= 0
  ) {
    throw new ApiError(400, "estimatedPriceCents must be greater than zero");
  }
  const estimatedPriceCents =
    requestedEstimatedPriceCents ??
    catalogMatch?.latest_regular_unit_price_cents ??
    null;
  const quantityMilli =
    optionalInteger(body.quantityMilli, "quantityMilli", 1, 1_000_000) ??
    1000;
  const now = nowIso();

  const explicitEstimateItem = estimateWasProvided
    ? await db
        .prepare(
          `SELECT * FROM trip_list_items
           WHERE trip_id = ? AND LOWER(TRIM(label)) = LOWER(TRIM(?))
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .bind(trip.id, requestedLabel)
        .first<ListItemRow>()
    : null;
  const existingItem = explicitEstimateItem ?? (productId
    ? await db
        .prepare(
          `SELECT * FROM trip_list_items
           WHERE trip_id = ? AND product_id = ?
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .bind(trip.id, productId)
        .first<ListItemRow>()
    : await db
        .prepare(
          `SELECT * FROM trip_list_items
           WHERE trip_id = ? AND LOWER(TRIM(label)) = LOWER(TRIM(?))
           ORDER BY created_at ASC
           LIMIT 1`
        )
        .bind(trip.id, label)
        .first<ListItemRow>());

  if (existingItem) {
    if (
      trip.status === "frozen" &&
      existingItem.included_at_freeze === 1 &&
      estimateWasProvided &&
      requestedEstimatedPriceCents !== existingItem.estimated_price_cents
    ) {
      throw new ApiError(
        409,
        "Starting-list estimates cannot change after shopping starts"
      );
    }
    const reusedEstimateCents =
      requestedEstimatedPriceCents ??
      catalogMatch?.latest_regular_unit_price_cents ??
      existingItem.estimated_price_cents;
    const reusedQuantityMilli =
      body.quantityMilli === undefined
        ? existingItem.quantity_milli
        : quantityMilli;
    const update = await db
      .prepare(
        `UPDATE trip_list_items
         SET included = ?,
             checked = CASE
               WHEN ? = 0 OR included = 0 THEN 0
               ELSE checked
             END,
             estimated_price_cents = ?, quantity_milli = ?,
             source = CASE
               WHEN (
                 SELECT trips.status FROM trips
                 WHERE trips.id = trip_list_items.trip_id
                   AND trips.household_id = ?
               ) = 'frozen' AND ? = 'manual'
               THEN 'in_store'
               ELSE source
             END,
             added_after_freeze = CASE
               WHEN (
                 SELECT trips.status FROM trips
                 WHERE trips.id = trip_list_items.trip_id
                   AND trips.household_id = ?
               ) = 'planning'
               THEN 0
               WHEN ? = 1 AND COALESCE(included_at_freeze, 0) = 0
               THEN 1
               ELSE added_after_freeze
             END,
             updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM trips
             WHERE trips.id = trip_list_items.trip_id
               AND trips.household_id = ?
               AND trips.status IN ('planning', 'frozen')
           )`
      )
      .bind(
        included ? 1 : 0,
        included ? 1 : 0,
        reusedEstimateCents,
        reusedQuantityMilli,
        context.household.id,
        requestedSource,
        context.household.id,
        included ? 1 : 0,
        now,
        existingItem.id,
        context.household.id
      )
      .run();
    if ((update.meta.changes ?? 0) < 1) {
      throw new ApiError(
        409,
        "List items can only be added while a trip is being planned or shopped"
      );
    }

    const reusedItem = await db
      .prepare(`SELECT * FROM trip_list_items WHERE id = ? LIMIT 1`)
      .bind(existingItem.id)
      .first<ListItemRow>();
    if (!reusedItem) throw new ApiError(500, "Unable to add the list item");

    return listMutationResponse(reusedItem);
  }

  const id = crypto.randomUUID();

  const insert = await db
    .prepare(
      `INSERT INTO trip_list_items (
        id, trip_id, product_id, label, section, source,
        recommendation_reason, confidence_bps, included, checked,
        included_at_freeze, added_after_freeze, estimated_price_cents,
        quantity_milli, sort_order, added_by_member_id, created_at, updated_at
      )
      SELECT
        ?, trips.id, ?, ?, ?,
        CASE
          WHEN trips.status = 'frozen' AND ? = 'manual' THEN 'in_store'
          ELSE ?
        END,
        ?, ?, ?, 0,
        CASE WHEN trips.status = 'frozen' THEN 0 ELSE NULL END,
        CASE WHEN trips.status = 'frozen' THEN 1 ELSE 0 END,
        ?, ?,
        (SELECT COALESCE(MAX(sort_order), -1) + 1
         FROM trip_list_items WHERE trip_id = trips.id),
        ?, ?, ?
      FROM trips
      WHERE trips.id = ?
        AND trips.household_id = ?
        AND trips.status IN ('planning', 'frozen')`
    )
    .bind(
      id,
      productId,
      label,
      section,
      requestedSource,
      requestedSource,
      recommendationReason,
      confidenceBps,
      included ? 1 : 0,
      estimatedPriceCents,
      quantityMilli,
      context.member.id,
      now,
      now,
      trip.id,
      context.household.id
    )
    .run();
  if ((insert.meta.changes ?? 0) < 1) {
    throw new ApiError(
      409,
      "List items can only be added while a trip is being planned or shopped"
    );
  }

  const item = await db
    .prepare(`SELECT * FROM trip_list_items WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ListItemRow>();
  if (!item) throw new ApiError(500, "Unable to add the list item");

  return listMutationResponse(item, 201);
}

async function addFeedback(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  let tripId = optionalId(body.tripId, "tripId");
  const receiptTransactionId = optionalId(
    body.receiptTransactionId,
    "receiptTransactionId"
  );
  const listItemId = optionalId(body.listItemId, "listItemId");
  const receiptItemId = optionalId(body.receiptItemId, "receiptItemId");

  if (!tripId && !receiptTransactionId && !listItemId && !receiptItemId) {
    throw new ApiError(
      400,
      "Feedback must reference a trip, receipt, list item, or receipt item"
    );
  }

  if (tripId) {
    await authorizedTrip(db, context.household.id, tripId);
  }

  if (receiptTransactionId) {
    const receipt = await db
      .prepare(
        `SELECT id, trip_id FROM receipt_transactions
         WHERE id = ? AND household_id = ? LIMIT 1`
      )
      .bind(receiptTransactionId, context.household.id)
      .first<{ id: string; trip_id: string | null }>();
    if (!receipt) throw new ApiError(404, "Receipt transaction not found");
    if (tripId && receipt.trip_id && tripId !== receipt.trip_id) {
      throw new ApiError(400, "receiptTransactionId does not belong to tripId");
    }
    tripId ??= receipt.trip_id;
  }

  if (listItemId) {
    const listItem = await authorizedListItem(
      db,
      context.household.id,
      listItemId
    );
    if (tripId && tripId !== listItem.trip_id) {
      throw new ApiError(400, "listItemId does not belong to tripId");
    }
    tripId ??= listItem.trip_id;
  }

  if (receiptItemId) {
    const receiptItem = await db
      .prepare(
        `SELECT receipt_items.id, receipt_transactions.trip_id
         FROM receipt_items
         INNER JOIN receipt_transactions
           ON receipt_transactions.id = receipt_items.receipt_transaction_id
         WHERE receipt_items.id = ? AND receipt_transactions.household_id = ?
         LIMIT 1`
      )
      .bind(receiptItemId, context.household.id)
      .first<ReceiptItemOwnershipRow>();
    if (!receiptItem) throw new ApiError(404, "Receipt item not found");
    if (tripId && receiptItem.trip_id && tripId !== receiptItem.trip_id) {
      throw new ApiError(400, "receiptItemId does not belong to tripId");
    }
    tripId ??= receiptItem.trip_id;
  }

  const kindValue = body.kind;
  if (
    typeof kindValue !== "string" ||
    !FEEDBACK_KINDS.has(kindValue as FeedbackKind)
  ) {
    throw new ApiError(400, "kind is invalid");
  }
  const kind = kindValue as FeedbackKind;
  const value = requiredString(body.value, "value", 120);
  const rating = optionalInteger(body.rating, "rating", 1, 5);
  const note =
    body.note === undefined || body.note === null || body.note === ""
      ? null
      : requiredString(body.note, "note", 500);
  const id = crypto.randomUUID();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO feedback (
        id, household_id, trip_id, receipt_transaction_id,
        list_item_id, receipt_item_id,
        kind, value, rating, note, created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      context.household.id,
      tripId,
      receiptTransactionId,
      listItemId,
      receiptItemId,
      kind,
      value,
      rating,
      note,
      context.member.id,
      now
    )
    .run();

  const row = await db
    .prepare(`SELECT * FROM feedback WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<FeedbackRow>();
  if (!row) throw new ApiError(500, "Unable to save feedback");

  return json({ feedback: feedbackSummary(row) }, 201);
}

async function setProductMemory(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const productId = requiredString(body.productId, "productId", 128);
  if (!isProductMemoryPreference(body.preference)) {
    throw new ApiError(400, "preference is invalid");
  }
  const preference = body.preference;
  const note =
    body.note === undefined || body.note === null || body.note === ""
      ? null
      : requiredString(body.note, "note", 500);
  const product = await db
    .prepare(
      `SELECT id FROM products
       WHERE id = ? AND household_id = ? AND active = 1
       LIMIT 1`
    )
    .bind(productId, context.household.id)
    .first<{ id: string }>();
  if (!product) throw new ApiError(404, "Product not found");

  const source = await db
    .prepare(
      `SELECT receipt_items.id AS receipt_item_id,
              receipt_transactions.id AS receipt_transaction_id,
              receipt_transactions.trip_id,
              receipt_transactions.purchased_at
       FROM receipt_items
       INNER JOIN receipt_transactions
         ON receipt_transactions.id = receipt_items.receipt_transaction_id
       WHERE receipt_items.product_id = ?
         AND receipt_transactions.household_id = ?
         AND receipt_items.is_return = 0
         AND receipt_items.net_amount_cents > 0
         AND receipt_transactions.parse_status = 'reconciled'
       ORDER BY receipt_transactions.purchased_at DESC,
                receipt_items.source_line_number DESC,
                receipt_items.id DESC
       LIMIT 1`
    )
    .bind(productId, context.household.id)
    .first<{
      receipt_item_id: string;
      receipt_transaction_id: string;
      trip_id: string | null;
      purchased_at: string;
    }>();
  if (!source) {
    throw new ApiError(
      409,
      "BasketSense needs a reconciled receipt purchase before it can remember this product"
    );
  }

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO feedback (
        id, household_id, trip_id, receipt_transaction_id,
        list_item_id, receipt_item_id, product_id, kind, value, rating, note,
        created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'product_experience', ?, NULL, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      context.household.id,
      source.trip_id,
      source.receipt_transaction_id,
      source.receipt_item_id,
      productId,
      preference,
      note,
      context.member.id,
      now
    )
    .run();

  return json({
    productId,
    memory: {
      preference,
      note,
      updatedAt: now,
      sourcePurchasedAt: source.purchased_at,
    },
  });
}

async function setListItemBoolean(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>,
  column: "included" | "checked"
) {
  const itemId = requiredString(body.itemId, "itemId", 128);
  const item = await authorizedListItem(db, context.household.id, itemId);
  if (item.trip_status === "completed") {
    throw new ApiError(409, "Completed trips cannot be changed");
  }

  const value = requiredBoolean(body[column], column);
  if (column === "checked" && value && !Boolean(item.included)) {
    throw new ApiError(409, "Only active list items can be checked");
  }
  const now = nowIso();
  const statement =
    column === "included"
      ? `UPDATE trip_list_items
         SET included = ?,
             checked = 0,
             added_after_freeze = CASE
               WHEN (
                 SELECT trips.status FROM trips
                 WHERE trips.id = trip_list_items.trip_id
                   AND trips.household_id = ?
               ) = 'planning'
               THEN 0
               WHEN ? = 1
                 AND COALESCE(included_at_freeze, 0) = 0
               THEN 1
               ELSE added_after_freeze
             END,
             updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM trips
             WHERE trips.id = trip_list_items.trip_id
               AND trips.household_id = ?
               AND trips.status IN ('planning', 'frozen')
           )`
      : `UPDATE trip_list_items
         SET checked = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM trips
             WHERE trips.id = trip_list_items.trip_id
               AND trips.household_id = ?
               AND trips.status IN ('planning', 'frozen')
           )
           AND (
             ? = 0
             OR (
               included = 1
               AND EXISTS (
                 SELECT 1 FROM trips
                 WHERE trips.id = trip_list_items.trip_id
                   AND trips.household_id = ?
                   AND trips.status = 'frozen'
               )
             )
           )`;

  let changes = 0;
  if (column === "included") {
    const update = await db
      .prepare(statement)
      .bind(
        value ? 1 : 0,
        context.household.id,
        value ? 1 : 0,
        now,
        item.id,
        context.household.id
      )
      .run();
    changes = update.meta.changes ?? 0;
  } else {
    const update = await db
      .prepare(statement)
      .bind(
        value ? 1 : 0,
        now,
        item.id,
        context.household.id,
        value ? 1 : 0,
        context.household.id
      )
      .run();
    changes = update.meta.changes ?? 0;
  }
  if (changes < 1) {
    if (column === "checked" && value) {
      throw new ApiError(
        409,
        "Only active list items can be checked while shopping"
      );
    }
    throw new ApiError(
      409,
      "List items can only be changed while a trip is being planned or shopped"
    );
  }

  const updated = await db
    .prepare(`SELECT * FROM trip_list_items WHERE id = ? LIMIT 1`)
    .bind(item.id)
    .first<ListItemRow>();
  if (!updated) throw new ApiError(500, "Unable to update the list item");
  if (column === "checked" && value && !Boolean(updated.included)) {
    throw new ApiError(409, "Only active list items can be checked");
  }

  return listMutationResponse(updated);
}

async function ensureIntentSnapshot(
  db: D1Database,
  context: HouseholdContext,
  trip: TripRow,
  evidenceLevel: "pre_trip" | "upload_fallback"
) {
  const existingSnapshot = await db
    .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(trip.id)
    .first<IntentSnapshotRow>();
  if (existingSnapshot) return existingSnapshot;

  const includedExpression =
    trip.status === "planning"
      ? "trip_list_items.included"
      : "COALESCE(trip_list_items.included_at_freeze, trip_list_items.included)";
  const snapshotId = crypto.randomUUID();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO trip_intent_snapshots (
          id, trip_id, evidence_level, estimated_total_cents,
          priced_item_count, unpriced_item_count, captured_by_member_id,
          captured_at, created_at
        )
        SELECT ?, ?, ?,
          COALESCE(SUM(
            CASE
              WHEN ${includedExpression} = 1
                AND trip_list_items.estimated_price_cents IS NOT NULL
              THEN CAST((trip_list_items.estimated_price_cents *
                         trip_list_items.quantity_milli + 500) / 1000 AS INTEGER)
              ELSE 0
            END
          ), 0),
          COALESCE(SUM(
            CASE
              WHEN ${includedExpression} = 1
                AND trip_list_items.estimated_price_cents IS NOT NULL
              THEN 1 ELSE 0
            END
          ), 0),
          COALESCE(SUM(
            CASE
              WHEN ${includedExpression} = 1
                AND trip_list_items.estimated_price_cents IS NULL
              THEN 1 ELSE 0
            END
          ), 0),
          ?, ?, ?
        FROM trip_list_items
        WHERE trip_id = ?
        ON CONFLICT(trip_id) DO NOTHING`
      )
      .bind(
        snapshotId,
        trip.id,
        evidenceLevel,
        context.member.id,
        now,
        now,
        trip.id
      ),
    db
      .prepare(
        `INSERT INTO trip_intent_items (
          id, snapshot_id, trip_id, list_item_id, product_id, label,
          section, source, recommendation_reason, confidence_bps, included,
          quantity_milli, estimated_price_cents, sort_order, created_at
        )
        SELECT ? || ':' || trip_list_items.id, ?, trip_list_items.trip_id,
          trip_list_items.id, trip_list_items.product_id, trip_list_items.label,
          trip_list_items.section, trip_list_items.source,
          trip_list_items.recommendation_reason, trip_list_items.confidence_bps,
          ${includedExpression}, trip_list_items.quantity_milli,
          trip_list_items.estimated_price_cents, trip_list_items.sort_order, ?
        FROM trip_list_items
        WHERE trip_list_items.trip_id = ?
          AND EXISTS (
            SELECT 1 FROM trip_intent_snapshots
            WHERE id = ? AND trip_id = ?
          )
        ON CONFLICT(snapshot_id, list_item_id) DO NOTHING`
      )
      .bind(
        snapshotId,
        snapshotId,
        now,
        trip.id,
        snapshotId,
        trip.id
      ),
  ]);

  const snapshot = await db
    .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(trip.id)
    .first<IntentSnapshotRow>();
  if (!snapshot) throw new ApiError(500, "Unable to preserve the saved trip plan");
  return snapshot;
}

async function freezeTrip(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const tripId = requiredString(body.tripId, "tripId", 128);
  const trip = await authorizedTrip(db, context.household.id, tripId);
  if (trip.status === "completed") {
    throw new ApiError(409, "Completed trips cannot be frozen");
  }

  if (trip.status === "planning") {
    const now = nowIso();
    const snapshotId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          `UPDATE trip_list_items AS item
           SET included_at_freeze = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM trip_intent_snapshots
                   WHERE trip_id = item.trip_id
                 )
                 THEN COALESCE((
                   SELECT intent.included
                   FROM trip_intent_items AS intent
                   INNER JOIN trip_intent_snapshots AS snapshot
                     ON snapshot.id = intent.snapshot_id
                   WHERE snapshot.trip_id = item.trip_id
                     AND intent.list_item_id = item.id
                   LIMIT 1
                 ), 0)
                 ELSE item.included
               END,
               added_after_freeze = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM trip_intent_snapshots
                   WHERE trip_id = item.trip_id
                 )
                   AND item.included = 1
                   AND COALESCE((
                     SELECT intent.included
                     FROM trip_intent_items AS intent
                     INNER JOIN trip_intent_snapshots AS snapshot
                       ON snapshot.id = intent.snapshot_id
                     WHERE snapshot.trip_id = item.trip_id
                       AND intent.list_item_id = item.id
                     LIMIT 1
                   ), 0) = 0
                 THEN 1
                 ELSE 0
               END,
               updated_at = ?
           WHERE item.trip_id = ? AND item.included_at_freeze IS NULL
             AND EXISTS (
               SELECT 1 FROM trips
               WHERE id = ? AND household_id = ? AND status = 'planning'
             )`
        )
        .bind(now, trip.id, trip.id, context.household.id),
      db
        .prepare(
          `INSERT INTO trip_intent_snapshots (
            id, trip_id, evidence_level, estimated_total_cents,
            priced_item_count, unpriced_item_count, captured_by_member_id,
            captured_at, created_at
          )
          SELECT ?, trips.id, 'pre_trip',
            (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NOT NULL
                     THEN CAST((estimated_price_cents * quantity_milli + 500) / 1000 AS INTEGER)
                     ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = trips.id
               ),
            (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NOT NULL
                     THEN 1 ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = trips.id
               ),
            (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NULL
                     THEN 1 ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = trips.id
               ),
            ?, ?, ?
          FROM trips
          WHERE trips.id = ? AND trips.household_id = ?
            AND trips.status = 'planning'
          ON CONFLICT(trip_id) DO NOTHING`
        )
        .bind(
          snapshotId,
          context.member.id,
          now,
          now,
          trip.id,
          context.household.id
        ),
      db
        .prepare(
          `INSERT INTO trip_intent_items (
            id, snapshot_id, trip_id, list_item_id, product_id, label,
            section, source, recommendation_reason, confidence_bps, included,
            quantity_milli, estimated_price_cents, sort_order, created_at
          )
          SELECT ? || ':' || item.id, ?, item.trip_id, item.id,
            item.product_id, item.label, item.section, item.source,
            item.recommendation_reason, item.confidence_bps,
            item.included_at_freeze, item.quantity_milli,
            item.estimated_price_cents, item.sort_order, ?
          FROM trip_list_items AS item
          INNER JOIN trips ON trips.id = item.trip_id
          WHERE item.trip_id = ? AND trips.household_id = ?
            AND trips.status = 'planning'
            AND item.included_at_freeze IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM trip_intent_snapshots
              WHERE id = ? AND trip_id = item.trip_id
            )
          ON CONFLICT(snapshot_id, list_item_id) DO NOTHING`
        )
        .bind(
          snapshotId,
          snapshotId,
          now,
          trip.id,
          context.household.id,
          snapshotId
        ),
      db
        .prepare(
          `UPDATE trips
           SET status = 'frozen', frozen_at = COALESCE(frozen_at, ?),
               estimated_list_total_at_freeze_cents = COALESCE((
                 SELECT estimated_total_cents FROM trip_intent_snapshots
                 WHERE trip_id = trips.id
               ), 0),
               estimated_priced_item_count_at_freeze = COALESCE((
                 SELECT priced_item_count FROM trip_intent_snapshots
                 WHERE trip_id = trips.id
               ), 0),
               estimated_unpriced_item_count_at_freeze = COALESCE((
                 SELECT unpriced_item_count FROM trip_intent_snapshots
                 WHERE trip_id = trips.id
               ), 0),
               updated_at = ?
           WHERE id = ? AND household_id = ? AND status = 'planning'
             AND EXISTS (
               SELECT 1 FROM trip_intent_snapshots
               WHERE trip_id = trips.id
             )`
        )
        .bind(now, now, trip.id, context.household.id),
    ]);
  }

  const frozenSnapshot = await db
    .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(trip.id)
    .first<{ id: string }>();
  if (!frozenSnapshot) {
    throw new ApiError(500, "Unable to preserve the saved trip plan");
  }

  const [updatedTrip, itemsResult] = await Promise.all([
    authorizedTrip(db, context.household.id, trip.id),
    db
      .prepare(
        `SELECT * FROM trip_list_items
         WHERE trip_id = ?
         ORDER BY sort_order ASC, created_at ASC`
      )
      .bind(trip.id)
      .all<ListItemRow>(),
  ]);

  return json({
    trip: tripSummary(updatedTrip),
    listItems: itemsResult.results.map(listItemSummary),
  });
}

async function unfreezeTrip(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const tripId = requiredString(body.tripId, "tripId", 128);
  const trip = await authorizedTrip(db, context.household.id, tripId);
  if (trip.status === "completed") {
    throw new ApiError(409, "Completed trips cannot return to planning");
  }
  if (trip.id !== context.currentTrip.id) {
    throw new ApiError(
      409,
      "Only the current shopping trip can return to planning"
    );
  }

  const linkedReceipt = await db
    .prepare(
      `SELECT id FROM receipt_transactions
       WHERE household_id = ? AND trip_id = ?
       LIMIT 1`
    )
    .bind(context.household.id, trip.id)
    .first<{ id: string }>();
  if (linkedReceipt) {
    throw new ApiError(
      409,
      "Shopping cannot be undone after receipt evidence has been added"
    );
  }
  if (trip.status === "planning") {
    const itemsResult = await db
      .prepare(
        `SELECT * FROM trip_list_items
         WHERE trip_id = ?
         ORDER BY sort_order ASC, created_at ASC`
      )
      .bind(trip.id)
      .all<ListItemRow>();
    return json({
      trip: tripSummary(trip),
      listItems: itemsResult.results.map(listItemSummary),
    });
  }
  if (trip.status !== "frozen") {
    throw new ApiError(409, "This trip is not in shopping mode");
  }

  const now = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM trip_intent_snapshots
         WHERE trip_id = ?
           AND EXISTS (
             SELECT 1 FROM trips
             WHERE id = ? AND household_id = ? AND status = 'frozen'
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipt_transactions
             WHERE household_id = ? AND trip_id = ?
           )`
      )
      .bind(
        trip.id,
        trip.id,
        context.household.id,
        context.household.id,
        trip.id
      ),
    db
      .prepare(
        `UPDATE trip_list_items
         SET source = CASE WHEN source = 'in_store' THEN 'manual' ELSE source END,
             checked = 0, included_at_freeze = NULL, added_after_freeze = 0,
             updated_at = ?
         WHERE trip_id = ?
           AND EXISTS (
             SELECT 1 FROM trips
             WHERE id = ? AND household_id = ? AND status = 'frozen'
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipt_transactions
             WHERE household_id = ? AND trip_id = ?
           )`
      )
      .bind(
        now,
        trip.id,
        trip.id,
        context.household.id,
        context.household.id,
        trip.id
      ),
    db
      .prepare(
        `UPDATE trips
         SET status = 'planning', frozen_at = NULL,
             estimated_list_total_at_freeze_cents = NULL,
             estimated_priced_item_count_at_freeze = NULL,
             estimated_unpriced_item_count_at_freeze = NULL,
             updated_at = ?
         WHERE id = ? AND household_id = ? AND status = 'frozen'
           AND NOT EXISTS (
             SELECT 1 FROM receipt_transactions
             WHERE household_id = ? AND trip_id = ?
           )`
      )
      .bind(
        now,
        trip.id,
        context.household.id,
        context.household.id,
        trip.id
      ),
  ]);

  if ((results[2]?.meta.changes ?? 0) < 1) {
    const receiptAfterRace = await db
      .prepare(
        `SELECT id FROM receipt_transactions
         WHERE household_id = ? AND trip_id = ? LIMIT 1`
      )
      .bind(context.household.id, trip.id)
      .first<{ id: string }>();
    if (receiptAfterRace) {
      throw new ApiError(
        409,
        "Shopping cannot be undone after receipt evidence has been added"
      );
    }
    throw new ApiError(409, "This trip is no longer in shopping mode");
  }

  const [updatedTrip, itemsResult] = await Promise.all([
    authorizedTrip(db, context.household.id, trip.id),
    db
      .prepare(
        `SELECT * FROM trip_list_items
         WHERE trip_id = ?
         ORDER BY sort_order ASC, created_at ASC`
      )
      .bind(trip.id)
      .all<ListItemRow>(),
  ]);

  return json({
    trip: tripSummary(updatedTrip),
    listItems: itemsResult.results.map(listItemSummary),
  });
}

async function reopenSandboxTrip(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  if (context.household.id !== SANDBOX_HOUSEHOLD_ID || context.member.role !== "owner") {
    throw new ApiError(403, "Only the owner can reopen a disposable test trip");
  }

  const tripId = requiredString(body.tripId, "tripId", 128);
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const trip = await authorizedTrip(db, context.household.id, tripId);
  const receipt = await authorizedReceipt(db, context.household.id, receiptId);
  if (trip.status !== "completed" || receipt.trip_id !== trip.id || receipt.source_type !== "receipt_photo") {
    throw new ApiError(409, "Only a completed sandbox receipt can be reopened for testing");
  }

  // This is intentionally limited to the owner-only disposable household. It
  // restores a needs-review receipt and its trip so the list and receipt can be
  // changed, then finalized again, without weakening shared-history immutability.
  const now = nowIso();
  await db.batch([
    db.prepare(`DELETE FROM trip_item_matches WHERE household_id = ? AND trip_id = ?`)
      .bind(context.household.id, trip.id),
    db.prepare(`DELETE FROM review_questions WHERE household_id = ? AND trip_id = ?`)
      .bind(context.household.id, trip.id),
    db.prepare(`DELETE FROM trip_intent_snapshots WHERE trip_id = ?`)
      .bind(trip.id),
    db.prepare(
      `UPDATE trip_list_items
       SET source = CASE WHEN source = 'in_store' THEN 'manual' ELSE source END,
           checked = 0, included_at_freeze = NULL, added_after_freeze = 0,
           updated_at = ?
       WHERE trip_id = ?`,
    ).bind(now, trip.id),
    db.prepare(
      `UPDATE receipt_transactions
       SET parse_status = 'needs_review',
           audit_flag = CASE WHEN item_count = 0
             THEN 'closed_loop_totals_only_draft'
             ELSE 'closed_loop_draft'
           END,
           updated_at = ?
       WHERE id = ? AND household_id = ?`,
    ).bind(now, receipt.id, context.household.id),
    db.prepare(
      `UPDATE trips
       SET status = 'planning', frozen_at = NULL, completed_at = NULL,
           estimated_list_total_at_freeze_cents = NULL,
           estimated_priced_item_count_at_freeze = NULL,
           estimated_unpriced_item_count_at_freeze = NULL,
           updated_at = ?
       WHERE id = ? AND household_id = ? AND status = 'completed'`,
    ).bind(now, trip.id, context.household.id),
  ]);

  const reopenedTrip = await authorizedTrip(db, context.household.id, trip.id);
  if (reopenedTrip.status !== "planning") {
    throw new ApiError(409, "This sandbox trip could not be reopened");
  }
  return json({ trip: tripSummary(reopenedTrip), reopened: true });
}

interface ValidatedDraftItem {
  sourceLineNumber: number;
  costcoItemNumber: string | null;
  rawDescription: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  lineSubtotalCents: number;
  discountCents: number;
  netAmountCents: number;
  kind: "item" | "discount";
  taxStatus: "taxable" | "non_taxable" | "unknown";
  isReturn: boolean;
}

function draftDiscountAppliesToPrevious(
  previous: ValidatedDraftItem | undefined,
  current: ValidatedDraftItem
) {
  if (
    !previous ||
    previous.kind !== "item" ||
    previous.lineSubtotalCents <= 0 ||
    current.kind !== "discount" ||
    current.discountCents <= 0 ||
    current.netAmountCents >= 0
  ) {
    return false;
  }
  if (current.costcoItemNumber) {
    return (
      current.costcoItemNumber === previous.costcoItemNumber ||
      Boolean(
        previous.costcoItemNumber &&
          current.rawDescription.includes(previous.costcoItemNumber)
      )
    );
  }
  return (
    /\b(?:coupon|discount|instant\s+savings|rebate|mfr)\b/i.test(
      current.rawDescription
    ) || /^\d+\s*\/\s*\d+$/.test(current.rawDescription)
  );
}

function foldAttachedDraftDiscounts(items: ValidatedDraftItem[]) {
  const folded: ValidatedDraftItem[] = [];
  for (const item of items) {
    const previous = folded.at(-1);
    if (draftDiscountAppliesToPrevious(previous, item) && previous) {
      previous.discountCents += item.discountCents;
      previous.netAmountCents =
        previous.lineSubtotalCents - previous.discountCents;
      continue;
    }
    folded.push(item);
  }
  return folded;
}

function requiredInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
) {
  const parsed = optionalInteger(value, field, minimum, maximum);
  if (parsed === null) throw new ApiError(400, `${field} is required`);
  return parsed;
}

function requiredDateTime(value: unknown, field: string) {
  const raw = requiredString(value, field, 64);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${field} must be a valid date`);
  }
  return date.toISOString();
}

const RECEIPT_TRIP_DATE_TOLERANCE_DAYS = 14;

function receiptDateForTrip(
  value: unknown,
  trip: TripRow,
  field = "purchasedAt"
) {
  const parsed = requiredDateTime(value, field);
  const purchasedOn = parsed.slice(0, 10);
  const scheduledFor = trip.scheduled_for.slice(0, 10);

  if (
    purchasedOn.slice(5) === scheduledFor.slice(5) &&
    purchasedOn.slice(0, 4) !== scheduledFor.slice(0, 4)
  ) {
    return `${scheduledFor}T00:00:00.000Z`;
  }

  const purchasedDay = Date.parse(`${purchasedOn}T00:00:00.000Z`);
  const scheduledDay = Date.parse(`${scheduledFor}T00:00:00.000Z`);
  const dayDistance = Math.abs(purchasedDay - scheduledDay) / 86_400_000;
  if (dayDistance > RECEIPT_TRIP_DATE_TOLERANCE_DAYS) {
    throw new ApiError(
      400,
      `${field} must be within ${RECEIPT_TRIP_DATE_TOLERANCE_DAYS} days of the trip date`
    );
  }

  return parsed;
}

function validateDraftItems(
  value: unknown,
  allowTotalsOnly = false
): ValidatedDraftItem[] {
  if (!Array.isArray(value) || (value.length === 0 && !allowTotalsOnly)) {
    throw new ApiError(400, "items must contain at least one receipt line unless this is a totals-only receipt");
  }
  if (value.length > 200) {
    throw new ApiError(400, "items cannot contain more than 200 lines");
  }

  const seenLines = new Set<number>();
  const parsed: ValidatedDraftItem[] = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(400, `items[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    const lineValue = item.sourceLineNumber ?? item.lineNumber;
    const sourceLineNumber = requiredInteger(
      lineValue,
      `items[${index}].sourceLineNumber`,
      1,
      10_000
    );
    if (seenLines.has(sourceLineNumber)) {
      throw new ApiError(400, "Receipt line numbers must be unique");
    }
    seenLines.add(sourceLineNumber);

    const rawDescription = requiredString(
      item.rawDescription,
      `items[${index}].rawDescription`,
      180
    );
    const costcoItemNumber = optionalId(
      item.costcoItemNumber,
      `items[${index}].costcoItemNumber`
    );
    const quantityMilli =
      optionalInteger(
        item.quantityMilli,
        `items[${index}].quantityMilli`,
        1,
        1_000_000
      ) ?? 1000;
    const unitPriceCents = optionalInteger(
      item.unitPriceCents,
      `items[${index}].unitPriceCents`,
      -10_000_000,
      10_000_000
    );
    const lineSubtotalCents = requiredInteger(
      item.lineSubtotalCents,
      `items[${index}].lineSubtotalCents`,
      -10_000_000,
      10_000_000
    );
    const discountCents =
      optionalInteger(
        item.discountCents,
        `items[${index}].discountCents`,
        0,
        10_000_000
      ) ?? 0;
    const netAmountCents =
      optionalInteger(
        item.netAmountCents,
        `items[${index}].netAmountCents`,
        -10_000_000,
        10_000_000
      ) ?? lineSubtotalCents - discountCents;
    if (Math.abs(netAmountCents - (lineSubtotalCents - discountCents)) > 5) {
      throw new ApiError(
        400,
        `items[${index}] net amount does not match subtotal minus discount`
      );
    }
    const taxStatus =
      item.taxStatus === "taxable" || item.taxStatus === "non_taxable"
        ? item.taxStatus
        : "unknown";
    const kind =
      item.kind === "discount" ||
      (discountCents > 0 && lineSubtotalCents <= 0 && netAmountCents < 0)
        ? "discount"
        : "item";

    return {
      sourceLineNumber,
      costcoItemNumber,
      rawDescription,
      quantityMilli,
      unitPriceCents,
      lineSubtotalCents,
      discountCents,
      netAmountCents,
      kind,
      taxStatus,
      isReturn:
        kind === "item" && lineSubtotalCents < 0 && discountCents === 0,
    };
  });
  return foldAttachedDraftDiscounts(parsed);
}

function isTotalsOnlyReceipt(receipt: Pick<ReceiptTransactionRow, "audit_flag">) {
  return receipt.audit_flag.includes("_totals_only");
}

function aliasKeyFor(
  costcoItemNumber: string | null,
  normalizedDescription: string
) {
  return costcoItemNumber
    ? `item:${costcoItemNumber}`
    : `description:${normalizedDescription}`;
}

function intentAliasKeyFor(normalizedDescription: string) {
  return `intent:${normalizedDescription}`;
}

async function resolveDraftProducts(
  db: D1Database,
  householdId: string,
  items: ValidatedDraftItem[]
) {
  const [productsResult, aliasesResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM products WHERE household_id = ? AND active = 1`)
      .bind(householdId)
      .all<ProductRow>(),
    db
      .prepare(`SELECT * FROM product_aliases WHERE household_id = ?`)
      .bind(householdId)
      .all<ProductAliasRow>(),
  ]);
  const productsByNumber = new Map(
    productsResult.results
      .filter((product) => product.costco_item_number)
      .map((product) => [product.costco_item_number as string, product])
  );
  const productsById = new Map(
    productsResult.results.map((product) => [product.id, product])
  );
  const productsByName = new Map(
    productsResult.results.map((product) => [
      normalizeReceiptDescription(product.canonical_name),
      product,
    ])
  );
  const aliasesByKey = new Map(
    aliasesResult.results.map((alias) => [alias.alias_key, alias])
  );

  return items.map((item) => {
    if (item.kind === "discount") {
      return { item, product: null, confidenceBps: 10_000 };
    }
    const normalized = normalizeReceiptDescription(item.rawDescription);
    const numbered = item.costcoItemNumber
      ? productsByNumber.get(item.costcoItemNumber)
      : undefined;
    if (numbered) {
      return { item, product: numbered, confidenceBps: 10_000 };
    }
    const alias = aliasesByKey.get(
      aliasKeyFor(item.costcoItemNumber, normalized)
    );
    const aliasedProduct = alias ? productsById.get(alias.product_id) : null;
    if (aliasedProduct) {
      return { item, product: aliasedProduct, confidenceBps: 9_900 };
    }
    const named = productsByName.get(normalized);
    if (named) {
      return { item, product: named, confidenceBps: 9_400 };
    }
    return { item, product: null, confidenceBps: 0 };
  });
}

async function promoteAdHocReceiptProducts(
  db: D1Database,
  context: HouseholdContext,
  receiptId: string,
  items: ReceiptItemRow[],
) {
  const [productsResult, aliasesResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM products WHERE household_id = ? AND active = 1`)
      .bind(context.household.id)
      .all<ProductRow>(),
    db
      .prepare(`SELECT * FROM product_aliases WHERE household_id = ?`)
      .bind(context.household.id)
      .all<ProductAliasRow>(),
  ]);
  const productsById = new Map(
    productsResult.results.map((product) => [product.id, product]),
  );
  const productsByNumber = new Map(
    productsResult.results
      .filter((product) => product.costco_item_number)
      .map((product) => [product.costco_item_number as string, product]),
  );
  const productsByName = new Map(
    productsResult.results.map((product) => [
      normalizeReceiptDescription(product.canonical_name),
      product,
    ]),
  );
  const aliasesByKey = new Map(
    aliasesResult.results.map((alias) => [alias.alias_key, alias]),
  );
  const linkedProductIds = new Set<string>();

  for (const item of items) {
    if (receiptItemKind(item) === "discount") continue;
    const normalized = normalizeReceiptDescription(item.raw_description);
    if (!normalized) continue;

    let product = item.product_id ? productsById.get(item.product_id) : undefined;
    let confidenceBps = product ? 10_000 : 0;
    if (!product && item.costco_item_number) {
      product = productsByNumber.get(item.costco_item_number);
      if (product) confidenceBps = 10_000;
    }
    if (!product) {
      const alias = aliasesByKey.get(
        aliasKeyFor(item.costco_item_number, normalized),
      );
      product = alias ? productsById.get(alias.product_id) : undefined;
      if (product) confidenceBps = 9_900;
    }
    if (!product) {
      product = productsByName.get(normalized);
      if (product) confidenceBps = 9_400;
    }

    if (!product) {
      const canonicalName = item.raw_description.trim();
      const classification = classifyReceiptItem({
        channel: "warehouse",
        itemNumber: item.costco_item_number ?? "",
        rawDescription: item.raw_description,
        canonicalName,
        taxStatus: item.tax_status,
      });
      const productId = crypto.randomUUID();
      const now = nowIso();
      if (item.costco_item_number) {
        await db
          .prepare(
            `INSERT INTO products (
              id, household_id, costco_item_number, canonical_name,
              category, category_status, catalog_revision,
              active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'ad-hoc-receipt-v1', 1, ?, ?)
            ON CONFLICT(household_id, costco_item_number) DO NOTHING`,
          )
          .bind(
            productId,
            context.household.id,
            item.costco_item_number,
            canonicalName,
            classification.key,
            classification.status,
            now,
            now,
          )
          .run();
        product = await db
          .prepare(
            `SELECT * FROM products
             WHERE household_id = ? AND costco_item_number = ? AND active = 1
             LIMIT 1`,
          )
          .bind(context.household.id, item.costco_item_number)
          .first<ProductRow>() ?? undefined;
      } else {
        await db
          .prepare(
            `INSERT INTO products (
              id, household_id, costco_item_number, canonical_name,
              category, category_status, catalog_revision,
              active, created_at, updated_at
            )
            SELECT ?, ?, NULL, ?, ?, ?, 'ad-hoc-receipt-v1', 1, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM products
              WHERE household_id = ? AND active = 1
                AND lower(trim(canonical_name)) = lower(trim(?))
            )`,
          )
          .bind(
            productId,
            context.household.id,
            canonicalName,
            classification.key,
            classification.status,
            now,
            now,
            context.household.id,
            canonicalName,
          )
          .run();
        product = await db
          .prepare(
            `SELECT * FROM products
             WHERE household_id = ? AND active = 1
               AND lower(trim(canonical_name)) = lower(trim(?))
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
          )
          .bind(context.household.id, canonicalName)
          .first<ProductRow>() ?? undefined;
      }
      if (!product) {
        throw new ApiError(500, "The receipt product could not be added to the catalog");
      }
      confidenceBps = 10_000;
      productsById.set(product.id, product);
      if (product.costco_item_number) {
        productsByNumber.set(product.costco_item_number, product);
      }
      productsByName.set(normalized, product);
    }

    const now = nowIso();
    const aliasKey = aliasKeyFor(item.costco_item_number, normalized);
    await db.batch([
      db
        .prepare(
          `INSERT INTO product_aliases (
            id, household_id, alias_key, raw_description,
            normalized_description, costco_item_number, product_id,
            confirmation_source, confirmed_by_member_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'receipt', NULL, ?, ?)
          ON CONFLICT(household_id, alias_key) DO UPDATE SET
            raw_description = excluded.raw_description,
            normalized_description = excluded.normalized_description,
            updated_at = excluded.updated_at`,
        )
        .bind(
          crypto.randomUUID(),
          context.household.id,
          aliasKey,
          item.raw_description,
          normalized,
          item.costco_item_number,
          product.id,
          now,
          now,
        ),
      db
        .prepare(
          `UPDATE receipt_items
           SET product_id = ?, normalization_status = 'normalized_from_history',
               match_confidence_bps = ?, updated_at = ?
           WHERE id = ? AND receipt_transaction_id = ?`,
        )
        .bind(product.id, confidenceBps, now, item.id, receiptId),
    ]);
    aliasesByKey.set(aliasKey, {
      id: "",
      household_id: context.household.id,
      alias_key: aliasKey,
      raw_description: item.raw_description,
      normalized_description: normalized,
      costco_item_number: item.costco_item_number,
      product_id: product.id,
      confirmation_source: "receipt",
    });
    linkedProductIds.add(product.id);
  }

  for (const productId of linkedProductIds) {
    const image = await db
      .prepare(
        `SELECT id FROM product_images
         WHERE product_id = ? AND household_id = ?
           AND status = 'approved' AND is_primary = 1
         LIMIT 1`,
      )
      .bind(productId, context.household.id)
      .first<{ id: string }>();
    if (image) continue;
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO product_image_jobs (
          id, household_id, product_id, receipt_transaction_id,
          status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
          receipt_transaction_id = excluded.receipt_transaction_id,
          status = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN 'queued'
            ELSE product_image_jobs.status
          END,
          attempt_count = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN 0
            ELSE product_image_jobs.attempt_count
          END,
          model = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN NULL
            ELSE product_image_jobs.model
          END,
          error_code = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN NULL
            ELSE product_image_jobs.error_code
          END,
          locked_at = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN NULL
            ELSE product_image_jobs.locked_at
          END,
          completed_at = CASE
            WHEN product_image_jobs.status IN ('generated', 'skipped', 'failed')
              THEN NULL
            ELSE product_image_jobs.completed_at
          END,
          updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(),
        context.household.id,
        productId,
        receiptId,
        now,
        now,
      )
      .run();
  }
}

async function authorizedReceipt(
  db: D1Database,
  householdId: string,
  receiptId: string
) {
  const receipt = await db
    .prepare(
      `SELECT * FROM receipt_transactions
       WHERE id = ? AND household_id = ? LIMIT 1`
    )
    .bind(receiptId, householdId)
    .first<ReceiptTransactionRow>();
  if (!receipt) throw new ApiError(404, "Receipt transaction not found");
  return receipt;
}

function receiptItemKind(
  row: Pick<
    ReceiptItemRow,
    "line_subtotal_cents" | "discount_cents" | "net_amount_cents"
  >
): "item" | "discount" {
  return row.discount_cents > 0 &&
    row.line_subtotal_cents <= 0 &&
    row.net_amount_cents < 0
    ? "discount"
    : "item";
}

function receiptItemSummary(row: ReceiptItemRow): ClosedLoopReceiptItem {
  return {
    id: row.id,
    sourceLineNumber: row.source_line_number,
    costcoItemNumber: row.costco_item_number,
    rawDescription: row.raw_description,
    productId: row.product_id,
    canonicalName: row.canonical_name ?? null,
    category: row.category ?? null,
    quantityMilli: row.quantity_milli,
    unitPriceCents: row.unit_price_cents,
    lineSubtotalCents: row.line_subtotal_cents,
    discountCents: row.discount_cents,
    netAmountCents: row.net_amount_cents,
    kind: receiptItemKind(row),
    taxStatus: row.tax_status,
    matchConfidenceBps: row.match_confidence_bps,
  };
}

function intentItemSummary(row: IntentItemRow): TripIntentItemSummary {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    listItemId: row.list_item_id,
    productId: row.product_id,
    costcoItemNumber: row.costco_item_number ?? null,
    label: row.label,
    section: row.section,
    source: row.source,
    recommendationReason: row.recommendation_reason,
    confidenceBps: row.confidence_bps,
    included: Boolean(row.included),
    quantityMilli: row.quantity_milli,
    estimatedPriceCents: row.estimated_price_cents,
    sortOrder: row.sort_order,
  };
}

function matchSummary(row: TripItemMatchRow): TripItemMatchSummary {
  return {
    id: row.id,
    intentItemId: row.intent_item_id,
    receiptItemId: row.receipt_item_id,
    matchType: row.match_type,
    confidenceBps: row.confidence_bps,
    resolutionSource: row.resolution_source,
  };
}

function safeQuestionOptions(value: string): ReviewQuestionOptionSummary[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (option): option is Record<string, unknown> =>
          Boolean(option) && typeof option === "object" && !Array.isArray(option)
      )
      .map((option) => ({
        value: typeof option.value === "string" ? option.value : "",
        label: typeof option.label === "string" ? option.label : "",
        effect: typeof option.effect === "string" ? option.effect : "",
      }))
      .filter((option) => option.value && option.label && option.effect);
  } catch {
    return [];
  }
}

function questionSummary(row: ReviewQuestionRow): ReviewQuestionSummary {
  return {
    id: row.id,
    purpose: row.purpose,
    prompt: row.prompt,
    options: safeQuestionOptions(row.options_json),
    status: row.status,
    selectedValue: row.answer_value,
    effectTarget: row.effect_target,
    declaredEffect: row.declared_effect,
    listItemId: row.list_item_id,
    intentItemId: row.intent_item_id,
    receiptItemId: row.receipt_item_id,
    answeredAt: row.answered_at,
  };
}

function toLogicIntent(row: IntentItemRow): ReceiptIntentItem {
  return {
    id: row.id,
    productId: row.product_id,
    costcoItemNumber: row.costco_item_number ?? null,
    frozenLabel: row.label,
    section: row.section,
    source: row.source,
    includedAtFreeze: Boolean(row.included),
    quantityMilli: row.quantity_milli,
    estimatedPriceCents: row.estimated_price_cents,
  };
}

function toLogicReceipt(row: ReceiptItemRow): MatchableReceiptItem {
  return {
    id: row.id,
    productId: row.product_id,
    costcoItemNumber: row.costco_item_number,
    rawDescription: row.raw_description,
    canonicalName: row.canonical_name ?? null,
    quantityMilli: row.quantity_milli,
    lineSubtotalCents: row.line_subtotal_cents,
    discountCents: row.discount_cents,
    netAmountCents: row.net_amount_cents,
    kind: receiptItemKind(row),
    isReturn: Boolean(row.is_return),
    // A missing catalog match is not a failed receipt parse. Once the household
    // has checked and saved the receipt, an uncataloged item is valid receipt
    // evidence and belongs in receipt-only additions rather than Needs review.
    parseConfidenceBps: row.match_confidence_bps ?? 9_000,
  };
}

function receiptPaidCents(item: ReceiptItemRow): number {
  return item.net_amount_cents;
}

export async function readFinalTripListEstimate(
  db: D1Database,
  tripId: string,
): Promise<TripListEstimateRow> {
  const estimate = await db
    .prepare(
      `SELECT
         COALESCE(SUM(
           CASE
             WHEN included = 1 AND estimated_price_cents IS NOT NULL
             THEN CAST((estimated_price_cents * quantity_milli + 500) / 1000 AS INTEGER)
             ELSE 0
           END
         ), 0) AS estimated_total_cents,
         COALESCE(SUM(
           CASE WHEN included = 1 AND estimated_price_cents IS NOT NULL THEN 1 ELSE 0 END
         ), 0) AS priced_item_count,
         COALESCE(SUM(
           CASE WHEN included = 1 AND estimated_price_cents IS NULL THEN 1 ELSE 0 END
         ), 0) AS unpriced_item_count
       FROM trip_list_items
       WHERE trip_id = ?`,
    )
    .bind(tripId)
    .first<TripListEstimateRow>();
  return estimate ?? {
    estimated_total_cents: 0,
    priced_item_count: 0,
    unpriced_item_count: 0,
  };
}

function buildClosedLoopComparison(
  receipt: ReceiptTransactionRow,
  snapshot: IntentSnapshotRow,
  finalListEstimate: TripListEstimateRow,
  intentItems: IntentItemRow[],
  receiptItems: ReceiptItemRow[],
  matches: TripItemMatchRow[],
  possibleSubstitutions: ReceiptIntentMatch[],
  arithmetic: ReturnType<typeof reconcileReceipt>
): ClosedLoopComparison {
  const intentById = new Map(intentItems.map((item) => [item.id, item]));
  const receiptById = new Map(receiptItems.map((item) => [item.id, item]));
  const matchedIntentIds = new Set(matches.map((match) => match.intent_item_id));
  const matchedReceiptIds = new Set(
    matches.map((match) => match.receipt_item_id)
  );
  let matchedVarianceCents = 0;
  let unpricedPlannedActualCents = 0;
  let additionsCents = 0;
  let skippedEstimateCents = 0;
  let unresolvedCents = 0;
  const matched: ClosedLoopComparison["buckets"]["matched"] = [];
  const unpricedPlanned: ClosedLoopComparison["buckets"]["unpricedPlanned"] = [];

  for (const match of matches) {
    const intent = intentById.get(match.intent_item_id);
    const item = receiptById.get(match.receipt_item_id);
    if (!intent || !item) continue;
    const paidCents = receiptPaidCents(item);
    if (!Boolean(intent.included)) {
      additionsCents += paidCents;
      continue;
    }
    if (intent.estimated_price_cents === null) {
      unpricedPlannedActualCents += paidCents;
      unpricedPlanned.push({
        intentItemId: intent.id,
        receiptItemId: item.id,
      });
      continue;
    }
    const estimate = Math.round(
      (intent.estimated_price_cents * intent.quantity_milli) / 1000
    );
    matchedVarianceCents += paidCents - estimate;
    matched.push({ intentItemId: intent.id, receiptItemId: item.id });
  }

  const skippedPlanned = intentItems
    .filter((item) => Boolean(item.included) && !matchedIntentIds.has(item.id))
    .map((item) => {
      if (item.estimated_price_cents !== null) {
        skippedEstimateCents += Math.round(
          (item.estimated_price_cents * item.quantity_milli) / 1000
        );
      }
      return { intentItemId: item.id };
    });
  const receiptOnly: Array<{ receiptItemId: string }> = [];
  const unresolved: Array<{ receiptItemId: string }> = [];
  for (const item of receiptItems) {
    if (matchedReceiptIds.has(item.id)) continue;
    const paidCents = receiptPaidCents(item);
    if (item.discount_cents > 0 && item.line_subtotal_cents === 0) continue;
    if (item.is_return) {
      unresolvedCents += paidCents;
      unresolved.push({ receiptItemId: item.id });
    } else {
      // Catalog membership is optional. A household-reviewed receipt line is
      // still valid purchase evidence even when it is new to BasketSense.
      additionsCents += paidCents;
      receiptOnly.push({ receiptItemId: item.id });
    }
  }

  return {
    isProvisional:
      receipt.parse_status !== "reconciled" || unresolved.length > 0 || isTotalsOnlyReceipt(receipt),
    isTotalsOnly: isTotalsOnlyReceipt(receipt),
    arithmetic: {
      isReconciled: arithmetic.isReconciled,
      itemNetCents: arithmetic.itemNetCents,
      subtotalDeltaCents: arithmetic.subtotalDeltaCents,
      totalDeltaCents: arithmetic.totalDeltaCents,
    },
    intentEvidence: snapshot.evidence_level,
    frozenEstimateCents: snapshot.estimated_total_cents,
    pricedIntentItemCount: snapshot.priced_item_count,
    unpricedIntentItemCount: snapshot.unpriced_item_count,
    finalListEstimateCents: finalListEstimate.estimated_total_cents,
    listEstimateChangeCents:
      finalListEstimate.estimated_total_cents - snapshot.estimated_total_cents,
    finalPricedItemCount: finalListEstimate.priced_item_count,
    finalUnpricedItemCount: finalListEstimate.unpriced_item_count,
    actualMerchandiseCents: receipt.subtotal_cents,
    actualTotalCents: receipt.total_cents,
    matchedVarianceCents,
    unpricedPlannedActualCents,
    additionsCents,
    skippedEstimateCents,
    discountsCents: receipt.discount_cents,
    taxCents: receipt.tax_cents,
    unresolvedCents,
    buckets: {
      matched,
      unpricedPlanned,
      skippedPlanned,
      receiptOnly,
      unresolved,
      possibleSubstitutions: possibleSubstitutions.map((candidate) => ({
        intentItemId: candidate.intentItemId,
        receiptItemId: candidate.receiptItemId,
      })),
    },
  };
}

async function matchingInputs(
  db: D1Database,
  householdId: string,
  tripId: string,
  receiptId: string
) {
  const [intentResult, receiptResult, aliasResult] = await Promise.all([
    db
      .prepare(
        `SELECT trip_intent_items.*, products.costco_item_number,
                products.category AS product_category
         FROM trip_intent_items
         LEFT JOIN products ON products.id = trip_intent_items.product_id
         WHERE trip_intent_items.trip_id = ?
         ORDER BY trip_intent_items.sort_order ASC`
      )
      .bind(tripId)
      .all<IntentItemRow>(),
    db
      .prepare(
        `SELECT receipt_items.*, products.canonical_name, products.category
         FROM receipt_items
         LEFT JOIN products ON products.id = receipt_items.product_id
         WHERE receipt_items.receipt_transaction_id = ?
         ORDER BY receipt_items.source_line_number ASC`
      )
      .bind(receiptId)
      .all<ReceiptItemRow>(),
    db
      .prepare(`SELECT * FROM product_aliases WHERE household_id = ?`)
      .bind(householdId)
      .all<ProductAliasRow>(),
  ]);
  const aliases: ConfirmedProductAlias[] = aliasResult.results.map((alias) => ({
    normalizedDescription: alias.normalized_description,
    productId: alias.product_id,
    costcoItemNumber: alias.costco_item_number,
    confirmed: true,
  }));
  return {
    intentRows: intentResult.results,
    receiptRows: receiptResult.results,
    aliases,
  };
}

async function rebuildTripItemMatches(
  db: D1Database,
  householdId: string,
  tripId: string,
  receiptId: string
) {
  const inputs = await matchingInputs(db, householdId, tripId, receiptId);
  const manualMatches = await db
    .prepare(
      `SELECT * FROM trip_item_matches
       WHERE receipt_transaction_id = ? AND resolution_source = 'member'`
    )
    .bind(receiptId)
    .all<TripItemMatchRow>();
  const manualIntentIds = new Set(
    manualMatches.results.map((match) => match.intent_item_id)
  );
  const manualReceiptIds = new Set(
    manualMatches.results.map((match) => match.receipt_item_id)
  );
  const matching = matchReceiptItemsToIntent({
    intentItems: inputs.intentRows.map(toLogicIntent),
    receiptItems: inputs.receiptRows.map(toLogicReceipt),
    aliases: inputs.aliases,
  });
  const automatic = matching.matches.filter(
    (match) =>
      match.status === "auto_matched" &&
      !manualIntentIds.has(match.intentItemId) &&
      !manualReceiptIds.has(match.receiptItemId)
  );
  const candidates = matching.matches.filter(
    (match) =>
      match.status === "candidate" &&
      !manualIntentIds.has(match.intentItemId) &&
      !manualReceiptIds.has(match.receiptItemId)
  );
  await db
    .prepare(
      `DELETE FROM trip_item_matches
       WHERE receipt_transaction_id = ? AND resolution_source = 'system'`
    )
    .bind(receiptId)
    .run();

  const now = nowIso();
  const statements = automatic.map((match) => {
    const matchType =
      match.reason === "normalized_exact" || match.reason === "descriptive_subset"
        ? "exact_name"
        : match.reason === "fuzzy_candidate"
          ? "exact_name"
          : match.reason;
    return db
      .prepare(
        `INSERT INTO trip_item_matches (
          id, household_id, trip_id, receipt_transaction_id,
          intent_item_id, receipt_item_id, match_type, confidence_bps,
          resolution_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)
        ON CONFLICT(receipt_item_id) DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        householdId,
        tripId,
        receiptId,
        match.intentItemId,
        match.receiptItemId,
        matchType,
        match.confidenceBps,
        now,
        now
      );
  });
  await runPreparedInChunks(db, statements);
  const persisted = await db
    .prepare(
      `SELECT * FROM trip_item_matches
       WHERE receipt_transaction_id = ?
       ORDER BY created_at ASC`
    )
    .bind(receiptId)
    .all<TripItemMatchRow>();
  return { ...inputs, matches: persisted.results, candidates };
}

interface QuestionCandidateInput {
  key: string;
  purpose: ReviewQuestionPurpose;
  prompt: string;
  options: ReviewQuestionOptionSummary[];
  declaredEffect: string;
  effectTarget: string;
  intentItemId?: string;
  listItemId?: string | null;
  receiptItemId?: string;
  priority: number;
}

function moneyLabel(cents: number) {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

async function rebuildReviewQuestions(
  db: D1Database,
  householdId: string,
  receipt: ReceiptTransactionRow,
  comparison: ClosedLoopComparison,
  intentItems: IntentItemRow[],
  receiptItems: ReceiptItemRow[],
  persistedMatches: TripItemMatchRow[],
  possibleSubstitutions: ReceiptIntentMatch[]
) {
  if (!receipt.trip_id) return;
  await db
    .prepare(
      `DELETE FROM review_questions
       WHERE receipt_transaction_id = ?
         AND status = 'open'
         AND answer_claim_token IS NULL`
    )
    .bind(receipt.id)
    .run();

  if (comparison.isTotalsOnly) return;

  const candidates: QuestionCandidateInput[] = [];
  const receiptById = new Map(receiptItems.map((item) => [item.id, item]));
  const intentById = new Map(intentItems.map((item) => [item.id, item]));
  const matchedReceiptIds = new Set(
    persistedMatches.map((match) => match.receipt_item_id)
  );
  const tenPercentThreshold = Math.round(
    Math.abs(receipt.total_cents) * 0.1
  );
  const materialThreshold =
    tenPercentThreshold > 0 ? Math.min(1500, tenPercentThreshold) : 1500;
  const materialCatalogCandidate = receiptItems
    .filter(
      (item) =>
        !matchedReceiptIds.has(item.id) &&
        !item.product_id &&
        !item.is_return &&
        item.discount_cents === 0 &&
        item.net_amount_cents > 0 &&
        item.net_amount_cents >= materialThreshold
    )
    .sort(
      (left, right) =>
        Math.abs(right.net_amount_cents) - Math.abs(left.net_amount_cents)
    )[0];
  if (materialCatalogCandidate) {
    candidates.push({
      key: `verify-line:${materialCatalogCandidate.id}`,
      purpose: "data_quality",
      prompt: `Add “${materialCatalogCandidate.raw_description}” (${moneyLabel(
        materialCatalogCandidate.net_amount_cents
      )}) to your household catalog?`,
      options: [
        {
          value: "add_to_catalog",
          label: "Add to catalog",
          effect: "Lets you choose a friendly name and category, then remembers this receipt alias.",
        },
        {
          value: "leave_unresolved",
          label: "Not now",
          effect: "Keeps this receipt line uncataloged without blocking the final recap.",
        },
      ],
      declaredEffect: "Creates one confirmed household catalog product or leaves this receipt line uncataloged",
      effectTarget: "receipt_record",
      receiptItemId: materialCatalogCandidate.id,
      priority: 10,
    });
  }

  const matchedIntentIds = new Set(
    persistedMatches.map((match) => match.intent_item_id)
  );
  const missingEssentials = intentItems
    .filter(
      (item) =>
        Boolean(item.included) &&
        item.section === "essentials" &&
        !matchedIntentIds.has(item.id)
    )
    .sort((left, right) => {
      const leftEstimate =
        left.estimated_price_cents === null
          ? 0
          : Math.round(
              (left.estimated_price_cents * left.quantity_milli) / 1000
            );
      const rightEstimate =
        right.estimated_price_cents === null
          ? 0
          : Math.round(
              (right.estimated_price_cents * right.quantity_milli) / 1000
            );
      return rightEstimate - leftEstimate || left.label.localeCompare(right.label);
    });
  const candidateSubstitution = possibleSubstitutions
    .filter((candidate) => {
      const intent = intentById.get(candidate.intentItemId);
      const item = receiptById.get(candidate.receiptItemId);
      if (!intent || !item || !missingEssentials.includes(intent)) return false;
      const sameKnownCategory = Boolean(
        intent.product_category &&
          item.category &&
          intent.product_category === item.category
      );
      return sameKnownCategory || candidate.confidenceBps >= 8_500;
    })
    .sort((left, right) => right.confidenceBps - left.confidenceBps)[0];

  if (candidateSubstitution) {
    const intent = intentById.get(candidateSubstitution.intentItemId)!;
    const item = receiptById.get(candidateSubstitution.receiptItemId)!;
    candidates.push({
      key: `possible-substitution:${intent.id}:${item.id}`,
      purpose: "intent",
      prompt: `Did “${item.canonical_name ?? item.raw_description}” replace ${intent.label} on this trip?`,
      options: [
        {
          value: "yes_substitution",
          label: "Yes",
          effect: "Confirms this trip and remembers the household wording for future receipts.",
        },
        {
          value: "separate_purchase",
          label: "No, separate item",
          effect: "Keeps one item skipped and the other not on the saved list.",
        },
        {
          value: "not_sure",
          label: "Not sure",
          effect: "Leaves the possible match unresolved without changing future suggestions.",
        },
      ],
      declaredEffect: "Confirms or rejects this match and, when confirmed, remembers a household alias",
      effectTarget: "receipt_match",
      intentItemId: intent.id,
      listItemId: intent.list_item_id,
      receiptItemId: item.id,
      priority: 20,
    });
  } else if (missingEssentials[0]) {
    const intent = missingEssentials[0];
    candidates.push({
      key: `missing-essential:${intent.id}`,
      purpose: "intent",
      prompt: `We could not find ${intent.label} on the receipt. Should it stay in next Saturday’s plan?`,
      options: [
        {
          value: "still_need_it",
          label: "Yes, carry it forward",
          effect: "Adds it to the next planning trip.",
        },
        {
          value: "not_needed",
          label: "No, not needed",
          effect: "Records a one-trip exception without changing the product permanently.",
        },
        {
          value: "receipt_needs_fix",
          label: "It is on the receipt",
          effect: "Lets you choose the receipt line once and remember the household match.",
        },
      ],
      declaredEffect: "Carries the item forward or records why it was not matched",
      effectTarget: "next_saturday_list",
      intentItemId: intent.id,
      listItemId: intent.list_item_id,
      priority: 20,
    });
  }

  const latestMemoryRows = await db
    .prepare(
      `SELECT product_id, preference FROM (
         SELECT COALESCE(feedback.product_id, receipt_items.product_id) AS product_id,
                feedback.value AS preference,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(feedback.product_id, receipt_items.product_id)
                  ORDER BY feedback.created_at DESC, feedback.id DESC
                ) AS memory_rank
         FROM feedback
         LEFT JOIN receipt_items ON receipt_items.id = feedback.receipt_item_id
         WHERE feedback.household_id = ?
           AND feedback.kind = 'product_experience'
           AND COALESCE(feedback.product_id, receipt_items.product_id) IS NOT NULL
       )
       WHERE memory_rank = 1`
    )
    .bind(householdId)
    .all<{ product_id: string; preference: string }>();
  const rememberedProductIds = new Set(
    latestMemoryRows.results
      .filter((row) => isProductMemoryPreference(row.preference))
      .map((row) => row.product_id),
  );
  const memoryCandidateByProductId = new Map<string, ReceiptItemRow>();
  receiptItems
    .filter(
      (item) =>
        Boolean(item.product_id) &&
        !rememberedProductIds.has(item.product_id!) &&
        !item.is_return &&
        receiptItemKind(item) !== "discount" &&
        item.net_amount_cents > 0,
    )
    .sort((left, right) => {
      const leftIsAddition = matchedReceiptIds.has(left.id) ? 1 : 0;
      const rightIsAddition = matchedReceiptIds.has(right.id) ? 1 : 0;
      return (
        leftIsAddition - rightIsAddition ||
        Math.abs(right.net_amount_cents) - Math.abs(left.net_amount_cents) ||
        left.source_line_number - right.source_line_number
      );
    })
    .forEach((item) => {
      if (!memoryCandidateByProductId.has(item.product_id!)) {
        memoryCandidateByProductId.set(item.product_id!, item);
      }
    });
  [...memoryCandidateByProductId.values()].slice(0, 3).forEach((item, index) => {
    const name = item.canonical_name ?? item.raw_description;
    candidates.push({
      key: `product-memory:${item.product_id}`,
      purpose: "product_experience",
      prompt: `What should BasketSense remember about ${name}?`,
      options: [
        {
          value: "buy_again",
          label: "Buy again",
          effect: "Allows this product to appear when its receipt cadence suggests it may be due.",
        },
        {
          value: "pause",
          label: "Pause for now",
          effect: "Keeps this product out of Saturday Prep until the household changes it.",
        },
        {
          value: "not_for_us",
          label: "Not for us",
          effect: "Keeps this product out of future suggestions until the household changes it.",
        },
      ],
      declaredEffect: "Updates this product's explicit household memory for future Saturday Prep suggestions",
      effectTarget: "product_memory",
      receiptItemId: item.id,
      priority: 40 + index,
    });
  });

  const now = nowIso();
  const statements = candidates
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 3)
    .map((candidate) =>
      db
        .prepare(
          `INSERT INTO review_questions (
            id, household_id, trip_id, receipt_transaction_id,
            question_key, purpose, prompt, options_json, declared_effect,
            effect_target, list_item_id, intent_item_id, receipt_item_id,
            priority, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
          ON CONFLICT(receipt_transaction_id, question_key) DO NOTHING`
        )
        .bind(
          crypto.randomUUID(),
          householdId,
          receipt.trip_id,
          receipt.id,
          candidate.key,
          candidate.purpose,
          candidate.prompt,
          JSON.stringify(candidate.options),
          candidate.declaredEffect,
          candidate.effectTarget,
          candidate.listItemId ?? null,
          candidate.intentItemId ?? null,
          candidate.receiptItemId ?? null,
          candidate.priority,
          now,
          now
        )
    );
  await runPreparedInChunks(db, statements);
}

async function readTripReviewHistory(
  db: D1Database,
  householdId: string,
): Promise<TripReviewHistoryEntry[]> {
  const result = await db
    .prepare(
      `SELECT trips.id AS trip_id,
              trips.scheduled_for,
              trips.completed_at,
              receipt_transactions.id AS receipt_id,
              receipt_transactions.purchased_at,
              receipt_transactions.total_cents,
              receipt_transactions.item_count,
              receipt_transactions.parse_status,
              receipt_transactions.audit_flag,
              (SELECT COUNT(*) FROM review_questions
               WHERE review_questions.receipt_transaction_id = receipt_transactions.id
                 AND review_questions.status = 'open') AS open_question_count,
              (SELECT COUNT(*) FROM receipt_corrections
               WHERE receipt_corrections.receipt_transaction_id = receipt_transactions.id) AS correction_count
       FROM trips
       INNER JOIN receipt_transactions
         ON receipt_transactions.trip_id = trips.id
        AND receipt_transactions.household_id = trips.household_id
       INNER JOIN trip_intent_snapshots
         ON trip_intent_snapshots.trip_id = trips.id
       WHERE trips.household_id = ?
         AND trips.status = 'completed'
         AND receipt_transactions.source_type = 'receipt_photo'
         AND receipt_transactions.parse_status != 'rejected'
       ORDER BY trips.completed_at DESC,
                receipt_transactions.purchased_at DESC,
                receipt_transactions.id DESC`,
    )
    .bind(householdId)
    .all<{
      trip_id: string;
      scheduled_for: string;
      completed_at: string | null;
      receipt_id: string;
      purchased_at: string;
      total_cents: number;
      item_count: number;
      parse_status: TripReviewHistoryEntry["parseStatus"];
      audit_flag: string;
      open_question_count: number;
      correction_count: number;
    }>();
  return result.results.map((row) => ({
    tripId: row.trip_id,
    scheduledFor: row.scheduled_for,
    completedAt: row.completed_at,
    receiptId: row.receipt_id,
    purchasedAt: row.purchased_at,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    parseStatus: row.parse_status,
    auditFlag: row.audit_flag,
    openQuestionCount: row.open_question_count,
    correctionCount: row.correction_count,
  }));
}

async function readClosedLoopReview(
  db: D1Database,
  householdId: string,
  receiptId?: string
): Promise<ClosedLoopReview | null> {
  const receipt = receiptId
    ? await authorizedReceipt(db, householdId, receiptId)
    : await db
        .prepare(
          `SELECT receipt_transactions.*
           FROM receipt_transactions
           INNER JOIN trips ON trips.id = receipt_transactions.trip_id
           WHERE receipt_transactions.household_id = ?
             AND trips.household_id = receipt_transactions.household_id
             AND trips.status = 'completed'
           ORDER BY trips.completed_at DESC,
                    receipt_transactions.created_at DESC,
                    receipt_transactions.id DESC
           LIMIT 1`
        )
        .bind(householdId)
        .first<ReceiptTransactionRow>();
  if (!receipt?.trip_id) return null;

  const snapshot = await db
    .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(receipt.trip_id)
    .first<IntentSnapshotRow>();
  if (!snapshot) return null;

  const [inputs, matchesResult, questionsResult, upload, finalListEstimate] = await Promise.all([
    matchingInputs(db, householdId, receipt.trip_id, receipt.id),
    db
      .prepare(
        `SELECT * FROM trip_item_matches
         WHERE receipt_transaction_id = ?
         ORDER BY created_at ASC`
      )
      .bind(receipt.id)
      .all<TripItemMatchRow>(),
    db
      .prepare(
        `SELECT * FROM review_questions
         WHERE receipt_transaction_id = ?
         ORDER BY priority ASC, created_at ASC`
      )
      .bind(receipt.id)
      .all<ReviewQuestionRow>(),
    db
      .prepare(
        `SELECT * FROM receipt_uploads
         WHERE receipt_transaction_id = ? AND status != 'deleted'
         LIMIT 1`
      )
      .bind(receipt.id)
      .first<ReceiptUploadRow>(),
    readFinalTripListEstimate(db, receipt.trip_id),
  ]);
  const matching = matchReceiptItemsToIntent({
    intentItems: inputs.intentRows.map(toLogicIntent),
    receiptItems: inputs.receiptRows.map(toLogicReceipt),
    aliases: inputs.aliases,
  });
  const persistedIntentIds = new Set(
    matchesResult.results.map((match) => match.intent_item_id)
  );
  const persistedReceiptIds = new Set(
    matchesResult.results.map((match) => match.receipt_item_id)
  );
  const possibleSubstitutions = matching.matches.filter(
    (match) =>
      match.status === "candidate" &&
      !persistedIntentIds.has(match.intentItemId) &&
      !persistedReceiptIds.has(match.receiptItemId)
  );
  const totalsOnly = isTotalsOnlyReceipt(receipt);
  const arithmetic = reconcileReceipt({
    items: inputs.receiptRows.map((item) => ({
      lineSubtotalCents: item.line_subtotal_cents,
      discountCents: item.discount_cents,
      netAmountCents: item.net_amount_cents,
    })),
    subtotalCents: receipt.subtotal_cents,
    taxCents: receipt.tax_cents,
    totalCents: receipt.total_cents,
    discountCents: receipt.discount_cents,
    totalsOnly,
  });
  const comparison = buildClosedLoopComparison(
    receipt,
    snapshot,
    finalListEstimate,
    inputs.intentRows,
    inputs.receiptRows,
    matchesResult.results,
    possibleSubstitutions,
    arithmetic
  );

  return {
    receipt: receiptSummary(receipt),
    items: inputs.receiptRows.map(receiptItemSummary),
    intentItems: inputs.intentRows.map(intentItemSummary),
    matches: matchesResult.results.map(matchSummary),
    comparison,
    questions: questionsResult.results.map(questionSummary),
    upload: upload
      ? {
          id: upload.id,
          originalFilename: upload.original_filename,
          contentType: upload.content_type,
          byteSize: upload.byte_size,
          status: upload.status,
          uploadedAt: upload.created_at,
          imageUrl: `/api/receipt-photo?receiptId=${encodeURIComponent(
            receipt.id
          )}`,
        }
      : null,
  };
}

async function rebuildReceiptState(
  db: D1Database,
  context: HouseholdContext,
  receiptId: string,
  completeTrip = false
) {
  let receipt = await authorizedReceipt(
    db,
    context.household.id,
    receiptId
  );
  if (!receipt.trip_id) {
    throw new ApiError(409, "Receipt is not linked to a trip");
  }
  const receiptItems = await db
    .prepare(
      `SELECT * FROM receipt_items
       WHERE receipt_transaction_id = ?
       ORDER BY source_line_number ASC`
    )
    .bind(receipt.id)
    .all<ReceiptItemRow>();
  const totalsOnly = isTotalsOnlyReceipt(receipt);
  const arithmetic = reconcileReceipt({
    items: receiptItems.results.map((item) => ({
      lineSubtotalCents: item.line_subtotal_cents,
      discountCents: item.discount_cents,
      netAmountCents: item.net_amount_cents,
    })),
    subtotalCents: receipt.subtotal_cents,
    taxCents: receipt.tax_cents,
    totalCents: receipt.total_cents,
    discountCents: receipt.discount_cents,
    totalsOnly,
  });
  const now = nowIso();
  const parseStatus = arithmetic.isReconciled ? "reconciled" : "needs_review";
  const auditFlag = arithmetic.isReconciled
    ? totalsOnly
      ? "closed_loop_totals_only"
      : "closed_loop_reconciled"
    : `${totalsOnly ? "closed_loop_totals_only_delta" : "closed_loop_delta"}:${arithmetic.subtotalDeltaCents ?? "missing"}:${
        arithmetic.totalDeltaCents ?? "missing"
      }`;
  await db
    .prepare(
      `UPDATE receipt_transactions
       SET item_gross_cents = ?, item_count = ?, parse_status = ?,
           audit_flag = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`
    )
    .bind(
      receiptItems.results.reduce(
        (sum, item) => sum + item.line_subtotal_cents,
        0
      ),
      receiptItems.results.length,
      parseStatus,
      auditFlag,
      now,
      receipt.id,
      context.household.id
    )
    .run();
  if (completeTrip && arithmetic.isReconciled) {
    await db
      .prepare(
        `UPDATE trips
         SET status = 'completed', completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ? AND household_id = ?`
      )
      .bind(now, now, receipt.trip_id, context.household.id)
      .run();
  }

  const rebuilt = await rebuildTripItemMatches(
    db,
    context.household.id,
    receipt.trip_id,
    receipt.id
  );
  receipt = await authorizedReceipt(db, context.household.id, receipt.id);
  const snapshot = await db
    .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(receipt.trip_id)
    .first<IntentSnapshotRow>();
  if (!snapshot) {
    throw new ApiError(500, "Trip intent snapshot is unavailable");
  }
  const comparison = buildClosedLoopComparison(
    receipt,
    snapshot,
    await readFinalTripListEstimate(db, receipt.trip_id as string),
    rebuilt.intentRows,
    rebuilt.receiptRows,
    rebuilt.matches,
    rebuilt.candidates,
    arithmetic
  );
  await rebuildReviewQuestions(
    db,
    context.household.id,
    receipt,
    comparison,
    rebuilt.intentRows,
    rebuilt.receiptRows,
    rebuilt.matches,
    rebuilt.candidates
  );
  return readClosedLoopReview(db, context.household.id, receipt.id);
}

async function insertReceiptItems(
  db: D1Database,
  householdId: string,
  receiptId: string,
  items: ValidatedDraftItem[],
  replaceExisting = false
) {
  const statements = await buildReceiptItemStatements(
    db,
    householdId,
    receiptId,
    items,
    replaceExisting,
  );
  await runPreparedInChunks(db, statements);
}

async function buildReceiptItemStatements(
  db: D1Database,
  householdId: string,
  receiptId: string,
  items: ValidatedDraftItem[],
  replaceExisting = false,
) {
  const resolved = await resolveDraftProducts(db, householdId, items);
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (replaceExisting) {
    statements.push(
      db
        .prepare(`DELETE FROM receipt_items WHERE receipt_transaction_id = ?`)
        .bind(receiptId)
    );
  }
  for (const resolution of resolved) {
    const item = resolution.item;
    statements.push(
      db
        .prepare(
          `INSERT INTO receipt_items (
            id, receipt_transaction_id, product_id, source_line_number,
            costco_item_number, raw_description, quantity_milli,
            unit_price_cents, unit_price_mills, line_subtotal_cents,
            discount_cents, net_amount_cents, tax_status,
            normalization_status, is_return, match_confidence_bps,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          receiptId,
          resolution.product?.id ?? null,
          item.sourceLineNumber,
          item.costcoItemNumber,
          item.rawDescription,
          item.quantityMilli,
          item.unitPriceCents,
          item.lineSubtotalCents,
          item.discountCents,
          item.netAmountCents,
          item.taxStatus,
          item.kind === "discount"
            ? "receipt_discount"
            : resolution.product
            ? "normalized_from_history"
            : "receipt_abbreviation",
          item.isReturn ? 1 : 0,
          resolution.confidenceBps,
          now,
          now
      )
    );
  }
  return statements;
}

function receiptMutationResponse(closedLoop: ClosedLoopReview) {
  return json({
    receiptId: closedLoop.receipt.id,
    receipt: closedLoop.receipt,
    comparison: closedLoop.comparison,
    questions: closedLoop.questions,
    closedLoop,
  });
}

function adHocReceiptResponse(
  receipt: ReceiptTransactionRow,
  items: ReceiptItemRow[]
) {
  return json({
    receiptId: receipt.id,
    receipt: receiptSummary(receipt),
    items: items.map(receiptItemSummary),
    mode: "ad_hoc",
  });
}

async function readAdHocReceipt(
  db: D1Database,
  householdId: string,
  receiptId: string
) {
  const receipt = await authorizedReceipt(db, householdId, receiptId);
  if (receipt.trip_id !== null || receipt.source_type !== "receipt_photo") {
    throw new ApiError(404, "Standalone receipt not found");
  }
  const items = await db
    .prepare(
      `SELECT receipt_items.*, products.canonical_name, products.category
       FROM receipt_items
       LEFT JOIN products ON products.id = receipt_items.product_id
       WHERE receipt_items.receipt_transaction_id = ?
       ORDER BY receipt_items.source_line_number ASC`
    )
    .bind(receipt.id)
    .all<ReceiptItemRow>();
  return { receipt, items: items.results };
}

type AdHocTransactionType = "warehouse" | "return";

function adHocTransactionType(
  value: unknown,
  fallback: AdHocTransactionType = "warehouse"
): AdHocTransactionType {
  if (value === undefined) return fallback;
  if (value === "warehouse" || value === "return") return value;
  throw new ApiError(400, "transactionType must be warehouse or return");
}

function assertAdHocReceiptShape(
  transactionType: AdHocTransactionType,
  items: readonly { isReturn: boolean; kind: "item" | "discount" }[],
  subtotalCents: number,
  taxCents: number,
  totalCents: number,
  discountCents: number
) {
  if (transactionType === "return") {
    if (subtotalCents > 0 || taxCents > 0 || totalCents > 0) {
      throw new ApiError(400, "Return amounts must be zero or negative");
    }
    if (discountCents !== 0 || items.some((item) => item.kind === "discount")) {
      throw new ApiError(400, "Return receipts cannot contain purchase discounts");
    }
    if (items.some((item) => !item.isReturn)) {
      throw new ApiError(400, "Every product on a return receipt must be a negative return line");
    }
    return;
  }

  if (subtotalCents < 0 || taxCents < 0 || totalCents < 0) {
    throw new ApiError(400, "Purchase amounts cannot be negative; choose Return instead");
  }
  if (items.some((item) => item.isReturn)) {
    throw new ApiError(400, "A purchase receipt cannot contain return lines; choose Return instead");
  }
}

async function rebuildAdHocReceiptState(
  db: D1Database,
  context: HouseholdContext,
  receiptId: string,
  finalize = false
) {
  const standalone = await readAdHocReceipt(
    db,
    context.household.id,
    receiptId
  );
  if (standalone.receipt.parse_status === "rejected") {
    throw new ApiError(409, "Discarded receipts cannot be changed");
  }
  const arithmetic = reconcileReceipt({
    items: standalone.items.map((item) => ({
      lineSubtotalCents: item.line_subtotal_cents,
      discountCents: item.discount_cents,
      netAmountCents: item.net_amount_cents,
    })),
    subtotalCents: standalone.receipt.subtotal_cents,
    taxCents: standalone.receipt.tax_cents,
    totalCents: standalone.receipt.total_cents,
    discountCents: standalone.receipt.discount_cents,
    totalsOnly: isTotalsOnlyReceipt(standalone.receipt),
  });
  const totalsOnly = isTotalsOnlyReceipt(standalone.receipt);
  const auditPrefix = standalone.receipt.transaction_type === "return"
    ? "ad_hoc_return"
    : "ad_hoc";
  const now = nowIso();
  const parseStatus = finalize && arithmetic.isReconciled
    ? "reconciled"
    : "needs_review";
  const auditFlag = arithmetic.isReconciled
    ? finalize
      ? totalsOnly
        ? `${auditPrefix}_totals_only_reconciled`
        : `${auditPrefix}_reconciled`
      : totalsOnly
        ? `${auditPrefix}_totals_only_ready_to_finalize`
        : `${auditPrefix}_ready_to_finalize`
    : `${totalsOnly ? `${auditPrefix}_totals_only_delta` : `${auditPrefix}_delta`}:${
        arithmetic.subtotalDeltaCents ?? "missing"
      }:${arithmetic.totalDeltaCents ?? "missing"}`;
  await db
    .prepare(
      `UPDATE receipt_transactions
       SET item_gross_cents = ?, item_count = ?, parse_status = ?,
           audit_flag = ?, updated_at = ?
       WHERE id = ? AND household_id = ? AND trip_id IS NULL`
    )
    .bind(
      standalone.items.reduce(
        (sum, item) => sum + item.line_subtotal_cents,
        0
      ),
      standalone.items.length,
      parseStatus,
      auditFlag,
      now,
      standalone.receipt.id,
      context.household.id
    )
    .run();
  return readAdHocReceipt(db, context.household.id, standalone.receipt.id);
}

async function createAdHocReceipt(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const transactionType = adHocTransactionType(body.transactionType);
  const clientReceiptId = requiredString(body.clientReceiptId, "clientReceiptId", 128);
  const sourceTransactionKey = `ad-hoc-receipt:${clientReceiptId}`;
  const existing = await db
    .prepare(
      `SELECT * FROM receipt_transactions
       WHERE household_id = ? AND source_transaction_key = ? LIMIT 1`
    )
    .bind(context.household.id, sourceTransactionKey)
    .first<ReceiptTransactionRow>();
  if (existing) {
    if (existing.trip_id !== null || existing.source_type !== "receipt_photo") {
      throw new ApiError(409, "This standalone receipt key is already in use");
    }
    const standalone = await readAdHocReceipt(db, context.household.id, existing.id);
    return adHocReceiptResponse(standalone.receipt, standalone.items);
  }

  const purchasedAt = requiredDateTime(body.purchasedAt, "purchasedAt");
  const subtotalCents = requiredInteger(body.subtotalCents, "subtotalCents", -100_000_000, 100_000_000);
  const taxCents = requiredInteger(body.taxCents, "taxCents", -10_000_000, 10_000_000);
  const totalCents = requiredInteger(body.totalCents, "totalCents", -100_000_000, 100_000_000);
  const totalsOnly = body.captureMode === "totals_only";
  const items = validateDraftItems(body.items, totalsOnly);
  const discountCents = optionalInteger(body.discountCents, "discountCents", 0, 100_000_000)
    ?? items.reduce((sum, item) => sum + item.discountCents, 0);
  assertAdHocReceiptShape(
    transactionType,
    items,
    subtotalCents,
    taxCents,
    totalCents,
    discountCents
  );
  const receiptId = crypto.randomUUID();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO receipt_transactions (
        id, household_id, trip_id, source_transaction_key,
        transaction_type, source_type, purchased_at, item_gross_cents,
        item_count, subtotal_cents, tax_cents, discount_cents, total_cents,
        household_funded_cents, external_funding_cents, audit_flag,
        parse_status, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, 'receipt_photo', ?, ?, ?, ?, ?, ?, ?, ?,
                0, ?, 'needs_review', ?, ?)`
    )
    .bind(
      receiptId,
      context.household.id,
      sourceTransactionKey,
      transactionType,
      purchasedAt,
      items.reduce((sum, item) => sum + item.lineSubtotalCents, 0),
      items.length,
      subtotalCents,
      taxCents,
      discountCents,
      totalCents,
      totalCents,
      totalsOnly
        ? `${transactionType === "return" ? "ad_hoc_return" : "ad_hoc"}_totals_only_draft`
        : `${transactionType === "return" ? "ad_hoc_return" : "ad_hoc"}_draft`,
      now,
      now
    )
    .run();
  await insertReceiptItems(db, context.household.id, receiptId, items);
  const standalone = await rebuildAdHocReceiptState(db, context, receiptId);
  return adHocReceiptResponse(standalone.receipt, standalone.items);
}

async function updateAdHocReceipt(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const standalone = await readAdHocReceipt(db, context.household.id, receiptId);
  if (standalone.receipt.parse_status === "reconciled") {
    throw new ApiError(409, "Finalized standalone receipts are immutable");
  }
  if (standalone.receipt.parse_status === "rejected") {
    throw new ApiError(409, "Discarded receipts cannot be changed");
  }
  const purchasedAt = body.purchasedAt === undefined
    ? standalone.receipt.purchased_at
    : requiredDateTime(body.purchasedAt, "purchasedAt");
  const subtotalCents = body.subtotalCents === undefined
    ? standalone.receipt.subtotal_cents
    : requiredInteger(body.subtotalCents, "subtotalCents", -100_000_000, 100_000_000);
  const taxCents = body.taxCents === undefined
    ? standalone.receipt.tax_cents
    : requiredInteger(body.taxCents, "taxCents", -10_000_000, 10_000_000);
  const totalCents = body.totalCents === undefined
    ? standalone.receipt.total_cents
    : requiredInteger(body.totalCents, "totalCents", -100_000_000, 100_000_000);
  const discountCents = body.discountCents === undefined
    ? standalone.receipt.discount_cents
    : optionalInteger(body.discountCents, "discountCents", 0, 100_000_000) ?? 0;
  const totalsOnly = body.captureMode === "totals_only" ||
    (body.captureMode === undefined && isTotalsOnlyReceipt(standalone.receipt));
  const items = body.items === undefined ? null : validateDraftItems(body.items, totalsOnly);
  const transactionType = adHocTransactionType(
    body.transactionType,
    standalone.receipt.transaction_type === "return" ? "return" : "warehouse"
  );
  const shapeItems = items ?? standalone.items.map((item) => ({
    isReturn: Boolean(item.is_return),
    kind: receiptItemKind(item),
  }));
  assertAdHocReceiptShape(
    transactionType,
    shapeItems,
    subtotalCents,
    taxCents,
    totalCents,
    discountCents
  );
  const auditPrefix = transactionType === "return" ? "ad_hoc_return" : "ad_hoc";
  const now = nowIso();
  await db
    .prepare(
      `UPDATE receipt_transactions
       SET transaction_type = ?, purchased_at = ?, subtotal_cents = ?, tax_cents = ?,
           discount_cents = ?, total_cents = ?, household_funded_cents = ?,
           item_gross_cents = ?, item_count = ?, parse_status = 'needs_review',
           audit_flag = ?, updated_at = ?
       WHERE id = ? AND household_id = ? AND trip_id IS NULL`
    )
    .bind(
      transactionType,
      purchasedAt,
      subtotalCents,
      taxCents,
      discountCents,
      totalCents,
      totalCents,
      items ? items.reduce((sum, item) => sum + item.lineSubtotalCents, 0) : standalone.receipt.item_gross_cents,
      items?.length ?? standalone.receipt.item_count,
      totalsOnly ? `${auditPrefix}_totals_only_draft` : `${auditPrefix}_corrected`,
      now,
      standalone.receipt.id,
      context.household.id
    )
    .run();
  if (items) {
    await insertReceiptItems(db, context.household.id, standalone.receipt.id, items, true);
  }
  const rebuilt = await rebuildAdHocReceiptState(
    db,
    context,
    standalone.receipt.id
  );
  return adHocReceiptResponse(rebuilt.receipt, rebuilt.items);
}

async function finalizeAdHocReceipt(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const standalone = await readAdHocReceipt(db, context.household.id, receiptId);
  if (standalone.receipt.parse_status === "reconciled") {
    await promoteAdHocReceiptProducts(
      db,
      context,
      standalone.receipt.id,
      standalone.items,
    );
    const promoted = await readAdHocReceipt(
      db,
      context.household.id,
      standalone.receipt.id,
    );
    return adHocReceiptResponse(promoted.receipt, promoted.items);
  }
  if (standalone.receipt.parse_status === "rejected") {
    throw new ApiError(409, "Discarded receipts cannot be finalized");
  }
  if (
    (standalone.receipt.transaction_type === "return" && standalone.receipt.total_cents >= 0) ||
    (standalone.receipt.transaction_type !== "return" && standalone.receipt.total_cents <= 0)
  ) {
    throw new ApiError(
      409,
      standalone.receipt.transaction_type === "return"
        ? "A finalized return must have a negative total"
        : "A finalized purchase must have a positive total"
    );
  }
  const arithmetic = reconcileReceipt({
    items: standalone.items.map((item) => ({
      lineSubtotalCents: item.line_subtotal_cents,
      discountCents: item.discount_cents,
      netAmountCents: item.net_amount_cents,
    })),
    subtotalCents: standalone.receipt.subtotal_cents,
    taxCents: standalone.receipt.tax_cents,
    totalCents: standalone.receipt.total_cents,
    discountCents: standalone.receipt.discount_cents,
    totalsOnly: isTotalsOnlyReceipt(standalone.receipt),
  });
  if (!arithmetic.isReconciled) {
    throw new ApiError(409, "Receipt totals must reconcile within five cents before finalizing");
  }
  const rebuilt = await rebuildAdHocReceiptState(
    db,
    context,
    standalone.receipt.id,
    true
  );
  await promoteAdHocReceiptProducts(
    db,
    context,
    rebuilt.receipt.id,
    rebuilt.items,
  );
  const promoted = await readAdHocReceipt(
    db,
    context.household.id,
    rebuilt.receipt.id,
  );
  return adHocReceiptResponse(promoted.receipt, promoted.items);
}

async function discardAdHocReceipt(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const standalone = await readAdHocReceipt(db, context.household.id, receiptId);
  if (standalone.receipt.parse_status === "reconciled") {
    throw new ApiError(409, "Finalized standalone receipts are immutable");
  }
  if (standalone.receipt.parse_status !== "rejected") {
    await db
      .prepare(
        `UPDATE receipt_transactions
         SET parse_status = 'rejected', audit_flag = 'ad_hoc_discarded', updated_at = ?
         WHERE id = ? AND household_id = ? AND trip_id IS NULL`
      )
      .bind(nowIso(), standalone.receipt.id, context.household.id)
      .run();
  }
  const discarded = await readAdHocReceipt(db, context.household.id, standalone.receipt.id);
  return adHocReceiptResponse(discarded.receipt, discarded.items);
}

async function ingestReceiptDraft(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const clientDraftId = requiredString(
    body.clientDraftId,
    "clientDraftId",
    128
  );
  const tripId = requiredString(body.tripId, "tripId", 128);
  const trip = await authorizedTrip(db, context.household.id, tripId);
  const sourceTransactionKey = `closed-loop-draft:${clientDraftId}`;
  const existing = await db
    .prepare(
      `SELECT * FROM receipt_transactions
       WHERE household_id = ? AND source_transaction_key = ? LIMIT 1`
    )
    .bind(context.household.id, sourceTransactionKey)
    .first<ReceiptTransactionRow>();
  if (existing) {
    if (existing.trip_id !== trip.id) {
      throw new ApiError(409, "This receipt draft is linked to another trip");
    }
    const persistedItemCount = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM receipt_items
         WHERE receipt_transaction_id = ?`
      )
      .bind(existing.id)
      .first<{ count: number }>();
    if ((persistedItemCount?.count ?? 0) !== existing.item_count) {
      const recoveryItems = validateDraftItems(body.items);
      if (recoveryItems.length !== existing.item_count) {
        throw new ApiError(
          409,
          "This receipt draft is incomplete and the retry no longer matches it"
        );
      }
      await insertReceiptItems(
        db,
        context.household.id,
        existing.id,
        recoveryItems,
        true
      );
      const recovered = await rebuildReceiptState(db, context, existing.id);
      if (!recovered) {
        throw new ApiError(409, "The existing receipt draft is incomplete");
      }
      return receiptMutationResponse(recovered);
    }
    const closedLoop = await readClosedLoopReview(
      db,
      context.household.id,
      existing.id
    );
    if (!closedLoop) {
      throw new ApiError(409, "The existing receipt draft is incomplete");
    }
    return receiptMutationResponse(closedLoop);
  }
  if (trip.status === "completed") {
    throw new ApiError(409, "This trip already has a completed receipt");
  }
  const linkedReceipt = await db
    .prepare(
      `SELECT id FROM receipt_transactions
       WHERE household_id = ? AND trip_id = ? AND source_type = 'receipt_photo'
       LIMIT 1`
    )
    .bind(context.household.id, trip.id)
    .first<{ id: string }>();
  if (linkedReceipt) {
    throw new ApiError(409, "This trip already has a receipt draft");
  }

  const purchasedAt = receiptDateForTrip(body.purchasedAt, trip);
  const subtotalCents = requiredInteger(
    body.subtotalCents,
    "subtotalCents",
    -100_000_000,
    100_000_000
  );
  const taxCents = requiredInteger(
    body.taxCents,
    "taxCents",
    -10_000_000,
    10_000_000
  );
  const totalCents = requiredInteger(
    body.totalCents,
    "totalCents",
    -100_000_000,
    100_000_000
  );
  const totalsOnly = body.captureMode === "totals_only";
  const items = validateDraftItems(body.items, totalsOnly);
  const discountCents =
    optionalInteger(
      body.discountCents,
      "discountCents",
      0,
      100_000_000
    ) ?? items.reduce((sum, item) => sum + item.discountCents, 0);

  if (trip.status === "planning") {
    await ensureIntentSnapshot(db, context, trip, "upload_fallback");
  } else {
    await ensureIntentSnapshot(db, context, trip, "pre_trip");
  }
  const receiptId = crypto.randomUUID();
  const now = nowIso();
  try {
    await db
      .prepare(
        `INSERT INTO receipt_transactions (
          id, household_id, trip_id, source_transaction_key,
          transaction_type, source_type, purchased_at, item_gross_cents,
          item_count, subtotal_cents, tax_cents, discount_cents, total_cents,
          household_funded_cents, external_funding_cents, audit_flag,
          parse_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'warehouse', 'receipt_photo', ?, ?, ?, ?, ?, ?, ?, ?,
                  0, ?, 'needs_review', ?, ?)`
      )
      .bind(
        receiptId,
        context.household.id,
        trip.id,
        sourceTransactionKey,
        purchasedAt,
        items.reduce((sum, item) => sum + item.lineSubtotalCents, 0),
        items.length,
        subtotalCents,
        taxCents,
        discountCents,
        totalCents,
        totalCents,
        totalsOnly ? "closed_loop_totals_only_draft" : "closed_loop_draft",
        now,
        now
      )
      .run();
  } catch (error) {
    if (
      error instanceof Error &&
      /unique constraint failed/i.test(error.message)
    ) {
      throw new ApiError(
        409,
        "This trip already has a receipt draft. Refresh to continue reviewing it."
      );
    }
    throw error;
  }
  await insertReceiptItems(db, context.household.id, receiptId, items);
  const closedLoop = await rebuildReceiptState(db, context, receiptId);
  if (!closedLoop) {
    throw new ApiError(500, "Unable to prepare the receipt review");
  }
  return receiptMutationResponse(closedLoop);
}

async function updateReceiptDraft(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const receipt = await authorizedReceipt(
    db,
    context.household.id,
    receiptId
  );
  if (receipt.source_type !== "receipt_photo") {
    throw new ApiError(409, "Audited historical receipts cannot be edited here");
  }
  const trip = receipt.trip_id
    ? await authorizedTrip(
      db,
      context.household.id,
      receipt.trip_id
    )
    : null;
  if (!trip) {
    throw new ApiError(
      409,
      "Use the standalone receipt workflow to edit an ad hoc receipt"
    );
  }
  if (trip) {
    if (trip.status === "completed") {
      throw new ApiError(
        409,
        "Completed receipts are immutable so historical totals stay trustworthy."
      );
    }
  }
  const purchasedAt =
    body.purchasedAt === undefined
      ? receipt.purchased_at
      : trip
        ? receiptDateForTrip(body.purchasedAt, trip)
        : requiredDateTime(body.purchasedAt, "purchasedAt");
  const subtotalCents =
    body.subtotalCents === undefined
      ? receipt.subtotal_cents
      : requiredInteger(
          body.subtotalCents,
          "subtotalCents",
          -100_000_000,
          100_000_000
        );
  const taxCents =
    body.taxCents === undefined
      ? receipt.tax_cents
      : requiredInteger(
          body.taxCents,
          "taxCents",
          -10_000_000,
          10_000_000
        );
  const totalCents =
    body.totalCents === undefined
      ? receipt.total_cents
      : requiredInteger(
          body.totalCents,
          "totalCents",
          -100_000_000,
          100_000_000
        );
  const discountCents =
    body.discountCents === undefined
      ? receipt.discount_cents
      : (optionalInteger(
          body.discountCents,
          "discountCents",
          0,
          100_000_000
        ) ?? 0);
  const totalsOnly =
    body.captureMode === "totals_only" ||
    (body.captureMode === undefined && isTotalsOnlyReceipt(receipt));
  const items =
    body.items === undefined ? null : validateDraftItems(body.items, totalsOnly);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE receipt_transactions
       SET purchased_at = ?, subtotal_cents = ?, tax_cents = ?,
           discount_cents = ?, total_cents = ?, household_funded_cents = ?,
           item_gross_cents = ?, item_count = ?,
           parse_status = 'needs_review', audit_flag = ?,
           updated_at = ?
       WHERE id = ? AND household_id = ?`
    )
    .bind(
      purchasedAt,
      subtotalCents,
      taxCents,
      discountCents,
      totalCents,
      totalCents,
      items
        ? items.reduce((sum, item) => sum + item.lineSubtotalCents, 0)
        : receipt.item_gross_cents,
      items?.length ?? receipt.item_count,
      totalsOnly ? "closed_loop_totals_only_draft" : "closed_loop_corrected",
      now,
      receipt.id,
      context.household.id
    )
    .run();
  if (items) {
    await insertReceiptItems(
      db,
      context.household.id,
      receipt.id,
      items,
      true
    );
  }
  const closedLoop = await rebuildReceiptState(db, context, receipt.id);
  if (!closedLoop) {
    throw new ApiError(500, "Unable to refresh the receipt review");
  }
  return receiptMutationResponse(closedLoop);
}

async function applyHistoricalReceiptCorrection(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>,
) {
  requireHouseholdOwner(context);
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const ingestionId = requiredString(body.ingestionId, "ingestionId", 128);
  const receipt = await authorizedReceipt(db, context.household.id, receiptId);
  if (!receipt.trip_id || receipt.source_type !== "receipt_photo") {
    throw new ApiError(409, "Only a completed trip receipt can be corrected here");
  }
  const trip = await authorizedTrip(db, context.household.id, receipt.trip_id);
  if (trip.status !== "completed") {
    throw new ApiError(409, "Use the current receipt flow until this trip is complete");
  }

  const priorCorrection = await db
    .prepare(
      `SELECT id FROM receipt_corrections
       WHERE ingestion_id = ? AND receipt_transaction_id = ?
       LIMIT 1`,
    )
    .bind(ingestionId, receipt.id)
    .first<{ id: string }>();
  if (priorCorrection) {
    const existing = await readClosedLoopReview(db, context.household.id, receipt.id);
    if (!existing) throw new ApiError(500, "The corrected review is unavailable");
    return json({
      receiptId: receipt.id,
      correctionId: priorCorrection.id,
      alreadyApplied: true,
      closedLoop: existing,
    });
  }

  const ingestion = await db
    .prepare(
      `SELECT * FROM receipt_ingestions
       WHERE id = ? AND household_id = ? AND trip_id = ?
         AND receipt_transaction_id = ? AND status IN ('awaiting_review', 'failed')
       LIMIT 1`,
    )
    .bind(ingestionId, context.household.id, trip.id, receipt.id)
    .first<{
      id: string;
      source_storage_key: string;
      source_content_type: string;
      source_byte_size: number;
    }>();
  if (!ingestion) {
    throw new ApiError(409, "The proposed replacement receipt is not ready to apply");
  }

  const purchasedAt = receiptDateForTrip(body.purchasedAt, trip);
  const subtotalCents = requiredInteger(
    body.subtotalCents,
    "subtotalCents",
    -100_000_000,
    100_000_000,
  );
  const taxCents = requiredInteger(
    body.taxCents,
    "taxCents",
    -10_000_000,
    10_000_000,
  );
  const totalCents = requiredInteger(
    body.totalCents,
    "totalCents",
    -100_000_000,
    100_000_000,
  );
  const totalsOnly = body.captureMode === "totals_only";
  const items = validateDraftItems(body.items, totalsOnly);
  if (items.some((item) => item.isReturn)) {
    throw new ApiError(400, "Use the standalone Return flow for refund receipts");
  }
  const discountCents =
    optionalInteger(body.discountCents, "discountCents", 0, 100_000_000) ??
    items.reduce((sum, item) => sum + item.discountCents, 0);
  const arithmetic = reconcileReceipt({
    items: items.map((item) => ({
      lineSubtotalCents: item.lineSubtotalCents,
      discountCents: item.discountCents,
      netAmountCents: item.netAmountCents,
    })),
    subtotalCents,
    taxCents,
    totalCents,
    discountCents,
    totalsOnly,
  });
  if (!arithmetic.isReconciled) {
    throw new ApiError(409, "Replacement receipt totals must reconcile within five cents");
  }

  const [previousItems, previousMatches, previousQuestions, previousUpload, revisionRow] =
    await Promise.all([
      db.prepare(`SELECT * FROM receipt_items WHERE receipt_transaction_id = ? ORDER BY source_line_number ASC`)
        .bind(receipt.id).all<ReceiptItemRow>(),
      db.prepare(`SELECT * FROM trip_item_matches WHERE receipt_transaction_id = ? ORDER BY created_at ASC`)
        .bind(receipt.id).all<TripItemMatchRow>(),
      db.prepare(`SELECT * FROM review_questions WHERE receipt_transaction_id = ? ORDER BY created_at ASC`)
        .bind(receipt.id).all<ReviewQuestionRow>(),
      db.prepare(`SELECT * FROM receipt_uploads WHERE receipt_transaction_id = ? LIMIT 1`)
        .bind(receipt.id).first<ReceiptUploadRow>(),
      db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM receipt_corrections WHERE receipt_transaction_id = ?`)
        .bind(receipt.id).first<{ revision: number }>(),
    ]);
  const correctionId = crypto.randomUUID();
  const revision = revisionRow?.revision ?? 1;
  const now = nowIso();
  const itemStatements = await buildReceiptItemStatements(
    db,
    context.household.id,
    receipt.id,
    items,
    false,
  );
  await db.batch([
    db.prepare(
      `UPDATE receipt_corrections
       SET status = 'superseded'
       WHERE receipt_transaction_id = ? AND status = 'applied'`,
    ).bind(receipt.id),
    db.prepare(
      `INSERT INTO receipt_corrections (
        id, household_id, trip_id, receipt_transaction_id, ingestion_id,
        revision, status, previous_receipt_json, previous_items_json,
        previous_matches_json, previous_questions_json, previous_upload_json,
        replacement_storage_key, applied_by_member_id, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      correctionId,
      context.household.id,
      trip.id,
      receipt.id,
      ingestion.id,
      revision,
      JSON.stringify(receipt),
      JSON.stringify(previousItems.results),
      JSON.stringify(previousMatches.results),
      JSON.stringify(previousQuestions.results),
      previousUpload ? JSON.stringify(previousUpload) : null,
      ingestion.source_storage_key,
      context.member.id,
      now,
      now,
    ),
    db.prepare(`DELETE FROM review_questions WHERE receipt_transaction_id = ?`).bind(receipt.id),
    db.prepare(`DELETE FROM trip_item_matches WHERE receipt_transaction_id = ?`).bind(receipt.id),
    db.prepare(`DELETE FROM receipt_items WHERE receipt_transaction_id = ?`).bind(receipt.id),
    ...itemStatements,
    db.prepare(
      `UPDATE receipt_transactions
       SET purchased_at = ?, item_gross_cents = ?, item_count = ?,
           subtotal_cents = ?, tax_cents = ?, discount_cents = ?,
           total_cents = ?, household_funded_cents = ?, parse_status = 'needs_review',
           audit_flag = ?, updated_at = ?
       WHERE id = ? AND household_id = ? AND trip_id = ?`,
    ).bind(
      purchasedAt,
      items.reduce((sum, item) => sum + item.lineSubtotalCents, 0),
      items.length,
      subtotalCents,
      taxCents,
      discountCents,
      totalCents,
      totalCents,
      totalsOnly ? "closed_loop_totals_only_historical_correction" : "closed_loop_historical_correction",
      now,
      receipt.id,
      context.household.id,
      trip.id,
    ),
    db.prepare(
      `INSERT INTO receipt_uploads (
        id, household_id, receipt_transaction_id, storage_key, original_filename,
        content_type, byte_size, status, uploaded_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'costco-receipt-correction', ?, ?, 'stored', ?, ?, ?)
      ON CONFLICT(receipt_transaction_id) DO UPDATE SET
        storage_key = excluded.storage_key,
        original_filename = excluded.original_filename,
        content_type = excluded.content_type,
        byte_size = excluded.byte_size,
        status = 'stored',
        uploaded_by_member_id = excluded.uploaded_by_member_id,
        updated_at = excluded.updated_at`,
    ).bind(
      previousUpload?.id ?? crypto.randomUUID(),
      context.household.id,
      receipt.id,
      ingestion.source_storage_key,
      ingestion.source_content_type,
      ingestion.source_byte_size,
      context.member.id,
      previousUpload?.created_at ?? now,
      now,
    ),
    db.prepare(
      `UPDATE receipt_ingestions
       SET status = 'complete', completed_at = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`,
    ).bind(now, now, ingestion.id, context.household.id),
  ]);

  const closedLoop = await rebuildReceiptState(db, context, receipt.id);
  if (!closedLoop) throw new ApiError(500, "Unable to rebuild the corrected trip review");
  const refreshedItems = await db
    .prepare(`SELECT * FROM receipt_items WHERE receipt_transaction_id = ? ORDER BY source_line_number ASC`)
    .bind(receipt.id)
    .all<ReceiptItemRow>();
  await promoteAdHocReceiptProducts(db, context, receipt.id, refreshedItems.results);
  const promoted = await readClosedLoopReview(db, context.household.id, receipt.id);
  return json({
    receiptId: receipt.id,
    correctionId,
    revision,
    closedLoop: promoted ?? closedLoop,
  });
}

async function finalizeReceipt(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const receiptId = requiredString(body.receiptId, "receiptId", 128);
  const receipt = await authorizedReceipt(
    db,
    context.household.id,
    receiptId
  );
  const items = await db
    .prepare(
      `SELECT * FROM receipt_items WHERE receipt_transaction_id = ?`
    )
    .bind(receipt.id)
    .all<ReceiptItemRow>();
  const arithmetic = reconcileReceipt({
    items: items.results.map((item) => ({
      lineSubtotalCents: item.line_subtotal_cents,
      discountCents: item.discount_cents,
      netAmountCents: item.net_amount_cents,
    })),
    subtotalCents: receipt.subtotal_cents,
    taxCents: receipt.tax_cents,
    totalCents: receipt.total_cents,
    discountCents: receipt.discount_cents,
    totalsOnly: isTotalsOnlyReceipt(receipt),
  });
  if (!arithmetic.isReconciled) {
    throw new ApiError(
      409,
      "Receipt totals must reconcile within five cents before finalizing"
    );
  }
  const closedLoop = await rebuildReceiptState(db, context, receipt.id, true);
  if (!closedLoop) {
    throw new ApiError(500, "Unable to finalize the receipt");
  }
  await promoteAdHocReceiptProducts(db, context, receipt.id, items.results);
  const promoted = await readClosedLoopReview(db, context.household.id, receipt.id);
  return receiptMutationResponse(promoted ?? closedLoop);
}

async function followingPlanningTrip(
  db: D1Database,
  context: HouseholdContext,
  sourceTripId: string
) {
  const sourceTrip = await authorizedTrip(
    db,
    context.household.id,
    sourceTripId
  );
  let target = await db
    .prepare(
      `SELECT * FROM trips
       WHERE household_id = ? AND status IN ('planning', 'frozen')
         AND scheduled_for > ?
       ORDER BY scheduled_for ASC LIMIT 1`
    )
    .bind(context.household.id, sourceTrip.scheduled_for)
    .first<TripRow>();
  if (!target) {
    const scheduledFor = saturdayAfter(sourceTrip.scheduled_for);
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO trips (
          id, household_id, scheduled_for, status, created_by_member_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'planning', ?, ?, ?)
        ON CONFLICT(household_id, scheduled_for) DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        context.household.id,
        scheduledFor,
        context.member.id,
        now,
        now
      )
      .run();
    target = await db
      .prepare(
        `SELECT * FROM trips
         WHERE household_id = ? AND scheduled_for = ?
         LIMIT 1`
      )
      .bind(context.household.id, scheduledFor)
      .first<TripRow>();
  }
  if (!target || target.status === "completed") {
    throw new ApiError(500, "Unable to prepare the next Saturday list");
  }
  await seedSaturdayList(db, target, nowIso());
  return target;
}

async function carryItemForward(
  db: D1Database,
  context: HouseholdContext,
  sourceTripId: string,
  item: {
    productId: string | null;
    label: string;
    section: ListItemSection;
    estimatedPriceCents: number | null;
    quantityMilli: number;
  }
) {
  const target = await followingPlanningTrip(db, context, sourceTripId);
  const existing = item.productId
    ? await db
        .prepare(
          `SELECT id FROM trip_list_items
           WHERE trip_id = ? AND product_id = ? LIMIT 1`
        )
        .bind(target.id, item.productId)
        .first<{ id: string }>()
    : await db
        .prepare(
          `SELECT id FROM trip_list_items
           WHERE trip_id = ? AND lower(trim(label)) = lower(trim(?)) LIMIT 1`
        )
        .bind(target.id, item.label)
        .first<{ id: string }>();
  const now = nowIso();
  if (existing) {
    await db
      .prepare(
        `UPDATE trip_list_items
         SET included = 1, updated_at = ? WHERE id = ?`
      )
      .bind(now, existing.id)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO trip_list_items (
        id, trip_id, product_id, label, section, source,
        recommendation_reason, included, checked, included_at_freeze,
        added_after_freeze, estimated_price_cents, quantity_milli,
        sort_order, added_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'manual', ?, 1, 0, NULL, 0, ?, ?,
        (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM trip_list_items WHERE trip_id = ?),
        ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      target.id,
      item.productId,
      item.label,
      item.section,
      "Carried forward from the previous trip review",
      item.productId ? item.estimatedPriceCents : null,
      item.quantityMilli,
      target.id,
      context.member.id,
      now,
      now
    )
    .run();
}

async function confirmReceiptProduct(
  db: D1Database,
  context: HouseholdContext,
  receiptItemId: string,
  requestedProductId?: string | null,
  metadata?: { canonicalName?: string; category?: string }
) {
  const receiptItem = await db
    .prepare(
      `SELECT receipt_items.*, receipt_transactions.trip_id,
              receipt_transactions.household_id
       FROM receipt_items
       INNER JOIN receipt_transactions
         ON receipt_transactions.id = receipt_items.receipt_transaction_id
       WHERE receipt_items.id = ? AND receipt_transactions.household_id = ?
       LIMIT 1`
    )
    .bind(receiptItemId, context.household.id)
    .first<ReceiptItemRow & { trip_id: string; household_id: string }>();
  if (!receiptItem) throw new ApiError(404, "Receipt item not found");

  let productId = requestedProductId ?? receiptItem.product_id;
  if (productId) {
    const product = await db
      .prepare(`SELECT id FROM products WHERE id = ? AND household_id = ?`)
      .bind(productId, context.household.id)
      .first<{ id: string }>();
    if (!product) throw new ApiError(404, "Product not found");
  } else {
    const canonicalName = requiredString(
      metadata?.canonicalName,
      "canonicalName",
      140
    );
    const category = requiredString(metadata?.category, "category", 80);
    if (!REVIEWABLE_PRODUCT_CATEGORIES.has(category as ProductCategoryKey)) {
      throw new ApiError(400, "Choose a household product category");
    }
    productId = crypto.randomUUID();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO products (
          id, household_id, costco_item_number, canonical_name, category,
          category_status, category_reviewed_at, category_reviewed_by_member_id,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'reviewed', ?, ?, 1, ?, ?)`
      )
      .bind(
        productId,
        context.household.id,
        receiptItem.costco_item_number,
        canonicalName,
        category,
        now,
        context.member.id,
        now,
        now
      )
      .run();
  }
  const normalized = normalizeReceiptDescription(receiptItem.raw_description);
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO product_aliases (
          id, household_id, alias_key, raw_description,
          normalized_description, costco_item_number, product_id,
          confirmation_source, confirmed_by_member_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?)
        ON CONFLICT(household_id, alias_key) DO UPDATE SET
          product_id = excluded.product_id,
          raw_description = excluded.raw_description,
          normalized_description = excluded.normalized_description,
          confirmed_by_member_id = excluded.confirmed_by_member_id,
          updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        context.household.id,
        aliasKeyFor(receiptItem.costco_item_number, normalized),
        receiptItem.raw_description,
        normalized,
        receiptItem.costco_item_number,
        productId,
        context.member.id,
        now,
        now
      ),
    db
      .prepare(
        `UPDATE receipt_items
         SET product_id = ?, normalization_status = 'normalized_from_history',
             match_confidence_bps = 10000, updated_at = ?
         WHERE id = ?`
      )
      .bind(productId, now, receiptItem.id),
  ]);
  return productId;
}

async function rememberConfirmedIntentAlias(
  db: D1Database,
  context: HouseholdContext,
  intentItemId: string,
  receiptItemId: string,
  now: string,
) {
  const pair = await db
    .prepare(
      `SELECT trip_intent_items.label, receipt_items.product_id,
              receipt_items.raw_description, receipt_items.costco_item_number
       FROM trip_intent_items
       INNER JOIN receipt_items ON receipt_items.id = ?
       WHERE trip_intent_items.id = ?
       LIMIT 1`,
    )
    .bind(receiptItemId, intentItemId)
    .first<{
      label: string;
      product_id: string | null;
      raw_description: string;
      costco_item_number: string | null;
    }>();
  if (!pair?.product_id) return;

  const normalized = normalizeReceiptDescription(pair.label);
  if (!normalized) return;
  await db.batch([
    db.prepare(
      `INSERT INTO product_aliases (
        id, household_id, alias_key, raw_description,
        normalized_description, costco_item_number, product_id,
        confirmation_source, confirmed_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'member', ?, ?, ?)
      ON CONFLICT(household_id, alias_key) DO UPDATE SET
        product_id = excluded.product_id,
        raw_description = excluded.raw_description,
        normalized_description = excluded.normalized_description,
        confirmed_by_member_id = excluded.confirmed_by_member_id,
        updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      context.household.id,
      intentAliasKeyFor(normalized),
      pair.label,
      normalized,
      pair.product_id,
      context.member.id,
      now,
      now,
    ),
    db.prepare(
      `INSERT INTO product_aliases (
        id, household_id, alias_key, raw_description,
        normalized_description, costco_item_number, product_id,
        confirmation_source, confirmed_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?)
      ON CONFLICT(household_id, alias_key) DO UPDATE SET
        product_id = excluded.product_id,
        raw_description = excluded.raw_description,
        normalized_description = excluded.normalized_description,
        confirmed_by_member_id = excluded.confirmed_by_member_id,
        updated_at = excluded.updated_at`,
    ).bind(
      crypto.randomUUID(),
      context.household.id,
      aliasKeyFor(
        pair.costco_item_number,
        normalizeReceiptDescription(pair.raw_description),
      ),
      pair.raw_description,
      normalizeReceiptDescription(pair.raw_description),
      pair.costco_item_number,
      pair.product_id,
      context.member.id,
      now,
      now,
    ),
  ]);
}

async function confirmProductMetadata(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const productId = requiredString(body.productId, "productId", 128);
  const canonicalName = requiredString(
    body.canonicalName,
    "canonicalName",
    140
  );
  const categoryValue = requiredString(body.category, "category", 80);
  if (
    !REVIEWABLE_PRODUCT_CATEGORIES.has(categoryValue as ProductCategoryKey)
  ) {
    throw new ApiError(400, "category is invalid");
  }
  const category = categoryValue as ProductCategoryKey;
  const expectedUpdatedAt = requiredString(
    body.expectedUpdatedAt,
    "expectedUpdatedAt",
    80
  );

  const product = await db
    .prepare(
      `SELECT * FROM products
       WHERE id = ? AND household_id = ?
       LIMIT 1`
    )
    .bind(productId, context.household.id)
    .first<ProductRow>();
  if (!product) throw new ApiError(404, "Product not found");
  if (product.updated_at !== expectedUpdatedAt) {
    throw new ApiError(
      409,
      "This product was updated on another device. Review the latest details and try again."
    );
  }

  const now = nowIso();
  const update = await db
    .prepare(
      `UPDATE products
       SET canonical_name = ?, category = ?, category_status = 'reviewed',
           category_reviewed_at = ?, category_reviewed_by_member_id = ?,
           updated_at = ?
       WHERE id = ? AND household_id = ? AND updated_at = ?`
    )
    .bind(
      canonicalName,
      category,
      now,
      context.member.id,
      now,
      product.id,
      context.household.id,
      expectedUpdatedAt
    )
    .run();
  if ((update.meta.changes ?? 0) !== 1) {
    throw new ApiError(
      409,
      "This product was updated on another device. Review the latest details and try again."
    );
  }

  return json({
    product: {
      id: product.id,
      canonicalName,
      category,
      categoryStatus: "reviewed",
      categoryReviewedAt: now,
      categoryReviewedByDisplayName: context.member.display_name,
      updatedAt: now,
    },
  });
}

async function answerReviewQuestion(
  db: D1Database,
  context: HouseholdContext,
  body: Record<string, unknown>
) {
  const questionId = requiredString(body.questionId, "questionId", 128);
  const value = requiredString(body.value, "value", 120);
  const question = await db
    .prepare(
      `SELECT * FROM review_questions
       WHERE id = ? AND household_id = ? LIMIT 1`
    )
    .bind(questionId, context.household.id)
    .first<ReviewQuestionRow>();
  if (!question) throw new ApiError(404, "Review question not found");

  if (value === "skip") {
    if (question.status === "answered") {
      throw new ApiError(409, "This question already has an answer");
    }
    if (question.status !== "dismissed") {
      const now = nowIso();
      const dismissed = await db
        .prepare(
          `UPDATE review_questions
           SET status = 'dismissed', answer_value = 'skip',
               answered_by_member_id = ?, answered_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`
        )
        .bind(context.member.id, now, now, question.id)
        .run();
      if ((dismissed.meta.changes ?? 0) !== 1) {
        const latest = await db
          .prepare(`SELECT * FROM review_questions WHERE id = ?`)
          .bind(question.id)
          .first<ReviewQuestionRow>();
        if (latest?.status === "dismissed") {
          return json({ question: questionSummary(latest) });
        }
        if (latest?.status === "answered") {
          throw new ApiError(409, "This question already has an answer");
        }
        throw new ApiError(409, "Another household member is updating this question");
      }
    }
    const updated = await db
      .prepare(`SELECT * FROM review_questions WHERE id = ?`)
      .bind(question.id)
      .first<ReviewQuestionRow>();
    return json({ question: updated ? questionSummary(updated) : null });
  }

  if (question.status === "answered") {
    if (question.answer_value !== value) {
      throw new ApiError(409, "This question already has a different answer");
    }
    return json({ question: questionSummary(question) });
  }
  if (question.status === "dismissed") {
    throw new ApiError(409, "This question was skipped");
  }
  const options = safeQuestionOptions(question.options_json);
  if (!options.some((option) => option.value === value)) {
    throw new ApiError(400, "value is not an option for this question");
  }
  const note =
    body.note === undefined || body.note === null || body.note === ""
      ? null
      : requiredString(body.note, "note", 500);
  const productId = optionalId(body.productId, "productId");
  const canonicalName =
    body.canonicalName === undefined || body.canonicalName === null
      ? undefined
      : requiredString(body.canonicalName, "canonicalName", 140);
  const category =
    body.category === undefined || body.category === null
      ? undefined
      : requiredString(body.category, "category", 80);
  const replacementReceiptItemId = optionalId(
    body.replacementReceiptItemId,
    "replacementReceiptItemId"
  );
  const now = nowIso();
  const claimToken = crypto.randomUUID();
  const staleClaimCutoff = new Date(Date.now() - 120_000).toISOString();
  const claim = await db
    .prepare(
      `UPDATE review_questions
       SET answer_claim_token = ?, answer_claimed_at = ?, updated_at = ?
       WHERE id = ? AND household_id = ? AND status = 'open'
         AND (answer_claim_token IS NULL OR answer_claimed_at < ?)`
    )
    .bind(
      claimToken,
      now,
      now,
      question.id,
      context.household.id,
      staleClaimCutoff
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const latest = await db
      .prepare(`SELECT * FROM review_questions WHERE id = ?`)
      .bind(question.id)
      .first<ReviewQuestionRow>();
    if (latest?.status === "answered" && latest.answer_value === value) {
      return json({ question: questionSummary(latest) });
    }
    if (latest?.status === "answered") {
      throw new ApiError(409, "This question already has a different answer");
    }
    if (latest?.status === "dismissed") {
      throw new ApiError(409, "This question was skipped");
    }
    throw new ApiError(
      409,
      "Another household member is saving this answer. Try again in a moment."
    );
  }

  try {
    if (question.receipt_item_id && value === "add_to_catalog") {
    await confirmReceiptProduct(
      db,
      context,
      question.receipt_item_id,
      productId,
      { canonicalName, category }
    );
    } else if (question.receipt_item_id && productId) {
      await confirmReceiptProduct(
        db,
        context,
        question.receipt_item_id,
        productId
      );
    }
  if (
    (value === "yes_substitution" || value === "receipt_needs_fix") &&
    question.intent_item_id &&
    (question.receipt_item_id || replacementReceiptItemId)
  ) {
    const receiptItemId = question.receipt_item_id ?? replacementReceiptItemId!;
    const receiptItem = await db
      .prepare(
        `SELECT id FROM receipt_items
         WHERE id = ? AND receipt_transaction_id = ? LIMIT 1`
      )
      .bind(receiptItemId, question.receipt_transaction_id)
      .first<{ id: string }>();
    if (!receiptItem) {
      throw new ApiError(400, "Choose a receipt line from this trip");
    }
    await db.batch([
      db
        .prepare(
          `DELETE FROM trip_item_matches
           WHERE intent_item_id = ? OR receipt_item_id = ?`
        )
        .bind(question.intent_item_id, receiptItemId),
      db
        .prepare(
          `INSERT INTO trip_item_matches (
            id, household_id, trip_id, receipt_transaction_id,
            intent_item_id, receipt_item_id, match_type, confidence_bps,
            resolution_source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'member_confirmed', 10000, 'member', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          context.household.id,
          question.trip_id,
          question.receipt_transaction_id,
          question.intent_item_id,
          receiptItemId,
          now,
          now
        ),
    ]);
    await rememberConfirmedIntentAlias(
      db,
      context,
      question.intent_item_id,
      receiptItemId,
      now,
    );
  }
  if (value === "still_need_it" && question.intent_item_id) {
    const item = await db
      .prepare(`SELECT * FROM trip_intent_items WHERE id = ? LIMIT 1`)
      .bind(question.intent_item_id)
      .first<IntentItemRow>();
    if (item) {
      await carryItemForward(db, context, question.trip_id, {
        productId: item.product_id,
        label: item.label,
        section: item.section,
        estimatedPriceCents: item.estimated_price_cents,
        quantityMilli: item.quantity_milli,
      });
    }
  }
  if (value === "regular_next_time" && question.receipt_item_id) {
    const item = await db
      .prepare(
        `SELECT receipt_items.*, products.canonical_name
         FROM receipt_items
         LEFT JOIN products ON products.id = receipt_items.product_id
         WHERE receipt_items.id = ? LIMIT 1`
      )
      .bind(question.receipt_item_id)
      .first<ReceiptItemRow>();
    if (item) {
      await carryItemForward(db, context, question.trip_id, {
        productId: item.product_id,
        label: item.canonical_name ?? item.raw_description,
        section: "essentials",
        estimatedPriceCents:
          item.unit_price_cents ??
          Math.round((item.net_amount_cents * 1000) / item.quantity_milli),
        quantityMilli: item.quantity_milli,
      });
    }
  }

  const feedbackKind: FeedbackKind =
    question.purpose === "data_quality"
      ? "receipt_correction"
      : question.purpose === "intent"
        ? "fulfillment_reason"
        : question.purpose === "product_experience"
          ? "product_experience"
          : "discovery_outcome";
  await db
    .prepare(
      `INSERT INTO feedback (
        id, household_id, trip_id, receipt_transaction_id,
        list_item_id, receipt_item_id, kind, value, rating, note,
        created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`
    )
    .bind(
      `review-feedback:${question.id}`,
      context.household.id,
      question.trip_id,
      question.receipt_transaction_id,
      question.list_item_id,
      question.receipt_item_id,
      feedbackKind,
      value,
      note,
      context.member.id,
      now
    )
    .run();

  await db
    .prepare(
      `UPDATE review_questions
       SET status = 'answered', answer_value = ?, answer_note = ?,
           answered_by_member_id = ?, answered_at = ?, updated_at = ?,
           answer_claim_token = NULL, answer_claimed_at = NULL
       WHERE id = ? AND status = 'open' AND answer_claim_token = ?`
    )
    .bind(value, note, context.member.id, now, now, question.id, claimToken)
    .run();

  const closedLoop = await rebuildReceiptState(
    db,
    context,
    question.receipt_transaction_id
  );
  const updatedQuestion = closedLoop?.questions.find(
    (entry) => entry.id === question.id
  );
  return json({ question: updatedQuestion ?? null, closedLoop });
  } catch (error) {
    await db
      .prepare(
        `UPDATE review_questions
         SET answer_claim_token = NULL, answer_claimed_at = NULL
         WHERE id = ? AND status = 'open' AND answer_claim_token = ?`
      )
      .bind(question.id, claimToken)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

function handleError(error: unknown) {
  if (error instanceof ApiError) {
    return json({ error: error.message }, error.status);
  }

  console.error("BasketSense household API error", error);
  return json({ error: "Unable to update the household right now" }, 500);
}

export async function handleHouseholdGet(
  request: Request,
  db: D1Database
) {
  try {
    const user = authenticatedUser(request);
    // Reads happen every few seconds while a household is shopping. A ready
    // database only needs this lightweight availability check; running the
    // full DDL batch here can contend with those refreshes on cold isolates.
    await ensureReadableSchema(db);
    const url = new URL(request.url);
    const sandbox = sandboxRequested(url.searchParams.get("sandbox"));
    if (url.searchParams.get("scope") === "list") {
      const tripId = optionalId(url.searchParams.get("tripId"), "tripId");
      const revision = optionalRevision(url.searchParams.get("revision"));
      const context = sandbox
        ? await requestHouseholdContext(db, user, true)
        : await readExistingHouseholdContext(db, user, tripId);
      if (tripId && context.currentTrip.id !== tripId) {
        // requestHouseholdContext only returns the current sandbox trip. Keep
        // an explicit ownership check for polling a historical sandbox trip.
        const authorized = await authorizedTrip(db, context.household.id, tripId);
        if (revision === authorized.list_revision) {
          return new Response(null, {
            status: 204,
            headers: { "Cache-Control": "no-store" },
          });
        }
        return json(await readHouseholdListState(db, { ...context, currentTrip: authorized }));
      }
      if (revision === context.currentTrip.list_revision) {
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      }
      return json(await readHouseholdListState(db, context));
    }
    const context = await requestHouseholdContext(db, user, sandbox);
    const view = url.searchParams.get("view");
    if (view === "core") {
      return json(await readHouseholdCoreState(db, context));
    }
    if (view === "insights") {
      const insights = await buildDashboardViewStateFromD1(
        db,
        context.household.id,
      );
      return json(insights);
    }
    if (view === "data-health") {
      return json(await readDataHealth(db, context));
    }
    if (view === "ad-hoc-receipt") {
      const receiptId = requiredString(
        url.searchParams.get("receiptId"),
        "receiptId",
        128
      );
      const standalone = await readAdHocReceipt(
        db,
        context.household.id,
        receiptId
      );
      return adHocReceiptResponse(standalone.receipt, standalone.items);
    }
    if (view === "review-history") {
      return json({
        history: await readTripReviewHistory(db, context.household.id),
      });
    }
    if (view === "trip-review") {
      const receiptId = requiredString(
        url.searchParams.get("receiptId"),
        "receiptId",
        128,
      );
      const closedLoop = await readClosedLoopReview(
        db,
        context.household.id,
        receiptId,
      );
      if (!closedLoop) throw new ApiError(404, "Trip review not found");
      return json({ closedLoop });
    }
    if (view === "export") {
      return await householdExportResponse(
        db,
        context,
        url.searchParams.get("format"),
      );
    }
    if (view) {
      throw new ApiError(404, "Unknown household view");
    }
    return json(await readHouseholdState(db, context));
  } catch (error) {
    return handleError(error);
  }
}

export async function handleHouseholdPost(
  request: Request,
  db: D1Database
) {
  try {
    const user = authenticatedUser(request);
    const body = await requestBody(request);
    await ensureReadableSchema(db);
    const context = await requestHouseholdContext(db, user, sandboxRequested(body.sandbox));
    const action = body.action as HouseholdPostRequest["action"] | undefined;

    if (action === "add_list_item") {
      return await addListItem(db, context, body);
    }
    if (action === "add_feedback") {
      return await addFeedback(db, context, body);
    }
    if (action === "set_product_memory") {
      return await setProductMemory(db, context, body);
    }
    if (action === "ingest_receipt_draft") {
      return await ingestReceiptDraft(db, context, body);
    }
    if (action === "create_ad_hoc_receipt") {
      return await createAdHocReceipt(db, context, body);
    }
    if (action === "answer_review_question") {
      return await answerReviewQuestion(db, context, body);
    }

    throw new ApiError(400, "Unsupported action");
  } catch (error) {
    return handleError(error);
  }
}

export async function handleHouseholdPatch(
  request: Request,
  db: D1Database
) {
  try {
    const user = authenticatedUser(request);
    const body = await requestBody(request);
    await ensureReadableSchema(db);
    const context = await requestHouseholdContext(db, user, sandboxRequested(body.sandbox));
    const action = body.action as HouseholdPatchRequest["action"] | undefined;

    if (action === "set_item_included") {
      return await setListItemBoolean(db, context, body, "included");
    }
    if (action === "set_item_checked") {
      return await setListItemBoolean(db, context, body, "checked");
    }
    if (action === "freeze_trip") {
      return await freezeTrip(db, context, body);
    }
    if (action === "unfreeze_trip") {
      return await unfreezeTrip(db, context, body);
    }
    if (action === "reopen_sandbox_trip") {
      return await reopenSandboxTrip(db, context, body);
    }
    if (action === "update_receipt_draft") {
      return await updateReceiptDraft(db, context, body);
    }
    if (action === "update_ad_hoc_receipt") {
      return await updateAdHocReceipt(db, context, body);
    }
    if (action === "finalize_receipt") {
      return await finalizeReceipt(db, context, body);
    }
    if (action === "apply_receipt_correction") {
      return await applyHistoricalReceiptCorrection(db, context, body);
    }
    if (action === "finalize_ad_hoc_receipt") {
      return await finalizeAdHocReceipt(db, context, body);
    }
    if (action === "discard_ad_hoc_receipt") {
      return await discardAdHocReceipt(db, context, body);
    }
    if (action === "confirm_product_metadata") {
      return await confirmProductMetadata(db, context, body);
    }
    if (action === "confirm_receipt_product") {
      const receiptItemId = requiredString(body.receiptItemId, "receiptItemId", 128);
      const canonicalName = requiredString(body.canonicalName, "canonicalName", 140);
      const category = requiredString(body.category, "category", 80);
      const productId = await confirmReceiptProduct(db, context, receiptItemId, null, {
        canonicalName,
        category,
      });
      return json({ productId });
    }

    throw new ApiError(400, "Unsupported action");
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(request: Request) {
  try {
    return await handleHouseholdGet(request, await getD1());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    return await handleHouseholdPost(request, await getD1());
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    return await handleHouseholdPatch(request, await getD1());
  } catch (error) {
    return handleError(error);
  }
}
