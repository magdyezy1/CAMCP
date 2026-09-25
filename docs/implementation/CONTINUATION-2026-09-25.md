# Continued implementation — 2026-09-25

Baseline: `04ebe041b394c230220f8843070aef607c1e7774`, clean
`implementation-Codex-branch` checkout on `Codex-branch`.
The user requested completing the remaining work and batching pushes.
No live advertising, credential, provider-permission or production changes.
The 1000-row action backlog remains separate from the reliability work below.

## LinkedIn multipart authority and receipts

Confirmed: signed binary PUTs continued after organization, private Drive or
login withdrawal between parts. Existing account withdrawal already stopped
later parts but had no retained part receipt. Ten initial tests failed; not
all ten represent separate vulnerabilities (some assert the new recovery data).

Changes in `src/media-upload.ts`: bind initialization, parts and finalization
to current login/actor/account/owner/Drive authority; keep signed instructions,
upload tokens and ordered ETags in the encrypted upload-session store. Preserve
allocation and confirmed-byte progress before checking permission for the next
step. Check instruction expiry. Retain finalization outcomes before fallible
read-back. No automatic LinkedIn resume or resend after uncertain uploads.

Evidence: `linkedin-media-authority-baseline.log` has 10 failures.
The first compatibility run passed 63/64 with one optional FFmpeg skip.
Expanded required-FFmpeg run passed all 76 tests, no failures/skips:
`linkedin-media-authority-required.log`. Includes 18 added LinkedIn tests,
four Google chunk tests and existing media/private-source/creative tests.
Logs are in `.runtime/contract-completion-20260924/`.

Official reference checked 2026-09-25:
https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09
The documented ordered part ETags, upload expiry and owner permissions inform
this implementation; account-specific native acceptance remains unverified.

## Sheets authority and durable delivery

Confirmed: login/source/destination/lease changes could permit later delivery.
A successfully returned write could lose its local receipt when a later
authorization check failed. Pasted-URL binding could grant selection from a
previous login's read. Spreadsheet creation did not retain a received file ID
when the caller lost authorization before the grant.

Implemented locally: current request and commit authority, source callbacks from
both reporting worker paths, destination lock and binding checks, completed
delivery receipts bound to report content, and an atomic native delivery marker
for reconciling lost responses. Unknown outcomes only poll for their original
marker; they do not resend automatically. Accepted effects are saved before
late denial. Spreadsheet creation keeps its received ID without granting access
to a withdrawn actor; replay verifies the retained file with the current login.

Original baseline: 2 passed/8 failed. The first wrapper accidentally returned
the subsequent `rg` exit status; the retained `baseline-exit` run correctly
returned 1 with the same 8 failures. Two additional creation/binding tests failed
before their correction. First compatibility run: 40 passed/1 failed because the
old test expected a duplicate POST for an already confirmed export. It now proves
local replay and a separate new report updating the same owned tab; typed cells
and ownership assertions are retained. One interim TypeScript failure was fixed
by narrowing the replay union in the test. Latest combined run: 46 passed, no
failures/skips (`sheets-authority-combined.log`).

Official references checked 2026-09-25:
https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request#updatedevelopermetadatarequest
Native batch updates apply the marker and report cells together. Concurrent
human edits can subsequently alter the sheet; a retained receipt establishes
historical delivery, not perpetual equality of live cells.

The worker/restart pass now has 55 passing tests, no skips
(`sheets-authority-order.log`): 24 new Sheets fixtures plus 31 compatibility
tests. Five malformed-success envelope fixtures failed before stricter response
validation. One compatibility fixture then failed because it omitted Google's
spreadsheet ID; native fixtures now return exact spreadsheet IDs and a reply for
each atomic request. The schedule test now checks completed jobs/delivery receipts,
not just HTTP call counts. SQLite close/reopen recovery and original source/schedule
withdrawal through worker dispatch are exercised. An additional failing baseline
proved that a newer report could overtake an uncertain write; the destination now
waits for reconciliation of that original report. All initial logs are retained.

The maintained media and reporting guidance now describes these recovery rules.
The stale Microsoft fixed catalog count in the first-party skill was replaced
with current discovery instructions. These updates add no provider write family.

## First full release candidate

Candidate `.release/continuation-20260925-a`: 621 files, source manifest hash
`9bf398461ea614b9d92e33b63d9df0faba42a89c8fe968b243e7fcaabdb99fef`.
Offline clean dependency installation succeeded. Required-FFmpeg `npm run check`
reached 1788 main tests: 1786 passed, 2 failed, zero skipped (370699 ms).
Both failures were older Sheets fixtures returning empty replies without a
spreadsheet ID (`report-periods` and `audit-report-quality`). Those fixtures now
return the exact spreadsheet and one reply per request. Numerical, partial-source,
formula, CSV and typed-cell assertions remain intact. Candidate A and its initial
failure log are retained; subsequent check stages did not run after test failure.

## In progress / next acceptance gates

### Conversion definitions and dependent workflows

Implemented the native v23 ConversionActionService contract on all four mapped
surfaces (RPC plus create/update/remove aliases). Explicit business inputs,
exact mutable leaf masks, client ownership and current conversion-customer
checks, complete definition/goal dependencies, policy and spend confirmation,
strict per-operation receipts, read-back of automatic standard-goal creation,
and original-key crash/concurrency behavior are exercised synthetically.
Six manual definition types are qualified; this does not implement event
ingestion, imported app/GA4 setup, manager sharing or current App dependencies.
Remaining exact type/range limitations are in the Google guide and runtime impact.

The first family inventory test failed before implementation. The first lifecycle
run passed 6/27 and failed 21 because its query fixture accidentally matched
`!= 'MULTI_CHANNEL'` as `= 'MULTI_CHANNEL'`. Correcting that fixture produced
27/27. Two added graph tests then reproduced a missing-goal baseline and an
existing false refusal on system/former-manager observations. Corrections preserve
those observations without granting mutation/custom-goal membership ownership.
The expanded definition and existing-goal run passed 67/67.

A real `amcp_campaign` dependency test subsequently failed: symbolic preflight
guessed `campaigns` for a conversion result from its action name. It now derives
the resource collection/customer from the compiled predecessor route and checks
the result index/resource-name pointer. The creation → verified custom-goal test
and existing custom-goal attachment/recipe tests pass after the correction.
No assertion was removed to obtain those results. Initial logs are retained as
`conversion-actions-first-lifecycle.log`, `conversion-graph-baseline.log`,
`conversion-actions-integration.log` and `conversion-workflow-baseline.log`.
Two interim TypeScript errors were corrected (literal indexing and the test store
API); an exploratory public HTML download timed out, then official field tables
were retrieved through the web tool. No credentials or account calls were used.

Eight public v23 proto hashes and native field-table evidence are pinned in
`tests/fixtures/google-conversion-actions-v23.json`, reproduced by
`tools/google-conversion-evidence.mjs`. Official references are linked in the
Google guide (checked 2026-09-25). These support contract correctness, not live
acceptance. Updated machine-checked guidance examples cover create/update/remove.

Inventory now: 3241 catalog rows, 442 reviewed-family rows, 882 blocked writes;
996 remaining rows in `REMAINING-ACTIONS-2026-09-25.csv` (79 unmapped, 23
unqualified reads, 8 input-dependent and 4 retired/provider-unsupported in addition
to the blocked writes). Prior dated backlog remains historical evidence. The
separate vendor-method inventory and broader audit tickets remain open.

- The final selected conversion/goal/portfolio/guidance/recipe run passed all
  99 tests, no failures/skips (`conversion-actions-qualified.log`). The full
  candidate is still required; these tests do not establish provider acceptance.
- Run the full required-FFmpeg check in a fresh sanitized release candidate.
  No passing full check or new commit/push has yet qualified this continuation.
- Continue exact provider families from `REMAINING-ACTIONS-2026-09-24.csv`,
  remaining reporting/connection integrations and the broader audit tickets.
  Do not interpret these safety fixes as completion of the action catalog.

## Second full release candidate and Windows cleanup

Candidate `.release/continuation-20260925-b`: 626 files, source manifest
`0e731edea534e407cfc0015f27b69ae32ccbca108c1a01b583e36d1d7803ca03`.
Offline clean dependency installation succeeded. Required-FFmpeg full check:
1821 main tests, 1820 passed, one failed, zero skipped (395899 ms).
The spend-policy restart assertions passed; removal of the temporary test
directory failed with Windows ENOTEMPTY. A scoped read after the run found that
directory empty. The restart/worker fixtures now use the existing guarded,
bounded-retry test cleanup helper. Financial assertions are unchanged.
The focused policy suite passes 13/13 (`ci-cleanup-policy.log`). Candidate B
and its initial failure remain intact; later full-check stages did not run.

## X asynchronous reporting

Implemented the documented v12 reviewed POST and original-job GET with an explicit
server download control. New modules: `src/x-report-jobs.ts` and
`src/x-report-download.ts`. Scope and recovery details, sources and limits are in
`X-REPORTS-2026-09-25.md` and the LinkedIn/X guide. Cancellation, a native
platform filter and automatic dashboard/schedule backfill are not implemented.

Initial inventory test proved creation blocked. Initial lifecycle run: 6 passed,
23 failed because the generic review guard rejected native query-only POSTs.
After the exact contract exception: 27 passed, two failed due to incorrect test
preconditions (native bypass needed explicit confirmation; verify distinguishes
outer operation success from verification failure). Corrected fixtures retained
all guard assertions. Selected X/TikTok/parameter suites passed 110/110. Expanded
X suite: 34/35; a fixture attempted an invalid empty enabled-account binding
instead of withdrawing the original account. Correct valid withdrawal fixtures
then passed all 35 tests, including nine in-flight authority cases.

A final edge test exposed immediate native FAILED jobs losing their binding and
retaining a processing quota slot. Its first run had an incorrect outer-success
expectation; the corrected baseline reproduced missing persistence. Valid job
receipts now persist regardless of a failed job outcome, release terminal quota,
remain failed, and replay without another submission. The focused regression
passes (`x-report-terminal-fixed.log`). Unknown/malformed receipts still retain
uncertain claims and admission rather than guessing provider completion.

No live X requests or production changes were made. Full release qualification,
cross-family checks and exact candidate/source reconciliation remain required.

Final X/creative/targeting/TikTok/parameter/policy/guidance selection:
137 tests passed, zero failed/skipped, 28769 ms
(`x-report-final-selected.log`). X has 36 tests including the immediate-failure
receipt regression. All declared families have compiled guide examples.
Inventory: 3241 rows, 443 reviewed families, 881 blocked writes; 995 unresolved
rows including 79 unmapped, 23 unqualified reads, eight input-dependent and four
retired methods. Historical ledger entries above retain their original counts.

## Third full candidate: catalog extension assertion

Candidate `.release/continuation-20260925-c`: 630 files, source manifest
`758bbcb31a1f3132a30d60e7fc1601b8dff99e950ffb6a4ccbb76644df70806a`.
Offline clean installation succeeded. Required-FFmpeg full check: 1858 tests,
1857 passed, one failed, zero skipped, 400748 ms. The capture-preservation test
did not yet recognize the declared X `download_report` schema extension. It now
asserts that exact extension (including its full description), verifies help and
tool-list agreement, and deep-compares every remaining field with the unchanged
capture. The assertion was not removed or broadened to arbitrary extensions.
Candidate C and its failed log remain unchanged. Later check stages did not run.

## Snapchat nested ad/ad-squad updates

New `src/snapchat-nested-updates.ts` qualifies ten existing aliases covering four
native v1 parent routes (ad/ad-squad PATCH and full collection PUT). It validates
the exact account → campaign → ad squad → ad chain from current responses on
both sides of review. Prior account-scoped discovery is still required; a guessed
ID or returned foreign record never grants access. State reads are bounded to
110 requests, 60 seconds and eight MiB, with authority checks around each request.

The documented editable field subset includes delivery state, name, dates,
auction bids/budgets, content categories and original ad tracking URLs. Complete
PUT preserves immutable/untouched settings and refuses missing or unknown
configuration; PATCH avoids provider replacement defaults. IDs, currency,
parent objectives/regulations, targeting, budgets and ordered tracking lists stay
in the guard. Delivery/review telemetry and expanded tracking metadata do not.
Deprecated native bid flags are checked against `bid_strategy` and excluded from
PUT inputs, as required by current provider documentation.

Spending policy uses each target's exact cap and native micros, not its parent or
sibling budget. Renaming an already-active ad or testing its state does not falsely
activate it. Actual activation, changed owner policies, review expiry, integrity,
role/grant withdrawal, failed/ambiguous receipts and crash/concurrency protections
remain enforced. Read-back is fresh even after a prior successful verification.
Warnings remain visible and no uncertain write is automatically resubmitted.

Initial inventory failed while these routes were blocked. Interim test build
issues and the initial path-parameter fixture mistakes remain in
`snap-nested-tests-build*` and `snap-nested-first-lifecycle.log`. Correct exact
path parameters produced 31/34 passing tests; remaining fixture corrections used
the actual reservation field and explicitly modeled rediscovery after a replaced
connection. `snap-nested-qualified.log`: 34/34 passed (includes six catalog tests).

Additional adversarial tests reproduced four real gaps in the in-progress family:
malformed native budgets were accepted, reserved/Smart Budgets were treated like
ordinary auctions, unchanged active PUT/test values triggered activation policy,
and changed parent conversion/regulation settings were absent from state hashes.
The 1/5 baseline is retained in `snap-hardening-baseline.log`. Corrections plus
the policy selection passed 61/61. Expanded Snapchat tests pass 41/41, including
maximum 25-record batches, native warning/legacy envelopes, lost-response restart,
fresh verification revocation and deprecated-input refusal (`snap-expanded.log`).
Final cross-family selection passes 183/183, no failures/skips, 5708 ms:
`snap-final-selected.log` (Snapchat, X, transport, budget policies, state guards,
catalog and all guide examples). These are synthetic tests, not live acceptance.

The v1 official ads, ad-squad, campaign and patch references were checked on
2026-09-25 and linked in the TikTok/Snapchat guide. Machine-checked examples and
provider descriptor revision 3 match this family. Native targeting/pixel/app,
placement/frequency/scheduling changes, reserved/Smart Budgets and the conflicting
individual creative PUT remain outside this new contract; see the exact impact
and guide. No unsupported action was enabled just to change a coverage count.

Regenerated inventory: 3241 rows, 453 reviewed-family rows, 871 blocked writes;
985 remaining rows (79 unmapped, 23 unqualified reads, eight input-dependent,
four retired/provider-unsupported, plus blocked writes). The separate 1208-method
vendor inventory and broader audit tickets are still open. There is still no
passing full check or new commit/push for this continuation at this checkpoint.

## Full qualification of the combined continuation

Fresh candidate `.release/continuation-20260925-d`: 632 files, source manifest
`e3997759633ccca24e13b2c5831a0a73d46c1137347bb481c1fd696fe95747bb`.
Offline clean installation and `AMCP_REQUIRE_FFMPEG=true npm.cmd run check`
passed: **1899 main tests, four capture tests, zero failures/skips**. Main suite
duration: 402969 ms. Generation, vendor/WSDL/feed integrity, public report, web,
provider integrity/lifecycle and contract/action checks all completed. The Railway
Dockerfile compatibility check also passed. Docker is unavailable locally; native
provider calls, deployed behavior and container smoke evidence remain separate.
The exact staged-code comparison and hashed logs are recorded in
`CONTINUATION-VERIFICATION-2026-09-25.json` once generated. The three earlier full
candidate failures above remain visible; this success does not erase them.

Browser qualification used candidate D's `tests/fixtures/reporting-browser.mjs`
on loopback port 43286, in-memory state and synthetic provider responses only.
Observed through actual UI navigation:

- Client A: account 100, daily grouping, seven complete daily rows for September
  18–24, USD 42.50/10000 impressions/85 clicks per row, unavailable conversions
  shown as dashes, explicit Needs Target guidance. CSV download event completed.
- Pasted Client A spreadsheet URL bound its own tab; queued export visibly became
  complete. Fixture recorded an eight-row Sheets batch (header plus seven rows).
  Weekly Monday 08:00 Africa/Cairo delivery was saved for daily data.
- New report cleared the account selection. Client B selected account 200,
  previous-calendar-month grouping/window, another spreadsheet and monthly
  day-one delivery. Both independent schedules and destinations appeared together.
- Saving a reusable template excluded both client identity and account selections,
  with that behavior explained in the UI. Both saved client reports remained.

Manual browser deletion is **not verified** in this pass. The in-app browser
control timed out on the template-delete confirmation; its dialog API returned no
dialog, then state/close operations timed out despite recovery. A prior label
selector also failed, while the same control worked through its observed accessible
role. These are recorded as browser-control limitations, not proven product defects
or successful deletion. The fixture process was stopped; no real Sheets or provider
data was changed. Server/HTTP deletion and independent-schedule regression tests
still passed in the complete suite. No new browser layout/mobile claim is made.

Additional public research confirmed that Google's v23 CustomizerAttributeOperation
has create/remove but no update oneof (despite an imprecise service comment).
The historical UPDATE alias must not be enabled as an invented native update.
TikTok's official SmartTextGenerateBody documents required advertiser/ad-group
context; its portal content and exact response contract were not established here.
Neither observation is counted as an implemented action. These are next-pass
qualification items, along with the remaining native families and audit backlog.
