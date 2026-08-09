# BasketSense performance audit handoff

Initial code audit: 2026-08-08

Authenticated production baseline: 2026-08-09

Scope: private BasketSense only. Good Cart Day is explicitly out of scope.

## Conclusions first

1. **List mutation responsiveness is the first implementation ticket.** Adding,
   removing, and checking items are the household's most frequent, time-sensitive
   actions. The optimistic UI already moves immediately, but production still
   paid about 631 ms for the mutation and 616 ms for an immediate full refresh.
   The first change should keep the optimistic interaction, apply the
   authoritative mutation item directly, and make five-second recovery polls
   revision-aware.
2. **Products windowing and thumbnail variants remain the strongest laboratory
   scaling finding, but are deferred behind felt List work.** Authenticated
   production rendered 274 products as 3,379 DOM nodes,
   774 buttons, and 200 image elements. Desktop search reached 371 ms INP with
   333 ms processing. At 390×844, Fast 4G, and 4× CPU, search reached **8,921 ms
   INP**, including **8,881 ms processing**. Scrolling the full list downloaded
   52 more images and about **6.99 MB**. This remains the clearest laboratory
   scaling bottleneck.
3. **Production compression narrows, but does not remove, the household data
   problem.** The initial `/api/household` response was 52,824 encoded bytes
   but expanded to 644,687 decoded bytes and took 606–627 ms. The List poll was
   smaller than the original hypothesis—1,365 encoded / 7,928 decoded bytes—but
   an unchanged response arrived every five seconds and three sampled responses
   were byte-identical.
4. **Mutation followed by full refresh is expensive in production.** An isolated
   owner-sandbox check-off painted quickly (54–56 ms interaction), while its
   PATCH took about 631 ms and the immediate full sandbox GET took about 616 ms.
   The UI path is responsive because it is optimistic; the network contract
   still adds roughly 1.25 seconds and unnecessary state transfer.
5. **Receipt extraction is synchronously on the upload request in production.**
   A generated 68-byte blank PNG in the owner sandbox returned `202` in
   **2,967 ms**, with `queued: false` and `awaiting_review`. This confirms
   that extraction ran before the response. A realistic 1–2 MB synthetic image
   remains unmeasured, so this number is a lower-bound diagnostic, not a user
   receipt benchmark.
6. **Insights is not a primary interaction bottleneck.** Authenticated navigation,
   month selection, and chart/category interaction produced 74 ms INP and zero
   CLS. The broad “all tabs rerender badly” hypothesis is disproven for the
   sampled Insights flow.
7. **Initial paint is healthy, but layout stability needs a narrow-layout fix.**
   Desktop LCP was 1,078 ms with CLS 0.0221. Mobile LCP was 329 ms, but CLS was
   0.1135; 720 px CLS was 0.1036. Neither layout overflowed horizontally.

The recommended first implementation ticket is **Apply authoritative List
mutation responses and add revision-aware recovery polling**. This priority uses
the household's reported experience to rank the measured inefficiencies:
foreground List actions come first; Products remains a documented scaling risk.

## What this means for the household experience

The app does not feel uniformly slow. The normal List screen and Insights are
already responsive. The problems are concentrated in a few moments: searching
or scrolling the full product catalog, waiting for receipt processing, seeing
the mobile layout settle after load, and doing background synchronization that
users mostly do not see.

| Household moment | What happens today | What the improvement should feel like |
| --- | --- | --- |
| Open the shopping List | The useful screen appears quickly. On narrow/mobile layouts, some content shifts after it first appears. | The List should still appear quickly, but remain visually fixed so controls do not move as the page settles. |
| Check an item | The item checks immediately because the UI is optimistic, even though the save plus confirmation takes about 1.25 seconds in the background. | The tap should feel equally immediate. The gain is quieter, safer synchronization: less background work, faster acknowledgement, and less chance that a slow refresh delays reconciliation. |
| See a partner's change | The other device discovers the change on its next five-second poll, so the expected delay is zero to five seconds. Every unchanged poll still downloads and processes another snapshot. | Revision checks make “nothing changed” almost free. Adding push later would make partner changes appear nearly immediately; revisions would remain the recovery mechanism after sleep or disconnection. |
| Search Products | Desktop search has a noticeable pause. The 4× CPU mobile stress trace froze processing for almost nine seconds while the full catalog was reconsidered and laid out. | Search results should track typing without visible lag because only a small window of rows is rendered. The 8.9-second figure is a constrained-device lab result, not a claim that every phone always waits nine seconds. |
| Scroll Products | Dozens of large source images download for tiny row thumbnails; the sampled bottom scroll added about 7 MB. | Rows should stay smooth while scrolling and download only small, screen-sized thumbnails. The full image should load only when someone opens the preview. |
| Open a product image | The preview itself is close to the interaction budget and can reuse an already-downloaded full image. | Preview behavior should remain unchanged; optimization should target list thumbnails without making the full preview blurry. |
| Open Insights | Navigation and chart/category interaction are already fast in the sampled flow. | It should continue to feel the same. Chart optimization should not displace higher-impact work. |
| Add a receipt | The capture dialog appears promptly, but even a blank 68-byte sandbox image held the request for about three seconds while extraction completed. | After upload, the app should acknowledge immediately and show a durable “processing” state. The household can leave the screen and return without losing the job. |

### Collaboration: revision ledger versus real-time doorbell

Revisioning and real-time delivery solve different parts of the partner-list
experience:

- **The revision is the ledger.** Every accepted list change increments a small
  household-list revision. Each device remembers the newest revision it has
  applied. If its revision is current, the server returns no list body and the
  UI does no row work. If it is behind, it receives only the missing changes or
  a fresh snapshot when recovery is necessary.
- **Push is the doorbell.** A household-scoped WebSocket or Server-Sent Events
  connection can notify the other active device that a newer revision exists.
  The device then requests the missing changes instead of waiting up to five
  seconds for its next poll.
- **Both are needed for reliable instant updates.** Phones sleep, background
  Safari, switch networks, and miss messages. Push makes the normal case nearly
  immediate; the revision check repairs missed events on reconnect.

The lowest-risk first synchronization step is revision-based conditional
polling plus mutation deltas. It preserves the current zero-to-five-second
partner delay while removing most unchanged transfer, rerendering, and
post-mutation refresh work. Push can be added afterward if the five-second delay
is noticeable in real household use; none of the revision work is discarded.

### User-perceived priority

1. **List mutations:** the most frequent in-store actions should settle without
   a second household download, while preserving the immediate optimistic feel.
2. **Receipt processing:** the current request blocks on extraction and will
   feel increasingly uncertain as real images and model latency grow.
3. **Products:** the laboratory scaling issue remains real, but it is not
   currently perceived as the household's highest-value problem.
4. **Partner push:** revision-aware polling keeps the zero-to-five-second partner
   delay; add a doorbell only if that delay remains noticeable after phase one.
5. **Mobile/narrow layout stability:** the screen appears quickly but can shift
   after paint, which reduces visual confidence and can move a target tapped
   early.
6. **Bootstrap/read-model cleanup:** important for reliability, server cost, and
   future scale, but less directly visible than the moments above until
   server timing proves it is a user-facing latency source.

## Measurement boundary and method

- The baseline used an interactive authenticated session on the existing private
  production site through Chrome DevTools MCP. Access controls, the household
  allowlist, Sites identity, D1 bindings, and R2 bindings were not changed.
- Production household tracing was read-only. State-changing checks used only
  `/?sandbox=1`. The list check-off was undone and re-applied so the original
  sandbox list state was restored.
- Receipt ingestion used a generated 68-byte, 1×1 valid PNG containing no
  receipt or household data. It created one isolated owner-sandbox ingestion;
  no private receipt content, identifiers, storage keys, or response payloads
  are recorded here.
- Desktop and narrow traces used 1× CPU with no network throttling. The mobile
  Products interaction used 390×844 @3×, Fast 4G, and 4× CPU.
- Resource sizes are Chrome Resource Timing values. “Transfer” includes response
  overhead; “encoded” is the compressed body; “decoded” is the in-memory body.
  Asset probes used cache reload so the JS, CSS, and image transfer figures were
  not reduced to 300-byte cache-validation entries.
- No production build, deploy, schema change, access change, commit, or
  architectural refactor was performed.
- The `basketsense-2` graph was refreshed from a BasketSense-only source that
  excluded `good-cart-day/`. The requested call paths were queried after
  reindexing. `DataHealthExplorer` returned no UI graph match.

## Authenticated production metrics

### Core Web Vitals and main-thread work

| Flow | Conditions | LCP | INP | CLS | Main-thread evidence |
| --- | --- | ---: | ---: | ---: | --- |
| Initial List, desktop 1440×900 | 1×, unthrottled | 1,078 ms | n/a | 0.0221 | No initial >50 ms task observed |
| Initial List, mobile 390×844 | 1×, unthrottled | 329 ms | n/a | **0.1135** | LCP: quick-add catalog hint |
| Initial List, narrow 720×800 | 1×, unthrottled | 316 ms | n/a | **0.1036** | Shift cluster began at 1,157 ms |
| Insights navigation + chart/category | 1×, unthrottled | n/a | 74 ms | 0.00 | 28 ms processing, 46 ms presentation |
| Products search, desktop | 1×, unthrottled | n/a | **371 ms** | 0.00 | 333 ms processing; 333 ms and 71 ms long tasks |
| Products search, mobile | Fast 4G, 4× CPU | n/a | **8,921 ms** | 0.00 | 8,881 ms processing |
| Receipt dialog startup | 1×, unthrottled | n/a | 173 ms | 0.00 | 14 ms processing, 159 ms presentation |
| Sandbox list undo + check | 1×, unthrottled | n/a | 54 ms | 0.00 | Final check observed at 56 ms |

Desktop LCP consisted of 137 ms TTFB and 941 ms render delay. Mobile LCP
consisted of 135 ms TTFB and 193 ms render delay. Narrow LCP consisted of 148 ms
TTFB and 168 ms render delay. Chrome reported no CrUX field data for this private
URL.

The narrow layout shift cluster scored 0.1036; the mobile cluster scored 0.1135.
Chrome did not identify a root cause in either trace, so the CLS issue is
confirmed but not yet localized.

### Initial document and transfer sizes

Authenticated production, first two seconds after reload:

| Type | Requests | Transfer bytes | Encoded body bytes | Decoded body bytes |
| --- | ---: | ---: | ---: | ---: |
| Document | 1 | 36,565 | 36,265 | 483,924 |
| JavaScript | 5 | 123,748 | 122,248 | 423,970 |
| CSS | 1 | 20,122 | 19,822 | 109,535 |
| Initial List images | 11 | 1,320,401 | 1,317,101 | 1,317,101 |
| Initial full `/api/household` | 1 | 53,124 | 52,824 | 644,687 |

The document completed in about 353–369 ms. The initial household GET began at
about 401 ms and took 606–627 ms. Fonts and small auxiliary resources are not
included in the table, so its rows should not be summed as an all-resource page
weight.

### `/api/household` frequency, payloads, and waterfall

- The initial full GET transferred 53,124 bytes (52,824 encoded / 644,687
  decoded) and took 606–627 ms.
- The visible List tab requested
  `/api/household?scope=list&tripId=…` every five seconds. Each stable response
  transferred about 1,665 bytes (1,365 encoded / 7,928 decoded).
- A 16.2-second unchanged-state observer captured three successful polls at 146,
  144, and 192 ms. Their status, length, and SHA-256 digest were identical.
- A longer observation showed frequent 93–308 ms polls plus spikes at
  approximately 458, 756, 989, 1,056, and 1,264 ms.
- No ETag, revision token, 304/204 unchanged response, server push, or
  server-emitted mutation delta was observed.
- On an owner-sandbox list check-off, PATCH took about 631 ms and transferred
  649 bytes. It was followed immediately by a full sandbox GET taking about
  616 ms and transferring 7,661 bytes (51,711 decoded). Five-second List polls
  continued afterward.

### List loading and isolated sandbox check-off

- Initial List paint is fast enough in all three viewports, but mobile/narrow CLS
  exceeds the 0.10 budget.
- The production sandbox check interaction was 54–56 ms with CLS 0.00.
- The optimistic UI masks the roughly 1.25-second PATCH → full-refresh
  waterfall; removing that waterfall is a network/server objective, not a reason
  to remove the optimistic interaction.
- The check-off sequence restored the pre-test checked state. No production
  household list state was changed.

### Insights navigation and chart interaction

- Navigation, month selection, and category/chart interaction produced 74 ms
  INP: 0.4 ms input delay, 28 ms processing, and 46 ms presentation.
- CLS stayed at 0.00.
- The sampled chart interaction does not justify chart-specific optimization
  ahead of Products, synchronization, or receipts.

### Products render, search, scrolling, thumbnails, and preview

- The initial production Products view mounted **274 products**, **3,379 DOM
  nodes**, **774 buttons**, and **200 image elements**.
- Desktop search for “milk” produced **371 ms INP**: 0.1 ms input delay, 333 ms
  processing, and 37 ms presentation. The trace contained 333 ms and 71 ms long
  tasks.
- Under Fast 4G and 4× CPU, the same mobile search produced **8,921 ms INP**:
  5 ms input delay, 8,881 ms processing, and 36 ms presentation.
- Chrome counted 3,340 elements during that mobile trace, with 275 children in
  the product-list container. One layout update took 138 ms and required layout
  for 6,118 nodes.
- Restoring the unfiltered list produced a 21,980 CSS-pixel document. Scrolling
  to the bottom triggered 52 additional image requests and about **6,990,682
  transfer bytes**.
- Chrome's Image Delivery insight estimated **1.3 MB** avoidable bytes in the
  sampled trace. Rows displayed 640–960 px images at 76×76 CSS pixels; individual
  estimated savings ranged from about 63 kB to 258 kB.
- Opening a preview reused the cached full-size asset and added no request in the
  sampled run. The preview interaction was 208 ms. Full resolution is appropriate
  for the preview, not for every row.

### Receipt capture and sandbox ingestion

- Receipt-dialog startup produced 173 ms INP: 0.4 ms input delay, 14 ms
  processing, and 159 ms presentation. CLS stayed at 0.00.
- The synthetic 68-byte sandbox upload returned HTTP `202` in 2,966.7 ms. The
  response transferred 763 bytes, reported `awaiting_review`, and reported
  `queued: false`.
- This confirms production extraction is synchronous on the POST. It does not
  represent upload, preparation, or OCR time for a realistic 1–2 MB synthetic
  receipt.
- Code tracing confirms `startReceiptIngestion` waits on the app POST, the app
  POST calls `nativeExtractReceipt` when configured, and Workflow dispatch is
  currently implemented through the separate private ingestion Worker path.

### Desktop, mobile, and narrow-pane layouts

| Layout | Navigation | Horizontal overflow | Geometry |
| --- | --- | --- | --- |
| Desktop 1440×900 | Fixed left rail | No | Desktop List baseline |
| Narrow 720×800 | Fixed bottom nav | No | 720 px main; 66 px topbar; 67 px bottom nav |
| Mobile 390×844 @3× | Fixed bottom nav | No | 390 px main; 66 px topbar; 67 px bottom nav |

The responsive structure is correct at the sampled widths. Layout stability is
not: both narrow and mobile are just above the 0.10 CLS threshold.

## Five code-confirmed opportunities

### 1. Request-time schema/bootstrap/seeding work — structurally confirmed; magnitude not isolated

- Household handlers still enter schema/read-context setup. Full requests reach
  `requestHouseholdContext` and household/sandbox bootstrap work; List-only
  shared polling uses the narrower existing-context path.
- The production full GET took 606–627 ms, but browser tracing cannot separate
  D1 time, Worker CPU, serialization, and network latency.
- Verdict: **confirmed in code, not proven as the dominant runtime cost**.
  Privacy-safe server timings and statement counts are required before changing
  this path.

### 2. Fixed polling and mutation-triggered reloads — confirmed

- Five-second List polls continue while unchanged; three sampled bodies were
  byte-identical.
- `performWrite` still leads to a full `refreshHousehold`; the production
  sandbox waterfall showed ~631 ms PATCH followed by ~616 ms full GET.
- List scope and production compression disprove the earlier assumption that
  every poll sends the full 575 kB local dashboard body. The no-op work and
  mutation refresh remain confirmed.

### 3. Monolithic household/read-render model — confirmed, with tab-specific nuance

- The production full response is only 52.8 kB compressed, but expands to 644.7
  kB and contains data used across List, Insights, Products, receipts, and
  feedback.
- Products rendering is severely affected by mounting the full collection.
- Insights interactions are fast, so memoization/chart work is not a global
  first priority. Split contracts should be justified by initial/server,
  synchronization, and Products evidence rather than by the sampled chart.

### 4. Synchronous receipt extraction — confirmed in production

- The 68-byte synthetic sandbox request took 2.97 seconds, returned
  `awaiting_review`, and was not queued.
- The existing Workflow route is not the app upload dispatch path.
- Verdict: **confirmed and higher priority than the earlier local no-Gemini run
  suggested**.

### 5. Products windowing and image variants — strongly confirmed

- Desktop search misses the 200 ms INP threshold; throttled mobile search is
  unusable at 8.9 seconds.
- The DOM/layout and 7 MB scroll burst directly support bounded windowing and
  DPR-aware thumbnails.
- Verdict: **strongest laboratory scaling opportunity, deferred behind List
  responsiveness based on household usage**.

## Revised priority order

1. **Add List revisions, authoritative mutation responses, and conditional
   recovery polling.** Preserve optimistic UI, eliminate successful
   mutation-triggered full GETs, and return 204 when the revision is unchanged.
2. **Dispatch receipt extraction asynchronously through the existing Workflow,**
   with idempotent outbox/recovery and receipt revision/CAS safety.
3. **Window Products and add responsive thumbnail variants.**
4. **Split/lazy-load the household read model,** starting with List-first state
   and paginated Products/history contracts.
5. **Remove request-time bootstrap/schema/seeding work after instrumentation**
   proves the statement/write budget and identifies the steady-state cost.

Insights-specific chart optimization is deferred: the measured 74 ms interaction
does not justify a separate priority ahead of these five.

## Explicit performance budgets

These are implementation acceptance gates.

### Core UX and layout

- Authenticated List at Fast 4G and 4× CPU: LCP ≤ 1.5 s, CLS ≤ 0.10.
- All measured user interactions: INP ≤ 200 ms; Products search target ≤ 150 ms
  at 1× and ≤ 200 ms at 4× CPU.
- No task > 50 ms during initial List load or Products search/scroll; total
  blocking time ≤ 100 ms per flow.
- Receipt dialog presentation ≤ 150 ms production and ≤ 120 ms local.
- CLS ≤ 0.10 at 390, 720, and 1440 CSS pixels; horizontal overflow must remain
  zero at those widths.

### Initial transfer and household API

- Document ≤ 50 kB encoded; JS ≤ 150 kB encoded; CSS ≤ 30 kB encoded.
- Initial List images ≤ 400 kB transfer.
- Initial List API ≤ 75 kB encoded and ≤ 400 kB decoded. The current compressed
  response passes; the 644.7 kB decoded body fails.
- Unchanged synchronization: 304/204 or equivalent ≤ 1 kB, zero React row
  commits, at most two SELECTs, zero writes, and zero DDL.
- A List mutation must acknowledge at p95 ≤ 300 ms and must not trigger a full
  household GET. Ten rapid check-offs permit ten mutations and at most one
  reconciliation response ≤ 10 kB.

### Products

- Mount 30–40 rows plus overscan; never more than 60 product rows.
- Initial Products DOM ≤ 800 nodes and ≤ 200 buttons.
- 76 CSS-pixel row thumbnails use authorized 64/128 px variants, each ≤ 15 kB;
  initial visible thumbnails ≤ 400 kB and one full-list scroll burst ≤ 500 kB.
- Search/filter INP ≤ 150 ms at 1× and ≤ 200 ms at 4× CPU; no task > 50 ms;
  filter CLS ≤ 0.10.
- Full preview asset ≤ 250 kB and requested only when preview opens.

### Receipt ingestion

- For a 2 MB synthetic image on Fast 4G, return `202 queued` within 500 ms
  after upload completion; OCR/extraction time is never part of the request.
- Queue creation is idempotent, browser-closure-safe, and visible within 500 ms
  of source durability.
- Extraction target: p50 ≤ 15 s and p95 ≤ 45 s to `awaiting_review` or a
  terminal error, measured separately from upload acknowledgement.
- Poll no faster than every two seconds while queued/running, back off when
  hidden, and stop at `awaiting_review`, `failed`, or another terminal state.

## Checkpointed Terra/Luna implementation breakdown

### Checkpoint 0 — baseline harness (Luna)

- Add privacy-safe browser assertions for mounted Products rows, DOM size, long
  tasks, image bytes, mutation refresh count, response bytes, and CLS at 390/720.
- Add server measurements for D1 statement/write count and named timing phases;
  never log household payloads, product names, receipt lines, e-mails, object
  keys, or auth data.
- Exit: current Products, polling, mutation, and CLS failures reproduce without
  production mutation.

### Checkpoint 1 — List revisions and authoritative mutations (Terra, Luna client/tests)

- Terra: add monotonic trip/list revisions, exact mutation-assigned item
  revisions, conditional List reads, and concurrent-writer recovery tests.
- Luna: apply successful add/include/check mutation responses without a full
  refresh, retain optimistic focus/animation, and keep the five-second poll as a
  revision-aware safety net.
- Exit: unchanged polls return 204 with no body or row commit; successful List
  mutations trigger zero full household GETs; add/remove/check converge across
  two clients without skipping an intervening partner change.

Implementation checkpoint, 2026-08-09: the local worktree contains the D1
revision migration/triggers, authoritative item response contract, client merge,
204 poll handling, and focused concurrency tests. It is not built, committed,
deployed, or production-measured. Thirteen focused List/API tests pass, including
add, remove, and check revision responses, an assertion that an unchanged 204
does not read list-item rows, stale-write protection, atomic freeze rollback,
two-spouse synchronization, and recovery from an intervening partner mutation.

Release gate: apply and verify migration 0008 against the existing BasketSense
D1 before releasing the route/client code. Never deploy the new response
contract against an unmigrated database, and do not touch Good Cart Day storage.

### Checkpoint 2 — asynchronous receipt dispatch (Terra, Luna UX)

- Terra: define one idempotent app-upload → outbox → private Workflow dispatch;
  persist instance identity; recover stale dispatch; add receipt revision/CAS
  and atomic finalization.
- Luna: return after durable upload, render queued/running/terminal states, stop
  terminal polling, back off when hidden, and add synthetic sandbox tests.
- Exit: 2 MB acknowledgement and terminal-time budgets pass; duplicate client
  IDs cannot duplicate extraction; browser closure and injected failures do not
  lose or partially finalize work.

### Checkpoint 3 — Products window and images (Luna, Terra checkpoint review)

- Luna: bounded virtualization, stable row height/key behavior, memoized lookup
  maps, deferred search work if still needed, and 64/128 px generated-image
  variants.
- Terra: review the private R2/original-image authorization contract, focus
  restoration, keyboard/screen-reader behavior, and preview fallback.
- Exit: ≤60 mounted rows, ≤800 DOM nodes, ≤400 kB initial thumbnails, ≤500 kB
  scroll burst, Products INP budgets pass, and preview keeps authorized full
  resolution.

### Checkpoint 4 — read-model split (Terra, Luna client)

- Terra: define versioned List, Insights, Products, receipt-history, and feedback
  contracts with pagination/pre-aggregation and unchanged D1/R2 ownership.
- Luna: remove duplicate boot fetch/state, lazy-load tabs, and add direct-refresh,
  skeleton, retry, and cache-invalidation tests.
- Exit: initial List API ≤75 kB encoded / ≤400 kB decoded; Products and histories
  paginate; direct tab URLs recover correctly.

### Checkpoint 5 — request-path bootstrap cleanup (Terra, Luna regression)

- Terra: use the Checkpoint 0 evidence to move schema evolution to migrations,
  make household/catalog initialization explicit and idempotent, and separate
  membership activity writes from reads.
- Luna: add steady-state statement/write regression tests and update fixtures
  without weakening the two-person private-household guard.
- Exit: steady List refresh uses ≤2 SELECTs, zero writes, and zero DDL; full tab
  reads also perform zero schema or seed work.

Each checkpoint ends with a fresh authenticated desktop/mobile trace, budget
comparison, BasketSense-only diff review, and a written handoff before the next
checkpoint starts.

## Recommended first implementation ticket

**Title:** Apply authoritative List mutations with a revision-aware recovery poll

**Acceptance criteria:**

1. Keep the immediate optimistic add/remove/check behavior, focus restoration,
   completion animation, retry UI, and sandbox isolation.
2. Every accepted List mutation returns the authoritative changed item and the
   exact revision assigned to that mutation.
3. The client applies that response directly and performs zero successful
   post-mutation full household GETs. Failure recovery may still fetch fresh
   authoritative state.
4. The five-second visible-List poll sends the newest client revision. An
   unchanged poll returns 204 with no body and causes no List state commit.
5. A newer partner revision returns a recovery snapshot in phase one. Tests
   prove that an intervening partner mutation cannot be skipped even when two
   responses overlap.
6. Measure add, remove, and check from tap to settled UI on both authenticated
   household devices. Mutation acknowledgement p95 must be ≤300 ms, with zero
   immediate full household GETs.

## Remaining measurement gaps

- Repeat authenticated runs across a second session/region and real-user field
  telemetry; the private URL has no CrUX data.
- The root DOM element or async transition responsible for the mobile/narrow CLS
  clusters.
- Privacy-safe Worker/D1 timing and exact SQL statement/write counts for full,
  list-only, mutation, receipt-status, and Workflow requests.
- A realistic 1–2 MB synthetic receipt measuring client preparation, upload, R2
  durability, dispatch acknowledgement, Workflow queue/claim/retry, extraction,
  and terminal polling. No private receipt should be used.
- Memory/heap growth and React commit counts during prolonged Products scrolling
  and household polling.
- A read-only authenticated trace from the second allowed household user.

Do not deploy architectural changes until tests, authenticated browser
verification, private-access checks, D1/R2 binding checks, and BasketSense/Good
Cart Day isolation checks all pass.
