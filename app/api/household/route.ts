import {
  AUDITED_RECEIPT_ITEMS_2026,
  AUDITED_RECEIPT_TRANSACTIONS_2026,
  RECURRING_PRODUCT_HISTORIES_2026,
} from "../../basketsense-data";
import { buildSaturdayRecommendations } from "../../recommendation-engine";

import type {
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
  TripListItemSummary,
  TripStatus,
  TripSummary,
} from "./types";

export const dynamic = "force-dynamic";

const HOUSEHOLD_ID = "household_basketsense";
const HOUSEHOLD_SLUG = "basket-sense-household";
const HOUSEHOLD_NAME = "BasketSense household";
const HOUSEHOLD_TIME_ZONE = "America/Los_Angeles";

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
    brand TEXT,
    unit_description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS products_household_item_number_unique
    ON products (household_id, costco_item_number)`,
  `CREATE INDEX IF NOT EXISTS products_household_name_idx
    ON products (household_id, canonical_name)`,
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
  brand: string | null;
  unit_description: string | null;
  active: number;
}

interface ReceiptTransactionRow {
  id: string;
  household_id: string;
  trip_id: string | null;
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
  const [transactionCount, itemCount] = await Promise.all([
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
  ]);

  if (
    transactionCount?.count === AUDITED_RECEIPT_TRANSACTIONS_2026.length &&
    itemCount?.count === AUDITED_RECEIPT_ITEMS_2026.length
  ) {
    return;
  }

  const now = nowIso();
  const productByItemNumber = new Map<string, string>();
  const productStatements: D1PreparedStatement[] = [];

  for (const item of AUDITED_RECEIPT_ITEMS_2026) {
    if (productByItemNumber.has(item.itemNumber)) continue;
    const productId = productIdFor(item.itemNumber);
    productByItemNumber.set(item.itemNumber, productId);
    productStatements.push(
      db
        .prepare(
          `INSERT INTO products (
            id, household_id, costco_item_number, canonical_name,
            active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            canonical_name = excluded.canonical_name,
            updated_at = excluded.updated_at`
        )
        .bind(
          productId,
          householdId,
          item.itemNumber,
          item.canonicalName,
          now,
          now
        )
    );
  }
  await runPreparedInChunks(db, productStatements);

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

  const scheduledFor = nextSaturday(household.time_zone);
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

  const currentTrip = await db
    .prepare(
      `SELECT * FROM trips
       WHERE household_id = ? AND scheduled_for = ?
       LIMIT 1`
    )
    .bind(household.id, scheduledFor)
    .first<TripRow>();

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
    brand: row.brand,
    unitDescription: row.unit_description,
    active: Boolean(row.active),
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
        `SELECT * FROM products
         WHERE household_id = ? AND active = 1
         ORDER BY canonical_name COLLATE NOCASE ASC`
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

  const label = requiredString(body.label, "label", 140);
  const productId = optionalId(body.productId, "productId");
  if (productId) {
    const product = await db
      .prepare(
        `SELECT id FROM products WHERE id = ? AND household_id = ? LIMIT 1`
      )
      .bind(productId, context.household.id)
      .first<{ id: string }>();
    if (!product) throw new ApiError(404, "Product not found");
  }

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
  const estimatedPriceCents = optionalInteger(
    body.estimatedPriceCents,
    "estimatedPriceCents",
    0,
    10_000_000
  );
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
