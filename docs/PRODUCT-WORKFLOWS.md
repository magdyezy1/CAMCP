# Connected product workflows

Implemented on `magdyezy1/CAMCP`, branch `Work-here`, on 1 October 2026. These website views call the same
first-party service operations as MCP. The [implementation record](review/IMPLEMENTATION-2026-10-01.md) records
qualification and remaining blueprint scope. Provider acceptance is account/action-specific and remains separate
from local implementation.

## Find and resume work

Home (`/dashboard`) links to new plans, recent plans, attention items, creative preparation, reports and account
readiness. The navigation has seven main destinations with expandable campaign, reporting, connection and
management tools. Exact plan, media review, report and evidence IDs are retained in internal links. Session expiry,
logout and workspace changes clear private drafts and invalidate pending responses. Ordinary navigation preserves
an unsaved report setup within the same identity; an explicit new report clears the old selection and destination.

`amcp_workspace {action:"capabilities", gateway?, workflow_id?, account_id?, connection_id?}` projects executable
campaign recipes, Overview adapters, detailed capture presets and media routes into workflow cards. Exact workflow
and account/login filters expose dependencies, lifecycle handoffs, native actions, registered review families and
their evidence paths. The recipe dependencies are tested against the compiled plans. Recorded scopes and current
local access are prerequisites; a dated successful account read is separate evidence, never objective acceptance.
Readiness expires after 15 minutes and is invalidated by connection/credential changes. `contracts` remains the
paginated, searchable action ledger. Neither view creates a grant or replaces native preflight/review.

## Campaign review and recovery

The Campaigns page starts with saved plans and a collapsible composer. The readable review preserves exact native
units and shows account, request and impact alongside expandable source JSON. Required spend, cap and creative-edit
acknowledgements come from the server and start unchecked. A confirm-mode cap can be acknowledged; a block-mode cap
stays blocked.

The page exposes whole-plan approval/run/continue, the execution journal, supported clone creation, amendment of
server-declared editable fields and comparison with observed native state. An observed-state acceptance sends the
exact current `actual_hash`. Uncertain writes retain their original receipts and are never automatically replayed.
Clone support remains the existing Google Search, Snapchat, TikTok and LinkedIn scope. Guided Meta website
purchases (`meta_website_sales`) and website leads (`meta_website_leads`) add explicit pixel, event and attribution
choices to the image workflow. Choose a 1- or 7-day click window and explicitly include or exclude 1-day views.
The campaign starts PAUSED; children are ACTIVE under it. Activation requires a separate reviewed change.
Pixel/Page access is checked during preflight. Event delivery, objective eligibility and landing-page acceptance
still need account-specific evidence. Regulated categories require a tailored native plan; these recipes refuse them.

Client playbooks (`/profiles`) provide naming/UTM fields, selected-account bindings, recipe defaults, revisioned
approval and an expansion preview. Advanced variables, conversion mappings and native templates remain JSON.
Preview resolves the same template function as campaign creation without provider calls. A nonempty binding list
limits both recipe choices and generated/native plan steps to those exact accounts and connections. An empty list
retains the previous behavior of allowing the actor's currently authorized choices. Profiles never grant access.

## Creative preparation and durable uploads

Creative (`/media`) starts with a searchable, paginated metadata library. Filter by platform, account/login, name or
tag; open an exact asset to inspect native IDs, source hashes, transformation dimensions and retained plan usage.
Names and tags are revision-protected internal annotations. Confirming an edit never renames the provider object.
Verified plan usage follows actual media/creative/ad references and retains original plan links; dependency order
alone does not prove usage. **Inspect linked ad performance** selects a retained guided Meta ad report from the
same account/login and shows daily rows for exact verified ad IDs in that plan. It preserves source dates, currency,
timezone, attribution, result definition, completeness and unknown values. It does not allocate results to an image
or prove which creative served throughout the reporting window. External usage remains unknown. Every page/detail checks
current account access; asset reuse still requires the original fresh provider-availability check.

Source upload, variants and destination preparation follow the library. **Save as resumable upload plan** retains up to 50 eligible matrix rows as media-only
campaign steps, preserving every target and original source hash. Saving does not upload. Review and execute the
saved plan through Campaigns; successful step receipts survive later target failures.

The immediate bulk flow continues to prepare and execute one destination at a time, respecting the existing
two-review staging quota. Saved source files still expire after 30 minutes; a durable plan is not permanent media
storage. Expired or unavailable originals are not resurrected by the metadata library. See
[media uploads](MEDIA-UPLOADS.md) for provider limits and safe resume behavior.

## Reports, evidence and delivery

Report library (`/report-library`) separates saved definitions, reusable account-free templates and retained
snapshots. Search finds definitions by client/name; snapshot history pages through older accessible results. A
snapshot link opens its retained results, and **Use this snapshot's setup** explicitly copies its original settings
into the builder. Changing the builder does not mutate the snapshot.

Every Overview collection has one durable allowance across accounts, periods, pages, retries and report downloads:

| Limit | Whole snapshot allowance |
|---|---:|
| Native HTTP requests | 1,200 |
| Normalized source rows | 25,000 |
| Active collection time | 300,000 ms |
| Response bytes | 128 MiB |

Counters are saved before egress and never reset by retry. Clean queue waiting is excluded; an interrupted process
conservatively charges elapsed wall time since its last active checkpoint. Between completed native periods, a
dispatch yields after 20 seconds so other queued work can run. This is not a per-request deadline shorter than the
remaining collection time and does not interrupt advertising mutations. A limit retains completed results and
explicit missing-source/period errors. Narrow the next run rather than retrying for a fresh allowance. Legacy
partially collected jobs without counters require a new run (`REPORT_RESTART_REQUIRED`).

TikTok integrated aggregation requires complete, consistent native page counts and stable totals, with unique
requested dimension tuples. Missing completion metadata, overlapping rows and malformed grain fail the source
before Overview retains metrics. Native page metadata is preserved; the outer pages/truncated fields describe
aggregation. Single-page raw reads and inventory lists retain their independent contracts.

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

| Action | Inputs / result |
|---|---|
| `capture_presets` | Available detailed native mappings and declared limits |
| `capture_preset` | `preset`, exact `connection_id`/`account_id`, and `semantics`; Meta also requires `result_action_type` and `attribution_windows` |
| `overview_sources` | `id` of a retained Overview snapshot; lists eligible semantic groups |
| `capture_overview` | Snapshot `id` and exact `group_id`; reuses retained evidence |
| `scenarios` | Evidence `id`, `options.budgets`, `efficiency_low`, `efficiency_high`; returns explicit sensitivity assumptions |
| `allocation_candidates` | Guided campaign evidence `id`; paginated campaign metadata with `offset`/`limit` and `next_offset` |
| `allocation` | Evidence `id`, explicit total period budget, campaign floors/caps, sensitivity factors, evidence age and minimum conversions; returns an inspectable proposal |

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
[Google evidence qualification](review/DELIVERY-2026-10-02-GOOGLE-EVIDENCE-INTEGRITY.md).

Meta presets are `meta_campaign`, `meta_adset` and `meta_ad`, each at entity × day grain. Supply currency, IANA
timezone, dates, source name and completeness. Select the exact native `result_action_type` (for example,
`offsite_conversion.fb_pixel_purchase`) and `attribution_windows`: one of `1d_click`/`7d_click`, optional `1d_view`,
or `1d_view` alone. Both click windows together are refused. The request explicitly uses impression time and
disables account/unified attribution overrides; the saved attribution/result definitions are derived from that query.
Account identity, currency and timezone are verified before and after complete Insights pages, including empty
reports. Each native row must match its account, exact parent chain, currency, dates and unique entity/day grain.
Changed credentials/scopes/access stop collection. Only bounded native cursors on the original account/query are
reused; continuation URLs and their credentials are never followed or copied. Empty intermediate pages continue
when another page is advertised. At most 100 pages/10,000 rows share the same request/time/byte bounds. Both account
checks and every page retain source references. Missing selected actions stay unknown; overlapping action aliases
are never added. Window completeness remains declared, and complete paging does not prove conversion delivery.
See the [Meta evidence qualification](review/DELIVERY-2026-10-02-META-EVIDENCE-INTEGRITY.md); SDK/native fixture evidence
does not certify live provider acceptance.

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

TikTok presets are `tiktok_campaign`, `tiktok_adgroup` and `tiktok_ad`, at native entity × advertiser-local
day grain. Declare exact advertiser/login, currency, IANA timezone, source name, attribution (or `unknown`),
dates and `complete:true`. Use 1–31 closed days. Currency/timezone are verified against advertiser metadata
before and after complete native report pages. Native `conversion` follows each entity optimization goal;
goals may differ, and attribution windows remain declarations. Smart+, GMV Max and specialized reports are
separate. The UI fixes only `conversion_definition:"conversion (optimization goal)"` and restores prior
declarations when changing providers. Exact decimal values and native IDs remain intact; missing metrics stay
unknown. No conversion value or reach is synthesized. Empty reports require explicit native zero counts.
Up to ten pages/10,000 rows are collected with strict page/count validation, duplicate checks and unchanged
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
See the [allocation qualification record](review/DELIVERY-2026-10-01-ALLOCATION.md).

Schedules (`/schedules`) lists existing delivery definitions with a read-only preview of the next three windows.
Pause/resume/delete, destination links and recovery use the existing schedule/export engine. Timing preview performs
no provider request and does not create another schedule. Failed Sheets delivery and successful source collection
remain separate states.

## Read-only monitoring

Monitoring inbox (`/monitors`) creates an explicit rule from a retained measurement context. The workspace inbox
is always the evidence destination. Each person may separately enable brief email notices to their own verified
account address; no advertising change is sent.

`amcp_workspace` actions: `monitors`, `monitor`, `save_monitor`, `set_monitor_state`, `incidents`, `incident`,
`acknowledge_incident`, `snooze_incident`, `resume_incident`, and `evaluate_monitors`.
Saving requires operator authority, current account access, `confirmed:true`, and a monitor
containing name, platform, connection_id, account_id, currency, timezone, result_definition, attribution, metric,
comparison, threshold and max_age_hours. Up to 100 rules are retained. Supported metrics are spend, clicks,
conversions and CPA; comparisons are above/below; evidence age is 1–168 hours. Changes use the current revision.

Finished Overview snapshots evaluate matching enabled rules under the rule author's current authority. Incidents
deduplicate by rule version, objective and measurement window. Acknowledgement persists while the threshold stays
breached; only newer, complete, comparable evidence resolves an incident. Stale, missing and incomplete data never
becomes a successful zero. Freshness uses the oldest contributing row capture, not the later job completion time.
The latest evaluation records unavailable data/access or ignored older evidence. The API pages at up to 100 results;
the website has independent incident/rule search, state filters and previous/next controls. Both list actions return
`next_offset`; incident states include open, acknowledged, snoozed, resolved and superseded. `incident`/`monitor`
read an exact ID. A reporting snapshot links directly to monitor creation with its original snapshot ID.

Snooze requires the current revision and `snooze_hours` (integer 1–168). It defers `attention_state` while preserving
factual state and ongoing evaluation. Resume clears the deferral; expiry restores prior attention on the next read.
Neither action resolves evidence. Rule edits preserve paused/active state and supersede older unresolved incidents
atomically, keeping their original rule and evidence. A superseded incident is not evidence of recovery.
Resolved/superseded records cannot be snoozed or resumed.

Open a monitor detail to inspect **Your email notices**, then explicitly enable them for that rule version.
Future openings, reopenings and resolutions send a generic notice and authenticated incident link; account names,
values and report contents stay in the inbox. Existing incidents are not backfilled. Rule revision requires another
opt-in; pausing, opt-out, revoked access, security/email changes or obsolete evidence stop pending delivery. Snoozing
defers pending attention; acknowledgement withholds it. A message already submitted cannot be recalled.

`monitor_notifications` takes monitor `id` and returns your subscription, `subscription_version` and 20 recent
deliveries. `set_monitor_notifications` takes that `id`, exact `subscription_version`, `enabled` and `confirmed:true`.
Viewers can manage their own notices; arbitrary recipients and administrator/test identities are not supported.
`retry_monitor_notification` takes `notification_id`, its displayed `notification_version` and `confirmed:true`.
Only failed transient delivery can be recovered: the same encrypted recipient/body/key is reused within the
original 24-hour expiry. Five automatic attempts are allowed; one recovery permits up to ten total. `sent` means
provider acceptance, not verified inbox delivery. Configuration needs the deployment's existing email sender/key,
master key, public origin and running worker. Notice metadata lasts 30 days; failed transport does not remove inbox
evidence. See the [delivery record](review/DELIVERY-2026-10-01-MONITOR-DELIVERY.md) for limits and lifecycle checks.

The existing owner-selected report retention period includes captured analysis reports and resolved/superseded history.
Current open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
evidence under the existing disconnect workflow.

## Portfolio, measurement and commerce

Live portfolio (`/portfolio`) supports Google Ads, Meta, LinkedIn, Snapchat, TikTok and X. Google campaigns, ad groups and ads use validated
signed keyset continuation bound to current actor/login/permissions, account, hierarchy, native version and page size,
with a five-minute expiry and 100-page limit. Exact customer, parent and resource identities are verified in the
account-scoped query. Duplicate, out-of-order, foreign, unsafe-integer and partial rows are refused. Each page is
limited to 100 visible entities plus one lookahead, 5 requests including retries, 60 seconds and 8 MiB. Only selected
native metadata is returned. Amounts remain exact micros; configured status is not evidence of serving. A missing
empty results array requires the exact requested native field mask and no contradictory count. This is current
inventory, not a point-in-time snapshot while a provider account changes.

Meta supports `amcp_workspace {action:"portfolio",gateway:"meta_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Use the returned IDs for `entity:"adset",campaign_id` and then
`entity:"ad",campaign_id,adset_id`. Read each parent with the same account/login first; these ownership observations
last five minutes. Each child call re-reads the native parent and checks every returned row's exact account and
hierarchy before exposing the page or recording child ownership. A current read never grants write authority.

Meta pages contain 1–100 rows, use the provider's order/default status visibility, and retain configured and
effective status separately. Missing amounts remain null; exact native integers are not divided by an assumed
currency scale. Cursors are signed and bind the tenant/user, account/login/authorization, entity, parents and page
size. They expire after five minutes and bound a chain to 100 pages. Requests reuse only the opaque `after` token,
never a provider-supplied next URL. Repeated cursors, duplicate/overlapping adjacent pages, malformed IDs/amounts,
oversized pages, incomplete envelopes and changed scope fail. A page is bounded to eight requests, 60 seconds and
8 MiB. This is current inventory, with no guarantee of complete historical statuses or consistency across pages.
Expired parent observations require refreshing the parent inventory; other provider adapters remain qualified
native workflows in Capabilities.

LinkedIn supports `amcp_workspace {action:"portfolio",gateway:"linkedin_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign_group"}}`. Read a group first, then `entity:"campaign",campaign_group_id`, then
`entity:"creative",campaign_group_id,campaign_id`. Qualified parent observations last five minutes and each child
re-reads its parents. Native account/group/campaign relationships must agree. Groups search all seven documented
statuses and include test/non-test entities. Follow the signed `next_cursor` with the same exact settings; it
expires after five minutes, binds the current login/actor/version and limits a chain to 100 pages. Each page is
bounded to 100 rows, eight requests, 60 seconds and 8 MiB. Repeated/unordered IDs and tokens or incomplete metadata
refuse the read. Empty inventory is valid. Decimal amounts keep their exact native currency; unknown timezone
stays unknown. Creative intended status, observed serving and hold reasons are separate. This is current inventory,
not a historical or point-in-time guarantee. MCP portfolio responses link to `/portfolio`.

The website uses Google ad groups, Meta ad sets and LinkedIn campaign groups/campaigns/creatives, provides parent/first-page navigation,
shows exact IDs and native states, and wraps controls at mobile widths. Account-selection changes clear previous
results immediately. Departed controls cannot initiate another read. Late responses/errors cannot repaint a newer account, route or identity. Wide tables have a
keyboard-focusable scroll region; returned headings receive focus.

Snapchat uses `gateway:"snapchat_native_action"`, exact UUID account/login bindings and `requirements:{entity:"campaign"}`.
Then select `entity:"adsquad",campaign_id`, and `entity:"ad",campaign_id,ad_squad_id`. Read qualified parent pages
first with the same login; observations and signed cursors expire after five minutes. Each child page rechecks the
full native parent chain. Limits are **50–100 rows** (the website uses 50), eight requests, 8 MiB and 60 seconds.
Only the validated opaque native cursor is reused; supplied URLs are never followed. Money stays in exact native
micros with current currency/timezone, and configured status stays separate from review status/delivery codes.
Created-at descending inventory uses provider default visibility and is not a point-in-time or deleted-entity
snapshot. [Snapchat qualification](review/DELIVERY-2026-10-02-SNAPCHAT-PORTFOLIO.md) documents the bounds.

TikTok supports the same portfolio action with `gateway:tiktok_native_action`, exact advertiser/login and
`requirements:{entity:campaign}`; follow with `entity:adgroup,campaign_id` and `entity:ad,campaign_id,adgroup_id`.
Standard v1.3 account-scoped lists use explicit non-deleted filters and exact native hierarchy checks. Current
account currency/timezone accompanies native amounts; JSON numbers and decimal strings keep their type and units.
Budget mode, operation status and secondary status remain separate. Five-minute signed cursors bind current
authority/hierarchy/page size and cap traversal at 100 pages. Changed counts and adjacent overlaps fail. Each page
has at most 100 entities, six requests including retries, 8 MiB and 60 seconds. Smart+, GMV Max and other specialized
route coverage is not implied. The page is not a point-in-time snapshot; live qualification remains separate.

X supports `gateway:x_ads_native_action` with `entity:campaign`, then `entity:line_item,campaign_id`,
then `entity:promoted_tweet,campaign_id,line_item_id`. Exact account routes, current account/parent reads and
response identities bind each page. Deleted/draft entities are excluded; post content, scheduled posts, promoted
accounts and media creatives are separate native workflows. Whole-micro amounts and original post IDs remain
exact. Configured/effective status, servability and approval remain independent and do not prove delivery.
Signed continuation binds current actor/login/permissions and hierarchy for five minutes, at most 100 pages;
repeated tokens and adjacent overlaps fail. Eight requests including retries, 103 parent/inventory rows, 8 MiB
and 60 seconds bound a page. Provider-order pagination is not a fixed snapshot.

Measurement (`/measurement`) connects the existing Google Tag Manager configuration audit with GA4/Search Console
reporting, client conversion mappings and reviewed contract discovery. `measurement_audit` takes an exact GTM
account/login and optional container/workspace requirements. It establishes configuration evidence; actual event
delivery, deduplication and business attribution remain unmeasured by that audit.

A workspace audit includes **Workspace consent settings**: filter additional-consent states, search native tag
names/IDs/types and page 50 rows at a time. Required literal consent types remain native; unsupported or variable
settings stay unknown. Omitted settings use the API default, while built-in checks, defaults/updates, runtime
order and event delivery stay unverified. This inventory does not classify legal compliance or publish changes.
The MCP audit handoff preselects only a current exact login/account/container/workspace on the website. Opening
it makes no provider request; select **Read configuration evidence** for a fresh audit.

Portfolio scope, catalog preview guidance and selected audit explanations are available in English/Arabic.
GTM findings show translated labels and severity beside the exact original code/path; observation limits are
displayed as a readable list. Dynamic findings use validated typed metadata for duplicate entity kinds, exact
trigger IDs and missing live/latest versions. Unknown messages or unsupported metadata keep the original text.
The expandable audit evidence retains the original messages and does not gain a live-tracking qualification.

Measurement also offers **Recent GA4 events**. Select an exact login/property, 1–20 case-sensitive event names,
a 1–30 minute window and optionally one stream ID. `measurement_events` takes the GA4 gateway, numeric property
`account_id`, `connection_id` and `requirements:{event_names,minutes?,stream_id?}`. Names support Unicode
letters/digits and underscores, starting with a letter, up to 40 characters; the default window is 30 minutes.
The response preserves count strings, null for absent events, native minute/stream rows, scope, times and source hash.
It performs a read-only realtime POST, bounded to 3 requests, 1,000 rows, 2 MiB and 30 seconds. Narrow the window,
events or stream if the complete table exceeds that bound. Changed scope or malformed/partial evidence is refused.
The website shows the same evidence in English/Arabic and clears it when inputs change. It never sends a test event,
polls automatically or saves a report snapshot. Positive counts establish reported aggregate activity only; missing
or zero counts may reflect delayed processing. Specific test identity, consent, deduplication, attribution and overall
tracking health remain unverified. The [delivery record](review/DELIVERY-2026-10-02-MEASUREMENT-EVENTS.md) explains qualification.

**LinkedIn conversion settings** reads current configuration for one selected login/advertising account.
Inspect native rule IDs, enabled state, type, attribution model, click/view windows and exact configured values.
Missing fields remain unknown. Search names/IDs/types locally and page 50 rows without another native request.
The MCP action is `measurement_conversions` with `gateway:linkedin_native_action`, exact `account_id` and
`connection_id`; it accepts no additional requirements. Its scoped website link only preselects the account.

Collection requires existing `r_ads` or `rw_ads`, verifies native account identity/currency before and after,
checks current authority around each read and retains source request/hash/time references. Bounds: 1,000 rules,
25 pages, 30 requests, 8 MiB and 60 seconds; partial, changed or foreign-account evidence is refused. No snapshot
is saved. Configured value is a rule setting, not spend or observed revenue. Campaign membership, event delivery,
deduplication, consent and historical report attribution remain unverified. Current settings do not establish
earlier reporting windows. No rule is changed or test event sent. See the [delivery record](review/DELIVERY-2026-10-02-LINKEDIN-CONVERSION-EVIDENCE.md).

Commerce (`/commerce`) validates a Meta product CSV before creating a reviewed plan. Fields: retailer_id, name,
price, currency, image_url; optional url, availability, condition, brand and description. Files are capped at 128 KiB
and 50 products, with unique stable retailer IDs and HTTPS media/product URLs. `catalog_preview` does no provider
egress; `catalog_plan` saves one native product step per item. Both require the exact Meta account/login/catalog ID
and an explicit `allow_upsert` boolean. Decimal prices become exact integer hundredths through the existing qualified
Meta product contract. Every item then gets the normal native ownership, before-state, review, receipt and
verification path. There is no implicit deletion and no direct write on import. WooCommerce synchronization,
destination fan-out and automatic feed deletion are not implemented.

For supplier or WooCommerce CSV exports, select **Map supplier or WooCommerce export columns** and load the file.
Choose source columns for the stable retailer ID, name, decimal price and image URL. Use either a currency column
or one explicit currency for all rows. Regular/sale price choice is explicit; sale dates, tax, stock and variants
are not interpreted. Select the first-URL image mode only when the source contains a comma-separated list.
All source rows are mapped, up to 50. Only selected fields are sent; inspect **Exact product fields sent for review**
before saving the draft. Changing a file clears its mapping, and changing any input invalidates its preview/save.
Header names must be unique/nonempty (1–100 columns, up to 200 characters each). Use UTF-8 CSV; a leading BOM is
accepted. This is a local export-import workflow, not a connection to a live store. See the
[mapping delivery record](review/DELIVERY-2026-10-02-CATALOG-MAPPING.md).

## Client report packs and recovery

`amcp_reporting_overview {action:"report_pack", id}` presents a finished retained snapshot with its separate summary
groups, coverage, source hash and authenticated raw CSV/evidence links. The website provides a styled preview,
script-free HTML, generated PDF and Excel downloads, and browser print preview. A confirmed presentation editor
saves a brand name, accent color, footer, standard/compact layout and explicit PDF/Excel language against the snapshot's current revision.
The edit changes presentation metadata, never source rows or native objects. It performs no recollection, FX
conversion or silent cross-account aggregation. Review visible client/account labels before sharing the file.
Unknown metrics stay unknown; ratio charts name their shared scale.

`save_presentation` requires `id`, `presentation_revision`, `presentation` and `confirmed:true`, operator authority
and current access to every source. The authenticated `.pdf`/`.xlsx` paths returned by `report_pack` recheck session,
source access and snapshot/presentation revisions after asynchronous generation. Files are generated in memory,
with no server-side download archive. PDF includes source evidence and its embedded Latin/Arabic font; unsupported
glyphs produce an explicit error. Excel includes five formatted sheets: Report, Account summaries, Campaign rows,
Source coverage and Evidence. Literal names stay strings, numeric metrics stay numbers, missing values stay blank,
and the workbook states that retained values do not recalculate when edited. Evidence JSON is chunked in order.
Choose **PDF and Excel language** independently of the interface language. The optional presentation field
`artifact_language` accepts `en` or `ar`; omitted legacy settings remain English without rewriting their stored
shape. Arabic Excel uses translated sheet/header labels, RTL sheet views and original built-in metric IDs beside
translated metric labels. Native row values, custom identifiers, numeric cells, missing values and source JSON stay
unchanged. Arabic PDFs use logical contextual shaping and Unicode direction ordering, preserve Latin IDs and dates,
and embed the original source evidence and logical marked text. Unsupported glyphs still fail explicitly.
This setting is available in snapshot presentation, approved client branding and local file destinations. A queued
file export keeps its original language through retries; later settings cannot replace a retained accepted file.
This does not certify PDF/UA accessibility or independent Arabic editorial acceptance.

Presentation metadata follows snapshot deletion/retention. See the
[download limits and evidence](review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

Clients & templates can also retain optional `report_presentation` inside an approved client profile, using the
same bounded brand/color/footer/layout fields. From a report pack, **Use approved client branding** lists compatible
approved profiles, previews their exact values and requires confirmation before replacing the snapshot's style.
Nonempty profile bindings must cover every report source's exact provider/account/login. Empty bindings mean no
profile-specific account restriction; current report access is always required.

`presentation_profiles {id,offset?,limit?}` projects only approved branding metadata, with pages of 1–100 and at
most 100 candidate profiles checked per request. Continue with `next_offset` even after an empty filtered page.
`apply_profile_presentation` requires `id`, `profile_id`, `profile_revision`, `presentation_revision` and
`confirmed:true`. It copies the current approved revision atomically into the snapshot, records `presentation_source`
and preserves existing source rows. Later profile edits or deletion leave that copy unchanged; manual
`save_presentation` clears the copied-profile provenance. The report title receives keyboard focus after saving,
and delayed responses cannot replace a newer route or signed-in identity. Scheduled local file destinations are
described below. See the [branding delivery record](review/DELIVERY-2026-10-01-PROFILE-BRANDING.md).

**Workbook setup** in Operations (`/operations?bindings=1`) lists saved local workbook associations. Search
by name/ID or an exact saved spreadsheet ID, follow pagination and open the original association to see linked
saved queries. These records do not prove current Google Sheets access, and workbook runs still store output
locally. Overview delivery destinations are separate. No stored URL or private preference is shown.

`amcp_workspace report_bindings` accepts `search`, `spreadsheet_id`, `offset` and `limit` (1–100), scanning at
most 50 records per call; follow `next_offset` even after an empty page. `report_binding {id}` returns a
`binding_version` and up to 100 query links, with the total and truncation flag. Current access to every linked
query is required; empty setup belongs to its creator or a workspace administrator. A viewer can inspect.

Review a local name with `preview_report_binding {id,binding_version,binding:{spreadsheet_name}}`, then explicitly
confirm `save_report_binding` with the same fields and `confirmed:true`. Names are single-line, 1–120 characters.
The transactional version includes the binding and all linked query revisions. Edits invalidate the website
preview and pending confirmation. This changes only AMCP's saved name: the spreadsheet ID, external name/access,
stored preferences, queries, schedules and existing runs are unchanged. No external permission or rename is implied.

To move a query to another existing association, open it and choose **Move saved query**. Search the accessible
workbook list, choose one destination and review both spreadsheet IDs plus schedule counts. Confirm the exact
move: all linked schedules move together and become paused; review/resume each separately when ready. The query
configuration and old runs stay unchanged, and one new report is prepared without submission.

MCP: call `preview_report_query_move {id,query_version,target_binding_id}` with the current query version.
Confirm `move_report_query` with the same fields, returned `rebinding_version` and `confirmed:true`. Refresh and
review again after any stale-version error; do not automatically resubmit an uncertain mutation. Current access
to every query in both associations is required. At most 100 linked schedules can move; the target supports
500 queries total.

After moving all queries and schedules away, its creator or a workspace administrator can review **Retire workbook
setup**. This preserves the original ID and private settings and hides it from active lists. Choose **Retired**
or **All** in the workbook-state filter to inspect it and review restoration. Until restored, the association
cannot receive queries or changes. Orphaned/paused schedules also prevent retirement; nothing is deleted.

MCP: `preview_report_binding_state {id,binding_version,active:false}` reviews retirement; use `active:true` for
restoration. `save_report_binding_state` adds `confirmed:true` to the same fields. State changes recheck current
creator/admin/operator authority, versions and absence of references. `report_bindings` defaults to `state:active`;
`state:retired` and `state:all` expose only currently authorized metadata.

Operations (`/operations`) uses `amcp_workspace operations` for paginated campaign plans, upload reviews, Overview
snapshots, export jobs, Overview schedules, incidents, workbook report runs (`kind:workbook_report`) and workbook
schedules (`kind:workbook_schedule`). Filter by
kind, attention category, name/ID and exact account/login.
Continue with `next_cursor` using the same identity and filters, including after an empty page with `has_more:true`.
The new feed projects only metadata and checks at most 500 candidates per call. It rechecks current engine ownership
and account grants on every page, and exposes only an original-object path and read-only next call. Updates may
move rows between pages; refresh for current state.

Activity (`/activity`) is the separate retained audit history. Search by event/action/request reference or filter
an exact account, then use Previous/Next. Empty pages may still have a continuation. Refresh starts a new window
including later events; page navigation keeps its original sequence ceiling. Ordinary members see current account
metadata and their own unscoped events. Owners see workspace metadata, including disconnected-login diagnostics.
Raw request bodies, receipts and arbitrary event fields are omitted for every role. Native diagnostic fields are
bounded and independently scoped. The underlying audit and hash chain are unchanged.

MCP `amcp_workspace history` accepts `limit` (1–100), `search`, `gateway`, `account_id`, `connection_id` and returned
`cursor`; keep the same identity/filters/page size for continuation. Each call scans up to 500 candidates and
returns up to 256 KiB of event JSON, with current authorization checked again. This is retained AMCP history,
not complete vendor history or a new integrity verification. Clients should inspect the original operation for
currently authorized payloads instead of depending on arbitrary legacy history fields.

Owner-only support bundle preview/export preserves the backend's sanitized projection. Backend error codes,
safe recovery advice and request references survive the website wrapper. First-party MCP envelopes add versioned
`meta.workflow` state, original `source_state`, exact internal path, permitted next call and required acknowledgements
when present. Native provider payloads cannot supply these links. `automatic_retry_of_mutation` is always false.
Monitoring adds `attention_required`, `deferred` and `complete` outcomes without replacing factual incident state.
The synthetic SDK journey tests measure calls and response bytes; external MCP client acceptance is separate.

Workbook runs open `/operations?run_id=<original-id>`. `amcp_workspace report_run` takes that `id` and returns a
bounded status, original query revision, current account/login, attempt count and retained-result availability.
Prepared runs need explicit execution and appear under Attention; queued runs already await a worker. Operators
can resume prepared, failed or cancelled runs after confirmation with the displayed `run_version` through
`resume_report_run`. A changed run requires refreshing; queued/running/completed work is not restarted. The worker
retains its current-creator and independent read-only checks. A rejected write query requires a corrected new query.
Rolling dates resolve at execution, so a resumed rolling run may collect a different date window.

The older `amcp_native_action get_reporting_run_status` now returns this metadata summary; use `get_reporting_run`
to retrieve retained input/results explicitly. Both reads and `execute_reporting_run` recheck the saved run's account
scope and current connection access, independent of later query edits. Native compiler account aliases in structured
argument bags are recognized and conflicting anchors are refused. Jobs whose scope exists only in opaque body
strings, resource paths or provider results remain unavailable until a new explicitly scoped query is prepared.
Unscoped historical runs are not assigned an account by guesswork. Full job inputs/results, encrypted actor bindings,
leases and raw errors are absent from status and the feed. Legacy workbook bindings still describe local storage;
this view does not establish a live Google Sheets destination. See the
[workbook Operations delivery record](review/DELIVERY-2026-10-01-WORKBOOK-OPERATIONS.md).

Workbook schedules open `/operations?workbook_schedule_id=<original-id>`, also reachable from Schedules.
Inspect the current saved query revision/account and the next three clock occurrences, then edit the name,
hourly/daily/weekly/monthly clock and explicit IANA timezone. The saved query still controls report date windows;
changing the clock timezone does not change the query timezone. Before confirmation, a server preview validates
the proposed fields and shows their changes and three future times. Pausing prevents future enqueues while existing
queued/running work retains its state and saved query. Resuming uses the operator's current access and the next future
occurrence, without creating a catch-up job. Monthly dates clamp to the last day of shorter months; nonexistent DST
times are skipped and repeated local times run once. Previewed times remain visible while paused and are labeled as
clock previews. A last-run link appears only when the user still has access to that original run.

`amcp_workspace report_schedule` returns bounded metadata and `schedule_version`. Send that version with `id`,
`active` and `schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?}` to `preview_report_schedule`.
The preview makes no changes. Save through `save_report_schedule` with the same fields and `confirmed:true`.
The server rechecks current scope, operator access, schedule revision and saved query revision transactionally.
`STALE_REPORT_SCHEDULE` requires refresh and another review. Readers can inspect but cannot save. This editor
keeps query identity and workbook binding intact and does not configure external spreadsheet delivery.
See the [workbook schedule delivery record](review/DELIVERY-2026-10-01-WORKBOOK-SCHEDULES.md).

Operations also lists **Saved workbook queries**, with search and continuation through authorized records.
Open a query directly at `/operations?query_id=<id>` or follow its original run/schedule link. Edit its name and
explicit dates, complete-day window or last complete calendar week/month. Rolling windows use the specified
report timezone, independently of the schedule clock. An advanced native read has a JSON editor; account/provider/
connection are fixed and credentials belong in Connections. Review the exact proposed settings and number of
schedules to pause, then confirm. A changed definition pauses active schedules for separate review/resume and
creates one prepared, unsubmitted report. Naming alone keeps schedules active. Existing runs remain unchanged.

`amcp_workspace report_queries` accepts search, account/connection/spreadsheet filters and offset/limit; follow
`next_offset` even if a page has no visible results. `report_query` returns `query_version`; use it with `id` and
`query:{name,query_config}` in `preview_report_query`, then `save_report_query` with `confirmed:true`. Query or linked
schedule changes invalidate the version and require refresh. The returned `prepared_run_id` links the original
unsubmitted report. Viewer access cannot save. The legacy setup bootstraps now require current query scope and
withhold oversized bodies; they do not establish a live Sheets destination. See the
[saved query delivery record](review/DELIVERY-2026-10-01-REPORTING-MANAGEMENT.md) for limits and qualification.

Client packs can also be delivered on the existing report schedule to a local **PDF / Excel destination**.
Create it in the delivery dialog with explicit formats, branding and storage confirmation; a Sheets connection is
optional for this flow. Schedules collect their original scoped definition and queue a separate file job from the
retained snapshot. Delivery status, history and Operations preserve the original export ID and job. Successful
formats survive a failed-format retry, and each download rechecks current source access. The job freezes its
branding and source fingerprint. Encrypted files follow snapshot deletion/retention, with 20 MiB per-file and
256 MiB encrypted-storage limits per workspace. Complete-only partial snapshots remain undelivered.
The [reporting guide](REPORTING-OVERVIEW.md#scheduled-pdf-and-excel-files) documents the shared MCP contract,
queue limits and recovery. External email, Drive-folder and object-storage file destinations are not implemented.

## Allocation proposals and native budget drafts

Google campaign allocation results offer **Prepare a native budget draft**. Explicitly choose equal-daily conversion,
read the current dedicated daily budgets and inspect the exact amounts, micros and rounding residuals. Confirmation
saves a source-bound, unapproved Campaigns plan. Average daily amounts continue until separately changed; the
reference period does not schedule an end date or guarantee a period spend. Shared/lifetime/foreign budgets and
changed source/ownership are refused. The original source and current native ownership are checked before unsent
proposal steps, while the existing native review, spend acknowledgement and read-back remain required.

MCP uses `preview_allocation_plan` with report `id`, allocation `options` and `conversion:"equal_daily"`, followed
by `create_allocation_plan` with the same `id`, exact `preview_id`/`preview_hash` and `confirmed:true`. Preview is
bound to the current session and lasts ten minutes. Follow its returned `amcp_campaign get` and website link to
inspect the original draft. Lost responses reuse the same plan. `amcp_campaign create` also supports optional
stable creation keys. See the [native budget-draft record](review/DELIVERY-2026-10-01-ALLOCATION-PLANS.md).

## Interface language

Choose **English** or **العربية (جزئي)** in the top bar, public navigation or sign-in screen. The choice is saved
in this browser. Arabic currently covers the public introduction, authentication and MFA, account/security/team
controls, Home, navigation and schedule-center labels. Connections, asset selection/write permissions, MCP setup
and consent, owner access review, health, spending and retention controls also have Arabic interface copy. The shell
uses right-to-left layout and the existing local Arabic font. Principal campaign, creative, reporting, operations,
client and account workflow controls also have Arabic copy, including selected authored explanations and typed
GTM findings. Remaining diagnostic copy and legacy dynamic reasons can still be English; provider/user text
keeps its original value. Full editorial, visual, keyboard and assistive-technology acceptance remains unfinished.
Existing legal agreements remain English and retain their original wording.

Switching language refreshes the current view. Changed inputs, visible recovery codes or one-time connector tokens require confirmation;
save them first. Saved records remain available. Account names, campaign names, identifiers, exact numeric strings,
native request fields and technical codes keep their original values. Dates use the chosen interface locale while
report/schedule timezones keep their own meaning. The fixed local catalog is requested only for Arabic; if it
cannot load, English remains usable. See the [foundation](review/DELIVERY-2026-10-01-ARABIC-FOUNDATION.md) and
[connection/control localization record](review/DELIVERY-2026-10-01-ARABIC-CONNECTIONS.md).

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
broader objective recipes, additional portfolio providers, broader creative performance lineage and calibrated optimization
retain unfinished scope in the implementation matrix. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.


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
a fresh preview; previews expire after ten minutes. See the [delivery record](review/DELIVERY-2026-10-02-SEARCH-EXCLUSION-PLANS.md).

MCP: `amcp_decision_report {action:"search_exclusion_candidates",id,options:{minimum_clicks,maximum_age_days},offset?,limit?}`;
follow `next_offset` and explicitly select native row IDs. Then call `preview_search_exclusions` with the same
report, options and `ids`. Use its exact `preview_id`/`preview_hash` with `create_search_exclusion_plan`,
report `id` and `confirmed:true`. Candidate reads support readers; preview/save require an operator/admin.


## Opening website pages

Each page loads the feature files it needs on first visit and reuses them when revisited. A loading status appears
while these files arrive. If a download fails, **Try again** retries that page. If startup took too long or could
only finish partially, **Reload page** starts a fresh document. Leaving the page or changing identity invalidates
its pending result. Loading page files itself does not change an account or perform a provider operation.


## Google Search with Maximize Clicks

Choose **Google Search with Maximize Clicks** in Campaigns, or `google_search_clicks` through `amcp_campaign`.
Supply an explicit **Campaign CPC ceiling in account currency** as decimal text, such as `"1.250001"`, together
with the Search brief. Keep manual bids, CPA/ROAS targets and other bidding strategies out of this recipe. Country
and language lookup, original copy, currency and the EU political-advertising declaration remain required.

Preview shows a dedicated budget and PAUSED campaign with Maximize Clicks; its children are enabled under the paused
campaign. Save creates an unapproved draft. Review and verify every step before separately approving activation.
Maximize Clicks seeks clicks using the budget and ceiling; it does not optimize conversions or guarantee delivery.
The existing manual-CPC Search recipe remains available when a fixed ad-group bid is the intended strategy.
