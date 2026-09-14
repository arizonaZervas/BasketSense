# BasketSense interface decisions

## Existing identity

Preserve the warm, light, dark and automatic themes in `app/globals.css`, the
forest/apricot palette and existing typography. This is a compact household tool,
not a new brand or dashboard redesign. Keep the shared slide-over navigation on
both desktop and mobile; no separate desktop interaction model.

## September 13: monthly spending and navigation polish

- Monthly spending opens at the latest available months, without selecting a
  month or changing the all-month total. Preserve an explicitly selected month
  when resizing. Scrolling stays inside the chart, never the page.
- Narrow chart containers show up to six readable month targets (44px minimum).
  Smaller panes can show fewer rather than compressing labels and targets.
  Containers at least 600px wide fit the available annual series. Native swipe
  remains available, with explicit Earlier/Later controls when overflowing.
- Keep the partial-month label adjacent to its month and retain the exact
  through-date in accessible labels and the chart summary. Zero spend has no
  positive-height bar; signed amounts remain visible.
- Keep the floating navigation's section label visible on phones. Retain its
  existing accessible name, focus behavior and 46px minimum phone height.
- Use mouse-only hover movement. Keep drawer movement brief, avoid page-load
  choreography, and honor reduced motion. Keyboard chart navigation is instant.

Guidance used: installed Impeccable product-register guidance and Emil
design-engineering guidance. No new libraries, decorative assets, animation
framework, or external reference implementation was adopted.

## Verification boundary

Local layout math and interaction-source regression tests plus the existing
BasketSense suite are the automated gate. Production build and scoped lint must
pass. Browser/mobile/theme visual verification is still pending: the browser
verification command was blocked by the workspace credit limit. Do not describe
this polish as visually verified or deployed until those checks are completed.
