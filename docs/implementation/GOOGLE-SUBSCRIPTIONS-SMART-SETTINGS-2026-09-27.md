# Google Ads recommendation subscriptions and Smart campaign settings — 2026-09-27

Base revision: `b6124bd` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: auto-apply subscriptions decide whether Google changes campaigns on its own, and Smart campaign
settings hold what Smart campaign ads show. Five rows were blocked writes: the subscription service
with its three legacy aliases, and the Smart campaign setting service.

Contract source: the pinned Google Ads API v23 Discovery document
(`RecommendationSubscriptionService.MutateRecommendationSubscription`,
`RecommendationSubscriptionOperation`, `RecommendationSubscription`;
`SmartCampaignSettingService.MutateSmartCampaignSettings`, `SmartCampaignSettingOperation`,
`SmartCampaignSetting`), read on 2026-09-27. Key facts:

- A subscription's `type` is "Required. Immutable"; its `status` is ENABLED or PAUSED; operations are
  create or update only; its name is `customers/{customer}/recommendationSubscriptions/{type}`.
- A Smart campaign setting is updated only; its fields are the phone number, final URL or ad-optimized
  Business Profile, advertising language, and business name or Business Profile location.

## Change

| Family | Requests | Checks | Safety | Verification |
|---|---|---|---|---|
| `google_recommendation_subscriptions` (`src/google-recommendation-subscriptions.ts`) | 1–10 creates `{type, status}` or status updates; aliases limited to creation, pausing or updating | Every subscription of the customer; existing types for creation, missing ones for updates and unchanged statuses refused | Enabling needs `spend_change_confirmed` and counts as activation | Statuses read again |
| `google_smart_campaign_settings` (`src/google-smart-campaign-settings.ts`) | 1–10 updates by `updateMask`; one landing page and one business choice | Each setting with its campaign (a Smart campaign, not removed); unchanged settings refused | Shown from and to; serving changes at once | Settings read again |

Other code: `src/preflight.ts`, `src/spend-policy.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract version 26). Guidance:
two sections of `Skills/amcp-campaign-builder/references/google-ads.md` and two executable
inspect examples.

## Tests

- `tests/google-recommendation-subscriptions.test.mjs` (3): a paused subscription is created and verifies; enabling needs confirmation and verifies; the unsubscribe alias pauses two types; an owner activation rule refuses enabling but not pausing; nine malformed requests fail before any request; existing, missing and unchanged subscriptions are refused; a receipt for another type is never resubmitted; an ignored change is not verified; the ledger lists the four writes.
- `tests/google-smart-campaign-settings.test.mjs` (3): the landing page and phone change and verify; the business moves to a Business Profile location (snake_case input) and verifies; ten malformed requests fail before any request; non-Smart, removed and unknown campaigns and unchanged values are refused; a receipt for another setting is never resubmitted; an ignored update is not verified; the ledger lists the write.

Red/green against a build of `b6124bd`: four of the six tests fail (no reviewed family: the five rows were blocked writes); the two malformed-request tests pass because the base refuses those routes before any request. Local log:
`.runtime/google-subscriptions-smart-20260927/red-check.log`.

## Verification

- Targeted: 169 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,873/1,873.
- Guidance coverage: 295 write-path refusals across 166 modules accounted for.
- Full qualification: see
  [GOOGLE-SUBSCRIPTIONS-SMART-SETTINGS-VERIFICATION-2026-09-27.json](GOOGLE-SUBSCRIPTIONS-SMART-SETTINGS-VERIFICATION-2026-09-27.json).

Remaining rows: 811 (five Google Ads rows reviewed; Google Ads blocked writes 64 → 59). Live
acceptance is unverified; it needs the updated deployment and a Google Ads customer.
