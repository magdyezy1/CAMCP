---
status: record
tier: engineering
---

# Constrained campaign allocation proposals — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `ab09a7a`. Implementation: `5bc7bd1`. Batch 55 advances B26's planning workflow without adding autonomous advertising changes.

## Delivered behavior

Guided Google/Meta campaign-by-day evidence now supports paginated campaign choices and a constrained allocation
model in the website and MCP. The user selects 2–50 campaigns and enters an explicit total period budget and each
campaign's floor/cap. All selected campaigns belong to the same retained account/login and measurement context.
No implicit FX, cross-report comparison or additional campaign is introduced.

The model starts at the floors and assigns remaining budget by observed conversions per unit of spend until caps
bind. Ranking compares exact integer ratios; budget arithmetic uses six-decimal integers. Equal efficiencies use
stable lexicographic native-ID order. The full total is allocated exactly or infeasible bounds are refused. This
solves the stated linear model, not an unknown provider delivery-response curve. Low/high common efficiency factors
show sensitivity, not statistical intervals. Counts are not profit or causal incrementality.

Inputs require known currency/attribution/conversion definitions, complete evidence, positive campaign spend, a
declared minimum conversion threshold (1–1,000,000) and an age limit of 1–90 days. Both capture time and the reporting
end date must satisfy that age limit. The end date must precede today in the native timezone. Duplicate daily grain,
out-of-window rows, unknown values, future captures and inadequate samples fail. Measurement/timezone/completeness
retain their source declarations; this does not independently certify tracking or statistical significance.

## Contract and website

`amcp_reporting allocation_candidates` accepts report `id`, `offset` and `limit` (1–100). It returns bounded campaign
totals and `next_offset` without raw native rows. `allocation` accepts `id` and `options` with `budget`,
`allocations:[{entity_id,minimum,maximum}]`, `efficiency_low`, `efficiency_high`, `minimum_conversions` and
`maximum_age_days`. Every monetary input is nonnegative, at most 1 trillion, with up to six decimal places; the total
must be positive. Factors satisfy 0 < low ≤ high ≤ 10. Both actions recheck the retained report's current grants.

The website retains entered bounds while adding/removing campaigns, displays the source account and period,
shows binding constraints and focuses the completed proposal. Results can be downloaded with assumptions,
measurement, source hash and model fingerprint as JSON. Editing inputs clears stale results; navigation, identity,
report replacement or newer inputs suppress delayed responses. Reopening the chooser refreshes its first page.
Wide comparison tables scroll within their region, with a readable fixed minimum for campaign names and IDs.

The proposed amounts cover a comparable period of the same duration as the source window. They are never native
daily/lifetime budgets or approvals. Shared-budget ownership, provider eligibility, real budget constraints and
current native units require separate read/preflight before any reviewed campaign change. No plan or live budget
is created, and model/choice calls make zero provider requests.

## Evidence and limits

Red-to-green regressions cover exact constraints, six-decimal amounts, deterministic ties, infeasibility, unknown
and insufficient samples, stale/future/open periods, native timezone boundaries, grain, current access and bounded
metadata pages. Sixty varied small problems match exhaustive enumeration of feasible allocations. Browser-script
regressions cover edit/navigation/identity/detached-report races. A real MCP SDK journey follows guided capture →
choices → allocation in three calls, approximately 7.7 KB of structured response data and one synthetic GET; no
mutation is sent. Advertised input schemas and text/structured envelopes are checked.

Synthetic browser acceptance selects two campaigns, preserves their bounds, produces 125/75 USD from a 200 USD
total with 26–39 modeled conversions under the chosen assumptions, and invalidates the result on input changes.
Desktop and 390×844 mobile checks found and repaired first-column compression. No page overflow or console error
was observed after the repair. Logs/screenshots are in ignored `.runtime/allocation-20261001/`. Exact release checks
are recorded in [PROGRESS.md](PROGRESS.md).

The matrix remains **11 implemented / 15 partial / 2 open**. B26 still needs calibrated forecasts and an explicit
bridge into a separately reviewed native budget plan. Production outcome quality, external MCP clients and live
provider acceptance are unverified. No dependency, migration, OAuth scope, native write family, production
deployment, live advertising change, external message or DNS change is introduced.
