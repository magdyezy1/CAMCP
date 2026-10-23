# Design, accessibility and UX-copy review — October 2026

Review of the rendered AMCP website after wave 4a (WEB-07's colour consolidation), with the design-critique, WCAG 2.1
AA and UX-copy guidance the owner installed for wave 4. Base: `Work-here` at `cb338f68` (deployed). Fixes: package
`impl/w4-design-review` (tickets WEB-01, WEB-03, WEB-05, WEB-06), merged in wave 4b's integration after the design
system (`impl/w4-design-system`, WEB-07 and WEB-08), which settled the dark layer its own way (S1 and R1 below). This
is a dated record: what the website looks like now is in [the design system](../DESIGN-SYSTEM.md) and
[AMCP identity](../AMCP-IDENTITY.md). It also holds the screenshots for the owner's sign-off of WEB-07's component
colours ([section 7](#7-web-07-colour-sign-off)), taken from the integrated tree.

## 1. Scope and method

**Screens**, rendered from the synthetic browser fixtures of `tests/fixtures/browser-workflow-sites.mjs` (no provider,
no network, no live account), in English and Arabic, light and dark, at 375 and 1280 px:

| Screen | Fixture and state |
|---|---|
| Public landing, About, sign-in | `empty`, signed out |
| Workspace home | `empty` (new workspace) and `write-journey` (plans in attention, recent work) |
| Connections and readiness | `empty` (16 platforms, none set up) |
| Campaigns, review and approval | `write-journey`: review open, authorization refused, accepted / uncertain / refused outcomes |
| Creative push | `snapchat` (an uploaded asset, its detail and native references) |
| Reporting overview | `granular-reporting` (ad-set and ad rows, export), `period-comparison` (compare view, metrics open), `export-outcomes` (export receipt, superseded export) |
| Measurement hub and ledger | `measurement-ledger` (Snapchat and TikTok evidence layers) |
| Commerce | `woocommerce-inventory` (store inventory, products and variations) |
| Operations and attention | `write-journey` after its runs |
| Settings and owner controls | `spend-policy-edit` (policy saved, weakening dialog), `worker-health` |

The review ran in two passes on the package branch. The first (2026-10-22) found the defects fixed in `e19917c1`,
`30123080` and `1282d68b`; the second (2026-10-23) captured every screen again on top of those fixes and found the
rest. Section 7's screenshots were taken again after the merge, on the integrated tree.

**What ran on every capture** of the second pass (424 captures): axe-core 4.14.0 with the WCAG 2.0/2.1/2.2 A and AA tags (the
same pinned engine as the browser qualification), and layout probes for targets under 24 px, text under 12 px, form
control borders under 3:1, primary actions above the fold, controls past the page edge, and the heading outline. Each
capture was also inspected as a full-page screenshot. Token contrast was computed from `web/tokens.css` for both
themes ([section 5](#5-contrast)). The browser qualification's own checks (focus rings on six targets, start-edge
overflow, variant colours, Arabic leak probe, agent vocabulary) run on every case of `tools/browser-workflow-qa.mjs`.

**Framework.** Per screen: first impression and purpose, usability (can the person reach the goal), visual hierarchy,
consistency with the AMCP identity and tokens, accessibility (WCAG 2.1 AA: contrast, focus, target size, labels,
errors, name/role/value, reflow), and copy (verb over noun, specific over generic, never blame, plain words over MCP
vocabulary; English and Arabic).

**Not covered here** (owner-run, ACC-07): a keyboard-only walkthrough by a person, a screen-reader pass (NVDA +
Chrome), 200% zoom on a real display, and the deployed site.

**Severity.** *High*: a person cannot read, find or trust something on a core path, or a WCAG AA failure there.
*Medium*: a real usability, consistency or accessibility problem with a workaround. *Low*: polish.

## 2. Summary

What works and must be kept: the identity (ink, iris and apricot on paper, the dark inverse sidebar) is consistent and
calm; every token pair meets AA in both themes ([section 5](#5-contrast)); reviews show the exact native request,
start with every authorization unticked and say when they expire; provider values and IDs stay literal and isolated in
Arabic; Operations and Home share one attention classifier; errors carry a reference and keep the server's exact text
under Technical details; the browser qualification already checks focus rings, overflow and Arabic leaks on every case.

| | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| Findings | 3 | 18 | 21 | 42 |
| Fixed in this package | 3 | 18 | 2 | 23 |
| Open (recommendations, [section 6](#6-priority-list)) | 0 | 0 | 19 | 19 |

M1 and R2 are S4 as Creative and the report builder showed it; they are counted on each screen.

In the second pass axe found violations on 8 of the 424 captures: 56 nodes, one rule (`color-contrast`), all of them
the checked metric pills of the report builder in dark mode (finding R1, which the first pass's S1 fix had exposed).
After the fixes the same states pass; in the integrated tree that pill style no longer exists (R1). Its
*incomplete* results (manual review) were the avatar initial and the workspace-switch icon (`label-content-name-mismatch`:
their names, "Your account" and "Switch workspace", are right) and contrast over gradients and icon glyphs.

## 3. Findings by screen

Status names the commit that fixed a finding; "Open" findings are recommendations ([section 6](#6-priority-list)).

### 3.1 Shell (every workspace page)

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| S1 | In dark mode every primary and danger button looked like a plain button, and status badges and warning notices lost their tone: `theme.css`'s shared dark `:is()` groups listed `#command-results button`, `#capture-feedback` and `#breadcrumb`, which lifted each whole group to ID specificity above the variants. | High | Hierarchy; 1.4.1 (tone is a cue; the badges keep their words) | No component with variants in a group an ID lifts. | Fixed on the branch by rules of their own for the IDs (`e19917c1`). The merge kept the design system's fix instead (`f9a78cea`): `#command-results button` and `#breadcrumb` stay in their groups, the components with variants left them or are listed with a guard (the plain button's hover, the plain notice), and `#capture-feedback` left the layer; the branch's hunks were dropped and the guards rewritten for that structure (`9c01d97a`). |
| S2 | Sidebar labels sat in the icon's 20 px box: two-word names broke word by word and centred ("Evidence & analysis" on three lines), and with a group open the current page could fall below the sidebar's foot. | Medium | Readability, scanning | The label takes the row beside its icon, from its start; group links 14 px. | Fixed `4760735c` |
| S3 | Focus rings: the landing page's closing call to action measured 2.32:1 on its dark band, and a scroll region Chrome makes focusable (the AI connectors' command block) showed the browser's 1 px ring, 1.21:1 on the dark panel. | Medium | 2.4.7, 1.4.11 | The on-inverse ring on the band; the identity ring on any focusable element. | Fixed `e19917c1` |
| S4 | Action rows never wrapped: on 320 and 375 px phones the first action of a right-aligned row lay past the start edge, where nothing scrolls (Report library's "New report" at −114 px, Schedules' "Create a report and schedule", Creative's "Previous recovery page"). | Medium | 1.4.10 Reflow | `.dialog-actions` wraps. | Fixed `e19917c1` |
| S5 | The phone top bar takes two rows (about 80 px, sticky): language, appearance, a "Ctrl K" hint that means nothing on a touch screen, Sign out and the avatar. | Low | Hierarchy, space | Move language and appearance into the menu drawer below 600 px; hide the shortcut hint below 851 px. | Open |
| S6 | Informative text under 12 px in the shell: the brand note (8 px), group labels (9 px), the access line, legal links and status badges (10 px). | Low | Readability (no AA criterion; the identity's own 12 px floor) | Apply the 12 px floor through the type tokens (`w4-design-system`). | Open |
| S7 | "↗", the external-link glyph, also marks in-app actions: "Export now to Google Sheets ↗" opens a dialog, "Sign in to your workspace ↗" submits the form, "Back to home ↗" and "1 row ↗" stay in AMCP. | Low | Predictability (3.2), consistency | "→" for actions inside AMCP, "↗" only for another site or a new tab (identity decision, WEB-06 step 4). | Open |
| S8 | Pages without a header of their own say "Plan, review and verify work across your selected accounts." (Creative, Commerce, Measurement, Capabilities). | Low | Specific over generic | Use the route registry's description, already translated. | Open |

### 3.2 Public landing, About and sign-in

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| P1 | No axe violation in either language or theme; About has no text under 12 px; the hero illustration is one `role="img"` with a description, so its small mock text is not read out. | — | — | Keep. | Pass |
| P2 | Sign-in's password "Show" toggle is 11 px and "Back to home ↗" carries the external glyph (S7). | Low | Readability | 12 px; "→". | Open |

### 3.3 Workspace home

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| H1 | An empty workspace offered two primary actions: "New campaign plan" in the heading and "Set up connections" in its first panel, although a plan needs a connected account first. | Medium | One primary action per view | "New campaign plan" is primary only once an account is connected. | Fixed `4760735c` |
| H2 | Home and Schedules downloaded the campaign plan and review code (25.9 KB of Brotli, 14% of Home) and called none of it. | Medium | Performance | Drop the dependency. | Fixed `1aa81eb0` |
| H3 | Attention cards repeat a "Needs attention" badge inside the "Needs attention" panel and do not say what to do; the date wraps after the badge. | Low | Specific over generic | Show the feed's next safe action (as Operations does) instead of the badge. | Open |
| H4 | On a phone the three metric cards sit in two columns, the third alone. | Low | Layout | One column, or three narrow ones, below 600 px. | Open |

### 3.4 Connections and readiness

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| C1 | Every platform the deployment has not set up showed a primary "Set up →" to everyone (16 identical primaries on a new deployment). Only the site administrator's Settings hold a platform's setup; anyone else, workspace owners included, landed on their own Settings with a six-second toast. | Medium | Hierarchy; no dead ends | Offer "Set up →" to the site administrator only; the card's "Administrator setup required" explains it to everyone else. | Fixed `4760735c` |
| C2 | Manage → "+ Connect another" in the dialog of a platform that is not set up is the same dead end. | Low | No dead ends | The same rule as the card. | Open |

### 3.5 Campaigns, review and approval

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| CA1 | A step the person executed that failed, or whose provider answer was lost, was announced as "Saved." (`role=status`), the word used for a plan saved without execution. | High | Trust; 4.1.3 Status messages | Say what happened: the answer was lost (not sent again; read it back) or the step did not complete. | Fixed `30123080` |
| CA2 | Executing with an authorization unticked showed a six-second toast that repeated the box's own label and outlived the execution. | Medium | 3.3.1 Error identification | The refusal stands beside the boxes (`role=alert`), marks the unticked ones `aria-invalid`, focuses the first and clears when ticked. | Fixed `30123080`, tests `63f8f065` |
| CA3 | An uncertain write was explained with MCP vocabulary ("Do not retry with a new key", "a new idempotency key"). The first rewording dropped "Do not create another resource". | Medium | Plain words; safety | The page's words keep both facts: AMCP never sends it again, and the person reads back before repeating the change. | Fixed `30123080`, `3aac6519` |
| CA4 | A review of an account without a spending policy showed the server's advice for MCP clients ("… with amcp_workspace save_spend_policy") in a table of `/configured false`, in English on the Arabic page. | Medium | Plain words; Arabic | A notice in the page's words, with a link to the policy form for the owner. | Fixed `30123080` |
| CA5 | After a step went wrong the plan offered eight equal buttons. | Medium | Hierarchy | The safe way on is primary: "Read back submitted step" or "Correct blocked step". | Fixed `30123080` |
| CA6 | The plan filters' "Awaiting my approval" and "Archived plans" boxes stood alone, centred, above their words, right under the search field they seemed to belong to (a workspace form lays labels out as grids). | Medium | Proximity; 1.3.1 | A label that holds a checkbox is a row; the browser runner checks every checkbox on every case. | Fixed `ce59e589` |
| CA7 | A plan of one step read "1 steps". | Low | Copy | Plural forms. | Fixed `166cec41` |
| CA8 | "Request to submit — exact native fields" also lists AMCP's own review metadata (`/readOnly`, `/destructive`, `/requiresConfirmation`, `/evidence`, `/warnings`). | Low | Clarity | Group AMCP's metadata under its own caption; keep every field visible. | Open |
| CA9 | On a phone the plan's six actions stack right-aligned at six widths. | Low | Layout | Full-width stacked actions below 600 px. | Open |
| CA10 | Account lists in Arabic join with a Latin comma ("123 ,Meta"). | Low | Arabic | `Intl.ListFormat` (WEB-05 step 6). | Open |
| CA11 | The authorization a person ticks before an execution is styled as a form note (about 12.5 px, muted), smaller than the request it authorizes. | Low | Hierarchy | Body text for the consent sentences; keep them unticked. | Open |

### 3.6 Creative push

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| M1 | "Previous recovery page" unreachable on a phone (S4). | Medium | 1.4.10 | Wrapping action rows. | Fixed `e19917c1` |
| M2 | Headings sit directly against the controls above them ("Uploaded media" under the filter row, "Verified campaign usage" under the buttons). | Low | Grouping, whitespace | A spacing token above panel headings. | Open |

### 3.7 Reporting overview (ad-set and ad detail, compare view, export receipt)

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| R1 | In dark mode a checked metric pill is filled with the iris accent and its formula kept the page's muted shade: #c0b5ce on #c7adff, 1.01:1, invisible. S1's fix unmasked it: the ID-lifted group had kept the filled pill from ever applying. | High | 1.4.3 Contrast | The formula readable on a checked pill. | Fixed on the branch by the pill's own ink (`ce59e589`, 8.83:1). In the integrated tree the iris-filled dark rule is gone (`4e3f2623`): a checked pill keeps its own rule, `--surface-selected` with the `--iris` border in dark mode, and its formula in the muted ink measures 6.03:1 (4.65:1 in light). |
| R2 | "New report" unreachable on a phone (S4). | Medium | 1.4.10 | Wrapping action rows. | Fixed `e19917c1` |
| R3 | Export now: the authorization checkbox stood alone, centred, above its text, and the status after an export covered the authorization and the export button. | Medium | 2.4.11 Focus not obscured; proximity | The box beside its text; the status follows the actions in the flow. | Fixed `e19917c1` |
| R4 | Metric pills showed a base metric's aggregation as its raw value ("sum", "non_additive", "native field"), in English on the Arabic page. | Medium | Plain words; Arabic | "Summed", "Not summed", "Native field", translated; formulas stay literal. | Fixed `166cec41` |
| R5 | With the spreadsheet-URL disclosure open, the export dialog has two primary buttons. | Low | One primary action | "Use this Sheet & add a report tab" as a secondary button. | Open |
| R6 | The platform rows' disclosure indicator is a typed "v". | Low | Consistency | The shared chevron. | Open |

### 3.8 Measurement hub and ledger

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| ME1 | The ledger's layer names broke inside words at 1280 px ("Configurat-ion", "diagnostic-s"). | Low | Readability | Break between words (9rem row header). | Fixed `ce59e589` |
| ME2 | Generic subtitle (S8), and "Read the evidence ledger" is a full-width primary where other forms size buttons to their words. | Low | Consistency | The registry description; auto-width buttons. | Open |

### 3.9 Commerce

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| CO1 | The inventory pager's "Page 1 of 3" touches its buttons. | Low | Spacing | The pager's gap token. | Open |

### 3.10 Operations and attention

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| O1 | Seven of the fourteen next-safe-action sentences of the Operations feed (plans, uploads, incidents, schedules, exports, reports, workbook schedules) printed in English on the Arabic attention cards. | Medium | Arabic | Translated, with an unknown value left literal. | Fixed `1282d68b` |
| O2 | Every campaign row repeats "Inspect the original plan, step receipts and required approvals before continuing.", complete plans included. | Low | Specific over generic | State-specific guidance from the feed, none for a complete plan. | Open |

### 3.11 Settings and owner controls

| # | Finding | Severity | Criterion / principle | Recommendation | Status |
|---|---|---|---|---|---|
| SE1 | The owner's Pause all writes, report retention, plan retention, approval and download forms rendered unstyled native controls beside the styled spending-policy form. | Medium | Consistency, trust | The workspace form style. | Fixed `ce59e589` |
| SE2 | The backup card and reviewer sign-in sentences printed in English on the Arabic page; the timing table named "Reporting Overview", which has no Arabic. | Medium | Arabic | Translated; the canonical page name. | Fixed `1282d68b` |
| SE3 | Review friction shows "Unknown" for every rate when nothing was prepared, and times in milliseconds. | Low | Copy | "No reviews in the last 30 days"; seconds. | Open |

## 4. WCAG 2.1 AA checklist

| Principle | Criterion | Result |
|---|---|---|
| Perceivable | 1.1.1 Non-text content | Pass: icons are hidden or named; the hero illustration is one described image. |
| | 1.3.1 Info and relationships | Pass after CA6 and R3 (boxes beside their words); tables have scoped headers. |
| | 1.4.1 Use of colour | Pass: badges and pills carry words; the dark layer no longer masks the variants' colour cue (S1). |
| | 1.4.3 Contrast (text) | Pass after R1; every token pair meets 4.5:1 in both themes. |
| | 1.4.10 Reflow | Pass after S4 at 320 and 375 px; wide tables scroll inside labelled regions. |
| | 1.4.11 Non-text contrast | Pass: control borders 3.43:1 (light) and 4.93:1 (dark) on cards; focus rings at least 6.57:1. |
| Operable | 2.1.1 Keyboard, 2.4.3 Focus order | Runner keyboard checks pass; a person's keyboard-only pass is owner-run (ACC-07). |
| | 2.4.7 Focus visible | Pass after S3. |
| | 2.4.11 Focus not obscured (2.2) | Pass after R3. |
| | 2.5.8 Target size (2.2) | Pass (axe); stand-alone controls are at least 24 px or spaced. |
| Understandable | 3.2.1 / 3.2.2 Predictable | Pass; S7's glyph is open. |
| | 3.3.1 Error identification, 3.3.2 Labels | Pass after CA2: refusals beside their controls, named and focused. |
| Robust | 4.1.2 Name, role, value | Pass (axe, accessibility tree). |
| | 4.1.3 Status messages | Pass after CA1. |

## 5. Contrast

Token pairs, computed from `web/tokens.css` (WCAG relative luminance):

| Use | Tokens | Light | Dark | Needs | Result |
|---|---|---:|---:|---:|---|
| Body text | `--ink` on `--paper` | 14.56:1 | 15.60:1 | 4.5:1 | Pass |
| Text on cards | `--ink` on `--white` | 15.66:1 | 13.70:1 | 4.5:1 | Pass |
| Secondary text on cards | `--muted` on `--white` | 5.57:1 | 8.07:1 | 4.5:1 | Pass |
| Secondary text on the page | `--muted` on `--paper` | 5.17:1 | 9.19:1 | 4.5:1 | Pass |
| Secondary text on subtle panels | `--muted` on `--surface-subtle` | 4.94:1 | 7.09:1 | 4.5:1 | Pass |
| Neutral status badge | `--text-soft` on `--surface-subtle` | 8.67:1 | 12.05:1 | 4.5:1 | Pass |
| Links, focus ring on cards | `--iris-700` on `--white` | 7.06:1 | 10.51:1 | 4.5:1 | Pass |
| Links, focus ring on the page | `--iris-700` on `--paper` | 6.57:1 | 11.97:1 | 4.5:1 | Pass |
| Primary button label | `--on-accent` on `--accent-fill` | 4.73:1 | 8.83:1 | 4.5:1 | Pass |
| Checked metric pill formula | `--muted` on `--surface-selected` | 4.65:1 | 6.03:1 | 4.5:1 | Pass |
| Success badge | `--success-ink` on `--success-bg` | 6.73:1 | 8.88:1 | 4.5:1 | Pass |
| Warning notice and badge | `--warning-ink` on `--warning-bg` | 7.02:1 | 9.50:1 | 4.5:1 | Pass |
| Danger text on its tint | `--danger` on `--danger-bg` | 5.05:1 | 7.94:1 | 4.5:1 | Pass |
| Danger text on cards | `--danger` on `--white` | 6.06:1 | 9.54:1 | 4.5:1 | Pass |
| Decision pill: steady | `--decision-steady-ink` on `--decision-steady-bg` | 6.85:1 | 8.71:1 | 4.5:1 | Pass |
| Decision pill: hold | `--decision-hold-ink` on `--decision-hold-bg` | 4.94:1 | 7.09:1 | 4.5:1 | Pass |
| Control border on cards | `--line-strong` on `--white` | 3.43:1 | 4.93:1 | 3:1 | Pass |
| Control border on the page | `--line-strong` on `--paper` | 3.19:1 | 5.61:1 | 3:1 | Pass |
| Sidebar links | `--text-on-inverse-secondary` on `--surface-inverse` | 9.08:1 | 9.08:1 | 4.5:1 | Pass |
| Sidebar notes | `--text-on-inverse-muted` on `--surface-inverse` | 6.36:1 | 6.36:1 | 4.5:1 | Pass |
| Focus ring on the sidebar | `--focus-on-inverse` on `--surface-inverse` | 8.48:1 | 10.94:1 | 3:1 | Pass |
| Focus ring on the toast | `--focus-on-inverse` on `--surface-inverse-raised` | 7.72:1 | 9.96:1 | 3:1 | Pass |

Rendered states the review measured, before and after (after: the integrated tree):

| State | Before | After |
|---|---:|---:|
| Checked metric pill formula, dark (R1) | 1.01:1 (#c0b5ce on #c7adff) | 6.03:1 on `--surface-selected` (8.83:1 on the branch's iris fill) |
| Closing call to action focus ring, light (S3) | 2.32:1 | 8.48:1 |
| Focusable command block ring, dark (S3) | 1.21:1 (browser ring) | 10.51:1 |
| Primary button, dark (S1) | coloured like a plain button | 8.83:1 on the iris fill (`--accent-fill`) |

## 6. Priority list

Fixed in this package, by severity: R1, S1, CA1 (High); S2, S3, S4, H1, H2, C1, CA2–CA6, M1, R2–R4, O1, SE1, SE2
(Medium); CA7, ME1 (Low).

Open, in the order recommended (all Low; none blocks a task):

1. **S7, P2: the "↗" glyph on in-app actions.** An identity decision for the owner; then one copy pass in both
   languages (29 catalog keys carry the glyph; the links to other sites among them keep it).
2. **H3: Home's attention cards say what to do**, from the feed's next safe action that Operations already shows.
3. **CA8, CA11: the review's hierarchy**: AMCP's metadata under its own caption (every field still shown), and the
   authorization sentences as body text.
4. **S5, CA9, H4: phone layout**: a one-row top bar, full-width stacked actions, one-column metrics.
5. **S6: the 12 px floor through the type tokens** (with `w4-design-system`'s type scale).
6. **S8, ME2: page subtitles from the route registry.**
7. **C2, R5, R6, M2, CO1, O2, SE3, CA10**: the remaining polish.

Owner-run (ACC-07): keyboard-only and NVDA passes, 200% zoom, and the WEB-07 visual sign-off below.

Verification at the package's last code commit (`3aac6519`): the browser qualification as two development runs
(`tools/browser-workflow-qa.mjs --kinds`, axe configured) passed 400 of 400 cases for the 14 fixture kinds this review
rendered and 880 of 880 for the other 55, so every fixture kind and the same 1,280 cases as the full qualification,
with no axe violation, no Arabic leak above its ratchet and the new checkbox check on every case; the related unit
tests passed 1,437 of 1,437; `check-web` keeps all 56 pages at or below their route bytes before WEB-07.

After the merge with the design system and the integration review's fixes (`a1c6ed7e`): the build, `check-web` (all 56
pages within their route bytes, no literal colour, the design-token counts at their baseline) and the tests related to
every file wave 4b's two web packages changed (1,484 of 1,484, with the freshness checks) pass, and section 7's
screenshots were taken. On the batch's last code commit (`2d674540`, only this record's wording uncommitted), a
development subset of the browser runner with axe-core 4.14.0 (`--kinds` `empty`, `period-comparison`,
`measurement-ledger`, `worker-health`, `write-journey`, `spend-policy-edit`, `export-outcomes`) passed 320 of 320
cases in 7.7 minutes: no WCAG violation at any state (the checked pills of the dark period comparison included), 814
focus rings at 3:1 or more, no Arabic leak on its 32 routes, 12 synthetic and no provider writes, no external request
(`results.json` SHA-256 `a6752f18…`). The integration gate's browser qualification is the rendered acceptance of the
merged tree.

Regression guards added: `tests/website-design-review.test.mjs` (dark variants, rewritten at the merge for the
design system's dark layer; wrapping rows, focus rings, sidebar labels, export dialog, Set up rule, checked-pill
formula contrast from the tokens, checkbox rows, owner forms, ledger header, aggregation words, plurals),
`tests/home-attention-ui.test.mjs`, `tests/website-presentation.test.mjs`,
`tests/route-assets.test.mjs`, and in every case of the browser runner the start-edge overflow, variant colour and
checkbox checks (`tools/browser-accessibility.mjs`), plus the navigation-label check of the shell chrome cases
([local browser QA](../LOCAL-BROWSER-QA.md)).

## 7. WEB-07 colour sign-off

**What WEB-07 changed** ([identity](../AMCP-IDENTITY.md#component-colours-from-tokens-web-07-2026-10-18)): every
stylesheet colour became a token in `web/tokens.css` with a dark value (391 literals; `tools/check-colours.mjs` keeps
the count at 0), the pages without JavaScript read the same values from `web/public-tokens.css`, and one-off tints
merged into the palette. In light mode secondary text is the palette's muted ink (slightly darker), purple accents are
two shades, icons one soft iris, the sidebar's links and labels lighter, the hero's chip white on the iris; some
container borders and hover tints read a little lighter. In dark mode the component shades follow the dark palette.

**What wave 4b changed since** (one sign-off for both lists): the design system's list for the owner's visual sign-off
is in [the design system](../DESIGN-SYSTEM.md#what-changed-in-this-increment-for-the-owners-visual-sign-off): corners
on the radius scale, the top bar's appearance and working-client selects at 36px and About's at 44px, new hover,
disabled and busy states, error notices with the danger border, 3:1 field frames, the dark theme's variants, and a
browser bar that follows the system appearance before JavaScript. In the dark layer, the groups that
`#command-results button` and `#breadcrumb` still lift to ID specificity hold no component with variants any more
(S1): primary buttons are iris, danger buttons and refusals rose, and success and warning badges and warning and error
notices keep their pairs. A checked metric pill takes `--surface-selected` with the iris border, its formula at 6.03:1
(R1). The 94 dark-layer entries that only repeated a token left (B23). This review's fixes add wrapping action rows,
the focus rings, the sidebar labels beside their icons and the checkbox rows (section 3). No token value changed.

**What to check** in the pairs below: primary buttons (iris), danger buttons and refusals (rose), success and warning
badges, warning notices, the selected metric pills (an iris outline on the accent surface in dark mode), focus rings on
the dark sidebar, borders of inputs and cards, the rounder corners and taller top-bar selects, and that nothing reads
as washed out in either theme. Each image is a 1280 × 800 viewport (Home also at 375 × 812 in Arabic), rendered from
the synthetic fixtures on the integrated tree (both packages merged with their review fixes) on 2026-10-23.

| Screen | Light | Dark |
|---|---|---|
| Landing | ![Landing, light](design-review-2026-10/landing-en-light-1280.png) | ![Landing, dark](design-review-2026-10/landing-en-dark-1280.png) |
| Home with work in attention | ![Home, light](design-review-2026-10/home-en-light-1280.png) | ![Home, dark](design-review-2026-10/home-en-dark-1280.png) |
| Home, Arabic, phone | ![Home in Arabic, light](design-review-2026-10/home-ar-light-375.png) | ![Home in Arabic, dark](design-review-2026-10/home-ar-dark-375.png) |
| Connections | ![Connections, light](design-review-2026-10/connections-en-light-1280.png) | ![Connections, dark](design-review-2026-10/connections-en-dark-1280.png) |
| Review with the authorization refused | ![Review, light](design-review-2026-10/campaign-review-en-light-1280.png) | ![Review, dark](design-review-2026-10/campaign-review-en-dark-1280.png) |
| Plan after an uncertain step | ![Plan outcome, light](design-review-2026-10/campaign-outcome-en-light-1280.png) | ![Plan outcome, dark](design-review-2026-10/campaign-outcome-en-dark-1280.png) |
| Report builder metrics | ![Metrics, light](design-review-2026-10/report-metrics-en-light-1280.png) | ![Metrics, dark](design-review-2026-10/report-metrics-en-dark-1280.png) |
| Export receipt | ![Export receipt, light](design-review-2026-10/export-receipt-en-light-1280.png) | ![Export receipt, dark](design-review-2026-10/export-receipt-en-dark-1280.png) |
| Measurement ledger | ![Ledger, light](design-review-2026-10/measurement-ledger-en-light-1280.png) | ![Ledger, dark](design-review-2026-10/measurement-ledger-en-dark-1280.png) |
| Operations | ![Operations, light](design-review-2026-10/operations-en-light-1280.png) | ![Operations, dark](design-review-2026-10/operations-en-dark-1280.png) |
| Settings, Safety | ![Settings, light](design-review-2026-10/settings-en-light-1280.png) | ![Settings, dark](design-review-2026-10/settings-en-dark-1280.png) |

Sign-off: the owner records approval (or the screens to revisit) in [package status](../review/PACKAGE-STATUS.md)
under B16.
