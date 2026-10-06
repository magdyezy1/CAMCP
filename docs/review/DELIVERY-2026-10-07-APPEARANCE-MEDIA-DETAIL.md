# Appearance, thirty-minute uploads and detailed report export

Batch 191 follows the conditional-program and budget-evidence implementation.
The sole checkout/push target remains CAMCP-Codes-final-branch and
magdyezy1/CAMCP Work-here. Shopify, Salla, WooCommerce and Criteo expansion
remain parked. Existing regressions still run; hosted Actions remain waived.

## Appearance

The public website, About Us, account and workspace pages expose System,
Light and Dark appearance. System follows the operating system. An explicit
choice persists locally and across navigation; changing another tab's choice
updates the current tab. Unavailable local storage falls back safely.
The initial theme resolves before styles render. Interface surfaces, status
colors, inputs and focusable controls use a shared dark palette; provider
logos, images, video and QR pixels are preserved.

Appearance changes preserve report inputs and account selection, do not reload
the route or send provider requests, and are excluded from unsaved-edit prompts.
Privacy content remains complete static HTML when JavaScript is unavailable;
the optional appearance script is separate from the policy content.

## Website upload expiry

A computer upload has one absolute deadline: upload start plus thirty minutes.
Completion, navigation, plan creation, a new review or a variant cannot extend
it. Original bytes, thumbnails, converted previews and frozen review copies
share that deadline. Reads and new execution are refused at expiry. A dedicated
fifteen-second cleanup timer erases expired encrypted staging even when the
worker is not running; startup and ordinary cleanup also enforce the deadline.
Cleanup health exposes sanitized timing/errors. The media-only timer avoids
unrelated reporting/schedule cleanup, and an additive media-kind index bounds
its document scan.

Previously retained computer-upload copies also expire from their original
creation time. `retain_source` refuses computer uploads. Separately imported
link/Drive originals may still be explicitly retained by the current owner.
Provider-hosted assets and receipt/review metadata have their separate lifecycle.
New encrypted backups exclude temporary staging and legacy retained computer
uploads while preserving separately retained imports. Existing external backups
are not rewritten. SQLite secure deletion is enabled; this is application
retention enforcement, not a claim of instantaneous erasure from historical
WAL files, operating-system storage or provider systems. Expired bytes are
removed on the next cleanup tick, normally within fifteen seconds while the
process is running; access is refused at the exact deadline.

The English and Arabic policy now states the same rule, dated 7 October 2026.

## Native entity detail in Reporting overview

Date grouping and entity level are independent. The builder now selects:

| Provider | Native middle level | Native ad level |
| --- | --- | --- |
| Google Ads | Ad group | Full ad-group/ad resource |
| Meta | Ad set | Ad |
| TikTok | Auction ad group | Auction ad |
| Snapchat | Ad squad within a selected campaign UUID | Ad |
| LinkedIn | Its existing campaign hierarchy | Sponsored creative |

Other providers keep their existing qualified campaign/context behavior.
LinkedIn is not given a fabricated ad-set hierarchy. Unsupported levels are
refused before provider requests. Detailed collection reuses qualified native
daily capture contracts under the original whole-report allowance and current
account/credential checks; it does not persist an extra Decision report.

Meta requires one exact result action and explicit click/view windows.
Snapchat requires explicit swipe/view windows and an exact parent campaign for
ad squads. TikTok and Snapchat require complete closed windows. Other detailed
presets preserve explicitly declared attribution or `unknown`. Extra native
metrics are refused for these presets. The actual definitions, native rows,
current-account evidence, query/source hashes and page evidence remain available.

Exact entity/parent IDs stay text, including IDs beyond JavaScript's safe integer
range. Multi-day rollups sum only additive columns with exact decimal arithmetic;
missing values and multi-day reach/frequency stay unknown. Summary groups keep
hierarchy levels separate and count entities rather than calling ads campaigns.
Old campaign-only configurations, summary shapes and export columns are preserved.
Account-free templates keep level/measurement settings but omit selected accounts,
parent campaign IDs and destinations. CSV, localized Excel and Google Sheets
include entity-level and original-parent columns for detailed snapshots.

## Export now to Google Sheets

The collected result's **Export now to Google Sheets** button opens a focused
destination flow for that immutable snapshot. Later setup edits do not replace
the selected snapshot. Choose an existing destination or bind/create a Sheets
destination, review the original report context, explicitly confirm export and
dispatch the existing durable export job. This flow creates no schedule.

The existing account/session checks, exact snapshot/revision, idempotency,
AMCP-owned tab selection, formula-safe typed cells, batch/read-back and original
tab preservation remain in force. The separate Sheets-and-schedules flow still
supports recurring delivery. Local fixtures verify real HTTP/worker/Sheets
batch paths; no live spreadsheet or advertising account is changed here.

## Qualification

The focused media/granularity run passes 74 tests with required FFmpeg and no
skips, including an actual converted variant and review near the deadline.
The conditional-program/MCP/localization run passes 52 tests. The owned catalog
contains 8,543 pairs and the web gate selects 8,356 owned messages; original
native/user values remain literal.

Prototype runs retain failures and fixes separately. They found password/legal
link and populated-report contrast problems, which were corrected before final
qualification. The maintained runner now exercises light and dark appearance for
all its fixtures, at the original widths and languages, with two independent
fixture servers at a time and sequential cases within each store. Immediate
export tests preserve the original tab and export the selected snapshot after
setup edits. Manual and physical-assistive acceptance remain separate.

Full public-only checks, the complete maintained browser matrix, committed-source
identity, generated report freshness and deployment evidence are recorded after
those checks complete. No prototype or earlier release is represented as the
final qualification of these changes.

Primary references inspected for this increment:

- [CSS color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme).
- [SQLite secure_delete](https://www.sqlite.org/pragma.html#pragma_secure_delete).
- [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement).
- [LinkedIn reporting schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09).
- [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate) and [typed cell writes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateCellsRequest).

The [fifteen-package audit](COMPLETION-2026-10-07.md) retains the original broader
scope and blocked live acceptance. These four features do not certify all fifteen
packages or change the owner's read-only account authorization.
