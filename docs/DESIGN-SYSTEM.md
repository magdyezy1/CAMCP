---
status: reference
tier: engineering
---

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
| `tokens-v2.css` | the static public pages (third), and routes that use V2 as a page asset | the V2 tokens and every legacy token with its existing value ([V2 token sheet](#v2-token-sheet)) |
| `components*.css`, `design-system.css` | routes that list them as page assets, before `accessibility.css` | the V2 components and the state page's layout, from tokens only ([V2 components](#v2-components-amcpui)) |

`tools/check-web.mjs` keeps `tokens.css` first, `public-tokens.css` second on the static public pages and off the
workspace, `accessibility.css` last in the workspace, and refuses a token defined outside the token sheets.

`theme.css` is the older dark override layer: `[data-theme='dark'] :is(…)` groups that re-colour components in the dark
theme. Its groups take the specificity of their most specific member, so one ID in a group outranks every component
rule that names a class. Do not add to it: give the component a token whose dark value is right. What it still decides,
and what left it, is [below](#the-dark-override-layer-themecss).

## V2 token sheet

`web/tokens-v2.css` is the foundation for page adoption. It contains every legacy token with its existing value, so
loading it after the token sheets a page already has changes no legacy token (`tests/web-tokens-v2-components.test.mjs`
resolves every token in light, dark and, where the page has it, system-dark, with and without the sheet). Redesigned
components choose the V2 names below. Its explicit dark theme and system-dark theme have equal declarations; both are
checked independently of the loaded token sheets.

**Where it loads.** The static public pages (Privacy, Terms, Data deletion and 404, in both languages) link it third,
after `public-tokens.css`. The workspace shell (`index.html`) and About do not: the sheet is 2,374 Brotli bytes, and
`en /about`, `en /report-library` and `en /reporting-overview` have 52, 343 and 1,197 bytes of room under their recorded
route budgets, which are not raised for it. A route that uses V2 lists the sheet among its page assets, directly or
through a component sheet that depends on it (`web/route-assets.js`), so it reaches only the routes that need it.

### V2 colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--v2-paper` | #fffdf8 | #17141f | Main surface |
| `--v2-violet` | #7462e7 | #9085e9 | Primary control fill |
| `--v2-on-violet` | #ffffff | #17141f | Text on that fill |
| `--v2-violet-text` | #5a43bd | #c7adff | Accent text on paper |
| `--v2-peach` | #ffbd96 | #ffbf9b | Marker only |
| `--v2-ink` | #222137 | #f2edf8 | Main text |
| `--v2-ink-2` | #696678 | #c0b5ce | Secondary text |
| `--v2-rule` | #e5e1eb | #51475f | Decorative rule |
| `--v2-rule-strong` | #8e87a0 | #988aab | Control boundary |
| `--v2-data-1` | #6250d6 | #9085e9 | Data series |
| `--v2-data-2` | #eb6834 | #d95926 | Data series |
| `--v2-data-3` | #1baf7a | #199e70 | Data series requiring direct labels |
| `--v2-raised` | #ffffff | #252032 | Raised surface: cards, inputs, dialogs |
| `--v2-subtle` | #f5f2fa | #2e273b | Quiet fill: hovered rows, table headers, the neutral badge, skeletons |
| `--v2-selected` | #ece6f8 | #392f5c | Selected fill |
| `--v2-success`, `--v2-success-bg` | #245d49, #e6f3ed | #a5e5c4, #18382e | Success text and its tint |
| `--v2-warning`, `--v2-warning-bg` | #714b14, #fff3db | #f6d89e, #3d2e19 | Warning text and its tint |
| `--v2-danger`, `--v2-danger-bg` | #af3939, #fce5e8 | #ffb6bf, #452830 | Danger text and its tint |
| `--v2-danger-solid`, `--v2-on-danger` | #af3939, #ffffff | #d4566c, #17141f | A destructive fill and its text |
| `--v2-info`, `--v2-info-bg` | violet-text, selected | violet-text, selected | Information text and its tint |

Text pairs meet 4.5:1 in both themes, including on-violet on violet and every status on its tint. Strong rules and the
first two data series meet 3:1 against paper, raised and subtle surfaces. Data-3 has about 2.77:1 in light mode: use
direct labels and another distinguishing cue; never rely on that colour alone. Peach is a marker, with an icon or text
beside it, and nothing is written on it: ink on peach measures 1.38:1 in dark. Two more pairs fail as text and are never
used: ink-2 on rule (4.32:1 light, 4.45:1 dark) and violet-text on rule in dark (4.49:1); rule is a line or a track, not
a surface for words. Logo files are the brand kit's, byte for byte: `docs/records/BRAND-KIT-V1-2026-11-07.md`.

`public-tokens.css` names each of the 18 policy shades for V2, in its light block only, because each follows its shade
through the theme: `--v2-policy-surface`, `--v2-policy-text`, `--v2-policy-text-body`, `--v2-policy-text-intro`,
`--v2-policy-text-strong`, `--v2-policy-lead`, `--v2-policy-text-secondary`, `--v2-policy-eyebrow`,
`--v2-policy-accent`, `--v2-policy-link`, `--v2-policy-link-hover`, `--v2-policy-nav-link`,
`--v2-policy-contents-link`, `--v2-policy-border`, `--v2-policy-border-subtle`, `--v2-policy-border-strong`,
`--v2-policy-code` and `--v2-policy-shadow`. A page restyled for V2 repoints a V2 name when it adopts a new value.

Legacy `--ink`, `--muted`, `--line`, `--line-strong` and `--apricot` alias the corresponding V2 token in both themes.
`--iris-700` aliases violet-text in light, and `--iris` does so in dark. Other legacy values, including `--paper`, retain
their current definitions.

### V2 scales

| Token | Value |
|---|---|
| `--v2-space-1`, `--v2-space-2`, `--v2-space-3`, `--v2-space-4` | 4px, 8px, 12px, 16px |
| `--v2-space-5` | clamp(16px, 13.71px + 0.714vw, 24px) |
| `--v2-space-6` | clamp(24px, 21.71px + 0.714vw, 32px) |
| `--v2-space-7` | clamp(32px, 27.43px + 1.429vw, 48px) |
| `--v2-space-8` | clamp(40px, 33.14px + 2.143vw, 64px) |
| `--v2-text-xs`, `--v2-text-sm`, `--v2-text-md` | 12px, 14px, 16px |
| `--v2-text-lg` | clamp(18px, 16.86px + 0.357vw, 22px) |
| `--v2-text-xl` | clamp(22px, 20.29px + 0.536vw, 28px) |
| `--v2-text-2xl` | clamp(28px, 24.57px + 1.071vw, 40px) |
| `--v2-text-kpi` | clamp(32px, 25.14px + 2.143vw, 56px) |
| `--v2-numeric` | tabular-nums |
| `--v2-radius-control`, `--v2-radius-card`, `--v2-radius-round` | 8px, 12px, 999px |
| `--v2-shadow-overlay` | 0 10px 35px var(--shadow-soft), equal to the legacy elevation-2 |
| `--v2-elevation-overlay` | var(--v2-shadow-overlay) |
| `--v2-duration-fast`, `--v2-duration`, `--v2-duration-slow` | 120ms, 180ms, 280ms |
| `--v2-ease` | cubic-bezier(0.2, 0, 0, 1) |
| `--v2-z-raised`, `--v2-z-sticky`, `--v2-z-drawer` | 10, 20, 30 |
| `--v2-z-overlay`, `--v2-z-dialog`, `--v2-z-toast` | 40, 50, 60 |
| `--v2-control-height` | 40px by default; 32px in compact density |
| `--v2-row-height` | 44px by default; 32px in compact density |
| `--v2-row-height-compact` | 32px: a table's own density toggle, whatever the page's density |
| `--v2-target-min`, `--v2-target-primary` | 24px, 44px: the smallest target of any control; the target of a primary action |
| `--v2-focus-width`, `--v2-focus-offset` | 2px, 2px: the ring every component draws, in the `--focus` colour |

The larger spacing and type steps clamp between 320px and 1440px; 12px is the type floor. Under
`prefers-reduced-motion: reduce`, all three V2 durations are 0s. Use tabular numerals for comparable numbers.

### Viewport tiers and density

The V2 layout tiers are compact below 600px, medium at 600–1023px, and wide from 1024px. Components use container
queries where possible. Qualification at 320px, 768px and 1280px samples those tiers. The density preference is
independent of viewport width: `:root[data-density='compact']` selects the compact control and row heights, while the
default keeps 40px controls and 44px rows. The sheet supplies this switch; pages add its user control when they adopt
V2.

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
| `--focus-on-inverse` | `#c7adff` | `#decaff` | the focus ring on the inverse surfaces (toast, connector hero, callback header) |

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
| Inverse surfaces | `--surface-inverse` (`#201d30`: toast, connector hero, callback header), `--surface-inverse-raised`, `--surface-inverse-accent` |
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
The website's local WOFF2 subset is 68,180 bytes and covers the declared Arabic ranges, with weights 100–900 and
width fixed at 100. Latin text uses the system stack. The original TTF remains the PDF font; its bytes are unchanged.
Both browser font faces swap on load. Tool versions, glyph coverage and hashes are in
[the font reference](../web/fonts/README.md).
Some decorative text (the landing illustrations, the sidebar's section labels) is still below 12px; new readable text
uses `--type-xs` or larger.

### Spacing

Spacing stays component geometry rather than a token scale: the stylesheets write 868 padding, margin and gap
declarations with 82 distinct lengths, many tuned so a page reflows at 320 pixels without sideways scrolling, and
snapping them to a scale would move layouts the rendered qualification has measured. New rules use multiples of 4px
(4, 8, 12, 16, 20, 24, 32; a 1px or 2px nudge is allowed). `tools/check-design-tokens.mjs` counts the declarations off
that grid per stylesheet (468 on 2026-10-23), and a count may only go down.

## Components

Each entry lists its markup, variants and states, what assistive technology meets, and what to avoid. Every focusable
control gets the shared focus ring: 2px `--focus` with a 2px offset (`accessibility.css`), `--focus-on-inverse` on the
inverse surfaces, and a 3px ring where a control sits on a busy surface (the report library and delivery dialog, the
measurement task links, the evidence row controls).

### Button

- **Markup.** `<button class="button">` for an action, `<a class="button" href>` for navigation that looks like one.
- **Variants.** `primary` (the main action of a view: `--accent-fill`, `--on-accent` text), `danger` (destructive:
  `--danger-strong` text and `--danger-line` border on the raised surface), `quiet` (low emphasis: no border or fill
  until hovered), `dark` (the inverse fill of the public pages and connection prompts, `--text-on-inverse-strong`), and
  the sizes `small` (33px), the default (40px), `large` (52px) and `full` (full width). Each variant looks the same in
  both themes through its tokens (in dark: primary on `--iris`, danger in `--danger` ink and border on the panel).
- **States.** Hover: `--surface` with `--border-accent` (dark: `--surface-accent` with `--line-strong`), quiet buttons
  included; primary `--iris-700` and a 1px lift; danger `--danger-bg-subtle` (dark `--danger-bg`). A dark button has no
  hover of its own: in light mode it keeps its inverse fill under the pointer, and in dark mode the dark layer's hover
  group gives it the plain dark hover (`--surface-accent`, `--ink` at 10.2:1, `--line-strong`). Focus: the shared
  ring. Disabled (`disabled`): 50% opacity, a not-allowed cursor and no hover change (the hover rules are guarded with
  `:where(:not(:disabled))`, which adds no specificity). Busy: `aria-busy="true"` shows a progress cursor, and the label
  says what is happening ("Syncing…"); the sign-in forms set it while their request runs.
- **Accessibility.** A native `button` takes Enter and Space; a link stays a link. An icon-only button needs an
  `aria-label`. A disabled button is skipped by Tab, so when the reason matters keep it enabled and explain the
  refusal in the form's feedback alert.
- **Do** keep one primary button per region and label it with a verb ("Save as draft"). **Don't** style a link as a
  button for an in-page action, or disable a submit button without saying why.

`.social-button` (the sign-in providers: hover `--border-accent`, disabled 65% opacity), `.text-link` (an inline link
with an arrow; hover `--link`) and About's own `.about-button` (a pill) follow the same states.

### Icon button

`<button class="icon-button" aria-label="Close">×</button>`: dialog close buttons, the menu toggle, the drawer's close
button. `--text-secondary` glyph, `--radius-sm`; hover `--surface-subtle` with `--text`. Always named with `aria-label` (and `data-ui-label` for Arabic).

### Toggle groups: filter tabs, client tabs, asset tabs

- **Markup.** Buttons in a container: `.filter-tabs > .filter-tab` (Connections' platform filter) and
  `.asset-tabs > button` (the asset types of a connection) sit in a `role="group"` with an `aria-label`;
  `.client-tabs > .client-tab` (the AI connector's client) sits under the "Connect with a token" heading, which names
  it. A new toggle group takes the `role="group"` and its label.
- **States.** The selected button has `.active` and `aria-pressed="true"`, the others `aria-pressed="false"`. Hover:
  a filter tab takes `--surface-subtle`, a client tab `--border-accent`, an asset tab the ink.
- **Accessibility.** They are toggle buttons (they filter one view), not `role="tab"`: no tab panel is switched and
  arrow keys are not required. A screen reader hears "pressed" on the current choice.
- **Don't** convey the selection by colour alone; the weight change and `aria-pressed` carry it.

### Form fields

- **Markup.** A visible `<label>` around or before each field; the hint in `.form-note` (12px, muted). Forms that
  submit to the workspace use `.workspace-form`; the sign-in pages `.auth-form`.
- **Look.** Text inputs, selects and textareas: `--border-strong` (3:1 against the field and the page; the search
  field's frame too), `--surface-raised`, `--radius-md`; the report builder's and delivery dialog's fields are 40px
  tall, the report library's selects and the evidence row controls 44px. The compact select of the top bar (language,
  appearance, working client) is 36px with `--radius-sm`; About's header selects are 44px. Checkboxes and radios are
  the browser's own, at least 18px; checkboxes take `--iris` as accent colour (`--link` in the report builder's account
  lists).
- **States.** Focus: the shared ring. Disabled: the browser's disabled look. Invalid: the form's feedback alert (below)
  names the field and what to do; a single field can carry an `.error` line.
- **Accessibility.** Every field has a name; an error is announced (`role="alert"`) and its summary takes focus once.
  In Arabic, identifiers, URLs, amounts and codes are typed left to right (`localization.css` lists the fields).
- **Don't** use a placeholder as the label, or rely on the red border alone.

### Status badge

- **Markup.** `<span class="status online|attention|offline"><i></i>Label</span>`: an uppercase 10px pill with an
  optional dot.
- **Variants.** `online` (the success pair: connected, verified, "You" on the owner's own access row, WEB-08),
  `attention` (the warning pair: needs review, failed, uncertain), `offline` (neutral, with a grey dot); without a
  variant it is neutral (transparent, `--line` border). The variants keep their pairs in the dark theme.
- **Accessibility.** The word carries the meaning, never the colour alone; Arabic shows Arabic labels (the rendered
  qualification refuses a Latin-only badge on the critical Arabic routes).

Related badges: `.default-badge` (the default login), `.creative-tag`, `.measurement-ledger-state` (observed or
unknown), and `.recommendation-pill` with its decision pairs, each with a symbol before the label (↑ → ↓ ‖ •).

### Notice

- **Markup.** `<p class="notice">` or `<div class="notice">` inside a page; `role="status"` for news,
  `role="alert"` for a problem the person must act on. `#shell-alert` is the shell's warning above every page.
- **Variants.** Informational (`--surface-subtle`, `--text-soft`; in dark the layer's `--surface-accent`), `warning`
  (the warning pair with `--warning-line`), `error` (`--danger-line` border and `--danger-text`).
- **Do** say what happened and what to do next. **Don't** put a form's refusal in a notice: use the feedback alert,
  which keeps the reference and the technical details.

### Feedback alert

`#capture-feedback`, `.measurement-read-feedback` and `.workspace-form-feedback` share one rule: a form's refusal kept
beside the form, on the raised surface with a `--danger` border; the reason in `<strong>` in the danger ink, then what
to do, the provider's facts and the reference, each on its own line (`white-space: pre-line`), and a "Technical
details" disclosure with the server's exact text. It has `role="alert"`, takes focus once, persists until the person
edits the form, and never names MCP-client vocabulary (the rendered qualification probes it).

### Status strips

`.report-status-strip` (a partial snapshot, a queued or stalled report): the warning surface with a 4px bar on the
inline-start side. `.delivery-status` at the foot of the delivery dialog (sticky): neutral, `success`, `warning` and
`error` tones from the status pairs.

### Toast

`#toast.toast`, `role="status"`: a short confirmation on the inverse surface. It is the first element of `main`, in the
page's flow at its block start, so it pushes the content down instead of covering it, and it is sticky (12px from the top
of the window, below the 64px header on a phone) so it stays in view while the page is scrolled. One message at a time (a
new one restarts the timer). It never carries the only copy of an error: errors stay in the page.

### Panels and cards

`.panel` (the raised surface, `--radius`, `--elevation-1`), `.stat` (a figure and its label), `.platform-card` (hover:
`--border-accent` and `--elevation-2`), `.target-card`, `.report-summary-card`, `.quick-actions > a`,
`.workspace-metrics article` and `.empty` (the empty state: a dashed `--border`, centered, its strong line in ink). An
empty state says what is missing and offers the next step.

### Tables

- **Markup.** Wrap every data table in `<div class="data-scroll" role="region" tabindex="0" aria-label="…">` and give
  it a `<caption>`; row headers are `<th scope="row">`, column headers `<th scope="col">`.
- **Variants.** `.review-table` (the default data table), `.asset-table` (selection lists), `.push-table` (upload
  receipts) and `.report-table` (sticky header and row header, numbers aligned to the end, tabular figures).
- **Accessibility.** The region scrolls with the keyboard (the rendered qualification presses the arrow keys); native
  IDs and values keep their own direction (`dir="ltr"`, `<bdi>`, `data-native`).
- **Don't** put a table in a container that hides overflow, or make row labels narrower than 120px.

### Dialog

- **Markup.** `<dialog>` opened with `showModal()` and named by `aria-labelledby` or `aria-label` (`check-web` refuses
  an unnamed one). Every dialog takes `--surface-raised`, `--radius-xl`, `--elevation-3` and the blurred `--overlay`
  backdrop. `.small-dialog` (confirmations and sign-in), `.manage-dialog`, `.command-dialog` and
  `.report-delivery-dialog` set the size.
- **Destructive actions** use `confirmAction()` (`#action-dialog`): it names the consequence, focuses Cancel, keeps Tab
  between its two buttons, cancels on Escape, and its confirm button is a `danger` button. Never the browser's
  `confirm()` (`check-web` refuses it, except the one synchronous navigation guard).

### Disclosure

`<details><summary>`: a plain disclosure gets 3px of block padding so its summary is a 24px target;
`.workspace-details` (technical details), `.capability-unavailable` and `.worker-health-details` (44px summaries for
the collapsed groups of Capabilities and worker health, WEB-08), `.report-options` and `.report-platform` (the report
builder, with a chevron), `.native-settings`. The summary takes Enter and Space; its text says what opens.

### Navigation

- **Sidebar** (`.sidebar`): a neutral frame on the raised surface, drawn from the route registry (The shell, below); the
  current page has `.active` and `aria-current="page"`; the page's own focus ring. Below 851px it is a drawer from the
  end edge with a focus trap, Escape and a scrim.
- **Top bar**: one row at every width in both languages (the phone header is 64px: the logo or the icon, the client
  switcher, search and the menu); visible labels give way before anything wraps, and every control keeps its
  accessible name.
- **Skip link** (`.skip`): the first focusable element; it moves focus to `main` without changing the address.
- **Command palette** (Ctrl/Cmd+K): a dialog of pages and, for opted-in workspaces, entities.
- **Settings sub-navigation** (`.settings-subnav`, WEB-08): in-page links to Safety, Access, Health, Retention and
  Account, Safety first; pills with hover `--surface-selected` and `--border-accent`.

### The shell

`web/routes.js` is the one registry: it drives the navigation, the server's shell routes and the loader's asset order, and
gives each page its `group` (Home, Reports, Creatives, Campaigns, Connections, Operations, Settings), its `icon` (one
glyph for each link: a test refuses two that share one), its `subtitle` (the sentence under its heading) and its `parent`
(where a failed page leads back: `routeBack`). Account and Help are in the sidebar's footer (`menu: 'user'`).
`/design-system` is in no group, the navigation or the palette.

- **Sidebar and rail.** A group of one page is a plain link; a group of several is a disclosure, closed until its page is
  current. The navigation scrolls inside its column and the footer stays in view at 800px of height in both languages. The
  rail (72px: icons alone, each link keeping its name as clipped text and a title) is the default from 851 to 1023px and a
  choice at any wide width, remembered across routes (`amcp.sidebar` in local storage). In the rail the brand is `mark.svg`
  at 32px; the lockup is never drawn under 160px.
- **Header and drawer.** At 850px and below the header is one row: the logo (the icon alone under 520px) at the start
  edge, then the client switcher, search and the menu. The drawer opens from the end edge, holds language, appearance and
  sign out, and is one scrolling panel. The logo is never mirrored or recoloured; under forced colours the visible variant
  follows `prefers-color-scheme` (`accessibility.css` and `privacy.css`).
- **What the shell loads.** None of the V2 layer. The V2 core (`tokens-v2.css` 2,590, `components.css` 3,863 and
  `components.js` 6,740 Brotli bytes) on every signed-in route is more than the shell may spend on a skeleton, and it
  breaks the WEB-07 guard for `/connections` (`tests/web-route-bytes.test.mjs`), so the frame, the empty block, the page
  error and the toast are the shell's own (`app.css`, `web/workspace.js`, `web/app.js`). To load the core everywhere, add
  its three files to a shell asset list in `web/route-assets.js`, draw those states from `AmcpUI`, and re-record the route
  bytes with the reason.
- **Motion.** No view transition: a route change draws in two phases (the frame, then the page), which a transition would
  cross-fade badly. Reduced motion turns every CSS transition and animation off.

### Loading and empty states

A page that is opening shows its own heading and subtitle, from the registry, over skeleton blocks (`.skeleton`: a card and
four lines, one busy status the reader hears once, no motion), inside a shell that does not change. A section that fills
late (`fillSection`) draws the same blocks and fills when its answer arrives; a failure stays in that section. A button
that starts work says what it is doing and is disabled until it finishes. There is no spinner component. An empty state is
`emptyBlock`: a title, its words and exactly one link or button (it refuses a state with no action); a panel on a page that
already has its primary action uses a secondary one.

## V2 components (`AmcpUI`)

The V2 component layer (V2-WEB-02) is a set of classic scripts and stylesheets that pages adopt as they are rewritten. It
rewrites no page: the components above stay on their pages until those pages move (V2-WEB-03 to 05), and none of the
V2 sheets is linked by the workspace shell or About. The members-only state page `/design-system` (not in the
navigation, answered by the shell like every workspace page) shows every component in every state, in English and
Arabic and in both themes; it is the review surface for the visual sign-off.

### How it is built

| File | Holds |
|---|---|
| `components.js`, `components.css` | the namespace `AmcpUI`, icons, button, icon button, badge, filter chips, fields (text, number, date, select, checkbox), progress, skeleton, empty and error states, stepper, KPI, platform and creative cards |
| `components-controls.js`, `components-controls.css` | segmented control, tabs, searchable list (combobox), tree with tri-state boxes |
| `components-table.js`, `components-data.css` | the responsive table |
| `components-overlays.js`, `components-overlays.css` | dialog, side sheet, toast |
| `design-system.js`, `design-system.css` | the state page and its layout |

- **Loading.** A route lists the files it uses among its `assets` (`web/routes.js`, `web/route-assets.js`); a stylesheet
  loads as a `<link>` before `accessibility.css`, which stays last, and the page waits for it. `/design-system` loads
  all of them with `tokens-v2.css`. The checks read a route that loads sheets as a page of its own, so a component sheet
  may read a V2 token only on routes that also load `tokens-v2.css`.
- **Writing.** A component is a function that returns `` html`…` `` (never `innerHTML`, `insertAdjacentHTML` or `raw()`, so
  the markup ratchet does not move) and takes its words already translated by the page. An interactive component
  registers a delegated behaviour; the page calls `AmcpUI.bind(root)` once on its content and re-renders freely. A
  component that needs state after it is drawn has a `mount(host, config)` that returns a small controller. Changes
  reach the page as bubbling `amcp-change` events (`amcp-remove`, `amcp-action`) with a detail object.
- **Styling.** Tokens only (`tokens-v2.css`, with the legacy `--focus` and `--overlay` roles): a component sheet declares
  no custom property, no colour, no hand-written radius, shadow, duration or type size, and the token ratchet counts its
  debt at zero. Logical properties only, container queries inside components, no viewport breakpoints. Only overlays
  cast a shadow. No gradients, glows or icons in tinted squares.
- **Icons.** `AmcpUI.icon(name)` draws one of eleven glyphs (`check`, `close`, `minus`, `plus`, `chevron`, `next`, `info`,
  `warning`, `error`, `search`, `dot`) as an inline SVG on a 24px grid in the text colour; it is decoration beside words, so it is
  hidden from assistive technology, and `next` mirrors in right-to-left.
- **Dark layer.** `theme.css` paints native inputs, selects and textareas and recolours `label`, `p`, `th`, `dt` and
  `summary` in the dark theme at a specificity a class cannot beat. A field therefore keeps its state on its wrapper (border,
  dimming, never a fill), its muted words sit in spans and divs, and a table gives its header text the colour of its row.
- **Pairs.** Nothing is written on `--v2-rule` (ink-2 and, in dark, violet-text fail there) and nothing on `--v2-peach`
  (ink on peach is 1.38:1 in dark): rule draws lines and tracks, peach is a dot or a bar beside words.
- **Every component** has the states that apply (hover, active, focus, disabled, loading, error), reads right to left through
  logical properties, works in both themes, has a 24px minimum target (44px for a primary action), turns its motion off
  under `prefers-reduced-motion`, and keeps its focus ring and its state in forced colours (system colours, borders instead
  of fills). The state page draws hover, active and focus with `data-state` so they can be seen at rest.
- **Tests.** `tests/web-ui-*.test.mjs` read state, ARIA and keyboard behaviour back from the markup in a test DOM
  (`tests/helpers/web-ui-dom.mjs`); `node tools/browser-workflow-qa.mjs --kinds components` drives every component with real
  keys on the state page at 320, 375, 768 and 1280 pixels, in both languages and themes (axe, the Arabic leak probe, target
  sizes, focus rings, the open dialog and sheet, toasts, forced colours).

### Button

- **Markup.** `AmcpUI.button({label, variant, size, type, disabled, loading, loadingLabel, href, pressed, expanded, controls})`
  returns a `<button type="button">`, or an `<a>` when it has an `href`. `AmcpUI.iconButton({icon, label})` is the quiet
  variant with only a glyph and needs a name.
- **Variants.** `primary` (the main action of a region: violet fill; always 44px high and wide, whatever its size),
  `secondary` (the default: a rule and the raised surface), `quiet` (no border until hovered) and `danger` (a solid danger fill).
  Sizes `sm` (32px), `md` (40px, 32px in compact density) and `lg` (44px).
- **States.** Hover darkens the fill (primary and danger) or takes the subtle surface; active goes one step further; the shared
  ring shows on focus; disabled is a subtle fill with ink-2 text and `not-allowed`; loading is disabled with `aria-busy`, a
  spinner and, when given, a verb ("Saving…"); a pressed toggle has `aria-pressed` and a selected fill. A disabled link has
  no `href`, `aria-disabled` and `tabindex="-1"`.
- **Accessibility.** Native `button` keys; an icon-only button is named by `aria-label` and its glyph is hidden.
- **Do** keep one primary button per region and label it with a verb. **Don't** disable a button without saying why nearby,
  or put the busy state on a link.

### Badge

One badge replaces four. `AmcpUI.badge({label, tone})` with tones `neutral`, `success`, `warning`, `danger`, `info` and `marker`.
A status tone has an icon and its word; `marker` is a peach dot beside the word. The old classes map to it
(`AmcpUI.badge.legacy`), and the old pages keep their own CSS until they move:

| Old class | Badge tone |
|---|---|
| `.status` and `.status.offline` | `neutral` |
| `.status.online` | `success` |
| `.status.attention` | `warning` |
| `.status.error` | `danger` |
| `.default-badge` | `info` |
| `.creative-tag` | `neutral` |
| `.measurement-ledger-state` | `info` |

**Don't** use colour alone, put a badge's word in the glossary's other language, or write text on a peach fill.

### Filter chips

`AmcpUI.chips({label, chips, mode: 'multi' | 'single', removable})`: a labelled `role="group"` of toggle buttons, each with
`aria-pressed`, an optional count and a check mark when pressed (a fill and a heavier border too). `single` keeps exactly
one pressed. Removable chips name what they remove (`Remove {label}`), remove themselves and hand focus to the next or
previous chip, or to the group when none is left. A page reads `amcp-change` (`id`, `pressed`, `pressedIds`) and
`amcp-remove`. **Don't** use chips for navigation: they filter one view.

### Fields

- **Markup.** `AmcpUI.input({id, label, type: 'text' | 'number' | 'date' | 'search' | 'email' | 'url' | 'password', hint, error,
  required, disabled, readonly, loading})`, `AmcpUI.select({id, label, options, value, …})` and `AmcpUI.checkbox`. A label,
  the control, a hint and an error linked by `aria-describedby`; `aria-required` and a visible asterisk; an error is an icon and
  words with `role="alert"`, and sets `aria-invalid`.
- **Number.** A number is typed as text (`inputmode="decimal"`, `dir="ltr"`) so the digits stay exactly as typed: no float
  conversion, no locale digits, in both languages. `AmcpUI.decimal(text)` returns `{valid, value}` for a decimal with Latin
  digits (thousands separators dropped, no exponent). Money and metrics stay decimal strings.
- **Date.** The native date control.
- **States.** The border darkens on hover, takes the focus colour with the inset ring on focus, turns danger on error, and a
  disabled or read-only field is dimmed and lighter-bordered; `loading` adds a spinner and `aria-busy`.
- **Do** write the hint before the error and name what to do. **Don't** use a placeholder as the label.

### Progress, skeleton, empty and error states, stepper

- **Progress.** `AmcpUI.progress({label, value, max, text, tone})` is a native `<progress>` named by its label: determinate
  only when the value is known, otherwise the browser's indeterminate bar and the words "In progress", never 0%.
- **Skeleton.** `AmcpUI.skeleton({shape, lines})` is one `role="status"` busy group that says "Loading…" once; the blocks are
  decoration and stop pulsing under reduced motion.
- **Empty state.** `AmcpUI.emptyState({title, body, action})` refuses to render without an action: an empty state always names
  one next step.
- **Error state.** `AmcpUI.errorState({title, body, retry, reference, details})` is a `role="alert"` section with a way on, the
  reference in a left-to-right `<code>` and the technical details in a disclosure.
- **Stepper.** `AmcpUI.stepper({label, steps})` is an ordered list; each step has a marker and says its state in words
  (completed, current step, not started, needs attention), the current one with `aria-current="step"`; a column on a
  narrow container and a row on a wide one.

### Cards

`AmcpUI.kpi({label, value, unit, note})` is plain large type in a description list; a figure of zero (the number or the text
`'0'`) is shown as 0 and a missing one (`null`, `undefined` or an empty string) as a dash with "No data" for assistive
technology and its reason in the note, so zero and unknown never look alike. `AmcpUI.platformCard({name, status, meta, action})` has one action. `AmcpUI.creativeCard({id, title, meta,
mediaLabel, media, selectable, selected, badges})` has a media area named by `mediaLabel` and, when selectable, a checkbox
named by the title; a selected card has a violet border and a peach bar at its start (a marker, with the checked box beside it).

### Segmented control and tabs

- **Segmented control.** `AmcpUI.segmented({name, label, options, value})` is native radios in a labelled `radiogroup`: Tab
  enters the group once and the arrow keys move and select, as the browser does it.
- **Tabs.** `AmcpUI.tabs({id, label, tabs, selected, activation, orientation})`: roving tab stop, a panel for each tab
  (`aria-controls`, `aria-labelledby`). Arrow keys move and, by default, select (`activation: 'manual'` waits for Enter or
  Space); they wrap, skip a disabled tab, and swap in right-to-left; Home and End jump. `AmcpUI.tabs.next` is the pure rule.
- **Do** keep tab labels short and give every panel a heading or a first line that says where you are.

### Searchable list (combobox)

`AmcpUI.combobox({id, label, hint, error, …})` draws the field; `AmcpUI.combobox.mount(host, {options, value, limit, search,
onSelect})` gives it its options (or an asynchronous `search(query)`) and returns a controller.

- **Pattern.** An editable text box with `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls` and
  `aria-activedescendant`, and a listbox popup. Focus stays in the box.
- **Keys.** Typing filters (case and accents ignored, label prefixes first, the match marked). ArrowDown and ArrowUp open and move
  the active option (they wrap); Enter chooses (and does not submit a form); Escape closes, and a second Escape puts the chosen
  value back; Alt+ArrowDown opens. A click chooses; leaving the box puts the chosen label back, because a half-typed query is
  not a value.
- **States.** The list says "N results", or "Showing 8 of 120. Keep typing to narrow the list." when it is cut at its limit (8
  by default: the popup never scrolls, because a scrolling region the keyboard cannot reach fails WCAG 2.1.1); an empty result
  says what was searched and offers "Clear the search"; an asynchronous search is busy (`aria-busy`, a spinner), the newest
  answer wins, and a failure says so with "Try again".
- **Do** cut a long list with `limit` and let people narrow it by typing. **Don't** use it for fewer than about seven choices:
  use a select.

### Tree with tri-state boxes (the scope picker)

`AmcpUI.tree({id, label, nodes, checked, expanded})` and `AmcpUI.tree.mount(host, {nodes, checked, expanded, onChange})`.
A `role="tree"` (`aria-multiselectable`) of `treeitem`s with `aria-level`, `aria-setsize`, `aria-posinset`, `aria-expanded` and
`aria-checked` (`true`, `false` or `mixed`); one tab stop that follows the focus. A parent is checked when every selectable leaf
under it is, mixed when some are; checking a parent checks or clears them all; a disabled item is never checked and does not
count. Keys: Down and Up, Right to open or enter, Left to close or go to the parent (swapped in right-to-left), Home, End,
Space and Enter to check, `*` to open the siblings, a letter to jump. The pure rules are `AmcpUI.tree.states`, `toggle`, `visible`
and `keyAction`. A page reads `amcp-change` (`id`, `checkedIds`). Branches that are closed are not in the document.

### Table

`AmcpUI.table({id, caption, description, columns, rows, density, chooser, densityToggle, state, empty, error})`.

- **Structure.** The caption is a heading outside the scroll region, and both the region (`role="region"`, `tabindex="0"`, so it
  scrolls by keyboard) and the table are named by it. The header row and the first column (a `rowheader`) are sticky inside a
  region of its own height. Every element carries its ARIA role, because below 40rem of its own width (a container query) each
  row is a card with the name on the first line and `label: value` pairs beneath; a table that stops being `display: table`
  keeps its meaning. Numbers align to the end with tabular figures; a `native` column (names) keeps its own direction.
- **Column chooser.** A disclosure of checkboxes: hiding a column hides its header and cells, the last visible column cannot be
  hidden, Escape closes the chooser and returns focus to its button, and it opens in the flow so it cannot hang outside a narrow
  window. The density toggle changes the rows' height through `data-density`.
- **States.** `loading` (skeleton rows, `aria-busy`), `empty` (refuses to render without a next action) and `error` (with a way
  on) keep the header. Values are text, never markup (a cell may be an `html` fragment such as a badge).
- **Don't** put a table in a container that hides overflow, or hide the only column that names a row.

### Dialog, side sheet and toast

- **Dialog.** `AmcpUI.dialog.open({title, body, actions, size, role, dismissible})` returns `{element, closed, close, setLoading,
  setError}`; `closed` resolves with the answer (`'dismiss'` for Escape, the backdrop or the Close button). A native `<dialog>`
  opened with `showModal()` in a portal at the end of the body: the browser's top layer and Escape, and also the rest of the page
  marked `inert`, Tab kept inside, and focus returned to what opened it. `role: 'alertdialog'` with an action marked `initial`
  starts focus on the safe choice. A busy dialog disables its actions and sets `aria-busy`; an error shows in a `role="alert"` line
  without closing it. `dismissible: false` ignores Escape and the backdrop.
- **Side sheet.** `AmcpUI.sheet.open({…, side: 'end' | 'start', modal})` is the same panel against an edge (the end edge by
  default: the right in English, the left in Arabic); non-modal it leaves the page usable beside it, and closes on Escape itself.
- **Toast.** `AmcpUI.toasts.mount(host)` returns `{show, dismiss, clear}`. The host is in the page's flow at the block start,
  so a toast pushes content down instead of covering it, and on a phone it is the first thing. A labelled region with a
  polite `aria-live` list; it never takes focus; each toast has an icon, its words and a Dismiss button; success and information
  leave after six seconds, warnings and errors stay; the pointer or the keyboard on a toast holds its timer; three at most;
  Escape dismisses and returns focus to where it was.
- **Do** keep the answer of a destructive confirmation in the dialog's own buttons and say what will happen; use a toast to
  confirm what happened. **Don't** put the only copy of an error in a toast.

## The dark override layer (`theme.css`)

`theme.css` loads after the component sheets in the workspace and on the policy pages (About loads none). Besides the
Appearance control and three report-history rules that both themes use, it holds `[data-theme='dark']` rules: groups
that give a set of components one dark surface or ink their tokens do not give them. What each still decides:

| Rule | Members | Dark value |
|---|---|---|
| the page | `body` | `--paper` with `--ink` (the body has no surface of its own) |
| raised surfaces | `.empty`, `.endpoint-box`, `.command-trigger`, `#command-results button`, `.social-button`, `.report-summary-card`, `.report-pack` | `--white` with `--ink` and `--line` |
| inset surfaces | the report builder's top, run bar and progress, opened report options, code and code blocks, the manage dialog's footer, platform metrics, stat icons, asset counts, the landing page's AI feature, icons and illustrations, the sign-in story and divider, the account hero, workspace metrics, monograms, session icons, quick actions, failed activity, next source actions, report platform dots, the measurement task links, recovery keys | `--surface-subtle` with `--ink` and `--line` |
| inherited ink | `p`, `label`, `summary`, `th`, `dt`, `.brand`, `.how-steps li > span` | `inherit` |
| muted text | `small`, `.eyebrow`, `.report-section-label > span`, `.target-currency-row label`, the public navigation links, `#breadcrumb`, `footer a` | `--muted` |
| ink | `article strong` | `--ink` |
| links | `a.text-link`, `.auth-legal a`, the hero's highlighted word | `--iris-700` |
| fields | `input` (not checkbox, radio or colour), `select`, `textarea`, `.search`; `.password-toggle`; `::placeholder` | `--white` with `--ink` and `--line-strong`; `--muted` |
| hover and selected | plain, quiet and dark buttons under the pointer, social buttons, the palette's results, the measurement task links' hover and focus, active filter and client tabs, the default badge, report table headers, plain notices, avatars | `--surface-accent` with `--ink` and `--line-strong` |
| steps and errors | `.auth-success`, `.callback-step.done`, `.callback-step.failed`; `.error`, `.status.error` | the success and danger pairs; `--danger` |
| odds and ends | `caption`, the owner entry and its eyebrow, the sign-in divider line, the X logo (its light canvas), `::selection` | — |

A group's specificity is that of its most specific member, so the groups that list `#command-results button` or
`#breadcrumb` outrank every rule that names classes only, for every member: a member's variants and states lose to the
group in dark mode. Components with variants or states are therefore not listed, or listed with a guard
(`.button:not(.primary, .danger):hover:where(:not(:disabled))`, `.notice:not(.warning, .error)`); the guard keeps quiet
and dark buttons in the hover group, which gives them the plain dark hover ([Button](#button)). Do not add to the
layer: a new component's dark appearance comes from its tokens.

### What left it (B23, 2026-10-23)

94 entries left: 88 members of the dark groups, four single dark rules and two of the three page selectors. Each
repeated what the component's own rule with its token's dark value already gave, never applied, or named markup no page
with `theme.css` renders:

- **Repeated tokens.** The report table's compared values and row headers, the source health lines (success and
  attention), the white-surface members `.topbar`, `.stat`, `.panel`, `.floating-chip`, `.callback-card`, the report
  builder's panel, platforms and target cards, the source health block, the report table frame, the delivery dialog
  and `dialog` itself; the inset members of the landing page's features, the delivery dialog's report context and the
  native field tags (`code` already covers them); the inherited ink of `td`, `dd`, the headings, the report section
  labels, the technical details' summaries; 23 muted text members (`.muted`, `.form-note`, the sign-in links, the
  report builder's labels and notes, …); eight muted members of the landing page, the public footer and the
  breadcrumb; the quick actions' and report history rows' ink; two sign-in links; the sign-in fields; `html` and
  `body.public-view`.
- **Never applied.** The primary, status, warning, danger and `.danger` rules and the platform initials' dark rule had a
  lower specificity than the white-surface and hover groups, which always won for those elements; `.step:before` sat
  inside `:is()`, where a pseudo-element never matches.
- **No markup.** About's classes (About loads no `theme.css`), `.auth-art-label` and `.overview-welcome`.

Proof: a computed-style comparison in the dark theme of every element and its `::before`, `::after`, `::marker` and
`::placeholder` (the colour, border, radius, outline, shadow, opacity, size and padding properties), with and without
the entries, on the public and workspace pages of the empty fixture and 26 populated kinds plus 8 scripted states (an
export dialog, a write review and its outcome, a run report, a spending-policy confirmation, a callback refusal, worker
health), in English and Arabic at 375 and 1280 pixels, at rest, with every disclosure open and with every element
forced into hover, focus and active, after each rule's removal in turn (2,080 page states per rule, from 256 page
loads): no difference. The four removed members no state rendered are dead or covered by a member that stays
(`.auth-art-label` and `.overview-welcome` have no markup, `code` covers `.native-field-tags code`, and no rule gives
`dd` a colour, so it inherits anyway). `dt` stayed: three previews (`.branding-preview`,
`.allocation-proposal`, `.conversion-recipe-preview`) give it the muted ink, which the layer's `inherit` overrides in
dark mode; and so did `.report-progress` and `article strong`, which a static check of every component rule found
deciding colours in states the fixtures may not reach. `theme.css` went from 7,359 to 4,831 bytes (1,933 to 1,474
Brotli bytes, which every workspace and policy page downloads).

### What it no longer masks (dark variants, 2026-10-23)

With `.button`, `.status`, `.client-tab` and `.platform-card` out of the white-surface group, the plain hover and the
plain notice guarded, and the metric pills and feedback alerts out of the hover group, the dark theme shows what the
light theme shows: primary buttons on `--iris` with `--on-accent` text (hover `--iris-700`), danger buttons in the
`--danger` ink and border with a `--danger-bg` hover, quiet buttons transparent, dark buttons on the inverse surface,
status badges with their success and warning pairs (the plain badge transparent), warning and error notices with their
pairs, the feedback alerts' `--danger` border, checked metric pills on `--surface-accent` with the `--iris` border, and
hover borders on platform cards and client tabs. Their labels measure 7.85:1 or more and a checked pill's formula 6.03:1
(masked as plain components they measured 10.2 to 13.7:1).

## What changed in this increment (for the owner's visual sign-off)

A computed-style comparison of every page state above against the tree before the design-system work (the release
deployed before wave 4b, both themes) found these differences and no other:

- **Corners on the scale.** Near-duplicate radii took the nearest step: icon buttons 6 to 8px; filter tabs, metric and
  recommendation pills, client chips 6 or 7 to 8px; sidebar links, the command trigger, text fields and selects, code
  blocks, feedback alerts and source health 7, 8, 9 or 12 to 10px; platform logos and stat icons 11 to 10px; the
  toast, sidebar note, quick actions, report table frame and report progress 14 to 12px, the landing page's mini plan
  and the report builder's platforms 13 to 12px; tags 5 to 4px; stat cards, the owner entry, the callback card and
  report packs 16 or 18 to 17px; dialogs 16 or 20 to 22px, as are the account hero and monogram. Status badges, the
  default badge, creative tags and About's buttons became `--radius-pill` (the same shape). A hovered platform card's
  shadow is `--elevation-2` (10px 35px instead of 9px 30px), and the phone drawer slides in 0.18s instead of 0.2s.
- **Control sizes.** The top bar's appearance and working-client selects are 36px like its language select (they were
  32px with 7px side padding); About's appearance select is 44px like its language select.
- **States.** Icon buttons, filter tabs, client tabs, asset tabs and the Settings section links show hover; a disabled
  button keeps its look under the pointer; a busy button shows a progress cursor; selected toggles say
  `aria-pressed`; an error notice has the danger border and ink; the search field's frame and the report actions'
  select have the 3:1 control border (they had the 1.29:1 decorative line in light mode).
- **Dark mode.** The variants listed [above](#what-it-no-longer-masks-dark-variants-2026-10-23), and the report pack's
  click-through chart follows the theme (it painted light SVG fills on the dark pack).
- **Browser bar.** Before JavaScript runs, and on a page read without it, the browser's bar (`theme-color`) follows
  the system appearance: the light `--paper` (`#f7f6fa`) or the dark one (`#181522`), from a light and a dark meta on
  every page. The deployed release painted it `#171629` (workspace) or `#201c32` (the other pages) in both. Once
  `theme.js` runs, both metas take the chosen theme's `--paper`, as before.

The owner signs off once for this list and the design review's own changes: the light and dark screenshots of the
integrated website are in the [design review record](records/DESIGN-REVIEW-2026-10.md#7-web-07-colour-sign-off), and
the approval (or the screens to revisit) goes in [package status](review/PACKAGE-STATUS.md) under B16.

## Known gaps

What the audit found and this increment did not change, because it would move text or layout the owner has not
reviewed:

- Some readable text is below the 12px floor: status badges (10px), the default badge (9px), asset counts, small
  captions in the asset tables, connection rows and stat labels (10 to 11px), and the social buttons' notes (8px). A
  type step for badges, or moving them to `--type-xs`, is a visible change.
- The palette names `--white` and `--ink` keep their light meaning in their names while their dark values are the
  panel and the light ink; new rules use the roles (`--surface-raised`, `--text`). `--radius` (17px) has no size suffix
  between `--radius-lg` and `--radius-xl`.
- Badges are four components (`.status`, `.default-badge`, `.creative-tag`, `.measurement-ledger-state`) with their own
  sizes; the V2 badge replaces them and the map is in [V2 components](#badge), but the old pages keep their own CSS until they
  move. The disclosure summaries of Capabilities and worker health repeat one 44px rule in two sheets.
- 195 type sizes, 14 radii, 17 shadows and 468 spacing values off the 4px grid are still written by hand; the ratchet
  keeps them from growing.

## Checks

`node tools/check-web.mjs` (part of `npm run check`) runs them all; each has a test in the default suite.

| Check | Refuses | Baseline or list |
|---|---|---|
| `tools/check-colours.mjs` | a colour token without a dark value or with a dark value that differs without JavaScript; a literal colour in a stylesheet; a literal colour in a script or page (hex, functional, or a named colour in a colour attribute or style text) outside the reviewed list (data defaults, QR pixels, the downloaded report document, by file, value, context and count); a `theme-color` meta that is not its appearance's `--paper`, or a page without a light and a dark one | `tools/web-colour-baseline.json` (0; the reviewed script entries and the total of their counts only go down), `tools/web-colour-allowlist.json` (only shrinks); `tests/web-colours.test.mjs` |
| `tools/check-design-tokens.mjs` | a radius, shadow, duration or type size written by hand, or a padding, margin or gap off the 4px grid, above its stylesheet's count; a custom property read by a stylesheet and defined in no token sheet that every page loading it loads (the workspace has no `public-tokens.css`) | `tools/web-design-token-baseline.json` (only goes down); `tests/web-design-tokens.test.mjs`, which also requires every token to be documented here |
| `tools/web-route-bytes.mjs` | a page that downloads more (Brotli) before it renders than its recorded value | `tools/web-route-bytes-baseline.json`; `tests/web-route-bytes.test.mjs` |
| `tools/check-markup.mjs` | new markup escaped by hand instead of `` html`…` `` | `tools/web-markup-baseline.json` |
| `tools/check-rtl.mjs` | a physical left or right side in a stylesheet | its allow-list |
| `check-web` itself | inline scripts, styles and handlers; a token defined outside the token sheets; the stylesheet order; an unnamed dialog; `confirm()` | — |
| `tests/website-contrast.test.mjs` | shell colour pairs below 4.5:1 (text) or 3:1 (focus) in either theme | — |
| `tests/web-components.test.mjs` | a button hover rule without the disabled guard; a toggle without `aria-pressed`; a field border below 3:1; a dark group member that re-colours a button, badge, notice variant, feedback alert, metric pill, dialog, client tab or platform card; more than 87 dark members; a button variant or the Settings section links below 4.5:1 | — |
| `tests/web-ui-*.test.mjs`, `tests/route-assets-styles.test.mjs`, `tests/web-tokens-v2-components.test.mjs`, `tests/web-design-tokens-routes.test.mjs` | a V2 component's state, ARIA or keyboard handling that is wrong (over the test DOM); a stylesheet that reaches a page without its bytes counted; a V2 surface or status below its contrast, or one of the pairs listed above adopted; a legacy token that moves when the V2 sheet loads; a component sheet read on a route that does not load the V2 tokens | — |
| `tests/web-components-css.test.mjs` | a component sheet with debt on the token ratchet, a colour or custom property of its own, a physical side or a viewport breakpoint; a focus ring that is not the shared one; an animation that does not stop under reduced motion; no forced-colour rules; a primary action under 44px or a control under 24px; a text colour on a fill it fails on (4.5:1, 3:1 when disabled) or on one of the pairs listed above; peach behind words | — |
| rendered qualification | WCAG rules (axe-core), focus rings below 3:1, a focused control hidden by a sticky layer, sideways scrolling, Arabic leaks; for `--kinds components` also targets below 24px (44px for a primary action), the focus style of each component, the keyboard model of each, the open dialog and sheet, toasts, forced colours | [local browser QA](LOCAL-BROWSER-QA.md) |

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
  `theme.css` entry. A V2 component goes in `web/components*.js` and its sheet, as [above](#v2-components-amcpui): written
  with `` html`…` ``, with a test over the test DOM, a section on the state page in English and Arabic, and a case in
  `tests/fixtures/components-browser.mjs`.
- **Removing a `theme.css` entry.** Prove it: a computed-style comparison of every element (and `::before`,
  `::after`, `::marker`, `::placeholder`), at the rendered pages' states and with forced hover, focus and active
  states, with and without the entry, must find no difference; or, where it finds one, the difference must be a fix of
  the component's intended look, with its contrast measured. Check the contexts no fixture renders too: an entry also
  overrides every component rule of a lower specificity that colours the same element somewhere else ([above](#what-left-it-b23-2026-10-23)).
- **Bytes.** A page may not download more than its recorded value. The recorded values are the tree before WEB-07,
  and `tests/web-route-bytes.test.mjs` measures the bundle split's gains against them, so a page that shrinks does
  not re-record them; a page that legitimately grows past its value re-records them in a commit of its own.
