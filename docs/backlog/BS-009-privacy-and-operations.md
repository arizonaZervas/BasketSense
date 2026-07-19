# BS-009 — Privacy and operational readiness

**Status:** Blocked by BS-005  
**Priority:** 9  
**Decision gate:** Gate B

## Outcome

BasketSense can explain, export, retain, delete, recover, and safely operate one
household's data before taking responsibility for a friend's private receipts.

## Rationale

Encryption and tenant checks are necessary but insufficient. External users
also need control over retention and deletion, while the operator needs enough
redacted visibility to detect failures and recover from them.

## Dependencies

- BS-005 identity and tenant isolation.
- BS-008 defines stored originals, imports, and parser provenance.
- The decisions directory records the accepted receipt-image retention policy.

## Smallest test

Using a synthetic household, export all household data, delete it through the
supported lifecycle, verify D1 and R2 cleanup, restore a separate
production-shaped backup, and confirm no other household changed.

## Intended scope

- Versioned household JSON/CSV export.
- Household deletion and member-access revocation.
- Explicit original-receipt retention and deletion controls.
- Cleanup for replaced, failed, expired, and orphaned R2 objects.
- Invite and upload rate limits.
- Redacted structured logs and actionable error categories.
- Minimal audit events for invite, accept, remove, export, delete request, and
  failed authorization—never raw receipt text.
- Backup, Time Travel/export, restore, and recovery runbooks.
- Operational counts for failed imports, unreconciled receipts, open review,
  storage, and query health.

## Acceptance criteria

- Export contains exactly one household and documented schema/version metadata.
- Spreadsheet exports neutralize formula injection.
- Deletion removes or anonymizes every in-scope D1 record and private object
  according to the accepted policy.
- Removing a member immediately revokes access without corrupting historical
  trip attribution.
- R2 replacement and deletion leave no retrievable orphan.
- Backup and restore are rehearsed against a production-shaped environment.
- Logs contain identifiers sufficient for support but no receipt bodies,
  invitation tokens, credentials, or unnecessary member data.
- Rate limits fail clearly without losing successfully accepted work.

## Privacy risks

Exports and backups create additional sensitive copies. They require access
control, limited retention, secure delivery, clear ownership, and a documented
cleanup path. Operational logs must not become a shadow receipt database.

## Explicit non-goals

- Enterprise compliance certification.
- Indefinite storage by default without a household choice.
- Support access that bypasses household authorization.

## Evidence after completion

Pending. Attach export-isolation tests, deletion and orphan-cleanup evidence,
rate-limit tests, log review, and the successful restore drill.

