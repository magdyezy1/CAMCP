# TikTok change log download tasks — 2026-09-27

Base revision: `39ee55b` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the change log check and download reads were qualified, but a download task could not be
started through AMCP: `POST /v1.3/changelog/task/create/` was a blocked write, so the audit trail of
budget, status, bidding and targeting changes was out of reach.

Contract source: TikTok API for Business v1.3 "Create a change log download task" and "Check the
status of a download task", read on 2026-09-28. The task takes `advertiser_id`, `start_time` and
`end_time` (`YYYY-MM-DD HH:MM:SS`; "The largest time gap allowed is 30 days"), `timezone` (of the
returned values), `module` (BIDDING_AND_OPTIMIZATION, BUDGET, STATUS, TARGETING), `object_type` (AD,
ADGROUP, ADVERTISER, CAMPAIGN, INSTANT_FORM), `object_ids`, `operation_types` (CREATE, AUDIT,
STATUS, UPDATE, DELETE, DOWNLOAD_LEADS, SUBSCRIBE_FORM, UNSUBSCRIBE_FORM) and `order_fields`, and
answers `task_id`; the check reports PROCESSING, SUCCESS or FAILED.

## Change

New reviewed family `tiktok_change_log_tasks` (`src/tiktok-change-logs.ts`):

| Part | Behaviour |
|---|---|
| Request | `advertiser_id` of the selected advertiser; required `start_time` and `end_time` at most 30 days apart; optional documented `timezone`, `module`, `object_type`, `operation_types` and `object_ids` (1–100 strings, with `object_type`); nothing else |
| State | The advertiser (name, time zone and status only; its contact fields are not requested) and, for a campaign, ad group or ad filter, the named objects the advertiser has |
| Checks | Every named object belongs to the advertiser (`STATE_NOT_FOUND`); an ADVERTISER filter names only the selected advertiser; instant forms cannot be filtered by ID (their owner is not read) |
| Safety | Nothing in the account changes, so no spending confirmation (the family is exempt from the generic spend pattern, which a BUDGET module filter would otherwise match) |
| Receipt | `code` 0 with a `task_id`; anything else is a failure never resubmitted |
| Verification | The task checked by ID: SUCCESS verifies; PROCESSING is verified again later; FAILED is not verified |

AMCP requires both times because the reference gives no default window. `order_fields` is refused:
its values are not documented, and the example sends it as a string next to an undocumented
`order_type`. New refusal code: `INVALID_TIKTOK_CHANGE_LOG_TASK`.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (TikTok contract version 31). Guidance: a
change log paragraph in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an
executable inspect example.

## Tests

`tests/tiktok-change-logs.test.mjs`, three tests:

1. A task filtered to two campaigns reads them, starts, is not verified while PROCESSING and verifies once it reports SUCCESS; a replay sends nothing; an unfiltered task reads only the advertiser; ad group and advertiser filters are accepted.
2. Sixteen malformed tasks (no end time, an ISO time, a date that does not exist, an end before the start, a 31-day window, an unknown module, object type or operation, a repeated operation, IDs without a type, 101 IDs, instant form IDs, another advertiser as object, ordering, an unknown field, another advertiser) are refused before any request; campaigns and ads of other advertisers are refused after reading.
3. An error reply is never resubmitted; a FAILED task is not verified; the ledger lists the row in the family.

Red/green against a build of `39ee55b`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-change-logs-20260927/red-check.log`.

## Verification

- Targeted: 212 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,064/2,064.
- Guidance coverage: 344 write-path refusals across 206 modules accounted for.
- Full qualification: see
  [TIKTOK-CHANGE-LOGS-VERIFICATION-2026-09-27.json](TIKTOK-CHANGE-LOGS-VERIFICATION-2026-09-27.json).

Remaining rows: 704 (one TikTok row reviewed; TikTok blocked writes 168 → 167). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser with change history.
