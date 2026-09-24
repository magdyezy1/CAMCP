# Reporting and provider-contract continuation — 2026-09-24

Baseline: db617803e88e76986257617e633f156d59b97977, clean Codex-branch,
origin https://github.com/magdyezy1/AMCP.git. Remote baseline matched; main remains
067871481d79fc59a6cb976d8a13b62d409e283a. Development and historical release
directories are separate and are not edited. The user's latest request resumes
the full implementation effort and prioritizes four reporting changes.

## Current work

1. Independent named client reports, templates, new/duplicate/select controls,
   account selection and per-report destinations; edit and delete definitions,
   schedules and snapshots without overwriting unrelated reports.
2. Daily, weekly and monthly scheduling, calendar date windows and independent
   daily/weekly/monthly data grouping. Preserve existing hourly/total defaults.
3. Fix X circuit poisoning by terminal request errors; retain actual diagnostics,
   provider reset timing and genuine transient-failure protection. Check current
   native analytics fields, placements and null values against official docs.
4. Synthetic backend, UI and regression evidence; fresh sanitized full check;
   commit/push only Codex-branch. Then continue remaining qualified contracts.

## Confirmed baseline problems

- UI save always creates a view and loses its selected identity. There is no clear
  new/template/edit/delete workflow; schedules can pause/resume but cannot edit.
- nextSchedule accepts hourly/daily/weekly only. Reporting produces one total per
  campaign; there is no daily/weekly/monthly grouping.
- NativeTransport increments a tenant-wide platform circuit on every failed
  request, including terminal 400/401/403 and schema errors. Five such failures
  block unrelated accounts with CIRCUIT_OPEN, masking the underlying error.
- X reads unconditionally include PUBLISHER_NETWORK; current official synchronous
  endpoint enum lists ALL_ON_TWITTER, SPOTLIGHT and TREND. Historical examples on
  the same official page still mention PUBLISHER_NETWORK; use current endpoint
  parameters as the runtime contract and record this documentation inconsistency.
- X reporting rejects native null metric columns as malformed arrays even though
  official examples return them and explain null as no reported activity.
- Transport does not interpret X reset headers and caps retry waits at five seconds,
  which can retry earlier than the provider permits.

Official primary references accessed 2026-09-24:
https://docs.x.com/x-ads-api/analytics
https://docs.x.com/x-ads-api/fundamentals/rate-limiting
The historical developer.x.com synchronous URL redirects to a generic overview.
No live credentials, account reports, mutations or deployment access are used.

## Implementation

- `src/report-library.ts` owns saved report/template CRUD, revision checks,
  independent destinations, schedule edits/removal, and cancellation of stale jobs.
  Edits retain the report ID. Templates retain metric/objective/formula/calendar
  choices but remove client/account/destination/schedule identity. Limits are 100
  saved definitions, 100 templates and 50 schedules per workspace.
- `web/report-library.js` and `web/report-delivery.js` provide new, select,
  duplicate, template, edit and delete controls. Unavailable accounts remain visible
  with recovery instructions. Snapshot downloads stay separate from saved setup.
  Stale browser responses cannot replace a newly selected report.
- `src/report-periods.ts` queries each daily/weekly/monthly native period directly;
  reach is never added from daily rows to invent weekly or monthly reach. It retains
  completed periods and native job IDs across retries, exposes failed periods, and
  enforces 10,000 rows per source across all periods. Native timezone, attribution,
  quality and metric provenance survive the report, CSV and typed Sheets paths.
- Scheduling now accepts monthly day-of-month with short-month clamping. Calendar
  week/month presets and delivery frequency are independent of data grouping.
  Existing hourly/total defaults and legacy schedule-creation keys remain valid.
  `pause_schedule` is explicit; `delete_schedule` keeps its legacy pause meaning;
  `remove_schedule` actually removes the schedule and fences old jobs.
- Native transport now opens scoped circuits only for repeated transient failures.
  Terminal payload/access errors preserve their diagnostics without blocking other
  accounts. X respects shared user/account reset times, supports the three current
  documented analytics placements, interprets reported null columns as no activity,
  and resumes completed analytics batches without double counting.
- X creative review preserves `X_CREATIVE_STATE_UNVERIFIED` for incomplete HTTP-200
  envelopes rejected by transport, retaining the underlying sanitized native error.
  Authentication/rate-limit failures retain their original codes and recovery hints.

No database migration or npm dependency was added. Older saved reports default to
total grouping. Schedule definition versions fence edits/deletes from in-flight
workers; an external request already dispatched cannot be unsent. Deleting local
reports/schedules never deletes an external spreadsheet or its tabs. Audit records
remain. A rollback must retain durable job/receipt data; older binaries do not
understand monthly schedules, so pause those schedules before reverting.

## Verification so far

Windows / Node 24.19.0 / npm 11.17; all provider fixtures are synthetic. Root logs:
`.runtime/reporting-20260924/`. Commands use `npm.cmd` on PowerShell.

1. Baseline `npm run build` passed. Six new reproductions failed before fixes
   (`baseline-reproductions.log`). The first focused run passed 41 and failed one
   old X placement expectation; updated the assertion to the documented exact
   placement set and corrected the expected aggregate (not an accepted error).
2. The first expanded new-test run passed 21 and failed one invalid-template-default
   case. Fixed the input merge so validation sees the invalid field. Builds 3/4
   caught the same TypeScript test narrowing issue; builds 5 through 9 passed.
3. `node --test --test-concurrency=1 dist/tests/report*.test.js
   dist/tests/provider-circuit.test.js dist/tests/transport.test.js
   dist/tests/recommendations-hardening.test.js tests/report-library-ui.test.mjs
   tests/audit-report-quality.test.mjs`: 92 passed, zero failed/skipped.
4. `npm run check:web`: 12 scripts passed. `git diff --check`: passed.
5. Sanitized candidate A (`.release/reporting-20260924-a`) contains 546 files;
   source_tree_hash `b21b9defbeb86642e8957552bfbbd9a45c6f6eb399c5c6cff14bda71dc0a7213`.
   Initial `npm ci --offline --ignore-scripts` failed ENOTCACHED for
   zod-to-json-schema 3.25.2 and reported an EPERM cleanup warning. Reusing the
   existing `.runtime/npm-cache` with `--cache` installed 107 packages successfully.
   `AMCP_SCHEMA_PYTHON` points to the bundled Python runtime for generators.
   Candidate A `npm run check` failed: 1404 passed, one failed, one optional FFmpeg
   skip. The new HTTP-200 error handling changed a creative-review error code;
   restored the contract signal and strengthened its native-diagnostic assertion.
6. After that correction: `node --test --test-concurrency=1
   dist/tests/x-creative-writes.test.js dist/tests/x-draft-writes.test.js
   dist/tests/provider-circuit.test.js`: 46 passed, zero failed/skipped.
   Original failure logs are retained; candidate A was not patched in place.

Manual browser evidence used `node tests/fixtures/reporting-browser.mjs` on
127.0.0.1:43281, an in-memory workspace with no real account or credential access:

- Created client A daily report, renamed it without duplication, saved an unbound
  template, then created client B with another account and monthly grouping.
- Bound two distinct synthetic spreadsheet URLs. Saved A weekly and B monthly;
  day 31 clamped to September 30. Editing B's hour retained one schedule and its
  independent destination. A remained active after B was paused and deleted.
- Ran A for September 22–23: two daily rows, each 42.50 USD, 10,000 impressions,
  85 clicks and CPC 0.50, matching the backend fixture. Sheets delivery completed;
  CSV download fired and retained the reporting route. No JS errors observed.
- At 390x844 the content and scroll widths matched (no horizontal overflow).
  The delivery dialog fit, focused its close button, closed with Escape and returned
  focus to the invoking control. Its pending monthly settings survived binding.

These are local synthetic end-to-end observations, not deployed or live-provider
proof. `ffmpeg`, `ffprobe` and Docker are unavailable on this host. Required FFmpeg
mode, container smoke, live X permissions/rate limits and deployed behavior remain
unverified. No live advertising mutation or production configuration was changed.

## Remaining work and resume boundary

Fresh candidate B (`.release/reporting-20260924-b`) completed `npm run check` with
exit 0: 1405 main tests passed, zero failed, one optional FFmpeg skip; all four
capture tests passed. Generated catalogs/vendor/WSDL/feed checks, reporting, 12
browser scripts, offline provider drift/lifecycle, contract and action-inventory
checks all passed. Its 546-file source_tree_hash is
`f4821303873238e310f7f1dc7f07b7b125e72f3033a803b4ec02c22d8c0275ad`.
The only subsequent changes for this reporting commit are verification documents.
The candidate's baseline revision records the pre-commit checkout; its hashes
include the uncommitted executable changes. Final remote evidence belongs to the
task response and the commit containing this file. The synthetic browser server
and its temporary tab were stopped/closed after verification.

The 2026-09-20 handoff and action inventory remain the provider-contract baseline:
3241 rows, 423 reviewed-family, 894 blocked writes, 91 unmapped, 27 unqualified
reads, eight input-dependent and four provider-unsupported actions. That is 1020
incomplete plus four explicitly unsupported; this reporting batch adds no native
reviewed-write family. Vendor-method coverage uses a separate denominator.

Continue from `RESUME-HANDOFF-2026-09-20.md` tickets R1–R12. R11 now has a stronger
reporting UI/backend/CSV/Sheets fixture, but broader live journeys remain unproven.
R1 now has a reproduced local prerequisite gap: two synthetic negative cases use
foreign Facebook Page post / Instagram identity-and-media references. The stub
offers only different advertiser identities. `prepare` succeeds after only
`GET /v25.0/act_123`, without querying those identities. No mutation is permitted
by this harness. Repro: `.runtime/reporting-20260924/meta-owner-gap.test.mjs`;
two expected-denial assertions fail in `meta-owner-gap-2.log`. The initial harness
had a misplaced native connection_id argument and obtained a schema refusal; that
did not prove ownership and was corrected before recording this finding.

This demonstrates inconsistent AMCP prerequisites, not successful live Meta
cross-account exploitation. The existing positive Instagram fixture accepts any
GET as an account response and does not prove content ownership. The next fix must
reuse bounded account/Page/Instagram identity and native owner checks at both
prepare and execute, cover revocation/content changes, and retain private tokens
server-side. The public Meta IGMedia SDK 25.0.3 confirms an owner field and GET;
token/permission acceptance still needs the scoped workflow and live qualification.
Direct Meta documentation returned 429/unavailable on 2026-09-24; the Postman page
returned a shell, so neither was counted as newly verified permission evidence.
https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/igmedia.py
No Meta creative ownership implementation was added in this reporting batch.
