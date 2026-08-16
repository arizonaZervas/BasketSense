import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildGeminiGenerateContentRequest,
  extractReceiptWithGemini,
  ReceiptExtractionError,
} from "../workers/receipt-ingestion/src/extraction.ts";
import {
  prepareReceiptRecoveryAssets,
  prepareReceiptUpload,
} from "../app/receipt-review-flow.tsx";

test("recovery extraction accepts an enhanced image plus ordered overlapping sections", () => {
  const request = buildGeminiGenerateContentRequest({
    contentType: "image/jpeg",
    bytes: new Uint8Array([9]).buffer,
    sources: [
      { contentType: "image/jpeg", bytes: new Uint8Array([1]).buffer },
      { contentType: "image/jpeg", bytes: new Uint8Array([2]).buffer },
      { contentType: "image/jpeg", bytes: new Uint8Array([3]).buffer },
    ],
    recovery: true,
  });
  const parts = request.contents[0].parts;
  assert.deepEqual(parts.slice(0, 3).map((part) => part.inlineData.data), ["AQ==", "Ag==", "Aw=="]);
  assert.match(parts[3].text, /overlapping top-to-bottom sections/i);
  assert.match(parts[3].text, /Merge duplicated lines/i);
});

test("receipt provider failures are classified without returning receipt contents", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      responseId: "response-safe-id",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not-json" }] } }],
    });
    await assert.rejects(
      () => extractReceiptWithGemini({
        apiKey: "test-key",
        model: "test-model",
        contentType: "image/jpeg",
        bytes: new Uint8Array([1]).buffer,
      }),
      (error) => error instanceof ReceiptExtractionError && error.code === "invalid_json",
    );

    globalThis.fetch = async () => Response.json({
      responseId: "response-safe-id",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
        purchasedAt: null,
        subtotalCents: null,
        taxCents: null,
        totalCents: null,
        discountCents: 0,
        lines: [],
        warnings: ["unreadable"],
      }) }] } }],
    });
    await assert.rejects(
      () => extractReceiptWithGemini({
        apiKey: "test-key",
        model: "test-model",
        contentType: "image/jpeg",
        bytes: new Uint8Array([1]).buffer,
      }),
      (error) => error instanceof ReceiptExtractionError && error.code === "unreadable_image",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token-limited receipt output is classified as truncation without accepting partial JSON", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      responseId: "response-safe-id",
      candidates: [{
        finishReason: "MAX_TOKENS",
        content: { parts: [{ text: '{"purchasedAt":null,"lines":[' }] },
      }],
    });
    await assert.rejects(
      () => extractReceiptWithGemini({
        apiKey: "test-key",
        model: "test-model",
        contentType: "image/jpeg",
        bytes: new Uint8Array([1]).buffer,
      }),
      (error) =>
        error instanceof ReceiptExtractionError &&
        error.code === "output_truncated" &&
        error.details.finishReason === "MAX_TOKENS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("long receipt recovery creates a shadow-resistant full view and overlapping sections", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  let closed = false;
  globalThis.createImageBitmap = async () => ({
    width: 1_200,
    height: 5_000,
    close() { closed = true; },
  });
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return { filter: "none", drawImage() {} };
        },
        toBlob(callback) {
          callback(new Blob([new Uint8Array(2_000)], { type: "image/jpeg" }));
        },
      };
    },
  };
  try {
    const assets = await prepareReceiptRecoveryAssets(new File(
      [new Uint8Array(8_000)],
      "shadowed-long-receipt.jpg",
      { type: "image/jpeg" },
    ));
    assert.equal(assets[0].name, "shadowed-long-receipt-enhanced.jpg");
    assert.ok(assets.filter((asset) => asset.name.includes("section-")).length >= 3);
    assert.equal(closed, true);
  } finally {
    if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
    else delete globalThis.createImageBitmap;
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  }
});

test("large receipt preparation retries createImageBitmap without Safari-unsupported options", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  let decodeCalls = 0;
  let closed = false;
  globalThis.createImageBitmap = async (_file, options) => {
    decodeCalls += 1;
    if (options) throw new TypeError("options unsupported");
    return {
      width: 1_842,
      height: 5_709,
      close() { closed = true; },
    };
  };
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(callback) {
          callback(new Blob([new Uint8Array(900_000)], { type: "image/jpeg" }));
        },
      };
    },
  };
  try {
    const prepared = await prepareReceiptUpload(new File(
      [new Uint8Array(5_236_522)],
      "IMG_4797.jpg",
      { type: "image/jpeg" },
    ));
    assert.equal(decodeCalls, 2);
    assert.equal(prepared.type, "image/jpeg");
    assert.equal(prepared.size, 900_000);
    assert.ok(prepared.size < 1.5 * 1024 * 1024);
    assert.equal(closed, true);
  } finally {
    if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
    else delete globalThis.createImageBitmap;
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  }
});

test("large receipt preparation never falls back to an oversized original", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalImage = globalThis.Image;
  globalThis.createImageBitmap = async () => {
    throw new Error("decoder unavailable");
  };
  delete globalThis.Image;
  try {
    await assert.rejects(
      () => prepareReceiptUpload(new File(
        [new Uint8Array(5_236_522)],
        "IMG_4797.jpg",
        { type: "image/jpeg" },
      )),
      /could not decode/i,
    );
  } finally {
    if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
    else delete globalThis.createImageBitmap;
    if (originalImage) globalThis.Image = originalImage;
    else delete globalThis.Image;
  }
});

test("historical review is lazy, owner-only to correct, and keeps revision evidence", async () => {
  const [route, ingestionRoute, dashboard, flow, migration, feedbackMigration] = await Promise.all([
    readFile(new URL("../app/api/household/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/receipt-ingestion/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/basket-sense-dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/receipt-review-flow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0011_swift_warbird.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_wet_psylocke.sql", import.meta.url), "utf8"),
  ]);
  assert.match(route, /view === "review-history"/);
  assert.match(route, /view === "trip-review"/);
  assert.match(route, /requireHouseholdOwner\(context\)/);
  assert.match(route, /previous_receipt_json/);
  assert.match(route, /previous_items_json/);
  assert.match(route, /replacement_storage_key/);
  assert.match(route, /status IN \('awaiting_review', 'failed'\)/);
  assert.match(route, /SET status = 'superseded'/);
  assert.doesNotMatch(route.match(/async function applyHistoricalReceiptCorrection[\s\S]*?async function finalizeReceipt/)?.[0] ?? "", /SET status = 'completed'/);
  assert.match(dashboard, /view=review-history/);
  assert.match(dashboard, /Correct this receipt/);
  assert.match(dashboard, /current version stays official until you review and apply/i);
  assert.match(flow, /action: "apply_receipt_correction"/);
  assert.match(flow, /Re-read saved receipt/);
  assert.match(flow, /Current official receipt → proposed correction/);
  assert.match(flow, /Product changes/);
  assert.match(flow, /Apply correction/);
  assert.match(ingestionRoute, /action !== "reprocess_saved_receipt"/);
  assert.match(ingestionRoute, /receipt_uploads\.storage_key/);
  assert.match(ingestionRoute, /reusedSavedOriginal/);
  assert.match(migration, /CREATE TABLE `receipt_corrections`/);
  assert.match(migration, /provider_response_id/);
  assert.match(feedbackMigration, /UPDATE `feedback`/);
  assert.match(feedbackMigration, /product_experience/);
});

test("receipt ingestion stores recovery evidence separately and records safe diagnostics", async () => {
  const source = await readFile(
    new URL("../app/api/receipt-ingestion/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /form\.get\("action"\) !== "add_recovery_asset"/);
  assert.match(source, /recovery-manifest\.json/);
  assert.match(source, /provider_response_id/);
  assert.match(source, /provider_finish_reason/);
  assert.match(source, /provider_duration_ms/);
  assert.match(source, /unreadable_image/);
  assert.match(source, /DEFAULT_GEMINI_MODEL = "gemini-3\.5-flash-lite"/);
  assert.match(source, /DEFAULT_GEMINI_RECOVERY_MODEL = "gemini-3\.5-flash"/);
  assert.match(
    source,
    /GEMINI_RECOVERY_MODEL\?\.trim\(\) \|\|\s+DEFAULT_GEMINI_RECOVERY_MODEL/,
  );
  assert.doesNotMatch(source, /console\.error\([^\n]*draft/);
});

test("receipt hardening migration preserves existing ingestion rows and adds revision indexes", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE households (id TEXT PRIMARY KEY);
      CREATE TABLE trips (id TEXT PRIMARY KEY);
      CREATE TABLE household_members (id TEXT PRIMARY KEY);
      CREATE TABLE receipt_transactions (id TEXT PRIMARY KEY);
      CREATE TABLE receipt_ingestions (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        trip_id TEXT,
        client_request_id TEXT NOT NULL,
        source_storage_key TEXT NOT NULL,
        source_content_type TEXT NOT NULL,
        source_byte_size INTEGER NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO receipt_ingestions VALUES (
        'ingestion-before-hardening', 'household-1', NULL, 'request-1',
        'private/source', 'image/jpeg', 1234, 'failed', 1, 2,
        '2026-08-15T00:00:00.000Z'
      );
    `);
    const migration = await readFile(
      new URL("../drizzle/0011_swift_warbird.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
    assert.equal(
      database.prepare("SELECT status FROM receipt_ingestions WHERE id = ?").get("ingestion-before-hardening").status,
      "failed",
    );
    const columns = database.prepare("PRAGMA table_info(receipt_ingestions)").all().map((row) => row.name);
    assert.ok(columns.includes("recovery_manifest_key"));
    assert.ok(columns.includes("provider_response_id"));
    assert.ok(columns.includes("extraction_pass"));
    const indexes = database.prepare("PRAGMA index_list(receipt_corrections)").all().map((row) => row.name);
    assert.ok(indexes.includes("receipt_corrections_ingestion_unique"));
    assert.ok(indexes.includes("receipt_corrections_receipt_revision_unique"));
  } finally {
    database.close();
  }
});
