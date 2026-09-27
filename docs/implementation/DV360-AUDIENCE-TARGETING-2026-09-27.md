# DV360 audience targeting — 2026-09-27

Base revision: `bc4faba` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: most DV360 campaigns, and Demand Gen ad groups in particular, target audiences. The
targeting review refused `TARGETING_TYPE_AUDIENCE_GROUP` because it could not read whether the
advertiser may use an audience (P2 "DV360 audience and inventory-source targeting" in the
[2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md)). The audience reads needed to find audience
IDs were also refused by the scope guard (`RESOURCE_SCOPE_REQUIRED`): these collections are not
under `/advertisers/`, so no account path bound them.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`AudienceGroupAssignedTargetingOptionDetails` and its group and setting models,
`FirstPartyAndPartnerAudience`, `GoogleAudience`, `CustomList`, `CombinedAudience`, and the get and
list methods of `firstPartyAndPartnerAudiences`, `googleAudiences`, `customLists` and
`combinedAudiences`), [Audience list targeting](https://developers.google.com/display-video/api/guides/concepts/targeting/audience-list)
and [Configure audience targeting](https://developers.google.com/display-video/api/guides/tasks/upload-customer-match-audience/target-audience),
read on 2026-09-27. Key facts:

- Audience reads take `advertiserId` ("the advertiser that has access") or `partnerId`; DV360
  returns only audiences that advertiser or partner can use.
- One audience group option per resource, ID `audienceGroup`. Included first-party and partner
  groups intersect; every other included group is a union; excluded audiences are removed.
  Exclusions alone are allowed. It is replaced by deleting and creating it in one bulk edit.
- First-party and partner settings require `recency`, which applies only to first-party
  audiences; repeated settings are not allowed. Other groups ignore repeated settings; repeated
  first-party groups are ignored. At most five combined audiences. Only affinity, in-market and
  installed-apps Google audiences can be excluded.

## Change

New module `src/dv360-audiences.ts` and scope rule (`src/scope.ts`): a get or list of the four
audience collections is in scope when `advertiserId` is the selected advertiser, with only the
documented list parameters, no `partnerId` and the display-video scope.

Audience groups in the targeting review (`src/dv360-line-item-targeting.ts`), for line items and
Demand Gen ad groups:

| Part | Behaviour |
|---|---|
| Request | `audienceGroupDetails` with at least one group of the pinned model; `{settings}` with decimal-string IDs; recency only in first-party and partner settings |
| Local checks | No repeated audience in a group, no repeated first-party group, at most 5 combined audiences, no audience both included and excluded, at most 100 audiences per review |
| State | Each audience read once with `advertiserId`; an unavailable one is a target mismatch naming it |
| Checks | Recency only on first-party audiences; only affinity, in-market and installed-apps Google audiences excluded; one option per resource, identical option `CONFIGURATION_EXISTS` |
| Review state | Audience identity and types only; sizes change daily and are left out, so they do not stop execution, while a renamed audience or a changed type does |
| Verification | The complete targeting read again; audience groups compare without order, with `RECENCY_NO_LIMIT` equal to no recency |

Other code: `src/types.ts` (the audience read marker), `src/review-state.ts` (the audience
projection) and `src/provider-contracts.ts` (DV360 contract version 11). Guidance: "Audience
targeting" in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md`.

Two existing tests asserted the old refusal and now show the new behaviour: the local-failure list
of `tests/dv360-line-item-targeting.test.ts` uses an inventory source and an empty audience group,
and `tests/dv360-ad-group-targeting.test.mjs` reassigns a removed audience group and verifies it.

## Tests

`tests/dv360-audience-targeting.test.mjs`, eight tests:

1. Audience lists and gets with the selected advertiser succeed; `partnerId`, another advertiser, extra parameters and a connection without the display-video scope are refused without requests.
2. A line item audience group with every group kind reads each of its eight audiences once, is written once and verifies against DV360's order and recency form.
3. Replacement by deleting `audienceGroup` and creating the new option verifies; a second option and an identical one are refused.
4. Fourteen malformed audience groups fail before any request (four already at the pinned model).
5. An unavailable audience, recency on a partner audience and an excluded life-event audience are refused after reading, with no write; an in-market exclusion is accepted.
6. Demand Gen ad groups take audience groups and verify; Demand Gen line items still do not.
7. Changing audience sizes do not stop execution; a renamed audience does (`STATE_CHANGED`), and an audience that became a partner audience is refused at execution; a write DV360 ignored is not verified.
8. The audience group model, rules and audience reads match the pinned Discovery document.

Red/green against a build of `bc4faba` (with the pinned document present): six of the eight new tests fail (the scope guard refused audience reads and the review refused audience groups) and so does the reassigned audience group of the ad group suite; the malformed-group and pinned-document tests pass, since the base refuses those requests too, and the line item suite passes with its updated local cases. Local log:
`.runtime/dv360-audience-targeting-20260927/red-check.log`.

## Verification

- Targeted: 147 related suite files, including every DV360, media, scope and security suite, with FFmpeg
  configured: 1,763/1,763.
- Guidance coverage: 266 write-path refusals across 146 modules accounted for.
- Full qualification: see
  [DV360-AUDIENCE-TARGETING-VERIFICATION-2026-09-27.json](DV360-AUDIENCE-TARGETING-VERIFICATION-2026-09-27.json).
  The first full run failed one unrelated test: the LinkedIn media resume suite could not remove
  its Windows temp directory (EPERM) while other local runs were active. That suite passed alone
  three times, and the unchanged candidate was qualified again.

Remaining rows: 887 (unchanged: the audience reads were already classified as native reads, and
audience groups use the reviewed targeting routes). Inventory source targeting remains a P2.
Live acceptance is unverified; it needs the updated deployment and a DV360 advertiser with
audiences.
