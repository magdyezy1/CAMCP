# Original Google campaign/device/day evidence

Batch 159 adds a sixth separate Google capture preset, google_campaign_device. It reads campaign
performance by original native device and account-local day through the existing v25 Search
transport. The campaign preset stays the default. The query selects full customer/campaign
resources, account currency/timezone, segments.date/device and the original five metrics. It has
no status, channel or device filter and no ad-group/ad/criterion projection.

Every row must retain an exact campaign resource, selected customer and two-field date/device
grain. The seven documented device enums remain literal: MOBILE, DESKTOP, TABLET, CONNECTED_TV,
OTHER, UNKNOWN and UNSPECIFIED. An absent, malformed or unrecognized category refuses guided
capture; it is never inferred. The duplicate key is campaign resource × device × date across
all pages. Existing 100-page/10,000-row/deadline/body bounds, exact counts, before/after account
checks, current authorization and page/account source references remain.

The optional native_device mapping requires a plain field pointer and a literal documented
enum when present. Missing manually mapped cells stay null. Unmapped rows gain no device field.
Retained search includes it only when mapped. Device tables present the original campaign name,
device, date and complete resource identity; native categories/resources stay LTR and names are
escaped with automatic direction. Search changes only the displayed rows. Full totals and every
original Excel row remain. The mapped workbook appends native_device; old eleven columns and
keyword twelve columns retain their ordering, including optional combined thirteen-column maps.

## Research and interpretation

The current [Google segmentation guidance](https://developers.google.com/google-ads/api/docs/reporting/segmentation)
and [v25 segments.device field reference](https://developers.google.com/google-ads/api/fields/v25/segments#segments.device)
were checked on October 5. Device splits metrics by resource and device; adding a dimension expands
the row grain. The native field is selectable and compatible with campaign/customer, date and
all five selected metrics. The verified-TLS field page is 4,936,007 bytes, SHA256
4b32e79ab3cff3df2e0c5b647c7a6ebd20a0031e85713518c74a2e5d68b42254. Its resource compatibility list
names resources rather than every resource attribute. The pinned v25 schemas separately confirm
campaign/customer resource, ID, name, currency/timezone and date/device types. The
[official v25 device enum](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/enums/device.proto)
and [segments definition](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/common/segments.proto)
confirm all seven literal values. No live native query was used.

This preset keeps attribution and period completeness declared. UNKNOWN/UNSPECIFIED are native
categories, and absent categories do not establish zero activity. The report proves neither
point-in-time inventory nor attribution equivalence with a differently segmented report. Its
separate preset/grain refuses campaign allocation and search-exclusion eligibility and incompatible
guided reconciliation. It does not qualify device bid changes. No advertising changes are made.

## Connected verification

The first focused run passes 57 cases and fails one new MCP evaluator assertion: list returns its
documented reports array, while the evaluator attempted items. The corrected evaluator uses reports;
no application assertion or API was weakened. The fresh focused run passes 58/58/0/0 in 3.694 seconds.
Negative cases exercise foreign resources/customer, currency/timezone changes, unsupported or
missing device/grain, bad dates, duplicates across pages, changing/partial/repeated pagination,
the row limit, current credentials/scopes/account/key revocation and mapping transforms. Old
Google campaign/keyword captures, retained queries/index and workbook compatibility also pass.

The real MCP SDK journey uses six tool calls and 37,769 observed structured bytes. It discovers
the preset, captures two pages between two customer checks, filters CONNECTED_TV, lists source-linked
metadata, retrieves every original row and refuses access after key revocation. Original full
totals, huge exact spend, known zero, unknown conversion cells and every literal enum remain. The
fixed native fixture allows only the documented read endpoint; actual egress and mutations are
zero, with no campaign plan or write review. Observed bytes are not a performance threshold.

Seven authored Arabic messages cover the new label, native field/search, scope and three refusals.
The locale collector selects the exact Google refusal source plus only nativeDeviceMappingFailure
calls in decision-reporting; unrelated/dynamic/native diagnostics remain outside that selection.
Every prior catalog pair is preserved. The website gate passes 34 scripts/four pages and 3,620
explicitly selected messages. Maintained browser qualification adds eight served captures at
English/Arabic 320/375/768/1280 to the previous 184 cases; final results are recorded below.

## Release boundaries

Build and report generation run in fresh sanitized candidates with a literal empty live sample.
Only three validated public report artifacts return to the checkout; root private samples remain
unread. Fresh required-FFmpeg/default full checks, report freshness, Railway static checks and
exact committed-source/browser qualification precede the sole guarded Work-here push. Hosted
Actions is owner-skipped and the final documentation commit carries [skip ci]. Broader assistive
technology, browser/device coverage, current Linux/Docker, deployed Railway and native-provider
acceptance remain separate. B18/B27 and connected B15/B16/B24 advance within this local scope;
the whole-plan count remains 13 implemented / 14 partial / one open, and work continues.

## Final working-source qualification

The fresh sanitized candidate passes install/build/regenerated report/early freshness/full checks/
Railway: main 4,372/4,372/0/0 in 161.876 seconds; capture 4/4/0/0 in
91.5686 ms. Required FFmpeg runs with zero skips. The manifest contains 1,792
public sources and one generated literal empty sample, digest ea1a183c08b690e4ac8ee3e094c9c3d3128be45164c66073b4ac6e830f30f10c. All
three public report artifacts regenerate identically and preserve tracked bytes; root private
samples stay unread. Checks retain 34 scripts/four pages/3,620 selected messages/327 documents.

The maintained rendered suite passes 192/192/0 from 2026-10-04T23:00:21.155Z through 2026-10-04T23:05:22.854Z,
website digest c1d025bbf6b3836b4f804b2e6599ec9609138de3380446995052651ec351ddbc. Eight actual device capture/filter/download journeys
retain all seven literal categories and full campaign resources, original huge spend/zero/unknown
cells, complete totals and every original workbook row. The 32 populated retained-report journeys
inspect 1,336 original downloaded rows and 288 original controls meeting the scoped 44-pixel minimum,
with original labels/keyboard/table scroll/reflow checks. All earlier 3,821 catalog pairs remain.
No actual provider egress or mutation occurs, and report journeys create no plan or write review.
Fresh exact committed-source/full and clean-head browser checks follow before the sole Work-here
push; hosted Actions remains owner-skipped. Whole-plan work continues after this delivery.

## Exact-head qualification and delivery

Code 9275639 and final documentation 6f58a6e qualify 1,792 exact public Git sources plus one
generated empty sample, digest fb4ac2e9d906803f15ca6f2314a08136700bf6163a99d1784a269c2b0667b441. Fresh required-FFmpeg install/build/report/
freshness/default full checks/Railway all pass: main 4,372/4,372/0/0 in 224.090 seconds; capture
4/4/0/0 in 90.062 ms. Clean-head browser qualification passes 192/192/0, with 288 original controls,
128 original fields and 1,336 original workbook rows. All three reports remain byte-identical.
The guarded sole Work-here push advances 25fa7c4 to 6f58a6e; hosted Actions is not used. These
local results remain separate from independent assistive, Linux/Docker, deployed and provider
acceptance. Whole-plan delivery continues.
