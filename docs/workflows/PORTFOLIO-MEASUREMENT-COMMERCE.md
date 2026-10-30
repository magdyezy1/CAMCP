---
status: reference
tier: operator
---

# Portfolio, measurement and commerce

The live portfolio, the measurement hub and catalog commerce: product sources, comparisons, imports and removals. Sections of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with their text unchanged on 2026-10-24 (DOC-03).

Live portfolio (`/portfolio`) supports Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising. Google campaigns, ad groups and ads use validated
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
snapshot. [Snapchat qualification](../records/DELIVERY-2026-10-02-SNAPCHAT-PORTFOLIO.md) documents the bounds.

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

Microsoft Advertising (RPT-07, B27) uses `gateway:microsoft_ads_native_action` with `entity:campaign`, then
`entity:ad_group,campaign_id`, then `entity:ad,campaign_id,ad_group_id` (the Google hierarchy, so the website
drill-down is the same). Microsoft does not page `GetCampaignsByAccountId`, `GetAdGroupsByCampaignId` or
`GetAdsByAdGroupId`, so each page reads the complete collection and serves an ascending native-ID slice: campaigns are
requested with every documented `CampaignType` (the API returns only Search campaigns by default) and ads with every
documented `AdType`. A collection above 1000 entities is refused with `PORTFOLIO_COLLECTION_LIMIT`, never truncated.
The signed five-minute cursor binds the actor, login, account, hierarchy, page size and the collection's content; a
collection that changes between pages is refused with `PORTFOLIO_CHANGED` so a reader restarts instead of merging two
states. Parents must be observed in the same login's portfolio first, and each child page re-reads its current parent
campaign (and ad group) by ID. Money (`DailyBudget`, `CpcBid`) stays unconverted decimal account currency; undocumented
campaign or ad types, repeated or malformed IDs and negative amounts refuse the page. `portfolio_reconcile` compares
two complete Microsoft observations like the other providers. There is no Microsoft guided evidence capture, so the
page offers no capture link.

### Google Ads change history

Below the inventory, **Google Ads change history** reads what changed in one selected Google Ads account (PRV-07).
Choose account-local dates: at most 30 days, starting no earlier than 29 days before today, because Google keeps
change events for 30 days. A wider or older window is refused in the page and again by the server, before any
request. One fixed `change_event` query (at most 1,000 events from the page, 10,000 over MCP, newest first) returns
the native resource type, operation, the tool used (`client_type`), changed field paths and the changed resource,
campaign, ad group or asset. Who made a change (`user_email`) is personal data and is never requested; old and new
values are not requested either. The page shows a timeline per day and counts by resource type, operation and tool
in English or Arabic; native values stay literal, and rows page 50 at a time without another read. A full read is
labelled: older changes in the window may exist. A response for another account, login or window, or with any
unselected field, is refused rather than shown. Nothing is saved. MCP: `amcp_workspace {action:"change_history",
gateway:"google_ads_native_action",account_id,connection_id?,requirements:{date_from,date_to,limit?,resource_types?}}`.

Measurement (`/measurement`) connects the existing Google Tag Manager configuration audit with GA4/Search Console
reporting, client conversion mappings and reviewed contract discovery. `measurement_audit` takes an exact GTM
account/login and optional container/workspace requirements. It establishes configuration evidence; actual event
delivery, deduplication and business attribution remain unmeasured by that audit.

**Inspect a sanitized event trace** is a separate browser-local task. Choose a
GA4 property and explicitly inspect version-1 synthetic scope, relative step
times, consent declarations and event observations. The editor rejects raw
URL/cookie/user-ID fields, original transaction identifiers, duplicate keys,
foreign property scope and invalid order. The table pages 25 steps and preserves
inherited or unknown consent state. Findings concern the supplied observations;
repeated purchase keys do not establish native double counting, and an event
under denied consent can be cookieless. The trace is never sent or retained;
Clear/navigation/identity changes discard it. Native/runtime consent,
deduplication and attribution remain unverified. See
[input shape and actual qualification](../records/DELIVERY-2026-10-07-TRACE-RECOVERY.md).

Version 1 stays accepted unchanged. **Trace version 2** (MSR-03) adds `scope.visitor_region` (a region code such as
`US-CA`, or null), an optional `region` list and `wait_for_update_ms` (0–60,000) on consent defaults, and
`transaction_id_empty:true` on a purchase. It applies the most specific default that matches the declared visitor
region and keeps types an earlier default set unless a later one declares them; without a declared visitor region a
regional default is reported as `default_region_unknown` and only agreeing values survive. Events inside a declared
wait are consent-unknown (`event_during_consent_wait`), and a default that follows an update of the same type is
`ordering_ambiguous` (the type becomes unknown), not a conflict, because the documentation does not establish which
applies. In both versions the hashed empty transaction ID (and `transaction_id_empty`) is flagged as
`empty_transaction_key`, since GA4 deduplicates every purchase whose transaction ID is empty. Declared storage writes
have their own columns, and the trace stream is compared with the property's synchronized data streams (listed,
not listed or not synchronized; a non-web stream notes that transaction-ID deduplication applies to web streams).
A pasted trace over 128 KiB reports its size, not invalid JSON.

**Convert a dataLayer export or HAR file in this browser** (MSR-03) fills the trace field with a version 2 trace.
The chosen file's size is checked before it is read (2 MiB for a dataLayer export, 16 MiB for a HAR file), and it is
read only in the page: nothing is uploaded, stored or sent, and no request is made. A dataLayer export keeps only
`gtag('consent','default'|'update',…)` commands with the four Google consent types (with `region` and
`wait_for_update` on defaults), event names from `gtag('event',…)` and pushed `{event}` entries and, for a purchase,
an HMAC-SHA-256 of its transaction ID under a random key generated in the page and never exported or stored (an empty
ID becomes `transaction_id_empty`). A HAR file keeps only the event names (`en`) of GA4 `/g/collect` requests whose
`tid` is the synchronized measurement ID of the chosen stream (every GA4 stream, with a notice, when it is not
synchronized); GA4 does not document `gcs`/`gcd`, so a HAR import derives no consent. URLs, cookies, user and client
IDs, raw transaction IDs and every other parameter are left out. Times follow the original order (real timing is
unknown), coverage is always `partial`, and a session longer than 1,000 steps or 128 KiB keeps its first steps with a
notice. The synthetic test identifier is generated locally and can be replaced.

A workspace audit includes **Workspace consent settings**: filter additional-consent states, search native tag
names/IDs/types and page 50 rows at a time. Required literal consent types remain native; unsupported or variable
settings stay unknown. Omitted settings use the API default, while built-in checks, defaults/updates, runtime
order and event delivery stay unverified. This inventory does not classify legal compliance or publish changes.
The MCP audit handoff preselects only a current exact login/account/container/workspace on the website. Opening
it makes no provider request; select **Read configuration evidence** for a fresh audit.

The audit also summarizes the **published (live) version** it already reads: `live_consent_evidence` lists each
live tag's additional-consent setting, and a workspace audit adds `consent_diff`, a per-tag **Published vs draft
consent** comparison (`same`, `differs`, `draft_only`, `live_only`, `unknown`). Both reuse the version read, so the
request count is unchanged. An oversized or unrecognized live tag list is reported `unavailable`; foreign or
duplicate tag identities still fail the audit. The comparison does not show which version a site serves.

Trigger references missing from the workspace inventory (often provider-managed built-in triggers) produce **one**
`UNRESOLVED_OR_SYSTEM_TRIGGER` finding per trigger ID, with `entity_count`, `tag_count` and up to 20
`sample_paths`; the code, message and localization keys are unchanged. `complete` means every read succeeded. The
list keeps at most 1,000 findings, errors and warnings first; `finding_list:"truncated"` (with `finding_count`)
reports a shortened list without marking the audit incomplete. The website pages findings 25 at a time with a
severity filter.

The consent draft offers the seven documented Google consent types (`ad_storage`, `analytics_storage`,
`ad_user_data`, `ad_personalization`, `functionality_storage`, `personalization_storage`, `security_storage`) as
checkboxes. Any other literal type, such as the typo `analytic_storage`, needs
`requirements.custom_types_acknowledged:true` (refused with `CONSENT_CUSTOM_TYPES_UNACKNOWLEDGED` before any read
otherwise). Acknowledged non-standard types are returned as `scope.custom_types` and labelled in the preview, the
draft brief and each review step description. The draft stays additive-only, literal-only and unpublished.

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
tracking health remain unverified. The [delivery record](../records/DELIVERY-2026-10-02-MEASUREMENT-EVENTS.md) explains qualification.

**Inspect a specific GA4 test identifier** uses an already registered event-scoped `amcp_test_id` custom dimension.
Choose an exact login/property, event name and original synthetic `amcp-test-` identifier. Enter explicit dates
covering at most seven property-calendar days, optionally a stream ID, and your declared expected count (1–1,000).
Generating an identifier is local and is useful only before your own separate instrumented test. AMCP does not
register the dimension or send a test event. Reading checks the dimension before/after a bounded exact-filtered
core report; source references remain inspectable. Counts remain exact strings and absent evidence stays null.
Above/below/matching counts compare only with your declaration. Higher counts are not proof of duplicate delivery,
and missing/zero counts can reflect processing lag or filters. Consent, deduplication and attribution remain
unverified. Original scope handoffs prefill without reading. Edits or generation clear prior evidence and pending
results cannot overwrite a newer selection. See the [qualification record](../records/DELIVERY-2026-10-03-MEASUREMENT-IDENTITY.md).

**Realtime test identity** (MSR-04) is the faster report source of the same task. Choose **Realtime: user scope, test
properties only** and a window of the last 1–30 minutes instead of dates. It reads a user-scoped
`customUser:amcp_test_id` through the GA4 Realtime API, which cannot filter event-scoped dimensions, and only on a
property the workspace owner marked as a test property (`amcp_workspace save_ga4_test_property`; otherwise
`MEASUREMENT_TEST_PROPERTY_REQUIRED` before any GA4 request). The user-scoped dimension is checked before and after.
Counts cover every event of the synthetic test user, so a match is user-level, not event-level proof, and realtime
processing can lag a few minutes. The value persists on the test user: use a fresh identifier and a dedicated test
browser or device for each test. The GA4 configuration read reports `checks.realtime_identity_dimension`.

**LinkedIn conversion settings** reads current configuration for one selected login/advertising account.
Inspect native rule IDs, registration method, reported ownership, enabled state, type, attribution model,
click/view windows and exact configured values. Missing fields remain unknown; provider defaults do not fill
missing observations. This finder requests the provider default owned-rule selection, without shared rules.
Its collection_request describes the request separately from each reported ownership value. Search native
names/IDs/types/methods/ownership locally and page 50 rows without another native request. Complete older
envelopes without new fields stay readable with unknown metadata. See the
[method, ownership and scope qualification](../records/DELIVERY-2026-10-05-LINKEDIN-CONVERSION-METADATA.md).
The MCP action is `measurement_conversions` with `gateway:linkedin_native_action`, exact `account_id` and
`connection_id`; it accepts no additional requirements. Its scoped website link only preselects the account.
The **Observed activity** column (MSR-04) shows LinkedIn's own `lastCallbackAt` (the last time a rule's URL match
fired) and `latestFirstPartyCallbackAt` as `last_callback_at` and `latest_first_party_callback_at` (epoch
milliseconds). LinkedIn may take about 20 minutes to update them. A missing time is Unknown, never "never fired",
and a time does not verify event delivery. The times stay out of conversion-rule write fingerprints.

Collection requires existing `r_ads` or `rw_ads`, verifies native account identity/currency before and after,
checks current authority around each read and retains source request/hash/time references. Bounds: 1,000 rules,
25 pages, 30 requests, 8 MiB and 60 seconds; partial, changed or foreign-account evidence is refused. No snapshot
is saved. Configured value is a rule setting, not spend or observed revenue. Campaign membership, event delivery,
deduplication, consent and historical report attribution remain unverified. Current settings do not establish
earlier reporting windows. No rule is changed or test event sent. See the [delivery record](../records/DELIVERY-2026-10-02-LINKEDIN-CONVERSION-EVIDENCE.md).

**Google Ads conversion goals** (MSR-02) reads one selected Google Ads customer's account-default conversion
goals, enabled primary conversion actions with their value settings, and the last conversion date and last tag
detection Google Ads reports. The MCP action is `measurement_google_goals` with
`gateway:google_ads_native_action`, exact `account_id`, `connection_id` and optional `requirements:{currency}`
(when omitted the observed account currency is reported). It reuses the recipe goal inspection unchanged in
scope: every collection is read twice and must match, within 64 requests, 4,000 rows, 2 MiB and 60 seconds.
Manager accounts and customers whose conversions are tracked by another customer are refused instead of guessed,
and an incomplete read is labelled incomplete with no partial ready status. A fence covering the actor, the
login's account access, its stored credential and the owner write pause wraps the whole read; any change refuses
the response. `provider_mutations` is 0 and nothing is saved. Configuration is not proof of delivery,
deduplication, consent or attribution. The scoped website link (`/measurement?google_goals=1&…`) only
preselects the account.

**Measurement scope** (MSR-02) is chosen once at the top of `/measurement`: a Tag Manager account, then a
container from the synchronized inventory (or one the audit discovered) and a workspace the audit discovered; a
GA4 property and one of its synchronized data streams; a Google Ads account and a LinkedIn account. Choosing fills
each task's own fields and clears their earlier results; it never starts a read. The scope is kept only in the
page URL (`ms_*` parameters); entries that no longer match an account selected for the current identity are
removed with a notice. Each task keeps its free-text fields as a fallback for stale inventory. A container-level
or account-level audit now lists the workspaces or containers it found with **Use this workspace/container**
buttons instead of only raw JSON. Every task with no eligible account shows how to connect one (with a
Connections link) and disables its read; a single eligible account is preselected, so **Load a synthetic example**
works without a prior choice and otherwise explains inline which property to choose.

**GA4 property configuration** (MSR-03) reads one property's key events, custom dimensions and metrics, data
streams (with type and web measurement ID), Google Ads links and data retention through fixed GET routes of the
pinned Admin API v1beta under the existing analytics read permission. The MCP action is `measurement_ga4_config`
with `gateway:ga4_native_action`, numeric property `account_id`, `connection_id` and optional
`requirements:{sections}`. Every list is read completely (ten pages per list; 60 requests, 4 MiB, 60 seconds); a row
of another property, an unknown enum, an unpinned field, a repeated page token or a duplicate resource refuses the
read, and the login, permission and actor are rechecked around each request. It reports whether an event-scoped
`amcp_test_id` dimension exists (the test-identifier task needs it) and how many web streams exist. Google Ads link
creator e-mail addresses are checked and never returned. The website relates each stream's measurement ID to the
Google tag IDs of synchronized Tag Manager containers without a request; discovery now keeps each data stream's type
and web measurement ID and each container's public ID and Google tag IDs. Nothing is saved; configuration is not
proof of delivery. The scoped website link (`/measurement?ga4_config=1&…`) only preselects the property.

**Measurement evidence ledger** (MSR-03) shows, for one asset, where the evidence stops, in six fixed layers:
configuration, provider-observed activity, provider diagnostics, supplied runtime trace, consent and attribution
settings. Each layer is `observed`, `unknown`, `unavailable` or `not_applicable` with a reason code. A layer is
observed only from complete evidence of the selected asset; a failed, partial, foreign or thresholded read leaves only
that layer unknown with its error code and never upgrades it (a provider's own refusal also keeps its allow-listed
facts, D21: `http_status`, `provider_code` and `request_id`, never its message). Owner direction P8 (2026-10-11) made Measurement the
multi-provider conversion-health hub, so the MCP action `measurement_ledger` takes `gateway`
(`google_ads_native_action`, `ga4_native_action`, `meta_native_action`, `snapchat_native_action`,
`tiktok_native_action`, `google_search_console_native_action` or `adjust_native_action`), exact `account_id` and
`connection_id`, and for the three pixel providers an optional `requirements:{pixel_id}`. Every adapter is read-only:
no test event, Conversions API call, `/events/validate` request or provider change is ever sent.

- **Google Ads** reuses the conversion goals read (configuration; last conversion date and tag detection as activity,
  observed only when every primary action reports both), then reads `offline_conversion_upload_client_summary`
  (diagnostics: client, status, event counts, success and pending rates, last upload and alerts; no upload is
  `not_applicable`) and the attribution model and lookback windows of enabled conversion actions. Enum values are
  checked against the pinned v25 document. A manager or shared-conversion customer leaves every Google Ads layer
  unknown and nothing else is read.
- **GA4** reuses the configuration read, then one 30-minute realtime count of the property's key events (no
  reported key event stays unknown; a property without key events is not applicable). GA4 offers no diagnostics API,
  and its attribution settings exist only in the unpinned Admin API alpha (`unavailable`).
- **Meta** lists the ad account's pixels (`GET act_{id}/adspixels`, bounded pages; configuration with each pixel's
  owner business and last fire time). That validated list is also the ownership evidence: for five minutes this
  connection may read only two aggregate routes of a listed pixel, `/{pixel}/stats` and
  `/dataset_quality?dataset_id=`, never the pixel node, its other edges or any write (`src/meta-dataset-scope.ts`).
  Activity is 24 hours of hourly stats summed per event (AdsPixelStats entries `value`, `count`, `event`,
  `diagnostics_hourly_last_timestamp`); diagnostics is the Dataset Quality API for web events (match quality out of
  10 and match-key coverage, Conversions API coverage, deduplication-key coverage, upload frequency, ACR). Meta's
  description texts are never kept. Dataset quality needs `ads_management`, or `ads_read` with `business_management`;
  without either it stays unknown (`quality_permission_missing`) and no request is sent. Advanced access tiers are
  tracked in ACC-05.
- **Snapchat** lists the ad account's pixels (a pixel of another account refuses the list), then the domains that
  fired the pixel in the last 7 days (`/v1/pixels/{id}/domains/stats`) and the Signal Readiness scores and
  recommendations (`/v1/pixels/{id}/event_quality_scores`; codes, priority, score and title, never descriptions).
  Snap intends Signal Readiness for internal monitoring and asks for review before any public display; AMCP shows it
  only to signed-in workspace members.
- **TikTok** lists the advertiser's pixels in bounded pages with ownership (owned, or shared/unbound), then reads the
  selected pixel's event statistics ("Get Pixel Event statistics", `GET /v1.3/pixel/event/stats/`) with the request
  TikTok's official Business API SDK specification documents (`advertiser_id`, `pixel_ids` and `date_range`
  `{start_date, end_date}`, JSON-encoded). The dates have no documented format: AMCP sends the last seven complete UTC
  days as `YYYY-MM-DD`, which is a guess, not TikTok's documented format. AMCP sends a provider request only as a pinned
  document states it, so this read follows the pinned specification (`yml_files/pixel_event_stats.yml` of
  `tiktok/tiktok-business-api-sdk` at the commit `.mirror/VENDOR/tiktok-pixel-event-stats.json` names, pinned on
  2026-10-17 with its SHA-256 and the request fields it documents; see [operations](../OPERATIONS.md)). Without a pin, or
  when the pin documents another method, path, field
  or date format than AMCP sends, activity is `unavailable` (`unpinned_request`; a differing pin is named with
  `evidence.problem`) and nothing is sent. With the pin, the evidence names the pinned file the request followed
  (`request_specification`). The specification leaves the answer's `data` unspecified and the portal page's response
  table is drawn by TikTok's scripts, so AMCP checks only the documented envelope (`code`, `message`, `request_id`,
  `data`) and safety: at most 200 values, 6 levels and 100 items an array, field names of letters, digits and `_`, no
  unsafe number, no text over 128 characters, and no `pixel_id`, `pixel_ids`, `pixel_code` or `advertiser_id` other than
  the selected ones (each refused whole: the layer is unknown with `read_failed`; a failed envelope keeps TikTok's
  `provider_code` and `request_id`, never its message). Otherwise every value is returned as TikTok sent it, by path
  (`stats[0].count` style), and activity stays `unknown` (`unconfirmed_fields`, `field_meanings: "unconfirmed"`,
  `day_basis: "unconfirmed"`): AMCP names no field's meaning and never reports TikTok activity as observed until an
  owner-run read under ACC-06 confirms the fields and their day basis. The website lists the first 20 values literally.
  TikTok exposes no event-quality diagnostics to these reads.
- **Search Console** reads the site and the login's permission level (an unverified user stops there:
  `site_unverified`), seven complete days of final web search totals grouped by date in Pacific time (no final data
  stays unknown; data lags several days) and the submitted sitemaps with errors, warnings and pending state. Wire
  values follow Google's public reference (camelCase such as `siteOwner`, `sitemap`, `byProperty`). It has no consent
  setting and attributes no conversions (`not_applicable`).
- **Adjust** reuses the qualified Report Service reads (app grant, shared source-IP permit, token fence, audit
  record): the app's event catalog and seven complete UTC days of installs and events. A report with warnings or
  missing totals stays unknown (`report_incomplete`). Adjust apps are bound administratively, so the website lists
  them only when the workspace shows them; the MCP action always covers them.
- Pixel selection: the ledger reads the requested pixel when the account lists it, otherwise the account's only pixel.
  Several pixels without a choice (`pixel_not_selected`) or an unlisted pixel (`pixel_not_listed`) leave activity and
  diagnostics unknown without a pixel read; an account without pixels is `not_applicable`. Attribution windows belong
  to ad sets, ad groups or reports, not pixels (`not_pixel_setting`).
- Supplied traces never reach AMCP (`unavailable`, see the trace task), and no advertising provider exposes a consent
  setting to these reads (the Tag Manager audit reports tag consent configuration).

A change of actor, login, account access or (for Google Ads) the owner write pause refuses the whole ledger. One
allowance bounds it (96 requests, 8,000 rows, 8 MiB, 150 seconds; each adapter's own collections 24 requests, 2,000
rows, 2 MiB, 60 seconds), and `network_requests` counts every request. Nothing is saved, `provider_mutations` is 0 and
delivery, deduplication, consent and attribution stay unverified. `AMCP_MEASUREMENT_LEDGER_OFF` (a comma-separated list
of gateways) withdraws an adapter without a release. The website task lists Google Ads accounts and GA4 properties
first (it follows the kind last chosen in the scope bar), then Meta, Snapchat, TikTok and Search Console accounts,
with an optional pixel or dataset ID field that is sent only for a pixel provider. It explains each reason in English
or Arabic, keeps native values literal, links each layer to the task that holds its detail and accepts
`/measurement?ledger=1&gateway=…&connection_id=…&account_id=…[&pixel_id=…]` handoffs without reading.

Native acceptance (ACC-06) remains: one authorized read-only ledger call per adapter on a designated asset, which
also confirms the AdsPixelStats entry shape and the Meta access tier.

Commerce (`/commerce`) validates explicitly supplied Meta or X product CSV before creating an unapproved plan. The following native hundredths and optional-field rules describe Meta; X requires all ten source fields, exact original price/currency strings and explicit upsert as described below. Fields: retailer_id, name,
price, currency, image_url; optional url, availability, condition, brand and description. Files are capped at 192 KiB
and 500 products (more than 50 are saved as one plan group, see
[large stores](#large-stores-saved-column-mappings-and-plan-lineage)), with unique stable retailer IDs and HTTPS
media/product URLs. `catalog_preview` does no provider
egress; `catalog_plan` saves one native product step per item. Both require the exact selected account/login/catalog ID
and an explicit `allow_upsert` boolean. Decimal prices become exact integer hundredths through the existing qualified
Meta product contract. The precision applies to the value, not the text: `12.500 KWD` is 1250 and `0.10` is 10, while
`12.345 KWD` is refused with that price and currency named, because Meta counts hundredths; nothing is rounded.
Every item then gets the normal native ownership, before-state, review, receipt and
verification path. There is no implicit deletion and no direct write on import. WooCommerce synchronization,
simultaneous destination fan-out and automatic feed deletion are not implemented.

The page opens with the reviewed import and says that product imports support Meta and X, while Snapchat catalogs
change only through feeds and their products are compared read-only (COM-02 D). With no Meta, X or Snapchat account
it links to Connections. WooCommerce store sources follow the
import; until a source is configured they sit in one collapsed "Connect a store source (administrators)" disclosure.

The native product review and verification require exact account/catalog/business identities and a complete,
bounded product page for the selected retailer. Malformed rows, foreign retailers, unfinished paging and coerced
IDs are refused. Price and sale-price proof must identify the same product as the original mutation receipt.
Read-back checks current account/catalog ownership again; incomplete proof cannot become a verified result or
permission to repeat the product mutation. See the [catalog evidence repair](../records/DELIVERY-2026-10-03-CATALOG-EVIDENCE.md).

For supplier or WooCommerce CSV exports, select **Map supplier or WooCommerce export columns** and load the file.
Choose source columns for the stable retailer ID, name, decimal price and image URL. Use either a currency column
or one explicit currency for all rows. Regular/sale price choice is explicit; sale dates, tax, stock and variants
are not interpreted. Select the first-URL image mode only when the source contains a comma-separated list.
All source rows are mapped, up to 500. Only the selected columns leave the browser: AMCP saves the mapping as this
account catalog's versioned column mapping and maps the rows on the server, so a later import of the same catalog
starts from the saved columns. Inspect **Exact product fields sent for review** before saving the draft. Changing a
file clears its mapping, and changing any input invalidates its preview/save.
Header names must be unique/nonempty (1–100 columns, up to 200 characters each). Use UTF-8 CSV; a leading BOM is
accepted. This is a local export-import workflow, not a connection to a live store. See the
[mapping delivery record](../records/DELIVERY-2026-10-02-CATALOG-MAPPING.md).

### Compare an import before saving its changes

In Commerce, select the Meta account/login and catalog, load a canonical or explicitly mapped supplier/WooCommerce
CSV, choose create-only or explicit upsert, then validate the source. The preview has one row per product with
exact decimal source prices and native hundredths. Compare current catalog products starts a bounded read of
only the supplied retailer IDs. New, changed, matching and unknown states stay separate; create-only blocks every
existing ID. Matching means only submitted fields have matching evidence. Unknown fields need native review.
For Meta, as for X, each row also names the native attributes the product holds a value for although the source does
not send them (`unsent_fields`: for example a sale price, staging visibility or zero inventory), because neither
provider says whether an update keeps or clears them; the summary counts such products
(`with_destination_only_values`). On Meta such a product is never shown as matching: when every supplied field
matches, it is unknown, says that the catalog holds values this import does not send, and is among the products
needing review (owner decision P9 of 2026-10-11; before P9 it stayed matching). On X the note changes no state. The
native review of an upsert repeats it as a warning.

Save only products needing review excludes matching/blocked rows and preserves each selected original source
product. Save all supplied products keeps the whole import; after a comparison it says how many already match. In an
X plan a product that still matches when the plan reaches it is recorded as unchanged (`skipped_unchanged`) and nothing
is sent; a matching Meta product is reviewed and sent again. Both save unapproved local drafts; neither submits
product changes. Execution still requires fresh native reviews, write authority and per-item read-back. Missing
source items are retained. Revalidate after editing the file, mappings, account or policy. Scoped MCP handoffs
(`/commerce?catalog_comparison=1&gateway=…&connection_id=…&account_id=…&catalog_id=…`) select only a currently
accessible account of that gateway and its catalog ID, and ask for the source CSV again, without an automatic read. A
link without `gateway` is a Meta comparison; a gateway that does not match the account selects nothing.
See [comparison qualification and limits](../records/DELIVERY-2026-10-03-CATALOG-COMPARISON.md).

## X source products and current comparison

In Commerce, choose an accessible X account/login/catalog and supply all ten source fields: retailer_id, name,
price, currency, image_url, url, availability, condition, brand and plain-text description. Map local supplier
columns explicitly or use AMCP columns; unsupported canonical headers require supplier mapping. Prices keep
exact original decimal text, with the qualified six-fraction native bound. Select explicit upsert because X
updates matching IDs. Preview then inspect source/native fields. Early-access entitlement is not established.

Compare current catalog products reads up to 1,000 listed products twice, shares those scans across supplied
SKUs and brackets current catalog ownership. New/changed/matching/unknown/blocked remain separate. Supported
prices compare exactly; grouped/unknown metadata prevents treating a potentially hidden variant as absent.
Only original supplied rows are returned, with qualified omitted-attribute names and explicit update uncertainty.
Save only products needing review excludes matching/blocked rows. Both subset/all saves remain unapproved local
drafts with no product mutation; native review applies the same group guards and fresh ownership independently.
Missing source items are retained. This is sequential current evidence, not complete variant reconciliation or
a point-in-time inventory. See [workflow and qualification](../records/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md).

### Preview explicitly selected X product removal

After current source comparison, choose the exact observed individual products intended for removal. The
unchecked per-SKU controls open a second preview of native keys, names and exact current prices. Changed
evidence requires comparing again. Save unapproved removal draft retains one original campaign plan without
deleting any product. Every selected key has a separate native review, confirmation, accepted receipt and
read-back; the review itself checks that the product it reads still matches the selected evidence, at prepare and
again at execute. A feed may restore products it still contains. Products outside the explicit selection stay retained;
missing/grouped/unknown records and deleting absent-source inventory are outside this workflow.
See [delivery](../records/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).

### Sale prices, retirement, variant groups and Snapchat comparisons

- **Sale prices (Meta and X).** Add optional `sale_price`, `sale_price_start_date` and `sale_price_end_date` columns (or
  map them). The sale is a decimal lower than the price in the product currency; the start and end are ISO 8601 times
  with an explicit offset, kept as written (X needs both or neither). The preview shows the native sale and the
  comparison checks it exactly. Without sale columns the destination keeps its current sale; the comparison names it as
  a note, and a product whose only differences are values your source does not send still counts as matching.
- **Retire instead of delete.** After an update comparison, tick **Retire** for existing products you stopped selling
  and save a retirement draft: each product is updated to "discontinued" or "out of stock", so ads stop showing it
  while the product stays. This is the only removal path for Meta, which has no product deletion.
- **X variant groups.** When a supplied product may be a hidden variant, the comparison names the grouped records that
  can hide it; add or change variants through the catalog's scheduled feed. After the owner qualifies X's group
  listing, AMCP reads the groups and new products outside them are no longer blocked.
- **Snapchat (read-only).** Choose a Snapchat ad account to compare supplied products with a Snapchat catalog. Exact
  prices and fields are compared twice; products that differ say **Fix this product in the product feed**, because
  Snapchat changes products only through feeds. Nothing is saved for Snapchat.

### Large stores, saved column mappings and plan lineage

- **More than 50 products.** A CSV of 51–500 products is validated part by part and shown as a plan group: how many
  products, how many plans of at most 50, and the first and last retailer ID of each part. **Save … products as …
  plans** saves one unapproved plan per part, and the page links to each. Approve and run each part separately; every
  product still gets its own native review and read-back. Compare at most 50 products at a time (a plan group is saved
  from its whole source), and a Snapchat comparison takes at most 50. Nothing is ever deleted because the file lacks a
  product.
- **Saved column mappings.** A supplier mapping is saved for the selected account and catalog, with a version.
  Loading the next file fills the saved columns and names the version and the retailer ID column. The retailer ID
  column decides which product each row is, so choosing another one needs **Identify products by another retailer ID
  column from now on**; without it the import is refused before anything is sent.
- **Where a plan came from.** Every catalog plan records its source (the file's hash, row count and mapping version)
  and, when it was saved after a comparison, that comparison. A part of a plan group says which part of which import
  it is. Open **Plan provenance and execution journal** on the plan to inspect it.

### Selected WooCommerce source products

Use `amcp_workspace {action:"catalog_sources"}` for local configured-store metadata, then
`catalog_source` with exact `commerce_native_action` account/connection and
`requirements:{product_ids:["101"],price_field:"price"}`. Choose 1–50 explicit published product IDs and
price, regular_price or sale_price. A one-account encrypted wc/v3 connection with a public HTTPS origin
and recorded Read/Read/Write key permission is required. Four bounded fixed GETs repeat supported
products and bracket native currency with current actor/origin/login/permission checks. Basic keys stay
in headers on fresh public-DNS-checked sockets; redirects, caller URLs, incomplete/changed selections
and sandbox routes are refused. No snapshots, writes or full inventory/variant/tax/acceptance claims
are added. The bilingual source table exposes blockers; explicitly selected eligible simple products
enter the existing Meta supplied-product preview/comparison/unapproved draft. X retains its ten explicit
CSV fields. MCP handoffs preselect exact source IDs/price without an automatic read. See [qualification](../records/DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md).

### Selected WooCommerce variations and explicit Meta groups

Choose **Selected variations of one parent**, enter one published variable parent ID and 1–50
exact published child IDs, then choose the native price field and explicitly read the source.
The API equivalent is catalog_source with requirements:{source_kind:"variations",
parent_product_id:"101",variation_ids:["102"],price_field:"price"}. Native child SKU/attributes/price
and parent SKU remain literal. WooCommerce has no native child name: review or enter the suggested
destination title, then explicitly check each eligible child. The shown parent SKU becomes its
reviewed Meta retailer_product_group_id; the preview displays that exact group. Title/selection/
source changes clear stale previews. Saving creates only an unapproved draft; native per-child
review and receipt/read-back remain required before execution. Six repeated/bracketed GETs enforce
current access, parent membership, complete selected evidence, one deadline and combined body bounds.
There is no automatic read, image ancestry/tax/full-inventory proof or missing-source deletion.
Meta CSV also accepts an explicit optional group; X retains its ten original fields. See [qualification](../records/DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md) and [CSV group mapping](../records/DELIVERY-2026-10-04-META-GROUP-CSV.md).

### Explicit Meta CSV product groups

Canonical Meta product CSV accepts optional retailer_product_group_id. Supplier mode exposes an
explicit **Meta product group ID** source-column choice; no parent-looking source column infers a
group and blank optional values are omitted. Original group/SKU/price/currency strings remain.
Choose the destination before loading mapped columns; changing account/login/destination clears
old mapping/preview evidence. X retains its ten fields and refuses Meta groups before submission.
Selected WooCommerce mode hides unrelated CSV layout controls; returning to CSV restores its choice.
Group previews/comparisons retain the existing unapproved-draft and per-product native review/receipt/
complete-field-proof path. See [workflow and qualification](../records/DELIVERY-2026-10-04-META-GROUP-CSV.md).

### Readable recent GA4 event evidence

The recent-event summary and minute/stream details have English/Arabic captions and readable event
columns. Original names, exact counts and stream IDs stay literal with explicit LTR isolation.
No count returned remains unknown; editing scope clears old evidence and only an explicit request
reads the native aggregate report. Existing tracking-health/runtime-consent limits remain visible.
See [measured qualification](../records/DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md).

### Inspect other listed X products without inferring source absence

After validating your supplied products for X, choose **Inspect other listed X products**.
The result shows listed products outside that source selection, original price strings, IDs
and group information. Search and page through this already collected view without another
provider read. Other listed products stay retained unless you select them: tick individual
listed products (none is selected for you; grouped and unknown products cannot be ticked), choose
**Preview removal of selected listed products**, check the native keys and current prices, and
type the number of products to save an unapproved removal draft. A listing that changed since
the inspection needs a new inspection. Each removal still has its own native review, the owner's
deletion policy and read-back; nothing is selected because your source lacks it.
X listings may hide variants, and your supplied selection does not establish full-store
absence. Changed native observations require a new explicit read. A current failure stays
visible with its request reference; editing the form clears old evidence and suppresses late
responses. Ordinary saved drafts still contain only the supplied products. See
[scope and checks](../records/DELIVERY-2026-10-06-X-CATALOG-SELECTION-INVENTORY.md).

### Recovering a GA4 measurement read

Recent GA4 events and the exact synthetic test-identifier inspection now keep the current
refusal reason, recovery hint and reference beside the submit button in either interface language.
The message remains until you edit the form or explicitly read again; your selected scope and
settings survive. Editing invalidates the earlier observation and feedback without starting a
provider read. A response from an obsolete selection stays silent. An explicit second read uses
the current settings and retains exact native counts, unknown observations and property-calendar
boundaries. AMCP sends no test event, stores no snapshot and does not infer consent, deduplication
or attribution from these aggregates. See [measurement feedback delivery](../records/DELIVERY-2026-10-05-MEASUREMENT-READ-FEEDBACK.md).

### Moving between measurement inspections

Use Choose a measurement task to reach the original GTM audit, recent GA4 counts, exact synthetic
GA4 test-identifier inspection or LinkedIn conversion settings. The heading receives keyboard focus;
Back to measurement tasks returns to the choices. Ordinary section jumps keep your entries,
current results, local result search, original URL/history and any pending original read. They do
not submit a form. Read evidence only with that form's original submit button.

Open Related measurement workflows for reporting context, approved client conversion mappings and
exact capability discovery. Exact section fragments can focus a named inspection while keeping
the original current-account handoff query; an unknown fragment does not select a task. The normal
account/test/audit scope validation and read-only evidence boundaries still apply.
See [navigation evidence and limits](../records/DELIVERY-2026-10-05-MEASUREMENT-NAVIGATION.md).
