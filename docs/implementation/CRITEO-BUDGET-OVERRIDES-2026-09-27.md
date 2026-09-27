# Criteo campaign and line item budget overrides — 2026-09-27

Base revision: `6bf3f05` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: retail media advertisers raise or lower spending caps for sale periods with budget
overrides. The campaign and line item override PUTs were blocked writes (two rows).

Contract source: the pinned Criteo Retail Media 2026-01 OpenAPI document
(`UpdateCampaignBudgetOverrides`, `UpdateLineItemBudgetOverrides` and their GETs,
`CampaignBudgetOverrides`, `CampaignDailyBudgetOverride`, `CampaignMonthlyBudgetOverride`,
`LineItemBudgetOverrides`, `DailyLineItemBudgetOverride`, `MonthlyLineItemBudegetOverride`) and the
[Budget Overrides](https://developers.criteo.com/retail-media/docs/budget-overrides) guide, read on
2026-09-27. Key facts:

- The PUT "replaces all existing" overrides of the campaign or line item; both lists are required.
- Lists are in chronological order without overlaps; a null start follows the previous override;
  durations are "1D, 2D, 3D…" or "1M, 2M, 3M…" (either case); caps are decimals of 0 or more; status
  is computed.
- The line item daily cap is the one cap the document marks nullable, without saying what a null
  cap means. AMCP requires every cap, and a stored null cap leaves the current state unreadable, so
  such a request is refused.
- The documented PUT answer is 201 with the stored overrides.
- The guide's examples store back-to-back overrides with equal caps as one (two 3M overrides of
  cap 12 come back as one 6M override) and return the start of an override that follows the
  previous one as null, even when it was sent.
- The GET returns a computed status (`Expired`, `Active`, `Upcoming`); whether an expired override
  left out of the PUT is deleted is undocumented.
- The PUTs need `RetailMedia_Campaign_Manage`; the GETs `RetailMedia_Campaign_Read`.

## Change

New reviewed family `criteo_budget_overrides` (`src/criteo-budget-overrides.ts`):

| Part | Behaviour |
|---|---|
| Request | Both lists of the target, each at most 50 entries: daily `{startDate, duration nD, maxDailySpend}` and monthly `{startMonth, duration nM, maxMonthlySpend}`; the first start explicit; chronological without overlaps; no status |
| State | The account (currency), the campaign's or line item's membership in the account, and its current overrides as effective ranges |
| Checks | Discovered targets only; every expired override kept with its cap; an unchanged request (compared as merged runs) refused |
| Safety | `spend_change_confirmed` always; owner monetary limits cannot measure the caps, so such a policy refuses the request (`POLICY_AMOUNT_UNSUPPORTED`); activation policies do not apply |
| Receipt | 200, 201 or 204 without errors or warnings; otherwise a failure that is never resubmitted |
| Verification | The overrides read again and compared as merged runs: every start (null starts filled in), duration and cap |

Other code: `src/types.ts`, `src/scope.ts`, `src/spend-policy.ts`, `src/preflight.ts`,
`src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract
version 9). Guidance: "Budget overrides (2026.01)" in
`Skills/amcp-campaign-builder/references/criteo.md` and an executable inspect example.

## Tests

`tests/criteo-budget-overrides.test.mjs`, six tests. The synthetic Criteo stores overrides the way the
guide's examples show: null starts filled in, back-to-back equal caps merged, following starts
returned as null and status computed from the dates.

1. Campaign overrides are replaced once after spending confirmation and verify, with a null start following the previous override; a replay sends nothing.
2. Line item overrides are replaced and verify when Criteo merges two back-to-back equal caps; the merged form is then refused as unchanged; clearing every override verifies too.
3. Ten malformed requests fail before any request.
4. Undiscovered targets, unchanged overrides and monetary owner policies are refused without writes; an activation policy does not apply.
5. A request that leaves out an expired override or changes its cap is refused without writes; keeping it (here split in two with the same cap) verifies.
6. A response with warnings is a failure that is never resubmitted; an ignored PUT is not verified; the models match the pinned document and the ledger lists both writes in the family.

Red/green against a build of `6bf3f05`: all six tests fail (no reviewed family: the two routes were blocked writes). Local log:
`.runtime/criteo-budget-overrides-20260927/red-check.log`.

## Verification

- Targeted: 161 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,840/1,840.
- Guidance coverage: 282 write-path refusals across 159 modules accounted for.
- Full qualification: see
  [CRITEO-BUDGET-OVERRIDES-VERIFICATION-2026-09-27.json](CRITEO-BUDGET-OVERRIDES-VERIFICATION-2026-09-27.json).

Remaining rows: 845 (two Criteo rows reviewed; Criteo blocked writes 34 → 32). Live acceptance is
unverified; it needs the updated deployment and a Criteo campaign or line item.
