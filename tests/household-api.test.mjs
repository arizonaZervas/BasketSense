import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RECURRING_PRODUCT_HISTORIES_2026 } from "../app/basketsense-data.ts";
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
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new PreparedStatementAdapter(this.database, this.sql, values);
  }

  async run() {
    return this.execute(false);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return this.execute(true);
  }

  execute(forceRows) {
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
  }

  prepare(sql) {
    return new PreparedStatementAdapter(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute(false));
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

function householdRequest(email, method = "GET", body) {
  return new Request("https://basket-sense.test/api/household", {
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

    const sharedAfterAdd = await responseJson(
      await handleHouseholdGet(householdRequest("second@example.test"), db),
    );
    assert.ok(sharedAfterAdd.listItems.some((item) => item.label === "Diapers"));

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

    const milk = frozen.listItems.find(
      (item) => item.label === "Kirkland Signature organic 2% milk",
    );
    assert.ok(milk);
    assert.equal(milk.includedAtFreeze, true);

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
    assert.equal(removedMilk.item.includedAtFreeze, true);

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
