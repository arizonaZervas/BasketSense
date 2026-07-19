# BasketSense data model

## Why a database is necessary

Yes: a database is the right foundation for the shared household experience. The reason is not the dashboard itself; it is the **one mutable Saturday list** that two people must read and edit from different phones.

Browser storage can keep a private draft on one device, but it cannot reliably give both spouses the same list, preserve who changed it, freeze a pre-trip record of intent, or connect that intent to a later receipt. D1 is the canonical household copy. Local storage can still be used as a temporary offline draft, but it is not the source of truth.

Authentication remains a separate concern. The site's two-person access policy decides who may enter; `household_members` connects an authenticated person to the household and records attribution. The API also stops auto-enrollment after two members, which limits damage if the site access policy is broadened accidentally.

## The important correction: a trip is not a receipt

The original table idea is directionally correct: receipt-level metadata should be separate from purchased line items, the Saturday list should be separate from what was bought, and feedback deserves its own records.

The important correction is naming and responsibility:

- A `trip` is the **planning event**: the target Saturday, list status, spending target, discovery allowance, and the moment the list is frozen.
- A `receipt_transaction` is the **financial event**: purchase time, warehouse/fuel/optical/return type, subtotal, discounts, tax, reimbursements, and total.

One planned Costco visit can produce multiple transactions, such as warehouse and fuel receipts. Conversely, an imported historical receipt may have no corresponding planned trip. Therefore `Date/Time/ItemsSold/Total Amount` should not live on `trips`: purchase time, receipt-reported item count, and totals belong on `receipt_transactions`. BasketSense also derives a line-item count and checks it against the receipt-reported count during reconciliation.

## Tables and responsibilities

| Table | What it represents | Key relationships |
| --- | --- | --- |
| `households` | The private shared BasketSense space and its time zone. | Parent of members, products, trips, receipts, and feedback. |
| `household_members` | The two authenticated people, their role, and attribution metadata. | Belongs to a household; referenced by created/added/feedback fields. |
| `products` | A household-approved canonical identity such as “Whole Milk,” independent of an abbreviated receipt description. | May be linked from list items and receipt items. |
| `trips` | One planning cycle for a scheduled Costco visit, moving through `planning`, `frozen`, and `completed`. | Owns list items; may link to several receipt transactions and feedback records. |
| `trip_list_items` | Suggested, manually added, optional, or in-store items for one trip, including section, explanation, confidence, include/check state, quantity, estimate, order, and author. | Belongs to a trip; optionally links to a canonical product. |
| `receipt_transactions` | One warehouse, fuel, optical, or return transaction and its reconciled header amounts, receipt-reported item count, source type, funding split, and audit flag. | Belongs to a household; optionally links to the trip that produced it; owns receipt items. |
| `receipt_items` | Parsed line items, preserving source wording, quantity, gross/discount/net values, tax status, normalization status, and mill-level fuel prices. | Belongs to one receipt transaction; optionally links to a product. |
| `feedback` | Small, explicit household signals: trip enjoyment, recommendation response, discovery outcome, duplicate, waste, or regret. | Belongs to the household and may point to a trip, receipt transaction, list item, or purchased item. |

The design intentionally treats `products` as the bridge between planning language and receipt language. A list can say “milk” while the receipt keeps its abbreviated source text; a reviewed match connects both without overwriting the evidence.

## Core invariants

1. **Money is stored as integer cents.** `$12.34` is `1234`, avoiding floating-point rounding errors. Discounts, tax, returns, and insurance reimbursements remain separate fields so gross purchase value is not confused with household-funded spending.

2. **Quantities are stored in thousandths.** `quantity_milli = 1000` means one unit; this supports fractional quantities later without introducing decimal rounding into the database.

3. **The frozen list is immutable evidence of intent.** When a trip is frozen, each existing item's current `included` value is copied once into `included_at_freeze`. Later include/check edits must never rewrite that snapshot. Items added afterward are marked `added_after_freeze = true`. This is what makes “planned versus unplanned” defensible; receipt history alone cannot establish intent.

4. **Unplanned does not mean bad.** Matching an actual receipt item against the frozen snapshot identifies whether it was planned. Only later feedback can describe a discovery as satisfying, wasteful, regretted, or still unknown.

5. **Receipt totals must reconcile before they are trusted.** A transaction starts as `needs_review`. It becomes `reconciled` only after the source transaction is unique, header arithmetic accounts for subtotal, discounts, tax, reimbursements, and returns, and parsed line items agree with the receipt under a documented sign convention. Ambiguous rows stay reviewable; they are not silently guessed.

6. **Raw evidence is preserved conceptually, not exposed as product truth.** `raw_description` retains the sanitized receipt wording; `product_id` records a reviewed canonical match; `match_confidence_bps` communicates uncertainty. Correcting a match must not rewrite the original line text.

7. **Source totals and derived totals are both kept only when they can be reconciled.** The receipt-reported item count is stored as evidence; parsed items produce an independent count that must agree with it. Planned-versus-actual totals and dashboard aggregates remain derived so display values cannot drift from their rows.

These guarantees require API rules in addition to table columns. In particular, the database field `included_at_freeze` permits storage, while the application must enforce that it is written once.

## Example weekly flow

1. On Friday, BasketSense creates a `trip` for Saturday and adds predicted or recurring `trip_list_items`.
2. Both spouses open the same household list. Each edit is saved to D1 and the next read returns the unified state.
3. Before leaving, one spouse freezes the trip. BasketSense captures `included_at_freeze` for every existing item.
4. During the visit, checked items change freely; a new discovery can be added with source `in_store` and `added_after_freeze = true`.
5. After the visit, each receipt becomes a separate `receipt_transaction`; its lines become `receipt_items`. Warehouse and fuel can both link to the same trip.
6. Only after reconciliation does BasketSense compare purchased products with the frozen list. It can now say “not on the pre-trip list,” but not “bad purchase.”
7. A short `feedback` response later records whether a discovery was useful, whether something was duplicated or wasted, and whether the trip stayed enjoyable. Those explicit signals improve future suggestions.

## Deliberately deferred

The MVP does not need these yet:

- Raw receipt file storage, OCR artifacts, or image metadata. Keep originals outside the database; add private object storage later only if weekly ingestion requires it.
- A product-alias table and automated matching pipeline. Start with a canonical product plus reviewable source descriptions; add aliases after real mismatch patterns appear.
- Pantry inventory or inferred consumption. Purchasing cadence is not consumption cadence, and receipts cannot prove remaining stock or waste.
- A full list-edit event log, live cursor presence, or complex conflict resolution. Server saves plus a simple refresh/polling strategy are sufficient for two users initially.
- Multiple lists per trip. One trip already owns one ordered set of list items; a separate `shopping_lists` table would add structure without current value.
- LLM classification, external price comparisons, and multi-retailer support. None is required to test whether a shared frozen list and lightweight feedback change household behavior.

The database creates a trustworthy shared record, but it does not make receipt parsing accurate by itself. Accuracy comes from retaining the source line, normalizing cautiously, reconciling every transaction, exposing low-confidence matches, and asking for review instead of inventing certainty.
