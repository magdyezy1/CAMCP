---
status: record
tier: engineering
---

# Browser qualification history of the October 2026 waves and batches

A dated record (DOC-03): the dated qualification runs of waves 2 to 4b and the notes of delivery batches 150 to 190 that the [local rendered website qualification guide](../LOCAL-BROWSER-QA.md) collected, moved here on 2026-10-24 and kept as written. Each later integration result has its own record, such as the [wave 4b qualification](QUALIFICATION-4b-2026-10-24.md).

## Wave 2 qualification regressions (2026-10-12)

The first full rendered run after the wave 1 and 2 merges (revision `40ed7a5`: 1,248 cases, 933 passed, 315 failed,
80.87 minutes; `results.json` SHA-256 `c6645de83f11b9989b83810f618b18d89d516fd1bccdcf82ee3abc301391e147`) was
triaged by failure group. It is a failed run, not the leak baseline's provenance. Product defects were fixed; an
expectation changed only where a wave 2 change was intended and stays correct and accessible:

- **Product fixes.** The sign-in page people see is `web/account-security.js`'s renderer, which had dropped WEB-02's
  About link and closed-registration state (only the replaced `identity.js` page had them). A fresh `/measurement`
  reported unsaved edits because MSR-03's generated synthetic test identifier was set as a typed value. The open
  report delivery dialog's text was `#897593`, 3.57–4.11:1 (axe, intermediate state); it uses the muted ink token.
  The dated program read chip ("Provider refused · <time>") kept the status badge's `nowrap` and widened a 320-pixel
  page to 345; it wraps inside its card. A one-row export said "Exported 1 rows" and its snapshot notice "1 rows".
- **Intended changes the expectations now follow.** RPT-05 hides long native resource names behind **Show native
  IDs**, middle-truncates them with a copy button, formats decimals with the exact value in a `<data value>` element
  and labels location types with the native enum in an `<abbr title>`: the Google and retained-evidence cases assert
  the hidden default, show the IDs with the keyboard and read exact values from those carriers
  (`tests/fixtures/evidence-rows-browser.mjs`); "one line" counts visual lines of text, since a `<data>` carrier adds
  an element box on the same line. MSR-03 added four trace converter fields (21 named fields, not 17). WEB-01 moves
  focus on a hash-only change without re-rendering: the linked measurement case now asserts that a hash-only change
  to an unknown fragment keeps the rendered page and leaves focus where it was, then reloads to open that fragment as
  a fresh deep link. COM-01 parks the WooCommerce panels in a collapsed administrator disclosure until the page knows
  a store; the setup case opens it with the keyboard, and so does the stale case after its silent result, since only
  the explicit store-list refresh tells the page about the new store. SEC-05 lets viewers download report files only
  when the owner allows it; the retained-evidence and Google evidence fixtures record that permission. EXP-04 A
  replaced "Export complete." with a receipt naming rows, tab, spreadsheet and time. Status badges are set in capitals
  with CSS, so the program chip is read from its DOM text.
- **WCAG inspections run at the document start.** `atDocumentStart` (`tools/browser-wcag.mjs`) scrolls to the top for
  each initial, intermediate and final axe run and restores the position. axe evaluates the whole document at any
  scroll position (the same color-contrast and target-size node counts were measured at both), but the sticky phone
  top bar overlapped whichever control the last automated click left beneath it, and target-size reported it as
  partially obscured (`measurement-identity-*` at 375 pixels). No rule or tag is excluded.
- **Runner.** The wave 2 run took 80.87 minutes against the proposed 75-minute budget, and one of its two fixture
  lanes sat idle for 33 of them, waiting behind adjacent kinds that share a tenant identity. `runFixtureLanes`
  (`tools/browser-qualification.mjs`) parks a fixture whose tenant is busy and runs another kind; fixtures of one
  tenant still never overlap. A browser promise that rejects after its case closed (the other half of a
  `Promise.all`) is kept in `unhandled_rejections` and fails the run instead of ending it without a record. Each axe
  inspection records `elapsed_ms` and its `deadline_ms`, and the summary names the slowest
  (`wcag_slowest_inspection`). One wave 2 case (Arabic `/capabilities` at 768 pixels) failed only on the 10-second
  deadline. With the machine fully loaded, the same Arabic inspections then measured 1.4 to 1.8 seconds and the
  slowest of a 208-case run 6.1 seconds; the deadline, which bounds a hung engine and asserts nothing about the page,
  is now 20 seconds (the bound stays at most 30).

No full rendered qualification was recorded with these fixes alone: the 208-case run above was a partial run. The
full `--qualification` run belonged to the wave 3 integration gate, which records it under
[Wave 3a integration qualification](#wave-3a-integration-qualification-2026-10-16).

## Wave 3a merge checks (2026-10-16)

The wave 3a merge ran development subsets (`--kinds`, no axe engine, so no WCAG rules) on the merged tree at
`b1da592` with uncommitted changes: `empty`, `granular-reporting`, both `workspace-form-*-error` kinds,
`write-journey` and `export-outcomes` (316 cases, 6.3 minutes, `results.json` SHA-256 `5daad68c…`), then, with the
fixes below, `empty`, `granular-reporting`, `workspace-form-gtm-error`, `write-journey`, `export-outcomes` and
`spend-policy-edit` (304 cases, 5.8 minutes, 299 passed, SHA-256 `be801424…`) and `spend-policy-edit` alone (4 of 4).

- **Found and fixed.** The privacy policy case still expected its 2026-10-07 date; SEC-07 revised the policy on
  2026-10-12. The Arabic title of ACC-05's LinkedIn Lead Sync discovery program kept "(Lead Sync)" in Latin, a new
  leak on `/capabilities`; the title is translated in full (the program's details keep the product name). The Settings
  spending form showed WRT-07's Meta budget unit in English on the Arabic page ("account currency minor units (Meta
  currency offset)"), raising the leak count of `spend-policy-edit /settings` from 2 to 3; the multi-word unit labels
  are now translated.
- **WEB-03 in the rendered matrix.** `granular-reporting` first presses **Pull report** with no account: the refusal
  is shown at the run bar before any request, `#report-run-error` takes focus, and it lies inside the viewport below the
  sticky top bar (`report_run_preflight` in each case record; 16 of 16). The two `workspace-form-*-error` kinds check
  that the refusal's message, what to do, the provider's facts and the reference are separate lines, that nothing
  promises details "below", and that the line "Provider response: HTTP 403. Provider request ID: …" is shown (the GTM
  audit and the LinkedIn conversion read now keep the provider's allow-listed status, request ID, code and layer,
  never its body). Every case probes the messages a person sees (alerts, status regions, notices, errors, toasts) at
  its initial state, every intermediate state and its final state (`tools/browser-agent-tokens.mjs`): none may name
  `execute_next`, `next_call`, `prepare_next`, `recover_step`, `reconcile_step`, `add_after_user_approval`,
  `confirmed: true` or a `details.` path. No probe found one in either subset (608 and 606 probes).
- **WCAG 2.4.11 where the reader is.** The axe runs scroll to the document start (above), so a control the sticky top
  bar hides after a click was no longer seen by any check. `focusObscured` (`tools/browser-wcag.mjs`) now checks, at
  every intermediate and the final state and before each document-start axe run, that the focused control is not
  entirely hidden by a fixed or sticky layer (`focus_obscured` in the record). None was in the 304-case subset (330
  checks).
- **Known, not fixed here.** `granular-reporting`'s second table check times out at 320 pixels (3 or 4 of 4 cases, once
  at 768 dark): the native metric mapping region is focused, but ArrowRight does not move it, while the same key sent
  through the region's locator a moment later does. It reproduces at the browser-fixes tip `f8cce00`, before the wave
  3a merges, and not in a standalone replay of the exercise, so it is a runner timing issue at narrow widths rather
  than a regression of these merges; the integration gate run decides it.

## Wave 3a integration qualification (2026-10-16)

The integration gate ran the full `--qualification` (axe-core 4.14.0, every kind, two fixture lanes) on the gated head
`68fdcd6` (`wave3a-browser-1`): 1,248 cases, 813 passed, 435 failed, 37.64 minutes. It is a failed run, not the leak
baseline's provenance. Each failure group was traced to its first failing case. Where that case stopped part-way, it
left its kind's shared fixture in the wrong state (a store connection never removed, a refused read whose recovery never
ran), so every later case of the kind failed for the same cause: the 435 failures in 29 kinds had 9 causes.

- **Product fix (`e6ebe51`).** The Settings section links (`.settings-subnav`) took the dark sidebar's hover surface
  (`#27392e`) from an unscoped `nav a:hover` in `web/app.css`, so a hovered link read at 1.27:1 in the light theme (axe,
  final state of `worker-health` at 320 and 375 pixels, where the document-start inspection left the pointer over
  "Account"; `spend-policy-edit` at 320 pixels failed its saved-alert state on the same page and passes with the fix).
  The sidebar's own link states are set in `web/identity.css`; the `app.css` hover and current-page rules are now
  scoped to `.sidebar nav`, and `tests/website-contrast.test.mjs` refuses an unscoped sidebar link state and checks
  the section links' own colour pair in both themes.
- **Intended changes the expectations now follow (`0891a76`).** No WCAG, keyboard or reflow assertion changed.
  - WEB-03 appends a hidden feedback region, with its own "Technical details" disclosure, to every workspace form, so
    the report capture disclosure (the Google keyword, device, hour and country kinds with their error and stale
    variants, and the four provider-refusal kinds) and the store removal disclosure (the three WooCommerce connection
    kinds) hold a second summary. Each journey opens its disclosure by its own summary (`:scope > summary`).
  - WEB-03 shows the page's wording instead of a remedy written for an MCP client. The GA4 event and identity refusals
    and the LinkedIn conversion setting refusal carry "Correct the value the message names and send the call again (a
    write is prepared again).", so the cases require the request category's website wording in the page's language
    and that the server's text stays off the page (it stays under Technical details). The permission refusal's
    people-facing remedy is still required as written.
  - MSR-04 added the Observed activity column to the LinkedIn conversion table (10 columns) and the identity form's
    report source and realtime window (23 named measurement fields; `mode` and `minutes` are named).
  - COM-02 B lets each individual listed X product be selected for an explicit removal: the listed view holds one
    unchecked choice per individual product on the page and never a preselected one.
  - COM-03 makes a catalog's supplier column mapping a saved, versioned profile that only operators save, and a mapped
    preview saves it first. `catalog-groups` signs in as the owner (the canonical `catalog` journey stays a viewer's),
    clears the catalog's saved mappings at the start of each case and requires that its mapped preview saved version 1
    with the chosen group column. A viewer can no longer preview a mapped supplier export.
- **Not reproduced.** The `granular-reporting` table check that timed out at 320 pixels in the merge subsets passed in
  all 16 cases of both full runs.

Development subsets confirmed the fixes before the rerun: the 29 failing kinds (452 cases, axe on; 437 passed, the
other 15 being `catalog-groups` cases before its per-case reset) and `catalog-groups` with `catalog` (32 of 32).

**The passing run.** `wave3a-browser-2` on `0891a76` (2026-10-16, 05:26 to 06:16 UTC; `results.json` SHA-256
`4c894911d63247fcbe65ea94af46664b12083f33dcf1ef8be6eca7d5ff03571d`): 1,248 of 1,248 cases passed in 50.16 minutes
against the 75-minute budget. It covered 93 distinct scenarios, 67 fixture kinds and 22 presentation variants. No
pinned WCAG rule was violated at any initial, intermediate or final state; the incomplete results left for manual
review were color-contrast (2,354), label-content-name-mismatch (2,320) and link-in-text-block (4). The slowest
inspection took 0.71 seconds of its 20-second deadline (`conditional-programs-stale-capabilities-ar-1280-dark`). All
3,470 measured focus rings reached 3:1, none of the 3,780 focus-obscured checks found a hidden control, and none of the
2,500 message probes found MCP-client vocabulary. Every critical route had zero Arabic leaks, `/measurement` included
(the wave 2 run never probed it). The write journeys ended accepted, uncertain and refused four times each, with 28
synthetic writes, 0 provider writes, 0 external provider requests and 0 unhandled rejections.

This run is the provenance of the leak baseline. `node tools/browser-arabic-leaks.mjs --ratchet
.runtime/wave3a-browser-2/results.json --write` kept every committed limit (each measured maximum equals it) and added
the 63 routes this run measured for the first time, most of them at zero, so all 90 probed routes are now held; all 624
Arabic cases of the run are within the new limits. The nonzero new limits name the Latin phrases that remain on those
routes: the ten Google evidence kinds on `/reports` (15 each), `retained-evidence /reports` (27), `snapchat /media`
(3) and `worker-health /settings` (2). They may only go down.

## Wave 3b local remainders (2026-10-17)

- **`period-comparison` (RPT-07, `/reporting-overview`).** The full matrix (both appearances, both languages, 320,
  375, 768 and 1280 pixels). Each case starts from the same retained snapshots (an overlapping window and a one-day
  shorter one, collected again from the synthetic Meta account), pulls a seven-day report with **Also collect the
  previous equal window to compare** and reach chosen, and requires the run request to carry
  `compare: "previous_period"`, the pair's window and twice the request estimate, and queueing to read nothing. The
  fixture's worker collects both windows; **Compare periods** must preselect the pair, list the overlapping and the
  shorter snapshot disabled with their reasons in the page's language and allow no other choice, and the table must
  show this window, the earlier window and the change (`+70.13%` from 100.10 to 170.30, `-20%` clicks), "—" for a
  zero earlier value with its reason, "Unavailable" for a ratio with an unknown side, reach named as not compared,
  the campaign of the earlier window listed apart, and the native name `Spring <sale> العربية` literal in its own
  direction. Listing, comparing and comparing again with the explicit choice read nothing from the provider. The
  comparison state is inspected like the other intermediate states (accessibility, WCAG, Arabic leaks, obscured
  focus) and its table by the table checks.
- **Found and fixed by it.** The comparison table had no caption (the table check requires one beside the named
  region; `tests/report-compare-ui.test.mjs` now pins it). In the dark theme a compared value
  (`.report-table td strong`) kept the light ink, 1.24:1 on the dark panel (`web/theme.css`). An opened report
  option's section number measured 4.44:1 on its `#fcfafe` summary (`#7b6696`, 4.84:1;
  `tests/website-contrast.test.mjs`). The Arabic summary card's spend, clicks and CPC row ("170.30 US$") widened a
  320-pixel page to 339 pixels; the row wraps. At the comparison state the Arabic leak probe counted eight English
  nodes: the account and login names and the metric formulas are now marked as native or left-to-right literals.
- **`measurement-ledger` (MSR-03, `/measurement`).** The full matrix. A synthetic TikTok advertiser lists two pixels
  and a synthetic Snapchat ad account one. The fixture installs a synthetic pin of TikTok's statistics specification
  while it runs (the state after the owner pins the real file; without one the statistics read is not sent). Choosing the advertiser reads nothing. With no pixel entered, only the pixel
  list is read and activity stays unknown (`pixel_not_selected`). With the first pixel, its event statistics come back
  field by field as literal left-to-right paths and values, and activity stays unknown (`unconfirmed_fields`, never
  observed). The second pixel's answer names another pixel: it is refused, the layer is unknown with
  `MEASUREMENT_LEDGER_INVALID` and no field of it is shown. Snapchat's pixel domains and signal readiness are observed,
  with their codes literal. Each of the four results is inspected as an intermediate state, the layer table by the
  table checks; eight provider reads in all, no write and no saved report, plan or review. It found nothing to fix.
- **Runner.** An intermediate state's record is kept before its checks run, so a refused state keeps the WCAG rules
  that failed (before, a failing state left no evidence in `results.json`).
- **Development runs.** `--kinds period-comparison,granular-reporting,export-outcomes` with axe-core 4.14.0 on
  `58a3251` plus these changes: 36 of 36 passed in 1.64 minutes (`results.json` SHA-256 `5484512a…`), with no WCAG
  violation, zero Arabic leaks on the three routes and at the comparison state, 118 focus rings at 3:1 or more, and no
  provider write. The ratchet added `period-comparison /reporting-overview` to the leak baseline at 0 from that run
  (the other limits it measured were already 0). `--kinds measurement-ledger`: 16 of 16 in 0.97 minutes, no WCAG
  violation, zero Arabic leaks on the route and at each of the four states; the ratchet added
  `measurement-ledger /measurement` at 0. A wider subset with the shared style and markup changes
  (`empty`, `period-comparison`, `measurement-ledger`, `granular-reporting`, `export-outcomes`, `measurement-trace`,
  `measurement-navigation`, `measurement-events`, `write-journey`; `79e1c2d` plus the ledger journey files): 364 of 364
  passed in 9.13 minutes (`results.json` SHA-256 `265c0988…`), with no WCAG violation, every critical route at zero
  Arabic leaks, 932 focus rings at 3:1 or more, the write journeys ending accepted, uncertain and refused four times
  each, 28 synthetic and 0 provider writes. The integration gate's full `--qualification` passed both kinds in full
  ([Wave 3b integration qualification](#wave-3b-integration-qualification-2026-10-17)).

## WEB-07 front-end architecture (2026-10-17)

WEB-07 changes every page: the shell's stylesheets and tokens, escape-by-default markup, the Arabic catalog chunks
and route-sized bundles. Its local acceptance asks the full rendered run to show no contrast failure in either theme.
The integration gate's browser stage made that run on the merged tree (`--qualification`, every kind in English and
Arabic, both appearances, 320 to 1280 pixels), and it passed
([Wave 3b integration qualification](#wave-3b-integration-qualification-2026-10-17)). The component colours from
tokens (w4a, below) changed every page's colours after that run, so the wave 4a integration gate's `--qualification`
with axe-core was their acceptance run, and it passed
([Wave 4a integration qualification](#wave-4a-integration-qualification-2026-10-18)). WEB-07's other open items are in
the package status (B16 deployed and the owner's visual sign-off, B24 the providers chunk); English About's bytes gap
closed when About stopped loading `theme.css` (docs/AMCP-IDENTITY.md). The `theme.css` entries that only repeated a
token left in wave 4b (B23), each proven by a dark-mode computed-style comparison, and the dark groups no longer mask the
components' variants ([design system](../DESIGN-SYSTEM.md#the-dark-override-layer-themecss)); the integration gate's
`--qualification` is their rendered acceptance run.

- **Development subsets so far** (no qualification; axe-core 4.14.0 on). On the package branch: the Live portfolio,
  Measurement and Commerce kinds, 144 of 144, and `empty`, `granular-reporting`, `export-outcomes`,
  `retained-evidence`, `conditional-programs`, `worker-health`, `google-keyword` and `snapchat`, 360 of 360, with no
  WCAG violation, no focus ring below 3:1, no provider write or external request and the Arabic leak counts at their
  limits. On the merged tree with the merge and review fixes (`b764b4e`, only this documentation uncommitted):
  `empty`, `measurement-ledger`, `measurement-events`, `catalog`, `woocommerce-connection`, `conditional-programs`,
  `period-comparison`, `portfolio-comparison`, `spend-policy-edit` and `export-outcomes`, 380 of 380 in 7.1 minutes
  (`results.json` SHA-256 `9622d496…`): 38 scenarios, 12 fixture kinds, 22 presentation variants, no WCAG violation at
  any state, 1,000 focus rings at 3:1 or more, every critical route at zero Arabic leaks and every route within its
  committed limit (`node tools/browser-arabic-leaks.mjs --ratchet`), 4 synthetic and 0 provider writes, no external
  provider request and no unhandled rejection.
- **Changed expectations in the VM suites**, each because the old one encoded the behavior WEB-07 removed. Every
  other test edit (about forty files) only loads the files a page now gets its code from (`web/routes.js` for the
  route registry and the extension points, `web/work-pages.js`, the account workflow modules, the helpers that moved
  into `web/workspace.js`, `web/route-assets.js` for the chunk loading); none weakens an assertion.
  - `tests/route-assets.test.mjs`: the initial document no longer lists `reporting-overview.js` (the report builder
    left the shell); `/settings` requests `owner-operations.js` and `account-approvals.js` together and retries only a
    failed one (the second no longer captures the first's `renderSettings` wrapper while it loads); a cold `/portfolio`
    or `/commerce` no longer loads `reviewTable` (campaign-workflows.js), and `/settings` names its registered parts
    instead of the `base*` wrappers. New: each account page loads only its own module, and a page that lists work
    loads the paged-list loader, not the Operations center.
  - `tests/asset-version-skew.test.mjs`: `/account` requests the QR vendor file and `mfa-qr.js` together and a
    retryable failure inserts only that script again; the catalog address a script builds is a chunk's.
  - `tests/website-catalog-loading.test.mjs`, `tests/website-localization.test.mjs`, `tests/owner-door.test.mjs`: the
    first Arabic request is `/assets/locales/ar/shell.json` and the reader's bound is 1 MiB per chunk (it was the
    2 MiB monolith); Home's chunks arrive through `uiNeedChunks`.
  - `tests/website-navigation.test.mjs`: it rendered `identity.js`'s copy of the sign-in page, which never rendered in
    the product (account-security.js replaced it at load); it now renders the live page and requires each builder to
    be declared once.
  - `tests/website-contrast.test.mjs`: the sidebar's surface is resolved through its token.
  - `tests/web-locale-chunks.test.mjs` (review fix): a signed-in page's scripts and chunks start once the session says
    the person may open it, not before it answers; a signed-out visitor or an out-of-scope test account requests none.
  - `tests/web-markup.test.mjs` (review fix): `false` inserts nothing in `` html`…` `` (it read as the word "false").
  - `tests/web-colours.test.mjs`: the token parity is read over `tokens.css` and `public-tokens.css`; the public pages
    load the second sheet right after the first, About inside `<noscript>`, the workspace never.
  - `tests/route-anchors.test.mjs` (merge): the contracts panel harness loads the paged-list loader from
    `web/work-pages.js`, where WEB-07 moved it.
  - `deploy/smoke-api.mjs` (integration gate; the deployed HTTP contract `tests/deployment-smoke.test.ts` and the
    container smoke share): `/reporting-overview` no longer carries the report builder's script. The contract requires
    the page loader and the route registry from the page's own snapshot, the registry naming the script as a file of
    that page, the exact versioned script served, and the shell not listing it.
- **Visible changes in the light theme.** The review tables and measurement task links asked for a `--border` that
  did not exist (a `#ddd` fallback); they now take the palette's line. In the dark theme the policy pages' dividers,
  the 404 links and those borders take the dark palette. Computed-style comparisons found no other difference: WEB-07's
  own (every element of 30 pages, light and dark, 1280 and 375 pixels) and the review fix's for the token split (About,
  Privacy in both languages, Terms, Data deletion, 404 and the workspace shell, light and dark, with and without
  JavaScript, 320 and 1280 pixels).
- **Component colours from tokens (w4a, 2026-10-18).** Every literal colour of the stylesheets became a token
  (docs/AMCP-IDENTITY.md), so every page's colours changed a little. A development run of every kind (no
  `--qualification`: the pinned axe-core asset is not installed in this checkout, so no WCAG rule ran; recorded head
  `f6fb978`, a package commit since squashed whose `web/` is the final one) passed 1,279 of 1,280 cases in 56.6
  minutes (`results.json` SHA-256 `bab018b6…`): 95 scenarios, 69 kinds,
  22 presentation variants, 3,574 focus rings at 3:1 or more, every critical route at zero Arabic leaks, 27 synthetic
  and 0 provider writes, no external request and no unhandled rejection. The one failure, `granular-reporting`
  Arabic 768 px dark, is the table check's keyboard-scroll wait timing out; run alone, the kind failed three or four
  of its 320 and 375 px cases the same way both with these stylesheets and with the stylesheets before the change
  (served to the same runner), so it is a timing flake of that journey, not a colour change. Text contrast stood in for
  the WCAG rule: a computed-style comparison with the tree before (256 page states of the empty workspace and 23
  populated kinds, light and dark) found no text whose contrast went down. The integration gate's `--qualification`
  with axe-core was the acceptance run: it passed every kind, the 16 `granular-reporting` cases included, with no WCAG
  violation in either theme (`wave4a-browser-1`, below).
  - `tests/website-contrast.test.mjs`: the dialog, notice, report option and hero surfaces are read through their
    tokens, and app.css's sidebar hover rule (which identity.css always overrode) is gone, so its old value is the
    regression's constant.

## Wave 3b integration qualification (2026-10-17)

The integration gate ran the full `--qualification` (axe-core 4.14.0, every kind, two fixture lanes) on the gated head
`c0f15bd`, the merged wave 3b tree with the gate fix (`wave3b-browser-1`, 2026-10-17, 17:40 to 18:31 UTC;
`results.json` SHA-256 `bddf3eff222f68f0193766d51870e4b158f0b6a1e6d2171b084f8f19192ac814`). Its first run passed 1,280
of 1,280 cases in 50.93 minutes against the 75-minute budget. It covered 95 distinct scenarios, 69 fixture kinds and 22
presentation variants: every page WEB-07 changed, and the two wave 3b kinds, `period-comparison` (RPT-07) and
`measurement-ledger` (MSR-03), in full.

- **WCAG.** No pinned rule was violated at any initial, intermediate or final state in either theme, so WEB-07's
  contrast criterion holds in light and dark. Left incomplete for manual review: color-contrast 2,498,
  label-content-name-mismatch 2,464 and link-in-text-block 4. The slowest inspection took 0.78 seconds of its
  20-second deadline (`period-comparison-reporting-overview-ar-1280-dark`).
- **Focus and wording.** All 3,574 measured focus rings reached 3:1. None of the 4,036 focus-obscured checks found a
  hidden control, and none of the 2,644 message probes found MCP-client vocabulary.
- **Arabic.** Every critical route had zero leaks, and each of the 92 held routes measured exactly its committed limit.
  `node tools/browser-arabic-leaks.mjs --ratchet .runtime/wave3b-browser-1/results.json` proposes no change, so the
  baseline was not rewritten.
- **Writes.** The write journeys ended accepted, uncertain and refused four times each, with 28 synthetic writes, 0
  provider writes, 0 external provider requests and 0 unhandled rejections.

The gate fix `c0f15bd` changed only the deployment HTTP contract, which no rendered case reads; the browser stage ran
after the release gate passed on the same head. `working_tree_clean` is false only because of an untracked file
outside the release scope.

## Wave 4a integration qualification (2026-10-18)

The integration gate ran the full `--qualification` (axe-core 4.14.0, every kind, two fixture lanes) on the gated head
`8295c64c`, the merged wave 4a tree with its review fixes (`wave4a-browser-1`, 2026-10-18, 04:22 to 05:14 UTC;
`results.json` SHA-256 `73b413c8e80206bc71b27b3eab402b84a8cf4d8945cce7ccd4f7662301fbc574`). Its first run passed 1,280
of 1,280 cases in 51.55 minutes against the 75-minute budget. It covered 95 distinct scenarios, 69 fixture kinds and 22
presentation variants: every page with WEB-07's component colours from tokens, in both languages and appearances at
320 to 1280 pixels. The fixtures drive the compiled merged server (`createWebsite` with ARC-04's route modules,
`MirrorService` with its composite tool table, and `NativeTransport`, which consults ARC-01's provider hooks), and
their synthetic fetchers answer every provider request.

- **WCAG.** No pinned rule was violated at any initial, intermediate or final state in either theme, so WEB-07's
  contrast criterion holds with the component colours from tokens in light and dark. Left incomplete for manual
  review, as in wave 3b: color-contrast 2,498, label-content-name-mismatch 2,464 and link-in-text-block 4. The slowest
  inspection took 0.77 seconds of its 20-second deadline (`conversion-metadata-owned-measurement-ar-375-dark`).
- **Focus and wording.** All 3,574 measured focus rings reached 3:1. None of the 4,036 focus-obscured checks found a
  hidden control, and none of the 2,644 message probes found MCP-client vocabulary.
- **Tables.** The table check's keyboard-scroll wait, which timed out in the development runs above, passed in all 16
  `granular-reporting` cases.
- **Arabic.** Every critical route had zero leaks, and each of the 92 held routes measured exactly its committed limit.
  `node tools/browser-arabic-leaks.mjs --ratchet .runtime/wave4a-browser-1/results.json` proposes no change, so the
  baseline was not rewritten.
- **Writes.** The write journeys ended accepted, uncertain and refused four times each, with 28 synthetic writes, 0
  provider writes, 0 external provider requests and 0 unhandled rejections.

The browser stage ran after the release gate had passed on the same head (`wave4a-gate-1`), with no other heavy job
running. `working_tree_clean` is false only because of an untracked file outside the release scope.

## Wave 4b integration qualification (2026-10-24)

The full `--qualification` of the merged wave 4b tree (`wave4b-browser-2`) passed 1,280 of 1,280 cases in 50.87
minutes, after the release gate and a container-parity run had passed on the same head. No pinned WCAG rule was
violated in either theme, every measured focus ring reached 3:1, and the critical Arabic routes stayed at zero. The
run measured Settings and two of its states at zero leaks, so the ratchet lowered their limits. Eight samples of the
new scroll-region target were not measured, because the command block on Connectors wraps and is not a keyboard stop.
The [qualification record](QUALIFICATION-4b-2026-10-24.md) holds the runs, revisions, digests and figures.

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
mutation is added. See [current completion walkthrough](../CURRENT-READINESS.md).

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
receipts qualify the release. See [evidence and limits](DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md).

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
See [delivery](DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md).

## Six-provider inventory diagnostics

The maintained selection adds forty-eight original-scope refused inventory journeys: Google,
Meta, LinkedIn, Snapchat, TikTok and X in English/Arabic at 320/375/768/1280 px, reaching 408 total.
Each real current collector returns its original malformed-currency/text refusal after one fixed
synthetic read. The original described alert retains translated authored reason/hint/reference
for 6,600 ms, original selection/focus, and clears on edit with no automatic read or saved record.
Both the dedicated browser helper and native fixture hashes are retained. Every preceding 360
journey and its assertions remains required. This is local synthetic evidence, with live,
physical-device, full Arabic editorial and assistive acceptance separate. See [account inventory diagnostic evidence](DELIVERY-2026-10-05-PORTFOLIO-DIAGNOSTICS.md).

## Exact inventory read-recovery guidance

The original 408-case selection remains. Its 48 six-provider inventory refusals additionally
assert provider category/ownership, unchanged false retryable and mutation_retry_safe values,
authored Arabic recovery and explicit manual-read-only guidance. All original request/reference,
selection/focus, 6,600 ms described-alert persistence, viewport and edit/no-read assertions remain.
Catalog discovery SDK/HTTP regressions run in the default suite; discovery does not call a provider.
See [operation help and inventory recovery evidence](DELIVERY-2026-10-05-DISCOVERY-RECOVERY.md).

## Batch 170 diagnostic coverage

The complete 408 maintained served journeys remain required in English/Arabic at 320, 375, 768
and 1280 pixels. This increment changes only the Arabic catalog on the browser side; original
controllers, styles, selectors and all maintained fixture/helper assertions remain unchanged.
Twelve new non-browser tests additionally check all 232 selected server reasons through the actual
formatters and four actual owned early HTTP refusals, optional sink failure and original MCP auth.
Do not label those synthetic HTTP/VM cases a live OAuth callback roundtrip or physical assistive
technology test. All working-source 408 journeys pass; fresh exact clean-head qualification gates the sole push. See
[website diagnostic evidence](DELIVERY-2026-10-05-WEBSITE-DIAGNOSTICS.md).

## Core contract diagnostics and public source comparison — batch 171

The original 408 served journeys and every earlier assertion remain required in English/Arabic
at 320/375/768/1280 px. This increment changes only catalog copy on the browser side. Six new
VM/ownership tests qualify all 239 selected core reasons; eight actual loopback HTTP tests
qualify the bounded optional public comparison independently. Native execution, controllers,
styles, browser helpers and existing fixtures remain exact. All working-source 408 journeys pass; fresh exact clean-head qualification gates the sole push. See [core diagnostic evidence](DELIVERY-2026-10-05-CORE-CONTRACT-DIAGNOSTICS.md).

## Maintained browser semantics — batch 172

The maintained 408-case browser runner now inspects the actual Chromium accessibility tree and
local ID references before each journey and after its original workflow. Nineteen selected
interactive/dialog roles require names; missing ARIA label/description/control references and
duplicate IDs refuse the case. Initial views require one exposed main landmark and primary
heading. Final views retain name/reference checks while allowing the original modal boundary.
Inspection disables its accessibility domain and detaches its session, including refusal paths.
Every prior case, native count, egress/write boundary, geometry/focus and workflow assertion stays
exact. All 54 website files and 4,654 Arabic entries remain byte-identical.
See [semantic evidence](DELIVERY-2026-10-05-BROWSER-SEMANTICS.md). Complete working-source semantic release/browser gates pass; exact committed-source checks gate the sole push.
This automated browser guard does not establish physical assistive-technology or full WCAG
acceptance. Package status is in [package status](../review/PACKAGE-STATUS.md); Actions stay waived.

## Complete directly owned backend Arabic — batch 173

The Arabic catalog adds 806 directly owned static error reasons across 150 previously uncovered
source files, retaining all 4,654 existing values exactly. A generalized import/lexical ownership
selector now examines every regular TypeScript file under src/server, including future nested
files. Its actual inventory is 424 files, 173 with selected reasons, and 1,288 distinct directly
owned sentences. The complete locale gate requires 5,294 messages and has zero missing entries
in the 5,460-value catalog. Native fields, numeric limits, response bytes, identifiers, uncertainty
and request references retain their original meaning. Backend behavior and all earlier selectors
and gate statements remain unchanged. See [evidence](DELIVERY-2026-10-05-BACKEND-CONTRACT-LOCALIZATION.md).
Complete working-source backend-Arabic release/browser gates pass; exact committed-source checks gate the sole push. Dynamic/native messages and local wrapper-generated reasons remain outside this
direct-constructor inventory; whole-plan Arabic, physical assistive and deployed acceptance remain
partial ([package status](../review/PACKAGE-STATUS.md)), with hosted Actions owner-waived.

## Release identity HTTP scope — batch 174

The public identity route is covered by actual local HTTP/build/worker regressions independently
of the existing 408 served website journeys. Every website file, runner/helper, fixture, original
native read/recovery assertion and initial/completed accessibility check stays exact. The new
route preserves original host/auth/health behavior and exposes only bounded scoped metadata.
The only preceding test edit advances the exact backend file inventory from 424 to 427; all
native/token/Arabic assertions remain unchanged. See [qualification and limits](DELIVERY-2026-10-05-RELEASE-IDENTITY.md).
Complete working-source release-identity gates pass; exact committed-source full/browser checks gate the sole push.

## Qualified wrapper Arabic and catalog transport — batch 175

The maintained ownership gate now includes static messages passed unchanged through top-level
sole-throw local runtime helpers and their sole-call forwarders. The actual 427-file inventory
contains 2,624 selected wrapper reasons across 168 files. All 2,596 missing messages receive
manually authored Arabic, preserving every earlier 5,460 value; the complete catalog has 8,056
entries and the full gate requires 7,890 messages with zero gaps. Native fields, amounts, enum
values, request references, authorization and provider execution retain their exact meaning.

The catalog reader limits received/decompressed UTF-8 bytes to 2 MiB, enforces a 15-second
abort/monotonic deadline, decodes split UTF-8 strictly and releases reader/listener resources.
Valid small positive chunks are accepted; 65 consecutive empty chunks are refused. Invalid,
oversized or unavailable catalogs retain the current view and a fixed notice; successful reads
coalesce/cache and a failed read permits an explicit fresh attempt. The public diagnostic
command uses the same Arabic byte ceiling; its three original credential-free GET routes and
separate liveness/About limits remain unchanged.

Focused local checks pass 60/60, zero failures/skips. Existing native/locale/browser assertions
remain intact; broader helpers, dynamic/native reasons and complete Arabic editorial/physical
assistive/deployed acceptance remain separate ([package status](../review/PACKAGE-STATUS.md)).
Hosted Actions remain explicitly owner-waived.
Complete working-source wrapper-localization gates pass; exact committed-source full/browser checks gate the sole push.

## Public liveness and LinkedIn forecast prerequisites — batches 176/177

The explicit public comparison now accepts only the application's up/degraded liveness state
and returns a fixed refusal for inconsistent HTTP-200 JSON. Forecast preflight requires an
included geographic-only clause before transport while retaining all three read-only actions
and native payloads. Audience Insights stays unchanged; one manually authored Arabic reason
preserves all preceding 8,056 values. B08/B13/B26 remained partial ([package status](../review/PACKAGE-STATUS.md)).
See [implementation and primary sources](DELIVERY-2026-10-05-LIVENESS-PLANNING-PREREQUISITES.md).
Hosted Actions stay owner-waived; full local source/report/FFmpeg checks remain mandatory.
Working-source checks pass; exact clean committed source/full/browser checks remain the sole push gate.

## Batch 178 — optional selected WCAG A/AA rules

For the additional owned local inspection, install the exact test package under ignored runtime:

```powershell
npm.cmd install --prefix .runtime/wcag-qa --ignore-scripts --no-audit --no-fund axe-core@4.14.0
$env:AMCP_QA_AXE_PATH = (Resolve-Path .runtime/wcag-qa/node_modules/axe-core/axe.min.js).Path
npm.cmd run check:browser -- --output-dir .runtime/wcag-browser-fresh
```

Keep the explicit Playwright/Chromium configuration above. The maintained helper independently
verifies the known 4.14.0 asset bytes and refuses another asset before inspection. It records
engine/hash/tags/helper identity and wcag_initial/wcag_final rule/node/check evidence alongside
every preceding journey and semantic snapshot. Any selected automated violation refuses the
case. Incomplete rules retain manual_review_required and their original evidence. A bounded
deadline, unexpected engine or malformed result refuses qualification rather than dropping it.
An unset optional path retains the earlier browser checks. The root dependency/lockfile and
application runtime stay exact. Selected automated pass is not full WCAG or physical AT.
[Reproductions, primary sources and limits](DELIVERY-2026-10-05-BROWSER-WCAG.md).
Working-source full/report and focused changed-state checks pass; exact clean committed full/browser checks remain the sole push gate.

The retained first full selected-rule audit finds 88 populated-state failures. Shared
pagination contrast and named keyboard-scrollable original-record regions now address those
reproductions. Focused original journeys and a fresh complete clean-head browser run qualify
the changed source separately; the failed audit is never reported as a passing release.
[Scope and additional primary evidence](DELIVERY-2026-10-05-BROWSER-WCAG.md).

## Batch 179 — original hourly evidence and explicit recovery

Three added hourly kinds bring the maintained suite to 432. Each language/width captures all
24 explicit hours across two source pages between account checks, displays original name/hour/
date/resource values and filters hour 21 without changing totals. The actual Excel download
retains all 24 rows and text hours 0/23, with no extra native read. Current malformed-hour
refusals save nothing, preserve settings/references and remain visible beyond 6.6 seconds.
A delayed obsolete failure remains silent after an edit; only a separate explicit retry saves
a complete report. Provider counters, all nine original row controls, caption/label/keyboard/
reflow, semantic and optional selected-WCAG checks apply to these served pages. The 408 old
assertions remain. New fixture/helper hashes are recorded with exact runner/source evidence.
Prototype qualification is labeled separately from clean committed-source qualification.
No real-provider read/write or advertising artifact is allowed. See
[interpretation and release checks](DELIVERY-2026-10-06-GOOGLE-HOUR-EVIDENCE.md).

## Batch 180 — other listed X products with explicit retention

An opt-in read-only inspection extends the existing complete bounded X catalog comparison,
retaining exact native IDs, supported price strings, original group evidence and source lineage.
Two full scans must agree on every displayed supported observation; malformed policy, unsupported
destination and other workspace actions refuse before reads/artifacts. The local searchable
fifty-row-page EN/AR view keeps other listed products retained and outside drafts/removals.
Full-store absence, complete variants and point-in-time reconciliation remain unverified.
The isolated formatted-source prototype passes 75 focused checks and 24 served browser cases
with 400 synthetic GETs, 2,904 original other-product observations, zero mutations/egress,
48 semantic/pinned selected-rule snapshots and all manual evidence retained. All 8,066 earlier
Arabic values remain; 25 are added. Fresh integrated full/report/source/browser gates follow.
B21/B15/B16/B24 remained partial and Actions unused ([package status](../review/PACKAGE-STATUS.md) is current).
See [contract, workflow and qualification](DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).

The maintained total is now 456 cases. Three new catalog kinds retain all 432 old identities,
keyboard/native assertions and deadlines. Each locale/width checks the exact safe 121 outside-
selection observations, eight local page/search actions, no row selection for those observations,
lossless large keys/accepted prices, escaped literal names, explicit retain-only policy, no
artifacts and actual native/mutation/egress counters. Persistent current errors and delayed
edited-form errors save nothing; explicit retry alone collects new native evidence. Initial/final
semantics and optional pinned selected-WCAG checks apply to all cases. Prototype proof remains
separate from fresh clean-head source-qualified full browser proof.

## Batch 190 — conditional programs and current public policy language

The default maintained runner now retains all 560 preceding cases and adds 24 exact
conditional-program journeys, for 584 total. Success/denied/stale kinds run in English/Arabic
at 320/375/768/1280 pixels. They use the actual owned synthetic service and HTTP website,
check guided forecast, guided/native audience and DV360 evidence, and preserve exact original
account/login/native values, current-view refusal, keyboard focus, named table regions,
complete captions/headings and zero provider changes/external egress. New helper/fixture
hashes are recorded beside the original runner and website hashes. All prior workflow,
semantic and optional pinned selected-WCAG assertions remain.

The ordinary public Terms/Data deletion cases now verify the active translated legal copy;
authentication policy links retain their exact original destinations. Selected automated rules
still retain incomplete/manual evidence; the suite does not certify physical assistive use
or full Arabic editorial acceptance. A working-source run is identified as such. Any later
committed-source claim must prove the exact website, compiled backend and maintained browser
inputs match the tested bytes. See
[contract/qualification record](DELIVERY-2026-10-07-CONDITIONAL-PROGRAMS.md).
