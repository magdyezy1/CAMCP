---
status: reference
tier: engineering
---

# Local rendered website qualification

Run `npm run check:browser -- --output-dir .runtime/<fresh-directory>` from the Git checkout root
with Node 24 or later. This opt-in check needs an installed local Playwright package directory in
`AMCP_QA_PLAYWRIGHT_MODULE` and an installed headless Chromium executable in `AMCP_QA_BROWSER_PATH`.
Use absolute paths. The command builds the application and refuses a reused output directory.
It does not install a browser, change the machine's configuration or use an existing browser profile.

The ordinary `npm run check` remains independent of the optional browser runtime. Continue its full
sanitized release checks and exact committed-source verification separately. GitHub Actions remain
paused at the owner's 2026-10-04 direction; this command starts no hosted workflow.

### Development subsets and qualification mode (QA-03)

- `--kinds <kind,...>` renders only the named fixture kinds. The record then says `qualification_mode: false` and
  lists `selected_kinds`, so a subset is never mistaken for a qualification.
- `--qualification` is the release mode. It renders every kind and refuses to start, before it creates output or
  launches a browser, when `AMCP_QA_AXE_PATH` is unset. The pinned axe-core result is part of a qualification
  record. A qualification run that takes longer than the runtime budget exits non-zero. The budget is 75 minutes, a
  proposed default in `tools/browser-qualification.mjs` until the owner sets it (decision D26 leaves the budget
  pending); `AMCP_QA_RUNTIME_BUDGET_MINUTES` (whole minutes, 1–600) sets another for a run.
- `results.json` carries a `summary`: distinct scenarios (a fixture kind on a route), fixture kinds, presentation
  variants, WCAG rules left incomplete or violated per rule (intermediate states included), Arabic leaks per route,
  write-journey outcomes, synthetic and provider writes, focus rings measured, and the run's duration against the
  budget. Cite these figures, not the headline case count.

## Synthetic write journeys, Arabic leak probe and focus contrast (QA-03)

Owner decision D26 lets the browser fixture accept its own synthetic mutations. Three fixture kinds run at 320 and
1280 pixels in English and Arabic, light appearance only, to bound runtime:

- `write-journey` (`/campaigns`): for each outcome (accepted, uncertain, refused) a saved one-step plan is prepared,
  reviewed, refused without consent (the refusal is announced and nothing is sent), consented and executed. Accepted
  ends `verified`; uncertain ends `uncertain` with `WRITE_OUTCOME_UNCERTAIN` and offers only a read-back; refused
  meets an account change after the review and ends `failed` with `STATE_CHANGED` before anything is sent.
- `spend-policy-edit` (`/settings`): the form shows the stored policy; a one-field tightening saves without a
  question and keeps every other setting (WRT-03); a weakening names what weakens, saves nothing when cancelled and
  changes only that field when confirmed.
- `export-outcomes` (`/reporting-overview`): the newer snapshot's export completes and writes the owned tab; the
  older one's is superseded, says so, offers a new tab and writes nothing (EXP-03).

Each synthetic provider (`tests/fixtures/synthetic-writes-data.mjs`) declares its mutation routes as one exact HTTPS
origin, a mutation method and an anchored path. Only those count as `synthetic_writes`, are answered inside the
fixture process and are never forwarded. Every other mutation is refused and counted as a provider write. The
existing invariant is unchanged: zero provider writes and zero external egress per case. Kinds without this mode
must report zero synthetic writes. `tests/browser-synthetic-writes.test.mjs` runs the same journeys over the fixture's
HTTP website without a browser, so the default suite covers them.

Every Arabic case, including the shell-chrome and version-skew cases, runs a rendered leak probe
(`tools/browser-arabic-leaks.mjs`). It counts visible text nodes in `main` with two or more Latin words that
`tools/arabic-literal-allowlist.json` does not cover. Selectors there keep text literal (`code`, `bdi`, `dir=ltr`,
`data-native` and similar), and terms list brand, provider and format names. User and provider values are marked
`data-native` where they render. Open dialogs and shown status messages are probed at intermediate states and
reported per state. `tools/arabic-leak-baseline.json` holds a per-route limit that may only go down. Home
(`/dashboard`), Connections, Campaigns, Reports, Capabilities and Measurement are critical routes held at zero. A
route without a limit is report-only. After a passing run, `node tools/browser-arabic-leaks.mjs --ratchet
.runtime/<run>/results.json --write` lowers limits to the measured maximum and adds new routes. It refuses to absorb
a rise.

Provenance: the committed limits are those of the first passing full qualification after the wave 1, 2 and 3a merges
(`wave3a-browser-2`, 2026-10-16, recorded under
[Wave 3a integration qualification](records/LOCAL-BROWSER-QA-HISTORY-2026-10.md#wave-3a-integration-qualification-2026-10-16)), which also showed the focus and
leak assertions passing across every case. Wave 3b's development runs added `period-comparison /reporting-overview` and
`measurement-ledger /measurement` at zero, and the full qualification after the wave 3b merges (`wave3b-browser-1`,
[Wave 3b integration qualification](records/LOCAL-BROWSER-QA-HISTORY-2026-10.md#wave-3b-integration-qualification-2026-10-17)) measured each of the 92 routes at
exactly its limit. A limit that fails is now a regression from a measured state. Two known gaps make the counts a
lower bound: the allow-list skips `option` elements (closed select options are not visible text nodes, so they are
never probed) and every `bdi`, not only `bdi[data-native]`.

Every case also focuses the skip link, a sidebar link, a primary button, a form field, the landing page's closing call
to action and a focusable command block in its own appearance (the last two since the design review of 2026-10, where
they measured 2.32:1 and 1.21:1). It requires each focus ring to reach 3:1 against the opaque surface behind it, with
the worst gradient stop counting (WCAG 1.4.11). A focused control with no outline and no shadow fails. Accessibility
semantics, the pinned WCAG rules (when configured) and the leak probe also run after a dialog opens, an alert is shown
and an outcome renders in the write journeys. Report panels and evidence controls use the theme focus colour.

The final state of every case also checks (design review 2026-10) that no control lies past the page's start edge,
where no scrolling reaches it (WCAG 1.4.10; the end-side `scrollWidth` check never saw Reporting's "New report" at
-114 px on a 375 px phone), and that a primary or danger button and an online or attention status badge are not
coloured exactly like their plain counterparts (in dark mode a shared `theme.css` group had erased all four), and that
every visible checkbox sits beside the first line of its own words (a workspace form's label grid had put the plan
filters' boxes alone above them). Period comparison in dark mode also runs axe over the checked metric pills: their
formulas measured 1.01:1 on an iris fill the design review's branch had unmasked; in the merged dark layer a checked
pill takes `--surface-selected`, and its formula 6.03:1. The export journey checks that the
authorization box sits beside its text and that the status after an export covers
neither the box nor the export button (WCAG 2.4.11). The shell chrome cases (851 to 1,280 px) open every navigation
group and require each label to take the row beside its icon (wider than 40 px, not centred, at most two lines); the
icon's 20 px box had broken "Evidence & analysis" into three centred lines.

The qualification records of waves 2 to 4a below stay where they were written. Record the next run in
`docs/records/` (for example `QUALIFICATION-<wave>-<date>.md`, with its revision, digests and figures) and link
it from here: since the documentation freeze (DOC-03), a current page cites no commit and repeats no long line of
another current page, and `npm run docs:index:check` refuses one (`tools/docs-lint.mjs`). The latest is the
[wave 4c qualification of 2026-10-30](records/QUALIFICATION-4c-2026-10-30.md).

## What it exercises

The runner creates disposable loopback applications with encrypted in-memory stores, synthetic users
and isolated browser contexts. Two independent fixture servers/stores run concurrently; cases within each fixture remain sequential. Page requests can reach only the exact owned loopback origin.
The fixture transports return fixed synthetic responses. Explicit qualified reads include semantic
report/planning POSTs. The granular reporting fixture also accepts only its owned synthetic Sheets
cell batch and verifies its read-back and unrelated-tab preservation. All other requests and native
advertising writes are refused. It signs into no live website or advertising account.

The runner selects its cases across 31 distinct page paths, including light/dark appearance and the additional
populated/refusal/recovery cases documented below. Its initial page selection covers:

- About Us and the public landing page at 320, 375, 768 and 1280 CSS pixels in English and Arabic.
- Sign-in and signup at 320 and 1280 pixels (sign-in also at 375 and 768, where a visible About link and visible
  Privacy and Terms links are asserted), and the static Terms and Data deletion pages (`?lang=`, one script, the
  published contact) at 320 and 1280 pixels, in both selected languages.
- The complete standalone privacy policy at all four widths in English and Arabic. Actual language
  links, skip focus, ten sections and the original published date are checked. Both versions remain
  complete static HTML without login or JavaScript; the optional pre-style appearance script does not supply policy content.
- Eighteen workspace views with an empty synthetic owner workspace, in both selected languages at
  320 and 1280 pixels: home, campaigns, reports, report builder, operations, capabilities, report
  library, report pack, monitors, portfolio, measurement, schedules, profiles, connections,
  connectors, settings, account and audit activity.
- The members-only Help page (`/help`, DOC-03), signed in, which shows the owner guide in the interface language, at
  all four widths in English and Arabic.
- Reviewer pass (`--kinds reviewer`): an invited test account opens each `testAccount` route and `/help` at 320 and
  1280 pixels in both languages; its navigation lists only those, no API response fails while a page loads, and Help
  lands on Home; `tests/reviewer-page-apis.test.mjs` checks their scripts against the test-account gate.
- Original Snapchat top-snap references, selected WooCommerce products and Meta supplied-product
  comparisons at all four widths in English and Arabic, using actual served controllers and APIs.
- Deploy version skew (WEB-04) at 375 and 1280 pixels in English and Arabic: a tab opened on Connections sees its
  asset snapshot answer 409, opens `/reports`, must show "AMCP was updated" with **Reload page** (never "Try
  again"), and the reload must open the page.
- Shell chrome (WEB-05) on Home, Capabilities and the report builder at 851, 1024, 1150 and 1280 pixels in English
  and Arabic: every top-bar control stays inside one 78-pixel row, the avatar is square, the page never scrolls
  sideways, the workspace name takes its own direction (`dir="auto"`, right-to-left for an Arabic name), and Arabic
  state badges carry Arabic words.

Every empty-workspace route must also open pristine (`uiHasUnsavedEdits()` is false, so a language switch asks
nothing), and in Arabic `/dashboard`, `/reports`, `/capabilities` and `/reporting-overview` show no `.status` badge
made only of Latin text.

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
Git revision and a digest of the tracked and new non-ignored website source bytes actually served. It also binds the
compiled backend: `release_identity` holds the validated `dist/release-identity.json` digest and components, and
`input_map` (with `input_map_sha256`) hashes every non-`dist` module the runner loads, fixture data files included. The
runner refuses to start when that identity record is missing (`RELEASE_IDENTITY_MISSING`) or older than any TypeScript
source (`RELEASE_IDENTITY_STALE`). `npm run qualify -- --attach-browser <results.json>` adds the run's totals and
whether it was bound to the same package to a qualification record ([operations](OPERATIONS.md)). Keep it with the
maintained source verification and full sanitized release proof. A result recorded before a later
source change does not qualify that change; run again at the clean committed source before pushing.

The October 4 run uses local Chromium 148.0.7778.96 and Playwright 1.62.1 with an explicit existing
test executable. It does not establish another browser,
touch device, assistive technology, complete Arabic editorial acceptance, production deployment,
live provider acceptance or current Linux/Docker qualification. The screen-reader and touch acceptance is the finite
manual protocol of ACC-07 ([assistive-technology acceptance](acceptance/ASSISTIVE-TECHNOLOGY.md): 28 sessions, none
recorded yet); its `serve` command starts these same synthetic fixture kinds for a person to use.

The checks apply the [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
[keyboard focus sequence guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), and
[table caption guidance](https://www.w3.org/WAI/tutorials/tables/caption-summary/) to the selected
interfaces. This is a scoped engineering check, not a complete WCAG certification. Browser setup is
described by the [official Playwright BrowserType API](https://playwright.dev/docs/api/class-browsertype).

## Appearance and immediate detail export

All selected public/workspace and populated/refusal journeys run in both light and dark appearance. Dark cases verify system resolution, an explicit light/dark switch, reload persistence and returning to system. The granular Overview fixture exercises ad and ad-set reports, original native IDs, preserving form inputs during appearance changes, exporting the original snapshot after setup edits, unchecked export confirmation, real synthetic worker/Sheets batches, preserving the original tab and creating no schedule. Automated contrast inspection includes populated results. See [batch 191](records/DELIVERY-2026-10-07-APPEARANCE-MEDIA-DETAIL.md).

## Pending rendered journeys

- The multi-provider measurement ledger (MSR-03): the rendered `measurement-ledger` kind covers the TikTok and Snapchat
  choices in both languages and appearances at 320 to 1280 pixels
  ([Wave 3b local remainders](records/LOCAL-BROWSER-QA-HISTORY-2026-10.md#wave-3b-local-remainders-2026-10-17)). Choosing a Meta pixel or dataset or a Search
  Console site in the ledger task is covered in English and Arabic by the DOM fixture tests
  (`tests/measurement-ledger-ui.test.mjs`), and the Adjust adapter by the backend tests
  (`tests/measurement-ledger-providers.test.mjs`); this runner covers neither yet.

## History

The dated qualification runs and the delivery-batch notes this guide collected are kept as written in [Browser qualification history of the October 2026 waves and batches](records/LOCAL-BROWSER-QA-HISTORY-2026-10.md) since 2026-10-24 (DOC-03):

- <a id="wave-2-qualification-regressions-2026-10-12"></a>Wave 2 qualification regressions (2026-10-12)
- <a id="wave-3a-merge-checks-2026-10-16"></a>Wave 3a merge checks (2026-10-16)
- <a id="wave-3a-integration-qualification-2026-10-16"></a>Wave 3a integration qualification (2026-10-16)
- <a id="wave-3b-local-remainders-2026-10-17"></a>Wave 3b local remainders (2026-10-17)
- <a id="web-07-front-end-architecture-2026-10-17"></a>WEB-07 front-end architecture (2026-10-17)
- <a id="wave-3b-integration-qualification-2026-10-17"></a>Wave 3b integration qualification (2026-10-17)
- <a id="wave-4a-integration-qualification-2026-10-18"></a>Wave 4a integration qualification (2026-10-18)
- <a id="wave-4b-integration-qualification-2026-10-24"></a>Wave 4b integration qualification (2026-10-24)
- <a id="batch-150--readable-selected-product-columns"></a>Batch 150 — readable selected product columns
- <a id="batch-151--complete-public-privacy-languages"></a>Batch 151 — complete public privacy languages
- <a id="batch-152--selected-variation-titles-and-groups"></a>Batch 152 — selected variation titles and groups
- <a id="batch-153--canonical-and-supplier-group-csvs"></a>Batch 153 — canonical and supplier group CSVs
- <a id="batch-154--populated-ga4-event-tables"></a>Batch 154 — populated GA4 event tables
- <a id="batch-155--retained-pages-search-columns-and-actual-downloads"></a>Batch 155 — retained pages, search, columns and actual downloads
- <a id="batch-156--positive-search-keyword-capture-and-downloads"></a>Batch 156 — positive Search keyword capture and downloads
- <a id="batch-157--measured-report-fields-and-action-targets"></a>Batch 157 — measured report fields and action targets
- <a id="batch-158--failed-capture-and-explicit-recovery"></a>Batch 158 — failed capture and explicit recovery
- <a id="batch-159--native-device-evidence"></a>Batch 159 — native device evidence
- <a id="batch-160--persistent-and-obsolete-capture-feedback"></a>Batch 160 — persistent and obsolete capture feedback
- <a id="batch-163--persistent-measurement-feedback-and-explicit-recovery"></a>Batch 163 — persistent measurement feedback and explicit recovery
- <a id="batch-164--native-access-denial-and-translated-shared-recovery"></a>Batch 164 — native access denial and translated shared recovery
- <a id="batch-165--shared-form-errors-gtm-audit-and-linkedin-configuration"></a>Batch 165 — shared form errors, GTM audit and LinkedIn configuration
- <a id="batch-166--conversion-metadata-and-request-scope"></a>Batch 166 — conversion metadata and request scope
- <a id="batch-167--measurement-task-navigation"></a>Batch 167 — measurement task navigation
- <a id="six-provider-inventory-diagnostics"></a>Six-provider inventory diagnostics
- <a id="exact-inventory-read-recovery-guidance"></a>Exact inventory read-recovery guidance
- <a id="batch-170-diagnostic-coverage"></a>Batch 170 diagnostic coverage
- <a id="core-contract-diagnostics-and-public-source-comparison--batch-171"></a>Core contract diagnostics and public source comparison — batch 171
- <a id="maintained-browser-semantics--batch-172"></a>Maintained browser semantics — batch 172
- <a id="complete-directly-owned-backend-arabic--batch-173"></a>Complete directly owned backend Arabic — batch 173
- <a id="release-identity-http-scope--batch-174"></a>Release identity HTTP scope — batch 174
- <a id="qualified-wrapper-arabic-and-catalog-transport--batch-175"></a>Qualified wrapper Arabic and catalog transport — batch 175
- <a id="public-liveness-and-linkedin-forecast-prerequisites--batches-176177"></a>Public liveness and LinkedIn forecast prerequisites — batches 176/177
- <a id="batch-178--optional-selected-wcag-aaa-rules"></a>Batch 178 — optional selected WCAG A/AA rules
- <a id="batch-179--original-hourly-evidence-and-explicit-recovery"></a>Batch 179 — original hourly evidence and explicit recovery
- <a id="batch-180--other-listed-x-products-with-explicit-retention"></a>Batch 180 — other listed X products with explicit retention
- <a id="batch-190--conditional-programs-and-current-public-policy-language"></a>Batch 190 — conditional programs and current public policy language
