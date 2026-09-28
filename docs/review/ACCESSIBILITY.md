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

Remaining (see [FINDINGS.md](FINDINGS.md)): 60 low-contrast labels, mostly inside the landing-page illustration and
a few workspace captions; small inline links (target size is a WCAG 2.2 criterion); a QR code for MFA setup (needs a
vendored encoder, since the CSP allows only same-origin scripts); right-to-left layout (F-47).
