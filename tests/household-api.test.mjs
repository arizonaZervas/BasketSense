import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RECURRING_PRODUCT_HISTORIES_2026 } from "../app/basketsense-data.ts";
import { buildDashboardViewData } from "../app/basketsense-dashboard-data.ts";
import {
  handleHouseholdGet,
  handleHouseholdPatch,
  handleHouseholdPost,
  readFinalTripListEstimate,
} from "../app/api/household/route.ts";
import {
  buildSaturdayRecommendations,
  JULY_25_PLAN_DATE,
} from "../app/recommendation-engine.ts";

class PreparedStatementAdapter {
  constructor(
    database,
    sql,
    values = [],
    beforeExecute = null,
    reportedChanges = null,
  ) {
    this.database = database;
    this.sql = sql;
    this.values = values;
    this.beforeExecute = beforeExecute;
    this.reportedChanges = reportedChanges;
  }

  bind(...values) {
    return new PreparedStatementAdapter(
      this.database,
      this.sql,
      values,
      this.beforeExecute,
      this.reportedChanges,
    );
  }

  async run() {
    return this.execute(false);
  }

  async first() {
    this.beforeExecute?.(this.sql);
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return this.execute(true);
  }

  execute(forceRows) {
    this.beforeExecute?.(this.sql);
    const returnsRows =
      forceRows || /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(this.sql);
    const statement = this.database.prepare(this.sql);
    if (returnsRows) {
      return {
        success: true,
        results: statement.all(...this.values),
        meta: {},
      };
    }

    const result = statement.run(...this.values);
    const changes = Number(result.changes);
    return {
      success: true,
      results: [],
      meta: {
        changes: this.reportedChanges
          ? this.reportedChanges(this.sql, changes)
          : changes,
      },
    };
  }
}

class D1DatabaseAdapter {
  constructor(database = null, reportedChanges = null) {
    this.database = database ?? new DatabaseSync(":memory:");
    this.ownsDatabase = database === null;
    this.database.exec("PRAGMA foreign_keys = ON");
    this.failNextBatchPattern = null;
    this.beforeNextStatement = null;
    this.batchCalls = 0;
    this.schemaBatchCalls = 0;
    this.reportedChanges = reportedChanges;
  }

  prepare(sql) {
    return new PreparedStatementAdapter(
      this.database,
      sql,
      [],
      (statement) => {
        if (
          this.beforeNextStatement &&
          this.beforeNextStatement.pattern.test(statement)
        ) {
          const { mutation } = this.beforeNextStatement;
          this.beforeNextStatement = null;
          mutation(this.database);
        }
      },
      this.reportedChanges,
    );
  }

  async batch(statements) {
    this.batchCalls += 1;
    if (
      statements.some((statement) =>
        /CREATE TABLE IF NOT EXISTS households/i.test(statement.sql),
      )
    ) {
      this.schemaBatchCalls += 1;
    }
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (
          this.failNextBatchPattern &&
          this.failNextBatchPattern.test(statement.sql)
        ) {
          this.failNextBatchPattern = null;
          throw new Error("Injected D1 batch failure");
        }
        return statement.execute(false);
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  failNextBatchMatching(pattern) {
    this.failNextBatchPattern = pattern;
  }

  beforeNextStatementMatching(pattern, mutation) {
    this.beforeNextStatement = { pattern, mutation };
  }

  close() {
    if (this.ownsDatabase) this.database.close();
  }
}

function householdRequest(email, method = "GET", body, search = "") {
  return new Request(`https://basket-sense.test/api/household${search}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "oai-authenticated-user-email": email,
      "oai-authenticated-user-full-name": encodeURIComponent(
        email.split("@")[0],
      ),
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function responseJson(response) {
  const body = await response.json();
  assert.ok(body && typeof body === "object");
  return body;
}

function receiptTimestampForTrip(trip, time = "10:30:00") {
  return `${trip.scheduledFor}T${time}-07:00`;
}

test("D1 dashboard matches the audited historical view before client cutover", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const response = await responseJson(
      await handleHouseholdGet(householdRequest("dashboard-owner@example.test"), db),
    );

    assert.deepEqual(response.dashboard, buildDashboardViewData());
  } finally {
    db.close();
  }
});

test("core household reads defer dashboard calculation until Insights is requested", async (t) => {
  const db = new D1DatabaseAdapter();
  try {
    const core = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "lazy-insights-owner@example.test",
          "GET",
          undefined,
          "?view=core",
        ),
        db,
      ),
    );

    assert.equal("dashboard" in core, false);
    assert.equal("recentTrips" in core, false);
    assert.equal("receiptTransactions" in core, false);
    assert.equal("feedback" in core, false);
    assert.ok(core.listItems.length > 0);
    assert.ok(core.products.length > 0);

    const insights = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "lazy-insights-owner@example.test",
          "GET",
          undefined,
          "?view=insights",
        ),
        db,
      ),
    );

    assert.deepEqual(
      Object.keys(insights).sort(),
      ["dashboard", "historyRevision"],
    );
    assert.equal(insights.historyRevision, core.historyRevision);
    assert.deepEqual(insights.dashboard, buildDashboardViewData());

    const full = await responseJson(
      await handleHouseholdGet(
        householdRequest("lazy-insights-owner@example.test"),
        db,
      ),
    );
    const coreBytes = Buffer.byteLength(JSON.stringify(core));
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    t.diagnostic(`core=${coreBytes} bytes full=${fullBytes} bytes`);
    assert.ok(
      coreBytes < fullBytes * 0.75,
      "the List-first response should remove at least 25% of the decoded full snapshot",
    );
  } finally {
    db.close();
  }
});

test("positive item-0000 discount summaries do not become products needing review", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const core = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "discount-summary-owner@example.test",
          "GET",
          undefined,
          "?view=core",
        ),
        db,
      ),
    );
    const householdId = core.household.id;
    const now = "2035-01-01T00:00:00.000Z";
    const groceryProduct = db.database
      .prepare(
        `SELECT id, costco_item_number
         FROM products
         WHERE household_id = ?
           AND category = 'groceries_beverages'
         LIMIT 1`,
      )
      .get(householdId);
    assert.ok(groceryProduct?.id);

    db.database
      .prepare(
        `INSERT INTO receipt_transactions (
          id, household_id, trip_id, source_transaction_key,
          transaction_type, source_type, purchased_at, item_gross_cents,
          item_count, subtotal_cents, tax_cents, discount_cents, total_cents,
          household_funded_cents, external_funding_cents, audit_flag,
          parse_status, created_at, updated_at
        ) VALUES (
          'discount-summary-transaction', ?, NULL, 'discount-summary-transaction',
          'warehouse', 'manual', ?, 2900, 2, 1000, 0, 1900, 1000,
          1000, 0, 'test_discount_summary', 'reconciled', ?, ?
        )`,
      )
      .run(householdId, now, now, now);
    db.database
      .prepare(
        `INSERT INTO receipt_items (
          id, receipt_transaction_id, product_id, source_line_number,
          costco_item_number, raw_description, quantity_milli,
          unit_price_cents, line_subtotal_cents, discount_cents,
          net_amount_cents, tax_status, normalization_status, is_return,
          created_at, updated_at
        ) VALUES
          ('discount-summary-product', 'discount-summary-transaction', ?, 1,
           ?, 'TEST PRODUCT', 1000, 1000, 1000, 0, 1000, 'non_taxable',
           'normalized_from_history', 0, ?, ?),
          ('discount-summary-line', 'discount-summary-transaction', NULL, 2,
           '0000', 'Discounts', 1000, 1900, 1900, 0, 1900, 'unknown',
           'receipt_abbreviation', 0, ?, ?)`,
      )
      .run(
        groceryProduct.id,
        groceryProduct.costco_item_number,
        now,
        now,
        now,
        now,
      );

    const insights = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "discount-summary-owner@example.test",
          "GET",
          undefined,
          "?view=insights",
        ),
        db,
      ),
    );
    const transactionLines = insights.dashboard.receiptLines.filter(
      (line) => line.transactionId === "discount-summary-transaction",
    );

    assert.equal(transactionLines.length, 1);
    assert.equal(transactionLines[0].itemNumber, groceryProduct.costco_item_number);
    assert.equal(
      insights.dashboard.products.some((product) => product.itemNumber === "0000"),
      false,
    );
    assert.equal(
      insights.dashboard.productCategories.find(
        (category) => category.key === "needs_review",
      ).householdViewCents,
      buildDashboardViewData().needsReviewWarehouseCents,
    );
  } finally {
    db.close();
  }
});

test("extra household products do not rewrite the audited seed catalog during reads", async () => {
  const db = new D1DatabaseAdapter();
  try {
    await handleHouseholdGet(
      householdRequest("catalog-seed-owner@example.test", "GET", undefined, "?view=core"),
      db,
    );

    db.database.exec(`
      INSERT INTO products (
        id, household_id, costco_item_number, canonical_name,
        category, category_status, catalog_revision,
        active, created_at, updated_at
      )
      SELECT
        'product-household-extra', household_id, 'household-extra',
        'Household extra product', category, category_status, catalog_revision,
        1, created_at, '2035-01-01T00:00:00.000Z'
      FROM products
      ORDER BY id
      LIMIT 1
    `);

    const seedProduct = db.database
      .prepare(
        `SELECT id FROM products
         WHERE id <> 'product-household-extra'
         ORDER BY id
         LIMIT 1`,
      )
      .get();
    assert.ok(seedProduct?.id);
    db.database
      .prepare("UPDATE products SET updated_at = ? WHERE id = ?")
      .run("2001-01-01T00:00:00.000Z", seedProduct.id);

    await handleHouseholdGet(
      householdRequest(
        "catalog-seed-owner@example.test",
        "GET",
        undefined,
        "?view=insights",
      ),
      db,
    );

    const unchanged = db.database
      .prepare("SELECT updated_at FROM products WHERE id = ?")
      .get(seedProduct.id);
    assert.equal(unchanged?.updated_at, "2001-01-01T00:00:00.000Z");
  } finally {
    db.close();
  }
});

test("additional receipt history does not rewrite audited seed data during reads", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const core = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "history-seed-owner@example.test",
          "GET",
          undefined,
          "?view=core",
        ),
        db,
      ),
    );

    const cloneRow = (table, overrides) => {
      const columns = db.database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      const source = db.database.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
      assert.ok(source);
      const values = columns.map((column) =>
        Object.hasOwn(overrides, column) ? overrides[column] : source[column],
      );
      db.database
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...values);
    };

    cloneRow("receipt_transactions", {
      id: "additional-receipt-history",
      source_transaction_key: "additional-receipt-history",
      trip_id: null,
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    });
    cloneRow("receipt_items", {
      id: "additional-receipt-item",
      receipt_transaction_id: "additional-receipt-history",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:00.000Z",
    });

    const insights = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          "history-seed-owner@example.test",
          "GET",
          undefined,
          "?view=insights",
        ),
        db,
      ),
    );

    assert.equal(insights.historyRevision, core.historyRevision);
  } finally {
    db.close();
  }
});

test("ready household reads avoid repeating runtime schema DDL", async () => {
  const initialized = new D1DatabaseAdapter();
  const reusedConnection = new D1DatabaseAdapter(initialized.database);
  try {
    await handleHouseholdGet(
      householdRequest("read-only-owner@example.test"),
      initialized,
    );
    reusedConnection.schemaBatchCalls = 0;

    const response = await handleHouseholdGet(
      householdRequest("read-only-owner@example.test"),
      reusedConnection,
    );

    assert.equal(response.status, 200);
    assert.equal(reusedConnection.schemaBatchCalls, 0);
  } finally {
    reusedConnection.close();
    initialized.close();
  }
});

test("ready household writes avoid repeating runtime schema DDL", async () => {
  const initialized = new D1DatabaseAdapter();
  const reusedConnection = new D1DatabaseAdapter(initialized.database);
  try {
    const initial = await responseJson(
      await handleHouseholdGet(
        householdRequest("write-only-owner@example.test"),
        initialized,
      ),
    );
    reusedConnection.schemaBatchCalls = 0;

    const response = await handleHouseholdPost(
      householdRequest("write-only-owner@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        label: "Schema test item",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      reusedConnection,
    );

    assert.equal(response.status, 201);
    assert.equal(reusedConnection.schemaBatchCalls, 0);
  } finally {
    reusedConnection.close();
    initialized.close();
  }
});

test("product memory is explicit, receipt-backed, and newest-choice wins", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const owner = "product-memory-owner@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(owner), db),
    );
    const product = initial.products.find(
      (candidate) => candidate.latestPurchasedAt !== null,
    );
    assert.ok(product, "expected a receipt-backed household product");
    assert.equal(product.memory, null);

    const pausedResponse = await handleHouseholdPost(
      householdRequest(owner, "POST", {
        action: "set_product_memory",
        productId: product.id,
        preference: "pause",
        note: "Smaller package next time",
      }),
      db,
    );
    assert.equal(pausedResponse.status, 200);
    const paused = await responseJson(pausedResponse);
    assert.equal(paused.memory.preference, "pause");
    assert.equal(paused.memory.note, "Smaller package next time");
    assert.ok(paused.memory.sourcePurchasedAt);

    const changedResponse = await handleHouseholdPost(
      householdRequest(owner, "POST", {
        action: "set_product_memory",
        productId: product.id,
        preference: "buy_again",
      }),
      db,
    );
    assert.equal(changedResponse.status, 200);

    const refreshed = await responseJson(
      await handleHouseholdGet(householdRequest(owner), db),
    );
    const remembered = refreshed.products.find(
      (candidate) => candidate.id === product.id,
    );
    assert.equal(remembered.memory.preference, "buy_again");
    assert.equal(remembered.memory.note, null);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM feedback
           WHERE household_id = ? AND kind = 'product_experience'`,
        )
        .get(initial.household.id).count,
      2,
      "memory changes remain auditable events instead of overwriting history",
    );
  } finally {
    db.close();
  }
});

test("Data Health is owner-only, household-scoped, and exportable without a SQL console", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const owner = "data-health-owner@example.test";
    const healthResponse = await handleHouseholdGet(
      householdRequest(owner, "GET", undefined, "?view=data-health"),
      db,
    );
    assert.equal(healthResponse.status, 200);
    const health = await responseJson(healthResponse);
    assert.equal(health.source, "hosted_d1");
    assert.ok(health.tableCounts.some((entry) => entry.key === "receiptItems"));
    assert.ok(health.reconciliation.totalReceipts > 0);
    assert.equal(health.importTracking.supportsBatchJobFailures, false);
    assert.ok(Array.isArray(health.receipts));
    assert.ok(Array.isArray(health.recommendationEvents));

    const exportResponse = await handleHouseholdGet(
      householdRequest(owner, "GET", undefined, "?view=export&format=json"),
      db,
    );
    assert.equal(exportResponse.status, 200);
    const exported = await responseJson(exportResponse);
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.household.id, "household_basketsense");
    assert.ok(Array.isArray(exported.records.receiptTransactions));
    assert.ok(!JSON.stringify(exported).includes("storage_key"));

    const csvResponse = await handleHouseholdGet(
      householdRequest(owner, "GET", undefined, "?view=export&format=csv"),
      db,
    );
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type"), /text\/csv/i);
    assert.match(await csvResponse.text(), /receipt_id/);

    await handleHouseholdGet(householdRequest("data-health-member@example.test"), db);
    const forbidden = await handleHouseholdGet(
      householdRequest("data-health-member@example.test", "GET", undefined, "?view=data-health"),
      db,
    );
    assert.equal(forbidden.status, 403);
    assert.match((await responseJson(forbidden)).error, /owner/i);
  } finally {
    db.close();
  }
});

test("owner-only test sandbox is isolated from shared history and inaccessible to the second member", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const owner = "sandbox-owner@example.test";
    const member = "sandbox-member@example.test";
    const shared = await responseJson(
      await handleHouseholdGet(householdRequest(owner), db),
    );
    const sandbox = await responseJson(
      await handleHouseholdGet(
        householdRequest(owner, "GET", undefined, "?sandbox=1"),
        db,
      ),
    );

    assert.equal(sandbox.household.name, "BasketSense owner-only test sandbox");
    assert.notEqual(sandbox.household.id, shared.household.id);
    assert.equal(sandbox.members.length, 1);
    assert.equal(sandbox.members[0].email, owner);
    assert.equal(sandbox.dashboard.transactions.length, 0);
    assert.ok(shared.dashboard.transactions.length > 0);

    const added = await handleHouseholdPost(
      householdRequest(owner, "POST", {
        action: "add_list_item",
        sandbox: true,
        tripId: sandbox.currentTrip.id,
        label: "Sandbox-only receipt test item",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(added.status, 201);

    const sharedAfter = await responseJson(
      await handleHouseholdGet(householdRequest(owner), db),
    );
    assert.ok(
      !sharedAfter.listItems.some((item) => item.label === "Sandbox-only receipt test item"),
    );

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "freeze_trip",
            sandbox: true,
            tripId: sandbox.currentTrip.id,
          }),
          db,
        )
      ).status,
      200,
    );
    const draft = await responseJson(
      await handleHouseholdPost(
        householdRequest(owner, "POST", {
          action: "ingest_receipt_draft",
          sandbox: true,
          clientDraftId: "sandbox-finalized-receipt",
          tripId: sandbox.currentTrip.id,
          purchasedAt: receiptTimestampForTrip(sandbox.currentTrip),
          subtotalCents: 1000,
          taxCents: 0,
          totalCents: 1000,
          discountCents: 0,
          captureMode: "totals_only",
          items: [],
        }),
        db,
      ),
    );
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "finalize_receipt",
            sandbox: true,
            receiptId: draft.receiptId,
          }),
          db,
        )
      ).status,
      200,
    );
    const sharedAfterFinalization = await responseJson(
      await handleHouseholdGet(householdRequest(owner), db),
    );
    assert.deepEqual(
      sharedAfterFinalization.dashboard,
      sharedAfter.dashboard,
      "Finalizing a sandbox receipt must not change shared totals or flash cards",
    );

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "reopen_sandbox_trip",
            sandbox: true,
            tripId: sandbox.currentTrip.id,
            receiptId: draft.receiptId,
          }),
          db,
        )
      ).status,
      200,
    );
    const reopened = await responseJson(
      await handleHouseholdGet(
        householdRequest(owner, "GET", undefined, "?sandbox=1"),
        db,
      ),
    );
    assert.equal(reopened.currentTrip.id, sandbox.currentTrip.id);
    assert.equal(reopened.currentTrip.status, "planning");
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "reopen_sandbox_trip",
            tripId: reopened.currentTrip.id,
            receiptId: draft.receiptId,
          }),
          db,
        )
      ).status,
      403,
      "The shared household route cannot reopen a sandbox receipt",
    );
    assert.equal(
      (
        await handleHouseholdPost(
          householdRequest(owner, "POST", {
            action: "add_list_item",
            sandbox: true,
            tripId: reopened.currentTrip.id,
            label: "Added after reopening the test",
            source: "manual",
            section: "essentials",
            included: true,
          }),
          db,
        )
      ).status,
      201,
      "The reopened sandbox list accepts changes",
    );
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "freeze_trip",
            sandbox: true,
            tripId: reopened.currentTrip.id,
          }),
          db,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(owner, "PATCH", {
            action: "update_receipt_draft",
            sandbox: true,
            receiptId: draft.receiptId,
            totalCents: 1000,
          }),
          db,
        )
      ).status,
      200,
      "The reopened sandbox receipt can be edited again",
    );

    await handleHouseholdGet(householdRequest(member), db);
    const denied = await handleHouseholdGet(
      householdRequest(member, "GET", undefined, "?sandbox=1"),
      db,
    );
    assert.equal(denied.status, 403);
  } finally {
    db.close();
  }
});

test("product metadata migration upgrades an existing catalog safely", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE household_members (
        id TEXT PRIMARY KEY NOT NULL
      );
      CREATE TABLE products (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL,
        costco_item_number TEXT,
        canonical_name TEXT NOT NULL,
        category TEXT,
        brand TEXT,
        unit_description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const migration = readFileSync(
      new URL("../drizzle/0003_ambiguous_dark_beast.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    const columns = db.database
      .prepare(`PRAGMA table_info(products)`)
      .all()
      .map((column) => column.name);
    for (const expected of [
      "category_status",
      "category_reviewed_at",
      "category_reviewed_by_member_id",
      "catalog_revision",
    ]) {
      assert.ok(columns.includes(expected), `Expected ${expected} to be migrated`);
    }
    db.database
      .prepare(`INSERT INTO household_members (id) VALUES (?)`)
      .run("reviewer");
    db.database
      .prepare(
        `INSERT INTO products (
          id, household_id, costco_item_number, canonical_name,
          category, brand, unit_description, active, created_at, updated_at,
          category_reviewed_by_member_id
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)`,
      )
      .run(
        "product-test",
        "household-test",
        "123",
        "Test product",
        "household_supplies",
        "2026-07-18T00:00:00.000Z",
        "2026-07-18T00:00:00.000Z",
        "reviewer",
      );
    db.database.prepare(`DELETE FROM household_members WHERE id = ?`).run("reviewer");
    assert.equal(
      db.database
        .prepare(
          `SELECT category_reviewed_by_member_id AS reviewer
           FROM products WHERE id = ?`,
        )
        .get("product-test").reviewer,
      null,
    );
  } finally {
    db.close();
  }
});

test("receipt-integrity migration adds the asynchronous-ingestion boundary and review claims", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE trips (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE household_members (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE receipt_transactions (id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, trip_id TEXT, source_type TEXT NOT NULL);
      CREATE TABLE review_questions (id TEXT PRIMARY KEY NOT NULL);
    `);
    const migration = readFileSync(
      new URL("../drizzle/0004_magical_patriot.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    const ingestionColumns = db.database
      .prepare(`PRAGMA table_info(receipt_ingestions)`)
      .all()
      .map((column) => column.name);
    assert.ok(ingestionColumns.includes("workflow_instance_id"));
    assert.ok(ingestionColumns.includes("receipt_transaction_id"));
    assert.ok(ingestionColumns.includes("completed_at"));
    const reviewColumns = db.database
      .prepare(`PRAGMA table_info(review_questions)`)
      .all()
      .map((column) => column.name);
    assert.ok(reviewColumns.includes("answer_claim_token"));
    assert.ok(reviewColumns.includes("answer_claimed_at"));
  } finally {
    db.close();
  }
});

test("standalone receipt migration preserves ingestion rows and indexes while making trip optional", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE trips (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE household_members (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE receipt_transactions (id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL, trip_id TEXT, source_type TEXT NOT NULL);
      CREATE TABLE review_questions (id TEXT PRIMARY KEY NOT NULL);
    `);
    const boundaryMigration = readFileSync(
      new URL("../drizzle/0004_magical_patriot.sql", import.meta.url),
      "utf8",
    );
    for (const statement of boundaryMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    db.database.prepare(`INSERT INTO households (id) VALUES (?)`)
      .run("household-before-nullable-trip");
    db.database.prepare(`INSERT INTO trips (id) VALUES (?)`)
      .run("trip-before-nullable-trip");
    db.database.prepare(`INSERT INTO receipt_ingestions (
      id, household_id, trip_id, client_request_id, source_storage_key,
      source_content_type, source_byte_size, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`)
      .run(
        "ingestion-before-nullable-trip",
        "household-before-nullable-trip",
        "trip-before-nullable-trip",
        "request-before-nullable-trip",
        "source-before-nullable-trip",
        "image/jpeg",
        12,
        "2026-08-15T00:00:00.000Z",
        "2026-08-15T00:00:00.000Z",
      );
    const migration = readFileSync(
      new URL("../drizzle/0009_fantastic_white_tiger.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    const tripColumn = db.database
      .prepare(`PRAGMA table_info(receipt_ingestions)`)
      .all()
      .find((column) => column.name === "trip_id");
    assert.equal(tripColumn.notnull, 0);
    assert.equal(
      db.database.prepare(`SELECT trip_id FROM receipt_ingestions WHERE id = ?`)
        .get("ingestion-before-nullable-trip").trip_id,
      "trip-before-nullable-trip",
    );
    const indexNames = db.database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'receipt_ingestions'`)
      .all()
      .map((row) => row.name)
      .filter((name) => !name.startsWith("sqlite_autoindex"));
    assert.deepEqual(indexNames.sort(), [
      "receipt_ingestions_household_client_request_unique",
      "receipt_ingestions_household_status_idx",
      "receipt_ingestions_receipt_idx",
      "receipt_ingestions_source_storage_key_unique",
      "receipt_ingestions_trip_idx",
    ]);
  } finally {
    db.close();
  }
});

test("product image job migration adds a durable one-job-per-product outbox", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE products (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE receipt_transactions (id TEXT PRIMARY KEY NOT NULL);
    `);
    const migration = readFileSync(
      new URL("../drizzle/0010_fluffy_cannonball.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    const columns = db.database
      .prepare(`PRAGMA table_info(product_image_jobs)`)
      .all()
      .map((column) => column.name);
    for (const expected of [
      "household_id",
      "product_id",
      "receipt_transaction_id",
      "status",
      "attempt_count",
      "locked_at",
      "completed_at",
    ]) {
      assert.ok(columns.includes(expected), `Expected ${expected} in image jobs`);
    }
    const indexes = db.database
      .prepare(`PRAGMA index_list(product_image_jobs)`)
      .all()
      .map((index) => index.name);
    for (const expected of [
      "product_image_jobs_product_unique",
      "product_image_jobs_status_idx",
      "product_image_jobs_household_status_idx",
      "product_image_jobs_receipt_idx",
    ]) {
      assert.ok(indexes.includes(expected), `Expected ${expected}`);
    }
  } finally {
    db.close();
  }
});

test("trip report outbox migration creates an idempotent delivery ledger", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE trips (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE household_members (id TEXT PRIMARY KEY NOT NULL);
    `);
    const migration = readFileSync(
      new URL("../drizzle/0005_cheerful_the_professor.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }
    const indexes = db.database
      .prepare(`PRAGMA index_list(email_outbox)`)
      .all()
      .map((index) => index.name);
    assert.ok(indexes.includes("email_outbox_dedupe_key_unique"));
    const columns = db.database
      .prepare(`PRAGMA table_info(email_outbox)`)
      .all()
      .map((column) => column.name);
    for (const expected of ["attempt_count", "provider_message_id", "locked_at", "sent_at"]) {
      assert.ok(columns.includes(expected), `Expected ${expected} in the email outbox`);
    }
  } finally {
    db.close();
  }
});

test("list revision migration adds an atomic trip and item ledger", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        target_cents INTEGER,
        discovery_allowance_cents INTEGER,
        estimated_list_total_at_freeze_cents INTEGER,
        estimated_priced_item_count_at_freeze INTEGER,
        estimated_unpriced_item_count_at_freeze INTEGER,
        frozen_at TEXT,
        completed_at TEXT
      );
      CREATE TABLE trip_list_items (
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
        added_by_member_id TEXT
      );
    `);
    const migration = readFileSync(
      new URL("../drizzle/0008_sticky_roxanne_simpson.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }

    for (const table of ["trips", "trip_list_items"]) {
      const columns = db.database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
      assert.ok(columns.includes("list_revision"));
    }
    const triggers = db.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE '%list_revision%'
         ORDER BY name`,
      )
      .all()
      .map((trigger) => trigger.name);
    assert.deepEqual(triggers, [
      "trips_list_revision_after_state_update",
    ]);
    const itemTriggers = db.database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'trip_list_items_revision_%'
         ORDER BY name`,
      )
      .all()
      .map((trigger) => trigger.name);
    assert.deepEqual(itemTriggers, [
      "trip_list_items_revision_after_delete",
      "trip_list_items_revision_after_insert",
      "trip_list_items_revision_after_update",
    ]);

    db.database
      .prepare(`INSERT INTO trips (id) VALUES (?)`)
      .run("revision-trip");
    db.database
      .prepare(
        `INSERT INTO trip_list_items (id, trip_id, label)
         VALUES (?, ?, ?)`,
      )
      .run("revision-item", "revision-trip", "Revision test");
    const insertedRevisions = db.database
      .prepare(
        `SELECT trips.list_revision AS tripRevision,
                trip_list_items.list_revision AS itemRevision
         FROM trips
         INNER JOIN trip_list_items ON trip_list_items.trip_id = trips.id
         WHERE trips.id = ?`,
      )
      .get("revision-trip");
    assert.equal(insertedRevisions.tripRevision, 1);
    assert.equal(insertedRevisions.itemRevision, 1);

    db.database
      .prepare(`UPDATE trip_list_items SET checked = 1 WHERE id = ?`)
      .run("revision-item");
    const updatedRevisions = db.database
      .prepare(
        `SELECT trips.list_revision AS tripRevision,
                trip_list_items.list_revision AS itemRevision
         FROM trips
         INNER JOIN trip_list_items ON trip_list_items.trip_id = trips.id
         WHERE trips.id = ?`,
      )
      .get("revision-trip");
    assert.equal(updatedRevisions.tripRevision, 2);
    assert.equal(updatedRevisions.itemRevision, 2);

    db.database
      .prepare(`UPDATE trips SET status = 'frozen' WHERE id = ?`)
      .run("revision-trip");
    assert.equal(
      db.database
        .prepare(`SELECT list_revision AS revision FROM trips WHERE id = ?`)
        .get("revision-trip").revision,
      3,
    );
    db.database
      .prepare(`DELETE FROM trip_list_items WHERE id = ?`)
      .run("revision-item");
    assert.equal(
      db.database
        .prepare(`SELECT list_revision AS revision FROM trips WHERE id = ?`)
        .get("revision-trip").revision,
      4,
    );
  } finally {
    db.close();
  }
});

test("product understanding migration keeps interpretations separate from receipt truth", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE household_members (
        id TEXT PRIMARY KEY NOT NULL,
        household_id TEXT NOT NULL
      );
      CREATE TABLE receipt_items (
        id TEXT PRIMARY KEY NOT NULL,
        raw_description TEXT NOT NULL
      );
    `);
    const migration = readFileSync(
      new URL("../drizzle/0014_dusty_sprite.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }

    const receiptColumns = db.database
      .prepare(`PRAGMA table_info('receipt_items')`)
      .all()
      .map((column) => column.name);
    assert.ok(receiptColumns.includes("interpreted_name"));
    assert.ok(receiptColumns.includes("interpretation_confidence_bps"));
    assert.ok(
      db.database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_understandings'`)
        .get(),
    );
    assert.ok(
      db.database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'intent_fulfillments'`)
        .get(),
    );
  } finally {
    db.close();
  }
});

test("August receipt date migration repairs only the linked 2026 trip", () => {
  const db = new D1DatabaseAdapter();
  try {
    db.database.exec(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY NOT NULL,
        scheduled_for TEXT NOT NULL
      );
      CREATE TABLE receipt_transactions (
        id TEXT PRIMARY KEY NOT NULL,
        trip_id TEXT,
        source_type TEXT NOT NULL,
        purchased_at TEXT NOT NULL,
        total_cents INTEGER NOT NULL
      );
      INSERT INTO trips (id, scheduled_for)
      VALUES ('trip-august-1', '2026-08-01');
      INSERT INTO receipt_transactions (
        id, trip_id, source_type, purchased_at, total_cents
      ) VALUES
        ('repair-me', 'trip-august-1', 'receipt_photo', '2020-08-01T00:00:00.000Z', 17181),
        ('leave-me', NULL, 'receipt_photo', '2020-08-01T00:00:00.000Z', 17181);
    `);
    const migration = readFileSync(
      new URL("../drizzle/0006_fix_august_receipt_date.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.database.exec(statement);
    }

    const rows = db.database
      .prepare(
        `SELECT id, purchased_at AS purchasedAt
         FROM receipt_transactions ORDER BY id`,
      )
      .all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: "leave-me", purchasedAt: "2020-08-01T00:00:00.000Z" },
      { id: "repair-me", purchasedAt: "2026-08-01T00:00:00.000Z" },
    ]);
  } finally {
    db.close();
  }
});

test("receipt cadence produces a conservative, explainable July 25 list", () => {
  const recommendations = buildSaturdayRecommendations(
    RECURRING_PRODUCT_HISTORIES_2026,
    JULY_25_PLAN_DATE,
  );
  const byItemNumber = new Map(
    recommendations.map((recommendation) => [
      recommendation.itemNumber,
      recommendation,
    ]),
  );

  assert.deepEqual(
    recommendations.map((recommendation) => recommendation.itemNumber),
    [
      "1550393",
      "2619",
      "7113",
      "2023727",
      "1344",
      "2534",
      "47825",
      "720650",
      "1068083",
      "38742",
      "2064923",
    ],
  );
  assert.deepEqual(
    recommendations
      .filter((recommendation) => recommendation.included)
      .map((recommendation) => recommendation.itemNumber),
    ["1550393", "2619"],
  );

  const lychee = byItemNumber.get("7113");
  assert.ok(lychee);
  assert.equal(lychee.name, "Lychee");
  assert.equal(lychee.role, "seasonal_favorite");
  assert.equal(lychee.section, "suggested");
  assert.equal(lychee.included, false);
  assert.equal(lychee.evidence.purchaseCount, 10);
  assert.equal(lychee.evidence.totalUnits, 12);
  assert.equal(lychee.evidence.daysSinceLastPurchase, 7);
  assert.equal(lychee.evidence.recentStreak, 4);
  assert.ok(lychee.confidenceBps >= 8_000);
  assert.ok(lychee.confidenceBps <= 9_700);
  assert.match(lychee.reason, /10 purchases \(12 units\)/);
  assert.match(lychee.reason, /last purchased 2026-07-18/);
  assert.match(lychee.reason, /receipts suggest timing, not current household supply/i);

  assert.equal(byItemNumber.get("2534")?.name, "Cherries");
  assert.equal(byItemNumber.get("47825")?.name, "Green grapes");
  for (const itemNumber of ["720650", "1068083", "38742", "2064923"]) {
    const recommendation = byItemNumber.get(itemNumber);
    assert.ok(recommendation);
    assert.equal(recommendation.section, "check_first");
    assert.equal(recommendation.included, false);
    assert.match(recommendation.reason, /^Check supply:/);
  }
  assert.match(byItemNumber.get("1068083").reason, /2026-07-12/);
  assert.match(byItemNumber.get("2064923").reason, /Plain bagels.*2026-07-18/);

  for (const recommendation of recommendations) {
    assert.ok(Number.isInteger(recommendation.confidenceBps));
    assert.ok(recommendation.confidenceBps >= 3_000);
    assert.ok(recommendation.confidenceBps <= 9_700);
    assert.match(recommendation.reason, /median interval \d+ days/);
  }
});

test("list seeding backfills missing candidates without overwriting spouse edits", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("first@example.test"), db),
    );
    assert.equal(initial.listItems.length, 11);

    const lychee = initial.listItems.find((item) => item.label === "Lychee");
    const sweetCorn = initial.listItems.find(
      (item) => item.label === "Sweet corn",
    );
    assert.ok(lychee);
    assert.ok(sweetCorn);

    db.database
      .prepare(
        `UPDATE trip_list_items
         SET label = ?, section = 'consider', included = 1, checked = 1,
             recommendation_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        "Lychee — household edited",
        "Household choice takes precedence",
        "2026-07-24T18:00:00.000Z",
        lychee.id,
      );
    db.database
      .prepare("DELETE FROM trip_list_items WHERE id = ?")
      .run(sweetCorn.id);

    const reconciled = await responseJson(
      await handleHouseholdGet(householdRequest("first@example.test"), db),
    );
    assert.equal(reconciled.listItems.length, 11);
    assert.ok(reconciled.listItems.some((item) => item.id === sweetCorn.id));

    const preserved = reconciled.listItems.find((item) => item.id === lychee.id);
    assert.ok(preserved);
    assert.equal(preserved.label, "Lychee — household edited");
    assert.equal(preserved.section, "consider");
    assert.equal(preserved.included, true);
    assert.equal(preserved.checked, true);
    assert.equal(
      preserved.recommendationReason,
      "Household choice takes precedence",
    );

    await handleHouseholdGet(householdRequest("first@example.test"), db);
    assert.equal(
      db.database
        .prepare(
          "SELECT COUNT(*) AS count FROM trip_list_items WHERE trip_id = ?",
        )
        .get(initial.currentTrip.id).count,
      11,
    );
  } finally {
    db.close();
  }
});

test("list scope returns only the live trip without rerunning household bootstrap", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("poll-owner@example.test"), db),
    );
    const sweetCorn = initial.listItems.find(
      (item) => item.label === "Sweet corn",
    );
    assert.ok(sweetCorn);

    const lastSeenMarker = "2026-07-19T08:00:00.000Z";
    db.database
      .prepare(
        `UPDATE household_members SET last_seen_at = ? WHERE user_email = ?`,
      )
      .run(lastSeenMarker, "poll-owner@example.test");
    db.database
      .prepare(`DELETE FROM trip_list_items WHERE id = ?`)
      .run(sweetCorn.id);

    const scopedResponse = await handleHouseholdGet(
      householdRequest(
        "poll-owner@example.test",
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(initial.currentTrip.id)}`,
      ),
      db,
    );
    assert.equal(scopedResponse.status, 200);
    const scoped = await responseJson(scopedResponse);
    assert.deepEqual(Object.keys(scoped).sort(), ["currentTrip", "listItems"]);
    assert.equal(scoped.currentTrip.id, initial.currentTrip.id);
    assert.equal(scoped.listItems.length, 10);
    assert.ok(!scoped.listItems.some((item) => item.id === sweetCorn.id));
    assert.equal(
      db.database
        .prepare(
          `SELECT last_seen_at AS lastSeenAt FROM household_members
           WHERE user_email = ?`,
        )
        .get("poll-owner@example.test").lastSeenAt,
      lastSeenMarker,
    );

    const outsiderResponse = await handleHouseholdGet(
      householdRequest(
        "poll-outsider@example.test",
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(initial.currentTrip.id)}`,
      ),
      db,
    );
    assert.equal(outsiderResponse.status, 403);
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM household_members`).get()
        .count,
      1,
    );
  } finally {
    db.close();
  }
});

test("list revisions suppress unchanged polls and preserve intervening partner changes", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "revision-owner@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const [firstItem, partnerItem] = initial.listItems;
    assert.ok(firstItem);
    assert.ok(partnerItem);
    assert.ok(Number.isSafeInteger(initial.currentTrip.listRevision));

    db.beforeNextStatementMatching(
      /SELECT \* FROM trip_list_items\s+WHERE trip_id = \?/,
      () => {
        throw new Error("Unchanged list polls must not read list item rows");
      },
    );
    const unchanged = await handleHouseholdGet(
      householdRequest(
        email,
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(initial.currentTrip.id)}&revision=${initial.currentTrip.listRevision}`,
      ),
      db,
    );
    assert.equal(unchanged.status, 204);
    assert.equal(await unchanged.text(), "");
    assert.ok(db.beforeNextStatement);
    db.beforeNextStatement = null;

    db.beforeNextStatementMatching(
      /SELECT \* FROM trip_list_items WHERE id = \? LIMIT 1/,
      (database) => {
        database
          .prepare(
            `UPDATE trip_list_items
             SET included = CASE included WHEN 1 THEN 0 ELSE 1 END
             WHERE id = ?`,
          )
          .run(partnerItem.id);
      },
    );
    const mutationResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_included",
        itemId: firstItem.id,
        included: !firstItem.included,
      }),
      db,
    );
    assert.equal(mutationResponse.status, 200);
    const mutation = await responseJson(mutationResponse);
    assert.equal(mutation.item.id, firstItem.id);
    assert.equal(mutation.item.included, !firstItem.included);
    assert.ok(mutation.listRevision > initial.currentTrip.listRevision);

    const databaseRevision = db.database
      .prepare(`SELECT list_revision AS revision FROM trips WHERE id = ?`)
      .get(initial.currentTrip.id).revision;
    assert.ok(databaseRevision > mutation.listRevision);

    const changedResponse = await handleHouseholdGet(
      householdRequest(
        email,
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(initial.currentTrip.id)}&revision=${mutation.listRevision}`,
      ),
      db,
    );
    assert.equal(changedResponse.status, 200);
    const changed = await responseJson(changedResponse);
    assert.equal(changed.currentTrip.listRevision, databaseRevision);
    assert.equal(
      changed.listItems.find((item) => item.id === partnerItem.id).included,
      !partnerItem.included,
    );

    const caughtUp = await handleHouseholdGet(
      householdRequest(
        email,
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(initial.currentTrip.id)}&revision=${databaseRevision}`,
      ),
      db,
    );
    assert.equal(caughtUp.status, 204);
  } finally {
    db.close();
  }
});

test("add, remove, and check mutations return authoritative revisions", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "revision-actions-owner@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;
    const checkedItem = initial.listItems.find((item) => item.included);
    assert.ok(checkedItem);

    const addResponse = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Revision action test item",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(addResponse.status, 201);
    const added = await responseJson(addResponse);
    assert.equal(added.item.included, true);
    assert.ok(added.listRevision > initial.currentTrip.listRevision);

    const removeResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_included",
        itemId: added.item.id,
        included: false,
      }),
      db,
    );
    assert.equal(removeResponse.status, 200);
    const removed = await responseJson(removeResponse);
    assert.equal(removed.item.id, added.item.id);
    assert.equal(removed.item.included, false);
    assert.ok(removed.listRevision > added.listRevision);

    const freezeResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freezeResponse.status, 200);
    const frozen = await responseJson(freezeResponse);

    const checkResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: checkedItem.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkResponse.status, 200);
    const checked = await responseJson(checkResponse);
    assert.equal(checked.item.id, checkedItem.id);
    assert.equal(checked.item.checked, true);
    assert.ok(checked.listRevision > frozen.trip.listRevision);

    const caughtUp = await handleHouseholdGet(
      householdRequest(
        email,
        "GET",
        undefined,
        `?scope=list&tripId=${encodeURIComponent(tripId)}&revision=${checked.listRevision}`,
      ),
      db,
    );
    assert.equal(caughtUp.status, 204);
  } finally {
    db.close();
  }
});

test("trigger-inclusive D1 change counts still acknowledge successful writes", async () => {
  const db = new D1DatabaseAdapter(null, (sql, changes) => {
    if (
      changes > 0 &&
      /\b(?:INSERT INTO|UPDATE)\s+[`\"]?(?:trip_list_items|trips)[`\"]?/i.test(
        sql,
      )
    ) {
      return changes + 2;
    }
    return changes;
  });
  try {
    const email = "trigger-count-owner@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;
    const checkedItem = initial.listItems.find((item) => item.included);
    assert.ok(checkedItem);

    const addBody = {
      action: "add_list_item",
      tripId,
      label: "Trigger count test item",
      source: "manual",
      section: "essentials",
      included: true,
    };
    const addedResponse = await handleHouseholdPost(
      householdRequest(email, "POST", addBody),
      db,
    );
    assert.equal(addedResponse.status, 201);
    const added = await responseJson(addedResponse);

    const reusedResponse = await handleHouseholdPost(
      householdRequest(email, "POST", addBody),
      db,
    );
    assert.equal(reusedResponse.status, 200);

    const removedResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_included",
        itemId: added.item.id,
        included: false,
      }),
      db,
    );
    assert.equal(removedResponse.status, 200);

    const frozenResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(frozenResponse.status, 200);

    const checkedResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: checkedItem.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkedResponse.status, 200);

    const unfrozenResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "unfreeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(unfrozenResponse.status, 200);
    const unfrozen = await responseJson(unfrozenResponse);
    assert.equal(unfrozen.trip.status, "planning");
    assert.equal(unfrozen.listItems.some((item) => item.checked), false);
  } finally {
    db.close();
  }
});

test("freeze rolls back flags, header, and intent children as one D1 batch", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("atomic-freeze@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    db.failNextBatchMatching(/INSERT INTO trip_intent_items/);

    const originalConsoleError = console.error;
    let failedFreeze;
    try {
      console.error = () => undefined;
      failedFreeze = await handleHouseholdPatch(
        householdRequest("atomic-freeze@example.test", "PATCH", {
          action: "freeze_trip",
          tripId,
        }),
        db,
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(failedFreeze.status, 500);
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "planning",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND included_at_freeze IS NOT NULL`,
        )
        .get(tripId).count,
      0,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      0,
    );
    assert.equal(
      db.database
        .prepare(`SELECT COUNT(*) AS count FROM trip_intent_items WHERE trip_id = ?`)
        .get(tripId).count,
      0,
    );

    const successfulFreeze = await handleHouseholdPatch(
      householdRequest("atomic-freeze@example.test", "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(successfulFreeze.status, 200);
    const frozen = await responseJson(successfulFreeze);
    assert.equal(frozen.trip.status, "frozen");
    const snapshot = db.database
      .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ?`)
      .get(tripId);
    assert.ok(snapshot);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND included_at_freeze IS NOT NULL`,
        )
        .get(tripId).count,
      initial.listItems.length,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items WHERE snapshot_id = ?`,
        )
        .get(snapshot.id).count,
      initial.listItems.length,
    );
  } finally {
    db.close();
  }
});

test("a productless manual estimate updates the trip total, freezes, and then locks", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "manual-estimate@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;

    const zeroEstimate = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Zero estimate",
        source: "manual",
        section: "essentials",
        included: true,
        estimatedPriceCents: 0,
      }),
      db,
    );
    assert.equal(zeroEstimate.status, 400);

    const addRice = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Rice",
        productId: null,
        source: "manual",
        section: "essentials",
        included: true,
        estimatedPriceCents: 2400,
      }),
      db,
    );
    assert.equal(addRice.status, 201);
    const rice = (await responseJson(addRice)).item;
    assert.equal(rice.productId, null);
    assert.equal(rice.estimatedPriceCents, 2400);

    const beforeFreeze = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          email,
          "GET",
          undefined,
          `?scope=list&tripId=${encodeURIComponent(tripId)}`,
        ),
        db,
      ),
    );
    const expectedTotalCents = beforeFreeze.listItems
      .filter(
        (item) => item.included && item.estimatedPriceCents !== null,
      )
      .reduce(
        (sum, item) =>
          sum +
          Math.round(
            (item.estimatedPriceCents * item.quantityMilli) / 1000,
          ),
        0,
      );

    const freeze = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freeze.status, 200);
    assert.equal(
      (await responseJson(freeze)).trip.estimatedListTotalAtFreezeCents,
      expectedTotalCents,
    );
    const frozenRice = db.database
      .prepare(
        `SELECT product_id, estimated_price_cents
         FROM trip_intent_items
         WHERE trip_id = ? AND lower(trim(label)) = 'rice'
         LIMIT 1`,
      )
      .get(tripId);
    assert.equal(frozenRice.product_id, null);
    assert.equal(frozenRice.estimated_price_cents, 2400);

    const rewrite = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Rice",
        productId: null,
        source: "manual",
        section: "essentials",
        included: true,
        estimatedPriceCents: 2700,
      }),
      db,
    );
    assert.equal(rewrite.status, 409);
    assert.match((await responseJson(rewrite)).error, /cannot change/i);
    assert.equal(
      db.database
        .prepare(
          `SELECT estimated_price_cents
           FROM trip_list_items WHERE id = ?`,
        )
        .get(rice.id).estimated_price_cents,
      2400,
    );

    const addAttaDuringTrip = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Atta",
        productId: null,
        source: "in_store",
        section: "essentials",
        included: true,
        estimatedPriceCents: 1800,
      }),
      db,
    );
    assert.equal(addAttaDuringTrip.status, 201);
    const atta = (await responseJson(addAttaDuringTrip)).item;
    assert.equal(atta.includedAtFreeze, false);
    assert.equal(atta.addedAfterFreeze, true);
    assert.equal(atta.estimatedPriceCents, 1800);
    const finalListEstimate = await readFinalTripListEstimate(db, tripId);
    assert.equal(
      finalListEstimate.estimated_total_cents,
      expectedTotalCents + 1800,
      "The checkout baseline includes priced items added while shopping",
    );
    assert.equal(
      db.database
        .prepare(`SELECT estimated_total_cents FROM trip_intent_snapshots WHERE trip_id = ?`)
        .get(tripId).estimated_total_cents,
      expectedTotalCents,
      "The pre-shopping intent estimate remains immutable",
    );

    const catalogProductId = "catalog-product-without-price";
    db.database
      .prepare(
        `INSERT INTO products (
          id, household_id, costco_item_number, canonical_name,
          category, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        catalogProductId,
        initial.household.id,
        "NEW-NO-PRICE",
        "New catalog item",
        "groceries_other",
        "2026-08-15T12:00:00.000Z",
        "2026-08-15T12:00:00.000Z",
      );
    const addUnpricedCatalogItem = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "New catalog item",
        productId: catalogProductId,
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(addUnpricedCatalogItem.status, 201);
    const unpricedCatalogItem = (await responseJson(addUnpricedCatalogItem)).item;
    assert.equal(unpricedCatalogItem.addedAfterFreeze, true);
    assert.equal(unpricedCatalogItem.estimatedPriceCents, null);

    const priceCatalogItemDuringShopping = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "New catalog item",
        productId: catalogProductId,
        source: "in_store",
        section: "essentials",
        included: true,
        estimatedPriceCents: 2599,
      }),
      db,
    );
    assert.equal(priceCatalogItemDuringShopping.status, 200);
    const pricedCatalogItem = (await responseJson(priceCatalogItemDuringShopping)).item;
    assert.equal(pricedCatalogItem.estimatedPriceCents, 2599);
    assert.equal(
      (await readFinalTripListEstimate(db, tripId)).estimated_total_cents,
      expectedTotalCents + 1800 + 2599,
      "An estimate added to a catalog item during shopping changes only the final baseline",
    );
    assert.equal(
      db.database
        .prepare(`SELECT estimated_total_cents FROM trip_intent_snapshots WHERE trip_id = ?`)
        .get(tripId).estimated_total_cents,
      expectedTotalCents,
    );
  } finally {
    db.close();
  }
});

test("shopping can return to planning atomically before receipt evidence", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "undo-shopping@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;
    const bananas = initial.listItems.find(
      (item) => item.label === "Organic bananas",
    );
    assert.ok(bananas);

    const freezeResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freezeResponse.status, 200);

    const checkBananas = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: bananas.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkBananas.status, 200);

    const addedResponse = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Sample aisle discovery",
        source: "manual",
        section: "consider",
        included: true,
      }),
      db,
    );
    assert.equal(addedResponse.status, 201);
    const added = await responseJson(addedResponse);
    assert.equal(added.item.addedAfterFreeze, true);
    const checkAdded = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: added.item.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkAdded.status, 200);

    const beforeUndo = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          email,
          "GET",
          undefined,
          `?scope=list&tripId=${encodeURIComponent(tripId)}`,
        ),
        db,
      ),
    );
    const liveStateBeforeUndo = new Map(
      beforeUndo.listItems.map((item) => [
        item.id,
        item.included,
      ]),
    );
    const snapshot = db.database
      .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ?`)
      .get(tripId);
    assert.ok(snapshot);

    db.failNextBatchMatching(/SET status = 'planning'/);
    const originalConsoleError = console.error;
    let failedUndo;
    try {
      console.error = () => undefined;
      failedUndo = await handleHouseholdPatch(
        householdRequest(email, "PATCH", {
          action: "unfreeze_trip",
          tripId,
        }),
        db,
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(failedUndo.status, 500);
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "frozen",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      1,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND included_at_freeze IS NULL`,
        )
        .get(tripId).count,
      0,
      "A failed undo must roll back list-flag clearing",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND checked = 1`,
        )
        .get(tripId).count,
      2,
      "A failed undo must roll back shopping-session checkmarks",
    );
    assert.equal(
      db.database
        .prepare(`SELECT source FROM trip_list_items WHERE id = ?`)
        .get(added.item.id).source,
      "in_store",
      "A failed undo must roll back source normalization",
    );

    const undoResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "unfreeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(undoResponse.status, 200);
    const undone = await responseJson(undoResponse);
    assert.equal(undone.trip.status, "planning");
    assert.equal(undone.trip.frozenAt, null);
    assert.equal(undone.trip.estimatedListTotalAtFreezeCents, null);
    assert.equal(undone.trip.estimatedPricedItemCountAtFreeze, null);
    assert.equal(undone.trip.estimatedUnpricedItemCountAtFreeze, null);
    assert.equal(undone.listItems.length, beforeUndo.listItems.length);
    for (const item of undone.listItems) {
      assert.equal(
        item.included,
        liveStateBeforeUndo.get(item.id),
        `${item.label} should preserve its live-list membership`,
      );
      assert.equal(item.checked, false);
      assert.equal(item.includedAtFreeze, null);
      assert.equal(item.addedAfterFreeze, false);
    }
    assert.equal(
      undone.listItems.find((item) => item.id === added.item.id)?.source,
      "manual",
      "An item kept for planning should no longer be marked as an in-store addition",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      0,
    );

    const staleCheck = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: bananas.id,
        checked: true,
      }),
      db,
    );
    assert.equal(staleCheck.status, 409);
    assert.match((await responseJson(staleCheck)).error, /while shopping/i);
    assert.equal(
      db.database
        .prepare(`SELECT checked FROM trip_list_items WHERE id = ?`)
        .get(bananas.id).checked,
      0,
      "A stale phone cannot restore a shopping checkmark after undo",
    );
    assert.equal(
      db.database
        .prepare(`SELECT COUNT(*) AS count FROM trip_intent_items WHERE trip_id = ?`)
        .get(tripId).count,
      0,
    );

    const repeatUndo = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "unfreeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(repeatUndo.status, 200);
    const repeated = await responseJson(repeatUndo);
    assert.equal(repeated.trip.status, "planning");
    assert.ok(repeated.listItems.every((item) => item.checked === false));

    db.database
      .prepare(
        `INSERT INTO trips (
          id, household_id, scheduled_for, status, created_at, updated_at
        )
        SELECT ?, household_id, ?, 'frozen', ?, ?
        FROM trips WHERE id = ?`,
      )
      .run(
        "not-current-shopping-trip",
        "2030-01-05",
        "2026-07-26T08:00:00.000Z",
        "2026-07-26T08:00:00.000Z",
        tripId,
      );
    const nonCurrentUndo = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "unfreeze_trip",
        tripId: "not-current-shopping-trip",
      }),
      db,
    );
    assert.equal(nonCurrentUndo.status, 409);
    assert.match((await responseJson(nonCurrentUndo)).error, /current shopping trip/i);
    assert.equal(
      db.database
        .prepare(`SELECT status FROM trips WHERE id = ?`)
        .get("not-current-shopping-trip").status,
      "frozen",
    );

    const refreeze = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(refreeze.status, 200);
    assert.ok(
      (await responseJson(refreeze)).listItems.every(
        (item) => item.checked === false,
      ),
      "A restarted shopping trip must begin with every item unchecked",
    );
    const replacementSnapshot = db.database
      .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ?`)
      .get(tripId);
    assert.ok(replacementSnapshot);
    assert.notEqual(replacementSnapshot.id, snapshot.id);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items WHERE snapshot_id = ?`,
        )
        .get(replacementSnapshot.id).count,
      undone.listItems.length,
    );
  } finally {
    db.close();
  }
});

test("stale list writes derive trip state at the write boundary", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "stale-list-write@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;
    const bananas = initial.listItems.find(
      (item) => item.label === "Organic bananas",
    );
    const lychee = initial.listItems.find((item) => item.label === "Lychee");
    assert.ok(bananas);
    assert.ok(lychee);
    assert.equal(lychee.included, false);

    const freeze = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freeze.status, 200);

    db.beforeNextStatementMatching(
      /UPDATE trip_list_items\s+SET checked/,
      (database) => {
        database
          .prepare(`UPDATE trips SET status = 'planning' WHERE id = ?`)
          .run(tripId);
      },
    );
    const racedCheck = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: bananas.id,
        checked: true,
      }),
      db,
    );
    assert.equal(racedCheck.status, 409);
    assert.equal(
      db.database
        .prepare(`SELECT checked FROM trip_list_items WHERE id = ?`)
        .get(bananas.id).checked,
      0,
    );

    db.database
      .prepare(`UPDATE trips SET status = 'frozen' WHERE id = ?`)
      .run(tripId);
    db.beforeNextStatementMatching(
      /UPDATE trip_list_items\s+SET included/,
      (database) => {
        database
          .prepare(`UPDATE trips SET status = 'planning' WHERE id = ?`)
          .run(tripId);
      },
    );
    const racedInclude = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_included",
        itemId: lychee.id,
        included: true,
      }),
      db,
    );
    assert.equal(racedInclude.status, 200);
    const included = await responseJson(racedInclude);
    assert.equal(included.item.included, true);
    assert.equal(included.item.addedAfterFreeze, false);

    db.database
      .prepare(`UPDATE trips SET status = 'frozen' WHERE id = ?`)
      .run(tripId);
    db.beforeNextStatementMatching(
      /INSERT INTO trip_list_items/,
      (database) => {
        database
          .prepare(`UPDATE trips SET status = 'planning' WHERE id = ?`)
          .run(tripId);
      },
    );
    const racedAdd = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "Write-boundary discovery",
        source: "manual",
        included: true,
      }),
      db,
    );
    assert.equal(racedAdd.status, 201);
    const added = await responseJson(racedAdd);
    assert.equal(added.item.source, "manual");
    assert.equal(added.item.includedAtFreeze, null);
    assert.equal(added.item.addedAfterFreeze, false);

    db.database
      .prepare(`UPDATE trips SET status = 'frozen' WHERE id = ?`)
      .run(tripId);
    const checkedBeforeCompletion = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: bananas.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkedBeforeCompletion.status, 200);
    db.beforeNextStatementMatching(
      /UPDATE trip_list_items\s+SET checked/,
      (database) => {
        database
          .prepare(`UPDATE trips SET status = 'completed' WHERE id = ?`)
          .run(tripId);
      },
    );
    const racedUncheck = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "set_item_checked",
        itemId: bananas.id,
        checked: false,
      }),
      db,
    );
    assert.equal(racedUncheck.status, 409);
    assert.equal(
      db.database
        .prepare(`SELECT checked FROM trip_list_items WHERE id = ?`)
        .get(bananas.id).checked,
      1,
      "Trip completion must win over a stale uncheck",
    );
  } finally {
    db.close();
  }
});

test("two spouses share audited history, one frozen list, and receipt feedback", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const firstResponse = await handleHouseholdGet(
      householdRequest("first@example.test"),
      db,
    );
    assert.equal(firstResponse.status, 200);
    const first = await responseJson(firstResponse);

    assert.equal(first.receiptTransactions.length, 38);
    assert.equal(first.listItems.length, 11);
    assert.match(first.currentTrip.scheduledFor, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(first.currentTrip.status, "planning");
    assert.equal(first.currentTrip.estimatedListTotalAtFreezeCents, null);
    assert.equal(first.currentTrip.estimatedPricedItemCountAtFreeze, null);
    assert.equal(first.currentTrip.estimatedUnpricedItemCountAtFreeze, null);
    assert.equal(
      first.receiptTransactions.reduce(
        (sum, receipt) => sum + receipt.householdFundedCents,
        0,
      ),
      616_322,
    );
    assert.equal(
      first.receiptTransactions.reduce(
        (sum, receipt) => sum + receipt.totalCents,
        0,
      ),
      691_115,
    );
    assert.equal(
      db.database.prepare("SELECT COUNT(*) AS count FROM receipt_items").get()
        .count,
      482,
    );

    const secondResponse = await handleHouseholdGet(
      householdRequest("second@example.test"),
      db,
    );
    assert.equal(secondResponse.status, 200);
    const second = await responseJson(secondResponse);
    assert.equal(second.members.length, 2);
    assert.deepEqual(
      second.listItems.map((item) => item.id),
      first.listItems.map((item) => item.id),
    );

    const addResponse = await handleHouseholdPost(
      householdRequest("first@example.test", "POST", {
        action: "add_list_item",
        tripId: first.currentTrip.id,
        label: "Diapers",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(addResponse.status, 201);

    const quantityResponse = await handleHouseholdPost(
      householdRequest("first@example.test", "POST", {
        action: "add_list_item",
        tripId: first.currentTrip.id,
        label: "Sparkling water",
        source: "manual",
        section: "essentials",
        included: true,
        estimatedPriceCents: 999,
        quantityMilli: 2000,
      }),
      db,
    );
    assert.equal(quantityResponse.status, 201);
    const quantityItem = await responseJson(quantityResponse);
    assert.equal(quantityItem.item.quantityMilli, 2000);
    assert.equal(quantityItem.item.estimatedPriceCents, 999);

    const sharedAfterAdd = await responseJson(
      await handleHouseholdGet(householdRequest("second@example.test"), db),
    );
    assert.ok(sharedAfterAdd.listItems.some((item) => item.label === "Diapers"));
    const includedBeforeFreeze = sharedAfterAdd.listItems.filter(
      (item) => item.included,
    );
    const expectedEstimateCents = includedBeforeFreeze.reduce(
      (sum, item) =>
        sum +
        (item.estimatedPriceCents === null
          ? 0
          : Math.round(
              (item.estimatedPriceCents * item.quantityMilli) / 1000,
            )),
      0,
    );
    const expectedPricedCount = includedBeforeFreeze.filter(
      (item) => item.estimatedPriceCents !== null,
    ).length;
    const expectedUnpricedCount =
      includedBeforeFreeze.length - expectedPricedCount;

    const freezeResponse = await handleHouseholdPatch(
      householdRequest("second@example.test", "PATCH", {
        action: "freeze_trip",
        tripId: first.currentTrip.id,
      }),
      db,
    );
    assert.equal(freezeResponse.status, 200);
    const frozen = await responseJson(freezeResponse);
    assert.equal(frozen.trip.status, "frozen");
    assert.equal(
      frozen.trip.estimatedListTotalAtFreezeCents,
      expectedEstimateCents,
    );
    assert.equal(
      frozen.trip.estimatedPricedItemCountAtFreeze,
      expectedPricedCount,
    );
    assert.equal(
      frozen.trip.estimatedUnpricedItemCountAtFreeze,
      expectedUnpricedCount,
    );

    const milk = frozen.listItems.find(
      (item) => item.label === "Kirkland Signature organic 2% milk",
    );
    const lychee = frozen.listItems.find((item) => item.label === "Lychee");
    assert.ok(milk);
    assert.ok(lychee);
    assert.equal(milk.includedAtFreeze, true);
    assert.equal(lychee.includedAtFreeze, false);
    assert.equal(lychee.addedAfterFreeze, false);

    const addLycheeDuringTripResponse = await handleHouseholdPatch(
      householdRequest("second@example.test", "PATCH", {
        action: "set_item_included",
        itemId: lychee.id,
        included: true,
      }),
      db,
    );
    assert.equal(addLycheeDuringTripResponse.status, 200);
    const addedLycheeDuringTrip = await responseJson(
      addLycheeDuringTripResponse,
    );
    assert.equal(addedLycheeDuringTrip.item.included, true);
    assert.equal(addedLycheeDuringTrip.item.includedAtFreeze, false);
    assert.equal(addedLycheeDuringTrip.item.addedAfterFreeze, true);

    const removeLycheeDuringTripResponse = await handleHouseholdPatch(
      householdRequest("second@example.test", "PATCH", {
        action: "set_item_included",
        itemId: lychee.id,
        included: false,
      }),
      db,
    );
    assert.equal(removeLycheeDuringTripResponse.status, 200);
    const removedLycheeDuringTrip = await responseJson(
      removeLycheeDuringTripResponse,
    );
    assert.equal(removedLycheeDuringTrip.item.included, false);
    assert.equal(removedLycheeDuringTrip.item.addedAfterFreeze, true);

    const checkedMilkResponse = await handleHouseholdPatch(
      householdRequest("first@example.test", "PATCH", {
        action: "set_item_checked",
        itemId: milk.id,
        checked: true,
      }),
      db,
    );
    assert.equal(checkedMilkResponse.status, 200);
    assert.equal((await responseJson(checkedMilkResponse)).item.checked, true);

    const removeMilkResponse = await handleHouseholdPatch(
      householdRequest("first@example.test", "PATCH", {
        action: "set_item_included",
        itemId: milk.id,
        included: false,
      }),
      db,
    );
    const removedMilk = await responseJson(removeMilkResponse);
    assert.equal(removedMilk.item.included, false);
    assert.equal(removedMilk.item.checked, false);
    assert.equal(removedMilk.item.includedAtFreeze, true);

    const excludedCheckResponse = await handleHouseholdPatch(
      householdRequest("second@example.test", "PATCH", {
        action: "set_item_checked",
        itemId: milk.id,
        checked: true,
      }),
      db,
    );
    assert.equal(excludedCheckResponse.status, 409);

    const reactivateMilkResponse = await handleHouseholdPatch(
      householdRequest("first@example.test", "PATCH", {
        action: "set_item_included",
        itemId: milk.id,
        included: true,
      }),
      db,
    );
    assert.equal(reactivateMilkResponse.status, 200);
    const reactivatedMilk = await responseJson(reactivateMilkResponse);
    assert.equal(reactivatedMilk.item.included, true);
    assert.equal(reactivatedMilk.item.checked, false);

    const inStoreResponse = await handleHouseholdPost(
      householdRequest("first@example.test", "POST", {
        action: "add_list_item",
        tripId: first.currentTrip.id,
        label: "Sample discovery",
        source: "manual",
        section: "consider",
        included: true,
      }),
      db,
    );
    const inStore = await responseJson(inStoreResponse);
    assert.equal(inStore.item.source, "in_store");
    assert.equal(inStore.item.addedAfterFreeze, true);
    assert.equal(inStore.item.includedAtFreeze, false);

    const afterShoppingChanges = await responseJson(
      await handleHouseholdGet(householdRequest("second@example.test"), db),
    );
    assert.equal(
      afterShoppingChanges.currentTrip.estimatedListTotalAtFreezeCents,
      expectedEstimateCents,
    );
    assert.equal(
      afterShoppingChanges.currentTrip.estimatedUnpricedItemCountAtFreeze,
      expectedUnpricedCount,
    );

    const feedbackResponse = await handleHouseholdPost(
      householdRequest("second@example.test", "POST", {
        action: "add_feedback",
        receiptTransactionId: "warehouse-2026-07-18",
        kind: "trip_enjoyment",
        value: "Enjoyable and easy",
        rating: 5,
      }),
      db,
    );
    assert.equal(feedbackResponse.status, 201);

    const sharedAfterFeedback = await responseJson(
      await handleHouseholdGet(householdRequest("first@example.test"), db),
    );
    assert.ok(
      sharedAfterFeedback.feedback.some(
        (feedback) =>
          feedback.receiptTransactionId === "warehouse-2026-07-18" &&
          feedback.value === "Enjoyable and easy",
      ),
    );

    const thirdResponse = await handleHouseholdGet(
      householdRequest("third@example.test"),
      db,
    );
    assert.equal(thirdResponse.status, 403);
  } finally {
    db.close();
  }
});

test("historical catalog prices list items and household review preserves receipt truth", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("catalog-owner@example.test"), db),
    );
    await responseJson(
      await handleHouseholdGet(householdRequest("catalog-spouse@example.test"), db),
    );

    const byItemNumber = new Map(
      initial.products.map((product) => [product.costcoItemNumber, product]),
    );
    const redOnions = byItemNumber.get("9218");
    const strawberries = byItemNumber.get("27003");
    const organicStrawberries = byItemNumber.get("512515");
    const huggies = byItemNumber.get("1935002");
    const lycheeProduct = byItemNumber.get("7113");
    const lycheeSuggestion = initial.listItems.find(
      (item) => item.label === "Lychee",
    );
    assert.ok(redOnions);
    assert.ok(strawberries);
    assert.ok(organicStrawberries);
    assert.ok(huggies);
    assert.ok(lycheeProduct);
    assert.ok(lycheeSuggestion);
    assert.equal(redOnions.latestRegularUnitPriceCents, 549);
    assert.equal(strawberries.latestRegularUnitPriceCents, 649);
    assert.equal(organicStrawberries.latestRegularUnitPriceCents, 1099);
    assert.equal(huggies.canonicalName, "Huggies Pull-Ups diapers, 4T–5T");
    assert.equal(huggies.latestRawDescription, "HUG PU 4T-5T");
    assert.equal(huggies.latestRegularUnitPriceCents, 3999);
    assert.equal(huggies.latestPaidUnitPriceCents, 3199);
    assert.equal(huggies.latestDiscountUnitCents, 800);

    const lycheeAddResponse = await handleHouseholdPost(
      householdRequest("catalog-owner@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        productId: lycheeProduct.id,
        label: lycheeProduct.canonicalName,
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(lycheeAddResponse.status, 200);
    const lycheeAdd = await responseJson(lycheeAddResponse);
    assert.equal(lycheeAdd.item.id, lycheeSuggestion.id);
    assert.equal(lycheeAdd.item.included, true);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND product_id = ?`,
        )
        .get(initial.currentTrip.id, lycheeProduct.id).count,
      1,
    );

    const redOnionAddResponse = await handleHouseholdPost(
      householdRequest("catalog-owner@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        productId: redOnions.id,
        label: "red onions",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(redOnionAddResponse.status, 201);
    const redOnionAdd = await responseJson(redOnionAddResponse);
    assert.equal(redOnionAdd.item.productId, redOnions.id);
    assert.equal(redOnionAdd.item.label, redOnions.canonicalName);
    assert.equal(redOnionAdd.item.estimatedPriceCents, 549);

    const redOnionRemoveResponse = await handleHouseholdPatch(
      householdRequest("catalog-spouse@example.test", "PATCH", {
        action: "set_item_included",
        itemId: redOnionAdd.item.id,
        included: false,
      }),
      db,
    );
    assert.equal(redOnionRemoveResponse.status, 200);

    const redOnionReuseResponse = await handleHouseholdPost(
      householdRequest("catalog-owner@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        productId: redOnions.id,
        label: "red onions",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(redOnionReuseResponse.status, 200);
    const redOnionReuse = await responseJson(redOnionReuseResponse);
    assert.equal(redOnionReuse.item.id, redOnionAdd.item.id);
    assert.equal(redOnionReuse.item.included, true);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND product_id = ?`,
        )
        .get(initial.currentTrip.id, redOnions.id).count,
      1,
    );

    const strawberryAdd = await responseJson(
      await handleHouseholdPost(
        householdRequest("catalog-owner@example.test", "POST", {
          action: "add_list_item",
          tripId: initial.currentTrip.id,
          label: "strawberries",
          source: "manual",
          section: "essentials",
          included: true,
        }),
        db,
      ),
    );
    assert.equal(strawberryAdd.item.productId, strawberries.id);
    assert.equal(strawberryAdd.item.estimatedPriceCents, 649);

    db.database
      .prepare(`UPDATE trip_list_items SET label = ? WHERE id = ?`)
      .run("Saturday berries", strawberryAdd.item.id);
    const strawberryResolvedReuseResponse = await handleHouseholdPost(
      householdRequest("catalog-spouse@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        label: "strawberries",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(strawberryResolvedReuseResponse.status, 200);
    const strawberryResolvedReuse = await responseJson(
      strawberryResolvedReuseResponse,
    );
    assert.equal(strawberryResolvedReuse.item.id, strawberryAdd.item.id);
    assert.equal(strawberryResolvedReuse.item.productId, strawberries.id);
    assert.equal(strawberryResolvedReuse.item.label, "Saturday berries");
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_list_items
           WHERE trip_id = ? AND product_id = ?`,
        )
        .get(initial.currentTrip.id, strawberries.id).count,
      1,
    );

    const partialAdd = await responseJson(
      await handleHouseholdPost(
        householdRequest("catalog-owner@example.test", "POST", {
          action: "add_list_item",
          tripId: initial.currentTrip.id,
          label: "straw",
          source: "manual",
          section: "essentials",
          included: true,
        }),
        db,
      ),
    );
    assert.equal(partialAdd.item.productId, null);
    assert.equal(partialAdd.item.estimatedPriceCents, null);

    await handleHouseholdPatch(
      householdRequest("catalog-owner@example.test", "PATCH", {
        action: "set_item_included",
        itemId: partialAdd.item.id,
        included: false,
      }),
      db,
    );
    const partialReuseResponse = await handleHouseholdPost(
      householdRequest("catalog-spouse@example.test", "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        label: "STRAW",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(partialReuseResponse.status, 200);
    const partialReuse = await responseJson(partialReuseResponse);
    assert.equal(partialReuse.item.id, partialAdd.item.id);
    assert.equal(partialReuse.item.productId, null);
    assert.equal(partialReuse.item.included, true);

    const ambiguous = byItemNumber.get("1901772");
    assert.ok(ambiguous);
    assert.equal(ambiguous.categoryStatus, "needs_review");
    const rawBefore = db.database
      .prepare(
        `SELECT raw_description FROM receipt_items
         WHERE product_id = ? ORDER BY id LIMIT 1`,
      )
      .get(ambiguous.id).raw_description;

    const reviewResponse = await handleHouseholdPatch(
      householdRequest("catalog-spouse@example.test", "PATCH", {
        action: "confirm_product_metadata",
        productId: ambiguous.id,
        canonicalName: "Household-confirmed two-pack combo",
        category: "household_supplies",
        expectedUpdatedAt: ambiguous.updatedAt,
      }),
      db,
    );
    assert.equal(reviewResponse.status, 200);

    const refreshed = await responseJson(
      await handleHouseholdGet(householdRequest("catalog-owner@example.test"), db),
    );
    const reviewed = refreshed.products.find(
      (product) => product.id === ambiguous.id,
    );
    assert.ok(reviewed);
    assert.equal(reviewed.canonicalName, "Household-confirmed two-pack combo");
    assert.equal(reviewed.category, "household_supplies");
    assert.equal(reviewed.categoryStatus, "reviewed");
    assert.equal(reviewed.categoryReviewedByDisplayName, "catalog-spouse");
    assert.equal(
      db.database
        .prepare(
          `SELECT raw_description FROM receipt_items
           WHERE product_id = ? ORDER BY id LIMIT 1`,
        )
        .get(ambiguous.id).raw_description,
      rawBefore,
      "Household metadata must not rewrite immutable receipt text",
    );

    const staleReview = await handleHouseholdPatch(
      householdRequest("catalog-owner@example.test", "PATCH", {
        action: "confirm_product_metadata",
        productId: ambiguous.id,
        canonicalName: "Stale overwrite",
        category: "clothing_accessories",
        expectedUpdatedAt: ambiguous.updatedAt,
      }),
      db,
    );
    assert.equal(staleReview.status, 409);
  } finally {
    db.close();
  }
});

function receiptDraftLine({
  sourceLineNumber,
  costcoItemNumber,
  rawDescription,
  quantityMilli = 1000,
  unitPriceCents,
  lineSubtotalCents,
  taxStatus = "non_taxable",
}) {
  return {
    sourceLineNumber,
    costcoItemNumber,
    rawDescription,
    quantityMilli,
    unitPriceCents,
    lineSubtotalCents,
    discountCents: 0,
    netAmountCents: lineSubtotalCents,
    taxStatus,
  };
}

function productForListItem(state, listItem) {
  assert.ok(listItem?.productId, `Expected ${listItem?.label ?? "list item"} to have a product`);
  const product = state.products.find((entry) => entry.id === listItem.productId);
  assert.ok(product?.costcoItemNumber, `Expected ${listItem.label} to have a Costco item number`);
  return product;
}

test("receipt ingestion repairs an OCR year error from the linked trip date", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("receipt-date@example.test"), db),
    );
    const scheduledFor = initial.currentTrip.scheduledFor;
    const wrongYear = `${Number(scheduledFor.slice(0, 4)) - 6}${scheduledFor.slice(4)}`;

    const response = await handleHouseholdPost(
      householdRequest("receipt-date@example.test", "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "receipt-date-year-repair",
        tripId: initial.currentTrip.id,
        purchasedAt: wrongYear,
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
        discountCents: 0,
        captureMode: "totals_only",
        items: [],
      }),
      db,
    );

    assert.equal(response.status, 200);
    const ingested = await responseJson(response);
    assert.equal(ingested.receipt.purchasedAt.slice(0, 10), scheduledFor);
  } finally {
    db.close();
  }
});

test("receipt ingestion rejects a date far from the linked trip", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("receipt-date-guard@example.test"), db),
    );
    const response = await handleHouseholdPost(
      householdRequest("receipt-date-guard@example.test", "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "receipt-date-too-far",
        tripId: initial.currentTrip.id,
        purchasedAt: "2025-01-02",
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
        discountCents: 0,
        captureMode: "totals_only",
        items: [],
      }),
      db,
    );

    assert.equal(response.status, 400);
    const body = await responseJson(response);
    assert.match(body.error, /within 14 days of the trip date/i);
  } finally {
    db.close();
  }
});

test("standalone receipt lifecycle is isolated until explicit finalization", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "ad-hoc-receipt-owner@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const product = initial.products.find(
      (entry) => entry.costcoItemNumber === "1868328",
    );
    assert.ok(product, "Expected a seeded product for standalone purchase history");
    const beforeDashboard = initial.dashboard;
    const sideEffectCounts = () => ({
      trips: db.database.prepare(`SELECT COUNT(*) AS count FROM trips`).get().count,
      listItems: db.database.prepare(`SELECT COUNT(*) AS count FROM trip_list_items`).get().count,
      intents: db.database.prepare(`SELECT COUNT(*) AS count FROM trip_intent_items`).get().count,
      matches: db.database.prepare(`SELECT COUNT(*) AS count FROM trip_item_matches`).get().count,
      questions: db.database.prepare(`SELECT COUNT(*) AS count FROM review_questions`).get().count,
      feedback: db.database.prepare(`SELECT COUNT(*) AS count FROM feedback`).get().count,
      outbox: db.database.prepare(`SELECT COUNT(*) AS count FROM email_outbox`).get().count,
      recommendations: db.database
        .prepare(`SELECT COUNT(*) AS count FROM trip_list_items WHERE source IN ('recurring', 'predicted', 'consider')`)
        .get().count,
    });
    const beforeEffects = sideEffectCounts();
    const draftRequest = {
      action: "create_ad_hoc_receipt",
      clientReceiptId: "ad-hoc-tires-001",
      purchasedAt: "2026-08-14T11:00:00-07:00",
      subtotalCents: 3500,
      taxCents: 0,
      totalCents: 3500,
      discountCents: 0,
      items: [
        receiptDraftLine({
          sourceLineNumber: 1,
          costcoItemNumber: product.costcoItemNumber,
          rawDescription: "AD HOC COSTCO PURCHASE",
          unitPriceCents: 1500,
          lineSubtotalCents: 1500,
        }),
        receiptDraftLine({
          sourceLineNumber: 2,
          costcoItemNumber: "99999990",
          rawDescription: "NEW AD HOC TIRES",
          unitPriceCents: 2000,
          lineSubtotalCents: 2000,
        }),
      ],
    };
    const createdResponse = await handleHouseholdPost(
      householdRequest(email, "POST", draftRequest),
      db,
    );
    assert.equal(createdResponse.status, 200);
    const created = await responseJson(createdResponse);
    assert.equal(created.mode, "ad_hoc");
    assert.equal(created.receipt.tripId, null);
    assert.equal(created.receipt.parseStatus, "needs_review");
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM products WHERE costco_item_number = ?`)
        .get("99999990").count,
      0,
      "Standalone drafts must not pollute the household catalog",
    );
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM product_image_jobs`).get().count,
      0,
      "Image work starts only after explicit finalization",
    );
    assert.deepEqual(
      (await responseJson(await handleHouseholdGet(householdRequest(email), db))).dashboard,
      beforeDashboard,
      "A standalone draft must not change official spend before finalization",
    );
    assert.deepEqual(sideEffectCounts(), beforeEffects);

    const read = await responseJson(
      await handleHouseholdGet(
        householdRequest(
          email,
          "GET",
          undefined,
          `?view=ad-hoc-receipt&receiptId=${encodeURIComponent(created.receiptId)}`,
        ),
        db,
      ),
    );
    assert.equal(read.receipt.id, created.receiptId);
    assert.equal(read.items.length, 2);

    const retry = await responseJson(
      await handleHouseholdPost(householdRequest(email, "POST", draftRequest), db),
    );
    assert.equal(retry.receiptId, created.receiptId, "Create retry must be idempotent");
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM receipt_transactions WHERE source_transaction_key = ?`)
        .get("ad-hoc-receipt:ad-hoc-tires-001").count,
      1,
    );

    assert.equal(
      (await handleHouseholdGet(
        householdRequest("ad-hoc-receipt-second@example.test"),
        db,
      )).status,
      200,
    );
    const unauthorized = await handleHouseholdGet(
      householdRequest(
        "ad-hoc-receipt-third@example.test",
        "GET",
        undefined,
        `?view=ad-hoc-receipt&receiptId=${encodeURIComponent(created.receiptId)}`,
      ),
      db,
    );
    assert.equal(unauthorized.status, 403);

    db.database.prepare(
      `INSERT INTO product_images (
        id, household_id, product_id, source_type, storage_key,
        status, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, 'household_upload', ?, 'approved', 1, ?, ?)`,
    ).run(
      "existing-household-photo",
      initial.household.id,
      product.id,
      `households/${initial.household.id}/product-images/${product.id}/existing.jpg`,
      "2026-08-15T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
    );

    const finalizedResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_ad_hoc_receipt",
        receiptId: created.receiptId,
      }),
      db,
    );
    assert.equal(finalizedResponse.status, 200);
    const finalized = await responseJson(finalizedResponse);
    assert.equal(finalized.receipt.parseStatus, "reconciled");
    const promotedProduct = db.database
      .prepare(`SELECT * FROM products WHERE costco_item_number = ?`)
      .get("99999990");
    assert.ok(promotedProduct, "A new finalized receipt product must enter the catalog");
    assert.equal(promotedProduct.category, "automotive_tires");
    assert.equal(promotedProduct.category_status, "rule_based");
    assert.equal(
      db.database.prepare(
        `SELECT product_id FROM receipt_items
         WHERE receipt_transaction_id = ? AND costco_item_number = ?`,
      ).get(created.receiptId, "99999990").product_id,
      promotedProduct.id,
    );
    assert.equal(
      db.database.prepare(
        `SELECT confirmation_source FROM product_aliases
         WHERE household_id = ? AND product_id = ?`,
      ).get(initial.household.id, promotedProduct.id).confirmation_source,
      "receipt",
    );
    assert.deepEqual(
      { ...db.database.prepare(
        `SELECT status, attempt_count, receipt_transaction_id
         FROM product_image_jobs WHERE product_id = ?`,
      ).get(promotedProduct.id) },
      {
        status: "queued",
        attempt_count: 0,
        receipt_transaction_id: created.receiptId,
      },
    );
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM product_image_jobs WHERE product_id = ?`)
        .get(product.id).count,
      0,
      "A household photo must suppress background generation",
    );
    const afterFinalization = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    assert.ok(afterFinalization.dashboard.transactions.some(
      (transaction) => transaction.id === created.receiptId,
    ));
    const beforeProduct = beforeDashboard.products.find(
      (entry) => entry.itemNumber === product.costcoItemNumber,
    );
    const afterProduct = afterFinalization.dashboard.products.find(
      (entry) => entry.itemNumber === product.costcoItemNumber,
    );
    assert.equal(afterProduct.purchaseCount, beforeProduct.purchaseCount + 1);
    assert.deepEqual(sideEffectCounts(), beforeEffects);

    const catalogProductAfterFinalization = afterFinalization.products.find(
      (entry) => entry.id === product.id,
    );
    assert.equal(catalogProductAfterFinalization.image.sourceType, "household_upload");
    const automotiveReview = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "confirm_product_metadata",
        productId: product.id,
        canonicalName: catalogProductAfterFinalization.canonicalName,
        category: "automotive_tires",
        expectedUpdatedAt: catalogProductAfterFinalization.updatedAt,
      }),
      db,
    );
    assert.equal(
      automotiveReview.status,
      200,
      "The new ad hoc purchase categories must be accepted by household review",
    );

    const activeImageLock = "2026-08-15T00:05:00.000Z";
    db.database.prepare(
      `UPDATE product_image_jobs
       SET status = 'processing', attempt_count = 1, locked_at = ?
       WHERE product_id = ?`,
    ).run(activeImageLock, promotedProduct.id);
    const finalizeRetry = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_ad_hoc_receipt",
        receiptId: created.receiptId,
      }),
      db,
    );
    assert.equal(finalizeRetry.status, 200, "Finalization retry must be idempotent");
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM products WHERE costco_item_number = ?`)
        .get("99999990").count,
      1,
    );
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM product_image_jobs WHERE product_id = ?`)
        .get(promotedProduct.id).count,
      1,
    );
    assert.deepEqual(
      { ...db.database.prepare(
        `SELECT status, attempt_count, locked_at
         FROM product_image_jobs WHERE product_id = ?`,
      ).get(promotedProduct.id) },
      {
        status: "processing",
        attempt_count: 1,
        locked_at: activeImageLock,
      },
      "A finalization retry must not steal or strand an active image job",
    );
    const immutableEdit = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "update_ad_hoc_receipt",
        receiptId: created.receiptId,
        totalCents: 1,
      }),
      db,
    );
    assert.equal(immutableEdit.status, 409);

    const beforeReturn = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const beforeReturnProduct = beforeReturn.dashboard.products.find(
      (entry) => entry.itemNumber === product.costcoItemNumber,
    );
    const returnDraftRequest = {
      action: "create_ad_hoc_receipt",
      clientReceiptId: "ad-hoc-return-001",
      transactionType: "return",
      purchasedAt: "2026-08-15T11:00:00-07:00",
      subtotalCents: -1500,
      taxCents: 0,
      totalCents: -1500,
      discountCents: 0,
      items: [
        receiptDraftLine({
          sourceLineNumber: 1,
          costcoItemNumber: product.costcoItemNumber,
          rawDescription: "AD HOC COSTCO RETURN",
          unitPriceCents: -1500,
          lineSubtotalCents: -1500,
        }),
      ],
    };
    const returnDraftResponse = await handleHouseholdPost(
      householdRequest(email, "POST", returnDraftRequest),
      db,
    );
    assert.equal(returnDraftResponse.status, 200);
    const returnDraft = await responseJson(returnDraftResponse);
    assert.equal(returnDraft.receipt.transactionType, "return");
    assert.equal(returnDraft.receipt.parseStatus, "needs_review");
    assert.deepEqual(
      (await responseJson(await handleHouseholdGet(householdRequest(email), db))).dashboard,
      beforeReturn.dashboard,
      "A return draft must not reduce official spend before finalization",
    );

    const finalizedReturnResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_ad_hoc_receipt",
        receiptId: returnDraft.receiptId,
      }),
      db,
    );
    assert.equal(finalizedReturnResponse.status, 200);
    const finalizedReturn = await responseJson(finalizedReturnResponse);
    assert.equal(finalizedReturn.receipt.parseStatus, "reconciled");
    assert.equal(finalizedReturn.items[0].productId, product.id);

    const afterReturn = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    assert.equal(
      afterReturn.dashboard.audit.householdFundedCents,
      beforeReturn.dashboard.audit.householdFundedCents - 1500,
      "A finalized return must reduce net Costco spending",
    );
    const returnTransaction = afterReturn.dashboard.transactions.find(
      (transaction) => transaction.id === returnDraft.receiptId,
    );
    assert.deepEqual(
      {
        channel: returnTransaction.channel,
        householdFundedCents: returnTransaction.householdFundedCents,
        receiptTotalCents: returnTransaction.receiptTotalCents,
        purchaseContext: returnTransaction.purchaseContext,
        transactionKind: returnTransaction.transactionKind,
      },
      {
        channel: "warehouse",
        householdFundedCents: -1500,
        receiptTotalCents: -1500,
        purchaseContext: "ad_hoc",
        transactionKind: "return",
      },
    );
    const afterReturnProduct = afterReturn.dashboard.products.find(
      (entry) => entry.itemNumber === product.costcoItemNumber,
    );
    assert.equal(
      afterReturnProduct.purchaseCount,
      beforeReturnProduct.purchaseCount,
      "A return must not be learned as another purchase",
    );
    assert.equal(
      afterReturnProduct.totalSpendCents,
      beforeReturnProduct.totalSpendCents,
      "Product purchase history remains a purchase-only evidence stream",
    );
    assert.deepEqual(sideEffectCounts(), beforeEffects);

    const finalizedReturnRetry = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_ad_hoc_receipt",
        receiptId: returnDraft.receiptId,
      }),
      db,
    );
    assert.equal(finalizedReturnRetry.status, 200);
    assert.equal(
      (await responseJson(
        await handleHouseholdGet(householdRequest(email), db),
      )).dashboard.audit.householdFundedCents,
      afterReturn.dashboard.audit.householdFundedCents,
      "A finalization retry must not subtract the return twice",
    );

    const totalsOnlyReturn = await responseJson(
      await handleHouseholdPost(
        householdRequest(email, "POST", {
          action: "create_ad_hoc_receipt",
          clientReceiptId: "ad-hoc-return-totals-only",
          transactionType: "return",
          purchasedAt: "2026-08-15T12:00:00-07:00",
          subtotalCents: -500,
          taxCents: 0,
          totalCents: -500,
          discountCents: 0,
          captureMode: "totals_only",
          items: [],
        }),
        db,
      ),
    );
    assert.equal(totalsOnlyReturn.receipt.parseStatus, "needs_review");
    const totalsOnlyFinalized = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_ad_hoc_receipt",
        receiptId: totalsOnlyReturn.receiptId,
      }),
      db,
    );
    assert.equal(totalsOnlyFinalized.status, 200);
    assert.equal(
      (await responseJson(
        await handleHouseholdGet(householdRequest(email), db),
      )).dashboard.audit.householdFundedCents,
      afterReturn.dashboard.audit.householdFundedCents - 500,
      "A totals-only return must still reduce net spend without inventing products",
    );

    const invalidPositiveReturn = await handleHouseholdPost(
      householdRequest(email, "POST", {
        ...returnDraftRequest,
        clientReceiptId: "ad-hoc-return-positive",
        subtotalCents: 1500,
        totalCents: 1500,
        items: [
          receiptDraftLine({
            sourceLineNumber: 1,
            rawDescription: "INVALID POSITIVE RETURN",
            lineSubtotalCents: 1500,
          }),
        ],
      }),
      db,
    );
    assert.equal(invalidPositiveReturn.status, 400);
    assert.match((await responseJson(invalidPositiveReturn)).error, /return amounts|negative return line/i);

    const invalidNegativePurchase = await handleHouseholdPost(
      householdRequest(email, "POST", {
        ...returnDraftRequest,
        clientReceiptId: "ad-hoc-purchase-negative",
        transactionType: "warehouse",
      }),
      db,
    );
    assert.equal(invalidNegativePurchase.status, 400);
    assert.match((await responseJson(invalidNegativePurchase)).error, /purchase amounts cannot be negative/i);
  } finally {
    db.close();
  }
});

test("receipt discounts fold into the product paid price and stay out of additions", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("discounted-recap@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const apparelProduct = initial.products.find(
      (product) => product.costcoItemNumber === "1868328",
    );
    assert.ok(apparelProduct, "Expected audited apparel SKU 1868328");

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest("discounted-recap@example.test", "PATCH", {
            action: "freeze_trip",
            tripId,
          }),
          db,
        )
      ).status,
      200,
    );

    const response = await handleHouseholdPost(
      householdRequest("discounted-recap@example.test", "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "discounted-recap",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip),
        subtotalCents: 6800,
        taxCents: 0,
        totalCents: 6800,
        discountCents: 1200,
        items: [
          receiptDraftLine({
            sourceLineNumber: 1,
            costcoItemNumber: apparelProduct.costcoItemNumber,
            rawDescription: "3 DOT PANT",
            unitPriceCents: 8000,
            lineSubtotalCents: 8000,
          }),
          {
            sourceLineNumber: 2,
            costcoItemNumber: null,
            rawDescription: "INSTANT SAVINGS",
            quantityMilli: 1000,
            unitPriceCents: null,
            lineSubtotalCents: 0,
            discountCents: 1200,
            netAmountCents: -1200,
            kind: "discount",
            taxStatus: "non_taxable",
          },
        ],
      }),
      db,
    );
    assert.equal(response.status, 200);
    const ingested = await responseJson(response);
    assert.equal(ingested.comparison.additionsCents, 6800);
    assert.equal(ingested.closedLoop.comparison.buckets.receiptOnly.length, 1);
    assert.equal(ingested.closedLoop.items.length, 1);
    assert.equal(ingested.closedLoop.items[0].kind, "item");
    assert.equal(ingested.closedLoop.items[0].lineSubtotalCents, 8000);
    assert.equal(ingested.closedLoop.items[0].discountCents, 1200);
    assert.equal(ingested.closedLoop.items[0].netAmountCents, 6800);
    assert.equal(
      ingested.questions.some((question) => /instant savings/i.test(question.prompt)),
      false,
    );

    const finalizedResponse = await handleHouseholdPatch(
      householdRequest("discounted-recap@example.test", "PATCH", {
        action: "finalize_receipt",
        receiptId: ingested.receiptId,
      }),
      db,
    );
    assert.equal(finalizedResponse.status, 200);

    const after = await responseJson(
      await handleHouseholdGet(householdRequest("discounted-recap@example.test"), db),
    );
    const updatedApparel = after.products.find(
      (product) => product.id === apparelProduct.id,
    );
    assert.equal(updatedApparel.latestRegularUnitPriceCents, 8000);
    assert.equal(updatedApparel.latestPaidUnitPriceCents, 6800);
    assert.equal(updatedApparel.latestDiscountUnitCents, 1200);
  } finally {
    db.close();
  }
});

test("a confirmed same-item correction teaches the list product identity for future trips", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("learn-alias@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const apparelProduct = initial.products.find(
      (product) => product.costcoItemNumber === "1868328",
    );
    const plannedMilk = initial.listItems.find(
      (item) => item.label === "Kirkland Signature organic 2% milk",
    );
    assert.ok(apparelProduct);
    assert.ok(plannedMilk);
    assert.ok(plannedMilk.productId);

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest("learn-alias@example.test", "PATCH", {
            action: "freeze_trip",
            tripId,
          }),
          db,
        )
      ).status,
      200,
    );
    const ingested = await responseJson(
      await handleHouseholdPost(
        householdRequest("learn-alias@example.test", "POST", {
          action: "ingest_receipt_draft",
          clientDraftId: "learn-alias",
          tripId,
          purchasedAt: receiptTimestampForTrip(initial.currentTrip),
          subtotalCents: 10000,
          taxCents: 0,
          totalCents: 10000,
          discountCents: 0,
          items: [
            receiptDraftLine({
              sourceLineNumber: 1,
              costcoItemNumber: apparelProduct.costcoItemNumber,
              rawDescription: "3 DOT PANT",
              unitPriceCents: 8000,
              lineSubtotalCents: 8000,
              taxStatus: "taxable",
            }),
            receiptDraftLine({
              sourceLineNumber: 2,
              costcoItemNumber: null,
              rawDescription: "ZIPLC SLIDER",
              unitPriceCents: 2000,
              lineSubtotalCents: 2000,
              taxStatus: "taxable",
            }),
          ],
        }),
        db,
      ),
    );
    const intent = db.database
      .prepare(
        `SELECT * FROM trip_intent_items WHERE trip_id = ? AND list_item_id = ?`,
      )
      .get(tripId, plannedMilk.id);
    const candidateReceiptItem = db.database
      .prepare(
        `SELECT * FROM receipt_items
         WHERE receipt_transaction_id = ? AND raw_description = '3 DOT PANT'`,
      )
      .get(ingested.receiptId);
    const replacementReceiptItem = db.database
      .prepare(
        `SELECT * FROM receipt_items
         WHERE receipt_transaction_id = ? AND raw_description = 'ZIPLC SLIDER'`,
      )
      .get(ingested.receiptId);
    assert.ok(intent);
    assert.ok(candidateReceiptItem);
    assert.ok(replacementReceiptItem);

    const questionId = "learn-alias-question";
    const now = new Date().toISOString();
    db.database
      .prepare(
        `INSERT INTO review_questions (
          id, household_id, trip_id, receipt_transaction_id, question_key,
          purpose, prompt, options_json, declared_effect, effect_target,
          list_item_id, intent_item_id, receipt_item_id, priority, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?, ?, 'receipt_match', ?, ?, ?, 1, 'open', ?, ?)`,
      )
      .run(
        questionId,
        "household_basketsense",
        tripId,
        ingested.receiptId,
        "learn-alias-question",
        "Is this the same household item?",
        JSON.stringify([
          {
            value: "receipt_needs_fix",
            label: "It is on the receipt",
            effect: "Remember this household wording.",
          },
        ]),
        "Confirms and remembers a household alias",
        plannedMilk.id,
        intent.id,
        candidateReceiptItem.id,
        now,
        now,
      );

    const answer = await handleHouseholdPost(
      householdRequest("learn-alias@example.test", "POST", {
        action: "answer_review_question",
        questionId,
        value: "receipt_needs_fix",
        replacementReceiptItemId: replacementReceiptItem.id,
      }),
      db,
    );
    assert.equal(answer.status, 200);
    const fulfillments = db.database
      .prepare(
        `SELECT intent_key, receipt_key, relation
         FROM intent_fulfillments
         WHERE household_id = ? ORDER BY receipt_key`,
      )
      .all("household_basketsense");
    assert.deepEqual(
      fulfillments.map((entry) => ({ ...entry })),
      [{
        intent_key: "intent:KIRKLAND SIGNATURE ORGANIC 2% MILK",
        receipt_key: "description:ZIPLOC BAGS",
        relation: "fulfills_intent",
      }],
    );
    const aliases = db.database
      .prepare(
        `SELECT normalized_description, product_id FROM product_aliases
         WHERE household_id = ? ORDER BY normalized_description`,
      )
      .all("household_basketsense");
    assert.ok(
      aliases.some(
        (alias) =>
          alias.normalized_description === "KIRKLAND SIGNATURE ORGANIC 2% MILK" &&
          alias.product_id === plannedMilk.productId,
      ),
    );
    assert.ok(
      aliases.some(
        (alias) =>
          alias.normalized_description === "ZIPLC SLIDER" &&
          alias.product_id === plannedMilk.productId,
      ),
    );
    const correctedReceiptItem = db.database
      .prepare(`SELECT product_id FROM receipt_items WHERE id = ?`)
      .get(replacementReceiptItem.id);
    assert.equal(correctedReceiptItem.product_id, plannedMilk.productId);
    assert.equal(
      db.database
        .prepare(`SELECT product_id FROM receipt_items WHERE id = ?`)
        .get(candidateReceiptItem.id).product_id,
      apparelProduct.id,
      "The explicit replacement must win over the question's stale candidate line",
    );
  } finally {
    db.close();
  }
});

test("a unique learned household alias restores the catalog product and latest estimate", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "learned-list-alias@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const listedProductIds = new Set(initial.listItems.map((item) => item.productId).filter(Boolean));
    const product = initial.products.find(
      (candidate) =>
        candidate.latestRegularUnitPriceCents !== null &&
        !listedProductIds.has(candidate.id),
    );
    assert.ok(product);

    const now = new Date().toISOString();
    db.database.prepare(
      `INSERT INTO product_aliases (
        id, household_id, alias_key, raw_description,
        normalized_description, costco_item_number, product_id,
        confirmation_source, confirmed_by_member_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'member', ?, ?, ?)`,
    ).run(
      "learned-list-alias",
      initial.household.id,
      "intent:HOUSEHOLD PANTRY SHORTHAND",
      "Household pantry shorthand",
      "HOUSEHOLD PANTRY SHORTHAND",
      product.id,
      initial.currentUser.id,
      now,
      now,
    );

    const response = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId: initial.currentTrip.id,
        label: "household pantry shorthand",
        source: "manual",
        section: "essentials",
        included: true,
      }),
      db,
    );
    assert.equal(response.status, 201);
    const added = (await responseJson(response)).item;
    assert.equal(added.productId, product.id);
    assert.equal(added.label, product.canonicalName);
    assert.equal(added.estimatedPriceCents, product.latestRegularUnitPriceCents);
  } finally {
    db.close();
  }
});

test("a totals-only receipt preserves exact spending without inventing product evidence", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("totals-only@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const freeze = await handleHouseholdPatch(
      householdRequest("totals-only@example.test", "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freeze.status, 200);

    const ingestedResponse = await handleHouseholdPost(
      householdRequest("totals-only@example.test", "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "totals-only-july-25",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip, "10:15:00"),
        subtotalCents: 21508,
        taxCents: 337,
        totalCents: 21845,
        discountCents: 0,
        captureMode: "totals_only",
        items: [],
      }),
      db,
    );
    assert.equal(ingestedResponse.status, 200);
    const ingested = await responseJson(ingestedResponse);
    assert.equal(ingested.receipt.parseStatus, "reconciled");
    assert.equal(ingested.closedLoop.items.length, 0);
    assert.equal(ingested.comparison.actualTotalCents, 21845);
    assert.equal(ingested.comparison.isTotalsOnly, true);
    assert.equal(ingested.comparison.isProvisional, true);
    assert.equal(ingested.questions.length, 0);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_items WHERE receipt_transaction_id = ?`,
        )
        .get(ingested.receiptId).count,
      0,
    );

    const finalizedResponse = await handleHouseholdPatch(
      householdRequest("totals-only@example.test", "PATCH", {
        action: "finalize_receipt",
        receiptId: ingested.receiptId,
      }),
      db,
    );
    assert.equal(finalizedResponse.status, 200);
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId).status,
      "completed",
    );
  } finally {
    db.close();
  }
});

test("only a finalized trip receipt can change official totals, and one trip cannot double-count", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "receipt-finality@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(email, "PATCH", { action: "freeze_trip", tripId }),
          db,
        )
      ).status,
      200,
    );

    const before = initial.dashboard;
    const draftResponse = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "finality-first-draft",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip),
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
        discountCents: 0,
        captureMode: "totals_only",
        items: [],
      }),
      db,
    );
    assert.equal(draftResponse.status, 200);
    const draft = await responseJson(draftResponse);

    const whileDraft = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    assert.deepEqual(
      whileDraft.dashboard,
      before,
      "A reconciled draft stays in Review until the trip is completed",
    );

    const duplicate = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "finality-second-draft",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip),
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
        discountCents: 0,
        captureMode: "totals_only",
        items: [],
      }),
      db,
    );
    assert.equal(duplicate.status, 409);

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(email, "PATCH", {
            action: "finalize_receipt",
            receiptId: draft.receiptId,
          }),
          db,
        )
      ).status,
      200,
    );
    const afterFinalization = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    assert.notDeepEqual(afterFinalization.dashboard, before);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM email_outbox
           WHERE trip_id = ? AND kind = 'trip_summary'
             AND dedupe_key LIKE 'trip-summary:%:v2'`,
        )
        .get(tripId).count,
      0,
      "Completing a trusted receipt leaves the recap available in the private app without queueing email",
    );

    const completedEdit = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "update_receipt_draft",
        receiptId: draft.receiptId,
        totalCents: 9999,
      }),
      db,
    );
    assert.equal(completedEdit.status, 409);
  } finally {
    db.close();
  }
});

test("a reconciled receipt closes the frozen intent loop idempotently", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("closed-loop@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const milk = initial.listItems.find(
      (item) => item.label === "Kirkland Signature organic 2% milk",
    );
    const cucumbers = initial.listItems.find(
      (item) => item.label === "Mini cucumbers",
    );
    assert.ok(milk);
    assert.ok(cucumbers);
    const milkProduct = productForListItem(initial, milk);
    const cucumberProduct = productForListItem(initial, cucumbers);
    const apparelProduct = initial.products.find(
      (product) => product.costcoItemNumber === "1868328",
    );
    assert.ok(apparelProduct, "Expected audited apparel SKU 1868328");

    const includeCucumbers = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "set_item_included",
        itemId: cucumbers.id,
        included: true,
      }),
      db,
    );
    assert.equal(includeCucumbers.status, 200);

    const freeze = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freeze.status, 200);

    const snapshot = db.database
      .prepare(
        `SELECT * FROM trip_intent_snapshots WHERE trip_id = ?`,
      )
      .get(tripId);
    assert.ok(snapshot);
    assert.equal(snapshot.evidence_level, "pre_trip");
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      1,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items WHERE snapshot_id = ?`,
        )
        .get(snapshot.id).count,
      initial.listItems.length,
    );
    const frozenMilk = db.database
      .prepare(
        `SELECT * FROM trip_intent_items
         WHERE snapshot_id = ? AND list_item_id = ?`,
      )
      .get(snapshot.id, milk.id);
    assert.ok(frozenMilk);
    assert.equal(frozenMilk.included, 1);

    const removeAfterFreeze = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "set_item_included",
        itemId: milk.id,
        included: false,
      }),
      db,
    );
    assert.equal(removeAfterFreeze.status, 200);

    const postFreezeAddResponse = await handleHouseholdPost(
      householdRequest("closed-loop@example.test", "POST", {
        action: "add_list_item",
        tripId,
        label: "Post-freeze C",
        source: "manual",
        section: "consider",
        included: true,
      }),
      db,
    );
    assert.equal(postFreezeAddResponse.status, 201);
    const postFreezeAdd = await responseJson(postFreezeAddResponse);
    assert.equal(postFreezeAdd.item.addedAfterFreeze, true);

    const freezeAgain = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freezeAgain.status, 200);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      1,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items WHERE snapshot_id = ?`,
        )
        .get(snapshot.id).count,
      initial.listItems.length,
      "An existing intent snapshot never gains post-freeze list rows",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items
           WHERE snapshot_id = ? AND list_item_id = ?`,
        )
        .get(snapshot.id, postFreezeAdd.item.id).count,
      0,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT included FROM trip_intent_items
           WHERE snapshot_id = ? AND list_item_id = ?`,
        )
        .get(snapshot.id, milk.id).included,
      1,
      "The frozen milk intent remains immutable after in-store list changes",
    );

    const body = {
      action: "ingest_receipt_draft",
      clientDraftId: "reconciled-july-25",
      tripId,
      purchasedAt: receiptTimestampForTrip(initial.currentTrip, "10:15:00"),
      subtotalCents: 4846,
      taxCents: 217,
      totalCents: 5063,
      discountCents: 0,
      items: [
        receiptDraftLine({
          sourceLineNumber: 1,
          costcoItemNumber: milkProduct.costcoItemNumber,
          rawDescription: "KS ORG 2% MK",
          unitPriceCents: 1399,
          lineSubtotalCents: 1399,
        }),
        receiptDraftLine({
          sourceLineNumber: 2,
          costcoItemNumber: cucumberProduct.costcoItemNumber,
          rawDescription: "MINI CUKES",
          unitPriceCents: 649,
          lineSubtotalCents: 649,
        }),
        receiptDraftLine({
          sourceLineNumber: 3,
          costcoItemNumber: apparelProduct.costcoItemNumber,
          rawDescription: "3 DOT PANT",
          quantityMilli: 2000,
          unitPriceCents: 1399,
          lineSubtotalCents: 2798,
          taxStatus: "taxable",
        }),
      ],
    };

    const ingestResponse = await handleHouseholdPost(
      householdRequest("closed-loop@example.test", "POST", body),
      db,
    );
    assert.equal(ingestResponse.status, 200);
    const ingested = await responseJson(ingestResponse);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items
           WHERE snapshot_id = ? AND list_item_id = ?`,
        )
        .get(snapshot.id, postFreezeAdd.item.id).count,
      0,
      "Receipt ingestion must not append to an existing intent snapshot",
    );
    assert.equal(ingested.receipt.tripId, tripId);
    assert.equal(ingested.receipt.parseStatus, "reconciled");
    assert.equal(ingested.closedLoop.items.length, 3);
    assert.equal(ingested.closedLoop.matches.length, 2);
    assert.equal(ingested.comparison.arithmetic.isReconciled, true);
    assert.equal(ingested.comparison.isProvisional, false);
    assert.equal(ingested.comparison.buckets.matched.length, 2);
    assert.equal(ingested.comparison.buckets.receiptOnly.length, 1);
    const projectedPostFreezeIntent = ingested.closedLoop.intentItems.find(
      (item) => item.listItemId === postFreezeAdd.item.id,
    );
    assert.ok(projectedPostFreezeIntent);
    assert.equal(projectedPostFreezeIntent.addedAfterFreeze, true);
    assert.equal(
      ingested.comparison.buckets.skippedPlanned.some(
        (item) => item.intentItemId === projectedPostFreezeIntent.id,
      ),
      false,
      "An unmatched shopping addition is not misreported as a skipped starting-list item",
    );
    assert.ok(ingested.questions.length <= 3);

    const undoWithReceipt = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "unfreeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(undoWithReceipt.status, 409);
    assert.match(
      (await responseJson(undoWithReceipt)).error,
      /receipt evidence/i,
    );
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "frozen",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_snapshots WHERE trip_id = ?`,
        )
        .get(tripId).count,
      1,
      "Receipt-linked undo must preserve the frozen evidence",
    );

    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "frozen",
      "Arithmetic reconciliation alone must not complete the trip",
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_items
           WHERE receipt_transaction_id = ?`,
        )
        .get(ingested.receiptId).count,
      3,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_item_matches
           WHERE receipt_transaction_id = ?`,
        )
        .get(ingested.receiptId).count,
      2,
    );

    const idempotentResponse = await handleHouseholdPost(
      householdRequest("closed-loop@example.test", "POST", body),
      db,
    );
    assert.equal(idempotentResponse.status, 200);
    const idempotent = await responseJson(idempotentResponse);
    assert.equal(idempotent.receiptId, ingested.receiptId);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_transactions
           WHERE source_transaction_key = ?`,
        )
        .get("closed-loop-draft:reconciled-july-25").count,
      1,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM receipt_items
           WHERE receipt_transaction_id = ?`,
        )
        .get(ingested.receiptId).count,
      3,
    );

    const finalizeResponse = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "finalize_receipt",
        receiptId: ingested.receiptId,
      }),
      db,
    );
    assert.equal(finalizeResponse.status, 200);
    const finalized = await responseJson(finalizeResponse);
    assert.equal(finalized.receipt.parseStatus, "reconciled");
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "completed",
      "Only explicit finalization completes the trip",
    );

    const undoCompleted = await handleHouseholdPatch(
      householdRequest("closed-loop@example.test", "PATCH", {
        action: "unfreeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(undoCompleted.status, 409);
    assert.match((await responseJson(undoCompleted)).error, /completed trips/i);

    const refreshed = await responseJson(
      await handleHouseholdGet(householdRequest("closed-loop@example.test"), db),
    );
    assert.ok(refreshed.closedLoop);
    assert.equal(refreshed.closedLoop.receipt.id, ingested.receiptId);
    assert.equal(refreshed.closedLoop.comparison.arithmetic.isReconciled, true);
    assert.equal(refreshed.closedLoop.comparison.isProvisional, false);
    assert.equal(
      refreshed.dashboard.audit.through,
      initial.currentTrip.scheduledFor,
    );
    assert.equal(
      refreshed.dashboard.audit.transactionCount,
      initial.dashboard.audit.transactionCount + 1,
    );
    assert.ok(
      refreshed.dashboard.transactions.some(
        (transaction) => transaction.id === ingested.receiptId,
      ),
      "A reconciled July 25 receipt becomes part of the shared dashboard",
    );
    assert.equal(
      refreshed.dashboard.products.find(
        (product) => product.itemNumber === milkProduct.costcoItemNumber,
      )?.lastPurchasedOn,
      initial.currentTrip.scheduledFor,
      "The new receipt also updates the product's purchase history",
    );
  } finally {
    db.close();
  }
});

test("a receipt matches items added during shopping without mutating the frozen snapshot", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const email = "shopping-addition-match@example.test";
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest(email), db),
    );
    const tripId = initial.currentTrip.id;

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest(email, "PATCH", {
            action: "freeze_trip",
            tripId,
          }),
          db,
        )
      ).status,
      200,
    );
    const snapshot = db.database
      .prepare(`SELECT id FROM trip_intent_snapshots WHERE trip_id = ?`)
      .get(tripId);
    assert.ok(snapshot?.id);

    const addResponse = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "add_list_item",
        tripId,
        label: "water",
        source: "manual",
        section: "essentials",
        included: true,
        estimatedPriceCents: 899,
      }),
      db,
    );
    assert.equal(addResponse.status, 201);
    const addition = (await responseJson(addResponse)).item;
    assert.equal(addition.addedAfterFreeze, true);
    assert.equal(addition.source, "in_store");
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_intent_items
           WHERE snapshot_id = ? AND list_item_id = ?`,
        )
        .get(snapshot.id, addition.id).count,
      0,
      "The immutable starting snapshot must not gain the shopping addition",
    );

    const ingestResponse = await handleHouseholdPost(
      householdRequest(email, "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "shopping-addition-water-receipt",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip, "12:15:00"),
        subtotalCents: 949,
        taxCents: 0,
        totalCents: 949,
        discountCents: 0,
        items: [
          receiptDraftLine({
            sourceLineNumber: 1,
            costcoItemNumber: null,
            rawDescription: "KS WATER 8OZ",
            unitPriceCents: 949,
            lineSubtotalCents: 949,
          }),
        ],
      }),
      db,
    );
    assert.equal(ingestResponse.status, 200);
    const ingested = await responseJson(ingestResponse);
    const shoppingIntent = ingested.closedLoop.intentItems.find(
      (item) => item.listItemId === addition.id,
    );
    assert.ok(shoppingIntent);
    assert.equal(shoppingIntent.addedAfterFreeze, true);
    assert.equal(ingested.closedLoop.matches.length, 1);
    assert.equal(ingested.comparison.buckets.matched.length, 0);
    assert.equal(ingested.comparison.buckets.addedDuringTrip.length, 1);
    assert.equal(ingested.comparison.buckets.receiptOnly.length, 0);
    assert.equal(ingested.comparison.additionsCents, 949);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_item_matches
           WHERE receipt_transaction_id = ?`,
        )
        .get(ingested.receiptId).count,
      0,
      "The live-addition projection must not create a foreign-key row in the frozen match table",
    );

    const finalizeResponse = await handleHouseholdPatch(
      householdRequest(email, "PATCH", {
        action: "finalize_receipt",
        receiptId: ingested.receiptId,
      }),
      db,
    );
    assert.equal(finalizeResponse.status, 200);

    const historicalResponse = await handleHouseholdGet(
      householdRequest(
        email,
        "GET",
        undefined,
        `?view=trip-review&receiptId=${encodeURIComponent(ingested.receiptId)}`,
      ),
      db,
    );
    assert.equal(historicalResponse.status, 200);
    const historical = (await responseJson(historicalResponse)).closedLoop;
    assert.equal(historical.comparison.buckets.addedDuringTrip.length, 1);
    assert.equal(historical.comparison.buckets.receiptOnly.length, 0);
    assert.equal(historical.comparison.additionsCents, 949);
  } finally {
    db.close();
  }
});

test("an unknown receipt item becomes a catalog product only after an explicit named confirmation", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("confirm-once@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const productCountBefore = db.database
      .prepare(`SELECT COUNT(*) AS count FROM products`)
      .get().count;

    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest("confirm-once@example.test", "PATCH", {
            action: "freeze_trip",
            tripId,
          }),
          db,
        )
      ).status,
      200,
    );
    const ingest = await responseJson(
      await handleHouseholdPost(
        householdRequest("confirm-once@example.test", "POST", {
          action: "ingest_receipt_draft",
          clientDraftId: "confirm-once-rice",
          tripId,
          purchasedAt: receiptTimestampForTrip(initial.currentTrip),
          subtotalCents: 2400,
          taxCents: 0,
          totalCents: 2400,
          discountCents: 0,
          items: [
            receiptDraftLine({
              sourceLineNumber: 1,
              costcoItemNumber: "9988776",
              rawDescription: "BASMATI RICE 20LB",
              unitPriceCents: 2400,
              lineSubtotalCents: 2400,
            }),
          ],
        }),
        db,
      ),
    );
    const catalogQuestion = ingest.questions.find((question) =>
      question.options.some((option) => option.value === "add_to_catalog"),
    );
    assert.equal(ingest.comparison.buckets.unresolved.length, 0);
    assert.equal(ingest.comparison.buckets.receiptOnly.length, 1);
    assert.equal(ingest.comparison.unresolvedCents, 0);
    assert.ok(catalogQuestion);
    assert.ok(catalogQuestion.receiptItemId);

    db.database
      .prepare(
        `UPDATE review_questions
         SET answer_claim_token = ?, answer_claimed_at = ? WHERE id = ?`,
      )
      .run("another-member", new Date().toISOString(), catalogQuestion.id);
    const claimedByPartner = await handleHouseholdPost(
      householdRequest("confirm-once@example.test", "POST", {
        action: "answer_review_question",
        questionId: catalogQuestion.id,
        value: "add_to_catalog",
        canonicalName: "Should not be saved",
        category: "groceries_beverages",
      }),
      db,
    );
    assert.equal(claimedByPartner.status, 409);
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM feedback`).get().count,
      0,
      "A claimed question must not run catalog or feedback side effects",
    );
    db.database
      .prepare(
        `UPDATE review_questions
         SET answer_claim_token = NULL, answer_claimed_at = NULL WHERE id = ?`,
      )
      .run(catalogQuestion.id);

    const missingMetadata = await handleHouseholdPost(
      householdRequest("confirm-once@example.test", "POST", {
        action: "answer_review_question",
        questionId: catalogQuestion.id,
        value: "add_to_catalog",
      }),
      db,
    );
    assert.equal(missingMetadata.status, 400);
    assert.equal(
      db.database.prepare(`SELECT COUNT(*) AS count FROM products`).get().count,
      productCountBefore,
      "Raw receipt text must never silently create a catalog product",
    );

    const confirmed = await handleHouseholdPost(
      householdRequest("confirm-once@example.test", "POST", {
        action: "answer_review_question",
        questionId: catalogQuestion.id,
        value: "add_to_catalog",
        canonicalName: "Royal basmati rice, 20 lb",
        category: "groceries_beverages",
      }),
      db,
    );
    assert.equal(confirmed.status, 200);
    const confirmedBody = await responseJson(confirmed);
    assert.equal(confirmedBody.question.selectedValue, "add_to_catalog");

    const product = db.database
      .prepare(
        `SELECT * FROM products
         WHERE household_id = ? AND canonical_name = ?`,
      )
      .get("household_basketsense", "Royal basmati rice, 20 lb");
    assert.ok(product);
    assert.equal(product.category, "groceries_beverages");
    assert.equal(product.category_status, "reviewed");
    assert.equal(product.costco_item_number, "9988776");
    assert.equal(
      db.database
        .prepare(
          `SELECT raw_description, product_id FROM product_aliases
           WHERE household_id = ? AND costco_item_number = ?`,
        )
        .get("household_basketsense", "9988776").raw_description,
      "BASMATI RICE 20LB",
    );
    const receiptItem = db.database
      .prepare(`SELECT * FROM receipt_items WHERE id = ?`)
      .get(catalogQuestion.receiptItemId);
    assert.equal(receiptItem.product_id, product.id);
    assert.equal(receiptItem.line_subtotal_cents, 2400);
    assert.equal(receiptItem.net_amount_cents, 2400);

    const refreshed = await responseJson(
      await handleHouseholdGet(householdRequest("confirm-once@example.test"), db),
    );
    const searchable = refreshed.products.find((entry) => entry.id === product.id);
    assert.ok(searchable);
    assert.equal(
      searchable.purchaseCount,
      0,
      "A draft is searchable after confirmation but does not train future prices until finalization",
    );
    assert.equal(searchable.latestRegularUnitPriceCents, null);
    assert.equal(searchable.latestPaidUnitPriceCents, null);
    assert.equal(
      refreshed.listItems.some((item) => item.productId === product.id),
      false,
      "One confirmed purchase is searchable but is not auto-added to the Saturday list",
    );

    const addedToLiveList = await responseJson(
      await handleHouseholdPost(
        householdRequest("confirm-once@example.test", "POST", {
          action: "add_list_item",
          tripId,
          productId: product.id,
          label: "Royal basmati rice, 20 lb",
          section: "essentials",
          source: "manual",
          included: true,
        }),
        db,
      ),
    );
    assert.equal(addedToLiveList.item.productId, product.id);
    assert.equal(addedToLiveList.item.estimatedPriceCents, 2400);
  } finally {
    db.close();
  }
});

test("finalizing a receipt promotes a new product even when optional review is declined", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("optional-catalog@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    assert.equal(
      (
        await handleHouseholdPatch(
          householdRequest("optional-catalog@example.test", "PATCH", {
            action: "freeze_trip",
            tripId,
          }),
          db,
        )
      ).status,
      200,
    );

    const ingest = await responseJson(
      await handleHouseholdPost(
        householdRequest("optional-catalog@example.test", "POST", {
          action: "ingest_receipt_draft",
          clientDraftId: "optional-catalog-line",
          tripId,
          purchasedAt: receiptTimestampForTrip(initial.currentTrip),
          subtotalCents: 1799,
          taxCents: 0,
          totalCents: 1799,
          discountCents: 0,
          items: [
            receiptDraftLine({
              sourceLineNumber: 1,
              costcoItemNumber: "1122334",
              rawDescription: "NEW HOUSEHOLD ITEM",
              unitPriceCents: 1799,
              lineSubtotalCents: 1799,
            }),
          ],
        }),
        db,
      ),
    );
    assert.equal(ingest.comparison.buckets.unresolved.length, 0);
    assert.equal(ingest.comparison.buckets.receiptOnly.length, 1);

    const catalogQuestion = ingest.questions.find((question) =>
      question.options.some((option) => option.value === "add_to_catalog"),
    );
    assert.ok(catalogQuestion);
    const notNowResponse = await handleHouseholdPost(
      householdRequest("optional-catalog@example.test", "POST", {
        action: "answer_review_question",
        questionId: catalogQuestion.id,
        value: "leave_unresolved",
      }),
      db,
    );
    assert.equal(notNowResponse.status, 200);

    const finalizeResponse = await handleHouseholdPatch(
      householdRequest("optional-catalog@example.test", "PATCH", {
        action: "finalize_receipt",
        receiptId: ingest.receiptId,
      }),
      db,
    );
    assert.equal(finalizeResponse.status, 200);

    const refreshed = await responseJson(
      await handleHouseholdGet(householdRequest("optional-catalog@example.test"), db),
    );
    assert.equal(refreshed.closedLoop.receipt.id, ingest.receiptId);
    assert.equal(refreshed.closedLoop.comparison.isProvisional, false);
    assert.equal(refreshed.closedLoop.comparison.buckets.unresolved.length, 0);
    assert.equal(refreshed.closedLoop.comparison.buckets.receiptOnly.length, 1);
    const promotedProductId = db.database
      .prepare(`SELECT product_id FROM receipt_items WHERE receipt_transaction_id = ?`)
      .get(ingest.receiptId).product_id;
    assert.ok(promotedProductId);
    assert.equal(
      db.database
        .prepare(`SELECT costco_item_number FROM products WHERE id = ?`)
        .get(promotedProductId).costco_item_number,
      "1122334",
    );
  } finally {
    db.close();
  }
});

test("a provisional receipt refuses finalization and review answers have bounded idempotent effects", async () => {
  const db = new D1DatabaseAdapter();
  try {
    const initial = await responseJson(
      await handleHouseholdGet(householdRequest("review-loop@example.test"), db),
    );
    const tripId = initial.currentTrip.id;
    const sourceScheduledFor = initial.currentTrip.scheduledFor;
    const milk = initial.listItems.find(
      (item) => item.label === "Kirkland Signature organic 2% milk",
    );
    assert.ok(milk);
    const milkProduct = productForListItem(initial, milk);
    const apparelProduct = initial.products.find(
      (product) => product.costcoItemNumber === "1868328",
    );
    assert.ok(apparelProduct, "Expected audited apparel SKU 1868328");

    const freezeResponse = await handleHouseholdPatch(
      householdRequest("review-loop@example.test", "PATCH", {
        action: "freeze_trip",
        tripId,
      }),
      db,
    );
    assert.equal(freezeResponse.status, 200);

    const ingestResponse = await handleHouseholdPost(
      householdRequest("review-loop@example.test", "POST", {
        action: "ingest_receipt_draft",
        clientDraftId: "provisional-july-25",
        tripId,
        purchasedAt: receiptTimestampForTrip(initial.currentTrip),
        subtotalCents: 6203,
        taxCents: 217,
        totalCents: 6420,
        discountCents: 0,
        items: [
          receiptDraftLine({
            sourceLineNumber: 1,
            costcoItemNumber: milkProduct.costcoItemNumber,
            rawDescription: "KS ORG 2% MK",
            unitPriceCents: 1399,
            lineSubtotalCents: 1399,
          }),
          receiptDraftLine({
            sourceLineNumber: 2,
            costcoItemNumber: apparelProduct.costcoItemNumber,
            rawDescription: "3 DOT PANT",
            quantityMilli: 2000,
            unitPriceCents: 1399,
            lineSubtotalCents: 2798,
            taxStatus: "taxable",
          }),
          receiptDraftLine({
            sourceLineNumber: 3,
            costcoItemNumber: "9999999",
            rawDescription: "MYSTERY RECEIPT LINE",
            unitPriceCents: 2000,
            lineSubtotalCents: 2000,
          }),
        ],
      }),
      db,
    );
    assert.equal(ingestResponse.status, 200);
    const draft = await responseJson(ingestResponse);
    assert.equal(draft.receipt.parseStatus, "needs_review");
    assert.equal(draft.comparison.arithmetic.subtotalDeltaCents, -6);
    assert.equal(draft.comparison.arithmetic.isReconciled, false);
    assert.equal(draft.comparison.isProvisional, true);
    assert.equal(draft.comparison.buckets.unresolved.length, 0);
    assert.equal(draft.comparison.buckets.receiptOnly.length, 2);
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "frozen",
    );

    assert.equal(draft.questions.length, 3);
    assert.deepEqual(
      draft.questions.map((question) => question.purpose),
      ["data_quality", "intent", "product_experience"],
    );

    const finalizeResponse = await handleHouseholdPatch(
      householdRequest("review-loop@example.test", "PATCH", {
        action: "finalize_receipt",
        receiptId: draft.receiptId,
      }),
      db,
    );
    assert.equal(finalizeResponse.status, 409);
    const finalizeError = await responseJson(finalizeResponse);
    assert.match(finalizeError.error, /within five cents/i);

    const dataQualityQuestion = draft.questions.find(
      (question) => question.purpose === "data_quality",
    );
    assert.ok(dataQualityQuestion);
    const countsBeforeSkip = {
      feedback: db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM feedback
           WHERE receipt_transaction_id = ?`,
        )
        .get(draft.receiptId).count,
      trips: db.database.prepare(`SELECT COUNT(*) AS count FROM trips`).get()
        .count,
      listItems: db.database
        .prepare(`SELECT COUNT(*) AS count FROM trip_list_items`)
        .get().count,
      matches: db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trip_item_matches
           WHERE receipt_transaction_id = ?`,
        )
        .get(draft.receiptId).count,
      aliases: db.database
        .prepare(`SELECT COUNT(*) AS count FROM product_aliases`)
        .get().count,
    };
    const skipResponse = await handleHouseholdPost(
      householdRequest("review-loop@example.test", "POST", {
        action: "answer_review_question",
        questionId: dataQualityQuestion.id,
        value: "skip",
      }),
      db,
    );
    assert.equal(skipResponse.status, 200);
    const skipped = await responseJson(skipResponse);
    assert.equal(skipped.question.status, "dismissed");
    assert.equal(skipped.question.selectedValue, "skip");
    assert.deepEqual(
      {
        feedback: db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM feedback
             WHERE receipt_transaction_id = ?`,
          )
          .get(draft.receiptId).count,
        trips: db.database.prepare(`SELECT COUNT(*) AS count FROM trips`).get()
          .count,
        listItems: db.database
          .prepare(`SELECT COUNT(*) AS count FROM trip_list_items`)
          .get().count,
        matches: db.database
          .prepare(
            `SELECT COUNT(*) AS count FROM trip_item_matches
             WHERE receipt_transaction_id = ?`,
          )
          .get(draft.receiptId).count,
        aliases: db.database
          .prepare(`SELECT COUNT(*) AS count FROM product_aliases`)
          .get().count,
      },
      countsBeforeSkip,
    );

    const skipAgain = await handleHouseholdPost(
      householdRequest("review-loop@example.test", "POST", {
        action: "answer_review_question",
        questionId: dataQualityQuestion.id,
        value: "skip",
      }),
      db,
    );
    assert.equal(skipAgain.status, 200);
    assert.equal((await responseJson(skipAgain)).question.status, "dismissed");

    const carryQuestion = draft.questions.find((question) =>
      question.options.some((option) => option.value === "still_need_it"),
    );
    assert.ok(carryQuestion, "Expected a missing-essential carry-forward option");
    db.database
      .prepare(
        `UPDATE trip_intent_items
         SET product_id = NULL, label = 'Atta', estimated_price_cents = 2400
         WHERE id = ?`,
      )
      .run(carryQuestion.intentItemId);
    const intent = db.database
      .prepare(`SELECT * FROM trip_intent_items WHERE id = ?`)
      .get(carryQuestion.intentItemId);
    assert.ok(intent);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trips
           WHERE scheduled_for > ?`,
        )
        .get(sourceScheduledFor).count,
      0,
    );

    const carryResponse = await handleHouseholdPost(
      householdRequest("review-loop@example.test", "POST", {
        action: "answer_review_question",
        questionId: carryQuestion.id,
        value: "still_need_it",
      }),
      db,
    );
    assert.equal(carryResponse.status, 200);
    const carriedAnswer = await responseJson(carryResponse);
    assert.equal(carriedAnswer.question.status, "answered");
    assert.equal(carriedAnswer.question.selectedValue, "still_need_it");

    const followingTrip = db.database
      .prepare(
        `SELECT * FROM trips
         WHERE scheduled_for > ?
         ORDER BY scheduled_for ASC LIMIT 1`,
      )
      .get(sourceScheduledFor);
    assert.ok(followingTrip);
    assert.equal(followingTrip.status, "planning");
    const carriedCount = () =>
      db.database
        .prepare(
          intent.product_id
            ? `SELECT COUNT(*) AS count FROM trip_list_items
               WHERE trip_id = ? AND product_id = ?`
            : `SELECT COUNT(*) AS count FROM trip_list_items
               WHERE trip_id = ? AND lower(trim(label)) = lower(trim(?))`,
        )
        .get(followingTrip.id, intent.product_id ?? intent.label).count;
    assert.equal(carriedCount(), 1);
    assert.equal(
      db.database
        .prepare(
          intent.product_id
            ? `SELECT included, estimated_price_cents FROM trip_list_items
               WHERE trip_id = ? AND product_id = ?`
            : `SELECT included, estimated_price_cents FROM trip_list_items
               WHERE trip_id = ? AND lower(trim(label)) = lower(trim(?))`,
        )
        .get(followingTrip.id, intent.product_id ?? intent.label).included,
      1,
    );
    assert.equal(
      db.database
        .prepare(
          `SELECT estimated_price_cents
           FROM trip_list_items
           WHERE trip_id = ? AND lower(trim(label)) = lower(trim(?))`,
        )
        .get(followingTrip.id, intent.label).estimated_price_cents,
      null,
      "A household guess expires instead of becoming a future price",
    );

    const carryAgain = await handleHouseholdPost(
      householdRequest("review-loop@example.test", "POST", {
        action: "answer_review_question",
        questionId: carryQuestion.id,
        value: "still_need_it",
      }),
      db,
    );
    assert.equal(carryAgain.status, 200);
    assert.equal(carriedCount(), 1);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM feedback
           WHERE id = ?`,
        )
        .get(`review-feedback:${carryQuestion.id}`).count,
      1,
    );
  } finally {
    db.close();
  }
});
