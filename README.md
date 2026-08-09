# BasketSense

BasketSense is a private, household-first Costco companion for two people who
plan, shop, and learn together. It helps a household arrive with a useful
Saturday list, preserve room for good discoveries, and turn receipts into
trustworthy spending and product insights—without turning a family ritual into
a guilt-heavy budgeting exercise.

## What it does today

- Maintains one private, mobile-friendly Saturday list for the household. Both
  members can plan together; the list refreshes while visible so warehouse
  changes reach the other phone quickly.
- Suggests recurring essentials and “check first” items using conservative,
  explainable purchase-cadence rules. Suggestions are optional—not purchases
  BasketSense assumes the household needs.
- Lets either member add, estimate, remove, check off, freeze for shopping, and
  return to planning before receipt evidence is attached.
- Captures a frozen pre-trip intent snapshot so planned-versus-actual language
  has evidence behind it, then finalizes the trip only after the receipt is
  reviewed.
- Uploads private receipt photos and Costco PDFs, supports Gemini-assisted OCR
  when configured, accepts manual correction, checks receipt arithmetic, and
  preserves raw Costco receipt wording.
- Matches receipt lines to the frozen list with strong text rules, conservative
  suggestions, and household-confirmed aliases. A confirmation teaches the
  household’s own wording for future receipts rather than guessing silently.
- Records item totals using the amount actually paid after Costco discounts;
  receipt, recap, and flash-card UI labels that amount as “Paid”.
- Creates at most three evidence-triggered review questions after a trip and
  turns confirmed answers into reusable household context.
- Offers interactive product, transaction, category, and receipt drill-downs.
  Owner-authorized data inspection and export remain available as dormant
  backend tools for future debugging rather than a customer-facing tab.
- Provides an in-app recap at `/recap` plus the Recap destination in the
  private dashboard. Automatic outgoing recap e-mail is intentionally disabled.
- Provides an owner-only disposable test sandbox at `/?sandbox=1`. Sandbox
  receipts, lists, recaps, and review answers stay separate from shared
  household history. Finalized sandbox tests can be reopened for retesting;
  shared-history receipts remain immutable.
- Offers accessible light, dark, and system theme modes, including an optional
  reduced-motion completion state and a full-page completion confetti burst.

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
- Completed shared trips and their receipts are immutable. That protects
  historical totals and recap facts. The owner-only sandbox is the deliberate
  exception for repeatable testing.
- Receipt images live in private R2 object storage. Searchable metadata and
  normalized line items live in D1.
- Draft or rejected receipts never silently alter “actual” spending metrics.
- The private app is separate from Good Cart Day. Never reuse or expose this
  household’s D1, R2, credentials, or access policy there.

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

### Receipt reader configuration

BasketSense stores uploaded receipt photos and Costco PDFs in its private R2
bucket first. When the hosted Sites environment has a `GEMINI_API_KEY` secret,
the same private application reads the saved document with Gemini and stores an
advisory, reviewable draft. `GEMINI_MODEL` is optional and defaults to
`gemini-3.5-flash-lite`.

Receipt totals and line items do not become household actuals until a household
member confirms the draft. Without the Gemini secret, the upload still succeeds
and the manual totals flow remains available.

### Recaps and asynchronous ingestion

The private app serves recaps directly at `/recap`; this is the currently
supported recap delivery path. Do not enable automatic e-mail recaps unless a
BasketSense-specific, approved Cloudflare Email Sending sender exists and the
owner explicitly authorizes the Worker configuration.

`workers/receipt-ingestion/` contains the separate asynchronous receipt
extraction Worker and its workflow definition. Keep its configuration scoped to
BasketSense; it must never use Good Cart Day resources or sender identities.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run build
node --import tsx --test tests/household-api.test.mjs tests/receipt-logic.test.mjs tests/dashboard-data.test.mjs tests/rendered-html.test.mjs
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
- [Assistant handoff](docs/assistant-handoff.md) — current deployment and
  scope context for the next Codex chat. Update it when a material deployment,
  integration, or product decision changes.

## Privacy

BasketSense is intentionally private. Do not commit receipt images, local D1
files, Cloudflare/Miniflare state, environment files, authentication headers,
or household data. The app does not store Costco credentials or automate Costco
sign-in.

## Project status

This is a working private household product, not a generic public shopping app.
The current focus is keeping the shared list and receipt learning loop reliable
and reviewable. Future recommendation work must score the eligible catalog
conservatively, preserve explicit household controls, and be offline-tested
before it changes the live list.
