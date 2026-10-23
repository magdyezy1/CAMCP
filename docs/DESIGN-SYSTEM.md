# AMCP design system

The website's tokens, components and the rules that keep them consistent: what to use when you build or change a page,
and what the checks refuse. It covers the public pages (landing, sign-in, About, Privacy, Terms, Data deletion, 404) and
the signed-in workspace. The identity behind it (ink, iris, apricot, warm paper) and the history of the colour migration
are in [AMCP identity](AMCP-IDENTITY.md); the rendered qualification is in [local browser QA](LOCAL-BROWSER-QA.md).

There is no framework: plain stylesheets under `web/`, classic scripts that write markup with the escape-by-default
`` html`…` `` tag, and a strict Content-Security-Policy (no inline styles or scripts, no `style` attributes; a script may
not write `element.style`). Everything below is therefore a class, a token or an attribute.

## Principles

1. **One theme source.** Every colour is a token in `web/tokens.css` with a light and a dark value, and no stylesheet
   writes a colour of its own. A new rule takes its radius, shadow, duration and type size from a token too; the values
   older rules still write by hand are counted, and the counts only go down (`tools/check-design-tokens.mjs`).
2. **Roles before shades.** Use the semantic roles (`--surface`, `--text`, `--border`, `--focus`, …) first; a component
   shade exists only where a role does not read well enough.
3. **Accessible by default.** Text reaches 4.5:1 and controls, borders that carry meaning and focus rings 3:1 against
   what they sit on, in both themes (WCAG 2.1 AA 1.4.3, 1.4.11). Readable text is at least 12px. Primary touch targets
   are 44 by 44 CSS pixels, nothing is below 24 (WCAG 2.2 2.5.8). Every control shows a visible focus ring.
4. **Both directions.** Layout uses logical properties (`inset-inline-start`, `margin-inline-end`, `padding-block`), so
   Arabic right-to-left needs no override; `tools/check-rtl.mjs` refuses a physical side without an allow-list entry.
   Native values (IDs, URLs, amounts) keep their own direction (`dir="ltr"`, `<bdi>`, `data-native`).
5. **State is semantic first.** A selected toggle says `aria-pressed`, a current page `aria-current`, a busy region
   `aria-busy`, an error `role="alert"`; the class that styles it is secondary.
6. **Motion is optional.** `prefers-reduced-motion: reduce` turns transitions and animations off.

## Stylesheets and their order

| Sheet | Loaded by | Holds |
|---|---|---|
| `tokens.css` | every page, first | every token, both themes (light in `:root`, dark in `:root[data-theme='dark']`) |
| `public-tokens.css` | the static public pages, second (About only inside `<noscript>`) | the policy pages' shades and the dark system a page read without JavaScript follows |
| `app.css` | workspace and sign-in | the reset, the shell layout and the core components' structure |
| `identity.css` | workspace and sign-in | the components' skin, the sidebar, the landing page and the sign-in screens |
| `workflows.css` | workspace | workflow pages: review tables, campaign steps, measurement, feedback alerts |
| `reporting.css` | workspace | report builder, report tables, delivery dialog, owner Settings |
| `localization.css` | workspace, About | the language control, the Arabic font and right-to-left exceptions |
| `theme.css` | workspace, policy pages | the Appearance control and the dark override layer that remains (below) |
| `accessibility.css` | workspace, About, last | focus rings, input borders, the 12px floor, target sizes |
| `about.css`, `privacy.css` | About; Privacy, Terms, Data deletion and 404 | those pages' own layout, from tokens only |

`tools/check-web.mjs` keeps `tokens.css` first, `public-tokens.css` second on the static public pages and off the
workspace, `accessibility.css` last in the workspace, and refuses a token defined outside the token sheets.

`theme.css` is the older dark override layer: `[data-theme='dark'] :is(…)` groups that re-colour components in the dark
theme. Its groups take the specificity of their most specific member, so one ID in a group outranks every component
rule that names a class. Do not add to it: give the component a token whose dark value is right. What it still decides is
being reduced (package status B23).

## Tokens

### Colour

The palette, the semantic roles, the component shades and the theme-invariant colours. Light values are in `:root`; the
dark values in `:root[data-theme='dark']` and, mirrored for a page without JavaScript, in `public-tokens.css`'s
`@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`. A dash means the token follows another token, so it
changes with the theme through that token.

**Palette**

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ink` | `#222137` | `#f2edf8` | body text |
| `--muted` | `#696678` | `#c0b5ce` | the lightest text colour (4.6:1 or more on every light surface) |
| `--iris` | `#7661df` | `#c7adff` | brand accent, selected indicators |
| `--iris-700` | `#5a43bd` | `#decaff` | links and the focus ring (7.06:1 on white) |
| `--apricot` | `#ffbd96` | `#ffbf9b` | brand warmth |
| `--paper` | `#f7f6fa` | `#181522` | the page; also `theme-color` |
| `--white` | `#fff` | `#252032` | raised surfaces (panels, cards, inputs) |
| `--line` | `#e5e1eb` | `#51475f` | decorative borders and dividers |
| `--line-strong` | `#8e87a0` | `#988aab` | control borders (3.43:1 on white) |
| `--danger` | `#af3939` | `#ffb6bf` | danger ink |
| `--surface-subtle` | `#f3f0f8` | `#30293f` | quiet fills |
| `--surface-accent` | `#e9e2f6` | `#403153` | accented fills, the dark hover surface |
| `--on-accent` | `#ffffff` | `#21172f` | text on `--iris` and `--accent-fill` |
| `--success-bg`, `--success-ink` | `#e6f3ed`, `#245d49` | `#18382e`, `#a5e5c4` | success pair |
| `--warning-bg`, `--warning-ink` | `#fff3db`, `#714b14` | `#3d2e19`, `#f6d89e` | warning pair |
| `--danger-bg` | `#fce5e8` | `#452830` | danger fill |
| `--focus-on-inverse` | `#c7adff` | `#decaff` | the focus ring on the inverse surfaces (sidebar, toast, connector hero, callback header) |

**Semantic roles** (use these first)

| Token | Follows | Use |
|---|---|---|
| `--surface` | `--paper` | page and inset surfaces |
| `--surface-raised` | `--white` | cards, panels, dialogs, inputs |
| `--text` | `--ink` | text |
| `--text-secondary` | `--muted` | secondary text |
| `--link` | `--iris-700` | links |
| `--border` | `--line` | container borders |
| `--border-strong` | `--line-strong` | control borders that must reach 3:1 |
| `--focus` | `--iris-700` | focus rings on ordinary surfaces |
| `--status-success-bg`, `--status-success-ink` | `--success-bg`, `--success-ink` | success state |
| `--status-warning-bg`, `--status-warning-ink` | `--warning-bg`, `--warning-ink` | warning state |
| `--status-danger-bg`, `--status-danger-ink` | `--danger-bg`, `--danger` | danger state |

**Recommendation decisions** (one pair per decision meaning, with a symbol so colour is not the only cue)

`--decision-positive-bg`, `--decision-positive-ink` (scale, the success pair), `--decision-steady-bg`,
`--decision-steady-ink` (maintain: `#e6eafa`/`#3f4b85`, dark `#232c4d`/`#c3ccff`), `--decision-caution-bg`,
`--decision-caution-ink` (pull back, the warning pair), `--decision-negative-bg`, `--decision-negative-ink`
(reconsider or pause, the danger pair), `--decision-hold-bg`, `--decision-hold-ink` (wait, needs review, needs a target,
insufficient data, observe: `--surface-subtle`/`--muted`).

**Component shades** (where a role reads too light or too flat; every one has a dark value)

| Group | Tokens |
|---|---|
| Text | `--text-strong` (report builder fields), `--text-soft` (notices, code, labels, chips), `--text-secondary-strong`, `--text-accent`, `--text-accent-strong` (purple secondary text: section numbers, summaries, badges, active tabs), `--text-warm` (on the warm callouts), `--danger-text` (form errors), `--danger-strong` (danger buttons, failed activity), `--iris-soft` (icons, dots), `--apricot-700` (sparks on light surfaces) |
| Surfaces | `--surface-selected` (active tabs and options), `--surface-warm`, `--surface-peach`, `--surface-cool`, `--paper-warm` (the public pages), `--accent-fill` (primary buttons), `--success-bg-subtle`, `--warning-bg-subtle`, `--danger-bg-subtle` (status tints) |
| Lines | `--border-control` (buttons), `--border-accent`, `--border-accent-strong` (hover and selected outlines), `--success-line`, `--warning-line`, `--danger-line`, `--warning-dot` |
| Platforms | `--platform-google`, `--platform-google-bg`, `--platform-meta`, `--platform-meta-bg`, `--platform-tiktok`, `--platform-tiktok-bg`, `--platform-snapchat`, `--platform-snapchat-bg`, `--platform-linkedin`, `--platform-linkedin-bg`, `--platform-microsoft`, `--platform-microsoft-bg` (the report builder's platform initials; ink on the accent fill in dark) |

**Theme-invariant** (one value in both themes; `tools/check-colours.mjs` refuses a dark value for them)

| Group | Tokens |
|---|---|
| Inverse surfaces | `--surface-inverse` (`#201d30`: sidebar, toast, connector hero, callback header), `--surface-inverse-raised`, `--surface-inverse-accent` |
| On the inverse surfaces | `--text-on-inverse`, `--text-on-inverse-strong`, `--text-on-inverse-secondary`, `--text-on-inverse-muted`, `--border-on-inverse`, `--fill-on-inverse`, `--fill-on-inverse-subtle`, `--accent-on-inverse` |
| Overlay and shadow colours | `--overlay` (dialog backdrop), `--shadow-soft`, `--shadow`, `--shadow-strong` |
| Status dot | `--success-dot` |
| Illustrations | `--art-iris`, `--art-frame`, `--art-spark`, `--art-lilac`, `--art-plum`, `--art-mist`, `--art-apricot`, `--art-cream`, `--art-highlight` |

**Policy pages** (`public-tokens.css`, loaded only by the static public pages): `--policy-surface`, `--policy-text`,
`--policy-text-body`, `--policy-text-intro`, `--policy-text-strong`, `--policy-lead`, `--policy-text-secondary`,
`--policy-eyebrow`, `--policy-accent`, `--policy-link`, `--policy-link-hover`, `--policy-nav-link`,
`--policy-contents-link`, `--policy-border`, `--policy-border-subtle`, `--policy-border-strong`, `--policy-code`,
`--policy-shadow`. Each reaches 4.5:1 on the policy surfaces in light, dark and system-dark (`tests/web-colours.test.mjs`).

### Corner radius

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4px | code chips, tags, keyboard keys |
| `--radius-sm` | 8px | compact controls: the top bar's selects, chips, filter tabs, icon buttons, skip links |
| `--radius-md` | 10px | buttons, text fields and selects, notices and feedback alerts, list rows, icon tiles |
| `--radius-lg` | 12px | cards, callouts, status strips, the toast, report blocks |
| `--radius` | 17px | panels, stat cards and the other large cards |
| `--radius-xl` | 22px | dialogs, hero cards, the report builder |
| `--radius-pill` | 999px | status badges, pills, the Settings sub-navigation, About's buttons |

Circles use `50%`. The landing page's and About's illustrations keep their own shapes (arches, frames, orbits), and
the report builder narrows to 14px on phones.

### Elevation

| Token | Value | Use |
|---|---|---|
| `--elevation-1` | `0 5px 20px var(--shadow-soft)` | resting panels |
| `--elevation-2` | `0 10px 35px var(--shadow-soft)` | raised surfaces: the report builder, a hovered platform card |
| `--elevation-3` | `0 24px 100px var(--shadow-strong)` | dialogs |

The other shadows are a component's own: the toast, the primary button's glow, the current sidebar link, the mobile
drawer, the delivery dialog's sticky status bar and the illustrations. The shadow colours are theme-invariant.

### Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 0.15s | borders and small lifts (platform cards, quick actions) |
| `--duration` | 0.18s | buttons and the mobile navigation drawer |

`prefers-reduced-motion: reduce` turns every transition and animation off (`identity.css`) and smooth scrolling with
them (`accessibility.css`).

### Type scale

| Token | Value | Use |
|---|---|---|
| `--type-xs` | 12px | captions, notes (`.form-note`), table headers, small buttons: the readable floor |
| `--type-sm` | 13px | secondary copy, tabs, notices, labels |
| `--type-md` | 14px | body copy of panels and controls (the button's size) |
| `--type-lg` | 16px | card titles; inputs on phones, so iOS does not zoom |
| `--type-xl` | 22px | section headings (`h2`) |

Page titles and display type (26 to 75px) stay with their page. The interface font is Aptos (Aptos Display for
headings) with Segoe UI as fallback; Arabic uses Noto Sans Arabic (`localization.css`), with letter spacing reset.
Some decorative text (the landing illustrations, the sidebar's section labels) is still below 12px; new readable text
uses `--type-xs` or larger.

### Spacing

Spacing stays component geometry rather than a token scale: the stylesheets write 868 padding, margin and gap
declarations with 82 distinct lengths, many tuned so a page reflows at 320 pixels without sideways scrolling, and
snapping them to a scale would move layouts the rendered qualification has measured. New rules use multiples of 4px
(4, 8, 12, 16, 20, 24, 32; a 1px or 2px nudge is allowed). `tools/check-design-tokens.mjs` counts the declarations off
that grid per stylesheet (469 when the ratchet was recorded), and a count may only go down.

## Checks

`node tools/check-web.mjs` (part of `npm run check`) runs them all; each has a test in the default suite.

| Check | Refuses | Baseline or list |
|---|---|---|
| `tools/check-colours.mjs` | a colour token without a dark value or with a dark value that differs without JavaScript; a literal colour in a stylesheet; a literal colour in a script or page outside the reviewed list (data defaults, QR pixels, the downloaded report document, by file, value, context and count); a `theme-color` that is not `--paper` | `tools/web-colour-baseline.json` (0), `tools/web-colour-allowlist.json` (only shrinks); `tests/web-colours.test.mjs` |
| `tools/check-design-tokens.mjs` | a radius, shadow, duration or type size written by hand, or a padding, margin or gap off the 4px grid, above its stylesheet's count; a custom property read by a stylesheet and defined in no token sheet | `tools/web-design-token-baseline.json` (only goes down); `tests/web-design-tokens.test.mjs`, which also requires every token to be documented here |
| `tools/web-route-bytes.mjs` | a page that downloads more (Brotli) before it renders than its recorded value | `tools/web-route-bytes-baseline.json`; `tests/web-route-bytes.test.mjs` |
| `tools/check-markup.mjs` | new markup escaped by hand instead of `` html`…` `` | `tools/web-markup-baseline.json` |
| `tools/check-rtl.mjs` | a physical left or right side in a stylesheet | its allow-list |
| `check-web` itself | inline scripts, styles and handlers; a token defined outside the token sheets; the stylesheet order; an unnamed dialog; `confirm()` | — |
| `tests/website-contrast.test.mjs` | shell colour pairs below 4.5:1 (text) or 3:1 (focus) in either theme | — |
| rendered qualification | WCAG rules (axe-core), focus rings below 3:1, a focused control hidden by a sticky layer, sideways scrolling, Arabic leaks | [local browser QA](LOCAL-BROWSER-QA.md) |

`node tools/check-colours.mjs --explain web/<sheet>.css` and `node tools/check-design-tokens.mjs --explain
web/<sheet>.css` list what a sheet still writes by hand; `--write` lowers a baseline after a migration and refuses a
count above its limit.

## Changing the system

- **A colour.** Add the token to `tokens.css` with its dark value in `:root[data-theme='dark']`, mirror the dark value
  in `public-tokens.css`'s no-JavaScript block, and document it above. A theme-invariant colour goes in the
  theme-invariant group and on `themeInvariantTokens` in `tools/check-colours.mjs`. Check text at 4.5:1 and borders
  that carry meaning at 3:1 in both themes.
- **A scale value.** Prefer an existing step. A new step goes in `tokens.css` (one value for both themes), in the
  table above, and in the components that need it.
- **A component.** Build it from the roles and scales, give it hover, focus, disabled, busy and error states where it
  has them, name its controls, and document it here. Its dark appearance comes from its tokens: never add a
  `theme.css` entry.
- **Removing a `theme.css` entry.** Prove it: a computed-style comparison of every element (and `::before`,
  `::after`, `::marker`, `::placeholder`, `::selection`), at the rendered pages' states and with forced hover, focus
  and active states, with and without the entry, must find no difference; or, where it finds one, the difference
  must be a fix of the component's intended look, with its contrast measured (see below).
- **Bytes.** A page may not download more than its recorded value. Re-record `tools/web-route-bytes-baseline.json`
  only in a commit of its own, when a page legitimately grows or shrinks.
