---
status: reference
tier: operator
---

# Assistive-technology acceptance: screen readers and touch, English and Arabic

The finite manual acceptance of ACC-07: seven website journeys, each run with two screen readers in two languages,
28 recorded sessions in all. It adds what the automated browser matrix ([local browser QA](../LOCAL-BROWSER-QA.md):
keyboard, reflow, focus, contrast and the pinned axe rules) cannot establish: what a person using a screen reader or
touch actually hears and can do. Nothing here has been run yet. ACC-07 stays open until all 28 sessions are recorded
with no blocking issue outstanding. Formal certification is out of scope; a third-party WCAG audit is optional and an
owner decision.

| Screen reader | Browser and system | Input |
|---|---|---|
| NVDA (`nvda-chrome-windows`) | Google Chrome on Windows | Keyboard only, no mouse |
| VoiceOver (`voiceover-safari-ios`) | Safari on iOS (an iPhone) | Touch gestures only, no keyboard; one check with VoiceOver off (C10) |

Each journey runs in English (`en`) and in Arabic (`ar`): choose **Language** → **العربية (جزئي)** in the page header.
Arabic is right to left and labelled partial until B24 acceptance (owner decision D27).

## The seven journeys

| ID | Journey | Starts on | Stops at |
|---|---|---|---|
| `connect-account` | Connect and select an account | Connections | Save selection changes AMCP access only; a connect flow stops at the provider sign-in page. |
| `recipe-draft` | Recipe, brief check and paused draft | Campaigns | The saved paused plan (a local save); it is not approved or run. |
| `creative-review` | Creative push review | Creative | The push review; its authorization stays unchecked and nothing is pushed. |
| `report-export` | Report build, snapshot and owned-tab Sheets export | Report builder | One export to the owned tab of the fixture spreadsheet, or of the ACC-03 disposable spreadsheet under its authorization. |
| `schedule-pause` | Schedule pause and resume | Schedules | Pause and resume of one schedule. |
| `operations-recovery` | An Operations recovery item | Operations | The read-only check of one recovery item; nothing is accepted as applied or sent again. |
| `ga4-events` | GA4 recent events | Measurement | One recent-events read; no event is sent. |

Steps, with the checkpoints each step exercises. Control names are the English interface text; an Arabic session uses
their Arabic text, which `template` lists under `listen_for`.

**`connect-account`.** (1) Open Connections from the main navigation (C1–C3). (2) Filter the platforms to Connected and
search for one (C4, C7). (3) On a platform that is not connected, choose its connect control: on the fixture host it
says administrator setup is required; on staging the provider sign-in page opens, so stop there and do not sign in
(C12). (4) On a connected platform choose **Manage**: the asset manager opens (C6). (5) Move through the logins and asset
tabs, clear the selected account and choose **Save selection**, then select it again and save (C4, C7, C8). (6) Close
the dialog; focus returns to Manage (C6). On staging, do not choose Sync or Save and check access (they read the provider); on the
fixture host they are refused and the refusal must be announced (C7).

**`recipe-draft`.** (1) Open Campaigns and find the guided recipes (C1, C3). (2) Choose Meta website traffic with image
for the synthetic Meta account (C4). (3) Leave a required field empty and submit: the validation message is announced
and you can reach the field (C7). (4) Fill the brief with synthetic values and choose **Check this brief**, which checks
locally (C7); Check account prerequisites reads the provider, so use it on the fixture host only. (5) Choose
**Create paused campaign plan**: the saved plan is announced and listed (C7, C12). Do not approve or run it.

**`creative-review`.** (1) Open Creative and find **Push creatives** (C1, C3). (2) Add one synthetic image (PNG or
JPEG, no people or client content) with the file control (C4). (3) Choose the destination account (C4). (4) Choose
**Review the push**: the review lists what the account receives (C7, C8). (5) Read the authorization checkbox, leave it
unchecked and push nothing (C12).

**`report-export`.** (1) Open Report builder (C1–C3). (2) Choose the synthetic sources and a closed date range, then
collect the report (C4, C7). (3) Follow its progress to a complete snapshot and read the snapshot table (C7, C8). (4) In
the Google Sheets export, choose the destination: on the fixture host its synthetic spreadsheet; on staging only the
ACC-03 disposable spreadsheet, under that authorization. (5) Confirm the export authorization and choose
**Export this snapshot now**: "Export complete." is announced (C7, C12).

**`schedule-pause`.** (1) On the fixture host one daily schedule, "Synthetic weekly report" to a local file
destination, is already saved; on staging use a schedule of the synthetic workspace. (2) Open Schedules and find the
schedule and its next deliveries (C1, C8). (3) Choose **Pause**: the pause and the Paused state are announced (C4, C7).
(4) Choose **Resume**: the resume is announced (C7, C12).

**`operations-recovery`.** (1) On the fixture host, open Campaigns and the plan "Synthetic uncertain journey", choose
**Review next step**, give consent and run it: the fixture loses the provider's answer, so the step ends uncertain
(synthetic; nothing leaves the computer; C6, C7). (2) Open Operations, filter to Needs attention and open the plan's
item (C4, C8). (3) Read its guidance and choose its read-only check: **Read back submitted step** for a plan step, or
**Check the provider (read-only)** for a standalone reviewed change (C7). (4) The outcome is announced; do not choose
Accept as applied and send nothing again (C12). On staging, use whichever item Operations lists as needing attention.

**`ga4-events`.** (1) Open Measurement and go to **Recent GA4 events** (C1, C3). (2) Choose the GA4 property and enter
an invalid event name: the validation is announced (C4, C7). (3) Enter `purchase` and a recent window, then choose
**Read recent event counts**: the counts table is announced (C7, C8, C9). No event is sent (C12).

## Checkpoints

Mark each `pass`, `fail` or `not_applicable` per session. C1, C2, C4, C5, C9 and C12 apply to every journey; C10 applies
to VoiceOver sessions only and C11 to NVDA sessions only; C3, C6, C7 and C8 are `not_applicable` when the journey has no
such element.

| ID | Checkpoint |
|---|---|
| C1 | On arrival the page title and main heading name the page in the session language. |
| C2 | The skip link and the banner, navigation and main landmarks are reachable (NVDA landmarks list, VoiceOver rotor). |
| C3 | The headings list matches the sections the journey uses. |
| C4 | Every control the journey uses announces a name in the session language, its role and its state (expanded, selected, checked, disabled). |
| C5 | Reading and focus order follow the visual order (right to left in Arabic); nothing the journey needs is skipped or unreachable. |
| C6 | A dialog takes focus, keeps it until it closes, closes with Escape or its close control, and returns focus to the control that opened it. |
| C7 | Progress, success, refusal and validation messages are announced when they appear without losing the place, and none is conveyed by colour alone. |
| C8 | Table cells announce their column headers; a long list announces its count or page. |
| C9 | The page is read in the voice of the session language; provider values, IDs and field names are read as written; digits are Latin. |
| C10 | Touch: every control is reached by swiping and activated by double-tap; nothing needs a path gesture, hover or long press without an alternative; with VoiceOver off each control is tappable (at least 24 by 24 CSS pixels, or spaced); at 200% zoom the journey works without sideways scrolling. |
| C11 | Keyboard: the journey completes without a mouse, NVDA enters focus mode in form fields by itself, and the focus indicator stays visible. |
| C12 | The journey stops at its boundary: nothing beyond it is sent, approved or changed. |

An issue is **blocking** when the journey cannot be completed with that screen reader and input, or only with sighted
help or a workaround the product does not offer, or when the person cannot tell what an action will do or did (for
example what a confirmation authorizes). It is **non-blocking** when the journey completes with friction: an unclear
name, an extra or missing announcement, a missing heading. A checkpoint fails exactly when an open blocking issue names
it; a non-blocking issue leaves it passed.

## Where to run

- **The synthetic fixture host (the NVDA sessions).** After `npm run build`, run
  `node tools/acceptance/assistive-results.mjs serve <journey>` on the tester's Windows computer. It starts that
  journey's synthetic workspace in memory, as the automated browser matrix does (owner role; viewer for `ga4-events`),
  on `127.0.0.1` only, and prints a one-time sign-in link, the stop boundary and the release identity for the record.
  Every provider request is answered by the fixture's own synthetic provider or refused; reports and exports finish
  because it runs the report worker. `creative-review` needs `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH`, as the media
  tests do. Ctrl+C ends it and prints its request counts: `provider_writes` must be 0. Each start is a fresh workspace,
  and a used link answers 410. If a journey cannot reach its boundary on the fixture host, run that session on
  staging instead: a limit of the synthetic fixture that a deployment does not have is not an accessibility issue.
- **Staging with synthetic data (owner request R7).** Every VoiceOver session (an iPhone cannot reach the fixture host)
  and any NVDA session. Only synthetic workspace data and assets the owner designated for acceptance: `report-export`
  exports only to the ACC-03 disposable spreadsheet under its authorization, and `ga4-events` reads only a GA4 test
  property the owner designated (R2). Never production (amcp.shop) or real client data.

## Recording

1. `node tools/acceptance/assistive-results.mjs template > assistive.json`, kept outside the repository (the owner's
   private evidence store or `.runtime/acceptance/`). Fill `release` once from `/versionz` (the fixture host prints
   it). Per session: `result`, `environment` (`fixture` or `staging`), `date`, `tester` (a label such as `tester-a`,
   never a name), `versions` (screen reader, browser and system), optionally `minutes`, each checkpoint, and the IDs
   of the issues found.
2. Each issue: `id` (`AT-001`…), the session it was found in, `checkpoint`, `severity`, a one-line `summary` that names
   pages by route (no URL, e-mail, account ID, token or screenshot) and `status`: `open`; `fixed` with `fix_ref` (the
   fix commit) and `retested: true` after the session ran again; or `declined`, for a non-blocking issue only.
3. `node tools/acceptance/assistive-results.mjs check assistive.json` validates the record and states its outcome:
   `accepted` (28 sessions passed, no blocking issue open), `blocked` or `incomplete`, with the record's SHA-256.
   `summary` gives sessions and issues per journey and the median minutes, the measurable outcome of ACC-07.
4. Fix each blocking issue in its own commit with its regression test, keeping the automated browser matrix green,
   then run the affected sessions again and update the record.
5. When the outcome is `accepted`, cite the record's SHA-256 and date in the qualification record (QA-01) and as B16's
   manual evidence in `docs/review/package-status.json` (its ACC-07 remainder closes), then run `npm run docs:index`.

Tests: `tests/assistive-acceptance.test.mjs` (the protocol, the record rules and the fixture host).
