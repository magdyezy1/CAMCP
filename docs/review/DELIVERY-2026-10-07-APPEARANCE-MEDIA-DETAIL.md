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

Local inspection, platform fitting and variant conversion inherit that same
absolute deadline. Nested processing cannot extend it or leak a deadline into
another request. A processor that runs into expiry is stopped; its temporary
directory is removed after the child process closes its file handles. Imported
durable originals retain their existing processing limits.

Legacy retained-upload deletion selects expired tenant/ID pairs through the
existing partial media-kind index before removing chunks, manifests and source
metadata. Matching IDs in another tenant and provider receipt metadata survive.
An isolated SQL-only fixture within the fifty-original ceiling measured the
two byte-table deletions at median 1.1701 ms before and 0.2134 ms after, across
seven measured alternating rounds with 45 retained imports, five expired
uploads, 32 chunks per original and 100,000 unrelated documents. This is a local
query observation, not an encrypted-upload or production capacity qualification.

The English and Arabic policy now states the same rule, dated 7 October 2026.

## Native entity detail in Reporting overview

Date grouping and entity level are independent. The builder now selects:

| Provider   | Native middle level                      | Native ad level           |
| ---------- | ---------------------------------------- | ------------------------- |
| Google Ads | Ad group                                 | Full ad-group/ad resource |
| Meta       | Ad set                                   | Ad                        |
| TikTok     | Auction ad group                         | Auction ad                |
| Snapchat   | Ad squad within a selected campaign UUID | Ad                        |
| LinkedIn   | Its existing campaign hierarchy          | Sponsored creative        |

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

The explanation table and downloaded source evidence retain each selected
account's exact saved native mapping. For example, a Meta purchase report names
`/actions[action_type=purchase]`; it does not show a campaign-objective alias.
Different accounts can use different result actions. Mixed campaign/detail
reports retain their own respective mappings, and an unavailable detailed
mapping stays explicitly unavailable.

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
contains 8,547 pairs and the web gate selects 8,360 owned messages; original
native/user values remain literal.

The later focused media/report regression run passes all 110 tests with required
FFmpeg and no skips. It includes an actual local processor holding an input file
until the absolute deadline, cross-tenant retained-ID cleanup, nested/concurrent
deadline isolation and per-account captured-field explanations. The first
complete maintained matrix passed 1,180 of 1,184 cases: four English 320/375px
light/dark measurement disclosures failed the minimum target-size check. Their
summary now has a 32px minimum block size. The complete later qualification passes after these fixes; the failed run
remains preserved separately. Exact completed outcomes appear below.

Prototype runs retain failures and fixes separately. They found password/legal
link and populated-report contrast problems, which were corrected before final
qualification. The maintained runner now exercises light and dark appearance for
all its fixtures, at the original widths and languages, with two independent
fixture servers at a time and sequential cases within each store. Immediate
export tests preserve the original tab and export the selected snapshot after
setup edits. Manual and physical-assistive acceptance remain separate.

Completed public-only full checks, the maintained browser matrix, committed
source and generated report freshness appear below. Deployment evidence remains
separate. No prototype or earlier release is represented as final qualification
of these changes.

Primary references inspected for this increment:

- [CSS color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme).
- [SQLite secure_delete](https://www.sqlite.org/pragma.html#pragma_secure_delete).
- [SQLite partial indexes](https://www.sqlite.org/partialindex.html).
- [Node child-process close and kill semantics](https://nodejs.org/api/child_process.html) and [async context](https://nodejs.org/api/async_context.html). The installed Node 24.19 runtime is verified locally; the current online API reference is newer.
- [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement).
- [LinkedIn reporting schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09).
- [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate) and [typed cell writes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#UpdateCellsRequest).

The [fifteen-package audit](COMPLETION-2026-10-07.md) retains the original broader
scope and blocked live acceptance. These four features do not certify all fifteen
packages or change the owner's read-only account authorization.

## Completed October 7 qualification

The fresh public-only v8 candidate on exact source `5723ee6080419abd3b2fa549971776a940a19b28`
passes **5,077 main tests and four capture tests**, with zero failures,
cancellations or skips and required FFmpeg. Offline installation, compilation,
report regeneration/freshness, every default-check stage and Railway
compatibility exit zero. The candidate has 1,941 public sources plus one
generated literal empty sample and no environment file. Its manifest SHA-256 is
`6fb9435659c5b12ae33654cf37132def1fd6a85dfb45d8c840ee5c5f71e9e483`.
All three generated public reports are byte-identical to committed Git.

The complete maintained browser run on clean source
`78637435df81d8237f107c4b3e2994b0fe85555d` passes **1,184 of 1,184 cases**:
592 in each language and appearance, with 340 at 320px, 252 at 375px,
252 at 768px and 340 at 1280px. All sixty populated fixtures use every width;
selected empty authentication/workspace baselines use narrow/wide layouts.
It started at `2026-10-07T01:03:04.978Z` and finished at
`2026-10-07T02:02:05.697Z`. The actual runner, fixture, website and
hash-pinned axe-core 4.14.0 sources match the frozen record. Sixty-one fixture
lifetimes retain their actual tenant identities; shared tenant identities never
overlap, and at most two fixtures are active. An initial proof-summary check
incorrectly expected equal counts at all widths; the original maintained matrix
and its 1,184 passes remain unchanged, and that failed assertion is retained
separately. All sixteen detailed-report
journeys preserve the original Sheets tab, create no schedule, preserve inputs
on appearance changes and explain the exact purchase action mapping.

The preceding complete browser run retains 1,183 passes and one failure:
independent fixture stores reused one tenant identity, so the existing tenant
report-generation budget correctly returned HTTP 429. Qualification now
serializes those fixture lifetimes by their actual tenant identity. The
production one-per-tenant/two-per-process generation limits, cases and
assertions are unchanged. The separate 32-case shared-tenant prototype passes
before the complete rerun. The earlier four measurement-disclosure target-size
failures and original preflight failures remain separate historical evidence.

The fresh v9 source/report/format/web/docs/Railway gates also pass on the
browser revision; its manifest SHA-256 is
`a480368195155c5f2a0c7bd5fbf3bb24211baa0f8606cce42a956edb2c14ec29`.
All 1,941 actual public source files match it. Its packaged application is
byte-identical to the full-suite candidate: 1,354 files / 52,393,204 bytes,
SHA-256
`c89e86cdf121cfb402c2046de52fe00b59fa5816a70c4a94d44ab32063322338`.
The full suite and browser remain bound to their respective actual revisions;
neither is represented as running on a later documentation-only commit.

The completed browser/retention proof is
`final-browser-retention-qualification-v2.json`, SHA-256
`4a1aee6f3b4dad8207fffcb06ba5b03dbf52c4d5de98dcf4cc283b7be5fecc7e`. Qualification records are retained locally under
`.runtime/completion-20261007/`; they contain no production upload or native
mutation. Root `.env` and the private root live-read sample remain unread.
Hosted Actions are neither run nor queried. The subsequent documentation-only
release must independently pass fresh public-source/report freshness and
packaged identity verification before the sole Work-here push.

These results qualify isolated Windows services, synthetic provider/Sheets
fixtures and selected automated accessibility checks. They do not certify live
Sheets delivery, native writes, private-program entitlement, a Linux/container
image digest, production load, every external MCP client or complete manual and
physical-assistive accessibility. Deployment observations remain separate from
the earlier healthy `bf84eab` pre-release snapshot.

An actual **thirty-minute wall-clock** HTTP upload test also passes. The
isolated authenticated HTTP upload, completion and thumbnail paths use actual
FFmpeg and the real clock. The independent cleanup timer removes stored source,
chunks and thumbnail metadata **1,292 ms after the original deadline**, without
an intervening HTTP or worker cleanup trigger. The next thumbnail request is
404 `MEDIA_SOURCE_NOT_FOUND`. No production file/account is touched and no
native provider request occurs. This is separate from the earlier mocked-clock
exact-boundary HTTP test and short processor-expiry tests. The completed
wall-clock proof SHA-256 is
`9434094238d1f0c67b0c90dc58899c1609ba2965fc0240534706a3ee0b1a5c36`.
Access refusal remains exact at the deadline; timer deletion remains bounded by
the running process's fifteen-second cleanup interval. Existing external
backups and provider-hosted assets retain their separately documented scope.

Additional owner-authorized native **read primitives** preserve exact account
selection without creating a report snapshot/job, upload or Sheets delivery.
Google v25 accepts the ad-group/ad resource selector and separate ad-group
selector for 4 October, with a native five-row limit; both responses are empty
(references `c05e4dde-7636-40ba-996f-9c1a2cbec166` and
`373b00b4-644f-42e1-a430-4f44264f0d2d`). The selected LinkedIn creative reads
also return accepted empty responses for the earlier recorded windows.

Meta v26 GETs return five populated daily rows at each ad and ad-set level,
with exact account/currency/campaign/ad-set identity and ad identity for ads.
Four rows at each level contain the selected native purchase action/value; one
omits action values and remains unavailable. References are
`f5495f18-13f3-4768-b2cc-8e0db51952b4` and
`8c33a05f-db81-4a6c-aaed-686e5c7ea991`. Requests use explicit 7d_click plus
1d_view, impression time and one five-row page. The ad response reports further
pages. Earlier five-item MCP projections truncated nested action arrays; those
observations remain retained, and the repeat increases only the MCP array
projection ceiling to 100 while keeping the native page at five rows.

These accepted read primitives establish their exact provider observations,
not complete collection, current-authority bracketing, normalized snapshot
acceptance, comparative reconciliation or end-to-end Sheets delivery. Native
account mutations remain zero.

LinkedIn's [reporting schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09)
and [conversion tracking](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-09)
were rechecked. Aggregate creative/campaign conversion fields and current
conversion-rule windows are different evidence. Inference: current rule
settings alone do not establish the aggregate report's historical conversion
windows. Exact rule-level binding and native historical meaning remain needed;
the tool does not manufacture that evidence from aggregate counts.

## Deployment asset consistency and static privacy contact

The first deployed `3dffa56` browser observation exposes an actual cache defect:
the HTML selects Dark, but the cached token stylesheet contains no dark palette,
the resolved paper color is still `#f7f6fa`, and sign-in has no visible appearance
control. Anonymous asset responses carry `max-age=14400` after the edge, while
the origin asks versionless clients to revalidate. Direct fresh public reads
match the current files; they do not establish which bytes an existing browser
uses. The original browser observation and screenshot remain retained.

Every served public HTML page now references `/assets/v/<content SHA-256>/<file>`.
The same version binds the lazy module loader and Arabic catalog. The server
holds one immutable, bounded public-file snapshot, excludes hidden files and
refuses symbolic links or unstable reads. Versioned responses preserve exact
bytes across compression, conditional GET and HEAD. A new process refuses an
unavailable earlier version with an uncached 409; it does not silently serve
new module bytes under the earlier identity. Existing versionless links keep
their original revalidation behavior. API, provider and private media URLs are
not rewritten, and no account permission changes.

The local real-browser cache regression passes all five checks with HTTP caching
enabled and no Playwright routing. Its negative control retains actual older
public token/localization bytes for four hours, proves the browser reuses them,
and reproduces a mixed-release startup failure. The versioned visit loads fresh
bytes in that same context, renders dark sign-in, retains entered form values
when appearance changes, obtains the Arabic catalog under the same identity,
and preserves appearance/language on About. Both full policy languages and the
original mailto contact also work with JavaScript disabled. All provider reads,
account mutations and external browser requests remain zero. Earlier custom
driver failures are retained, including two missing public proxy routes and
the existing language-change confirmation for entered test fields; neither
production safeguard was weakened to pass the driver.

The observed Cloudflare email transformation had replaced the privacy address
and injected `email-decode.min.js`. The public contact in both policies uses
Cloudflare's [documented per-address HTML exemption](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/#prevent-cloudflare-from-obfuscating-email).
Policy content, destination, scope and date are unchanged. The maintained
public comparison now compares exact locally rendered versioned HTML; unknown
edge differences remain failures. The earlier source-byte failures stay
separate from this fix and its subsequent deployment acceptance.

The focused source checks pass **65 tests**, including immutable snapshot
identity, same-size file changes, stale-version refusal, encoded/conditional
responses, private-path refusal, real theme/lazy-loader integration, static
privacy, Arabic loading, About and existing route-loader recovery. Whole
release/source/browser gates and the new live deployment remain to be recorded
for this additional change; the preceding 5,077/1,184 successes do not certify
these changed inputs automatically.

The first whole-suite attempt retains **5,077 passes and four failures out of
5,081 tests**: two deployment checks expected the original versionless script
URL, and the two source ownership inventories expected 437 instead of 438
TypeScript files. The second attempt corrects only the wrapper inventory and
retains **5,078 passes and three failures**. Neither run reaches the subsequent
capture/full-release gates. The complete deployed smoke check now requires the
same exact 64-character content identity for the theme and Reporting Overview
script and requests that precise versioned script. Both inventories count 438
files while preserving all existing message ownership, Arabic, native-token
and numeric assertions. All **31 focused deployment/ownership/asset tests**
pass after these corrections; no translation or production guard is relaxed.

The fresh public-only v13 candidate records each actual command exit and log.
Offline installation, compilation, public report generation/freshness, the
complete default check and Railway compatibility all pass. The new clean-source
rendered matrix also completes successfully, as recorded below. All three
generated public reports are copied from the sanitized candidate before the
source commit and remain byte-identical; the root environment and private
historical sample remain unread.

## Completed public-asset release qualification

The v13 default check completes successfully: **5,081 main tests and four
capture tests**, zero failures, cancellations or skips, and required FFmpeg.
Every install/build/report/freshness/check/Railway stage records actual exit
zero. The full check ran from `2026-10-07T03:43:42.450Z` to
`2026-10-07T03:54:41.844Z`. Its manifest SHA-256 is
`e020487750a12aa0a90fb02bb5267ba5e610bd0d91fcb97b3e473d446da337e5`.
The candidate records its actual precommit snapshot rather than claiming
execution on a later clean commit. Effective application inputs equal the
subsequent clean source; one appended nonpackaged delivery record differs.

Clean `ea5ceb08c7774a8e292620bdf43ed30bb7587c2c` passes the complete
**1,184/1,184** rendered cases from `2026-10-07T03:45:43.476Z`
to `2026-10-07T04:44:25.643Z`. Both languages and appearances
have 592 cases each; widths 320/375/768/1280 have 340/252/252/340. Sixty-one
actual fixture lifetimes serialize any shared tenant and allow at most two
independent lifetimes. All sixteen detailed-report/Sheets fixture journeys
pass. Real provider writes and live Sheets delivery are not inferred.

The clean v14 candidate passes eight source/report/format/web/docs/Railway
gates and matches all 1,943 public sources plus one generated literal empty
sample. Its manifest SHA-256 is
`7cfe040e964c581819b769ccf4e990e100715a9511763157a10f1da8104bd2f3`.
Full-suite and clean-source applications are byte-identical: 1,356 files /
52,402,377 bytes, SHA-256
`69d97019d67ee6bede460019be74f49d13316e9fbd0168019708773fe20f03b1`.
The public-file version is
`e5f20668edcfc5ddc4770b7070d435d509d075f3f12e2ad8b52048e6e73236b9`.

A separately tested stronger browser wait passes **16/16** cases before
byte-for-byte adoption into the maintained helper. It binds both the initial
ad result and following ad-set result to each exact acknowledged report ID,
instead of matching a repeated row name. Every existing identity, purchase
pointer, appearance, consent, export and original-tab assertion remains.

The optional installed-Chrome 154.0.8037.98 matrix was stopped after **157
completed observations, zero passes and 157 failures**. Of these, 133 fail
the strict external-request guard, eight static-policy checks see an extra
script, and sixteen detailed-report checks expose the original unbound wait.
The external URL names Kaspersky, whose [official documentation describes
web-traffic script injection](https://support.kaspersky.com/help/Kaspersky/Win21.7/en-US/201001.htm).
Those observations do not qualify installed Chrome, and the report failures
are not all attributed to that injection. Original results/logs remain
intact. No security setting, application logic or strict guard changed to
bypass them; the independently tested snapshot wait is the sole helper fix.

The actual thirty-minute retention result remains tied to its original
runtime and clock. All 436 other complete runtime sources and the website
private-handler prefix match that test; the new helper and website changes
serve public assets only. The original 1,292-ms timer-deletion result is
carried across those verified unchanged inputs, not presented as a new
30-minute run. The completed proof is
`final-browser-retention-qualification-v3.json`, SHA-256
`c8a9329374ab3fb70ead44282042a5b2131e855c05de1642f50813eb5191180b`, retained under
`.runtime/completion-20261007/` alongside the five passing cache checks.

The final source commit must independently pass fresh public report
regeneration/freshness and exact Git/candidate/root/package verification.
Later documentation/test-wait edits do not relabel actual full-suite or
complete-browser source revisions. Root private inputs remain unread;
Actions and account mutations remain unused. Deployment acceptance requires
the actual matching public release plus versioned bytes and a real existing
browser observation. The wider 13/15/0 audit remains unchanged.
