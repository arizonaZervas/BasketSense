import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ensureBasketSenseSchemaUpgrades } from "../app/database-schema-upgrades.ts";

class StatementAdapter {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new StatementAdapter(this.database, this.sql, values);
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.values),
      meta: {},
    };
  }
}

class DatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new StatementAdapter(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function applyMigration(database, filename) {
  const source = readFileSync(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) database.exec(sql);
  }
}

test("runtime schema gate upgrades the bound pre-release database idempotently", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    for (const migration of [
      "0000_mushy_proudstar.sql",
      "0001_gigantic_shiva.sql",
      "0002_tricky_marten_broadcloak.sql",
      "0003_ambiguous_dark_beast.sql",
      "0004_magical_patriot.sql",
      "0005_cheerful_the_professor.sql",
      "0006_fix_august_receipt_date.sql",
      "0007_bumpy_lily_hollister.sql",
      "0008_sticky_roxanne_simpson.sql",
    ]) {
      applyMigration(database, migration);
    }

    database.exec(`
      INSERT INTO households (id, slug, name) VALUES ('h1', 'house', 'House');
      INSERT INTO household_members (id, household_id, user_email, display_name, role)
        VALUES ('m1', 'h1', 'owner@example.test', 'Owner', 'owner');
      INSERT INTO products (id, household_id, canonical_name)
        VALUES ('p1', 'h1', 'Test product');
      INSERT INTO trips (id, household_id, status, scheduled_for)
        VALUES ('t1', 'h1', 'completed', '2026-08-01');
      INSERT INTO receipt_transactions (
        id, household_id, trip_id, source_transaction_key, source_type, purchased_at,
        item_gross_cents, item_count, subtotal_cents, total_cents, household_funded_cents
      ) VALUES (
        'r1', 'h1', 't1', 'source-1', 'receipt_photo', '2026-08-01T12:00:00Z',
        1000, 1, 1000, 1000, 1000
      );
      INSERT INTO receipt_items (
        id, receipt_transaction_id, product_id, source_line_number, raw_description,
        line_subtotal_cents, net_amount_cents, tax_status, normalization_status
      ) VALUES (
        'ri1', 'r1', 'p1', 1, 'TEST PRODUCT', 1000, 1000, 'unknown', 'matched'
      );
      INSERT INTO feedback (
        id, household_id, trip_id, receipt_transaction_id, receipt_item_id, kind, value
      ) VALUES (
        'f1', 'h1', 't1', 'r1', 'ri1', 'product_experience', 'buy_again'
      );
      INSERT INTO receipt_ingestions (
        id, household_id, trip_id, requested_by_member_id, client_request_id,
        source_storage_key, source_content_type, source_byte_size
      ) VALUES (
        'i1', 'h1', 't1', 'm1', 'request-1', 'receipt-source-1', 'image/jpeg', 1234
      );
    `);

    await ensureBasketSenseSchemaUpgrades(new DatabaseAdapter(database));

    const ingestionColumns = database.prepare("PRAGMA table_info('receipt_ingestions')").all();
    assert.equal(ingestionColumns.find((column) => column.name === "trip_id")?.notnull, 0);
    for (const column of [
      "recovery_manifest_key",
      "provider_response_id",
      "provider_finish_reason",
      "provider_duration_ms",
      "extraction_pass",
    ]) {
      assert.ok(ingestionColumns.some((entry) => entry.name === column));
    }
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT id, household_id, trip_id, client_request_id FROM receipt_ingestions")
          .get(),
      },
      { id: "i1", household_id: "h1", trip_id: "t1", client_request_id: "request-1" },
    );
    assert.equal(database.prepare("SELECT product_id FROM feedback WHERE id = 'f1'").get().product_id, "p1");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM product_image_jobs").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipt_corrections").get().count, 0);
    const receiptItemColumns = database.prepare("PRAGMA table_info('receipt_items')").all();
    assert.ok(receiptItemColumns.some((entry) => entry.name === "interpreted_name"));
    assert.ok(
      receiptItemColumns.some(
        (entry) => entry.name === "interpretation_confidence_bps",
      ),
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM product_understandings").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM intent_fulfillments").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM recommendation_shadow_runs").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM recommendation_shadow_candidates").get().count, 0);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM basketsense_schema_migrations WHERE status = 'completed'").get().count,
      6,
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);

    await ensureBasketSenseSchemaUpgrades(new DatabaseAdapter(database));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM receipt_ingestions").get().count, 1);
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);

    database.exec(
      "UPDATE basketsense_schema_migrations SET status = 'failed' WHERE id = '0012_product_memory_feedback'",
    );
    await ensureBasketSenseSchemaUpgrades(new DatabaseAdapter(database));
    assert.equal(
      database
        .prepare(
          "SELECT status FROM basketsense_schema_migrations WHERE id = '0012_product_memory_feedback'",
        )
        .get().status,
      "completed",
    );
  } finally {
    database.close();
  }
});
