---
status: record
tier: engineering
---

# Populated GA4 event evidence in English and Arabic

Batch 154 improves the existing recent-event observation view. The summary and minute/stream tables
now have authored captions, readable event-name columns and explicit left-to-right isolation for
original event names, exact counts, minutes and stream IDs. The request, backend projection,
window/row bounds, authorization and observation meanings remain unchanged. All 3,784 Arabic
catalog entries retain their exact previous bytes; existing captions are reused.

## Measured problem and result

Eight actual served synthetic views at 320/375/768/1280 CSS pixels in English and Arabic exposed
sixteen missing captions and ten table instances with event-label columns below 120 CSS pixels.
The narrowest minute table label was 32.203 pixels; Arabic 375 purchase wrapped across many lines.
The scoped existing commerce row-label rule now also covers these two tables. The same sixteen
table instances have nonempty captions and event-label widths from 192 to 312.203 pixels.
Horizontal scrolling stays within named keyboard-focusable table regions. English desktop and
Arabic phone result screenshots were inspected. This is measured synthetic geometry, not a live
incident, device/assistive-technology acceptance or full accessibility certification.

## Native read and workflow

The [official Google Analytics Data runRealtimeReport method](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runRealtimeReport)
uses POST for a report read. The maintained isolated browser fixture accepts only the exact
properties/123:runRealtimeReport path with the expected eventCount/limit query and analytics.readonly
binding. All other provider paths/methods and event senders are refused; the synthetic viewer has
no write account. No real property, event sender, provider write, snapshot or external request runs.
The application retains its existing bounded 1–30 minute choice; no Analytics 360 entitlement is inferred.

Each added journey starts no native read on navigation or control changes. One explicit request
returns two original purchase rows with counts 9007199254740993 and 2. Their exact aggregate remains 9007199254740995. An unreturned generate_lead stays null and displays No count returned / لم يُرجع عدد,
never an invented zero. Private upstream fields are withheld. Opening minute evidence exercises
actual captioned regions and arrow-key scrolling. Editing the report window clears old tables;
an explicit reread preserves the original exact aggregate and bounded scope.

Aggregate observations cannot identify a test event or verify runtime consent, deduplication,
attribution, conversion configuration or overall tracking health. Missing or zero counts do not
establish a broken tag. These limits remain visible and unchanged.

## Qualification and remaining work

The four focused backend/bilingual/native-identity/controller suites pass 57/57/0/0 in 2.961 seconds.
Eight new populated measurement cases extend the maintained browser suite from 152 to 160 across
the same 27 paths. Final rendered, full required-FFmpeg and clean committed-source proof follow
below before the sole Work-here push. Build and all three sanitized public report artifacts are
qualified separately; the private root sample is never read.

B16/B20/B24 stay partial for broader populated/engine/device/assistive/human and live/deployed
acceptance, and runtime tracking diagnostics. The matrix stays 13 implemented / 14 partial / 1 open.
Hosted CI stays skipped at the owner's direction; the complete remaining plan continues.

## Final focused and rendered evidence

Final served Chromium qualification passes 160/160/0 from 2026-10-04T20:03:22.025Z through
2026-10-04T20:07:05.910Z, website digest fbdad7fd0489c02ae4175f75a719071fe524007b15401ef6357c80bbba8aac0d. All eight GA4 cases
retain exact aggregate 9007199254740995 and authored unknown-count text, two original minute rows,
captioned readable event labels, actual keyboard scrolling and changed-window invalidation.
Navigation/control changes start no report; each case makes two explicit synthetic report reads
and zero native writes/external requests. Focused backend/bilingual/identity/controller checks
pass 57/57/0/0 in 2.961 seconds. Independent geometry checks measure sixteen captioned table
instances at 192–312.203 CSS pixels for event labels. Arabic 375 and English 1280 result screenshots
were inspected. All 3,784 Arabic catalog pairs retain exact previous bytes.
Local build and sanitized report generation pass; all three public artifacts regenerate unchanged.
Full required-FFmpeg and exact committed-source qualification follow before the sole Work-here push.
Hosted CI stays owner-skipped; remaining plan work continues.

## Batch 154 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,333/4,333/0/0 in 129.860 seconds, capture 4/4/0/0 in
74.354 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,576 selected messages; docs index 322. The sanitized
source manifest contains 1,778 public files plus one generated literal empty sample, hash
7a989de363bd71c6b14abf0e92eefdbc1ac7bb6a764bff67c79768493ae6ed02. All three public report artifacts regenerate unchanged and preserve
their bytes through full checks; the private root sample remains unread. The final 160-case
working-tree browser proof binds website digest fbdad7fd0489c02ae4175f75a719071fe524007b15401ef6357c80bbba8aac0d.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.

## Exact committed-source release follow-up

Batch 154 code 3146e155b6dc608d17e2371ac1d44f07f16833ce and documentation tip
a5a2245289ca69bf14c2b57fa3ab66792a167874 were pushed solely to Work-here with [skip ci].
Fresh clean-HEAD qualification matches 1,778 public Git blobs, one generated literal empty sample
and all three tracked report blobs, source hash 8e891c8ffc7c7383e9f4f25e8dfd52d5f032802ad817beb553d724c8521bca45.
Offline install/build/early report freshness/full checks/Railway pass with required FFmpeg: main
4,333/4,333/0/0 in 150.481 seconds, capture 4/4/0/0 in 72.168 ms. Report bytes stay unchanged.
Clean-HEAD browser passes 160/160/0 from 2026-10-04T20:16:17.557Z through 2026-10-04T20:20:49.057Z,
website digest fbdad7fd0489c02ae4175f75a719071fe524007b15401ef6357c80bbba8aac0d. A first preflight caught a formatting-related generated
documentation-index mismatch before commits; final index generation and a fresh full preflight pass.
Hosted CI remains owner-skipped; full-plan work continues.
