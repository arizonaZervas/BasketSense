# BS-008 — Batch receipt ingestion

**Status:** Blocked by BS-005  
**Priority:** 8  
**Decision gate:** Gate B

## Outcome

An invited household can upload multiple Costco receipt PDFs or photos and turn
them into reconciled, reviewable history without duplicate spending or a long
manual transcription session.

## Rationale

Historical setup is the largest likely adoption bottleneck. The beta needs a
low-friction import path, but automation must not sacrifice arithmetic accuracy,
privacy, or transparent human correction.

## Dependencies

- BS-005 tenant isolation and private R2 authorization.
- A receipt-processing ADR defines extraction provider, data handling, cost,
  retention, and fallback behavior.
- Exact metrics continue to exclude unreconciled drafts.

## Smallest test

Concierge-onboard one trusted household using 6–10 recent receipts. Process the
batch through the intended states, measure correction time and failure modes,
and avoid generalizing the pipeline until the observed errors are understood.

## Pipeline states

- Uploaded.
- Processing.
- Needs review.
- Reconciled.
- Duplicate.
- Failed with a safe retry path.

## Processing contract

1. Store the private original under a household-prefixed R2 key.
2. Compute a content hash and enforce idempotency.
3. Extract transaction identity, date, totals, tax, discounts, quantities, and
   line items while retaining raw descriptions.
4. Reconcile line and receipt arithmetic before exact metrics change.
5. Match item numbers to an application product catalog and household aliases.
6. Ask only about arithmetic failures or meaningful ambiguity.
7. Permit partial batch success, correction, and safe retry.

## Acceptance criteria

- PDFs and supported image formats have clear size and type validation.
- Re-uploading or retrying the same source cannot create duplicate spending.
- One failed file does not discard successful files in the batch.
- Every derived value retains source and parser-version provenance.
- Unreconciled receipts remain outside exact dashboard totals.
- Review focuses on ambiguous lines and arithmetic, not every recognized item.
- Original files are never public and follow the retention controls from
  BS-009.
- Correction time and reconciliation rate are measured during concierge use.

## Privacy risks

Receipts reveal spending and household habits. Minimize third-party processing,
disclose it before upload, avoid receipt contents in logs, keep originals
private, and never store Costco credentials or automate login.

## Explicit non-goals

- Costco login automation.
- Unsupported scraping, browser extensions, or email forwarding.
- Fully automatic acceptance of uncertain receipt arithmetic.

## Evidence after completion

Pending. Retain the batch success matrix, duplicate/idempotency tests,
reconciliation accuracy, correction minutes, provider/privacy review, and known
unsupported formats.

