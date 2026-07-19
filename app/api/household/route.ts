import {
  AUDITED_RECEIPT_ITEMS_2026,
  AUDITED_RECEIPT_TRANSACTIONS_2026,
  RECURRING_PRODUCT_HISTORIES_2026,
} from "../../basketsense-data";
import { buildSaturdayRecommendations } from "../../recommendation-engine";
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

import type {
  ClosedLoopComparison,
  ClosedLoopReceiptItem,
  ClosedLoopReview,
  FeedbackKind,
  FeedbackSummary,
  HouseholdBootstrapResponse,
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
  TripStatus,
  TripSummary,
} from "./types";

export const dynamic = "force-dynamic";

const HOUSEHOLD_ID = "household_basketsense";
const HOUSEHOLD_SLUG = "basket-sense-household";
const HOUSEHOLD_NAME = "BasketSense household";
const HOUSEHOLD_TIME_ZONE = "America/Los_Angeles";
const PRODUCT_CATALOG_REVISION = "audited-2026-07-18-v2";

const REVIEWABLE_PRODUCT_CATEGORIES = new Set<ProductCategoryKey>([
  "groceries_beverages",
  "clothing_accessories",
  "household_supplies",
  "health_personal_care",
  "home_kitchen_seasonal",
  "toys_books_activities",
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
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
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
  added_by_member_id: string | null;
  created_at: string;
  updated_at: string;
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
  confirmation_source: "historical" | "member";
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

  const initialization = db
    .batch(RUNTIME_SCHEMA_STATEMENTS.map((statement) => db.prepare(statement)))
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaInitializations.delete(db);
      throw error;
    });

  schemaInitializations.set(db, initialization);
  await initialization;
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

  const [transactionCount, itemCount, currentCatalogCount] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM receipt_transactions
         WHERE household_id = ?`
      )
      .bind(householdId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM receipt_items
         WHERE receipt_transaction_id IN (
           SELECT id FROM receipt_transactions WHERE household_id = ?
      )`
      )
      .bind(householdId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM products
         WHERE household_id = ? AND catalog_revision = ?`
      )
      .bind(householdId, PRODUCT_CATALOG_REVISION)
      .first<{ count: number }>(),
  ]);

  const now = nowIso();
  if ((currentCatalogCount?.count ?? 0) !== productByItemNumber.size) {
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
    transactionCount?.count === AUDITED_RECEIPT_TRANSACTIONS_2026.length &&
    itemCount?.count === AUDITED_RECEIPT_ITEMS_2026.length
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
  const recommendations = buildSaturdayRecommendations(
    RECURRING_PRODUCT_HISTORIES_2026,
    trip.scheduled_for,
  );
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
          ON CONFLICT(id) DO NOTHING`
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

  return { household, member, currentTrip };
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

async function readHouseholdState(
  db: D1Database,
  context: HouseholdContext
): Promise<HouseholdBootstrapResponse> {
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
        `SELECT * FROM trips
         WHERE household_id = ?
         ORDER BY scheduled_for DESC, created_at DESC
         LIMIT 12`
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
                latest.raw_description AS latest_raw_description,
                latest.purchased_at AS latest_purchased_at,
                latest.regular_unit_price_cents AS latest_regular_unit_price_cents,
                latest.paid_unit_price_cents AS latest_paid_unit_price_cents,
                latest.discount_unit_cents AS latest_discount_unit_cents
         FROM products
         LEFT JOIN household_members AS reviewer
           ON reviewer.id = products.category_reviewed_by_member_id
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
               AND receipt_transactions.transaction_type = 'warehouse'
               AND receipt_transactions.parse_status = 'reconciled'
           ) AS ranked
           WHERE ranked.price_rank = 1
         ) AS latest ON latest.product_id = products.id
         WHERE products.household_id = ? AND products.active = 1
         ORDER BY products.canonical_name COLLATE NOCASE ASC`
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

  const members = results[0].results as unknown as MemberRow[];
  const recentTrips = results[1].results as unknown as TripRow[];
  const listItems = results[2].results as unknown as ListItemRow[];
  const products = results[3].results as unknown as ProductRow[];
  const receipts = results[4].results as unknown as ReceiptTransactionRow[];
  const feedbackRows = results[5].results as unknown as FeedbackRow[];

  return {
    household: {
      id: context.household.id,
      name: context.household.name,
      timeZone: context.household.time_zone,
    },
    currentUser: memberSummary(context.member),
    members: members.map(memberSummary),
    currentTrip: tripSummary(context.currentTrip),
    recentTrips: recentTrips.map(tripSummary),
    listItems: listItems.map(listItemSummary),
    products: products.map(productSummary),
    receiptTransactions: receipts.map(receiptSummary),
    feedback: feedbackRows.map(feedbackSummary),
    closedLoop: await readClosedLoopReview(db, context.household.id),
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
  const source =
    trip.status === "frozen" && sourceValue === "manual"
      ? "in_store"
      : (sourceValue as ListItemSource);
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
  const estimatedPriceCents =
    requestedEstimatedPriceCents ??
    catalogMatch?.latest_regular_unit_price_cents ??
    null;
  const quantityMilli =
    optionalInteger(body.quantityMilli, "quantityMilli", 1, 1_000_000) ??
    1000;
  const addedAfterFreeze = trip.status === "frozen";
  const includedAtFreeze = addedAfterFreeze ? 0 : null;
  const id = crypto.randomUUID();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO trip_list_items (
        id, trip_id, product_id, label, section, source,
        recommendation_reason, confidence_bps, included, checked,
        included_at_freeze, added_after_freeze, estimated_price_cents,
        quantity_milli, sort_order, added_by_member_id, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM trip_list_items WHERE trip_id = ?),
        ?, ?, ?
      )`
    )
    .bind(
      id,
      trip.id,
      productId,
      label,
      section,
      source,
      recommendationReason,
      confidenceBps,
      included ? 1 : 0,
      includedAtFreeze,
      addedAfterFreeze ? 1 : 0,
      estimatedPriceCents,
      quantityMilli,
      trip.id,
      context.member.id,
      now,
      now
    )
    .run();

  const item = await db
    .prepare(`SELECT * FROM trip_list_items WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ListItemRow>();
  if (!item) throw new ApiError(500, "Unable to add the list item");

  return json({ item: listItemSummary(item) }, 201);
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
  const now = nowIso();
  const statement =
    column === "included"
      ? `UPDATE trip_list_items SET included = ?, updated_at = ? WHERE id = ?`
      : `UPDATE trip_list_items SET checked = ?, updated_at = ? WHERE id = ?`;

  await db.prepare(statement).bind(value ? 1 : 0, now, item.id).run();

  const updated = await db
    .prepare(`SELECT * FROM trip_list_items WHERE id = ? LIMIT 1`)
    .bind(item.id)
    .first<ListItemRow>();
  if (!updated) throw new ApiError(500, "Unable to update the list item");

  return json({ item: listItemSummary(updated) });
}

async function ensureIntentSnapshot(
  db: D1Database,
  context: HouseholdContext,
  trip: TripRow,
  evidenceLevel: "pre_trip" | "upload_fallback"
) {
  let snapshot = await db
    .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
    .bind(trip.id)
    .first<IntentSnapshotRow>();

  const listItems = await db
    .prepare(
      `SELECT * FROM trip_list_items
       WHERE trip_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    )
    .bind(trip.id)
    .all<ListItemRow>();

  if (!snapshot) {
    const includedItems = listItems.results.filter((item) =>
      trip.status === "planning"
        ? Boolean(item.included)
        : Boolean(item.included_at_freeze ?? item.included)
    );
    const priced = includedItems.filter(
      (item) => item.estimated_price_cents !== null
    );
    const estimatedTotalCents = priced.reduce(
      (sum, item) =>
        sum +
        Math.round(
          ((item.estimated_price_cents ?? 0) * item.quantity_milli) / 1000
        ),
      0
    );
    const snapshotId = crypto.randomUUID();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO trip_intent_snapshots (
          id, trip_id, evidence_level, estimated_total_cents,
          priced_item_count, unpriced_item_count, captured_by_member_id,
          captured_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(trip_id) DO NOTHING`
      )
      .bind(
        snapshotId,
        trip.id,
        evidenceLevel,
        estimatedTotalCents,
        priced.length,
        includedItems.length - priced.length,
        context.member.id,
        now,
        now
      )
      .run();
    snapshot = await db
      .prepare(`SELECT * FROM trip_intent_snapshots WHERE trip_id = ? LIMIT 1`)
      .bind(trip.id)
      .first<IntentSnapshotRow>();
  }

  if (!snapshot) {
    throw new ApiError(500, "Unable to preserve the saved trip plan");
  }

  const now = nowIso();
  const statements = listItems.results.map((item) => {
    const included =
      trip.status === "planning"
        ? item.included
        : (item.included_at_freeze ?? item.included);
    return db
      .prepare(
        `INSERT INTO trip_intent_items (
          id, snapshot_id, trip_id, list_item_id, product_id, label,
          section, source, recommendation_reason, confidence_bps, included,
          quantity_milli, estimated_price_cents, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_id, list_item_id) DO NOTHING`
      )
      .bind(
        crypto.randomUUID(),
        snapshot.id,
        trip.id,
        item.id,
        item.product_id,
        item.label,
        item.section,
        item.source,
        item.recommendation_reason,
        item.confidence_bps,
        included,
        item.quantity_milli,
        item.estimated_price_cents,
        item.sort_order,
        now
      );
  });
  await runPreparedInChunks(db, statements);
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
    await db.batch([
      db
        .prepare(
          `UPDATE trip_list_items
           SET included_at_freeze = included, added_after_freeze = 0,
               updated_at = ?
           WHERE trip_id = ? AND included_at_freeze IS NULL
             AND EXISTS (
               SELECT 1 FROM trips
               WHERE id = ? AND household_id = ? AND status = 'planning'
             )`
        )
        .bind(now, trip.id, trip.id, context.household.id),
      db
        .prepare(
          `UPDATE trips
           SET status = 'frozen', frozen_at = ?,
               estimated_list_total_at_freeze_cents = (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NOT NULL
                     THEN CAST((estimated_price_cents * quantity_milli + 500) / 1000 AS INTEGER)
                     ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = ?
               ),
               estimated_priced_item_count_at_freeze = (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NOT NULL
                     THEN 1 ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = ?
               ),
               estimated_unpriced_item_count_at_freeze = (
                 SELECT COALESCE(SUM(
                   CASE
                     WHEN included_at_freeze = 1 AND estimated_price_cents IS NULL
                     THEN 1 ELSE 0
                   END
                 ), 0)
                 FROM trip_list_items
                 WHERE trip_id = ?
               ),
               updated_at = ?
           WHERE id = ? AND household_id = ? AND status = 'planning'`
        )
        .bind(
          now,
          trip.id,
          trip.id,
          trip.id,
          now,
          trip.id,
          context.household.id
        ),
    ]);
  }

  const snapshotTrip = await authorizedTrip(
    db,
    context.household.id,
    trip.id
  );
  await ensureIntentSnapshot(db, context, snapshotTrip, "pre_trip");

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

interface ValidatedDraftItem {
  sourceLineNumber: number;
  costcoItemNumber: string | null;
  rawDescription: string;
  quantityMilli: number;
  unitPriceCents: number | null;
  lineSubtotalCents: number;
  discountCents: number;
  netAmountCents: number;
  taxStatus: "taxable" | "non_taxable" | "unknown";
  isReturn: boolean;
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

function validateDraftItems(value: unknown): ValidatedDraftItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(400, "items must contain at least one receipt line");
  }
  if (value.length > 200) {
    throw new ApiError(400, "items cannot contain more than 200 lines");
  }

  const seenLines = new Set<number>();
  return value.map((entry, index) => {
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

    return {
      sourceLineNumber,
      costcoItemNumber,
      rawDescription,
      quantityMilli,
      unitPriceCents,
      lineSubtotalCents,
      discountCents,
      netAmountCents,
      taxStatus,
      isReturn: lineSubtotalCents < 0 && discountCents === 0,
    };
  });
}

function aliasKeyFor(
  costcoItemNumber: string | null,
  normalizedDescription: string
) {
  return costcoItemNumber
    ? `item:${costcoItemNumber}`
    : `description:${normalizedDescription}`;
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
    isReturn: Boolean(row.is_return),
    parseConfidenceBps:
      row.product_id === null ? 0 : (row.match_confidence_bps ?? 9_000),
  };
}

function buildClosedLoopComparison(
  receipt: ReceiptTransactionRow,
  snapshot: IntentSnapshotRow,
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
    if (!Boolean(intent.included)) {
      additionsCents += item.line_subtotal_cents;
      continue;
    }
    if (intent.estimated_price_cents === null) {
      unpricedPlannedActualCents += item.line_subtotal_cents;
      unpricedPlanned.push({
        intentItemId: intent.id,
        receiptItemId: item.id,
      });
      continue;
    }
    const estimate = Math.round(
      (intent.estimated_price_cents * intent.quantity_milli) / 1000
    );
    matchedVarianceCents += item.line_subtotal_cents - estimate;
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
    if (!item.product_id || item.match_confidence_bps === 0) {
      unresolvedCents += item.line_subtotal_cents;
      unresolved.push({ receiptItemId: item.id });
    } else {
      additionsCents += item.line_subtotal_cents;
      receiptOnly.push({ receiptItemId: item.id });
    }
  }

  return {
    isProvisional:
      receipt.parse_status !== "reconciled" || unresolved.length > 0,
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
      match.reason === "normalized_exact"
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
       WHERE receipt_transaction_id = ? AND status = 'open'`
    )
    .bind(receipt.id)
    .run();

  const candidates: QuestionCandidateInput[] = [];
  const receiptById = new Map(receiptItems.map((item) => [item.id, item]));
  const intentById = new Map(intentItems.map((item) => [item.id, item]));
  const tenPercentThreshold = Math.round(
    Math.abs(receipt.total_cents) * 0.1
  );
  const materialThreshold =
    tenPercentThreshold > 0 ? Math.min(1500, tenPercentThreshold) : 1500;
  const materialUnresolved = comparison.buckets.unresolved
    .map((entry) => receiptById.get(entry.receiptItemId))
    .filter((item): item is ReceiptItemRow => Boolean(item))
    .filter((item) => Math.abs(item.net_amount_cents) >= materialThreshold)
    .sort(
      (left, right) =>
        Math.abs(right.net_amount_cents) - Math.abs(left.net_amount_cents)
    )[0];
  if (materialUnresolved) {
    candidates.push({
      key: `verify-line:${materialUnresolved.id}`,
      purpose: "data_quality",
      prompt: `We read “${materialUnresolved.raw_description}” as ${moneyLabel(
        materialUnresolved.net_amount_cents
      )}, but could not identify the product. Is the receipt wording usable?`,
      options: [
        {
          value: "keep_as_written",
          label: "Yes, keep it",
          effect: "Creates a household product using this wording and resolves the line.",
        },
        {
          value: "correct_line",
          label: "I’ll correct it",
          effect: "Keeps the receipt provisional until the line is corrected.",
        },
        {
          value: "leave_unresolved",
          label: "Not sure yet",
          effect: "Keeps this amount visibly unresolved.",
        },
      ],
      declaredEffect: "Updates receipt product resolution or keeps it provisional",
      effectTarget: "receipt_record",
      receiptItemId: materialUnresolved.id,
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
          effect: "Confirms the receipt-to-plan match for this trip.",
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
      declaredEffect: "Confirms or rejects a possible receipt-to-plan match",
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
          effect: "Keeps the match unresolved until the receipt line is corrected.",
        },
      ],
      declaredEffect: "Carries the item forward or records why it was not matched",
      effectTarget: "next_saturday_list",
      intentItemId: intent.id,
      listItemId: intent.list_item_id,
      priority: 20,
    });
  }

  const matchedReceiptIds = new Set(
    persistedMatches.map((match) => match.receipt_item_id)
  );
  const largestAddition = receiptItems
    .filter(
      (item) =>
        !matchedReceiptIds.has(item.id) &&
        Boolean(item.product_id) &&
        !item.is_return &&
        Math.abs(item.net_amount_cents) >= materialThreshold
    )
    .sort(
      (left, right) =>
        Math.abs(right.net_amount_cents) - Math.abs(left.net_amount_cents)
    )[0];
  if (largestAddition) {
    const name = largestAddition.canonical_name ?? largestAddition.raw_description;
    candidates.push({
      key: `receipt-only:${largestAddition.id}`,
      purpose: "outcome",
      prompt: `${name} (${moneyLabel(
        largestAddition.net_amount_cents
      )}) was not on the saved list. How should we remember it?`,
      options: [
        {
          value: "worthwhile_discovery",
          label: "Worthwhile discovery",
          effect: "Adds a positive discovery signal to this product.",
        },
        {
          value: "seasonal_or_exceptional",
          label: "Seasonal or one-time",
          effect: "Records a seasonal or one-time signal for future list decisions.",
        },
        {
          value: "regular_next_time",
          label: "Add next time",
          effect: "Adds it to the next planning trip.",
        },
      ],
      declaredEffect: "Updates the product insight or next Saturday list",
      effectTarget: "product_insight",
      receiptItemId: largestAddition.id,
      priority: 40,
    });
  }

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

async function readClosedLoopReview(
  db: D1Database,
  householdId: string,
  receiptId?: string
): Promise<ClosedLoopReview | null> {
  const receipt = receiptId
    ? await authorizedReceipt(db, householdId, receiptId)
    : await db
        .prepare(
          `SELECT * FROM receipt_transactions
           WHERE household_id = ? AND trip_id IS NOT NULL
           ORDER BY purchased_at DESC, created_at DESC
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

  const [inputs, matchesResult, questionsResult, upload] = await Promise.all([
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
  });
  const comparison = buildClosedLoopComparison(
    receipt,
    snapshot,
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
  });
  const now = nowIso();
  const parseStatus = arithmetic.isReconciled ? "reconciled" : "needs_review";
  const auditFlag = arithmetic.isReconciled
    ? "closed_loop_reconciled"
    : `closed_loop_delta:${arithmetic.subtotalDeltaCents ?? "missing"}:${
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
          resolution.product
            ? "normalized_from_history"
            : "receipt_abbreviation",
          item.isReturn ? 1 : 0,
          resolution.confidenceBps,
          now,
          now
        )
    );
  }
  await runPreparedInChunks(db, statements);
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

  const purchasedAt = requiredDateTime(body.purchasedAt, "purchasedAt");
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
  const items = validateDraftItems(body.items);
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
  await db
    .prepare(
      `INSERT INTO receipt_transactions (
        id, household_id, trip_id, source_transaction_key,
        transaction_type, source_type, purchased_at, item_gross_cents,
        item_count, subtotal_cents, tax_cents, discount_cents, total_cents,
        household_funded_cents, external_funding_cents, audit_flag,
        parse_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'warehouse', 'receipt_photo', ?, ?, ?, ?, ?, ?, ?, ?,
                0, 'closed_loop_draft', 'needs_review', ?, ?)`
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
      now,
      now
    )
    .run();
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
  const purchasedAt =
    body.purchasedAt === undefined
      ? receipt.purchased_at
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
  const items =
    body.items === undefined ? null : validateDraftItems(body.items);
  const now = nowIso();
  await db
    .prepare(
      `UPDATE receipt_transactions
       SET purchased_at = ?, subtotal_cents = ?, tax_cents = ?,
           discount_cents = ?, total_cents = ?, household_funded_cents = ?,
           parse_status = 'needs_review', audit_flag = 'closed_loop_corrected',
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
  return receiptMutationResponse(closedLoop);
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
      item.estimatedPriceCents,
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
  requestedProductId?: string | null
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
    productId = crypto.randomUUID();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO products (
          id, household_id, costco_item_number, canonical_name,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
      .bind(
        productId,
        context.household.id,
        receiptItem.costco_item_number,
        receiptItem.raw_description,
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
      await db
        .prepare(
          `UPDATE review_questions
           SET status = 'dismissed', answer_value = 'skip',
               answered_by_member_id = ?, answered_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`
        )
        .bind(context.member.id, now, now, question.id)
        .run();
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
  const replacementReceiptItemId = optionalId(
    body.replacementReceiptItemId,
    "replacementReceiptItemId"
  );
  const now = nowIso();

  if (
    question.receipt_item_id &&
    (value === "keep_as_written" || productId)
  ) {
    await confirmReceiptProduct(
      db,
      context,
      question.receipt_item_id,
      productId
    );
  }
  if (
    value === "yes_substitution" &&
    question.intent_item_id &&
    (question.receipt_item_id || replacementReceiptItemId)
  ) {
    const receiptItemId = question.receipt_item_id ?? replacementReceiptItemId!;
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
           answered_by_member_id = ?, answered_at = ?, updated_at = ?
       WHERE id = ? AND status = 'open'`
    )
    .bind(value, note, context.member.id, now, now, question.id)
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
    await ensureSchema(db);
    const context = await bootstrapHousehold(db, user);
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
    await ensureSchema(db);
    const context = await bootstrapHousehold(db, user);
    const action = body.action as HouseholdPostRequest["action"] | undefined;

    if (action === "add_list_item") {
      return await addListItem(db, context, body);
    }
    if (action === "add_feedback") {
      return await addFeedback(db, context, body);
    }
    if (action === "ingest_receipt_draft") {
      return await ingestReceiptDraft(db, context, body);
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
    await ensureSchema(db);
    const context = await bootstrapHousehold(db, user);
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
    if (action === "update_receipt_draft") {
      return await updateReceiptDraft(db, context, body);
    }
    if (action === "finalize_receipt") {
      return await finalizeReceipt(db, context, body);
    }
    if (action === "confirm_product_metadata") {
      return await confirmProductMetadata(db, context, body);
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
