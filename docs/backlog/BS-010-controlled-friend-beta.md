# BS-010 — Controlled friend beta

**Status:** Blocked by Gate B  
**Priority:** 10  
**Decision gate:** Gate C

## Outcome

BasketSense proves that a household outside the founding family can understand,
trust, and repeat the complete weekly loop with sustainable support.

## Rationale

Automated tests cannot prove that onboarding is understandable, receipt review
is tolerable, recommendations are useful, or the ritual remains enjoyable.
Expansion must be staged so one failure does not affect many households.

## Dependencies

- Gate B is explicitly recorded as passed.
- BS-007 onboarding, BS-008 ingestion, and BS-009 privacy/operations are
  validated with synthetic and concierge evidence.
- No public access or acquisition campaign is active.

## Smallest test

Invite one trusted household. Observe—but do not silently perform—their first
household creation, partner invitation, initial list, optional history import,
shopping trip, receipt reconciliation, review, and following-week return.

## Rollout stages

1. One household completes one weekly loop.
2. The same household chooses whether to return the next week.
3. Expand to five households only after Gate C passes.
4. Expand to ten only after reviewing support burden and any privacy or
   correctness incidents from the first five.

## Evidence to collect

- Time to first useful list and history-import choice.
- Partner-invitation completion.
- Planning and correction minutes.
- Recommendation acceptance, removal, and explanation comprehension.
- Data-quality and categorization corrections.
- Support questions and operator time.
- Whether both members return for another cycle.
- Whether Costco planning and shopping felt better, unchanged, or worse.

## Acceptance criteria

- One outside household independently completes the entire closed loop.
- The household chooses to use BasketSense again the following week.
- Support and correction effort is sustainable for the operator.
- No tenant-isolation, privacy, data-loss, or double-counting incident occurs.
- Feedback changes the backlog rather than being silently converted into
  unprioritized feature work.
- Expansion decisions are recorded at each stage.

## Privacy risks

Friendship can blur consent and support boundaries. Explain what is stored, who
can see it, whether extraction uses a third party, how to export/delete, and how
to report a problem before accepting any receipt.

## Explicit non-goals

- Public signup.
- Marketing or hundreds of active households.
- Automating concierge work before its failure patterns are understood.

## Evidence after completion

Pending. Record the Gate C decision, pilot journey, repeat-use outcome, support
minutes, incidents, and explicit expansion decision.

