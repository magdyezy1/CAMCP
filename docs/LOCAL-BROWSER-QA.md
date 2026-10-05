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
The Snapchat, WooCommerce, Meta and GA4 transports return fixed synthetic responses. Only the exact
GA4 report POST is accepted as a semantic read; every other provider request and all provider writes
are refused. It signs into no live website or advertising account.

The maintained runner now selects 264 cases across 27 distinct page paths, including the
additional populated/refusal/recovery cases documented below. Its initial page selection covers:

- About Us and the public landing page at 320, 375, 768 and 1280 CSS pixels in English and Arabic.
- Sign-in, signup, terms and data-deletion views at 320 and 1280 pixels in both selected languages.
- The complete standalone privacy policy at all four widths in English and Arabic. Actual language
  links, skip focus, eight sections and the original published date are checked. Both versions remain
  complete static HTML without login or JavaScript.
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
Git revision and a digest of the tracked and new non-ignored website source bytes actually served. Keep it with the
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

## Batch 151 — complete public privacy languages

The four new Arabic privacy widths bring the maintained total to 136 selected cases. Each policy
case switches through the actual language links and back, confirms skip focus in each version and
retains all eight sections and the original date. Both policy versions are public static HTML; the
separate API/structure tests verify no authentication/session cookies, exact language headers and
invalid/repeated fallback. Broader editorial/legal/assistive/deployed acceptance remains separate.

## Batch 152 — selected variation titles and groups

Eight new English/Arabic variation cases bring the maintained total to 144 selected cases across the
same 27 page paths. They use actual source-kind/parent/child controls and served APIs, six explicit
native reads, escaped literal parent/child fields, unchecked titles, exact Meta group/price previews
and title/parent invalidation. An additional explicit reread starts from unchecked selections.
Neither destination preview nor navigation starts a provider read, and no provider write is allowed.
The original label-width, caption, keyboard-scroll and page-reflow checks apply at all four widths.

## Batch 153 — canonical and supplier group CSVs

Eight new Meta group cases bring the total to 152 selected cases. Each previews an original
canonical group CSV, explicitly compares current groups, then loads a supplier file and chooses
its original group column before another local preview/current comparison. Parent-looking columns
remain initially unselected, unused private source fields are withheld, exact prices/groups retain
their original values and comparison choices stay unchecked. Original label/caption/keyboard/reflow
checks apply at all four widths in both languages. All sixteen WooCommerce source/variation cases
also assert that unrelated CSV layout controls are hidden after source handoff.

## Batch 154 — populated GA4 event tables

Eight new measurement cases bring the total to 160. Both tables need captions, event labels at least
120 CSS pixels and actual named-region keyboard scrolling. Two original rows retain the exact
9007199254740995 aggregate; unreturned generate_lead must display the authored unknown-count text
in each language. Navigation/controls do not read; one explicit report POST is read-only, a changed
window clears old tables, and one explicit reread retains the original scope/counts. The fixed
fixture refuses every event sender and other provider path/method. Private native fields stay absent.

## Batch 155 — retained pages, search, columns and actual downloads

Eight new retained-report cases bring the total to 168. The fixed 151 rows preserve huge native IDs,
exact decimal text, English HTML-like/Arabic names, known zero clicks and unknown conversions.
Actual 25-row/next/direct-final/search/empty/clear and identity-column hiding/restoring preserve
original full totals, captions, scoped readable row headers, keyboard scrolling and focus continuity.
Each downloads an XLSX while filtered to one row in the current UI language; ExcelJS inspects all
151 original rows in order, exact text values/full totals/native headers/unknown cells/worksheet
direction. The fixture refuses every provider request and makes no fresh capture or write.

## Batch 156 — positive Search keyword capture and downloads

Eight additional English/Arabic /reports cases cover 320/375/768/1280 widths, bringing the maintained
selection to 176. Exact fixed Search POSTs are synthetic reads, all other provider routes/writes refused.
Actual form choices, measurement-completeness reset, explicit two-page capture with two account checks,
literal distinct match types, escaped native text, source-identical retained match filtering and an
all-four-row current-language XLSX are exercised. Existing named-caption keyboard regions, readable
identity headings and contained page reflow remain. Native fixture text/IDs/huge micros/zero/null stay
exact. The selected Chromium suite does not establish live-provider, other-engine or full AT acceptance.

## Batch 157 — measured report fields and action targets

The maintained 176-case suite adds geometry checks to all sixteen populated retained/keyword
journeys: nine original controls each, 144 targets total, at least 44 pixels in both dimensions.
Four fields per case retain at least 16-pixel type and one original accessible label. Actual
query-to-page-size Tab/Shift+Tab verifies selector focus visibility without a new read. Existing
search/page/column/all-row workbook, native literal values and complete totals checks continue.
Baseline measurements of 32 fields were 21–29 pixels with 11-pixel inherited type; reflow already
passed and no prior WCAG failure is inferred. Broader AT/engine/device acceptance remains separate.

## Batch 158 — failed capture and explicit recovery

Eight more fixed Google keyword cases bring the maintained selection to 184. The first explicit
capture returns UNKNOWN match type, stops after three reads and saves no evidence. The API keeps
its original English message/code/reference; the toast uses authored message and recovery hint
in the selected language. Original form account/preset/settings remain and no automatic retry
occurs. A separate submit performs four valid reads, then filtered views download all four rows.
Every previous control/keyboard/native/workbook case remains. All provider traffic is synthetic.

## Batch 159 — native device evidence

Eight new fixed Google device cases bring the maintained selection to 192. English/Arabic at
320/375/768/1280 explicitly capture the exact original account/settings, verify all seven literal
native categories and full campaign resources, filter CONNECTED_TV and download all eight original
rows in the selected language. Known zero, unknown cells, huge spend and complete totals remain.
Original nine controls, labels, keyboard/table scroll and page reflow checks apply. All previous
184 cases remain; native traffic is synthetic and all other provider paths are refused.

## Batch 160 — persistent and obsolete capture feedback

Eight original failed-capture cases now inspect one persistent described alert, original submit
focus, authored reason/hint/reference after 6,600 ms, explicit edit clearing and separate full retry.
Eight new delayed loopback-response cases edit attribution before the old failure arrives; obsolete
feedback remains silent, the changed settings survive and only explicit retry retains new evidence.
The maintained selection reaches 200 English/Arabic cases, preserving all original native/workbook/
control/keyboard/reflow cases. No provider effects or live responses are used. Screen-reader
interoperability remains outside this selected Chromium qualification.

The maintained suite waits for a visible primary heading within its existing timeout before
checking exactly one heading. Locale initialization and network idle alone do not prove that
the asynchronous workspace render has completed. Heading count, visibility and all original
error/response checks remain required.

Batch 161 reached 232 cases: all prior 200 plus 32 Meta/LinkedIn/TikTok/Snapchat
capture-refusal journeys, English/Arabic at 320/375/768/1280. Fixed foreign-account responses must
stop after one original GET without saved reports or effects. Every journey checks original wire
scope, translated persistent reason/hint/reference, original submit focus/settings, description
links, no duplicate toast, persistence after 6,600 ms and explicit-edit clearing without retry.

## Batch 163 — persistent measurement feedback and explicit recovery

The maintained selection is now 264 cases, preserving all preceding 232 and adding 32 GA4
measurement cases: current refusal/recovery and delayed obsolete response for recent events
and exact synthetic identifiers, English/Arabic at all four original widths. The actual served
API returns fixed duplicate-row or missing custom-dimension evidence. Current refusal cases
require one native read, original settings/button focus, described form/submit alert, authored
reason/hint/reference and persistence after 6,600 ms. Editing must clear feedback without a read;
only explicit resubmission obtains qualified evidence with unchanged huge counts, unknown values,
exact identifier/dates/stream and original unverified checks. Delayed responses arrive only after
a form edit and must remain silent without changing the new setting or creating evidence.
Report POSTs and the exact metadata GET are semantic reads; no event sender is allowed.

## Batch 164 — native access denial and translated shared recovery

Sixteen more measurement journeys bring the maintained selection to 280 while preserving all
264 previous cases. Recent-event and exact-identifier reads each return one fixed native HTTP
403, preserving PROVIDER_ACCESS_DENIED and its original reason/reference. The selected Arabic
shared hint explicitly avoids treating status alone as a missing OAuth scope. Original focus/
settings, described alert persistence after 6,600 ms and edit clearing without a read remain.
Only explicit resubmission returns qualified original-scope evidence and exact native values.
All four original widths and both languages run; no grant, event sender, snapshot or provider
mutation is added. See [current completion walkthrough](CURRENT-READINESS.md).

## Batch 165 — shared form errors, GTM audit and LinkedIn configuration

The maintained selection reaches 312 with 32 additional real served journeys: GTM audit and
LinkedIn conversion settings, current refusal/recovery and delayed obsolete response, in both
languages and all four original widths. The original 280 assertions remain. Current cases retain
original native access denial, translated authored hint, reference, settings and button focus in
a described alert after 6,600 ms. Editing clears only current feedback without a native call;
explicit unchanged-scope recovery retains huge native IDs, exact decimal USD values and original
configuration/unknown boundaries. Obsolete response cases release an actual already-completed
local API response after settings change and must stay silent. The fixtures accept only their
fixed account/container/conversion GET plans; no event sender or provider write is allowed.

The populated conversion recovery journeys additionally require original rule/name/ID labels
at least 120 pixels wide and a named keyboard-scroll table region. These checks exposed the
missing native-row minimum; scoped styles correct it and keep literal LTR values together.
Rejected intermediate evidence remains archived; fresh final qualification retains the assertions.

## Batch 166 — conversion metadata and request scope

The maintained selection is 344 cases: all preceding 312 plus 32 metadata journeys in English/
Arabic at every original width. Reported owned rules retain literal methods/ownership and
51-row paging; omitted/future/reported-SHARED fields retain Unknown or escaped exact codes.
Local method/ownership search adds no provider read. Malformed native metadata must retain its
authored reason/hint/reference and described original-submit focus for 6,600 ms; editing clears
without retry and an explicit original-scope recovery makes three separate GETs. Delayed successful
configuration after a selection edit must stay silent. These journeys require 112 fixed synthetic
GETs, no external egress/effects/retained evidence and all original keyboard/table/reflow checks.
Rejected preliminary runner artifacts are retained. Only complete fresh working/exact-HEAD
receipts qualify the release. See [evidence and limits](review/DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md).

## Batch 167 — measurement task navigation

The maintained selection reaches 360 with sixteen new task-navigation and exact-fragment journeys,
retaining all preceding 344 case IDs and assertions. Eight local journeys preserve fifteen form
fields, ten task jumps/returns, the pending original native response and completed local search,
with one explicit original-scope request and three fixed synthetic GETs. Forty valid fragment
focuses and sixteen ignored malformed/unknown fragments across eight linked journeys make no read.
Focus targets must fit the viewport below a sticky/fixed header; all task links fit/wrap at every
width, are at least 44 px high/wide, and retain measured normal/hover label contrast of at least
4.5:1. History, query scope, literal native values and unverified measurement states remain.

The shared helper source hash is part of the result record alongside website/runner/site-fixture
hashes. Held response handlers finish before interception is removed, preserving the strict native
read bound. Rejected preliminary harness/visual evidence remains separate. These selected Chromium
keyboard/reflow/contrast checks do not establish full screen-reader, touch or WCAG acceptance.
See [delivery](review/DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md).

## Six-provider inventory diagnostics

The maintained selection adds forty-eight original-scope refused inventory journeys: Google,
Meta, LinkedIn, Snapchat, TikTok and X in English/Arabic at 320/375/768/1280 px, reaching 408 total.
Each real current collector returns its original malformed-currency/text refusal after one fixed
synthetic read. The original described alert retains translated authored reason/hint/reference
for 6,600 ms, original selection/focus, and clears on edit with no automatic read or saved record.
Both the dedicated browser helper and native fixture hashes are retained. Every preceding 360
journey and its assertions remains required. This is local synthetic evidence, with live,
physical-device, full Arabic editorial and assistive acceptance separate. See [account inventory diagnostic evidence](review/DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md).

## Exact inventory read-recovery guidance

The original 408-case selection remains. Its 48 six-provider inventory refusals additionally
assert provider category/ownership, unchanged false retryable and mutation_retry_safe values,
authored Arabic recovery and explicit manual-read-only guidance. All original request/reference,
selection/focus, 6,600 ms described-alert persistence, viewport and edit/no-read assertions remain.
Catalog discovery SDK/HTTP regressions run in the default suite; discovery does not call a provider.
See [operation help and inventory recovery evidence](review/DELIVERY-2026-10-05-DISCOVERY-RECOVERY.md).

## Batch 170 diagnostic coverage

The complete 408 maintained served journeys remain required in English/Arabic at 320, 375, 768
and 1280 pixels. This increment changes only the Arabic catalog on the browser side; original
controllers, styles, selectors and all maintained fixture/helper assertions remain unchanged.
Twelve new non-browser tests additionally check all 232 selected server reasons through the actual
formatters and four actual owned early HTTP refusals, optional sink failure and original MCP auth.
Do not label those synthetic HTTP/VM cases a live OAuth callback roundtrip or physical assistive
technology test. All working-source 408 journeys pass; fresh exact clean-head qualification gates the sole push. See
[website diagnostic evidence](review/DELIVERY-2026-10-05-WEBSITE-DIAGNOSTICS.md).

## Core contract diagnostics and public source comparison — batch 171

The original 408 served journeys and every earlier assertion remain required in English/Arabic
at 320/375/768/1280 px. This increment changes only catalog copy on the browser side. Six new
VM/ownership tests qualify all 239 selected core reasons; eight actual loopback HTTP tests
qualify the bounded optional public comparison independently. Native execution, controllers,
styles, browser helpers and existing fixtures remain exact. All working-source 408 journeys pass; fresh exact clean-head qualification gates the sole push. See [core diagnostic evidence](review/DELIVERY-2026-10-05-CORE-CONTRACT-DIAGNOSTICS.md).

## Maintained browser semantics — batch 172

The maintained 408-case browser runner now inspects the actual Chromium accessibility tree and
local ID references before each journey and after its original workflow. Nineteen selected
interactive/dialog roles require names; missing ARIA label/description/control references and
duplicate IDs refuse the case. Initial views require one exposed main landmark and primary
heading. Final views retain name/reference checks while allowing the original modal boundary.
Inspection disables its accessibility domain and detaches its session, including refusal paths.
Every prior case, native count, egress/write boundary, geometry/focus and workflow assertion stays
exact. All 54 website files and 4,654 Arabic entries remain byte-identical.
See [semantic evidence](review/DELIVERY-2026-10-05-BROWSER-SEMANTICS.md). Complete working-source semantic release/browser gates pass; exact committed-source checks gate the sole push.
This automated browser guard does not establish physical assistive-technology or full WCAG
acceptance. The whole-plan status remains 13 implemented / 14 partial / one open; Actions stay waived.

## Complete directly owned backend Arabic — batch 173

The Arabic catalog adds 806 directly owned static error reasons across 150 previously uncovered
source files, retaining all 4,654 existing values exactly. A generalized import/lexical ownership
selector now examines every regular TypeScript file under src/server, including future nested
files. Its actual inventory is 424 files, 173 with selected reasons, and 1,288 distinct directly
owned sentences. The complete locale gate requires 5,294 messages and has zero missing entries
in the 5,460-value catalog. Native fields, numeric limits, response bytes, identifiers, uncertainty
and request references retain their original meaning. Backend behavior and all earlier selectors
and gate statements remain unchanged. See [evidence](review/DELIVERY-2026-10-05-BACKEND-CONTRACT-LOCALIZATION.md).
Complete working-source backend-Arabic release/browser gates pass; exact committed-source checks gate the sole push. Dynamic/native messages and local wrapper-generated reasons remain outside this
direct-constructor inventory; whole-plan Arabic, physical assistive and deployed acceptance remain
partial. The matrix stays 13 implemented / 14 partial / one open, with hosted Actions owner-waived.

## Release identity HTTP scope — batch 174

The public identity route is covered by actual local HTTP/build/worker regressions independently
of the existing 408 served website journeys. Every website file, runner/helper, fixture, original
native read/recovery assertion and initial/completed accessibility check stays exact. The new
route preserves original host/auth/health behavior and exposes only bounded scoped metadata.
The only preceding test edit advances the exact backend file inventory from 424 to 427; all
native/token/Arabic assertions remain unchanged. See [qualification and limits](review/DELIVERY-2026-10-05-RELEASE-IDENTITY.md).
Complete working-source release-identity gates pass; exact committed-source full/browser checks gate the sole push.
