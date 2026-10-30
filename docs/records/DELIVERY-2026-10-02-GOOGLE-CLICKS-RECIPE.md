---
status: record
tier: engineering
---

# Google Search with Maximize Clicks — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `3794fb9`. Batch 102 extends B08/B17/B24.

Campaigns and MCP now offer a sixth guided recipe, `google_search_clicks`, for Google Search with Maximize Clicks.
It requires an explicit positive campaign CPC ceiling as decimal text in account currency, with up to six decimal
places. Compilation preserves exact micros, refuses numeric/rounded or unrepresentable inputs and rejects competing
manual-CPC, CPA, ROAS, portfolio and conversion-strategy inputs. Existing manual-CPC Search behavior is preserved.

The recipe creates a dedicated budget, PAUSED Search campaign, location/language criteria, Search ad group, exact
keywords and responsive search ad. Children may start ENABLED under the paused campaign, following the existing
parent-state contract; activation remains a separate reviewed operation. Search partners and display networks remain
disabled. The campaign uses `target_spend.cpc_bid_ceiling_micros`; the ad group has no manual CPC field. No portfolio
bidding strategy or deprecated `target_spend_micros` is supplied. The recipe optimizes clicks and makes no conversion,
delivery or performance guarantee. Provider account eligibility and live acceptance remain unverified.

The workflow preserves explicit currency, Google EU political-advertising declaration, original ad copy/destination,
valid account-timezone dates and all targeting criteria. The maximum 30 geo/language operations split into reviewed
25/5 requests. Website forms expose the ceiling in English and Arabic, preserve decimal text and support the same
country/language lookup as manual Search. Capability discovery includes the exact native dependencies and the ceiling
prerequisite. Preview performs no mutation; saving creates an unapproved local draft. Approved profile defaults and
per-field provenance remain frozen, and current account/session access is checked before every dependent operation.

A synthetic full plan executes all six native steps through the existing review engine, verifies each resource and
replays without another mutation. A provider read-back with a different ceiling is first inconclusive, then a mismatch
on the next read; dependent ad-group creation remains blocked and no additional mutation occurs. This verifies the
existing lifecycle rather than asserting that provider writes are atomic or immediately consistent.

**F-159 (low)** was separately reproduced while importing the capability module directly in a fresh Node process:
the workspace module eagerly copied an imported scope binding before the circular dependency initialized. Keeping
the imported binding live removes that import-order failure without changing scope policy. Normal service-first
startup already worked; no deployed outage is claimed. The new subprocess regression covers the failing entry order.

Twelve new tests cover recipe discovery, exact native fields, invalid/conflicting inputs, split targeting, scheduling,
current access/profile provenance, unchanged manual Search, native dry-run contracts, complete reviewed execution,
read-back mismatch, bilingual form preservation, SDK interaction and direct module import. Six isolated cases were
observed red before implementation. The shared guide-example test now supplies the new required ceiling and validates
the maximum targeting count for both Google recipes. Focused checks passed **64/64**. The actual SDK journey made
**six schema-validated calls / 19,412 structured response bytes / zero provider requests**, including revoked-access
refusal. Synthetic execution tests issue requests only to an in-memory provider fixture, never to advertising accounts.

Root regression: **3,615 tests / 3,610 passed / zero failed / five local FFmpeg skips; 84.98 seconds**.
Evidence: `.runtime/google-clicks-recipe-20261002/`. The pinned contract is Google Ads v23; no runtime provider-version
upgrade is included. Native strategy fields were checked against Google's [v23 TargetSpend reference](https://developers.google.com/google-ads/api/reference/rpc/v23/TargetSpend)
and [standard/portfolio assignment guide](https://developers.google.com/google-ads/api/docs/campaigns/bidding/assign-strategies).

Batch 101 exact committed-source qualification passed on `3794fb9`: **3,598 passed / zero failed / five local FFmpeg
skips; 93.25 seconds**, four capture tests and Railway, **1,549 public files + one generated empty sample**, hash
`724a537b0ebf81d444da0fff855aef4703f22220789d19f2523488c4b2a16020`.
It was pushed only to Work-here. [CI156](https://github.com/magdyezy1/CAMCP/actions/runs/36971539914) remains in progress
at this record. [CI155](https://github.com/magdyezy1/CAMCP/actions/runs/36970264019) succeeded on `226642a`: host and
Docker each **3,594 passed / zero failed/skipped**, four capture tests and Railway. Job `110722572890` and
release-evidence artifact `11212460232` were checked, including job logs.

Native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
Blueprint remains **13 implemented / 14 partial / 1 open**. B17 now has six guided recipes; additional objectives and
eligible-account/live event qualification remain open. Native-browser/editorial Arabic acceptance is also separate.

Sanitized preflight `.release/google-clicks-recipe-preflight-20261002` passed all stages and Railway:
**3,610 passed / zero failed / five local FFmpeg skips; 89.94 seconds**, four capture tests,
33 browser scripts, 2,764 selected Arabic messages and 268 documents. Its **1,552 public source files**
plus one generated empty sample have hash `37e26fd43abcd341e6f36d80e1f9ad0729ada20fd36803e35250eaf1deae2ff4`.
Exact committed-source qualification follows before the sole Work-here push.
