# TikTok asynchronous reports — implementation evidence

Status: the full sanitized required-FFmpeg release check passes: 1550 main tests
and four capture tests, zero failures/skips. Candidate B completed on September
25; [machine evidence](TIKTOK-REPORTS-VERIFICATION-2026-09-24.json) retains both
candidates and initial failures. This does not complete every provider action or
qualify TikTok permissions/live reporting.

Base revision: `45dc9bd33f2d1874f70a98a36164d89566bf4953`, Codex-branch,
`https://github.com/magdyezy1/AMCP.git`. Work is confined to the implementation
checkout. Parent development and historical release checkouts remain separate.
Node 24.19.0, npm 11.17.0, Windows PowerShell; portable FFmpeg/ffprobe 9.0.2.
No live provider/account changes or deployment operations occurred.

## Findings and completed behavior

P2, confirmed missing capability: both task/async create aliases mapped to the
right POST route but lacked a reviewed contract. Initial positive tests failed
with WRITE_CONTRACT_UNAVAILABLE. The two cancellation aliases were also blocked.
The four check/download entries had generic read classification without an
original-task/connection/token binding. A mapped read did not establish working
report retrieval. The native default CSV_STRING response was incompatible with
the JSON-only transport; this was established from transport inspection and the
rendered official response documentation, then exercised through the new workflow.

The new `tiktok_report_jobs` family covers four reviewed actions and qualifies
the four existing read aliases. Creation remains a reviewed mutation because it
creates a provider job and consumes quota. Cancellation only applies to an AMCP
submission that is currently queued/processing. No advertising configuration,
spending policy, account write grant or deployment control is bypassed.

P2, confirmed output correctness defect: a requested row limit left the returned
report marked complete and applied the same limit to definition/column arrays.
`tiktok-projection-baseline.log` preserves the failing test. TikTok output now
projects data rows only, retains metadata, and reports source/returned counts,
selected fields and whether empty values were omitted. A sliced response marks
both inner completeness and outer truncation correctly. A Criteo probe using the
same input failed schema validation because that operation does not expose
max_items; it is a rejected hypothesis, not a confirmed Criteo production defect.

## Workflow and contracts

1. Select one advertiser/connection and a native BASIC or AUDIENCE definition.
   Inspect its contract and preview the request without credentials or egress.
2. Prepare: validate native fields; read exact advertiser identity, currency and
   timezone twice; bind the current token fingerprint; review the frozen request.
   Volatile request IDs and unrelated advertiser names/status do not cause a
   report-state conflict. Real currency, timezone, identity or token changes do.
3. Execute with the original review/key and confirmation. Shared SQLite admission
   caps creation at one per second across the deployment and 500 per account in
   a rolling hour. This is conservatively stricter than separate apps/users. It
   cannot reset by changing connection/client-ID metadata. A pre-dispatch rate
   error rolls back the idempotency claim and keeps the same review usable.
4. A validated code=0/data.task_id receipt creates a tenant/connection/task binding
   atomically with completion. It retains the original definition, account
   metadata, token fingerprint and submission-time 30-day expiry. It grants no
   advertiser entity ownership. Reused IDs cannot replace the original binding.
5. Verify the original review or read status using the original task/account pair.
   Polls preserve QUEUING, PROCESSING, SUCCESS, FAILED and CANCELED distinctly.
   SUCCESS verifies job processing; it does not claim rows were downloaded.
6. Download: fresh successful status → authenticated CSV stream → fresh successful
   status, with current actor/account/token checks around each network request.
   A 60-second monotonic deadline bounds attempts, including native HTTP aborts.
   No signed output link or TikTok access token is sent to the client for relay.
7. Cancellation has its own prepare/execute/read-back path. QUEUING→PROCESSING is
   the same cancellable state; SUCCESS/FAILED/CANCELED stops cancellation. A
   terminal transition after dispatch can still reject the provider request.
   Lost submission/cancellation responses never cause automatic retries.

Completed receipts survive restart. Revocation after acceptance withholds results
while preserving completed idempotency. New token credentials cannot read a task
bound to the original token. Expiry cleanup prunes task bindings and inactive
quota records; it never deletes completed/uncertain claims to permit resubmission.

## Supported input and explicit limits

AUCTION_ADVERTISER/CAMPAIGN/ADGROUP/AD with one corresponding ID dimension;
optional stat_time_day or stat_time_hour; documented audience dimensions; up to
100 native metric names and 12 dimensions. Metric names are syntactically bounded
and remain subject to TikTok's actual asynchronous compatibility and permissions.
An accepted synchronous metric combination is not an async qualification.

Dates are inclusive in the native advertiser timezone. BASIC lifetime reports
exclude time/audience breakdowns and conflicting dates. Country/audience UV
restrictions are enforced. ID filters use native IN JSON strings, with a total
20,000-ID ceiling and the separate 100-ID ad_ids_v2 restriction. Upgraded Smart+
ID incompatibilities are enforced. Filters constrain the account report; they do
not create ownership grants for selected campaign/ad IDs.

The current family requires CSV_STRING and untranslated titles. Multi-advertiser
submissions, signed CSV/XLSX downloads, CATALOG, playable reports, CHUNK and
deprecated reservation-only levels remain outside it. This is an explicit
request variant boundary, not a claim that TikTok removed those API features.
The async-specific documentation contradicts some generic enum/filter sections;
the implementation does not use older Postman page/page_size examples, assume
playable async support, or enable disputed country filters.

CSV parsing supports BOM, CRLF/LF, quotes, doubled quotes and embedded newlines;
rejects invalid UTF-8, malformed widths/titles, duplicate grain, invalid IDs,
out-of-range dates, NUL and unclosed quotes. Limits: 8 MiB, 25,000 data rows,
112 columns and 64 KiB per cell. Every native value stays a string, including
large IDs and exact money; empty stays distinct from zero. No ratio/frequency,
currency or attribution aggregation is invented. Provider strings are labelled
untrusted and are never executed as instructions or formulas.

Account identity is proved through the original task/request and native
advertiser discovery. A returned advertiser_id dimension is checked exactly;
at lower grains TikTok's advertiser-scoped task contract supplies the account
boundary. Parent/filter columns are checked when present, not invented when absent.
The known country_code→country_name alias is explicit and never represented as a
verified ISO code. Currency metadata and native currency columns must agree.

TikTok provides no independent output count or checksum. A successful fenced,
structurally valid transfer is marked source-complete with this evidence limit
and provider_count_verified/checksum_verified=false. The local SHA-256 is an
output fingerprint, not provider checksum verification. Arbitrary complete-looking
provider truncation cannot be independently disproved from the documented API.
Recent data refreshes only every several hours and conversion attribution can
change. Raw output rows are returned to the authorized client but omitted from
the audit receipt; report definitions/metadata remain in the audit.

These native tasks are independent of existing dashboard/scheduled synchronous
reports. CSV output is not silently converted into the cross-platform metric
model or installed into a user's existing report/Sheets schedule.

## Source evidence and verification

Official portal pages were read in the background browser on 2026-09-24; the
canonical URLs resulted from navigation from the official SDK/portal links:

- [Create](https://business-api.tiktok.com/portal/docs/create-an-asynchronous-report-task/v1.3):
  native request/receipt, rates, validity, async-specific restrictions and freshness.
- [Status](https://business-api.tiktok.com/portal/docs/get-the-status-of-an-async-report-task/v1.3):
  required advertiser/task pair, same access token and five native statuses.
- [Download](https://business-api.tiktok.com/portal/docs/download-the-output-of-an-async-report-task/v1.3):
  CSV_STRING stream versus JSON signed-link modes and one-hour link validity.
- [Cancel](https://business-api.tiktok.com/portal/docs/cancel-an-asynchronous-report-task/v1.3):
  same-token requirement, queued/processing precondition and CANCELED receipt.
- [Advertiser](https://business-api.tiktok.com/portal/docs/get-ad-account-details/v1.3):
  exact native identity/currency/timezone fields and data.list envelope.
- [Official SDK create model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/ReportTaskCreateBody.md)
  and [cancel model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/TaskCancelBody.md).

The two SDK model field sets and public source hashes are pinned in
`tests/fixtures/tiktok-report-v13.json`. Portal lifecycle observations are labelled
manual separately. Reproduce with public SDK Markdown files and:
`node tools/tiktok-report-evidence.mjs --source-dir <download-directory> --check`.
Static web extraction returned zero content lines for these JS portal pages;
rendered browser evidence succeeded. The browser tab was closed after research.

Local evidence is retained under `.runtime/contract-completion-20260924/`:

- tiktok-report-baseline.log: two expected WRITE_CONTRACT_UNAVAILABLE failures.
- First build: incomplete import-marker edit stopped its helper; one TS index
  narrowing error. Expanded test builds then exposed fixture CallOptions/cleanup
  signature mistakes. These were corrected without changing product assertions.
- tiktok-report-expanded.log: 23 pass / one fixture failure. The disabled
  deployment rejects preparation itself, so it never produced an executable ID.
- tiktok-report-focused.log and tiktok-revocation-first.log: a supposed revocation
  fixture used an invalid enabled connection with no accounts. The owner API
  correctly rejected it. The fixture now actually revokes account 123 by changing
  the allowed account set; result withholding and retained completion both pass.
- tiktok-report-combined.log: 81 pass across the first 27 TikTok tests plus
  Criteo reports, Google previews, transport and reviewed-write regressions.
- tiktok-projection-baseline.log: confirmed false completeness after row slicing.
- criteo-projection-baseline.log: unsupported input; hypothesis not reproduced.
- tiktok-report-projection-fixed.log: 38 pass / zero fail/skip, including 30 TikTok
  tests and current guidance/inspect-example tests.
- Candidate A passed all 1550 main and four capture tests, then its report stage
  rejected missing guide coverage for TIKTOK_REPORT_TOKEN_CHANGED. The guide now
  names the refusal and explains original-token recovery; no exemption was added.
- Fresh candidate B (.release/tiktok-reports-20260925-b, 584 files) passed the
  entire required-FFmpeg check, including web, lifecycle, generated contracts and
  action coverage. Source tree hash:
  4ceea69a653412f02faf77b6579860acb33345dd61634eaef797ebbb4f615dc4.
  The staged code/tests/guidance are compared with that candidate, apart from
  normal Git line-ending normalization. Later evidence-only recording is separate.

Regenerate with `npm.cmd run build`, `node dist/tools/generate-contracts.js`,
`node dist/tools/action-contracts.js`, then update the remaining CSV with all
fourteen columns. Final inventory: 3241 actions; 438 reviewed-family, 886 blocked
writes, 88 unmapped, 23 unqualified reads, eight input-dependent, four retired;
1009 remaining rows including retired entries. Counts are not live qualification.

## Rollout and follow-up

No schema migration or runtime dependency. Task/quota document kinds are additive.
Deploy only the full-tested sanitized artifact. Rollback must retain the original
bindings/receipts: older binaries will not understand the new family or cleanup
kinds and cannot be used to retry pending/uncertain writes. Shared coordination
requires the existing single SQLite source of truth; independent replica databases
cannot coordinate one provider quota. Other apps can still consume vendor quotas.

Live validation needs separately authorized TikTok credentials/app reporting
permissions: actual headers and metric combinations, historical/disabled accounts,
task lifetime, provider failure messages, and large complete reports. Docker/Linux
and deployment storage/restore validation remain external checks. Signed download
formats require a provider-host/path contract, bounded server transfer/parser,
credential isolation and separate qualification. Dashboard async selection needs
an explicit metric crosswalk and schedule/job-resumption design; do not replace
working synchronous/CSV/Sheets flows just to increase action counts.
