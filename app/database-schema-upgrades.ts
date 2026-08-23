type SchemaColumn = {
  name: string;
  notnull?: number;
};

type SchemaMigrationRow = {
  status: string;
};

const schemaUpgradePromises = new WeakMap<D1Database, Promise<void>>();

export const LATEST_BASKETSENSE_SCHEMA_MIGRATION_ID =
  "0015_recommendation_shadow";

const RECEIPT_INGESTION_REBUILD_STATEMENTS = [
  `DROP TABLE IF EXISTS __basketsense_new_receipt_ingestions`,
  `CREATE TABLE __basketsense_new_receipt_ingestions (
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
    extraction_artifact_key TEXT,
    receipt_transaction_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL,
    FOREIGN KEY (receipt_transaction_id) REFERENCES receipt_transactions(id) ON DELETE SET NULL
  )`,
  `INSERT INTO __basketsense_new_receipt_ingestions (
    id, household_id, trip_id, requested_by_member_id, client_request_id,
    source_storage_key, source_sha256, source_content_type, source_byte_size,
    status, revision, attempt_count, workflow_instance_id, provider, model,
    prompt_version, schema_version, extraction_artifact_key,
    receipt_transaction_id, error_code, created_at, updated_at, completed_at
  )
  SELECT
    id, household_id, trip_id, requested_by_member_id, client_request_id,
    source_storage_key, source_sha256, source_content_type, source_byte_size,
    status, revision, attempt_count, workflow_instance_id, provider, model,
    prompt_version, schema_version, extraction_artifact_key,
    receipt_transaction_id, error_code, created_at, updated_at, completed_at
  FROM receipt_ingestions`,
  `DROP TABLE receipt_ingestions`,
  `ALTER TABLE __basketsense_new_receipt_ingestions RENAME TO receipt_ingestions`,
  `CREATE UNIQUE INDEX receipt_ingestions_household_client_request_unique
    ON receipt_ingestions (household_id, client_request_id)`,
  `CREATE UNIQUE INDEX receipt_ingestions_source_storage_key_unique
    ON receipt_ingestions (source_storage_key)`,
  `CREATE INDEX receipt_ingestions_household_status_idx
    ON receipt_ingestions (household_id, status, updated_at)`,
  `CREATE INDEX receipt_ingestions_trip_idx
    ON receipt_ingestions (trip_id)`,
  `CREATE INDEX receipt_ingestions_receipt_idx
    ON receipt_ingestions (receipt_transaction_id)`,
];

const PRODUCT_IMAGE_JOB_STATEMENTS = [
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
];

const RECEIPT_CORRECTION_STATEMENTS = [
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
];

const PRODUCT_UNDERSTANDING_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS product_understandings (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    lookup_key TEXT NOT NULL,
    costco_item_number TEXT,
    raw_description TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    brand TEXT,
    product_family TEXT,
    variant TEXT,
    category_hint TEXT,
    confidence_bps INTEGER NOT NULL,
    exact_sku_known INTEGER NOT NULL DEFAULT 0,
    search_aliases_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS product_understandings_household_lookup_unique
    ON product_understandings (household_id, lookup_key)`,
  `CREATE INDEX IF NOT EXISTS product_understandings_item_number_idx
    ON product_understandings (household_id, costco_item_number)`,
  `CREATE TABLE IF NOT EXISTS intent_fulfillments (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    intent_key TEXT NOT NULL,
    receipt_key TEXT NOT NULL,
    raw_intent_label TEXT NOT NULL,
    raw_receipt_description TEXT NOT NULL,
    costco_item_number TEXT,
    relation TEXT NOT NULL,
    confidence_bps INTEGER NOT NULL DEFAULT 10000,
    confirmed_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (confirmed_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS intent_fulfillments_household_pair_unique
    ON intent_fulfillments (household_id, intent_key, receipt_key)`,
  `CREATE INDEX IF NOT EXISTS intent_fulfillments_household_intent_idx
    ON intent_fulfillments (household_id, intent_key)`,
];

const RECOMMENDATION_SHADOW_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS recommendation_shadow_runs (
    id TEXT PRIMARY KEY NOT NULL,
    household_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    mode TEXT NOT NULL,
    attention_budget INTEGER NOT NULL,
    catalog_size INTEGER NOT NULL,
    eligible_count INTEGER NOT NULL,
    metrics_json TEXT NOT NULL,
    created_by_member_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_member_id) REFERENCES household_members(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recommendation_shadow_runs_household_cycle_unique
    ON recommendation_shadow_runs (household_id, as_of_date, engine_version, mode)`,
  `CREATE INDEX IF NOT EXISTS recommendation_shadow_runs_household_created_idx
    ON recommendation_shadow_runs (household_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS recommendation_shadow_candidates (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    rank INTEGER,
    score_bps INTEGER NOT NULL,
    eligible INTEGER NOT NULL,
    selected INTEGER NOT NULL,
    product_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    components_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (run_id) REFERENCES recommendation_shadow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS recommendation_shadow_candidates_run_product_unique
    ON recommendation_shadow_candidates (run_id, product_id)`,
  `CREATE INDEX IF NOT EXISTS recommendation_shadow_candidates_run_rank_idx
    ON recommendation_shadow_candidates (run_id, rank)`,
];

function changeCount(result: D1Result<unknown>) {
  return Number(result.meta?.changes ?? 0);
}

async function tableColumns(db: D1Database, tableName: string) {
  const result = await db.prepare(`PRAGMA table_info('${tableName}')`).all<SchemaColumn>();
  return result.results ?? [];
}

async function waitForMigration(db: D1Database, migrationId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await db
      .prepare(`SELECT status FROM basketsense_schema_migrations WHERE id = ? LIMIT 1`)
      .bind(migrationId)
      .first<SchemaMigrationRow>();
    if (row?.status === "completed") return;
    if (row?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`BasketSense schema migration ${migrationId} is still in progress`);
}

async function runClaimedMigration(
  db: D1Database,
  migrationId: string,
  migrate: () => Promise<void>,
) {
  const claim = await db
    .prepare(
      `INSERT OR IGNORE INTO basketsense_schema_migrations
        (id, status, started_at, updated_at)
       VALUES (?, 'applying', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .bind(migrationId)
    .run();

  let claimed = changeCount(claim) !== 0;
  if (!claimed) {
    const retry = await db
      .prepare(
        `UPDATE basketsense_schema_migrations
         SET status = 'applying',
             started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             completed_at = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'failed'`,
      )
      .bind(migrationId)
      .run();
    claimed = changeCount(retry) !== 0;
  }

  if (!claimed) {
    await waitForMigration(db, migrationId);
    return;
  }

  try {
    await migrate();
    await db
      .prepare(
        `UPDATE basketsense_schema_migrations
         SET status = 'completed',
             completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .bind(migrationId)
      .run();
  } catch (error) {
    await db
      .prepare(
        `UPDATE basketsense_schema_migrations
         SET status = 'failed',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .bind(migrationId)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

async function addColumnIfMissing(
  db: D1Database,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = await tableColumns(db, tableName);
  if (columns.some((column) => column.name === columnName)) return;
  try {
    await db.prepare(`ALTER TABLE ${tableName} ADD ${definition}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column name/i.test(message)) throw error;
  }
}

async function performSchemaUpgrades(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS basketsense_schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`).run();

  const householdColumns = await tableColumns(db, "households");
  if (householdColumns.length === 0) return;

  await runClaimedMigration(db, "0009_nullable_receipt_ingestion_trip", async () => {
    const columns = await tableColumns(db, "receipt_ingestions");
    const tripColumn = columns.find((column) => column.name === "trip_id");
    if (tripColumn && Number(tripColumn.notnull ?? 0) !== 0) {
      await db.batch(
        RECEIPT_INGESTION_REBUILD_STATEMENTS.map((statement) => db.prepare(statement)),
      );
    }
  });

  await runClaimedMigration(db, "0010_product_image_jobs", async () => {
    await db.batch(PRODUCT_IMAGE_JOB_STATEMENTS.map((statement) => db.prepare(statement)));
  });

  await runClaimedMigration(db, "0011_receipt_corrections_and_diagnostics", async () => {
    await db.batch(RECEIPT_CORRECTION_STATEMENTS.map((statement) => db.prepare(statement)));
    await addColumnIfMissing(db, "receipt_ingestions", "recovery_manifest_key", "recovery_manifest_key TEXT");
    await addColumnIfMissing(db, "receipt_ingestions", "provider_response_id", "provider_response_id TEXT");
    await addColumnIfMissing(db, "receipt_ingestions", "provider_finish_reason", "provider_finish_reason TEXT");
    await addColumnIfMissing(db, "receipt_ingestions", "provider_duration_ms", "provider_duration_ms INTEGER");
    await addColumnIfMissing(db, "receipt_ingestions", "extraction_pass", "extraction_pass INTEGER");
  });

  await runClaimedMigration(db, "0012_product_memory_feedback", async () => {
    await addColumnIfMissing(db, "feedback", "product_id", "product_id TEXT REFERENCES products(id)");
    await db.prepare(
      `UPDATE feedback
       SET product_id = (
         SELECT receipt_items.product_id
         FROM receipt_items
         WHERE receipt_items.id = feedback.receipt_item_id
         LIMIT 1
       )
       WHERE kind = 'product_experience'
         AND product_id IS NULL`,
    ).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS feedback_product_idx ON feedback (product_id)`).run();
  });

  await runClaimedMigration(db, "0014_product_understanding_and_intent_fulfillment", async () => {
    await db.batch(PRODUCT_UNDERSTANDING_STATEMENTS.map((statement) => db.prepare(statement)));
    await addColumnIfMissing(db, "receipt_items", "interpreted_name", "interpreted_name TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpreted_brand", "interpreted_brand TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpreted_product_family", "interpreted_product_family TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpreted_variant", "interpreted_variant TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpretation_category_hint", "interpretation_category_hint TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpretation_confidence_bps", "interpretation_confidence_bps INTEGER");
    await addColumnIfMissing(db, "receipt_items", "interpretation_source", "interpretation_source TEXT");
    await addColumnIfMissing(db, "receipt_items", "interpretation_model", "interpretation_model TEXT");
  });

  await runClaimedMigration(db, LATEST_BASKETSENSE_SCHEMA_MIGRATION_ID, async () => {
    await db.batch(RECOMMENDATION_SHADOW_STATEMENTS.map((statement) => db.prepare(statement)));
  });
}

export async function ensureBasketSenseSchemaUpgrades(db: D1Database) {
  const existing = schemaUpgradePromises.get(db);
  if (existing) {
    await existing;
    return;
  }

  const upgrade = performSchemaUpgrades(db).catch((error: unknown) => {
    schemaUpgradePromises.delete(db);
    throw error;
  });
  schemaUpgradePromises.set(db, upgrade);
  await upgrade;
}
