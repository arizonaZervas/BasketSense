# Feature graveyard

Record what we stop doing and why. Retiring a UI must not erase household data
or remove valuable underlying capabilities accidentally.

## Saturday Prep / Review picks

- Decision recorded: 2026-09-12.
- Status: retired in source on 2026-09-12; included in the approved search release.
- Purpose: a guided pre-shopping pass through likely-due/check-at-home ideas.
- Household feedback: not sufficiently useful; appears again after being used.
- Source finding: completion is device-local, Close returns to idle, and only
  Finish Prep persists complete. This provides repeat paths but is not a live
  reproduction of the owner's exact session.
- Removed: banner, guided steps, completion notice and exclusive component/styles.
  Regression coverage now verifies retirement and preservation of inline Ideas.
- Keep: inline Ideas and Add, shared List, recommendation engine, Product Memory,
  post-trip questions, durable intent corrections and Skip week.
- Data handling: do not delete feedback, products, list items or receipt history.
  Obsolete localStorage keys can remain inert; no database migration is needed.
- Return only if: household usage demonstrates that inline suggestions cannot
  serve a concrete need, and a prototype reduces effort without repeated prompts.
- Lesson: an additional review flow must save more decisions than it introduces.

See [product-intelligence roadmap](product-intelligence-roadmap.md).
