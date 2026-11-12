---
status: reference
tier: operator
---

# Allocation proposals and native budget drafts

Budget allocation proposals, their factors and outcome review, and native budget drafts. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

Google campaign allocation results offer **Prepare a native budget draft**. Explicitly choose equal-daily conversion,
read the current dedicated daily budgets and inspect the exact amounts, micros and rounding residuals. Confirmation
saves a source-bound, unapproved Campaigns plan. Average daily amounts continue until separately changed; the
reference period does not schedule an end date or guarantee a period spend. Shared/lifetime/foreign budgets and
changed source/ownership are refused. The original source and current native ownership are checked before unsent
proposal steps, while the existing native review, spend acknowledgement and read-back remain required.

Google repeats the complete selected campaign/budget observation under one ten-attempt, 100-row,
2 MiB, 60-second budget and refuses changed supported native state before retaining the preview.
Snapchat repeats each selected ad-squad budget inside its existing parent/account brackets;
LinkedIn retains its independent-budget/group/account consistency checks. Original request/time
references identify the observations. Matching sequential reads are not an atomic snapshot.

Each daily amount rounds down to the smallest unit of the account currency (USD 0.01, JPY and CLP 1, KWD 0.001),
which Google requires (`NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT`); the preview shows `minimum_unit_micros` and the
residual, and period floors are checked after rounding. LinkedIn drafts also read the account's daily budget limits
once (`adBudgetPricing`, priced for the first selected campaign) and refuse a daily amount outside them with
`ALLOCATION_BUDGET_LIMIT`; when LinkedIn states no exact limits the preview says `daily_budget_limits.status:
"unavailable"` and LinkedIn checks the amount at execution.

MCP uses `preview_allocation_plan` with report `id`, allocation `options` and `conversion:"equal_daily"`, followed
by `create_allocation_plan` with the same `id`, exact `preview_id`/`preview_hash` and `confirmed:true`. Preview is
bound to the current session and lasts ten minutes. Follow its returned `amcp_campaign get` and website link to
inspect the original draft. Lost responses reuse the same plan. `amcp_campaign create` also supports optional
stable creation keys. See the [native budget-draft record](../records/DELIVERY-2026-10-01-ALLOCATION-PLANS.md).

### Factor provenance and indicators (DEC-02)

**Use these historical factors** copies a retained calibration's envelope into the model and sends
`factor_source {kind:"calibration", evidence_fingerprint, ids, options}` with it. The server recomputes that
calibration and refuses `ALLOCATION_FACTOR_PROVENANCE` when the fingerprint, the factors or the entities differ, so
a proposal never claims history it does not have. The provenance is part of `model_fingerprint` (the same numbers with
and without it are different proposals), `assumptions.factor_provenance`, the limitations and the draft brief. Typed
factors say they have no historical provenance; calibrated ones say the calibration was one-day and spend-conditioned.

`allocation_indicators` compare each proposed daily average with the entity's observed daily spend range
(`proposed_to_observed_spend`; `outside_observed_range` means the linear model extrapolates there). The native budget
preview shows `budget_utilization` (observed spend ÷ today's daily budget × evidence days; below 80% is flagged, and
today's budget may differ from the one in force then) and, for Google, each campaign's Search budget-lost impression
share over the evidence period from one extra read after the two budget observations (`search_budget_lost_impression_share`:
`read`, `not_search`, `not_reported` or `unavailable`; Google reports shares above 90% as 0.9001, shown as "more than
90%"). Indicators are descriptive and never gate a proposal; a refused indicator read leaves it unavailable.

### Meta budget drafts (DEC-02)

A guided `meta_campaign` report can become a native draft of at most 20 campaigns. Inside one bounded bracket AMCP
reads the account (identity, currency, time zone, active status), observes every campaign in the account's own
collection, reads each campaign with its ad sets twice, and refuses anything it cannot bind exactly
(`ALLOCATION_BUDGET_MODE`): lifetime campaign or ad-set budgets, a campaign and ad-set budget at once, ad-set budgets
split across several spending ad sets, reserved buying, more ad sets than one bounded read, or a mode that changes
between observations. A campaign daily budget (Advantage campaign budget) is drafted with `meta_campaign_id_update`;
a campaign whose budget sits on its one spending ad set is drafted on that ad set with `meta_ad_set_id_update`. Amounts
are whole Meta minor units of the pinned currency offset (`daily_budget_native`), rounded down and never converted;
a currency without a pinned offset is refused before any read. The draft is unapproved and source-bound like the other
providers; every step still needs native review, spend acknowledgement, owner caps and read-back. On the website,
**Prepare a native budget draft** names the owner (campaign budget or ad set) and the minor units, and the saved plan
shows them in English and Arabic.

### Outcome review (DEC-02)

When every budget step of an allocation plan has been executed and verified by read-back, AMCP schedules its outcome
review. The outcome window is the plan's reference length (the evidence period's days), starting on the first
account-local day after the last verified step, so the new budgets were in force all day; it is complete once its
last day has ended in the account time zone. Nothing is read before then: `capture_allocation_outcome` refuses with
`ALLOCATION_OUTCOME_NOT_DUE`. After the window closes, a background job (as the person whose verified execution
completed the plan) repeats the proposal's own guided preset on the same login, account, currency, time zone,
attribution, result definition and way of counting actions (a Meta capture counts the attribution windows it asked for
and says so in `action_count_basis`), and retains it as ordinary guided evidence. A provider that has not finalized the
window (Snapchat) or a rate limit is retried up to six times with growing delays; any other refusal is recorded and an
authorized member can review the outcome from the plan page (**Review the outcome now**) or with
`capture_allocation_outcome {id}`. A verified plan without an outcome record (it completed before this release, or
recording it failed) gets one when its owner, an administrator, an editor or an approver opens the outcome; a plan viewer
only sees `not_scheduled` with the reason `not_recorded`, so the background review never runs as a viewer.

`allocation_outcome {id}` (the campaign plan ID) shows the window, state and results: per entity and in total, the
proposed budget, realized spend and its share of the proposal, realized conversions beside the range the proposal
modeled at the proposed budget, the same range at the realized spend, and a realized factor on the proposal's
efficiency scale (1.0 is the evidence period's conversions per unit of spend), all exact at nine places, half to even.
An entity without outcome rows stays unknown and partial days are named; nothing is counted as zero. These are
observational comparisons: they do not show that the budget change caused a difference, are not forecast accuracy and
are not adjusted for seasonality, auctions, creatives, tracking or attribution changes. The outcome capture is offered
as calibration evidence (`calibrate_allocation` when it covers 14–31 closed days). A plan whose evidence was deleted
or changed, or whose proposal can no longer be reproduced exactly, is recorded `unavailable`. So is an outcome whose
capture used other measurement settings than the proposal's evidence (`measurement_definition_changed`, with the
settings in `changed_fields`): evidence retained before Meta captures counted the requested windows has no
`action_count_basis`, so an outcome read after that is never compared with it. At most 500 outcome
records are kept per workspace; the oldest finished ones are removed first. Causal experiments (Google experiments,
LinkedIn lift tests) stay separate workflows.

## Snapchat ad-squad allocation drafts

Open a retained `snapchat_adsquad` report and choose **Allocate a budget across ad squads**. Select 2–50
units from this parent, declare total period budget, floors/caps, efficiency assumptions and evidence thresholds.
The model is illustrative. Explicitly choose equal daily conversion to read current budgets. Only owned auction
campaigns with explicit ad-squad pacing and ad squads with daily budgets qualify. The native account currency/timezone,
parent and ownership collections are checked; lifetime, reserved and Smart Budgets are refused. Proposed daily amounts
round down to the smallest unit of the account currency and must meet the native 5,000,000-micros minimum and your
period floor. Inspect current
amounts, residuals and expandable native request/hash/time references.

Confirm only the exact unapproved draft. Reporting sends no advertising change. The daily budgets are ongoing and this
draft adds no end date or automatic period cap. Current report/session/preview/parent/budget evidence binds every unsent
step; native review, execution/spending confirmation and receipt-bound read-back remain separate in Campaigns. The
review also freezes native delivery mode so a change prevents dispatch.

For MCP use `allocation_candidates`, `allocation`, `preview_allocation_plan` with `conversion:"equal_daily"`,
then `create_allocation_plan` with that session's `preview_id`, `preview_hash` and `confirmed:true`. Retain exact
report and account scope. Google retains its dedicated-budget flow, LinkedIn its independent-budget flow and Meta its
owner-bound flow (above); other providers remain unqualified for this handoff. See [qualification and limits](../records/DELIVERY-2026-10-03-SNAPCHAT-ALLOCATION.md).

### Allocation selection and browser review

Candidates use compact Add/Added controls with full accessible names. Added items remain disabled until removed; selection changes preserve each remaining item's bounds and invalidate obsolete results. Report buttons identify their source, account and dates. Snapchat model/candidate responses identify `entity_kind:ad_squad` and the exact `parent_campaign_id`; daily-budget copy stays provider-specific. Conversion tables retain exact decimal strings and micros inside named horizontal scroll regions. The confirmation starts on Cancel, wraps Tab/Shift+Tab between its controls and supports Escape cancellation. Long native IDs fit the English/Arabic narrow-screen form. See [browser and keyboard qualification](../records/DELIVERY-2026-10-03-BROWSER-ALLOCATION.md).

### Saved budget proposal review

Opening a recognized allocation draft shows **Retained budget proposal** with the exact provider/account, currency, timezone, reference duration and Snapchat parent. Its keyboard-accessible table compares the saved budgets at preview with the proposed native daily/average-daily amounts and micros. These settings are retained evidence, not a new live read. Inspect the original report for its date window and measurement definitions. Reference-period amounts are not an ongoing spending cap or end date.

The original plan brief and original native step descriptions remain expandable. A readable translated step is shown only for an exact matched single native budget request; additional/changed fields or older/unqualified bindings keep their stored descriptions. Language changes do not modify the original plan or request. Every advertising effect still needs the existing separate native review, spending acknowledgement and execution/read-back. Report metric cards and plan counts are available in both languages. See [review qualification](../records/DELIVERY-2026-10-03-ALLOCATION-REVIEW.md).
