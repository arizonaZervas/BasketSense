# BasketSense architecture decisions

This directory will hold short architecture decision records (ADRs) for choices
that materially affect privacy, migration risk, or the ability to serve more
than one household.

No decision record authorizes implementation by itself. The related backlog
item must be Ready and selected as the single active major item.

## Planned decisions

| Decision | Required before | Current constraint |
| --- | --- | --- |
| Hosting ownership and managed-auth provider | BS-004/BS-005 | Preserve the family deployment; do not build password authentication. |
| Shared-D1 tenant-isolation contract | BS-005 | One shared D1, server-resolved household context, no trusted client household ID. |
| Receipt extraction and third-party data handling | BS-008 | No Costco credentials; disclose and minimize any third-party processing. |
| Receipt-image retention policy | BS-009 | Owners need explicit retention and deletion controls. |

## ADR template

Each decision record must include:

- Status: proposed, accepted, superseded, or rejected.
- Context and the user risk being addressed.
- Decision and alternatives considered.
- Privacy, security, cost, and migration consequences.
- Reversal strategy.
- Evidence or experiment required before acceptance.

