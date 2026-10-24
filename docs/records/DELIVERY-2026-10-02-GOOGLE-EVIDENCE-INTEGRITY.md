---
status: record
tier: engineering
---

# Google guided evidence integrity — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `1a6d548`. Batch 95 repairs F-156 and extends B15/B18/B24.

A synthetic probe against the previous guided Google capture accepted six invalid inputs: a foreign customer,
different currency, different timezone, out-of-window date, duplicated campaign/day and missing campaign ID.
All six were retained; duplication doubled spend. This is a reproduced local integrity defect, not evidence of
incorrect deployed or live-account reporting. The probe is retained under `.runtime/google-evidence-integrity-20261002/`.

The four Google presets now read exact customer identity, resource name, currency and timezone before and after
collection. Every awaited request and final persistence rechecks the current actor, account binding, credentials
and scopes. Both account reads retain request/hash/time references, including for empty reports. The logical
catalog action retains its historical v23 name; the existing registry and pinned Discovery contract send v25 requests.

Report requests explicitly select native customer and resource identities and request total result counts.
Pages retain individual request/hash/time/count references. Up to 100 pages and 10,000 rows share the existing
120-request, 120-second, 32-MiB collection allowance; the retained report remains bounded to 8 MiB. No page-size
override is sent. Missing nonzero counts, count drift, inconsistent continuation, repeated tokens, partial/error
metadata, summary rows, duplicate native grains and malformed responses refuse capture before persistence.
Proto3 omitted default result arrays and zero counts are accepted only as an empty terminal result; both customer
checks still have to succeed. Complete paging is not a point-in-time snapshot or independently verified attribution.

Rows must match exact selected customer/currency/timezone, campaign and applicable ad-group/ad/search-term
resource identities. Native IDs remain positive int64 strings. Daily rows must use only the requested date segment
within the selected window. An ad group cannot change campaign within one collection. Search-term resources bind
campaign, ad group and exact UTF-8 term through URL-base64; native padded/unpadded resource spelling is preserved,
while the duplicate check uses the underlying parent/term tuple. Missing metrics remain unknown; cost micros keep
the established exact decimal conversion.

New `google_ad` captures use the complete native `adGroupAd.resourceName` as `entity_id`, at **ad group × ad × day**
grain. Search terms use `searchTermView.resourceName`, at campaign × ad group × search term grain. The same ad ID
or search text in different parents therefore remains distinct in retained rows, grouping, website views and Excel.
Campaign and ad-group entity IDs remain numeric strings. Existing records are unchanged; reconciliation rejects
incompatible old/new mappings or grains. The fixed 11-column retained/export schema remains intact.

Conversions are explicitly `metrics.conversions`, derived from the generated query. Attribution windows and
reporting-window completeness remain caller declarations; individual conversion-action settings are not fetched.
The English/Arabic capture form fixes this metric and explains verified settings, native resource identity and
search-term coverage. `search_term_view` excludes Performance Max and does not establish equality with campaign
totals. Manual mapped captures and Overview reporting remain separate paths.

Official references checked 2 October: Google's
[v25 customer model](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/resources/customer.proto),
[ad-group-ad resource](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/resources/ad_group_ad.proto),
[search-term model](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/resources/search_term_view.proto),
[Search request/response](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/google_ads_service.proto),
[segmentation](https://developers.google.com/google-ads/api/docs/reporting/segmentation) and
[paging](https://developers.google.com/google-ads/api/docs/reporting/paging). These contract references and native
fixture checks are not live-provider acceptance.

Eight backend cases and one bilingual UI case were observed red before implementation. Ten new tests include a
real-SDK journey; focused checks passed **67/67**. The SDK journey made **six schema-validated calls / 19,386
structured response bytes / six synthetic Google Search POST reads**, zero mutations; wrong-account and revoked-key
calls added no egress. It captures, retrieves and reconciles source-bound ad evidence. Regression covers all four
presets, exact large values, missing metrics, empty defaults, changed permissions, count/token failures, hierarchy,
date grain and the 10,000-row boundary. Root regression passed **3,531 tests / 3,526 passed / zero failed / five
local FFmpeg skips; 74.40 seconds**. Evidence: `.runtime/google-evidence-integrity-20261002/`.

Batch 94 exact committed-source checks and Railway passed on `1a6d548`: **3,516 passed / zero failed / five local
FFmpeg skips; 77.49 seconds**, four capture tests, **1,528 public files + one generated empty sample**;
source hash `4de5d0a938e1ce338095af44ebf0c65eccc894dc7e848e23d5fb9a08c92e5485`.
Its [CI149](https://github.com/magdyezy1/CAMCP/actions/runs/36960088574) was running when checked.
[CI148](https://github.com/magdyezy1/CAMCP/actions/runs/36957813743) succeeded on `ea4ae99`: host and Docker each
**3,508 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both container smokes;
job `110684605781`, artifact `11207443383`.
[CI147](https://github.com/magdyezy1/CAMCP/actions/runs/36956104150) also succeeded on `7c6d9e5`: host/Docker each
**3,499 passed / zero failed/skipped**, required FFmpeg, four capture tests, Railway and both smokes;
job `110679279128`, artifact `11207072004`.

The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. Provider qualification, broader dimensions and
actual-browser/accessibility acceptance remain unfinished.

Sanitized preflight `.release/google-evidence-integrity-preflight-20261002` passed every check and Railway stage:
**3,526 passed / zero failed / five local FFmpeg skips; 83.54 seconds**, four capture tests, 32 browser
scripts, 2,686 selected Arabic messages and 261 documents. Its **1,532 public source files** plus one generated
empty sample have hash `af657b82a71a0d55cd91a0fb9e47fc3f47aa44b61f85ccfbc274fb216c5a8609`. Exact committed-source checks follow before push.
