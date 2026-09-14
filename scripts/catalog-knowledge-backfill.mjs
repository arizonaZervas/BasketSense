#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  CatalogBackfillError, geminiProvider, ledgerReport, openLedger, planCatalog, prepareLedger,
  readCatalogSnapshot, recoverBatch, reviewCandidates, runBatch,
} from "./catalog-knowledge-backfill-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = path.join(root, "tmp", "catalog-knowledge");

function privateFile(value) {
  if (!value) throw new CatalogBackfillError("A ledger/output path under tmp/catalog-knowledge is required");
  const result = path.resolve(value);
  if (!result.startsWith(privateRoot + path.sep)) throw new CatalogBackfillError("Private artifacts must stay under tmp/catalog-knowledge");
  // Check ancestors before creating directories; do not follow a symlink outside.
  let ancestor = result;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw new CatalogBackfillError("Symlinked artifact paths are not supported");
  fs.mkdirSync(path.dirname(result), { recursive: true, mode: 0o700 });
  return result;
}

function snapshotFromSource(source, household) {
  if (!source) throw new CatalogBackfillError("--source-db is required (local SQLite snapshot only)");
  const actual = fs.realpathSync(source);
  if (actual.split(path.sep).includes("good-cart-day")) throw new CatalogBackfillError("Good Cart Day is out of scope");
  const db = new DatabaseSync(actual, { readOnly: true });
  try { return readCatalogSnapshot(db, household); } finally { db.close(); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "source-db": { type: "string" }, household: { type: "string" }, ledger: { type: "string" },
    model: { type: "string" }, output: { type: "string" }, execute: { type: "boolean" },
    "request-limit": { type: "string" }, "retry-errors": { type: "boolean" },
    "product-ids": { type: "string" },
    "confirm-interrupted": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log(`PI-2 catalog coverage/backfill (local review candidates only)
Commands: coverage, prepare, report, run, recover, review
coverage/prepare: --source-db LOCAL_SQLITE --household ID [--model MODEL]
prepare/report/run/recover/review: --ledger tmp/catalog-knowledge/RUN.sqlite --household ID
run: dry-run by default; --execute --request-limit N explicitly allows ONE batch
     of up to 20 products, with N cumulative calls across restarts. GEMINI_API_KEY
     is read only from the environment. Verify provider pricing/budget first.
     --retry-errors permits retrying failures; no automatic retries occur.
     --product-ids ID1,ID2 selects a bounded pilot from the prepared ledger.
recover: --confirm-interrupted (only after stopping the previous process)
review: --output tmp/catalog-knowledge/REVIEW.json (private; refuses overwrite)
No command can activate profiles, modify the source database, or deploy.`);
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !["coverage", "prepare", "report", "run", "recover", "review"].includes(command)) {
    throw new CatalogBackfillError("Choose a command; use --help");
  }
  if (!values.household?.trim()) throw new CatalogBackfillError("--household is required");
  if (command === "coverage") {
    const jobs = planCatalog(snapshotFromSource(values["source-db"], values.household), "coverage-only");
    const counts = { ready: 0, uncertain: 0, missing: 0, error: 0 };
    for (const job of jobs) counts[job.coverage.status] += 1;
    console.log(JSON.stringify({ products: jobs.length, activeCoverage: counts, providerCalls: 0 }));
    return;
  }
  const ledgerPath = privateFile(values.ledger);
  if (command !== "prepare" && !fs.existsSync(ledgerPath)) throw new CatalogBackfillError("Prepare the ledger first");
  if (values["source-db"] && fs.realpathSync(values["source-db"]) === ledgerPath) {
    throw new CatalogBackfillError("Source and ledger must be different files");
  }
  const db = openLedger(ledgerPath);
  fs.chmodSync(ledgerPath, 0o600);
  try {
    let report;
    if (command === "prepare") {
      report = prepareLedger(db, snapshotFromSource(values["source-db"], values.household), values.model);
    } else if (command === "run" && values.execute) {
      if (!process.env.GEMINI_API_KEY) throw new CatalogBackfillError("GEMINI_API_KEY is missing");
      report = await runBatch(db, values.household, {
        requestLimit: Number(values["request-limit"]), retryErrors: values["retry-errors"] ?? false,
        productIds: values["product-ids"]?.split(",") ?? null,
        provider: (input) => geminiProvider({ ...input, apiKey: process.env.GEMINI_API_KEY }),
      });
    } else if (command === "recover") {
      if (!values["confirm-interrupted"]) throw new CatalogBackfillError("Stop the old process, then pass --confirm-interrupted");
      report = recoverBatch(db, values.household);
    } else if (command === "review") {
      const output = privateFile(values.output);
      fs.writeFileSync(output, JSON.stringify(reviewCandidates(db, values.household), null, 2), { flag: "wx", mode: 0o600 });
      report = { reviewWritten: true, ...ledgerReport(db, values.household) };
    } else {
      report = { ...ledgerReport(db, values.household), ...(command === "run" ? { dryRun: true } : {}) };
    }
    console.log(JSON.stringify(report));
  } finally { db.close(); }
}

main().catch((error) => {
  // Avoid echoing paths, source SQL values, provider bodies or environment keys.
  const detail = error instanceof CatalogBackfillError ? error.message : "Check command options and local schema; use --help.";
  console.error(`Catalog operation failed: ${detail} No source writes or activation were performed.`);
  process.exitCode = 1;
});
