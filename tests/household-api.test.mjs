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
} from "../app/api/household/route.ts";
import {
  buildSaturdayRecommendations,
  JULY_25_PLAN_DATE,
} from "../app/recommendation-engine.ts";

class PreparedStatementAdapter {
  constructor(database, sql, values = [], beforeExecute = null) {
    this.database = database;
    this.sql = sql;
    this.values = values;
    this.beforeExecute = beforeExecute;
  }

  bind(...values) {
    return new PreparedStatementAdapter(
      this.database,
      this.sql,
      values,
      this.beforeExecute,
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
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class D1DatabaseAdapter {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.failNextBatchPattern = null;
    this.beforeNextStatement = null;
  }

  prepare(sql) {
    return new PreparedStatementAdapter(this.database, sql, [], (statement) => {
      if (
        this.beforeNextStatement &&
        this.beforeNextStatement.pattern.test(statement)
      ) {
        const { mutation } = this.beforeNextStatement;
        this.beforeNextStatement = null;
        mutation(this.database);
      }
    });
  }

  async batch(statements) {
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
    this.database.close();
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
        "2026-08-01",
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
    assert.equal(first.currentTrip.scheduledFor, "2026-07-25");
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
      purchasedAt: "2026-07-25T10:15:00-07:00",
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
    assert.equal(ingested.comparison.buckets.receiptOnly.length, 1);
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
    assert.equal(refreshed.dashboard.audit.through, "2026-07-25");
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
      "2026-07-25",
      "The new receipt also updates the product's purchase history",
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
        purchasedAt: "2026-07-25T10:30:00-07:00",
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
    assert.equal(draft.comparison.buckets.unresolved.length, 1);
    assert.equal(
      db.database.prepare(`SELECT status FROM trips WHERE id = ?`).get(tripId)
        .status,
      "frozen",
    );

    assert.equal(draft.questions.length, 3);
    assert.deepEqual(
      draft.questions.map((question) => question.purpose),
      ["data_quality", "intent", "outcome"],
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
    const intent = db.database
      .prepare(`SELECT * FROM trip_intent_items WHERE id = ?`)
      .get(carryQuestion.intentItemId);
    assert.ok(intent);
    assert.equal(
      db.database
        .prepare(
          `SELECT COUNT(*) AS count FROM trips
           WHERE scheduled_for > '2026-07-25'`,
        )
        .get().count,
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
         WHERE scheduled_for > '2026-07-25'
         ORDER BY scheduled_for ASC LIMIT 1`,
      )
      .get();
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
            ? `SELECT included FROM trip_list_items
               WHERE trip_id = ? AND product_id = ?`
            : `SELECT included FROM trip_list_items
               WHERE trip_id = ? AND lower(trim(label)) = lower(trim(?))`,
        )
        .get(followingTrip.id, intent.product_id ?? intent.label).included,
      1,
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
