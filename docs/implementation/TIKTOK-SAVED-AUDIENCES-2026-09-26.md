# TikTok saved audiences — 2026-09-26

Base revision: `21d351a` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). TikTok ad group creation accepts a
`saved_audience_id`, and advertisers keep reusable targeting as saved audiences;
`/dmp/saved_audience/create/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create a Saved Audience](https://business-api.tiktok.com/portal/docs/create-a-saved-audience/v1.3):
  at most 400 per advertiser; `saved_audience_name` (at most 512 characters, no emoji) and
  `location_ids` required; the optional targeting fields, their enums and the action scene
  rules; device models and price ranges not together; price ranges in multiples of 50 with the
  upper limit treated as 50 higher. The example also shows `interest_keyword_language`, which
  the parameter table does not list.
- [Get details of Saved Audiences](https://business-api.tiktok.com/portal/docs/get-details-of-saved-audiences/v1.3):
  a `saved_audience_ids` filter (at most 100), and a response whose example expands a
  `[0, 1000]` price range into every step of 50 and fills `min_ios_version: NONE` and
  `device_model_ids: []`. The request has no paging parameters.
- [Enumerations](https://business-api.tiktok.com/portal/docs/enumerations-appendix/v1.3): age
  groups, connection types and operating systems. Minimum OS versions point to
  `/tool/os_version/` for the current list, so only their format is checked.

## Contract

`tiktok_dmp_saved_audience_create` is the new reviewed family `tiktok_saved_audiences`
(`src/tiktok-saved-audiences.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SAVED_AUDIENCE` unless the name and locations are present and every optional field matches its documented type, enum and combination rules: unique numeric ID lists, no audience both included and excluded, at most 100 referenced audiences, one operating system, price ranges as `[lower, upper]` multiples of 50, and actions whose period and user actions fit their scene (period 0 for creator and hashtag actions, which TikTok stores as 0). Other keys, including `interest_keyword_language`, are refused |
| Reads | The advertiser, and every referenced custom audience through `/dmp/custom_audience/get/`, before review and again before execution |
| Checks | Each referenced audience must be returned (`STATE_TARGET_MISMATCH`), owned by the advertiser and available (`INVALID_TIKTOK_SAVED_AUDIENCE`) |
| Spending | None. Saved audience creation is excluded from the spending word heuristic |
| Impact | `creative_impact` lists the name, location count, included and excluded audience counts and the other targeting fields used |
| Receipt | `code: 0` and a `saved_audience_id` (the generic TikTok create rule looked for a `dmp_id`, so this family has its own) |
| Verification | One `/dmp/saved_audience/list/` read for the new ID, comparing every sent field: ID lists and actions as sets, the price range as its lowest and highest value |

Not qualified: deletion, and checking the saved audience an ad group references.

Other code: `src/write-review.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/preflight.ts`, `src/provider-contracts.ts` (TikTok contract
version 7), `src/action-contracts.ts`. Guidance: "TikTok saved audiences" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-saved-audiences.test.mjs`, seven tests:

1. The create route inspects as reviewed with no network; deletion stays blocked.
2. 25 invalid requests are refused with `INVALID_TIKTOK_SAVED_AUDIENCE` before any request.
3. A saved audience with owned audiences is created without spending confirmation (its name mentions bidders); the exact body is sent once, and it verifies although TikTok reorders the lists and actions, expands the price range and adds defaults; replay makes no second POST.
4. Without referenced audiences only the advertiser is read.
5. Shared, still-preparing and missing audiences are refused before any write.
6. Read-backs with other locations, another price range or fewer actions are inconclusive with the exact changed field.
7. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all seven fail against a build of `21d351a` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-saved-audiences-20260926/red-check.log`.

## Verification

- Targeted: 1272/1272 across 90 related suites.
- Guidance coverage: 240 write-path refusals across 117 modules accounted for.
- Full qualification: see
  [TIKTOK-SAVED-AUDIENCES-VERIFICATION-2026-09-26.json](TIKTOK-SAVED-AUDIENCES-VERIFICATION-2026-09-26.json).

Remaining rows: 959. Live acceptance is unverified; it needs the updated deployment and a
test advertiser.
