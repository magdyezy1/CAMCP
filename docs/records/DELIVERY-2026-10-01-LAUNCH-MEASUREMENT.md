---
status: record
tier: engineering
---

# Conversion launches, Meta evidence and linked-ad results — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `c419f96`. Implementation: `d640666`. Batch 53 advances B08, B15, B17, B18 and B22; the
[implementation matrix](../review/IMPLEMENTATION-2026-10-01.md) retains the remaining scope.

## Campaign launch workflow

Two guided image recipes add Meta website purchases and website leads. They compile five dependent media,
campaign, ad-set, creative and ad steps using existing reviewed families. The selected account/login and native
currency remain bound to every step. Budgets retain exact minor-unit conversion; pixel IDs, attribution windows,
dates, nonempty copy and headline length are validated before plan creation. The campaign starts PAUSED with its
children ACTIVE under that paused parent. Activation remains a separate reviewed change.

The brief requires an account-assigned pixel, PURCHASE or LEAD according to the selected recipe, a 1- or 7-day click
window and an explicit choice about 1-day views. Website leads also bind the selected Page in the promoted object.
Neither the website nor MCP guesses a pixel or attribution window. Existing whole-plan preflight checks account
currency and visible pixel/Page access without an advertising mutation. Missing access blocks readiness. Event
delivery, account-specific objective eligibility and landing-page/policy acceptance remain separately unverified.
Special ad categories require tailored native plans and are refused by these general website recipes.

## Measurement capture

The Evidence & analysis page and `amcp_reporting capture_preset` now offer Meta campaign, ad-set and ad daily reads,
alongside the four Google presets. Meta capture requires an exact native action type and explicit attribution
windows. The generated GET query sets `action_report_time: impression` and disables account/unified attribution
overrides. Attribution and result-definition provenance are saved from that request. Timezone and reporting-window
completeness remain caller declarations, while native rows must match account, currency, dates and unique entity/day
grain. A successful empty result cannot establish native currency or timezone.

The mapping selects exactly one action type from `actions`/`action_values`. It does not add aggregate, pixel and
omni aliases. An absent selected action remains unknown; duplicate selected actions and malformed arrays fail.
Partial reads, duplicate grain, scope/currency/date mismatch and incomplete pagination fail before evidence is
retained. Existing 120-request, 10,000-row, 120-second and 32-MiB limits apply. Input/mapping validation occurs before
egress, including requests that ultimately return no rows.

The report list updates immediately after capture, and keyboard focus moves to the opened result. Navigation/selection guards keep delayed capture, get, analysis
or reconciliation responses from replacing a newer page or report.

## Creative to performance

Creative usage retains exact verified result-reference chains. A linked-ad button now opens compatible retained
Meta ad snapshots from the same account and login. Metadata-only SQL projects bounded choices without loading all
snapshot rows; identity/session/asset-bound keyset cursors page those choices. With an explicit plan and report,
AMCP rechecks current asset access, original-plan ownership and all plan accounts, selects verified Meta ad-create
steps, then joins their exact native IDs to bounded daily report rows. Dependency order alone is insufficient.

The result preserves the original source hash, capture timestamp, report link and measurement definitions. Missing
matches do not imply zero delivery. Matched rows use explicit continuation and expose only named report fields.
This operation makes zero provider requests. It establishes performance for linked ads, not allocation to an
individual image: historical creative assignment, later external edits, dynamic combinations and external usage
remain unverified. Other providers and historical creative assignment still require further work.

## Contract evidence and validation

The Meta API reference returned a rate-limit response during research. The pinned official Python Business SDK
`26.0.2` supplies reproducible schema evidence for campaign/ad-set create parameters, objectives, optimization,
billing/destination enums, promoted objects, Insights GET parameters and readable fields. Sources and SHA-256
hashes are recorded in `tests/fixtures/meta-website-recipe-sdk-v26.json`; `tools/meta-recipe-evidence.mjs` regenerates
or checks it from an explicitly supplied SDK directory without network access. Existing Insights model evidence is
also tested. This verifies field/model alignment, not every parameter combination, API-version equivalence, account
eligibility or live behavior. Meta defaults and optional version support are unchanged.

Primary references:
- [Official AdAccount model and edge methods](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py)
- [Official AdSet enums](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adset.py)
- [Official Campaign objectives](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/campaign.py)
- [Official promoted object fields/events](https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adpromotedobject.py)

Regressions cover compiled dependencies, exact money, explicit measurement inputs, read-only pixel/Page preflight,
cross-account/login refusals, revocation, source/grain validation, ambiguous aliases, missing values, plan ownership,
verified reference chains, pagination, SDK fields and delayed browser responses. The full MCP SDK workflow validates
advertised schemas and matching text/structured envelopes across discovery → capture → choices → linked results:
four calls, 9,319 structured response bytes and one synthetic GET. This is not external MCP-client acceptance or
measured token savings.

Synthetic browser acceptance covers native Meta ad capture, immediate report-library refresh, linked-ad performance,
explicit purchase brief/preview, and saving a five-step paused plan without executing it. Desktop and 390×844 mobile
views retain the account, plan state and report definitions. Ad IDs render separately from names; wide tables scroll
within their container. Screenshots and test logs are retained in ignored `.runtime/launch-measurement-20261001/`.
Full release qualification and committed-source checks are recorded in [PROGRESS.md](PROGRESS.md).

The previous batch's [CI107](https://github.com/magdyezy1/CAMCP/actions/runs/36843246242) passed on `c419f96`:
3,125 host and 3,125 Docker tests, zero failures/skips, required FFmpeg, Railway compatibility, read/write smoke and
artifact upload. Those results do not qualify this later revision. No real credential, live advertising mutation,
deployment, DNS change or external notification was performed. No new dependency, database migration, OAuth scope
or reviewed native family is introduced.
