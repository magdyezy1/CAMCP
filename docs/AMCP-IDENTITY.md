# AMCP identity and interface migration

The current repository uses AMCP naming throughout source, generated catalogs, fixtures, documentation and website assets. Historical Git commits are retained; this release does not rewrite repository history. Baseline metadata is normalized development input, not an untouched external transcript. Vendor-owned schemas and their embedded notices retain their attribution.

The canonical metadata gateway is `amcp_tool_help`, the native workspace workflow gateway is `amcp_native_action`, and the baseline platform-workspace gateway is `amcp_platform_workspace`. The newer `amcp_workspace` readiness/profile tool keeps its name. Reload the server's tool list in existing MCP clients after upgrading. Old branded tool identifiers are no longer advertised or accepted. Provider-specific gateways and the prepare/review/execute contract keep their existing names and behavior.

The website uses ink (`#222137`), iris (`#7661df`), apricot (`#ffbd96`) and warm paper (`#f7f6fa`), defined once in
`web/tokens.css`, which loads before every other stylesheet. It includes:

- A public homepage with a clearly labeled workflow illustration, feature panels and working links into the product.
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
2 px offset, and readable text is at least 12 px. Surfaces that stay dark in the light theme (the sidebar, toast,
connector hero and callback header) use `--focus-on-inverse` instead, and recommendation decisions use the
`--decision-*` pairs. Measurements are in [the accessibility report](review/ACCESSIBILITY.md).
`tools/check-web.mjs` keeps `tokens.css` first (and `public-tokens.css` second on the static public pages) and refuses
a token defined in any other stylesheet. The shades of
individual components (about 500 one-off tints) are still written where they are used.

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
`theme.css`, the older override layer that still re-colours the components not yet migrated.

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
`tokens.css`: 570 on Work-here (558 outside today's allow-list), now 452 (440 outside the 12 allow-listed brand and
print colours, the count `tools/web-colour-baseline.json` holds).
