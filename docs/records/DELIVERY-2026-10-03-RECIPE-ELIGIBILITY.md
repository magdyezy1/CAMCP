---
status: record
tier: engineering
---

# Current campaign brief eligibility and form integrity

Batch 105, 2026-10-03. Work only in `magdyezy1/CAMCP`, branch `Work-here`.

## Delivered behavior

`amcp_campaign recipe_eligibility` resolves the same approved profile defaults, input provenance and native
recipe compiler used by plan creation. Missing business decisions are returned before any provider request.
Complete local inspection returns the exact login/account, registered contracts and unresolved dependencies.
It saves no campaign plan and performs no provider mutation. The default is local inspection. Explicit
`live:true` reuses the existing read-only native preflight, including account, accessible resource and media
preparation checks. Temporary prepared media is removed by that existing preflight.

Evidence expires after five minutes and is bound to current actor authority, exact connection, credentials,
workspace write pause and approved profile revision. A change during collection discards the result. Account
currency is confirmed only by the exact native account read. Accessible Page/pixel dependencies can show their
existing prerequisite evidence. Explicit attribution settings and a campaign CPC ceiling are local compilation
evidence only. Event delivery, landing-page acceptance, predecessor receipts and provider objective acceptance
remain unresolved where their specific evidence has not been established. The overall result therefore remains
`unknown` or `blocked`, rather than declaring the campaign launch approved.

Campaigns adds **Check account prerequisites** beside local inspection and plan creation. The readable English
and Arabic result shows scoped account evidence, expiry, dependency labels, blockers, later checks and policy
notices, with native details available separately. Provider/profile values are escaped. Form edits clear old
results. Delayed results and errors are discarded after edits, workflow/profile/account changes, navigation or
identity changes. Targeting lookups also bind their current query, kind and selected account. Saving still uses
the original paused plan and reviewed-write engine.

The capability lifecycle advertises the new assessment, and first-party MCP outcomes link it to the campaign
composer. The existing plan preflight now validates complete native account state and exact scalar identity
before accepting currency or returning source evidence.

## Confirmed defects and tests

- **F-161, medium:** three synthetic regressions proved that existing campaign preflight accepted a foreign
  account ID, a coerced identity array or an unfinished native page as matching account currency evidence.
  `src/campaign-preflight.ts:163` now validates complete state and exact account identity before evidence retention.
- **F-162, medium:** delayed inspections and provider errors could overwrite a changed campaign brief. Two
  further red cases reproduced the same problem in targeting results/errors after account/query edits.
  `web/campaign-recipes.js:196` and `web/campaign-recipes.js:253` bind each response to its current form.
- Initial backend run: **seven failed / two passed**, including the four missing-feature tests and three
  pre-existing account-evidence defects. The two guards passed initially because the action was absent; their
  actual implementation is exercised by the later green run.
- Initial UI run: **four failed**, covering missing readable eligibility and stale inspection/error results.
  Extended handoff run: **five failed / 17 passed**, covering targeting races, Arabic copy and missing lifecycle/link.
- Focused completed suite: **74 passed / zero failed**. It includes backend controls, nine synthetic UI cases,
  recipe/preflight integration and the real MCP SDK journeys. A first SDK attempt exposed an incorrect exact-query
  assertion in the new fixture; its spacing was corrected to the existing native request without changing code.
- New SDK journey: **four tool calls / 17,098 structured-response bytes / one synthetic read-only provider request**.
  It validates advertised argument schemas, exact evidence, no saved plan and revoked-key refusal before egress.

Evidence is retained in `.runtime/recipe-eligibility-20261003/`. No incorrect live result or real-browser
accessibility certification is asserted. No new native provider field, write family, scope, OAuth grant or
provider behavior is introduced; the implementation reuses existing qualified recipe and preflight contracts.

## Prior release and remaining scope

Batch 104 exact committed-source qualification on `70df5cf` passed all five stages and Railway:
**3,646 passed / zero failed / five local FFmpeg skips; 95.62 seconds**, four capture tests, **1,557 public files
+ one generated empty sample**, source hash
`f3f72ed76a6b622b9eaf7d1111f905295ca5b0b03cecff562b3a164774d11f65`.
It was pushed only to `Work-here`. [CI159](https://github.com/magdyezy1/CAMCP/actions/runs/37082107361)
was still running when checked during this batch; that is not a successful CI claim.

The blueprint remains **13 implemented / 14 partial / one open**. B08 retains objective and entity eligibility
beyond available native prerequisites. B15 retains broader task/external-client evaluation. B16/B24 retain
independent browser, Arabic editorial, keyboard and assistive-technology acceptance. Provider writes, deployment,
credentials and production changes remain outside the adopted engineering brief.

Full local regression: **3,670 tests / 3,665 passed / zero failed / five local FFmpeg skips; 89.03 seconds**.
The first full run found two historical fixtures that omitted native account identity. They now return exact
provider-shaped Google, Microsoft and Meta account responses; the safety check was preserved. The corrected
fixture group passed 30/30. Locale validation covers **2,809 selected Arabic messages**. Native ledger remains
**3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**, with no changed ledger rows.

Sanitized preflight `.release/recipe-eligibility-preflight-20261003` passed all five stages and Railway:
**3,665 passed / zero failed / five local FFmpeg skips; 94.83 seconds**, four capture tests,
33 browser scripts, 2,809 selected Arabic messages and 271 documents. Its **1,561 public source files**
plus one generated empty sample have hash `457fb92721bfa479afe2ff1524cc84228b6283132321c9fe43be22cb81c29b76`.
Exact committed-source qualification follows before the sole Work-here push.
