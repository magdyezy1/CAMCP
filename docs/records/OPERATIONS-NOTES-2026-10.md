---
status: record
tier: operator
---

# Operations runbook notes of the October 2026 deliveries

A dated record (DOC-03): the feature and batch notes the [operations runbook](../OPERATIONS.md) collected from the October 2026 deliveries, from "Current primary-action value defaults" to its end, moved here on 2026-10-24 and kept as written. Each note's current behaviour is described in the [workflow guides](../PRODUCT-WORKFLOWS.md) and its delivery record.

## Current primary-action value defaults

For either recorded-value Search recipe, `amcp_campaign recipe_eligibility` with `live:true` also inspects
the same matching primary actions' current `value_settings`: `default_value`, `default_currency_code`
and `always_use_default_value`. These native optional fields are selected on both complete collection passes.
Explicit zero/false remain known; omitted/null fields are unknown. The original conversion currency is retained
without converting it to billing currency. Full matching collections and unknown primary flags control
`conversion_value_configuration` readiness, including rows beyond the twenty displayed actions.

The website's Current conversion value settings table shows the original fields and override behavior.
Configured defaults do not prove received values, history, provider/account eligibility or actual return.
Shared/manager conversion customers stay unknown. This check saves nothing, edits no settings and reads no
event/person records. Readers may inspect it while native write blockers remain active. Reinspect current
settings and independently verify delivery before separate activation. Local and conversion-count checks retain
their original contracts.

## Current primary-action activity dates

Value-recipe live eligibility selects two optional aggregate date metrics in separate complete repeated
conversion-action collections under the existing shared read budget. Exact original resource IDs join them
to current explicit primary actions; all current authority and brief checks remain. Null/empty/missing dates
and absent metric rows are unknown. Original account-local date/time strings are preserved; no UTC age,
recent volume or event-health threshold is inferred. No raw events, persons or mutations are read/submitted.
Keep these known-date observations separate from delivered values/history/eligibility and real acceptance.
See [scope and qualification](DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md).

## Original Google image reference reads

Google image asset_usage uses exact original receipt/SHA/account binding, explicit non-manager identity,
bracketed native asset/customer reads and two complete matching link collections. A selected 1–1000 limit,
24 attempts, 2100 rows, 4 MiB and 60 seconds bound work and retries. Overflow, continuation or inconsistent
counts refuse a partial inventory. Current actor/session/scopes/credentials/source metadata remain guarded.
This reader-compatible flow creates no snapshot or provider mutation and makes no all-format/history/delivery
claim. See [scope and qualification](DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md).

## Selected Performance Max image reference view

Google image asset_usage now accepts explicit reference_view performance_max; ad_images remains the default.
Each selected view independently uses original exact IMAGE/receipt/SHA/client/account identity, six bracketed
searches and two complete matching collections with the existing authority and 24-attempt/2100-row/4-MiB/60-second
limits. PMax projects exact group/campaign/image links and requires explicit PERFORMANCE_MAX mode. Enabled and
paused links remain configurations, removed links separate, missing roles/statuses unresolved. No mutation,
snapshot, all-format absence, serving or historical attribution is implied. See [evidence](DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md).

### Original Performance Max campaign logo references

Choose `reference_view:"performance_max_brand"` on `amcp_media {action:"asset_usage",asset_id,limit:50}` for the
original IMAGE receipt's bounded current campaign-logo view. Literal enabled brand guidelines and exact
Performance Max campaign/image identity are required. LOGO/LANDSCAPE_LOGO link configuration, removed and
unknown links remain distinct. Campaign links are not ads or asset groups. The default ad view and explicit
asset-group view remain independent. Google handoffs retain the original asset, chosen view and bounded
limit; the website waits for an explicit read and clears view choices when another asset is opened. No
write grant, serving/performance/history or all-format absence is established. See [qualification](DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md).

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
CSV fields. MCP handoffs preselect exact source IDs/price without an automatic read. See [qualification](DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md).

### Original Snapchat top-snap references

Use `amcp_media {action:"asset_usage",asset_id,reference_view:"snapchat_top_snap",limit:50}` on an
original image/video UUID receipt with uploaded SHA-256. Reader access, current Snapchat Marketing API
permission and the original account/login are required. Two complete bounded creative collections and
bracketed original account/media observations must match. Native pages have 50 rows; the selected
1–1,000 limit covers all examined creatives, with separate 1,000-row original-media searches and shared
84-attempt/4,102-row/8MiB/60-second limits. Fixed account-scoped GETs grant no standalone ownership or
write authority. Only literal `creative.top_snap_media_id` is inspected; other/nested media and history
remain outside this view. Creative packaging/review and media processing do not prove ad serving.
The bilingual table keeps exact UUIDs and separate statuses; changes clear old results, and qualified
MCP handoffs preserve the original asset/bound without an automatic read. See [qualification](DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md).

### Current owner-directed release checks

On 2026-10-04 the owner confirmed exhausted GitHub Actions minutes and directed proceeding without
hosted CI. Use [skip ci] in the authorized batch tip; do not retry hosted jobs or claim later-source
Linux/Docker qualification. Existing workflow checks remain available for funded runners. Fresh local
public release assembly, build/report generation and early freshness, full checks with configured
FFmpeg, Railway compatibility, unchanged tracked report bytes and maintained exact committed-source
proof remain required. Generate reports only from the sanitized candidate with a literal empty sample;
never read a private root sample or run the report script against it. Copy only validated public reports.
Keep provider/browser/deployed acceptance separate.

Native Meta catalog product read-back now covers all 35 accepted observable fields, including exact
integer inventory, ordered additional images and literal sale dates. An accepted receipt alone cannot
verify a missing field. Current field proof v2 retires partial caches before pending dependency
continuation; preserve original accepted receipts/keys and use read-only recovery. The existing
website CSV/WooCommerce supplied-product fields are unchanged; group keys do not qualify full
variant reconciliation, tax, live store sync or provider eligibility.

### Batch 149 — local rendered workflow checks

Narrow English/Arabic headers keep navigation clickable and wrap their actions. Long workflow actions
stay within their panels; decorative About/landing artwork stays within its own layer. Mobile navigation
keeps its visible Tab order until closed and restores its trigger after Escape or workspace search.
Owner-account and catalog comparison tables have named keyboard scroll regions/captions; privacy's
original skip target receives focus. Account grants, product selections and provider writes retain their
original controls. See [local browser setup and scope](../LOCAL-BROWSER-QA.md) and
[delivery evidence](DELIVERY-2026-10-04-RENDERED-WORKFLOWS.md). Hosted CI remains owner-paused;
continue exact local source/report/full gates with required FFmpeg. Full Arabic privacy, broader
populated states, assistive technology and live/deployed/provider acceptance remain separate.

### Batch 150 — product readability and source mapping blockers

Product labels in the selected commerce preview/source tables remain readable inside their named
keyboard-scroll regions. A source SKU/name with surrounding whitespace stays exactly as read and
cannot be selected for Meta; correct the original store value and explicitly reread it. The supplied
Meta preview applies the native destination's product-field validation before offering a plan.
No identifier is trimmed or invented, and products keep their separate ownership/read-back/write-review
requirements. See [delivery evidence](DELIVERY-2026-10-04-COMMERCE-READABILITY.md) and
[local browser checks](../LOCAL-BROWSER-QA.md). Broader inventory/variants and live acceptance remain separate.

### Batch 151 — complete privacy languages

The published privacy policy is fully readable in English/Arabic without login or JavaScript.
/privacy keeps English by default; /privacy?lang=en and /privacy?lang=ar select static versions.
Ordinary policy language links work without scripts, and the selected website language determines
website privacy-link destinations. The choice does not change workspace preference, consent or
provider permissions. English policy content, date, anchors and linked destinations remain.
See [qualification](DELIVERY-2026-10-04-ARABIC-PRIVACY.md). Structural/rendered checks do not
replace human legal/editorial or assistive/live/deployed acceptance.

Selected WooCommerce variation sources use the existing encrypted one-store wc/v3 Read connection.
Choose exact parent/child IDs; keys are never entered on Commerce. Six fixed GETs bracket currency
and repeat parent membership/child projections with current authorization, a shared 30-second deadline,
4 MiB and 102 collected-row bounds. Unsupported fields stay visible blockers. Exact reviewed titles
and parent-SKU Meta groups create only unapproved drafts; there is no automatic sync or deletion.
See [workflow and qualification](DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md). Owner-directed hosted CI skipping remains active.

Website Meta canonical and explicitly mapped supplier CSVs accept optional retailer_product_group_id
through the existing reviewed product field contract. No group is inferred, native strings are
preserved and blank optionals remain omitted. X refuses group intent. Column evidence binds the
selected account/login/gateway and is invalidated on scope changes; WooCommerce mode hides unrelated
CSV controls. Native group proof/cache/receipt behavior remains unchanged. See [qualification](DELIVERY-2026-10-04-META-GROUP-CSV.md).

Recent GA4 event tables now use authored captions and readable event-name columns in both languages,
with literal exact native count/stream display. The isolated browser qualification treats Google's
exact runRealtimeReport POST as a semantic read and refuses event senders/other provider actions.
No native contract, permissions, event delivery, retained snapshot or tracking-health claim changes.
See [scope and evidence](DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md).

Saved evidence now supports explicit 10/25/50/100-row local page bounds with current-view/source
validation, pending-control fences, scoped retry and first-page reset under the active search.
The original 151-row synthetic browser journey verifies an all-row same-language Excel download
from a one-row filtered view. No provider request, native mutation, report revision or retained binary
is added. See [scope and proof](DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md).

Google keyword/day evidence uses the existing v25 Search read with exact positive Search criterion/view
identity, native text/match type and bracketed account/page source hashes. Complete paging and every
current-authority checkpoint precede persistence. Guided keyword evidence is excluded from the original
negative-exclusion and campaign-budget plan predicates. Retained filters/downloads add no provider read;
old workbook headers remain. See [scope and local proof](DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md).

Saved evidence controls use scoped first-party styling with readable type, usable dimensions and
explicit selector focus. Native values, query/page bounds, pending/current-view guards and download
semantics remain. The original strict CSP is unchanged. See [local qualification](DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md).

Selected Google reporting failures and their recovery hints use authored English/Arabic display.
The original API messages, codes, request references and native details remain exact. Failed
collection is not retained; a retry is a separate explicit capture using current authority and
full original completeness guards. No automatic retry or provider write is added. See
[connected negative/recovery evidence](DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md).

## Campaign/device/day evidence qualification

The sixth Google preset uses the existing v25 Search read contract and bounded collector, with
exact two-field date/device grain and full campaign resources. Preserve literal native enums,
complete row-count/page evidence and both customer checks; missing categories are not zero proof.
Keep this grain separate from campaign allocation and exclusion workflows. See [scope and local
release evidence](DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md). Hosted Actions remains owner-skipped; current local checks
do not establish Linux/Docker, deployed Railway or native-provider acceptance.

## Persistent evidence capture feedback

Current guided failures retain the existing reason/remediation/reference in a form-linked alert;
the shared toast/formatter/native collector remain unchanged. Explicit edits or new submission
clear that current message and superseded replies stay silent. Capture transport errors do not
automatically prove that no report was saved; follow the displayed reason before another submit.
See [baseline and qualification](DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md); no automatic retry is introduced.

### Worker health under SQLite contention

A worker health observation is optional. A SQLite BUSY refusal defers that observation or
transient cleanup until the next existing worker cycle; no successful timestamp is invented.
Unreported or old health remains not observed or stale under the 90-second rule. Job claims,
lease renewal and result writes keep their original failure behavior. A blocked health update
cannot prevent independent lease renewal or discard a completed job. Other database errors
still surface. This does not establish deployed multi-worker capacity.

### Capture diagnostic language ownership

The locale gate requires direct authored refusal sentences only in the selected native capture
collectors, plus their exact reachable shared recovery hints. Snapchat shape checks are included.
Native errors/details and changed or conditional upstream text are preserved. Report refusal
retains its code, original wire message and request reference; displayed guidance does not change
mutation_retry_safe. Missing or foreign account evidence stops the original capture without
retaining a report. This coverage is separate from provider live acceptance and Arabic editorial
or assistive-technology acceptance.

### Measurement read diagnostics

The two GA4 measurement forms retain current refusal reason/hint/reference as a described alert
without discarding settings or automatically retrying. A form edit dismisses the diagnostic and
invalidates old evidence. Preserve the original request reference when investigating the scoped
audit trail. Correct the named input or provider-side registration separately, then explicitly
read again. Aggregate counts and identifier matches leave consent, deduplication and attribution
unverified. No event sender, snapshot or reviewed-write authority is added by this interface.
The selected Arabic inventory covers all 34 owned measurement/consent metadata refusals and
reachable recovery hints; unknown native messages retain their source text.

The measurement evidence ledger (MSR-03, owner direction P8) reads Google Ads, GA4, Meta pixels and datasets,
Snapchat and TikTok pixels, Search Console sites and Adjust apps read-only; no test event, Conversions API call or
validate request is sent ([product workflows](../PRODUCT-WORKFLOWS.md)). To withdraw an adapter without a release, set
`AMCP_MEASUREMENT_LEDGER_OFF` to a comma-separated list of gateways (for example `meta_native_action`) and restart;
the ledger then refuses that gateway with `MEASUREMENT_LEDGER_UNQUALIFIED` before any provider request and lists the
remaining ones. Meta Dataset Quality needs `ads_management`, or `ads_read` with `business_management`; a login
without either keeps that layer unknown. Snap asks for review before Signal Readiness data is displayed publicly, so it
stays on signed-in workspace pages. The TikTok adapter sends one more read per ledger, the selected pixel's event
statistics (`GET /v1.3/pixel/event/stats/`), exactly as TikTok's SDK specification of that request documents it. The
specification is pinned in `.mirror/VENDOR/tiktok-pixel-event-stats.json`: the SDK commit that file names, with its
API reference, read publicly on 2026-10-17; without a pin that layer is `unavailable` (`unpinned_request`)
and nothing is sent. To pin another commit, download
`yml_files/pixel_event_stats.yml` of `tiktok/tiktok-business-api-sdk` at a full commit (for example
`https://raw.githubusercontent.com/tiktok/tiktok-business-api-sdk/<commit>/yml_files/pixel_event_stats.yml`), run
`node tools/tiktok-event-stats-pin.mjs --source-file <file> --commit <commit>` (it refuses a file that does not document
the route, `advertiser_id`, `pixel_ids` and `date_range` with `start_date` and `end_date`; add `--date-format
YYYY-MM-DD` only when the file states that format), review and commit `.mirror/VENDOR/tiktok-pixel-event-stats.json`,
and release; `--check` re-verifies a downloaded copy against the committed pin. The read's fields stay unconfirmed
(activity `unknown`, `unconfirmed_fields`) until the owner runs one authorized read under ACC-06 on a designated pixel
and records which fields mean what and on which day basis; `AMCP_MEASUREMENT_LEDGER_OFF=tiktok_native_action`
withdraws the whole TikTok adapter.
