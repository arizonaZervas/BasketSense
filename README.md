# BasketSense

BasketSense is a private, household-first Costco companion for two people who
plan, shop, and learn together. It helps a household arrive with a useful
Saturday list, preserve room for good discoveries, and turn receipts into
trustworthy spending and product insights—without turning a family ritual into
a guilt-heavy budgeting exercise.

## What it does today

- Maintains one shared mobile-friendly Saturday list for two household members.
- Suggests recurring essentials and “check first” items using explainable
  purchase-cadence rules.
- Lets either spouse add, remove, check off, freeze, and undo a shopping plan.
- Captures a frozen pre-trip snapshot so planned-versus-actual claims have
  evidence behind them.
- Uploads private receipt photos, supports OCR/manual correction, reconciles
  arithmetic, and preserves raw Costco receipt descriptions.
- Matches purchased receipt lines against frozen intent with deterministic,
  reviewable rules.
- Creates at most three evidence-triggered review questions after a trip.
- Supports interactive product, transaction, category, and receipt drill-downs.
- Offers accessible light, dark, and system theme modes.

## The product loop

```text
Purchase history → proposed list → shared edits → frozen intent
→ receipt reconciliation → planned-versus-actual comparison
→ lightweight feedback → a better next list
```

Receipt history can suggest a replenishment window. It cannot prove an item was
impulsive, wasteful, or a good deal. BasketSense records those outcomes only
when the household supplies explicit feedback.

## Data and correctness

The interactive dashboard reads reconciled household data from Cloudflare D1.
The audited January–July 2026 dataset remains a test oracle while this data path
evolves: automated tests assert that the D1-derived dashboard exactly matches
the audited dashboard before the UI uses it.

Important conventions:

- Money is stored as integer cents.
- Quantity is stored in thousandths, so fractional fuel quantities remain exact.
- A `trip` is the planning event; a `receipt_transaction` is a financial event.
- The live list is mutable; a frozen intent snapshot is immutable evidence.
- Receipt images live in private R2 object storage. Searchable metadata and
  normalized line items live in D1.
- Draft or rejected receipts never silently alter “actual” spending metrics.

## Architecture

```text
React / Next App Router client
        ↓
Authenticated household API
        ↓
Cloudflare D1 (shared list, products, trips, receipts, feedback)
        ↓
Cloudflare R2 (private receipt images)
```

The app uses vinext, React, TypeScript, Cloudflare Worker bindings, D1/SQLite,
R2, and Drizzle schema/migration tooling.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run lint
npm run db:generate
```

The local development runtime persists D1 and R2 emulator state under
`.wrangler/`. That state is intentionally ignored by Git.

## Learn the codebase

- [Full-stack learning guide](docs/full-stack-learning-guide.md) — architecture,
  frontend, API, receipt flow, all database tables, SQL exploration, testing,
  deployment, and technical debt.
- [Data model](docs/data-model.md) — why trips, receipts, list items, intent,
  and feedback are separate records.
- [Product backlog](docs/product-backlog.md) — the D1 dashboard migration,
  recommendation-engine direction, and data-ownership work.
- [Product principles](PRODUCT.md) — the household-first product contract.

## Privacy

BasketSense is intentionally private. Do not commit receipt images, local D1
files, Cloudflare/Miniflare state, environment files, authentication headers,
or household data. The app does not store Costco credentials or automate Costco
sign-in.

## Project status

This is a working private household product, not a generic public shopping app.
The next major product direction is a recommendation engine that scores the
whole eligible product catalog conservatively, with explicit household controls
and offline backtesting before it changes the live list.
