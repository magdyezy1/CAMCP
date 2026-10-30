---
status: record
tier: engineering
---

# LinkedIn guided evidence authority and account checks — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `a256bf1`. Batch 98 extends B15/B18/B24 and fixes F-157.

Guided LinkedIn campaign-group, campaign and creative capture now verifies exact native account identity and currency
before and after the complete analytics response. Actor, selected account/login, credentials and sorted permission scopes
are checked around every await and before persistence. Changed authorization stops capture before retaining evidence.
Reordering otherwise unchanged scopes remains valid. The previous synthetic path accepted changed credentials/scopes
and an account ID represented as an array; it also had no closing account read to detect changed currency/identity.
These are reproduced local findings, not assertions of observed incorrect live reports.

Account IDs accept exact positive decimal strings or safe native integers, never unsafe numbers or coercible arrays.
Ambiguous account wrappers and error/partial completion metadata are refused. The analytics endpoint remains one
native response with no invented pagination. Existing exact pivot, UTC date, duplicate-grain, empty-response ambiguity
and completeness checks run before the closing account read. All 10,000 rows are retained; 10,001 rows refuse before
another account read or persistence. The boundary case preserves the last large native URN and exact total.

Both account reads and the analytics response retain request/hash/time references. `source_collection:linkedin_analytics`
and one `source_pages` entry expose the collection in existing website source details and Excel references. The report's
source hash remains the hash of its original analytics response wrapper. The original first-account reference fields
remain available alongside the new `checks` array. Unselected account/billing fields are not retained in these projections.
UTC is the analytics date contract, not a newly inferred account timezone. Conversion-rule windows, reporting-window
completeness, event delivery and historical attribution are not verified by these account reads. Older retained reports,
manual mapped captures and Overview collection remain unchanged. This is not a point-in-time snapshot.

The English/Arabic form and MCP discovery explain both checks and source references while preserving fixed UTC and
`externalWebsiteConversions`, explicit attribution declarations, account selection and the original request. The native
read contracts were checked against official LinkedIn [account fields and account reads](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-09)
and [analytics reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-09),
using the repository's current `202609` request version. No new permission or advertising write is introduced.

Five backend cases and one bilingual UI case were observed red. Nine new tests also include exact/unsafe account IDs,
the 10,000-row boundary and a real-SDK capture → retained search → second capture → comparison journey. Focused checks
passed **64/64**. The SDK made **six schema-validated calls / 18,233 structured response bytes / six synthetic native GETs
/ zero mutations**; wrong-account and revoked-key calls added no egress. Missing conversion value correctly prevented a
fully matched comparison in an initial fixture; the successful fixture explicitly supplies that native metric.

Root regression passed **3,560 tests / 3,555 passed / zero failed / five local FFmpeg skips; 85.74 seconds**.
Static checks cover 32 browser scripts and 2,695 selected Arabic messages. Evidence: `.runtime/linkedin-evidence-integrity-20261002/`.
Fixture/VM/SDK checks are distinct from actual-browser, assistive-technology, live-provider and deployed acceptance.

Batch 97 exact committed-source checks and Railway passed on `a256bf1`: **3,546 passed / zero failed / five local
FFmpeg skips; 89.51 seconds**, four capture tests, **1,536 public files + one generated empty sample**;
source hash `b0639c341f89de30f41db85dca29f47cbb2e3dce59bb5061fc84a2985ed49042`.
It was pushed only to Work-here; [CI152](https://github.com/magdyezy1/CAMCP/actions/runs/36963993287) and Meta's
[CI151](https://github.com/magdyezy1/CAMCP/actions/runs/36962798743) were running when checked.

Google's [CI150](https://github.com/magdyezy1/CAMCP/actions/runs/36961537538) succeeded on `dad10e5`: host and Docker
each **3,531 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container smokes;
job `110696093657`, release-evidence artifact `11208882667`.

The ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Conversion-rule inspection, broader dimensions/providers
and further workflow/acceptance work remain separate.

Sanitized preflight `.release/linkedin-evidence-integrity-preflight-20261002` passed all stages and Railway:
**3,555 passed / zero failed / five local FFmpeg skips; 89.98 seconds**, four capture tests,
32 browser scripts, 2,695 selected Arabic messages and 264 documents. Its **1,538 public source files**
plus one generated empty sample have hash `311a0dde7f0986d8e93a2d7d965ca3430a88cd836245fceb71fdead0c3a5dbf0`.
Exact committed-source qualification follows before the sole Work-here push.
