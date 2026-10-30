---
status: record
tier: engineering
---

# Complete static Arabic privacy page and language-aware navigation

Batch 151 supplies a complete Arabic counterpart to the published English privacy policy, including
its eight sections, navigation, metadata, contact details and footer. Both versions are public HTML
that can be read without login, cookies or JavaScript. The English article text and published
2026-09-30 date remain unchanged; translating the page does not introduce a new policy or new consent.

## Public routes and workflow

`/privacy` retains its English default. `/privacy?lang=en` and `/privacy?lang=ar` select complete static
versions with matching `Content-Language` headers. Unknown, repeated or path-like query values fall
back to English; request data never selects an arbitrary file. GET and HEAD return directly without
creating a session or contacting a provider. Each page has ordinary English/Arabic language links
that work with JavaScript disabled, alongside a keyboard skip link and stable section anchors.

The current selected website language determines privacy-link destinations on public/workspace
screens. The standalone policy's own links choose the policy language, without changing a workspace
preference, account grant, authorization, customer consent or platform permission. Both language
versions have canonical URLs in their own language and reciprocal alternate-language references.
English retains the original canonical /privacy URL; Arabic uses /privacy?lang=ar, following
[Google's canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
and [localized-page guidance](https://developers.google.com/search/docs/specialty/international/localized-versions).

## Preserved content and layout

The translation retains the English article's paragraph/list/emphasis/link structure, eight section
IDs, six literal scope/method references and six linked destinations. Technical tokens remain literal,
including analytics.readonly, properties.runReport, analytics, adwords and datamanager. Encryption,
password/session controls, customer-list hashing, permitted data use, retention limitations, backup
limitations and contact details are translated without changing their scope or inventing new promises.

The original English article SHA-256 is
`0df3f09725af6c1e4a5d2881931b64eb37cb289292c91e1dd04578cc726c794c`.
The Arabic page uses the existing local Noto Sans Arabic font, RTL direction and logical spacing for
the skip link, title ornament and lists. Language links wrap within the existing public header. Scope
names and URL/email text use isolated LTR display. Both pages preserve the original print layout.
No new remote font, library, browser install or application dependency is introduced.

## Focused evidence

Five related suites pass **31/31/0/0 in 1.724 seconds**, including public no-session GET/HEAD routing,
invalid/repeated language fallback, complete matching article structure, literal scopes/destinations,
same-language canonical and reciprocal alternate references,
language-aware website links, existing navigation and About Us behavior. Website checks cover all
34 browser scripts, four HTML pages and 3,559 selected interface messages. The existing Arabic
interface catalog is unchanged; the policy is a separate complete static document.

Eight additional owned Chromium views at 320/375/768/1280 pixels in English/Arabic render all eight
sections with JavaScript disabled and zero synthetic provider reads/writes. Screenshots were inspected
at Arabic 375/1280 pixels, including the article text. The maintained rendered runner now covers
136 cases, adding the four previously unsupported Arabic privacy widths and testing actual
English/Arabic switching and skip focus before returning to the selected policy language.
The source digest now includes new non-ignored website files before commit, so an added static
page is represented in the working-tree proof as well as the final exact Git source proof.

These are local synthetic rendering and structure checks. They do not certify human legal/editorial
acceptance, every assistive technology/device/browser, current Linux/Docker execution, production
deployment or provider acceptance. Full-plan B16/B24 remain partial. Fresh sanitized report/full checks,
required FFmpeg and exact committed-source/browser gates remain separate below. Hosted CI stays
skipped at the owner's instruction and the remaining improvement plan continues.

## Batch 151 final local release preflight

Fresh offline install/build/early report freshness/full checks/Railway passed after the canonical
metadata correction. Main 4,312/4,312/0/0 in 150.741 seconds; capture 4/4/0/0
in 74.568 ms. Required FFmpeg ran every media case; website checks cover 34 scripts,
four pages and 3,559 selected interface messages, docs index 319. Source manifest: 1,766 public
files plus one generated literal empty sample, hash 9640e9159a78c22037c65fe6af49a50d36f195981399844157bd9361fc5cba5f.
All three sanitized public reports regenerated unchanged and preserved their bytes; the root private
sample was unread. English policy article and the entire Arabic interface catalog are unchanged.
Final working-tree browser QA passes 136/136/0 from 2026-10-04T18:19:36.569Z through
2026-10-04T18:22:24.574Z; website digest f4808ec7e260df1ab14b171812038a4f2abd50bedc358b3fbab142e9af4f1ba5 includes the new static
Arabic page. These served working-tree bytes are identified separately from their earlier Git base.
Earlier 136-case developer runs and the 4,311-test pre-canonical candidate remain diagnostic history;
this final record supersedes them. Fresh exact clean-HEAD/source/browser gates follow before the sole
Work-here push. Hosted CI remains owner-paused; full-plan work continues.
