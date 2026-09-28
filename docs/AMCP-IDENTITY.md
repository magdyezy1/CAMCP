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
2 px offset, and readable text is at least 12 px. Measurements are in [the accessibility report](review/ACCESSIBILITY.md).
`tools/check-web.mjs` keeps `tokens.css` first and refuses a token defined in any other stylesheet. The shades of
individual components (about 500 one-off tints) are still written where they are used.
