---
status: record
tier: engineering
---

# Google Ads campaign drafts — 2026-09-27

Base revision: `d355933` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: campaign drafts let advertisers stage changes to a serving campaign in a copy that cannot
serve, then apply them at once. The draft create, rename, remove and promote actions were blocked
writes (six rows), so staged changes could not be applied through AMCP.

Contract source: the pinned Google Ads API v23 Discovery document (`CampaignDraftService`
`MutateCampaignDrafts` and `PromoteCampaignDraft`, `CampaignDraftOperation`, `CampaignDraft`,
`CampaignDraftErrorEnum`, `Campaign.experiment_type`) and the
[Campaign drafts](https://developers.google.com/google-ads/api/docs/experiments/campaign-drafts)
guide, read on 2026-09-27. Key facts:

- A draft is created from `baseCampaign` with a `name`; the draft campaign "cannot serve ads" and is
  changed like any campaign. Drafts are renamed or removed with the same service.
- Promotion "applies all the changes you made in the draft campaign to the base campaign" as a
  long-running operation; the draft status moves to PROMOTING, then PROMOTED or PROMOTE_FAILED.
- `DUPLICATE_DRAFT_NAME`: a name is unique among the drafts of a campaign. Removed, promoted and
  failed drafts cannot change status again.

## Change

New reviewed family `google_campaign_drafts` (`src/google-campaign-drafts.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–10 create, rename or remove operations (legacy actions limited to their own operation), or one promotion by path; names of 1–255 characters without NUL, line feed or carriage return |
| State | The customer, each base campaign (status, channel, experiment type) and every draft of those campaigns |
| Checks | Removed campaigns and draft or experiment campaigns refused as bases; duplicate names are `CONFIGURATION_EXISTS`; removed, promoting, promoted and failed drafts are not renamed or removed; drafts with a serving experiment are not removed or promoted; only PROPOSED drafts are promoted |
| Safety | Draft changes serve nothing and need no confirmation (names never trigger it); promotion needs `spend_change_confirmed` and counts as activation under owner policies |
| Receipt | One result per operation naming its draft (new drafts under their base campaign), or a long-running operation for promotion; otherwise a failure that is never resubmitted |
| Verification | Drafts read again through their base campaigns: new drafts PROPOSED under their names, renames, removals; a promoted draft PROMOTED (PROMOTING stays open, PROMOTE_FAILED fails) |

Other code: `src/spend-policy.ts`, `src/preflight.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract version 22). Guidance:
"Campaign drafts" in `Skills/amcp-campaign-builder/references/google-ads.md` and an executable
inspect example.

## Tests

`tests/google-campaign-drafts.test.mjs`, five tests:

1. Drafts are created, renamed and removed once without spending confirmation and verify, also through the legacy actions; a replay sends nothing.
2. Promotion needs spending confirmation and verifies once PROMOTED; PROMOTING and PROMOTE_FAILED are not verified; an owner policy without activation refuses a promotion.
3. Fourteen malformed requests, including a promotion of a malformed draft name, fail before any request.
4. Removed, draft and unknown campaigns, duplicate names, and promoted, experiment-bound and unknown drafts are refused after reading, without writes.
5. A result naming another draft is a failure that is never resubmitted; an ignored rename is not verified; the statuses match the pinned document and the ledger lists the six actions in the family.

Red/green against a build of `d355933`: all five tests fail (no reviewed family: the six actions were blocked writes). Local log:
`.runtime/google-campaign-drafts-20260927/red-check.log`.

## Verification

- Targeted: 158 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,825/1,825.
- Guidance coverage: 279 write-path refusals across 156 modules accounted for.
- Full qualification: see
  [GOOGLE-CAMPAIGN-DRAFTS-VERIFICATION-2026-09-27.json](GOOGLE-CAMPAIGN-DRAFTS-VERIFICATION-2026-09-27.json).

Remaining rows: 858 (six Google Ads rows reviewed; Google Ads blocked writes 93 → 87). Live
acceptance is unverified; it needs the updated deployment and a campaign that supports drafts.
