---
status: reference
tier: operator
---

# Accounts, reporting and operating controls

Operating notes on accounts, reporting, provider access, website loading, owner timings and oversight, catalogs and verifying the committed release source. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

See [account setup](../USER-ACCOUNTS.md), [Reporting Overview](../REPORTING-OVERVIEW.md) and [implementation/acceptance notes](../archive/RECOMMENDATIONS-IMPLEMENTED.md) for owner migration, team access, MFA, custom metrics, scheduled Sheets exports, campaign preflight/recovery, spending policies, asynchronous media and encrypted backups.

### Workbook records withheld from Operations

The Operations feed shows a workbook report run or schedule only when its retained account and connection scope can
be established; others are withheld from everyone. Owner health (`withheld_workbook_records`, and the Background
work panel on the settings page) counts them by reason: `scope_unavailable` (path-only or opaque bodies, conflicting
anchors), `connection_unavailable` (the connection or account is no longer selected), `metadata_unreadable` and
`scope_check_failed` (the scope check of one record failed unexpectedly; it is counted, never fatal to the view). It
scans at most 5,000 of each and reports `truncated`, and it never lists IDs, names or bodies. A zero count in
production closes the path-only and opaque-format adapter question for B13 ([package status](../review/PACKAGE-STATUS.md)).

### Legacy Google action names

Owner health (`google_legacy_aliases`) counts, over the last 30 days of the workspace's audit, the Google Ads requests
planned under one of the legacy alias names instead of a canonical action: `google_requests`, `legacy_requests`,
`legacy_share` and the ten most used names (MCP-10, owner question Q23). Each request counts once; it reads at most
50,000 audit rows and reports `complete: false` when the window holds more. Nothing is hidden
yet: record the 30-day baseline, then decide whether to hide the aliases from default listings (their refusals would
name the canonical next call).

### Provider access

Owner health (`provider_access`, and the Provider access panel at the end of the settings page's Health group) shows,
for each provider this workspace has connected (ACC-05): the owner's declarations from the
[provider access register](../PROVIDER-ACCESS.md) with their dates, marked stale after 90 days; the logins' last
successful sync and last sync refusal code; the latest unexpired observation of each live program check
(`program:linkedin_forecast`, `program:linkedin_audience_insights`, `program:dv360_advertiser`); the programs listed for
discovery only; and the provider acceptance ledger's counts. It is computed from stored state only, never from a
provider request, and shows no token, account ID or login name. A declaration grants nothing.

To declare an approval, edit `src/provider-access.json` (status, a short value such as `Standard`, and the day of the
declaration), run `npm run build` and `node tools/acceptance/provider-access.mjs`, and deploy. Live acceptance results
reach the ledger only through the acceptance harnesses ([acceptance runbooks](../acceptance/README.md)).

### Website feature loading

The initial document contains eight shared scripts. Each page's lazily loaded feature scripts are its `assets` in the
route registry (`web/routes.js`); `web/route-assets.js` holds the fixed same-origin file order and dependencies, and
`tools/check-routes.mjs` refuses an asset the loader does not list or a file that does not ship. A page's files are
requested together; no script captures another's globals while it initializes (WEB-07): a feature extends the shell
through `AMCP.routes.register` (a page body), `AMCP.routes.extend(path, part, {order})` (a part after the page, in its
declared order whatever order the files finish loading in) and `AMCP.hooks.beforeRender`/`afterRender`, never by
reassigning a shell function. `tools/check-extensions.mjs` (part of `check-web`) refuses a top-level reassignment of a
declared function and a second declaration of one in the same document. Navigation awaits all required scripts before
rendering. Download errors retry only failed files; uncertain evaluation/timeouts require full reload, since removing
a script cannot establish that it never evaluated. Existing authorization applies after loading. No account data is
stored in the loader.

Pages load their own code (WEB-07). Live portfolio, Measurement and Commerce are one module each (`portfolio.js`,
`measurement.js`, `commerce.js`) over a small shared helper (`account-workflows.js`: AMCP's account-read explanations,
the account picker and the preview guard), and each registers its page body; they had shared one 388 KB script that
also loaded the campaign review code. The parked WooCommerce store source is a module of its own behind Commerce
(`commerce-woocommerce.js`, moved unchanged; a future store source gets its own the same way). Creative,
Capabilities, Evidence & analysis and the report pack load the paged-list loader (`work-pages.js`) instead of the
Operations center and its three workbook controllers. The report builder's script (`reporting-overview.js`) loads
with `/reporting-overview` and with the report modules that use its state and labels, no longer with every page; its
own page code runs only on that page, whose route lists the other report modules. The helpers the shell and many
modules share (`overviewCall`, `pretty`, `renderSourceDiagnostic`) are in `workspace.js`.

The Arabic catalog travels in chunks. `web/locales/ar.json` stays the authored catalog (`check-locales` bounds it at
2.25 MiB, 2,359,296 bytes, and the deployed byte comparison of `tools/check-public-website.mjs` reads the same constant; the file measures
2,134,830 bytes after the M4a merge); `node tools/locale-chunks.mjs --write` generates `web/locales/ar/`: `shell` (the shell scripts, the public
pages and the website server's messages; every page), `workspace` (what `src/` and the provider contracts say; every
signed-in page), `providers` and one chunk per feature script, a message going to the first chunk whose sources write
it. `providers` holds refusal sentences only (those the backend writes solely as the message of a call that throws) and
no page waits for it (R25 ar-lazy): an Arabic answer carrying a sentence not yet loaded fetches it first, a signed-in
page fetches it when idle after rendering, and a failed load shows one fixed Arabic sentence with **Try again**.
`check-web` refuses a stale or stray chunk, a chunk over 1 MiB (the browser's bound per chunk) and a script whose chunks
lack a message it requires; no script may rely on `providers`, which `web/route-assets.js` names lazy. It is 693,176
bytes (66% of that bound) and grows with the provider families; it is to be split per family before it reaches about
90% (package status B24).
`web/locales/ar.json` itself stays in the public snapshot although no page requests it any more:
`tools/check-public-website.mjs` compares the deployed catalog's bytes with the authored one, and it leaves the
snapshot once that comparison reads the chunks. A page requests its chunks together with its scripts; a chunk that
cannot be downloaded offers **Try again** like a script, and a deploy offers the reload. A language chosen later loads
every chunk the page has needed. The workspace asks `/api/session` while the shell chunk downloads (it used to wait
for the catalog) and starts the first page's scripts and chunks as soon as the session says this person may open that
page, while the shell chunk and the platforms load; a signed-out visitor, or a test account outside the page's scope,
downloads none of them. The chunk loading a page needs beyond the shell chunk is part of the workspace's page loader
(`web/route-assets.js`), so About and the policy pages do not download it. A versioned chunk address may be answered
from the browser cache; an unversioned one is revalidated.

Each page binds every file it uses to one public snapshot (`/assets/v/<version>/…`): HTML `src`/`href`, stylesheet
`url()` references (fonts, images) and the addresses scripts build through `AMCPAssets.url`. A deploy that changes
`web/` replaces the snapshot, and the server answers `409 ASSET_VERSION_CHANGED` for the old one. When a feature
script or an Arabic catalog chunk then fails, the page sends one `HEAD` probe (5-second bound); a 409 shows "AMCP was
updated" with **Reload page** instead of "Try again", and a reload with unsaved edits on the page asks first. Unversioned
`/assets/…` paths (legacy links only) stay `no-cache` and are compressed off the event loop at Brotli quality 5.

Run `node tools/benchmark-web-assets.mjs` from the repository for exact file hashes and raw/gzip/Brotli bytes per
route. This excludes CSS/fonts/locale JSON/headers and is not a browser timing test. The normal regression suite
covers the manifest, cold English/Arabic source initialization and HTTP revalidation. See
[qualification and limits](../records/DELIVERY-2026-10-02-ROUTE-ASSETS.md) before making performance claims.

`node tools/web-route-bytes.mjs` adds the stylesheets and the Arabic chunks: the Brotli (quality 5) bytes each page
downloads before it renders, per language (a stylesheet inside `<noscript>` is not counted), against
`tools/web-route-bytes-baseline.json`, recorded on the merged Work-here tree before WEB-07 (36742651, which already
held the other wave 3b packages' additions). `check-web` refuses a page above its recorded value unless the baseline
lists it under `open`: an acceptance gap WEB-07 has not closed (not an accepted exception), with the value it may not
exceed while open and the reason. An open page fails above that value and fails once it is back at or below its
baseline, so the list only shrinks; `--write --label <why>` records a new baseline from a tree and keeps each open
page's target. On 2026-10-17 every Arabic page was 11–85% below it (the public pages 69%, About 85%); in English the
public and sign-in pages were 15.4% below, Live portfolio 43.8%, Commerce 35.5%, Capabilities 25.0%, Measurement
23.7%, Creative 20.6% and most other pages 11–14%; Home, Schedules, Report library and Report builder 37 bytes below.
Those four were 2,750 bytes above until the shell lost most of the commentary WEB-07 had added to it (about 3.5 KB of
compressed comments every page downloaded), the workspace-only chunk loading moved into `route-assets.js`, and the
policy pages' shades and the no-JavaScript dark block moved into `public-tokens.css`, which the workspace never
downloads. English About was the last open gap (16,868 bytes against 15,848): it downloaded `theme.css`, the
workspace's dark override layer, although `about.css` took its colours from tokens. About no longer loads it
(`about.css` carries the Appearance control's rules), so it downloaded 15,111 bytes then (4.7% below) and renders the
same in dark mode with and without JavaScript; no page is open. Moving every component colour into tokens (2026-10-18,
docs/AMCP-IDENTITY.md) grew `tokens.css` from 1,000 to 1,642 bytes (its comments shortened) and shrank the
workspace's other stylesheets by 1,619 (the declarations a later rule always overrides left first): Home, Schedules,
Report library and Report builder were 1,014 bytes below their baseline and English About 146 (0.9%, 15,702 bytes)
below, every Arabic page 10.9–85% below. The measurement task links' hover and focus fix (wave 4a review) added 22
bytes to the workspace pages, which are 992 bytes below. `tests/web-route-bytes.test.mjs` checks the same and keeps the split's gains, each with a
wide margin.

`npm run build && node tools/benchmark-web-first-render.mjs --output-dir .runtime/<fresh-directory>` times the first
content render (the page's own heading in the chosen language, no loading placeholder) on the synthetic fixture under
a throttled profile (150 ms round trips, 1.6 Mbit/s down, 4× slower CPU), with the bytes each page transferred; it
needs the browser QA variables, and `--web <directory>` serves an exported tree, so a baseline is measured in the same
session. Measured on 2026-10-17 (median of three) against Work-here: Arabic first render 15–45% sooner on every page
measured (the landing page 4,838 → 2,683 ms, About 3,035 → 1,716 ms, Home 5,152 → 4,199 ms, Report builder 5,505 →
4,662 ms); English 3–29% sooner (About unchanged at 470 ms, Home 2,381 → 2,066 ms). With every component colour from
tokens (2026-10-18, both trees served from exports in one session, median of three) each page measured rendered as
soon as or sooner than on Work-here: English About 456 → 453 ms, Arabic About 1,718 → 1,217 ms, Home 2,256 → 2,223 ms
in English and 4,697 → 4,653 ms in Arabic, Report builder 2,585 → 2,554 ms in English. A timing describes that
machine and profile only.

### Owner tool timings

Settings and `amcp_workspace {action:"health"}` expose bounded workspace timings to existing owners/administrators;
the sanitized support bundle includes the same projection. Eight fixed groups aggregate completed tool attempts
within the current fixed 15-minute UTC interval. Only counts, elapsed-time aggregates and bounded percentile
buckets are retained, in at most eight records per workspace. No inputs, accounts, actors, URLs or error text
are stored in those counters.

Timings cover handler execution before counter storage/response delivery, excluding HTTP queueing, response
serialization and client network delivery. Internal calls/ownership refreshes are separate attempts; native
HTTP counts remain separate. Current in-flight attempts are excluded. Success/error means envelope status,
not business success. Median/p95 are approximate bucket bounds, not exact latencies. Unknown is distinct
from measured zero; saturation, omissions, invalid counters and clock resets are explicit.

Timing-storage failure preserves the original tool result and never retries a provider. The failure total is
process-local and resets on restart. Old idle interval data is omitted; there is no historical timing series.
These counters do not certify service-level objectives or tenant capacity. See
[qualification and measurement limits](../records/DELIVERY-2026-10-03-TOOL-TIMINGS.md).

### Owner review oversight

The same health view reads two 30-day summaries back from the audit: `cap_overrides`, the reviewed executions that
went beyond a spending cap with `cap_override_confirmed` (count, then the latest 20 with account, rules, actor, role
and review id; since owner decision P5 each is the owner's own execution or one the owner approved on the website),
and `review_friction`, prepare-to-execute latency and the rates of expired reviews, changed state,
acknowledgement refusals, uncertain outcomes and requests not sent per 100 prepares (codes, counts and field paths,
never values). Its `approvals` block (WRT-09) counts approvals given on the website, those by the owner, the time from
prepare to approval and the refusals that waited for a person (`HUMAN_APPROVAL_REQUIRED`,
`CAP_OVERRIDE_OWNER_REQUIRED`, `DESTRUCTIVE_CONFIRMATION_REQUIRED`), to compare an approval mode against this baseline.
Keep the five-minute review window until this baseline has been recorded. Details are in
[WRITE-OPERATIONS](../WRITE-OPERATIONS.md#human-approval-and-the-destructive-tier).

### Encoded native reporting definitions

Original-run/query/schedule scope can recover exact known account aliases from JSON-encoded native bodies for
DV360, LinkedIn and X, matching the existing compiler allowlist. Supported locations are payload/body and
params.payload/params.body; ordinary nested object bodies are also scoped. Encoded bodies must be JSON
objects within 64 KiB UTF-8, with exact text IDs. Malformed/oversized/scalar/array bodies, conflicting aliases
or duplicate IDs, and more than eight account occurrences per body are refused. Current identity, tenant,
account and login access still applies. Unsupported sole-anchor formats and resource-path inference remain
unqualified. Original stored source bytes are not rewritten.

Credential checks inspect decoded JSON before saving or preparing copies, and the worker checks legacy
queued input before collection. Recognized credential keys are masked in query/bootstrap/run previews and
refused-input error audits. Query detail exposes configuration_redacted when needed. Harmless encoded text
keeps its original spacing and integer text. Legacy stored inputs and historical audits are preserved. If an
owner discovers a real exposed credential, review/correct the definition and rotate it through Connections
and its provider's credential workflow. No automatic destructive cleanup is performed.

See [scope, credential findings and qualification](../records/DELIVERY-2026-10-03-REPORT-BODY-SCOPE.md).

### Bounded catalog comparisons

The workspace catalog_compare action reuses the existing qualified Meta account/catalog/product GETs and native
price filter. Current read authority is required on every attempt and after responses. It accepts 1–50 validated
source products, refuses incomplete or changed evidence, and has whole-operation limits of 180 attempts including
retries, 150 product rows, 2 MiB and 60 seconds. A limit returns CATALOG_COMPARISON_LIMIT; reduce the supplied
source products and compare again. No partial comparison or saved snapshot is returned. No write review or
advertising mutation is created. Catalog ownership and item rereads improve consistency but do not establish a
point-in-time or complete catalog snapshot. Native price values and source bytes remain unchanged.

Read-permission diagnostics now name existing ads_read/ads_management alternatives; they do not instruct a
read-only user to request catalog write privileges. Existing write requirements remain intact. Native review
price/sale-price display uses exact integer hundredths throughout the accepted safe range. See
[delivery and reproduced defects](../records/DELIVERY-2026-10-03-CATALOG-COMPARISON.md).

### Exact X catalog prices after upgrade

X product, sale-price and filtered-set review/verification money views use canonical decimal strings, including
ordinary amounts. The original native price text and currency remain unchanged on submission. Supported decimal
neighbors compare exactly; rounded read-back remains inconclusive or mismatch. An unsent review prepared with
legacy numeric views requires a fresh review. Accepted writes retain their original receipt and key; verification
is read-only and cannot make repeating a mutation safe. Older verified caches of these two families require a
fresh exact read; current caches still require current account/actor access. See
[upgrade, contract qualification and early-access limits](../records/DELIVERY-2026-10-04-X-CATALOG-PRICES.md).

### Search conversion strategy read-back

The two conversion Search recipes create paused campaigns and leave account-default goals unchanged.
Do not infer goal/event delivery acceptance from currency checks or local compilation. Generic Google campaign
verification now checks the exact native standard bidding type; missing/wrong type or an unexpected/different
target remains unresolved and prevents dependent steps. Inspect the original receipt and retry its read-back;
do not replay an accepted creation to fix a mismatch. Account goals require current separate inspection before
activation. See [batch 117](../records/DELIVERY-2026-10-03-GOOGLE-CONVERSION-RECIPES.md).

### Google conversion configuration inspection

Recipe prerequisite checks inspect existing qualified Google settings, with two matching bounded collections
and exact current authority. Limits are 64 attempts including retries, 4,000 rows including rereads, 2 MiB and
60 seconds; each collection permits at most ten pages and 1,000 rows. A failed/incomplete/changed result cannot
supply partial goal or primary-action readiness. Narrow supported scope or repeat the read; do not change
native goals or replay an accepted campaign to resolve this diagnostic. Manager/shared conversion customers
remain unqualified and do not trigger reads against the other customer. Complete configuration does not verify
events, performance or objective acceptance. See [batch 118](../records/DELIVERY-2026-10-03-GOOGLE-GOAL-INSPECTION.md).

### Local schedule and worker measurements

`npm run benchmark:schedules` compares full scans with indexed due selection on fixed synthetic in-memory
records in separate processes. `npm run benchmark:workers` exercises actual scheduling, leases and original
creator authority with one/four child processes on owned disposable SQLite files. Both build first, accept no
database/account inputs and make no provider request or advertising mutation. No deployed configuration or
worker/replica setting changes. A failed enqueue pauses only its attempted revision, preserving newer edits and
removals. Two additive indexes enter normal serialized bootstrap without rewriting data or schema version.
Latency and sampled memory apply only to the declared local workload. See
[method, regressions and limits](../records/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md).

`node tools/benchmark-schedules.mjs --sweep [--tenants 12,100,1000,10000]` (after `npm run build`) measures one
selection pass per schedule kind against the workspace count: 12 workspaces with 100 schedules per kind and the rest
empty (OPS-08). Asking every workspace, as the worker and the Overview tick did, cost about 47 µs per workspace on the
review workstation (2026-10-11): p95 2.8 ms at 12, 4.4 ms at 100, 46.8 ms at 1,000 and 749 ms at 10,000 workspaces,
against the one-second idle pause. That is material above about 1,000 workspaces, so the decision gate chose the
global query: per kind, a partial index by deadline names the workspaces with a due schedule, and only those are asked
(p95 under 3.1 ms at every count). Per-workspace selection, its order, fairness and every authority check are
unchanged, and the sweep checks that both strategies select identical schedules.

### Explicit local product imports into X

Choose the current X account/catalog, paste AMCP product columns or map a local supplier export, supply every
required native source value and explicitly allow updates to matching IDs. Preview exact native prices/fields
before saving an unapproved plan. Each SKU retains its existing native review and independent receipt/read-back.
Create-only imports, variants, absent-item deletion and live store synchronization are not qualified. A saved
draft does not prove X early-access entitlement. Stable rounded read-back stays mismatch; recover the original
receipt without resubmission and use a separately reviewed correction when appropriate. See
[workflow, requirements and qualification](../records/DELIVERY-2026-10-04-X-CATALOG-IMPORT.md).

### Read exact supplied X catalog differences

After local source validation, choose Compare current catalog products. The read shares complete scans of at
most 1,000 listed products, repeats selected evidence and brackets catalog ownership. Grouped/unknown native
records block ambiguous missing products; unsupported/missing fields remain unknown. Matching/blocked rows
are excluded from the eligible subset. Each saved product still needs fresh native review; saving all does
not bypass the same variant guards. A saved product that still holds every supplied value when the plan reaches it
is recorded as `skipped_unchanged` with the read evidence and is not sent, so the plan can complete; it is not a
failure and needs no correction. Any difference gets an ordinary review. Unsent legacy group projections need fresh review; accepted receipts
retain original recovery. No inventory deletion or point-in-time/complete variant proof is inferred. See
[workflow and exact collection bounds](../records/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md).

**Variant groups (COM-02 E).** X lists only the first product of a group, so a grouped record can hide a supplied SKU.
When the catalog lists grouped records, the comparison returns `variant_groups` (the grouped record count, up to ten
named records, `expansion` and `remedy: scheduled_feed`), the website names those records beside a possible hidden
variant, and the native review's refusal carries the same records: add or change variants through the catalog's
scheduled feed. X does not document whether `GET products?item_group_key=` lists every member of a group, so AMCP reads
group members only after an owner-authorized read-only qualification read on a catalog with a known group (owner
resource R2, item 7) shows complete membership and the owner sets `AMCP_X_CATALOG_GROUP_EXPANSION=qualified`. Then each
listed group is read by its key, at most 10 groups and 3 pages of 100 members per group and scan, and a supplied SKU's
absence is established only when every group was read completely: each member belongs to its group once, never
collides with another listed product, and the listed record of each group is among its members. A member SKU is a
grouped product, never a new one; anything else (`group_status_unknown`, `group_limit`, `page_limit`,
`listed_member_missing`) keeps the block. Both scans must agree on the membership hash. Unset, nothing changes but the
named records; members are never returned, only counted and hashed.

### Original X identities and verification upgrade

Catalog/product/set/feed evidence must retain exact native string IDs and literal manual membership. Numeric,
duplicate, contradictory or incomplete observations stay unverified. Identity-v3 retires old verified caches
of these four families while preserving original accepted keys/receipts; current v3 caches still require
current authority. Recover original accepted receipts without resubmission. A numeric original generated
catalog/set/feed ID cannot become a guessed verification target; investigate the original receipt rather
than rewriting it. See [qualification and recovery](../records/DELIVERY-2026-10-04-X-CATALOG-IDENTITIES.md).

### Explicit selected X product removals

In Commerce, validate the selected source and compare current products. Select only the observed individual
rows intended for removal; none is selected by default. Preview exact native keys/current values, then save
an unapproved removal draft. Missing, grouped or unknown products require separate qualification. Changing a
selection invalidates its preview. Save repeats selected supported evidence and retains one original plan;
each unsent step must still be its exact saved proposal, and its own native review compares the product it reads
with the bound evidence (fields, exact price, held optional attributes, individual grouping, catalog owner) at
prepare and again at execute, refusing `CATALOG_REMOVAL_CHANGED` with nothing sent (COM-02 C). No separate catalog
comparison is read per phase, so a removal step costs what an update step costs (about 40 GETs at 1,000 products,
down from about 130). Every campaign step records its native request attempts per phase in its journal
(`native_requests: {prepare|execute|verify: {reads, writes}}`). Accepted/uncertain deletion receipts
retain original keys and read-only recovery. Deletion is permanent and a scheduled feed may restore a product
it still contains. No source-absence deletion policy or feed rewrite is inferred.
See [workflow, exact limits and synthetic qualification](../records/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).

**Listed products outside the source (COM-02 B; P9, as recorded in the [decision record](../DECISIONS.md)).** A discontinued SKU that is no longer in the
source can be removed only by explicit intent: inspect the other listed X products, select individual products by
their native key (nothing is preselected, a selection survives search and paging), preview them
(`preview_catalog_removal` with `requirements: {selection_source: "listed_inventory", product_keys, listed_inventory_hash}`)
and type the number of products back to save (`create_catalog_removal` with `confirmed_count`). The preview refuses a
listing that changed since the inspection; grouped, unknown and unlisted keys are refused; 1–50 keys. No source row is
invented, so the saved plan's brief and removal binding name the listing hash instead of a source hash. Each step keeps the single-key native
review, the owner's `allow_deletion` policy (a `false` policy refuses the step before anything is deleted) and
read-back. Nothing is ever selected because a source lacks it.

### Catalog sale prices and retirement (COM-02 A, B)

Meta and X imports accept an optional `sale_price`: a decimal lower than `price`, in the product currency (an explicit
currency suffix must be that currency), with optional `sale_price_start_date` and `sale_price_end_date` in ISO 8601
with an explicit offset, kept exactly as written (X needs both or neither and receives them as one
`sale_price_effective_date` `start/end`). Meta receives the sale in hundredths, so digits beyond the second decimal
place must be zeros; X receives `amount CUR`. The comparison uses Meta's own `sale_price_amount` filter and X's exact
decimal value, and the native review and read-back check the sale that was sent. A source without a sale sends none:
the destination keeps its current sale and the comparison names it as a value the source does not send
(`unsent_fields`, COM-01). For Meta, a product whose only differences are such values is `unknown` and enters the
review set, because Meta does not say whether an upsert keeps or clears them (owner decision P9 of 2026-10-11, in the
[decision record](../DECISIONS.md); before P9 it stayed matching); for X it stays a note on a matching product. The native
review of a Meta upsert names the same values as a warning. Clearing a destination sale is not offered.

Retirement is the non-destructive way to stop advertising a discontinued product, for Meta (which has no product
delete contract) and X. `requirements: {retire_retailer_ids, retire_availability: "out of stock" | "discontinued"}` on
`catalog_preview`, `catalog_compare` and `catalog_plan` sends those supplied products through the same reviewed update
with that availability, so ads stop showing them while the product, its history and its sets stay. It needs
`allow_upsert: true`, and a comparison blocks retiring a product the catalog does not have (`retire_absent`: the update
would create it). A plan saved from supplied products or a CSV without a comparison records the retired retailer IDs on
the plan (`catalog_retirement`), and the native review of each retirement step refuses a product the catalog does not
have (`CATALOG_RETIRE_ABSENT`, at prepare and at execute, nothing sent). On the website an update comparison offers
Retire checkboxes for existing products; nothing is deleted.

### Read-only Snapchat catalog comparison (COM-02 D)

Snapchat changes catalog products only through product feeds, so Commerce offers Snapchat ad accounts a read-only
comparison and saves nothing (`catalog_plan` refuses `CATALOG_FEED_ONLY`). AMCP reads the selected ad account's
organization, the catalog (it must belong to that organization), then the 1–50 supplied IDs in one `products/search`
request with an `ID IS_ANY` filter (pages of 1,000, at most three; a repeated, empty-but-continued, foreign or
duplicated page is refused) twice, and the account and catalog again; both scans must agree. Prices stay exact decimal
strings and a supplied `sale_price` compares exactly. Every product that differs carries `fix_in: "feed"` and the
response `remedy: "fix_in_feed"`. Limits: 30 attempts, 9,000 rows, 4 MiB and 60 seconds. Feed processing takes time, so
this is current evidence, not the next feed result. The search body follows the documented product-set filter grammar;
its live acceptance is an owner-authorized read on a selected catalog, which has not run yet.

### Catalog destinations, sources, mappings, lineage and plan groups (COM-03)

- **One destination contract.** `src/catalog-destinations.ts` registers Meta, X and Snapchat once: source fields, item
  identity, how changes reach the catalog (one reviewed native step per product with its own receipt and read-back, or
  feeds only), upsert intent (Meta asks, X always updates), removal intent (Meta retires; X also deletes explicitly
  selected products by key; Snapchat none) and what a destination-only value means (P9: Meta reviews the product as
  `unknown`, X and Snapchat note it on a matching product). The projection and comparison
  of each destination are registered under the same gateway, every comparison returns the shared item
  (`catalog-comparison-item-v2`) and the website checks it with one validator. Native write contracts are unchanged.
- **Product sources.** `src/catalog-sources.ts` turns a source into supplied rows: the caller's `products`, or
  `requirements.source = {kind: "csv", text, columns: "canonical" | "profile", profile_version?}` (at most 192 KiB and
  500 rows; `INVALID_CATALOG_SOURCE`, `CATALOG_SOURCE_LIMIT`) on `catalog_preview`, `catalog_compare` and `catalog_plan`.
  The parked store sources (WooCommerce, Shopify, Salla) plug in as further adapters there. No source establishes
  absence: a product it lacks is retained.
- **Mapping profiles.** `catalog_mapping` reads and `save_catalog_mapping` saves the column mapping of one account's
  catalog (`requirements: {columns, fixed_currency, image_mode, replace_identity_column?}`, optional `revision`). Each
  change is a new version (20 kept), audited as `catalog_mapping_saved`; an unchanged mapping keeps its version; a save
  from an older read is refused with `CATALOG_MAPPING_CHANGED`, and another retailer ID column without
  `replace_identity_column: true` with `CATALOG_MAPPING_IDENTITY`. `columns: "profile"` needs a saved mapping
  (`CATALOG_MAPPING_MISSING`). Access to the account is checked before a profile is read.
- **Plan lineage.** Every `catalog_plan` stores `catalog_lineage` on its campaign_run (and in `amcp_campaign get`):
  source kind, `source_hash`, `catalog_source_hash`, row counts, column mode, mapping profile and version, and, when
  `requirements.comparison_token` names the `lineage_token` a `catalog_compare` returned to the same person within 15
  minutes, that `comparison_hash` and time. A token for other products or another scope is refused
  (`CATALOG_LINEAGE_MISMATCH`, `CATALOG_LINEAGE_EXPIRED`); a deployment without the encryption key returns no token.
  Only `catalog_plan` can set a lineage: a direct `amcp_campaign create` naming one is refused
  (`CATALOG_LINEAGE_UNBOUND`). Lineage changes no native request, review or approval.
- **Plan groups.** `requirements.chunked: true` with a source of 51–500 products: `catalog_preview` validates every
  part and saves nothing (`catalog_plan_group_preview`); `catalog_plan` saves one unapproved plan of at most 50 per
  part with one `lineage_group` (`catalog_plan_group`). A refused product saves no part; each part has its own creation
  key, so repeating the same request saves only missing parts; the parts count toward the 500-plan limit. Retirement,
  a comparison token and Snapchat are refused in a group (`INVALID_CATALOG_PLAN_GROUP`, `CATALOG_FEED_ONLY`).
- **Storage and rollback.** These are new documents (`catalog_mapping_profile`, the 90-second
  `catalog_lineage_binding`) and an additive campaign_run field, with no SQL change and no ledger step; an older release
  ignores them. Release the website and the server together: the website's mapped import and plan groups use these
  actions and inputs. Each phase can be reverted on its own (the destination registry, then profiles, sources and
  lineage, then plan groups).

### Verify the committed release source

After regenerating changed public reports in an isolated sanitized candidate and committing reviewed files,
assemble a fresh candidate and run `npm run release:verify -- .release/candidate` from the clean source root.
This proves exact committed public bytes, the original manifest and an empty generated sample; it does not
regenerate reports or qualify behavior. Preserve the proof with release evidence, then run offline/normal
installation, build, early `report -- --check`, the full required checks and Railway/container qualification.
CI performs the same source proof before installation. See [boundaries and fixture qualification](../records/DELIVERY-2026-10-04-RELEASE-SOURCE.md).
