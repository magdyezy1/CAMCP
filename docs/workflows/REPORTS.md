---
status: reference
tier: operator
---

# Reports, evidence and delivery

Reports, retained evidence and delivery, the guided evidence presets, saved evidence and capture refusals. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

Reporting overview selects campaign, native ad-set/ad-group or ad detail separately from date grouping.
Google, Meta, TikTok and Snapchat support their qualified middle and ad levels; LinkedIn supports native
campaign and sponsored-creative levels. Detailed sources require their explicit measurement settings; unsupported
levels are refused. Original native IDs and source rows remain available, additive rollups preserve exact decimals,
and missing values and multi-day reach/frequency stay unknown. Select **Export now to Google Sheets** on a
collected snapshot, choose its destination and confirm the immediate export. The original snapshot is exported
even after setup edits; no schedule is created and unrelated spreadsheet tabs are preserved. See the
[appearance, media and detail delivery record](../records/DELIVERY-2026-10-07-APPEARANCE-MEDIA-DETAIL.md).

Report library (`/report-library`) separates saved definitions, reusable account-free templates and retained
snapshots. Search finds definitions by client/name; snapshot history pages through older accessible results. A
snapshot link opens its retained results, and **Use this snapshot's setup** explicitly copies its original settings
into the builder. Changing the builder does not mutate the snapshot.

Every Overview collection has one durable allowance across accounts, periods, pages, retries and report downloads:

| Limit                  | Whole snapshot allowance |
| ---------------------- | -----------------------: |
| Native HTTP requests   |                    1,200 |
| Normalized source rows |                   25,000 |
| Active collection time |               300,000 ms |
| Response bytes         |                  128 MiB |

Counters are saved before egress and never reset by retry. Clean queue waiting is excluded; an interrupted process
conservatively charges elapsed wall time since its last active checkpoint. Between completed native periods, a
dispatch yields after 20 seconds so other queued work can run. This is not a per-request deadline shorter than the
remaining collection time and does not interrupt advertising mutations. A limit retains completed results and
explicit missing-source/period errors. Narrow the next run rather than retrying for a fresh allowance. Legacy
partially collected jobs without counters require a new run (`REPORT_RESTART_REQUIRED`).

A level that reads an account campaign by campaign (Snapchat's ad squad level, Apple's ad group and ad levels) has no
bound on campaigns of its own: each costs a request, and the allowance is the bound. When it ends after at least one
campaign is finished, the report keeps the campaigns it read, is partial, and says "n of m campaigns read" in a warning;
the next run is narrowed by campaign IDs. With no campaign read, the limit error itself is raised.

TikTok integrated aggregation requires consistent native page counts and stable totals, with unique requested
dimension tuples. Rows without page counts, overlapping rows and malformed grain fail the source before Overview
retains metrics; a short collection stays partial, and an empty report needs no page counts. Native page metadata
is preserved; the outer pages/truncated fields describe aggregation. Single-page raw reads and inventory lists keep
their own contracts.

X reporting assigns each UTC hour to one local calendar period by its midpoint. Fractional-hour boundary periods
are marked with the hourly-resolution limitation; adjacent daily totals do not count the same hour twice.
Successful empty or sparse native metrics remain valid dependencies with unknown values, rather than failing
custom formula validation.

**Analyze retained evidence** selects a single compatible account/login/currency/timezone/attribution/conversion
group. It retains original row capture timestamps, query fingerprints and snapshot lineage and makes no new
provider query. Pacing, reconciliation and recommendation operations remain advisory.

Detailed evidence includes a readable table of every retained mapped row, 50 at a time, with previous/next and
direct page selection. Exact IDs and decimal strings are preserved; missing metrics remain unknown. Paging reads
retained data under current account access and does not call the provider. Source/account/hash/count mismatches
clear the table. The source-details panel includes account checks, per-page evidence and Overview lineage when
available. English/Arabic labels keep native names and values unchanged.

Use **Download all rows as Excel** for all retained mapped rows, totals, mappings, measurement settings and
selected source hashes. Choose English or Arabic explicitly; it defaults to English independently of interface
language. Native headers and cell values remain unchanged. Numeric values are text to retain precision; missing
values stay blank and coverage distinguishes unknown from unmapped. Downloads recheck current session/account
access and report revision after generation. They make no provider request and do not save a binary copy.
The reporting capture/get response also exposes an authenticated relative `xlsx_path` handoff.

Open a retained report and choose a retained reference to compare the same account and period. AMCP checks the
saved measurement settings, guided native grain and field mappings, or the same Overview definition/group. It
refuses unknown or mismatched settings and shows exact additive differences, tolerances and unavailable values.
Both source hashes and capture times remain available. This compares retained declarations without a fresh
provider request or independent attribution verification. Manually entered totals remain available under their
own disclosure: a numerical match does not establish compatible report settings.

**Import a CSV reference** reads a UTF-8 CSV/TSV or BOM-marked UTF-16 file locally, up to 64 KiB. Use exactly
one header row and one aggregate totals row. Choose the delimiter and decimal separator, map each metric to its
own column, and specify currency units, hundredths or micros for each money metric. Preview the exact values;
then declare the original account, dates, currency, timezone, attribution, conversion definition and grain, and
explicitly confirm complete coverage and matching entities/filters. Multiple detail rows are refused rather than
silently summed with totals. Blank selected cells remain unknown. No grouping characters, formulas or rounding
are accepted. Only mapped totals, selected column names, settings and a SHA-256 of the original local bytes are
sent. The timestamp records the import comparison, not an independently established provider export time.
The server checks declarations against retained evidence but does not independently verify the file or attribution.

`amcp_reporting` adds:

| Action                  | Inputs / result                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_presets`       | Available detailed native mappings and declared limits; with `connection_id`/`account_id`, also the account's stored currency, timezone and read time         |
| `capture_preset`        | `preset`, exact `connection_id`/`account_id`, and `semantics`; Meta also requires `result_action_type` and `attribution_windows`                              |
| `overview_sources`      | `id` of a retained Overview snapshot; lists eligible semantic groups                                                                                          |
| `capture_overview`      | Snapshot `id` and exact `group_id`; reuses retained evidence                                                                                                  |
| `scenarios`             | Evidence `id`, `options.budgets`, `efficiency_low`, `efficiency_high`; returns explicit sensitivity assumptions                                               |
| `allocation_candidates` | Guided campaign evidence `id`; paginated campaign metadata with `offset`/`limit` and `next_offset`                                                            |
| `allocation`            | Evidence `id`, explicit total period budget, campaign floors/caps, sensitivity factors, evidence age and minimum conversions; returns an inspectable proposal |

Provider metric values are parsed from their decimal text, never with float arithmetic. Additive metrics keep nine
decimal places: a longer value, such as a fractional data-driven Google conversion (`0.30000000000000004`) or exponent
text (`1e-7`), is rounded half to even (owner decision D10) instead of failing the source. Evidence that needed
rounding records `semantics.metric_rounding` (`{metric: {places: 9, rule: "half_even", rows_rounded}}`), which is part
of its source hash; allocation, calibration and recommendations then add a rounding limitation. Reach and frequency
are never summed and keep their exact native text. Negative or non-numeric provider values fail with a field-naming
`REPORT_SHAPE_CHANGED` error, and JSON numbers above 2^53 with `METRIC_PRECISION_LOSS`. Caller-declared totals,
tolerances and targets keep the strict grammar of at most nine decimal places. `AMCP_REPORT_LOSSLESS_NUMBERS=true`
(off by default) also keeps fractional JSON numbers in read-only Google search, Meta Insights, TikTok, Snapchat and
LinkedIn report responses as their exact source text. Keep it off until the reporting suites cover campaign-level
overview runs of each of those platforms with it on; only the qualified detail collectors are covered today.

Google presets are `google_campaign`, `google_adset`, `google_ad` and `google_search_terms`. Each needs currency, IANA
timezone, date_from/date_to, attribution, source_name and a boolean complete declaration. The fixed conversion
definition is `metrics.conversions`. Exact customer identity/currency/timezone are verified before and after complete
Search pages; account and page request/hash references are retained. Each row must match its native hierarchy and
requested date/grain. Counts, duplicate rows, malformed continuation and changed authority stop capture before saving.
The first three retain daily grain; ads use ad-group-ad resource names as entity IDs, keeping parent-specific ads
distinct. Search terms use search-term-view resource names over the selected period, preserving campaign/ad-group/term
identity; this endpoint excludes Performance Max. Campaign/ad-group IDs stay numeric strings. Existing evidence is
unchanged, and incompatible legacy mappings/grains cannot be reconciled. Native cost micros are divided exactly by
1,000,000. Up to 100 pages share limits of 120 requests, 10,000 rows, 120 seconds and 32 MiB. Empty proto3 default
responses require successful customer checks. Missing metrics stay unknown. Attribution and window completeness
remain declarations; search-term visibility can prevent reconciliation to campaign totals. See the
[Google evidence qualification](../records/DELIVERY-2026-10-02-GOOGLE-EVIDENCE-INTEGRITY.md).

Meta presets are `meta_campaign`, `meta_adset` and `meta_ad`, each at entity × day grain. Supply currency, IANA
timezone, dates, source name and completeness. Select the exact native `result_action_type` (for example,
`offsite_conversion.fb_pixel_purchase`) and `attribution_windows`: at most one of `1d_click`/`7d_click`/`28d_click`,
optional `1d_view` and `1d_ev` (one-day engaged view), or view windows alone (RPT-07). Two click windows together, and
the `7d_view`/`28d_view` windows Meta removed on 2026-01-12, are refused. The request explicitly uses impression time and
disables account/unified attribution overrides; the saved attribution/result definitions are derived from that query.
Account identity, currency and timezone are verified before and after complete Insights pages, including empty
reports. Each native row must match its account, exact parent chain, currency, dates and unique entity/day grain.
Changed credentials/scopes/access stop collection. Only bounded native cursors on the original account/query are
reused; continuation URLs and their credentials are never followed or copied. Empty intermediate pages continue
when another page is advertised. At most 100 pages/10,000 rows share the same request/time/byte bounds. Both account
checks and every page retain source references. On a delivered row (impressions above 0) an absent selected action
counts as 0 and is named in `omitted_as_zero` (Meta omits zero-valued action entries); a row without delivery keeps
it unknown. Overlapping action aliases are never added. Window completeness remains declared, and complete paging does not prove conversion delivery.
See the [Meta evidence qualification](../records/DELIVERY-2026-10-02-META-EVIDENCE-INTEGRITY.md); SDK/native fixture evidence
does not certify live provider acceptance.

**Dimension packs (RPT-07).** Five presets answer audience, placement, network and Performance Max questions that
campaign rows cannot, through the same verified collectors:

| Preset                     | Grain                                                 | Native dimension columns                                |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `google_pmax_search_terms` | Performance Max campaign × search term (window total) | `search_term` from `campaign_search_term_view`          |
| `google_campaign_network`  | campaign × ad network × day                           | `native_ad_network` (`segments.ad_network_type`)        |
| `meta_campaign_age_gender` | campaign × age × gender × day                         | `native_age`, `native_gender`                           |
| `meta_campaign_country`    | campaign × country × day                              | `native_country`                                        |
| `meta_campaign_placement`  | campaign × publisher platform × placement × day       | `native_publisher_platform`, `native_platform_position` |

Values stay the literal provider values (never translated or merged) in the table, row search and English and Arabic
Excel exports. A value outside the documented native set (Google's AdNetworkType enum; Meta's age buckets, genders,
publisher platforms, ISO country codes or `unknown`, and lower-case placement names), a duplicate bucket/day row, an
unrequested breakdown field, an extra segment or a Performance Max term outside a `PERFORMANCE_MAX` campaign or under a
different `campaignSearchTermViews/{campaign}~{base64 term}` resource refuses capture and saves nothing. Saved evidence
carries `breakdown {dimensions, observed_values, absent_buckets:"unknown", reconciles_with_parent_totals:false}`: a
bucket the provider did not return is unknown, never zero, and bucket totals can differ from campaign totals (privacy
thresholds, unknown buckets). Reach and frequency stay per bucket and are never added together; Meta omits reach for
breakdown reports that start more than 13 months ago. The Google search-term view without keyword segments includes
Performance Max data; these terms do not qualify negative keywords, brand exclusions or budget changes.

LinkedIn presets are `linkedin_campaign_group`, `linkedin_campaign` and `linkedin_creative`, at the native
entity × UTC day grain. Supply the native account currency, `timezone:"UTC"`, dates, source name, attribution
definition (or `unknown`) and completeness declaration. The backend verifies currency against a fresh scoped
account read and derives `conversion_definition:"externalWebsiteConversions"` from its analytics request.
Native URNs are retained exactly; missing entity names and metrics remain unknown. Conversion-rule attribution
windows are not independently fetched. The website fixes the UTC/metric fields and restores prior declarations
when switching providers. The same request/row/time/byte limits cover the account and analytics reads together.
Use the current month and previous five calendar months, through today in UTC. Analytics has no pagination:
continuation metadata, provider ceilings, malformed/duplicate daily rows and empty responses refuse capture.
Empty responses can mean no activity or missing reporting access, so they cannot establish zero performance.
Narrow an oversized report or resolve access before making a new read. Retained account and analytics request/hash
references remain available; this does not qualify LinkedIn budget allocation or advertising writes.

**Verified LinkedIn conversion windows (RPT-07, B18).** `linkedin_campaign_conversion` reads campaign × conversion ×
UTC day evidence with the statistics finder (`q=statistics`, `pivots=List(CAMPAIGN,CONVERSION)`) and the
`externalWebsiteConversions`, post-click and post-view conversion counts and conversion value. Declare
`attribution:"verified_per_rule"`; a typed window (or `unknown`) is refused before any read with
`REPORT_ATTRIBUTION_DECLARED`. After the analytics response, and inside the same authorization bracket, AMCP reads
the account's current conversion rules (the same account finder as LinkedIn conversion settings) and joins each
reported conversion URN to its rule's `postClickAttributionWindowSize` and `viewThroughAttributionWindowSize`. The
result's `conversion_windows.status` is `verified_per_rule` (every conversion's rule has the same windows; the
semantics attribution names them), `mixed` (rules differ: no single window, and a declared single-window reference is
refused) or `unknown` (a reported conversion has no current rule, for example a deleted one, or no stated window;
attribution stays `unknown`). Spend, impressions and clicks are not split by conversion and stay unmapped. The
15,000-element ceiling, empty responses and malformed or duplicate campaign/conversion/day rows refuse capture as for
the other LinkedIn presets. Rule windows are today's settings, not a history. A live capture on an owner-designated
account (559535022) is still an owner acceptance step.

TikTok presets are `tiktok_campaign`, `tiktok_adgroup` and `tiktok_ad`, at native entity × advertiser-local
day grain. Declare exact advertiser/login, currency, IANA timezone, source name, attribution (or `unknown`),
dates and `complete:true`. Use 1–366 closed days. Currency/timezone are verified against advertiser metadata
before and after the report pages. Native `conversion` follows each entity optimization goal;
goals may differ, and attribution windows remain declarations. Smart+, GMV Max and specialized reports are
separate. The UI fixes only `conversion_definition:"conversion (optimization goal)"` and restores prior
declarations when changing providers. Exact decimal values and native IDs remain intact; missing metrics stay
unknown. No conversion value or reach is synthesized. In 30-day spans, up to 10,000 rows are collected with
strict page/count validation, duplicate checks and unchanged
authority; each page and both account checks retain request/hash references. Collection is not a point-in-time
snapshot. Current SDK request-contract and synthetic response tests are not live-provider qualification.

Scenarios accept 1–12 decimal budgets and positive low/high efficiency factors no greater than 10. They need positive
observed spend and conversions. They are linear CPA sensitivity models, with evidence age/completeness and source
hash attached, not calibrated delivery forecasts or automatic budget changes.

**Allocate a budget across campaigns** appears for guided Google/Meta campaign-by-day evidence. Choose 2–50
campaigns from paginated retained totals, then supply each floor/cap and a positive total period budget. The model
maximizes linear modeled conversions within those constraints. Amounts support six decimal places; exact integer
arithmetic preserves the total and constraints, and equal efficiencies use native ID ordering. A floor sum above
the budget or cap sum below it is refused. No campaign, currency or report is silently added to the selection.

The `allocation` options are `budget`, `allocations:[{entity_id,minimum,maximum}]`, `efficiency_low`,
`efficiency_high`, `minimum_conversions` (1–1,000,000) and `maximum_age_days` (1–90). Known positive spend and
enough observed conversions are required for every selected campaign. Incomplete reports, unknown measurement,
duplicate campaign/day rows, future/open periods and stale evidence are refused. Both capture time and the native
timezone's reporting end date must be recent; recapturing old dates does not satisfy the age check.

Proposals retain source hash, scope/measurement definitions, assumptions and binding constraints and can be
downloaded as JSON. Their budgets cover a comparable period of the same duration as the evidence. They are not
native daily budgets, calibrated forecasts or approvals. Linear response ignores saturation, causal effects and
changing auctions; the conversion threshold is an explicit planning assumption, not statistical significance.
Provider floors/caps, shared budget ownership and native units require separate validation before any reviewed
change. Editing a constraint clears the old result; late results cannot restore stale inputs or another report.
See the [allocation qualification record](../records/DELIVERY-2026-10-01-ALLOCATION.md).

Schedules (`/schedules`) lists existing delivery definitions with a read-only preview of the next three windows.
Pause/resume/delete, destination links and recovery use the existing schedule/export engine. Timing preview performs
no provider request and does not create another schedule. Failed Sheets delivery and successful source collection
remain separate states.

## Search-term exclusions from retained evidence

Open a completed guided Google search-term report in Reports. Choose minimum clicks (default 30) and maximum
evidence age (default seven days), then read possible exclusions. This uses retained rows without a provider call.
Known zero conversions is a selection aid, not proof that traffic has no business value. Review relevance and
conversion lag. Unknown metrics stay unknown. Only unchanged literal terms up to 80 UTF-16 characters/ten words
using letters, marks, numbers, spaces and apostrophes enter this guided subset.

Select one to 20 original rows across pages, then preview current native context. AMCP checks selected groups and
current exact keywords; conflicting positive or negative exact keywords block the proposal. Broader/phrase and
campaign/shared/account-level coverage is not assessed. Confirming saves an **unapproved** draft under Campaigns.
It changes no advertising account. Separate approval, spending acknowledgement, native review and verified execution
remain required. A save retry retains the original preview and reuses its plan. Source or selection changes require
a fresh preview; previews expire after ten minutes. See the [delivery record](../records/DELIVERY-2026-10-02-SEARCH-EXCLUSION-PLANS.md).

MCP: `amcp_decision_report {action:"search_exclusion_candidates",id,options:{minimum_clicks,maximum_age_days},offset?,limit?}`;
follow `next_offset` and explicitly select native row IDs. Then call `preview_search_exclusions` with the same
report, options and `ids`. Use its exact `preview_id`/`preview_hash` with `create_search_exclusion_plan`,
report `id` and `confirmed:true`. Candidate reads support readers; preview/save require an operator/admin.

## Organic and paid search overlap

`amcp_workspace {action:"search_overlap",gateway:"google_ads_native_action",account_id,connection_id?,
requirements:{site_url,gsc_connection_id?,date_from,date_to,row_limit?,max_rows?,include_pages?}}` (PRV-07, MCP
only) reads the Search Console property's queries (`searchAnalytics.query`, dimension `query`, web,
`dataState: final`) and the customer's `search_term_view` for the same closed dates (at most 90 days, before today;
1–25,000 rows per source), and joins them locally on normalized text (NFKC, lower case, collapsed spaces). Every
match is labelled `approximate_normalized_text`: the products match queries differently, Search Console omits
anonymized queries, both report top rows (`top_rows_only`, `complete:false`), their days use different time zones,
and final Search Console data trails by two to three days (`recent_days_may_be_missing`). The table classifies each
query as `both`, `paid_only` or `organic_only`, keeps exact paid micros, clicks and conversions and an
impression-weighted organic position, and sorts deterministically. `include_pages:true` adds one `query × page`
read and lists each organic query's top three landing pages; those by-page metrics rank pages within a query and do
not add up to its totals. `review_hint` marks a strong organic position with paid spend, or a converting paid-only
term; it is a prompt for review, never a change. Findings feed the reviewed paths above: each paid row lists its
native `search_term_views` (up to 20, with `search_term_view_count`), the ids `preview_search_exclusions` takes from
a retained `google_search_terms` report of the same dates; a keyword is prepared through `amcp_write`. Both sources
stay in scope: the Search Console login must hold the exact property and be its default, and a foreign site,
customer, page, search term view or malformed row refuses the whole read. Nothing is saved.

## Snapchat daily purchase evidence

Open **Capture detailed native evidence** in Reports and choose Snapchat campaign, ad squad or ad performance. Select the
exact login/account, native currency and IANA timezone, then 1–31 closed dates. Choose the swipe and view attribution
windows explicitly and confirm the complete window. A seven-day view needs a seven- or 28-day swipe. The capture
uses purchase conversions across total sources at conversion time, swipes as clicks and exact native spend micros.

The server verifies account metadata before/after all pages and requires native delivery and conversion processing
to cover the requested end. Missing, conflicting, oversized or partial evidence is refused. Missing metrics stay
unknown; names, conversion value and creative assignment are not supplied. Fractional-hour account midnights cannot
be represented by this whole-hour native stats request; the workflow refuses them. Retained rows support the same
scoped paging/search, Excel and compatible reference comparison as other guided evidence.

For MCP use `capture_preset` with `preset:"snapchat_campaign"` or `"snapchat_ad"`, explicit
`swipe_up_attribution_window` (`1_DAY`, `7_DAY`, `28_DAY`) and `view_attribution_window`
(`none`, `1_HOUR`, `3_HOUR`, `6_HOUR`, `1_DAY`, `7_DAY`). Generic attribution/conversion text is replaced
by the generated native settings. Provider finalization does not verify measurement setup or guarantee an atomic
account snapshot. See [qualification and limits](../records/DELIVERY-2026-10-02-SNAPCHAT-EVIDENCE.md).

For ad-squad evidence choose `snapchat_adsquad` and supply the exact `campaign_id` from Portfolio. The server
observes the campaign in this account's bounded native campaign collection, checks its exact ownership before/after
all stats pages, and retains every parent/account/page request, hash and time. This preset uses the campaign stats
route and native `AD_SQUAD` rows. English/Arabic forms require the parent only for this preset; other presets refuse
the unsupported filter. Comparisons require the same parent campaign. Collection membership is a positive ownership
observation, not complete inventory or an atomic snapshot. See [ad-squad qualification](../records/DELIVERY-2026-10-03-SNAPCHAT-SQUAD-EVIDENCE.md).

### Recovering encoded workbook definitions

Operations and original workbook runs can identify accounts retained in supported DV360/LinkedIn/X JSON
body fields without revealing body text. Current login/account access remains required on every page.
Known credential fields in legacy definitions and run previews are masked; the existing configuration
redaction flag identifies changed projections. Fresh unsafe definitions and queued collection are refused.
Stored originals retain their own bytes and revision. See
[operating limits](../operations/OPERATING-CONTROLS.md#encoded-native-reporting-definitions) and
[delivery evidence](../records/DELIVERY-2026-10-03-REPORT-BODY-SCOPE.md).

## Snapchat submitted native lead forms

In Reports, choose Snapchat campaign, ad squad or ad native lead submissions. Select the exact login/account,
native currency/IANA timezone and 1–31 closed account-local dates, then confirm the complete window. These
presets read aggregate native_leads submitted-form counts, exact spend micros, impressions and swipes. They
read no submitted person records. Purchase attribution controls are unavailable for this measurement definition.
Ad squads and ads require the exact owned campaign UUID from Portfolio. Current account/parent evidence and
every complete page retain source hashes; non-conversion finalization must cover the entire selected window.

For MCP, use capture_preset with snapchat_campaign_leads, snapchat_adsquad_leads or snapchat_ad_leads. Child
presets require campaign_id. Omit swipe/view attribution windows. Generated definitions replace caller text;
incompatible purchase and native-form evidence cannot reconcile. Missing counts stay unknown. Lead quality,
off-platform attribution and historical creative assignments are not established by this capture.

Inspect/search/page retained rows or download all rows with an explicit English/Arabic language. Parent-scoped
downloads include original campaign identity and retained parent/account/page hashes, without native request
bodies. Creative library linked-ad performance separately offers compatible retained purchase or native-form
snapshots for exact verified ad IDs; metric labels distinguish otherwise identical saved names. It makes no
provider call and rechecks current access. See [qualification](../records/DELIVERY-2026-10-04-SNAPCHAT-NATIVE-LEADS.md).

## Finding saved evidence

The saved-evidence view initially loads 30 source-linked metadata records. Search original report names, IDs, accounts
or presets, reset the query, or use **More saved evidence**. A page may contain no matching accessible reports while
still having further candidates; continue until the button disappears. Current access is rechecked on every page.
Expired or changed-scope continuation requires restarting the search. The open report remains inspectable while pages
load; comparison choices update without discarding a retained selected reference. Removed references clear obsolete
comparison results. Search makes no provider call and does not modify a saved report.

For MCP, use amcp_reporting list with limit (default 30, maximum 100), optional search and exact gateway/connection/preset
filters. Account filtering also requires gateway. Supply next_cursor under unchanged filters; nonzero offset is refused.
Continuations expire after 15 minutes and bind current identity/session/role and connection grants. Complete report rows,
native source definitions, analysis and exports remain available through the original report ID. See
[qualification](../records/DELIVERY-2026-10-04-EVIDENCE-INDEX.md).

### Choose retained evidence page length

Rows per page offers explicit 10/25/50/100 choices above the saved-row table, default 50. A change
returns to the first page of the active search under the original report/source. Native identity
columns form scoped row headers; hiding both never turns a metric into an identity. Search and
column choices remain local views, totals stay complete and Excel still includes every original row.
See [connected qualification](../records/DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md).

### Retain Google keyword performance by day

Choose **Google keyword performance** in detailed native evidence, bind the exact Google account/login
and declare its original currency/timezone/date/attribution settings. Only an explicit capture reads
positive Search keyword_view pages; native text, full resource identity and EXACT/PHRASE/BROAD stay literal.
Search can filter the original match type; full totals and every-row Excel remain the original report.
Only explicitly mapped keyword workbooks append the native match-type column. Attribution/completeness
remain declared, and keyword evidence does not qualify exclusions or budget changes. See [workflow and
qualification](../records/DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md).

### Readable saved-report controls

Retained row search, Rows per page, direct page choice and Excel language now use readable labels/type,
roomier fields and visible keyboard focus. Search/actions wrap into a phone layout; original values,
source identity, complete totals and every-row Excel remain. See [measurement and scope](../records/DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md).

### Recover from a refused Google evidence capture

A refused capture shows the reason, a recovery hint and its request reference in your interface
language. Check the reported issue and the selected account/date/currency/timezone settings, then
use **Read and retain evidence** again when appropriate. A failed collection saves no new report.
The form keeps its selected scope and settings; another read starts only after your explicit submit.
A successful capture retains original evidence, full totals and every-row Excel delivery. See
[scope and qualification](../records/DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md).

### Retain Google campaign performance by device

Choose **Google campaign device performance**, select the exact account/login and declare its
original currency/timezone/date/attribution settings. Explicit capture keeps campaign performance
by original device and account-local day; UNKNOWN and UNSPECIFIED remain original categories.
Missing categories do not prove zero activity. Search by device changes only displayed rows;
complete totals and every original Excel row remain. This report does not qualify device bids,
campaign budgets or exclusions. See [scope and qualification](../records/DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md).

### Retain Google campaign performance by original hour

Choose **Google campaign hourly performance**, select the exact account/login and declare its
original currency, timezone, dates, attribution and completeness. Explicit capture retains
the original reported hour 0–23 and date with full campaign identities; midnight remains hour
0. Missing hours do not prove zero activity. Search by hour changes the view; downloads include
every captured row and the original full totals. No UTC/DST conversion or schedule, bid, budget
or exclusion change is inferred. A failed capture saves nothing; review its reason/settings
and explicitly submit again. See [scope and qualification](../records/DELIVERY-2026-10-06-GOOGLE-HOUR-EVIDENCE.md).

### Keep a refused capture reason while reviewing settings

A current detailed-capture failure remains beside **Read and retain evidence**, with its reason,
recovery hint and original request reference. Review it and your settings before another explicit
submit. Editing settings clears that old message and retains the original completeness rules.
A reply from an older form/scope cannot paint a new error. See [scope and qualification](../records/DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md).

### Provider capture refusals

Guided Meta, LinkedIn, TikTok and Snapchat capture refusals now display authored English or Arabic
reason and recovery text through the current persistent capture feedback. Native API messages,
codes, identifiers, measurement settings and request references remain original. Feedback stays
until settings change or another explicit submit; edits do not automatically read the provider.
Unknown native diagnostics stay literal. A failed capture does not authorize a write or retry an
uncertain mutation. Exact-account refusal journeys are evaluated with fixed synthetic reads.
