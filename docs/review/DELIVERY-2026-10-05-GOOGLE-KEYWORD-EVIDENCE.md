# Native Google keyword performance, bounded daily evidence and exact downloads

Batch 156 adds a fifth Google detailed-evidence preset, google_keyword, through the existing v25
GoogleAds Search read. It advances B18/B27 and connected B15/B16/B24 workflows. Positive Search
keywords are separate native criterion/day units: entity_id retains the full keyword-view resource,
entity_name retains the original keyword text, and keyword_match_type retains EXACT, PHRASE or BROAD.
The four earlier Google presets and their original mappings remain. Four authored Arabic messages
preserve every earlier 3,785 catalog pair. Whole-plan package counts remain 13 implemented / 14 partial /
one open; broader reporting dimensions and external acceptance remain.

## Connected website and MCP workflow

In Reports, open Capture detailed native evidence, choose Google keyword performance and the exact
Google account/login, then declare the original currency, IANA timezone, date window and attribution
(or unknown). Conversion definition is fixed to metrics.conversions. The displayed keyword-specific
explanation distinguishes positive Search keyword/day performance from search queries, campaign totals,
exclusions and budget eligibility. Editing measurement revokes the completeness checkbox; only an
explicit Read and retain evidence starts the read. Existing current-form/navigation/identity handoffs
remain. MCP discovers the preset through capture_presets and captures it through capture_preset.

Retained rows display native match type with literal LTR enums and authored English/Arabic labels.
This preset starts its table with original keyword text and match type, followed by date and the full
resource ID. Scoped keyword-text row headers give the phone view useful context; other preset/table and
workbook orders remain unchanged. Hiding the name restores the available native ID as row header.
The keyword-specific row-search label explains that original text, dates and match types are searchable.
Search, page bounds and columns alter only the retained view: complete totals, source identity, original
unknown metrics and analysis remain. Every Excel download includes all original rows even while the
table is filtered. Only an explicitly mapped match type appends keyword_match_type to the workbook's
original eleven machine headers and Field mappings; existing workbook headers remain unchanged.
Enum values are never translated or combined with keyword text to fabricate a native name.

## Native contract and evidence boundaries

The existing captured google_ads_v23_google_ads_search action remains its compatibility identifier;
the maintained transport resolves it to POST /v25/customers/{customer}/googleAds:search. That exact
documented Search POST is a read. No new route, provider entitlement, keyword/bid/exclusion mutation,
negative-keyword recommendation or campaign-budget eligibility is introduced.

The generated keyword_view query selects customer/campaign/ad-group identity, criterion identity/type/
negative/text/match type, view resource, date and the existing exact metrics. It explicitly filters
campaign.advertising_channel_type = SEARCH and ad_group_criterion.negative = FALSE. No status filter
hides historical paused/removed keyword rows. The collector checks canonical int64 string IDs, exact
customer/campaign/ad-group/criterion/view resources, positive KEYWORD/Search shape, bounded original
text (80 Unicode code points and ten whitespace-delimited words), native enum and the account-local
daily window. ProtoJSON may omit a selected false negative flag; any present value must be false.
Duplicate view/day rows, contradictory parents or changed immutable keyword text/match type fail
before persistence. Response-only private fields are withheld from public evidence.

All existing bounded count/page/deadline/body rules and current actor/key/credentials/scopes/role/
read-grants checkpoints remain. Customer identity/currency/timezone are read before and after complete
native pages; both account reads and each page retain their source hashes. Custom match-type mapping
accepts only a plain pointer and the literal supported enum, with no unit/action/date transformation.
Empty terminal native defaults preserve the existing zero-row behavior; missing returned metrics stay
unknown and cannot become zero. Native page completion does not verify attribution, the declared
period completeness, a point-in-time snapshot, keyword inventory or equality with campaign totals.
Existing negative-exclusion and campaign-budget qualification remains limited to its original presets.

## Primary research

Google's [criteria reporting guide](https://developers.google.com/google-ads/api/docs/reporting/criteria-metrics?hl=en)
was inspected on 2026-10-04 and again on 2026-10-05. It identifies keyword_view, corresponding
ad_group_criterion fields and customer/campaign/ad-group parent selection. The exact v25
[KeywordView resource](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/resources/keyword_view.proto),
[KeywordInfo model](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/common/criteria.proto)
and [match-type enum](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/enums/keyword_match_type.proto)
were cross-checked with the pinned public .mirror/VENDOR/google-ads-v25.json discovery document.
Its capture is 2026-09-28 and its document hash is
38d286135f0f56170c654aa4a92a26d9a4b1f5d043eaa04776d0a21942729d70.

The full public [v25 keyword field reference](https://developers.google.com/google-ads/api/fields/v25/keyword_view)
was retrieved with verified TLS into the ignored research runtime: 4,607,115 bytes, SHA-256
5609f596cf6de6c6ea622f9e57b3de91f4ee27358b7493b5885e673df95b29ec.
Selected cost_micros, impressions, clicks, conversions, conversions_value and segments.date entries
all include keyword_view compatibility. The web tool's earlier size-limited fetch and a failed local
PowerShell TLS attempt were superseded by the bundled Python verified-TLS retrieval, not by disabling
TLS verification. These are vendor documentation and local fixture evidence, not native acceptance.

## Qualification

Six focused suites pass 62/62/0/0 in 3.372 seconds. They cover all four original guided Google presets,
positive/daily/paged/empty/default-false/Unicode cases, 26 malformed/foreign keyword variants,
duplicate/immutable-metadata/parent contradictions, complete-count refusals and twenty authority
changes around all four awaited reads. Unit/action/format coercion and unknown enum mappings fail.
Real workbook inspection confirms original headers and exact optional enums in both languages.

A real MCP SDK client/server journey makes five tool calls / 37,253 structured response bytes:
discover, two-page capture, native-match filter, full retained read/download link and key revocation.
Four synthetic native reads collect four original rows with two account checks and two page hashes.
Exact 9007199254.740993 spend, zero versus null, literal original text and resource IDs survive. No
actual provider request, provider mutation, advertising plan or write review occurs. Maintained web
checks cover 34 scripts, four pages and 3,581 explicitly selected messages. Contract and action-coverage
freshness checks pass unchanged. Actual browser/full-release and exact committed-source checks follow.

Hosted GitHub Actions runs remain owner-skipped because the owner exhausted minutes. Docker/Podman,
other engines/devices, assistive technology, real native acceptance and deployed Railway behavior remain
unqualified at this record. Full plan work continues after the sole qualified Work-here push.

Screenshot inspection of the first diagnostic keyword journey found long resource IDs dominating the
phone view. The context-first keyword-only table refinement passes all eight fresh English/Arabic
keyword journeys. The first full attempt passed the original 168 cases but the new test omitted the
required explicit account choice; native HTML validation correctly prevented capture. That test was
corrected. An overlapping earlier full run cannot qualify later source changes and is diagnostic only.
Fresh maintained final-source qualification is recorded separately below. No product defect/live
incident is inferred from these test setup or source-timing diagnostics.

## Final local release and rendered qualification

Fresh sanitized offline install/build/early report freshness/full checks/Railway pass: main
4,351/4,351/0/0 in 137.482 seconds; capture 4/4/0/0 in
78.547 ms. Required FFmpeg exercises all media cases with zero skips.
There are 1,785 public sources plus one generated literal empty sample; preflight source hash
1b869a433312a0d24b42a86a18f6661b44ab3ebf691c883b6bf2c5d1f80316b3. Three public report artifacts regenerate unchanged and preserve exact
bytes throughout full checks; the root private sample stays unread. Web checks cover 34 scripts /
four pages / 3,581 selected messages; documentation index has 324 documents.

The maintained final-source browser suite passes 176/176/0 from 2026-10-04T21:13:48.450Z through
2026-10-04T21:18:49.723Z; website digest 4f1c0dd4b3a09507ad6c94c40ea8c52ded857b446013b41acc08adbb5106b097. All eight new keyword
journeys retain text-first context, literal match type/resource IDs, four explicit synthetic native
reads, one-row retained match filtering and all four original XLSX rows. Thirty-two original
keyword/day workbook rows are inspected; original eight retained-report cases still inspect 1,208
workbook rows and 2,000 native single-line cell ranges. Row headers measure at least 192 pixels;
named-region keyboard scrolling, skipped-main/drawer focus and contained page reflow pass.
No provider mutation or external provider request occurs. Earlier diagnostic/mixed-source runs do
not qualify this final revision. Arabic 375 context-first and English 1280 filtered screenshots
were inspected, with keyboard-scrolled table positions distinguished from page reflow.
Fresh clean committed-source/default/browser checks follow before the sole Work-here push. Hosted
CI remains owner-skipped. Full-plan work and broader external acceptance remain separate.

## Exact batch-156 committed-source qualification and sole push

Code 20bc4c8b3da6c9fad3317d219d441487155a2c96 and documentation HEAD
536c945aa3f18c1a0b8b8e0e8dbb0d6d144dd005 were pushed only to Work-here after clean-source proof.
All 1,785 public Git blobs plus one generated literal empty sample match, source digest
680ff8306b48056c2ab75a47d76bc62f1215cfb8156122a3229640c860078a7e. Fresh offline install/build/report
freshness/full check/Railway pass with required FFmpeg: main 4,351/4,351/0/0 in 138.741 seconds and
capture 4/4/0/0 in 77.008 ms. Three tracked public report artifacts retain exact bytes.
The clean-HEAD browser suite passes 176/176/0, including eight keyword journeys, 32 inspected keyword
workbook rows, 1,208 original retained workbook rows and 2,000 exact native cell ranges. Website digest
4f1c0dd4b3a09507ad6c94c40ea8c52ded857b446013b41acc08adbb5106b097. Hosted CI remains owner-skipped;
no current Docker/live/deployed acceptance is inferred. Batch 157 and the remaining plan continue.
