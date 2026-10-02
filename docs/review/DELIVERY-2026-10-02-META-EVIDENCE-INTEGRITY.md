# Meta guided account verification and page lineage — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `dad10e5`. Batch 96 extends B15/B18/B24.

Guided Meta campaign, ad-set and ad evidence now verifies current native account identity, currency and timezone
before and after Insights collection, including empty results. Previously timezone was explicitly caller-declared,
and empty report rows could not themselves establish currency or timezone. Every account/page await and final
persistence rechecks the actor, account binding, credentials and sorted scopes. Changed authorization stops capture
without a retained report. No advertising write, new permission or external destination is introduced.

Each account and page read retains its request, response hash and capture time; pages also retain their sequence and
row count. `source_collection:"meta_insights_pages"`, `source_pages` and `native_account_evidence.checks` are exposed
through the existing report detail, readable source references and detailed Excel export. Unselected billing fields
and native continuation-link credentials do not enter those retained projections. Hashes describe the original
native response wrapper; the combined report has its own collection hash.

The collector keeps the original account-scoped Insights route, fields and measurement query. Only a bounded native
`paging.cursors.after` is copied into subsequent requests. The advertised next URL must stay on the same HTTPS Graph
origin/version/account/Insights path with matching cursor; it is never followed and its access token, fields or other
query values are never copied. Malformed cursors, foreign routes, repeated tokens and unknown completion metadata
fail. Empty intermediate pages with a valid next cursor continue; the absence of a next link ends native paging.
This is not a point-in-time snapshot, nor does paging prove event delivery or attribution accuracy.

The application retains at most 100 rows/page, 100 pages and 10,000 rows under the shared 120-request, 120-second,
32-MiB allowance and 8-MiB retained-report limit. A still-open 100th page fails before saving. Exact 10,000-row capture
is covered by a synthetic 102-read boundary case (100 pages plus two account checks); its final row and exact total
remain intact. The boundary/refusal suite passed **11/11**, taking 37.96 seconds in the recorded run.

Every row requires exact string account and applicable campaign/ad-set/ad IDs, matching currency and one date within
the requested daily window. An entity cannot change native parent during one collection. Duplicate entity/day rows
and ambiguous selected action metrics remain refused. Existing numeric entity IDs and the fixed 11-column evidence
schema remain unchanged. Missing conversions remain unknown; overlapping action aliases are still never summed.
Attribution window/action/report-time definitions continue to come from the generated request. Reporting-window
completeness remains a declaration. Manual mapped captures and Overview collection remain separate paths.

The English/Arabic capture form explains the verified account settings and page references while retaining the exact
selected conversion action and attribution windows. Account fields and GET semantics use the existing native read
contract, checked against Meta's official [Business SDK 26.0.2 AdAccount model](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/adaccount.py)
and pinned `tests/fixtures/meta-portfolio-sdk-v26.json` / `meta-website-recipe-sdk-v26.json` evidence. No live account
qualification or deployed acceptance is claimed.

Six backend cases and one bilingual UI case were observed red before implementation. Eight new tests include the
collection boundary; focused regression passed **68/68** before the additional boundary case. Existing real-SDK
journeys continue through verified capture to constrained allocation (**3 calls / 9,593 structured response bytes /
3 synthetic GETs**) and to retained linked-ad performance (**4 calls / 15,692 bytes / 3 synthetic GETs**). Neither
journey performs advertising mutations. Root regression passed **3,539 tests / 3,534 passed / zero failed / five
local FFmpeg skips; 85.44 seconds**. Static checks cover 32 browser scripts and 2,687 selected Arabic messages.
Evidence: `.runtime/meta-evidence-integrity-20261002/`. Fixture/VM/SDK checks remain distinct from real browser,
assistive-technology and live-provider acceptance.

Batch 95 exact committed-source checks and Railway passed on `dad10e5`: **3,526 passed / zero failed / five local
FFmpeg skips; 78.28 seconds**, four capture tests, **1,532 public files + one generated empty sample**;
source hash `37041be918b3aade99de591651f9f332a0a7ec68370b1a5310ad251d812b7913`.
Its [CI150](https://github.com/magdyezy1/CAMCP/actions/runs/36961537538) and consent/backup
[CI149](https://github.com/magdyezy1/CAMCP/actions/runs/36960088574) were running when checked.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Additional providers/dimensions, conversion-window
qualification and broader acceptance remain tracked separately.

Sanitized preflight `.release/meta-evidence-integrity-preflight-20261002` passed every check and Railway stage:
**3,534 passed / zero failed / five local FFmpeg skips; 88.59 seconds**, four capture tests, 32 browser
scripts, 2,687 selected Arabic messages and 262 documents. Its **1,534 public source files** plus one generated
empty sample have hash `e8f80eb336df13181ec559bee7fcba8aa6c38ecbf3c11ddcac07d8abe134ba26`. Exact committed-source checks follow before push.

The native next-link/cursor distinction was also checked in Meta's official
[SDK Cursor implementation](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/api.py).
AMCP additionally rejects a changed route and bounds the collection; it does not copy link credentials.
