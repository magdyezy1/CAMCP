---
status: reference
tier: engineering
---

# AMCP identity and interface migration

The current repository uses AMCP naming throughout source, generated catalogs, fixtures, documentation and website assets. Historical Git commits are retained; this release does not rewrite repository history. Baseline metadata is normalized development input, not an untouched external transcript. Vendor-owned schemas and their embedded notices retain their attribution.

The canonical metadata gateway is `amcp_tool_help`, the native workspace workflow gateway is `amcp_native_action`, and the baseline platform-workspace gateway is `amcp_platform_workspace`. The newer `amcp_workspace` readiness/profile tool keeps its name. Reload the server's tool list in existing MCP clients after upgrading. Old branded tool identifiers are no longer advertised or accepted. Provider-specific gateways and the prepare/review/execute contract keep their existing names and behavior.

The website uses ink (`#222137`), iris (`#7661df`), apricot (`#ffbd96`) and warm paper (`#f7f6fa`), defined once in
`web/tokens.css`, which loads before every other stylesheet. It includes:

- A public homepage with a clearly labeled workflow illustration, feature panels and working links into the product.
  It is for visitors who are not signed in: a signed-in visitor to `/` goes to Home (`/dashboard`), by a 302 from the
  server and in place in the shell (owner decision P12, DOC-03).
- Dedicated sign-in, account creation, verification and password recovery screens.
- A personal account/security page with explicit provider-configuration states.
- A workspace sidebar, responsive mobile navigation and keyboard page search (`Ctrl/Cmd + K`).
- Overview entry points derived from actual connected accounts, quick actions, readiness and capability evidence.
- Existing campaign, media, reporting, profile and connector operations under the same visual system.

Homepage illustrations contain no fabricated account metrics. New accounts begin with their own empty workspace. Reduced-motion preferences are respected, navigation supports keyboard focus, forms have visible labels, and account data responses use `Cache-Control: no-store`.

Google, Apple and Facebook sign-in require the separate app credentials documented in [user accounts](USER-ACCOUNTS.md). No advertising-account writes, hosting changes or DNS changes are required to test the design locally.

## Accessible shades (2026-09-28)

`web/tokens.css` holds three shades of the same palette so text and controls meet WCAG 2.1 AA on the light surfaces:
`--muted` `#696678` (the lightest text colour, 4.6:1 or more on paper, white and the light tints), `--iris-700`
`#5a43bd` (focus rings and links, 7.06:1 on white) and `--line-strong` `#8e87a0` (input borders, 3.43:1 on white).
`web/accessibility.css` loads after every other stylesheet and applies them: focus rings are 2 px `--iris-700` with a
2 px offset, on every focusable element (a scroll region Chrome makes focusable included), and readable text is at
least 12 px. Surfaces that stay dark in the light theme (the toast, connector hero, callback header and the
landing page's closing band) use `--focus-on-inverse` instead, and recommendation decisions use the `--decision-*`
pairs. Measurements are in [the accessibility report](review/ACCESSIBILITY.md).
`tools/check-web.mjs` keeps `tokens.css` first (and `public-tokens.css` second on the static public pages) and refuses
a token defined in any other stylesheet. The shades of individual components (about 500 one-off tints) were written
where they were used until WEB-07 made them tokens too ([below](#component-colours-from-tokens-web-07-2026-10-18)).

## One theme source (WEB-07, 2026-10-17)

`web/tokens.css` sets every colour for both themes: the palette above and the semantic roles components should use
(`--surface`, `--surface-raised`, `--text`, `--text-secondary`, `--link`, `--border`, `--border-strong`, `--focus`,
`--status-{success,warning,danger}-{bg,ink}`, and the theme-invariant `--surface-inverse`/`--text-on-inverse` of the
sidebar). The dark values sit in `:root[data-theme='dark']` (chosen in Appearance, or the system's under System).
`web/public-tokens.css`, which the static public pages load right after it, adds the policy pages' own shades
(`--policy-*`, with their dark values) and the same dark values again in `@media (prefers-color-scheme: dark)
{ :root:not([data-theme]) }`, so Privacy, Terms, Data deletion and the 404 page follow a dark system with JavaScript
turned off; `privacy.css` writes no colour of its own. About loads it inside `<noscript>`, so it follows a dark system
without JavaScript too, and the workspace, which needs JavaScript (`theme.js` sets its theme before the styles load),
never downloads it. A computed-style comparison of About, Privacy, Terms, Data deletion, 404 and the workspace shell,
light and dark, with and without JavaScript, at 320 and 1280 pixels, found no difference from one `tokens.css`
holding everything (2026-10-17). A component written with the roles is right in dark mode without an entry in
`theme.css`, the older override layer, which the workspace still loads after the component sheets; what it still
decides is [below](#component-colours-from-tokens-web-07-2026-10-18).

About loads no `theme.css` (w4a, 2026-10-17): `about.css` takes every colour from tokens and carries the Appearance
control's rules, so About renders the same in dark mode with and without JavaScript. The override layer had given its
JavaScript-dark rendering quirks the light theme and the no-JavaScript dark rendering never had: the eyebrows and the
registration note in plain ink instead of the accent and muted ink, the footer muted, and a language error in plain
ink instead of the danger ink. Light mode and every no-JavaScript state are unchanged (computed-style comparison at
320, 375 and 1280 pixels, English and Arabic); in dark mode with JavaScript the eyebrows measure 10.5–12.0:1, the
registration note and the Appearance label 9.2:1 on their surfaces, and the footer's contrast rises.

`tools/check-colours.mjs` (part of `check-web`) checks, over both token sheets, that every colour token has a dark
value and that the two dark blocks agree, and counts the literal colours left in every shipped stylesheet (`tools/web-colour-baseline.json`):
a count may only go down. Brand marks and the printed page keep their literal colours by name in
`tools/web-colour-allowlist.json`, which may only shrink. `node tools/check-colours.mjs --explain web/<sheet>.css`
lists a stylesheet's literals; `--write` lowers the baseline after a migration. Declaring `--border` and `--surface`
also gave the review tables, measurement task links and report packs that already asked for them (with `#ddd` and
white fallbacks) the palette's line, which in dark mode replaces a light grey border on dark surfaces.

The workspace stylesheets no longer carry declarations that a later stylesheet overrides for the identical selector
(`app.css`, `identity.css` and `reporting.css`; most were the original shades WEB-01's contrast fixes in
`accessibility.css` replaced). Each overriding declaration parses in Chromium, and a computed-style comparison of every
element on every page, light and dark, at 1280 and 375 pixels, found no difference. Literal colours outside
`tokens.css`: 570 on Work-here (558 outside today's allow-list), then 452 (440 outside the 12 allow-listed brand and
print colours). The 122 declarations that a later rule of the same stylesheet, or a later stylesheet, overrides for the
identical selector at the same or a wider media condition left too (w4a, 2026-10-17: 34 in `app.css`, 73 in
`identity.css`, 15 in `reporting.css`, 49 of them literal colours): each overriding declaration parses in Chromium, and
a computed-style comparison of every element and every forced hover, focus and active state of the public and
workspace pages, light and dark, English and Arabic, at 375, 800 and 1280 pixels, found no difference. 391 literal
colours remained outside the allow-list.

## Component colours from tokens (WEB-07, 2026-10-18)

No stylesheet writes a colour of its own any more: `tools/web-colour-baseline.json` holds 0, and only the 12
allow-listed brand marks and the printed page keep literals. Each of the 391 became the palette, a semantic role, a
component shade or a theme-invariant colour in `web/tokens.css` (a translucent tint is a `color-mix()` of a token), and
no text may read worse than the literal it replaced: text gets darker on light surfaces and lighter on the inverse
ones, and a surface under dark text lighter and under light text darker. The control borders WEB-01's input rule had
missed got darker (below). Decorative borders, hover tints, shadows, dots and illustration shapes take the nearest
token, so some read a little lighter than their literal (listed below for the owner's sign-off). The component shades,
by what they colour:

- **Text.** `--text-strong` (the report builder's fields), `--text-soft` (notices, code, labels, chips),
  `--text-secondary-strong`, `--text-accent` and `--text-accent-strong` (purple secondary text: section numbers,
  summaries, badges, active tabs), `--text-warm` (on the warm callouts), `--danger-text` (form errors) and
  `--danger-strong` (danger buttons, failed activity), `--iris-soft` (icons, dots and the hero's highlighted word),
  `--apricot-700` (sparks on light surfaces), and `--platform-<name>` with `--platform-<name>-bg` for the report
  builder's platform initials.
- **Surfaces.** `--surface-selected` (active tabs and options), `--surface-warm`, `--surface-peach`, `--surface-cool`,
  `--paper-warm` (the public pages), `--accent-fill` (primary buttons) and the status tints
  `--{success,warning,danger}-bg-subtle`, beside the roles (`--surface`, `--surface-raised`, `--surface-subtle`, …).
- **Lines.** `--border-control` (buttons), `--border-accent` and `--border-accent-strong` (hover and selected
  outlines), `--{success,warning,danger}-line`, `--warning-dot`. The report builder, delivery dialog, team list,
  native settings and saved-report selects had 1.4:1 borders that WEB-01's input rule did not reach (a class beat it);
  they take `--border-strong` (3:1).
- **Theme-invariant** (one value in both themes; `tools/check-colours.mjs` lists them and refuses a dark value for
  them): the inverse surfaces (`--surface-inverse`, `-raised`, `-accent`) and what sits on them
  (`--text-on-inverse`, `-strong`, `-secondary`, `-muted`, `--border-on-inverse`, `--fill-on-inverse`, `-subtle`,
  `--accent-on-inverse`), `--overlay`, the three shadows, the online dot `--success-dot` and the illustrations'
  `--art-*` colours.

Every component shade has a dark value: where `theme.css` re-colours that component, its value there, so the override
layer and the token agree; where the light literal used to paint in dark mode too, the dark theme's ink or line. That
fixes dark-mode slips no override had reached: the icon buttons' ink (3.05:1 on the dark panel, now 8.07:1), a plan
step's text (3.04:1), the near-black ink of the controls the dark input rule skips (the report builder's checkboxes),
and light borders on platform logos and report options that lit up the dark page. The visible change in light mode is
that the one-off tints merged: secondary text is the palette's muted ink (slightly darker), purple accents are two
shades, icons one soft iris, the sidebar's links and labels lighter, and the hero's chip white on the iris (it was pale
lilac on a mid lilac).

Some lines and tints read a little lighter in light mode, none of which reached 3:1 against white before: container
borders of 1.31 to 1.46:1 take `--border` (1.29:1): the report table, delivery dialog, source health, report control
panel, target cards, delivery report context, notices, the empty state, the plan card and the command key; the
failed-activity panel and the AI feature card lose their faint rose and warm tints; the spinner's track is
`--surface-accent`; and hover tints are slightly closer to white (the buttons' `#f4f0fc`, 1.12:1 against white, is
`--surface`, 1.08:1). In dark mode the borders of the platform logos, report options, report platforms and the command
key, which painted their light literal there (11 to 13:1 on the dark panel), are the dark line (1.8:1). The owner's
visual sign-off of this increment covers these changes (package status B16).

`theme.css` still loads after the component sheets in the workspace, and its `:is()` groups often outrank the
component rules (a group takes the specificity of its most specific entry). Two IDs remain in the layer:
`#command-results button` in the raised-surface and hover groups and `#breadcrumb` in a muted-text group, which lift
each of those groups to ID specificity. Until wave 4b those groups also held the buttons, status badges, notices,
metric pills and feedback alerts, so in dark mode every primary and danger button looked like a plain one and warning
notices and status badges lost their tone (design review 2026-10, S1). Those components have left the groups or are
listed with a guard that leaves their variants out, and `tests/web-components.test.mjs` and
`tests/website-design-review.test.mjs` refuse a dark group that re-colours a variant. A checked metric pill keeps its
own rule in dark mode, `--surface-selected` with the `--iris` border, where its muted formula reads at 6.03:1. The
screenshots for the owner's sign-off of these colours, light and dark, are in the
[design review record](records/DESIGN-REVIEW-2026-10.md#7-web-07-colour-sign-off). Where a component's colour became a
component shade, the shade's dark value is the layer's value, so those entries only repeat the tokens; where a
component uses a palette role, an entry can still decide its dark colours: the measurement task links, for example,
take `--surface-subtle` and the ink there instead of `--paper` and `--iris-700`, and their hover and focus states the
layer's dark hover group. The entries that only repeated a token left on 2026-10-23 (B23), each removal proven by a
dark-mode computed-style comparison: what the layer still decides, and what changed, is in
[the design system](DESIGN-SYSTEM.md#the-dark-override-layer-themecss).

A computed-style comparison with the tree before (every element, `::before`/`::after`/`::marker`/
`::placeholder` and every forced hover, focus and active state) of the public and workspace pages of the empty
workspace, light and dark, English and Arabic, at 375 and 1280 pixels (256 page states), and of 23 populated fixture
kinds on their pages in both themes, found colour changes only (no layout, text or DOM difference) and no text whose
contrast against its surface went down. A first pass that merged every tint into the nearest role had lowered text
contrast on every page (the primary buttons 4.73 to 4.62:1, the status pills 8.51 to 7.08:1);
`tests/web-colours.test.mjs` keeps those pairs at or above the literals' contrast and checks the dark slips above.
`tokens.css` grew from 1,000 to about 1,650 Brotli bytes, its comments shortened, and the component sheets shrank
by more, so every page stays at or below its bytes before WEB-07 ([operations](OPERATIONS.md)).
