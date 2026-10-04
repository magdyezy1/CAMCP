# Local rendered website qualification

Run `npm run check:browser -- --output-dir .runtime/<fresh-directory>` from the Git checkout root
with Node 24 or later. This opt-in check needs an installed local Playwright package directory in
`AMCP_QA_PLAYWRIGHT_MODULE` and an installed headless Chromium executable in `AMCP_QA_BROWSER_PATH`.
Use absolute paths. The command builds the application and refuses a reused output directory.
It does not install a browser, change the machine's configuration or use an existing browser profile.

The ordinary `npm run check` remains independent of the optional browser runtime. Continue its full
sanitized release checks and exact committed-source verification separately. GitHub Actions remain
paused at the owner's 2026-10-04 direction; this command starts no hosted workflow.

## What it exercises

The runner creates disposable loopback applications with encrypted in-memory stores, synthetic users
and isolated browser contexts. Page requests can reach only the exact owned loopback origin.
The Snapchat, WooCommerce and Meta transports return fixed synthetic responses; every other provider
request and all provider writes are refused. It signs into no live website or advertising account.

There are 132 selected cases across 27 distinct page paths:

- About Us and the public landing page at 320, 375, 768 and 1280 CSS pixels in English and Arabic.
- Sign-in, signup, terms and data-deletion views at 320 and 1280 pixels in both selected languages.
- The standalone privacy policy at all four widths in its currently supported English. Its policy
  content and published date are preserved; full Arabic privacy copy is separate remaining work.
- Eighteen workspace views with an empty synthetic owner workspace, in both selected languages at
  320 and 1280 pixels: home, campaigns, reports, report builder, operations, capabilities, report
  library, report pack, monitors, portfolio, measurement, schedules, profiles, connections,
  connectors, settings, account and audit activity.
- Original Snapchat top-snap references, selected WooCommerce products and Meta supplied-product
  comparisons at all four widths in English and Arabic, using actual served controllers and APIs.

Cases check one visible page heading, keyboard skip links, narrow navigation opening, Tab/Shift+Tab
boundaries, Escape focus restoration and switching from an open drawer to workspace search. They
check page reflow, browser exceptions, failed local responses and attempted external egress. Displayed
data tables need captions and named keyboard-focusable regions; overflowing selected tables must
respond to actual arrow-key scrolling in either direction.

Selected commerce and creative journeys also check explicit provider reads, original native IDs,
escaped provider names, initially unchecked selections and clearing old evidence when the selected
source field or reference limit changes. Navigation and CSV validation must not silently read providers.
No product is published, advertising asset changed, live account approved or campaign executed.

## Reading the evidence

Each fresh output directory contains `results.json`, selected workflow/About screenshots and screenshots
of failures. The record includes the browser version and executable hash, Playwright version, current
Git revision and a digest of the tracked website source bytes actually served. Keep it with the
maintained source verification and full sanitized release proof. A result recorded before a later
source change does not qualify that change; run again at the clean committed source before pushing.

The October 4 run uses local Chromium 148.0.7778.96 and Playwright 1.62.1 with an explicit existing
test executable. It establishes those observed local cases. It does not establish another browser,
touch device, assistive technology, complete Arabic editorial acceptance, production deployment,
live provider acceptance or current Linux/Docker qualification.

The checks apply the [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
[keyboard focus sequence guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), and
[table caption guidance](https://www.w3.org/WAI/tutorials/tables/caption-summary/) to the selected
interfaces. This is a scoped engineering check, not a complete WCAG certification. Browser setup is
described by the [official Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype).

## Batch 150 — readable selected product columns

The maintained WooCommerce source and Meta supplied-product journeys also measure actual row-label
column widths. They refuse a column below 120 CSS pixels, which catches per-character name/ID
wrapping independently of the chosen CSS minimum. Original literal values, product selections,
whole-page reflow and actual table keyboard scrolling retain their existing checks. The measurement
is scoped to the local selected Chromium cases and does not certify other engines/devices.
