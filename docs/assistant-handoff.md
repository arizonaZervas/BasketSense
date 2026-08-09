# BasketSense assistant handoff

Use this file as the short, durable starting context for a new Codex chat after
older chats are archived. Read it with the root `README.md`, `PRODUCT.md`, and
the current Git status; verify any live deployment or Cloudflare fact before
changing it.

## Current product state

- BasketSense is a private, two-person Costco companion: shared list, frozen
  intent, private receipt review, explainable comparison, lightweight feedback,
  product history, and in-app recap.
- Receipt images and PDFs are private R2 objects. Household data is in the
  BasketSense D1 database. Do not expose, migrate, or reuse either outside this
  product.
- A receipt’s paid amount is its net amount after Costco discounts. UI that
  presents that number uses the label `Paid`.
- Generated product illustrations are the default visual treatment. A household
  photo upload is the only supported override; external photo suggestions are
  intentionally disabled.
- Matching starts with strong textual evidence. A household can confirm a
  receipt-line-to-list-item relationship once; that creates a reusable alias
  for future receipts without broad semantic guessing.
- Completed shared trips and receipts are immutable so historical totals and
  recaps stay trustworthy.

## Owner test sandbox

- `/?sandbox=1` is an owner-only, isolated, disposable household for receipt
  and finalized-trip tests.
- It has no shared household history. Its review-question requests must carry
  `sandbox: true` so the API does not look in the shared household.
- A completed sandbox receipt can be reopened for another test cycle. This is
  intentionally unavailable in the real shared household.

## Recaps, e-mail, and the receipt Worker

- The supported recap path is inside the private app at `/recap`; automatic
  recap e-mail is disabled.
- Do not configure `EMAIL_FROM`, `allowed_sender_addresses`, or real sends
  unless a BasketSense-specific approved sender is verified and the owner
  authorizes it.
- `workers/receipt-ingestion/` contains BasketSense’s asynchronous extraction
  Worker. It is separate from the app source and must never be configured with
  Good Cart Day resources.

## Current site and access boundary

- The private site project is identified by `.openai/hosting.json`. Use Sites
  tooling to inspect its live URL, version, and access policy; do not create a
  replacement site, D1 database, or R2 bucket.
- Preserve the existing custom access allowlist: owner and household viewer,
  with no access groups. Verify identities live before modifying or deploying.
- The latest known production source commit is `612947fd0114d4f84541ff0bc13f02a72b356b8e`
  (product image preview, purchase-rank illustrations 176–200, and mobile
  preview polish), deployed as Sites version 59. Treat that value as a handoff
  hint, not live proof.

## Hard scope boundaries

- `good-cart-day/` is a separate product. Never modify, stage, commit, deploy,
  or use its files/resources while working on BasketSense unless the owner
  explicitly changes scope.
- The `origin` GitHub remote is public. Do not push it unless the owner first
  approves the exact remote identity and privacy.
- Use the existing private Sites artifact repository only for approved
  BasketSense deployments.

## Useful verification

```bash
npm run build
node --import tsx --test tests/household-api.test.mjs tests/receipt-logic.test.mjs tests/dashboard-data.test.mjs tests/rendered-html.test.mjs
git status --short
```

For code discovery, prefer the `codebase-memory-mcp` graph. For a deploy,
confirm the existing private site and its allowlist, push the exact committed
source to its existing artifact repository, save that exact build as a version,
then poll the deployment to success.

## Keep this handoff current

Update this document after a material deployment, access-policy change,
integration decision, or durable product behavior change. Do not add secrets,
receipt data, access tokens, personal e-mail addresses, or private URLs.
