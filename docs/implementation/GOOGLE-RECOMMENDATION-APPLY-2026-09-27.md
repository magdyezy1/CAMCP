# Applying Google Ads keyword and campaign budget recommendations — 2026-09-27

Base revision: `2ac1127` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: recommendations could be dismissed and auto-applied through subscriptions, but not applied one
at a time after review. The two apply rows (v23 action and alias) were blocked writes.

Contract source: the pinned Google Ads API v23 Discovery document (`RecommendationService.ApplyRecommendation`,
`ApplyRecommendationRequest`, `ApplyRecommendationOperation` with `KeywordParameters` and
`CampaignBudgetParameters`, and `Recommendation`), checked 2026-09-27. Key facts:

- "If partial_failure=false all recommendations should be of the same type"; at most 100 operations.
- Keyword parameters: `matchType` and `adGroup` (both required when given) and an optional
  `cpcBidMicros`; campaign budget parameters: `newBudgetAmountMicros`.
- A keyword recommendation carries the keyword (text, match type) and a recommended CPC; a campaign
  budget recommendation carries the recommended and current amounts.

## Change

New reviewed family `google_recommendation_apply` (`src/google-recommendation-apply.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–20 recommendations of one type, `partialFailure` false; `KEYWORD` (optionally match type, ad group and CPC bid) and `CAMPAIGN_BUDGET` (optionally the new amount) only |
| State | Each recommendation (type, dismissed, campaign, ad group, budget, keyword, amounts), the campaign budgets, the ad groups and their keywords |
| Checks | Current, undismissed recommendations of the customer; parameters that match the type; an ad group that is not removed and does not already have the keyword with that match type (`CONFIGURATION_EXISTS`); a budget that is not removed and changes |
| Safety | Every application needs spending confirmation; added keywords count as activation under owner policies; new budget amounts follow owner budget limits against the current amounts |
| Receipt | Results naming each recommendation in order; anything else is a failure never resubmitted |
| Verification | The campaign budgets read again (new amounts), or the ad group keywords read again (each keyword present) |

Other code: `src/preflight.ts`, `src/spend-policy.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract version 27). Guidance:
"Applying keyword and campaign budget recommendations" in
`Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect example.

## Tests

`tests/google-recommendation-apply.test.mjs`, four tests:

1. Two keyword recommendations are applied after spending confirmation, as recommended and with another match type, and verify; a replay sends nothing.
2. A budget recommendation sets the recommended amount and verifies; an owner budget limit refuses it and allows a chosen lower amount, which verifies; an owner rule against activation refuses keywords but not budgets.
3. Seven malformed requests fail before any request; another type, mixed types, a dismissed or unknown recommendation, an existing keyword and an unchanged budget are refused after reading, without writes.
4. A receipt naming another recommendation is never resubmitted; ignored applications are not verified; the models match the pinned document; the ledger lists both writes in the family.

Red/green against a build of `2ac1127`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/google-recommendation-apply-20260927/red-check.log`.

## Verification

- Targeted: 185 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,938/1,938.
- Guidance coverage: 314 write-path refusals across 182 modules accounted for.
- Full qualification: see
  [GOOGLE-RECOMMENDATION-APPLY-VERIFICATION-2026-09-27.json](GOOGLE-RECOMMENDATION-APPLY-VERIFICATION-2026-09-27.json).

Remaining rows: 770 (two Google Ads rows reviewed; Google Ads blocked writes 59 → 57). Live acceptance
is unverified; it needs the updated deployment and a Google Ads customer with recommendations.
