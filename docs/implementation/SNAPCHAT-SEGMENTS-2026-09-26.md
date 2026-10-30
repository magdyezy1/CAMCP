---
status: record
tier: engineering
---

# Snapchat audience segments — 2026-09-26

Base revision: `874038e` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Retargeting and lookalike
campaigns need audience segments; segment creation and update were blocked writes.

Contract sources: Snapchat Marketing API audience guides, checked 2026-09-26:
[customer lists](https://developers.snap.com/marketing-api/Ads-API/audience-creation/customer-lists)
(create, update, delete, get and list, with GET/PUT response examples),
[lookalikes](https://developers.snap.com/marketing-api/Ads-API/audience-creation/lookalikes)
and [website events](https://developers.snap.com/marketing-api/Ads-API/audience-creation/website-events).

## Contract

Four captured actions join the reviewed `snapchat_entities` family:
`snapchat_audience_create` / `snapchat_adaccounts_ad_account_id_segments_create`
(`POST /v1/adaccounts/{id}/segments`) and `snapchat_audience_update` /
`snapchat_adaccounts_ad_account_id_segments_update` (`PUT` on the same path).

| Stage | Behaviour |
|---|---|
| Create validation | `src/snapchat-segments.ts`, before any read. `FIRST_PARTY` and `LOOKALIKE` only, with documented keys. `ad_account_id` must be the selected account. `name` ≤375. Retention is an integer: 1–9999 for lists (9999 = lifetime), 1–180 for lookalikes. A lookalike `creation_spec` has a Snapchat `seed_segment_id`, unique two-letter `countries` (or the deprecated `country`, which must agree) and `type` `BALANCE`/`SIMILARITY`/`REACH`. Failures are `INVALID_SNAPCHAT_SEGMENT` |
| Update validation | One `{id, name, retention_in_days, description?, ad_account_id?}` record each, 1–25 records. At review and again at execution, against the fresh read: the segment must belong to the selected account (`STATE_TARGET_MISMATCH`), and retention must fit the current source type (lists 9999, lookalikes 180, pixel audiences 395; other types are refused). An existing description must be restated or replaced (`INCOMPLETE_SNAPCHAT_SEGMENT_UPDATE`), because Snapchat PUT can reset omitted fields |
| Reads | Create reads the account and, for a lookalike, `GET /v1/segments/{seed}` before review and before execution. Update reads each `GET /v1/segments/{id}` |
| Ownership | `segments` joins the Snapchat global-ID ownership rules. An account segment list records only segments whose `ad_account_id` is that account; segments shared from other accounts appear in the list but are not owned. Created segments are owned when the receipt names the account. Single reads renew ownership only when they name the account |
| Review evidence | Segment state ignores `approximate_number_users`, `targetable_status`, `upload_status` and `status`, which change without an edit. Configuration changes still produce `STATE_CHANGED` |
| Impact | `creative_impact` lists each segment's source type and retention before/after. `may_affect_serving` is set when retention changes. (As first pushed it also listed an audience size that review normalization had already removed, so it was always `null`; removed on 2026-09-26 with the TikTok lookalike batch.) |
| Receipt / verification | The existing Snapchat receipt rule includes `segments`. Read-back compares a projection: countries upper-cased and sorted, deprecated `country` read as `countries`, provider status fields dropped. Any other difference stays `inconclusive` |

Not qualified, and still blocked:

- `POST/DELETE /v1/segments/{id}/users` and `DELETE …/all_users`: customer data.
- `DELETE /v1/segments/{id}`: permanent, and no enumeration of dependent ad squads exists.
- `PIXEL`, `MOBILE` and `FOOT_TRAFFIC_INSIGHTS` rule audiences: no documented GET shape for their specs, so read-back cannot be proven. `ENGAGEMENT` segments are documented as read-only for creation.

Code: `src/snapchat-segments.ts` (new), `src/reviewed-routes.ts`, `src/write-review.ts`,
`src/write-impact.ts`, `src/write-verification.ts` (per-kind projection map shared with
lead forms), `src/scope.ts`, `src/review-state.ts`, `src/provider-contracts.ts` (Snapchat
contract version 5), `src/action-contracts.ts`. Guidance: "Snapchat audience segments" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable lookalike
inspect example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (972 rows).

## Tests

`tests/snapchat-segments.test.mjs`, ten tests:

1. The four actions inspect as reviewed with no network requests. User, delete and all-users routes stay blocked.
2. 23 invalid creates and 4 invalid updates are refused before any request.
3. A customer list is created once and verified despite provider size and status fields, and a native GET works.
4. A lookalike's seed is unowned until listed, then read twice despite a changing audience size, and it verifies with the deprecated `country` read-back.
5. A seed shared from another account is refused.
6. An update requires the listed segment, reports retention impact, executes once and verifies.
7. A dropped description, a lookalike retention of 181 and a segment moved to another account are refused.
8. A changed retention reads back as inconclusive.
9. Failed, empty, duplicated and lost receipts give no second POST and never verify.
10. Concurrent execution submits once. A fresh service replays and verifies. A lost receipt stays `WRITE_OUTCOME_UNCERTAIN`.

Red/green: all ten fail against a build of `874038e` with the identical test file
(`WRITE_CONTRACT_UNAVAILABLE`) and pass with this change. Local log:
`.runtime/snapchat-segments-20260926/red-check.log`.

## Deliberately not changed

- The per-kind segment rules are Snapchat-only. The global volatile-field set is unchanged,
  so other providers' review hashes are unaffected.
- `snapchat_audience_get` and other segment reads now work after the account's segment list
  has been read, like other Snapchat global IDs. On `874038e` they were refused with
  `RESOURCE_SCOPE_REQUIRED` even after that list, unless an administrator had provisioned a
  resource binding (checked against the base build).

## Verification

- Targeted: 382/382 across 41 related suites.
- Guidance coverage: 229 write-path refusals across 107 modules accounted for, including
  both new segment refusals.
- Full qualification: see
  [SNAPCHAT-SEGMENTS-VERIFICATION-2026-09-26.json](SNAPCHAT-SEGMENTS-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. It needs the updated deployment and a paused test in an
owned account, which this batch does not authorize.
