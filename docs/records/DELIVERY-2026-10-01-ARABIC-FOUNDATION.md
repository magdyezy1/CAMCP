# Arabic interface foundation — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `7977a19`. Implementation: `284300b`. Batch 63 starts B24's translation and RTL product track.

## User workflow and scope

The public navigation, authentication screens and workspace top bar offer explicit English and partial Arabic
choices. A browser-local preference persists the selection. The partial label remains visible because advanced
campaign, creative, reporting, operations, setup and connection workflows are not yet fully translated. This
increment translates the public introduction, sign-in/sign-up/recovery/verification/MFA, account/security/team
controls, Home, shell labels and schedule-center copy. It also translates selected common statuses and known
authentication errors. Unrecognized server/provider messages retain their original text.

Language changes refresh the current view and restore focus to a language selector. Unsaved form values or visible
recovery codes require explicit confirmation first; an untouched select with an implicit default does not falsely
count as edited. Navigation, identity and a newer language choice fence late catalog/confirmation responses. MFA
and verification tickets remain intact. Storage-denied browser modes still permit a current-session choice.

The shell changes its document language/direction, sidebar, mobile drawer, password control and text alignment for
Arabic. The existing locally shipped Noto Sans Arabic variable font is reused under its existing license. Code,
email, URL, password and one-time-code fields retain left-to-right isolation. Dates use the explicit interface
locale. The number helper only formats actual numbers/BigInts, preserving exact native numeric strings. This is
source and synthetic verification; visual layout, keyboard and assistive-technology acceptance remain unverified
because CUA cannot initialize its kernel-assets path.

## Translation and data boundaries

Only author-selected source messages and marked static elements are translated. There is no document-wide text
replacement. The fixed same-origin Arabic JSON catalog loads on demand and is cached for the page; English does
not fetch it. Invalid/unknown preferences and malformed catalogs fall back to English; an explicit failed switch
reports failure. Catalog values must be nonempty plain strings, contain no HTML angle brackets, and preserve the
exact interpolation-slot multiset. The 1 MiB text limit bounds validation of this trusted local asset.

Names, provider content, IDs, account scope, enum values, URLs, payloads and leading-zero codes remain unchanged.
Dynamic text is escaped at HTML/attribute insertion. Existing English legal agreements keep their wording and
explicit English/LTR markup. This introduces no legal policy, translation service, backend permission, OAuth scope,
dependency, provider mutation or external destination.

The catalog contains **531 messages**, of which **443** are explicitly referenced by selected source messages,
known label maps or static HTML markers. `check-web` now validates required entries, duplicate keys, plain-text
values, interpolation and script order. Its AST guard also rejects translating direct protocol fields, switch cases
and equality comparisons. These checks protect selected messages; they do not claim all website copy is translated.

The helper/style add 6,909/2,325 source bytes (2,057/694 bytes with local Brotli compression). The Arabic-only catalog
is 46,022 bytes (11,275 compressed). The reused font is 844,676 bytes (368,819 compressed). These are reproducible
asset byte measurements, not production network timings or a claim about browser font-fetch behavior.

## Qualification and remaining work

Eight localization tests cover loading/fallback, direction, dynamic values, precise numeric strings, stale changes,
unsaved input, exact confirmation, source/catalog guards, Home escaping and a real-controller sign-in/MFA journey.
That journey compares English and Arabic requests, including original tickets, password and leading-zero code.
HTTP loopback tests fetch and revalidate all new assets. The QR test changes its accessible label while requiring
identical QR matrix bytes. Existing navigation regressions load the actual new module. No provider was contacted.

Missing-module tests were observed red before implementation. Review caught and removed accidental translations
of keyboard control keys; the source guard now prevents that mistake. Navigation fixture failures were resolved
by loading the real module, retaining existing assertions. The focused group passed 26/26 before the additional
Home regression. The full 3,254-test suite passed 3,249 with zero failures and five local FFmpeg skips in 88.20 seconds.
Sanitized release and exact-HEAD qualification are recorded in [PROGRESS.md](PROGRESS.md), with ignored evidence in
`.runtime/localization-20261001/`.

B24 moves from open to partial; the matrix is **13 implemented / 14 partial / 1 open**. Remaining Arabic journeys,
translation review and RTL/keyboard acceptance remain explicit work. No production deployment or live-provider
acceptance is claimed. Work continues through those screens and the remaining blueprint packages.
