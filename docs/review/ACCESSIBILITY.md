# Accessibility report

Method: the site ran locally (`node dist/server/http.js`, throwaway database and key, no provider traffic) and a
Playwright/Chromium script visited 50 page and viewport combinations as an anonymous visitor, the administrator and a
reviewer, at 320, 360 and 1280 px. For each page it measured the contrast of every visible text node against its
composited background, horizontal overflow, target sizes, accessible names, headings, landmarks and live regions.
"Before" is `03ac8d3`; "after" is batch 3. Same pages, same widths, same script.

| Measure (50 page/width combinations) | Before | After |
|---|---:|---:|
| Text below 4.5:1 contrast | 271 | 60 |
| Pages that overflow horizontally | 3 | 0 (the last, `/campaigns` at 360 px, rechecked with a targeted probe after the final grid fix) |
| Pages whose whole content is a live region (`#content aria-live`) | 47 | 0 |
| Controls without an accessible name | 0 | 0 |
| Focus ring contrast on white (non-text, 1.4.11) | 2.78:1 (`#a18ded`) | 7.06:1 (`#5a43bd`) |
| Input border contrast on white | ~1.3:1 | 3.43:1 |

What changed (batch 3):

- `web/accessibility.css`, loaded last: accessible shades of the palette for muted text, focus rings, links and
  control borders; a 12 px floor for readable text; 18 px checkboxes; reflow fixes (`min-width:0` on fields,
  `overflow-wrap:anywhere` on code, wrapping panel headers, single-column recipe fields under 600 px, a recipe form track that can shrink); the closed
  mobile sidebar no longer casts its shadow; `prefers-reduced-motion` also stops smooth scrolling.
- `#content` is no longer a live region, so a route change is not read aloud in full; results still announce through
  the toast (`role=status`) and alerts.
- A page that fails to open shows a page-level error with the cause, "Try again" and a way back (`role=alert`,
  focused heading) instead of a six-second toast over a page stuck on "Opening…". The toast timer restarts for each
  message.
- Destructive actions ask first through one styled dialog that names the consequence, with Cancel focused: revoking an
  MCP client, a connector token or all write access; removing a sign-in method; cancelling a plan; removing a
  member; deleting a schedule, snapshot, template or saved report; enabling report retention cleanup.
- Dialogs have accessible names; the active navigation link has `aria-current="page"`; page titles are capitalised.
- Reporting: metric formulas are visible text under each metric (not hover-only tooltips); the results table is a
  labelled, keyboard-focusable scroll region; report dates use the viewer's language.
- Back/Forward uses the current page renderer, so a reviewer's scoped navigation also applies after Back.

Guarded by `tools/check-web.mjs` (part of `npm run check`): no inline scripts, styles or handlers (CSP), every
referenced asset exists, `accessibility.css` is the last stylesheet, `#content` is not a live region, the
confirmation dialog exists and is named, and no script uses native `confirm()` except the one synchronous
unsaved-changes guard. The check fails on `03ac8d3` with six violations and passes after.

Batch 6: every action bound through `authBind` returns keyboard focus to its control after a re-render, or to the
first control of its surviving section, or to the page heading — never to the body (checked in Chromium on the
settings page: "Refresh health" keeps focus; pausing writes moves it to "Resume writes"). MFA setup has numbered
steps, an open-in-authenticator link built from the server's `otpauth://` URI, a grouped, copyable key and copy or
download of the recovery codes. Removing a workspace member is its own confirmed button instead of a role.

Batch 9 (reporting): the results table's column headers have `scope="col"` and each campaign cell is the row header
(`<th scope="row">`, styled as before), so a screen reader names the campaign and the metric for every value. The
identity line shows the report's time zone beside the currency. Period and summary dates use the viewer's locale
instead of raw ISO dates. The table's secondary text (IDs, currency, time zone and source details) moved from
#9b8ba9 at 3.15:1 and #8f7aa2 at 3.84:1, both 10 px, to the muted ink at 5.32:1 and 12 px; the column headers also
move to 12 px (4.81:1 on their tint).

Batch 19: the same audit, same pages and widths, finds **0** texts below contrast (from 60), no horizontal overflow and
no unnamed control.

- Real text keeps its hue, darkened until it reaches 4.6:1 on its own background: dashboard captions, report pill
  labels, platform counts and section numbers, the homepage step numbers, the AI-tool and evidence labels, the account
  initial, and the platform initials in their brand hue. `--muted` is now `#696678` (was `#6c697b`), so muted text also
  passes on the light tints: it was 4.41:1 on the active filter tab and 4.44:1 under report metrics. Text at 10px or
  less moved to the 12px floor.
- The two homepage mock-ups, the workflow window and the example campaign plan, hold text at 6 to 8px. They are now
  labelled images (`role="img"` with a description of what they show), so their text is part of a picture, which WCAG
  1.4.3 exempts. The audit leaves out text inside `role="img"`, as assistive technology does.
- Decorative glyphs (the report spark, stat icons, link arrows, the account initial) are `aria-hidden`.
- Text fields, text areas and table cells take their direction from their own text (`unicode-bidi: plaintext`): an
  Arabic campaign name starts at the right edge of its cell, English names and numbers at the left (F-47).
- The design tokens are defined once, in `web/tokens.css` (F-40).

Batch 27: target size, WCAG 2.2 success criterion 2.5.8 (F-82). The audit now evaluates the criterion with its exceptions: a
control and its label count as one target; a link is exempt when it is inline in a sentence; a smaller target passes
when a 24 px circle centred on it meets no other target and no other small target's circle. Before and after were measured on fresh local sites built from the
same code, one serving the web assets of `e21ec88` and one those of batch 27.

| Measure (49 page/width combinations, 1,368 targets) | Before | After |
|---|---:|---:|
| Targets below 24 × 24 px | 197 | 116 |
| of which links inside sentences (exempt) | 45 | 45 |
| of which spaced as the criterion allows | 98 | 71 |
| **of which failing** | **54** | **0** |

- Plain disclosure summaries (18 px) gain 3 px above and below; the native-metrics summary (14 px), text links such as
  "Manage connections ↗" (15 px) and selects without their own sizing (21 px) are at least 24 px tall. The pages grow
  by 0 to 28 px, and the reporting page by up to 239 px at 360 px with every platform open.
- The Sheets delivery policy on the reporting page was an unstyled label and select at the panel's edge; it now
  matches the report's other fields (F-83).
- The same full audit afterwards: 0 texts below contrast, no horizontal overflow, no unnamed control, no duplicate
  id, and only the three expected console errors of the anonymous OAuth result page.

2026-10-09 (review ticket WEB-01): keyboard, skip-link and contrast defects found by the 2026-10-08 review.

| State | Before | After |
|---|---:|---:|
| Focus ring on the dark sidebar, light theme | 2.32:1 (`#5a43bd` on `#201d30`) | 8.48:1 (`--focus-on-inverse` `#c7adff`) |
| Focus ring on the toast / connector hero (worst gradient stop) | 2.11:1 / 2.28:1 | 7.72:1 / 6.15:1 |
| Focused skip link, dark theme | 1.15:1 (literal white background, inherited light ink) | 13.70:1 (`--ink` on `--white`) |
| `.source-diagnostic > strong` on the dark Activity failure surface | 1.82:1 | 8.38:1 (`--danger`) |
| Schedule-row and custom-metric secondary text, light theme | 3.37:1 and 3.52:1 at 11px | `--muted` at 12px |
| Recommendation decisions, dark theme | Scale and Needs review shared one colour | five token pairs, each 4.5:1 or more in both themes, plus a symbol (↑ → ↓ ‖ •) |

- Skip links and in-page jumps (`#main`, `#overview-config`) move focus to their section without a history entry; a
  history step that changes only the fragment no longer re-renders the route, so typed input survives and no request
  repeats. Back to a different path or query still renders it.
- The landing page's section jump scrolls instantly under `prefers-reduced-motion: reduce`.
- At 850px and narrower the top-bar buttons and breadcrumb keep the 12px floor.
- Guards: `tests/website-contrast.test.mjs` computes these pairs from the shipped stylesheets;
  `tests/website-navigation.test.mjs` covers the fragment and reduced-motion paths; the rendered runner
  (`tools/browser-workflow-qa.mjs`) now measures the focused skip link (4.5:1), the next focus ring after it and the
  connector-hero ring (3:1), checks that the next Tab lands inside the main content, and on `/measurement` and
  `/reporting-overview` that a typed value survives the skip link with no `/api` request.

Nothing from this report remains open.
