import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  BATCH_SIZE, geminiProvider, ledgerReport, openLedger, planCatalog, prepareLedger,
  readCatalogSnapshot, recoverBatch, reviewCandidates, runBatch,
} from "../scripts/catalog-knowledge-backfill-lib.mjs";
import {
  PRODUCT_UNDERSTANDING_PROMPT_VERSION as prompt,
  PRODUCT_UNDERSTANDING_SCHEMA_VERSION as schema,
} from "../product-understanding-contract.ts";
import { searchCatalog } from "../app/catalog-search.ts";

const product = (i = 1, overrides = {}) => ({
  productId: `p${String(i).padStart(3, "0")}`, itemNumber: String(1000 + i),
  canonicalName: `Product ${i}`, brand: null, category: null,
  labels: [`LABEL ${i}`], aliases: [], activeProfile: null, ...overrides,
});
const snapshot = (products = [product()]) => ({ householdId: "owner", products });
const proposal = (key, overrides = {}) => ({
  lookupKey: key, canonicalName: "Bounty Paper Towels", brand: "Bounty",
  productFamily: "paper towels", variant: null, categoryHint: "household_supplies",
  confidenceBps: 9000, exactSkuKnown: false, searchAliases: ["Bounty"],
  intentAliases: ["paper towels"], ...overrides,
});
const provider = async ({ lines }) => ({ products: lines.map((l) => proposal(`item:${l.itemNumber}`)) });
const active = (overrides = {}) => ({
  lookup_key: "item:1001", canonical_name: "Bounty", brand: "Bounty", product_family: "paper towels",
  variant: null, category_hint: "household_supplies", confidence_bps: 9000, exact_sku_known: 0,
  search_aliases_json: '["Bounty"]', intent_aliases_json: '["paper towels"]', model: "test",
  prompt_version: prompt, schema_version: schema, ...overrides,
});
function ledger(t, products = [product()]) {
  const db = openLedger(":memory:");
  t.after(() => db.close());
  prepareLedger(db, snapshot(products), "test");
  return db;
}

test("coverage accounts for every product, distinguishes outdated, uncertain and broken profiles", () => {
  const jobs = planCatalog(snapshot([
    product(1), product(2, { activeProfile: active() }),
    product(3, { activeProfile: active({ confidence_bps: 6000 }) }),
    product(4, { activeProfile: active({ prompt_version: "old" }) }),
    product(5, { activeProfile: active({ search_aliases_json: "broken" }) }),
    product(6, { activeProfile: active({ intent_aliases_json: "[]" }) }),
  ]), "test");
  assert.deepEqual(jobs.map((j) => j.coverage.status), ["missing", "ready", "uncertain", "missing", "error", "uncertain"]);
  assert.equal(jobs[1].coverage.reason, "model_profile_unverified");
  assert.equal(jobs[3].coverage.reason, "stale_version");
});

test("fingerprints are stable, tenant/model/evidence scoped and reject duplicate identities", () => {
  const input = snapshot();
  const key = planCatalog(input, "test")[0].fingerprint;
  assert.equal(planCatalog({ ...input, capturedAt: "later" }, "test")[0].fingerprint, key);
  for (const variant of [
    { ...input, householdId: "other" }, snapshot([product(1, { aliases: ["new alias"] })]),
    snapshot([product(1, { labels: ["NEW LABEL"] })]),
  ]) assert.notEqual(planCatalog(variant, "test")[0].fingerprint, key);
  assert.notEqual(planCatalog(input, "new-model")[0].fingerprint, key);
  assert.throws(() => planCatalog(snapshot([product(), product()]), "test"), /duplicate/);
});

test("batch size is 20; durable restarts are idempotent and budget counts are cumulative", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-pi2-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, "ledger.sqlite");
  const input = snapshot(Array.from({ length: 23 }, (_, i) => product(i)));
  let db = openLedger(file);
  try {
    prepareLedger(db, input, "test");
    let size;
    const result = await runBatch(db, "owner", { requestLimit: 1, provider: async (args) => {
      size = args.lines.length;
      return provider(args);
    } });
    assert.equal(size, BATCH_SIZE);
    assert.equal(result.candidates.proposed, 20);
    assert.equal(result.candidates.pending, 3);
    db.close();
    db = openLedger(file);
    prepareLedger(db, input, "test");
    await assert.rejects(runBatch(db, "owner", { requestLimit: 1, provider }), /limit reached/);
    const finished = await runBatch(db, "owner", { requestLimit: 2, provider });
    assert.equal(finished.candidates.proposed, 23);
    const noCall = await runBatch(db, "owner", { requestLimit: 2, provider: () => assert.fail("unexpected request") });
    assert.equal(noCall.providerCallsReserved, 2);
  } finally { db.close(); }
});

test("changed evidence invalidates only affected jobs; old proposals remain for audit", async (t) => {
  const db = ledger(t, [product(1), product(2)]);
  await runBatch(db, "owner", { requestLimit: 1, provider });
  const next = prepareLedger(db, snapshot([product(1, { aliases: ["paper towel"] }), product(2)]), "test");
  assert.equal(next.candidates.pending, 1);
  assert.equal(next.candidates.proposed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pi2_jobs WHERE current = 0 AND proposal_json IS NOT NULL").get().n, 1);
  const removed = prepareLedger(db, snapshot([product(2)]), "test");
  assert.equal(removed.products, 1);
  assert.equal(removed.candidates.proposed, 1);
});

test("a targeted pilot only sends selected current products and rejects unknown IDs before spending", async (t) => {
  const db = ledger(t, [product(1), product(2), product(3)]);
  await assert.rejects(runBatch(db, "owner", { requestLimit: 1, productIds: ["foreign-id"], provider }), /not current/);
  assert.equal(ledgerReport(db, "owner").providerCallsReserved, 0);
  const report = await runBatch(db, "owner", { requestLimit: 1, productIds: [product(2).productId], provider: async ({ lines }) => {
    assert.deepEqual(lines, [{ itemNumber: "1002", rawDescription: "LABEL 2" }]);
    return provider({ lines });
  } });
  assert.equal(report.candidates.proposed, 1);
  assert.equal(report.candidates.pending, 2);
});

test("scope mismatch never changes a prepared ledger", (t) => {
  const db = ledger(t);
  const before = ledgerReport(db, "owner");
  assert.throws(() => prepareLedger(db, { ...snapshot(), householdId: "sandbox" }, "test"), /mismatch/);
  assert.throws(() => prepareLedger(db, snapshot(), "different-model"), /mismatch/);
  assert.throws(() => reviewCandidates(db, "sandbox"), /mismatch/);
  assert.deepEqual(ledgerReport(db, "owner"), before);
});

test("a prompt/schema contract change prevents an old ledger from generating stale proposals", async (t) => {
  const db = ledger(t);
  db.prepare("UPDATE pi2_meta SET version = 'obsolete-contract'").run();
  await assert.rejects(runBatch(db, "owner", { requestLimit: 1, provider }), /version mismatch/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pi2_calls").get().n, 0);
});

test("CLI run defaults to dry-run and refuses artifacts outside the ignored private directory", (t) => {
  const base = path.resolve("tmp/catalog-knowledge");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "cli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, "ledger.sqlite");
  const db = openLedger(file);
  prepareLedger(db, snapshot(), "test");
  db.close();
  const invoke = (...args) => spawnSync(process.execPath, ["--import", "tsx", "scripts/catalog-knowledge-backfill.mjs", ...args], {
    encoding: "utf8", env: { ...process.env, GEMINI_API_KEY: "must-not-use-this" },
  });
  const dry = invoke("run", "--household", "owner", "--ledger", file);
  assert.equal(dry.status, 0, dry.stderr);
  const report = JSON.parse(dry.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.providerCallsReserved, 0);
  const invalid = invoke("run", "--household", "owner", "--ledger", "outside.sqlite");
  assert.equal(invalid.status, 1);
  assert.equal(fs.existsSync("outside.sqlite"), false);
  assert.doesNotMatch(dry.stdout + invalid.stderr, /must-not-use-this/);
});

test("partial response is resumable; uncertain and ungrounded results are not automatically retried", async (t) => {
  const db = ledger(t, [product(1), product(2), product(3, { itemNumber: null })]);
  const result = await runBatch(db, "owner", { requestLimit: 2, provider: async () => ({ products: [
    proposal("item:1001", { confidenceBps: 7000 }), proposal("raw:LABEL 3"),
  ] }) });
  assert.equal(result.candidates.uncertain, 2);
  assert.equal(result.candidates.error, 1);
  await runBatch(db, "owner", { requestLimit: 2, provider: () => assert.fail("must not auto-retry") });
  const done = await runBatch(db, "owner", { requestLimit: 2, retryErrors: true, provider });
  assert.equal(done.candidates.proposed, 1);
  assert.equal(done.candidates.uncertain, 2);
});

test("provider errors are redacted, reservations are not refunded, retries need an explicit limit", async (t) => {
  const db = ledger(t);
  await runBatch(db, "owner", { requestLimit: 1, provider: () => { throw new Error("secret-key receipt contents"); } });
  const review = JSON.stringify(reviewCandidates(db, "owner"));
  assert.doesNotMatch(review, /secret-key|receipt contents/);
  assert.match(review, /provider_or_validation_failure/);
  await assert.rejects(runBatch(db, "owner", { requestLimit: 1, retryErrors: true, provider }), /limit/);
  assert.equal((await runBatch(db, "owner", { requestLimit: 2, retryErrors: true, provider })).candidates.proposed, 1);
});

test("unknown/duplicate/invalid provider IDs fail closed without proposed profiles", async (t) => {
  for (const products of [
    [proposal("foreign")], [proposal("item:1001"), proposal("item:1001")],
    [proposal("item:1001", { searchAliases: ["a".repeat(101)] })],
  ]) {
    const db = ledger(t);
    const result = await runBatch(db, "owner", { requestLimit: 1, provider: async () => ({ products }) });
    assert.equal(result.candidates.error, 1);
    assert.equal(result.candidates.proposed, 0);
  }
});

test("concurrent/abandoned batches require explicit recovery and late results cannot overwrite", async (t) => {
  const db = ledger(t);
  let finish;
  const pending = runBatch(db, "owner", { requestLimit: 3, provider: () => new Promise((resolve) => { finish = resolve; }) });
  await assert.rejects(runBatch(db, "owner", { requestLimit: 3, provider }), /already running/);
  assert.throws(() => prepareLedger(db, snapshot(), "test"), /running/);
  assert.equal(recoverBatch(db, "owner").candidates.error, 1);
  await runBatch(db, "owner", { requestLimit: 3, retryErrors: true, provider });
  finish({ products: [proposal("item:1001", { canonicalName: "Late wrong value" })] });
  await assert.rejects(pending, /late result/);
  assert.equal(reviewCandidates(db, "owner").products[0].proposal.canonicalName, "Bounty Paper Towels");
});

test("local source is read-only, household isolated, and household databases cannot be used as ledgers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-pi2-source-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, "source.sqlite");
  const writer = new DatabaseSync(file);
  writer.exec(`CREATE TABLE households(id TEXT); INSERT INTO households VALUES ('owner'), ('sandbox');
    CREATE TABLE products(id TEXT, household_id TEXT, active INTEGER, costco_item_number TEXT, canonical_name TEXT, brand TEXT, category TEXT);
    INSERT INTO products VALUES ('p1','owner',1,'1001','Bounty',NULL,NULL), ('p2','sandbox',1,'1001','Private other',NULL,NULL);
    CREATE TABLE receipt_transactions(id TEXT, household_id TEXT, purchased_at TEXT);
    INSERT INTO receipt_transactions VALUES ('r1','owner','2026-09-01'), ('r2','sandbox','2026-09-02');
    CREATE TABLE receipt_items(id TEXT, product_id TEXT, receipt_transaction_id TEXT, raw_description TEXT, source_line_number INTEGER);
    INSERT INTO receipt_items VALUES ('i1','p1','r1','BNTY',1), ('i2','p2','r2','OTHER LABEL',1), ('i3','p1','r2','CROSS TENANT',2);
    CREATE TABLE product_aliases(product_id TEXT, household_id TEXT, raw_description TEXT, alias_key TEXT,
      id TEXT, confirmation_source TEXT, confirmed_by_member_id TEXT, updated_at TEXT);
    INSERT INTO product_aliases VALUES ('p1','owner','paper towel','a','a','receipt','m','2026-09-13'),
      ('p1','sandbox','FOREIGN ALIAS','b','b','member','other','2026-09-13');
    CREATE TABLE product_understandings(id TEXT, household_id TEXT, lookup_key TEXT, updated_at TEXT);
    CREATE TABLE intent_fulfillments(id TEXT, household_id TEXT, costco_item_number TEXT,
      receipt_key TEXT, raw_intent_label TEXT, relation TEXT, confirmed_by_member_id TEXT, updated_at TEXT);
    INSERT INTO intent_fulfillments VALUES ('f','owner','1001','item:1001','kitchen towels','substitute','m','2026-09-13');
    CREATE TABLE trips(id TEXT, amount INTEGER); INSERT INTO trips VALUES ('unchanged',1234);`);
  writer.close();
  const before = fs.readFileSync(file);
  const source = new DatabaseSync(file, { readOnly: true });
  const input = readCatalogSnapshot(source, "owner");
  assert.equal(input.products.length, 1);
  assert.deepEqual(input.products[0].labels, ["BNTY"]);
  assert.deepEqual(input.products[0].aliases, ["paper towel"]);
  assert.deepEqual(input.products[0].confirmedEvidence.facts.map(f => f.relation).sort(), ["same_product", "substitute"]);
  assert.equal(JSON.stringify(input.products[0].confirmedEvidence).includes("FOREIGN"), false);
  assert.throws(() => readCatalogSnapshot(source, "missing"), /not found/);
  source.close();
  assert.throws(() => openLedger(file), /separate/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("review candidate aliases improve the named search examples without changing product identities", async (t) => {
  // Explicitly synthetic provider outputs: integration coverage, not model accuracy.
  const names = [
    ["KS BATH TISSUE", "Kirkland Toilet Tissue", "toilet paper", "toilet tissue"],
    ["BNTY", "Bounty Paper Towels", "Bounty", "paper towels"],
    ["BATH TWL", "Cotton Bath Towels", "bath towel", "bath towels"],
    ["MANDARINS", "Mandarin Oranges", "mandarins", "oranges"],
  ];
  const original = names.map(([raw], i) => product(i, { canonicalName: raw, labels: [raw] }));
  const unchanged = JSON.stringify(original);
  const db = ledger(t, original);
  await runBatch(db, "owner", { requestLimit: 1, provider: async () => ({ products:
    names.map(([, name, alias, intent], i) => proposal(`item:${1000 + i}`, {
      canonicalName: name, searchAliases: [alias], intentAliases: [intent],
    })),
  }) });
  const rows = reviewCandidates(db, "owner").products.map((p) => ({
    id: p.productId, canonicalName: p.evidence.canonicalName, costcoItemNumber: p.evidence.itemNumber,
    latestRawDescription: p.evidence.labels[0], searchTerms: [p.proposal.canonicalName, ...p.proposal.searchAliases, ...p.proposal.intentAliases],
  }));
  assert.equal(searchCatalog(rows, "toilet paper")[0].id, original[0].productId);
  assert.equal(searchCatalog(rows, "Bounty")[0].id, original[1].productId);
  assert.equal(searchCatalog(rows, "bath towel")[0].id, original[2].productId);
  assert.equal(searchCatalog(rows, "oranges")[0].id, original[3].productId);
  for (const noMatch of ["orange juice", "orange candy", "navel oranges"]) assert.equal(searchCatalog(rows, noMatch).length, 0);
  assert.equal(JSON.stringify(original), unchanged);
  assert.match(reviewCandidates(db, "owner").activation, /none/);
});

test("Gemini adapter sends only bounded labels/SKUs, ignores thoughts, rejects incomplete/oversized output", async () => {
  const args = { apiKey: "test-secret", model: "test-model", lines: [{ itemNumber: "1001", rawDescription: "BNTY" }] };
  const good = { candidates: [{ finishReason: "STOP", content: { parts: [
    { thought: true, text: "not JSON" }, { text: JSON.stringify({ products: [proposal("item:1001")] }) },
  ] } }] };
  const result = await geminiProvider({ ...args, fetchImpl: async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.match(url, /generativelanguage.googleapis.com/);
    assert.equal(body.generationConfig.maxOutputTokens, 8192);
    assert.doesNotMatch(opts.body, /householdId|productId|totalCents|receiptImage|test-secret/);
    assert.match(opts.body, /untrusted data/);
    return Response.json(good);
  } });
  assert.equal(result.products.length, 1);
  await assert.rejects(geminiProvider({ ...args, fetchImpl: async () => Response.json({ candidates: [{ ...good.candidates[0], finishReason: "MAX_TOKENS" }] }) }), /Incomplete/);
  await assert.rejects(geminiProvider({ ...args, fetchImpl: async () => new Response("x".repeat(256001)) }), /too large/);
  await assert.rejects(geminiProvider({ ...args, lines: Array(21).fill(args.lines[0]) }), /Invalid/);
});
