# Operations

This runbook covers the current single-host deployment with read access by default and optional reviewed writes. It does not certify production release.

## Configuration

Use environment injection from a secret manager. `.env.example` documents names; the program does not automatically load `.env` files. Set `MIRROR_MASTER_KEY` to a base64 encoding of 32 random bytes. `MIRROR_DB` defaults to `.runtime/mirror.sqlite`. Set a tenant ID for stdio or create tenant-bound API keys for HTTP. A credential connection has explicit account bindings; broad vendor token permissions never replace those bindings.

Connection credentials: Meta/TikTok/Snapchat/LinkedIn use access tokens; Google Ads additionally requires a developer token and may need loginCustomerId. X requires consumerKey, consumerSecret, accessToken and tokenSecret for OAuth 1.0a. Refresh-capable connections also need their own clientId/clientSecret/refreshToken/expiresAt. Reddit uses a bearer access token, a connection userAgent, and Basic client authentication when refreshing. Tokens are refreshed shortly before expiry for supported providers; unsupported refresh modes return a reauthorization error. App registration, granted scopes and vendor approval are prerequisites and are not performed by this CLI.

Media execution locks and shared byte reservations use 45-second leases renewed
every 15 seconds and at transfer boundaries. After a worker crash, wait for lease
expiry and inspect `amcp_media recovery` for the original review. Do not delete
locks or create replacement uploads. Explicit resume is available only within the
transfer window set at the claim (`AMCP_MEDIA_TRANSFER_WINDOW_MINUTES`, default 60,
never past a website upload's thirty-minute deadline; reviews claimed before this
keep their original review expiry): Google video uses its authoritative offset; LinkedIn video uses
versioned encrypted confirmed-part receipts and current `WAITING_UPLOAD` status.
Unknown PUT outcomes and attempted finalization cannot resume. Old LinkedIn
receipts without an intent marker remain unqualified. See
[media recovery evidence](implementation/LINKEDIN-MEDIA-RECOVERY-2026-09-25.md).

Media admission reserves for each file's size, with a per-workspace share of the
operation slots, and queued uploads refused for contention before any claim are
retried by the worker until their review expires; see
[media capacity](MEDIA-UPLOADS.md#media-capacity) for the settings and defaults.
The owner's health view lists the workspace's media refusals
(`memory_busy_refusals`, `staging_full_refusals`, `deadline_too_close_refusals`),
released unfinished uploads and measured transfers (`transfers_completed`,
`transfer_ms_total`, `transfer_bytes_total`) since the process started; the
unauthenticated `/healthz` shows none of them. Lower the reservation factor or floor
only after measuring peak Node and FFmpeg memory on the production image.

GA4, GTM and Search Console have website OAuth onboarding and explicit property/account/site selection. Apple Ads uses client-credentials authentication with optional automatic ES256 signing; see [measurement and Apple setup](MEASUREMENT-AND-APPLE.md). Meta initial user tokens are exchanged for long-lived tokens. TikTok's current advertiser tokens are long-term and require reauthorization if revoked; its separate short-term user-token refresh API is not used for advertiser credentials.

Globally addressed Meta/Snapchat objects need recent ownership evidence from an account-scoped collection. Otherwise provision explicit resourceBindings with an accountId, exact pathPrefix and any required query invariants. These are administrator grants, not arbitrary caller input. GA4 connections bind property IDs; GTM binds account IDs; Search Console binds exact property URLs or sc-domain properties. Business Profile locations can be explicitly bound as `locations/<id>`.

Set `MIRROR_ALLOW_WRITES=true` to expose `amcp_write`, grant specific accounts, and issue operator access. The review service reads provider state, freezes requests for five minutes, verifies state again before submission, and persists idempotency across restarts. Lost or partial responses are retained and must be reconciled before new submissions. There is no automatic rollback. See [write operations](WRITE-OPERATIONS.md).

`MIRROR_FLAGS` takes a JSON object of opt-in enhancements. `{"compactSchemas":true}` lists each action once in the
tool schemas: the DV360 tool otherwise lists all 173 actions twice, with and without the `DV360_` prefix, and the
flag removes about 7 KB from every `tools/list`. The unprefixed legacy names stay accepted. Without the flag the
schemas match the captured gateway schemas exactly.

## Backup and recovery

Backups are encrypted only. `npm run admin -- backup <new-file>` (and its older name `backup-encrypted`) takes a
consistent SQLite snapshot and writes it as one AES-256-GCM archive under `MIRROR_MASTER_KEY`. Verification and
restoration use private plaintext staging; successful cleanup removes it, while restore deliberately publishes the verified offline copy. Keep the master key separately and back it up in the secret manager: losing it makes
both the encrypted tokens and the backups unrecoverable. Do not copy only the main SQLite file while WAL writes are
active.
`npm run admin -- backup-verify <encrypted-file>` checks a disposable copy without
opening or creating `MIRROR_DB`. To retain a verified offline restoration, use
`npm run admin -- backup-restore <encrypted-file> <new-sqlite-file>` with the same
`MIRROR_MASTER_KEY` injected through the environment. Never put the key on the
command line. The destination parent must already exist and be private. The CLI
refuses existing files, directories, links and SQLite sidecars, including a
concurrent restore's output. It validates GCM authentication, SQLite integrity,
foreign keys, supported schema, audit chain and connection-secret decryption
before atomically publishing the file. Publication requires a filesystem with
hard-link support; there is no overwrite/copy fallback. File content is synced;
the receipt separately reports directory syncing, unavailable through this path
on Windows and some filesystems. This is not a power-loss durability guarantee.

Restore does not open the configured database, change deployment configuration,
start the application, execute jobs, complete uncertain writes, or modify the
source archive. Keep the new copy offline while comparing the backup timestamp
with independently retained delivery, provider mutation, credential, membership,
session and revocation history. A backup can contain an old queued job or omit a
write completed after that snapshot. Stop all original writers before an explicit
database switch; reconcile these changes before enabling workers or advertising
writes. Restoring an old database alone cannot prove that a lost mutation is safe
to repeat. Host storage/ACLs, off-host retention, production RPO/RTO and rollback
qualification remain operational responsibilities requiring a deployment drill.

Staging cleanup makes six bounded asynchronous attempts for transient filesystem locks, yielding up to 750 ms
of backoff. Permanent failure is explicit: `BACKUP_CLEANUP_FAILED` includes `staging_directory`,
`primary_error_code`, `cleanup_required:true` and `operation_completed`. A completed restore can already have
published its verified destination even if later staging cleanup fails; inspect the destination before retrying.
Resolve the filesystem restriction and remove only that known inactive staging directory. Cleanup is not
silently treated as successful, and raw operating-system error messages are withheld. A terminated process can
leave `amcp-backup-*` under the system temporary directory or restore destination
parent. Preserve/inspect only the known interrupted attempt's staging directory
and remove it after establishing that no restoration uses it; never sweep active
operations or delete the original database. The command never publishes an
unauthenticated or partly verified destination.

The audit chain detects changes to retained records and SQL triggers prevent normal updates/deletes. It has no external checkpoint service and cannot detect rollback to a previously valid backup. Keep independent backup/checkpoint records for a production deployment. Owner-confirmed 7–365-day report retention is implemented for the selected finished report/job and resolved-incident records; active work, open/acknowledged incidents, audit records and write receipts are preserved. General all-record retention, external monitoring and independent checkpoints remain separate.

Local subprocess tests verified consistent backup while the source database remained open in WAL mode, restoration of encrypted credentials and committed documents, audit verification after restore, and refusal to overwrite an existing backup. Concurrent process startup now serializes database bootstrap/migrations in a transaction. Unsupported schema versions roll back attempted schema changes and close the connection. These tests do not qualify host-level disaster recovery or a production deployment.

## Workers and schedules

Both the embedded HTTP worker and standalone `npm run worker` use the same stage loop. Schedule,
mail and job-stage failures emit only stage/code/count/timestamp metadata and wait one second
before a new continuous cycle. Successful work drains immediately; idle cycles wait one second.
`npm run worker -- --once` runs one cycle and propagates a failed stage, so its exit remains
unsuccessful. The original one-shot exception presentation is unchanged. Shutdown waits for an
already awaited stage and starts no later mail/job stage or claim once its stop flag is observed.
Existing lease, authority, uncertain-mutation and listener cleanup rules remain. See
[local qualification and platform limits](review/DELIVERY-2026-10-05-WORKER-LOOP-RECOVERY.md).

Run `npm run worker` in a separate process on the same host/database. Jobs acquire 60-second leases, renew every 15 seconds, and require a matching lease token for completion. Expired read jobs can be reacquired; a stale worker cannot overwrite a newer result. Failed jobs retain their error. A prepared run never executes until activated. Reactivating a complete run does not repeat it; save/update a query or prepare a new run to request a new execution.

Native jobs aggregate up to 25 pages and fail with REPORT_TRUNCATED if more remain. Split such queries before rerunning. JSON endpoints reject empty, malformed, null or scalar HTTP success payloads; endpoint-specific no-content or non-JSON handling must be added explicitly before implementing those routes. Reddit additionally validates request and response bodies against its saved official schemas. See docs/REDDIT.md for supported behavior. The CLI verification report excludes raw vendor response contents, but the local audit database retains redacted outcomes and must be protected as sensitive operational data.

Schedules use local IANA clock time, and enqueue atomically with the next-occurrence update. A missed occurrence is coalesced into one current run. Generic query_config accepts explicit date ranges or `{preset:"last_complete_days",days:7,timezone:"Africa/Cairo"}` under date_range; native gateway requests preserve their explicit dates. Spring DST skipped times are skipped; autumn repeated local occurrences are deduplicated. Reporting Overview separately supports independent daily/weekly/monthly Sheets delivery schedules, owned destination tabs and content-bound delivery recovery; see [reporting setup](REPORTING-OVERVIEW.md). Selected report retention, owned destination recovery and monitoring notification delivery/retry are implemented; see the current [workflow guide](PRODUCT-WORKFLOWS.md) for their exact scope. These do not provide generic all-provider job cancellation, arbitrary dead-letter replay or all-record retention. Inspect original run status, audit records and destination receipts before any explicit recovery.

## Provider request pacing

Each tenant/gateway pair holds a 30-request burst that refills one request every 250 ms, in process, and a shared durable budget of the same size refilling every 200 ms. A burst is _shaped_, not rejected: a request that arrives with the burst spent waits for its refill, so a bounded operation that legitimately exceeds 30 calls — Google account discovery across many accessible customers, a long paged read — completes instead of failing partway. Only a caller that stays beyond the sustained rate long enough to owe more than 2 seconds receives `TENANT_RATE_LIMIT` with an accurate `retry_after_ms`. The in-process refill is deliberately faster than the durable budget's so that shaping never starves the shared limiter. HTTP 429 responses from a provider still open a shared cooldown, and repeated failures still open the per-gateway circuit.

## HTTP deployment

Default bind is loopback. External bind requires MIRROR_PUBLIC_ORIGIN as an HTTPS origin and a TLS reverse proxy. The service validates Host and Origin, authenticates bearer tokens, limits JSON bodies to 4 MiB, and supports stateless POST requests. Provision a distinct mirror key per operator with an appropriate role. Keys expire after 30 days by default; provision replacements and revoke old keys with `npm run admin -- revoke-key <protected-token-file>`.

Claude remote clients can dynamically register with `client_secret_post`; public clients retain `none`. Both require S256 PKCE and administrator consent. Client secrets are encrypted at rest and must accompany token, refresh and revocation requests. Optional trusted proxy CIDRs affect rate-limit attribution only. See [OAuth hardening](OAUTH-HARDENING.md) for configuration and regression coverage.

The maintained GitHub workflow defines Docker builds and synthetic read-only/write-enabled startup, volume ownership, authentication, MCP access, restart-persistence and revocation checks. Hosted Actions are waived at the owner’s direction after exhausted minutes; no new run is started or treated as passed. Fresh exact-source/default-full/required-FFmpeg/report checks continue locally; current Linux/Docker and deployed acceptance require actual host evidence. This does not qualify the TLS proxy, multi-host load, provider authorization, or recovery under production traffic. SQLite/WAL remains a single-host storage choice.

## Accounts, reporting and operating controls

See [account setup](USER-ACCOUNTS.md), [Reporting Overview](REPORTING-OVERVIEW.md) and [implementation/acceptance notes](RECOMMENDATIONS-IMPLEMENTED.md) for owner migration, team access, MFA, custom metrics, scheduled Sheets exports, campaign preflight/recovery, spending policies, asynchronous media and encrypted backups.

### Website feature loading

The initial document contains eight shared scripts; `web/route-assets.js` declares fixed same-origin feature
dependencies. Keep top-level initialization dependencies explicit when adding a controller, especially wrappers
that capture another function. Navigation awaits all required scripts before rendering. Download errors retry
only failed files; uncertain evaluation/timeouts require full reload, since removing a script cannot establish
that it never evaluated. Existing authorization applies after loading. No account data is stored in the loader.

Run `node tools/benchmark-web-assets.mjs` from the repository for exact file hashes and raw/gzip/Brotli bytes per
route. This excludes CSS/fonts/locale JSON/headers and is not a browser timing test. The normal regression suite
covers the manifest, cold English/Arabic source initialization and HTTP revalidation. See
[qualification and limits](review/DELIVERY-2026-10-02-ROUTE-ASSETS.md) before making performance claims.

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
[qualification and measurement limits](review/DELIVERY-2026-10-03-TOOL-TIMINGS.md).

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

See [scope, credential findings and qualification](review/DELIVERY-2026-10-03-REPORT-BODY-SCOPE.md).

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
[delivery and reproduced defects](review/DELIVERY-2026-10-03-CATALOG-COMPARISON.md).

### Exact X catalog prices after upgrade

X product, sale-price and filtered-set review/verification money views use canonical decimal strings, including
ordinary amounts. The original native price text and currency remain unchanged on submission. Supported decimal
neighbors compare exactly; rounded read-back remains inconclusive or mismatch. An unsent review prepared with
legacy numeric views requires a fresh review. Accepted writes retain their original receipt and key; verification
is read-only and cannot make repeating a mutation safe. Older verified caches of these two families require a
fresh exact read; current caches still require current account/actor access. See
[upgrade, contract qualification and early-access limits](review/DELIVERY-2026-10-04-X-CATALOG-PRICES.md).

### Search conversion strategy read-back

The two conversion Search recipes create paused campaigns and leave account-default goals unchanged.
Do not infer goal/event delivery acceptance from currency checks or local compilation. Generic Google campaign
verification now checks the exact native standard bidding type; missing/wrong type or an unexpected/different
target remains unresolved and prevents dependent steps. Inspect the original receipt and retry its read-back;
do not replay an accepted creation to fix a mismatch. Account goals require current separate inspection before
activation. See [batch 117](review/DELIVERY-2026-10-03-GOOGLE-CONVERSION-RECIPES.md).

### Google conversion configuration inspection

Recipe prerequisite checks inspect existing qualified Google settings, with two matching bounded collections
and exact current authority. Limits are 64 attempts including retries, 4,000 rows including rereads, 2 MiB and
60 seconds; each collection permits at most ten pages and 1,000 rows. A failed/incomplete/changed result cannot
supply partial goal or primary-action readiness. Narrow supported scope or repeat the read; do not change
native goals or replay an accepted campaign to resolve this diagnostic. Manager/shared conversion customers
remain unqualified and do not trigger reads against the other customer. Complete configuration does not verify
events, performance or objective acceptance. See [batch 118](review/DELIVERY-2026-10-03-GOOGLE-GOAL-INSPECTION.md).

### Local schedule and worker measurements

`npm run benchmark:schedules` compares full scans with indexed due selection on fixed synthetic in-memory
records in separate processes. `npm run benchmark:workers` exercises actual scheduling, leases and original
creator authority with one/four child processes on owned disposable SQLite files. Both build first, accept no
database/account inputs and make no provider request or advertising mutation. No deployed configuration or
worker/replica setting changes. A failed enqueue pauses only its attempted revision, preserving newer edits and
removals. Two additive indexes enter normal serialized bootstrap without rewriting data or schema version.
Latency and sampled memory apply only to the declared local workload. See
[method, regressions and limits](review/DELIVERY-2026-10-04-SCHEDULER-WORKERS.md).

### Explicit local product imports into X

Choose the current X account/catalog, paste AMCP product columns or map a local supplier export, supply every
required native source value and explicitly allow updates to matching IDs. Preview exact native prices/fields
before saving an unapproved plan. Each SKU retains its existing native review and independent receipt/read-back.
Create-only imports, variants, absent-item deletion and live store synchronization are not qualified. A saved
draft does not prove X early-access entitlement. Stable rounded read-back stays mismatch; recover the original
receipt without resubmission and use a separately reviewed correction when appropriate. See
[workflow, requirements and qualification](review/DELIVERY-2026-10-04-X-CATALOG-IMPORT.md).

### Read exact supplied X catalog differences

After local source validation, choose Compare current catalog products. The read shares complete scans of at
most 1,000 listed products, repeats selected evidence and brackets catalog ownership. Grouped/unknown native
records block ambiguous missing products; unsupported/missing fields remain unknown. Matching/blocked rows
are excluded from the eligible subset. Each saved product still needs fresh native review; saving all does
not bypass the same variant guards. Unsent legacy group projections need fresh review; accepted receipts
retain original recovery. No inventory deletion or point-in-time/complete variant proof is inferred. See
[workflow and exact collection bounds](review/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md).

### Original X identities and verification upgrade

Catalog/product/set/feed evidence must retain exact native string IDs and literal manual membership. Numeric,
duplicate, contradictory or incomplete observations stay unverified. Identity-v3 retires old verified caches
of these four families while preserving original accepted keys/receipts; current v3 caches still require
current authority. Recover original accepted receipts without resubmission. A numeric original generated
catalog/set/feed ID cannot become a guessed verification target; investigate the original receipt rather
than rewriting it. See [qualification and recovery](review/DELIVERY-2026-10-04-X-CATALOG-IDENTITIES.md).

### Explicit selected X product removals

In Commerce, validate the selected source and compare current products. Select only the observed individual
rows intended for removal; none is selected by default. Preview exact native keys/current values, then save
an unapproved removal draft. Missing, grouped or unknown products require separate qualification. Changing a
selection invalidates its preview. Save repeats selected supported evidence and retains one original plan;
each unsent step rechecks its source before normal native review/execute. Accepted/uncertain deletion receipts
retain original keys and read-only recovery. Deletion is permanent and a scheduled feed may restore a product
it still contains. No source-absence deletion policy or feed rewrite is inferred.
See [workflow, exact limits and synthetic qualification](review/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).

### Verify the committed release source

After regenerating changed public reports in an isolated sanitized candidate and committing reviewed files,
assemble a fresh candidate and run `npm run release:verify -- .release/candidate` from the clean source root.
This proves exact committed public bytes, the original manifest and an empty generated sample; it does not
regenerate reports or qualify behavior. Preserve the proof with release evidence, then run offline/normal
installation, build, early `report -- --check`, the full required checks and Railway/container qualification.
CI performs the same source proof before installation. See [boundaries and fixture qualification](review/DELIVERY-2026-10-04-RELEASE-SOURCE.md).

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
See [scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-CONVERSION-ACTIVITY.md).

## Original Google image reference reads

Google image asset_usage uses exact original receipt/SHA/account binding, explicit non-manager identity,
bracketed native asset/customer reads and two complete matching link collections. A selected 1–1000 limit,
24 attempts, 2100 rows, 4 MiB and 60 seconds bound work and retries. Overflow, continuation or inconsistent
counts refuse a partial inventory. Current actor/session/scopes/credentials/source metadata remain guarded.
This reader-compatible flow creates no snapshot or provider mutation and makes no all-format/history/delivery
claim. See [scope and qualification](review/DELIVERY-2026-10-04-GOOGLE-IMAGE-REFERENCES.md).

## Selected Performance Max image reference view

Google image asset_usage now accepts explicit reference_view performance_max; ad_images remains the default.
Each selected view independently uses original exact IMAGE/receipt/SHA/client/account identity, six bracketed
searches and two complete matching collections with the existing authority and 24-attempt/2100-row/4-MiB/60-second
limits. PMax projects exact group/campaign/image links and requires explicit PERFORMANCE_MAX mode. Enabled and
paused links remain configurations, removed links separate, missing roles/statuses unresolved. No mutation,
snapshot, all-format absence, serving or historical attribution is implied. See [evidence](review/DELIVERY-2026-10-04-GOOGLE-PMAX-IMAGE-REFERENCES.md).

### Original Performance Max campaign logo references

Choose `reference_view:"performance_max_brand"` on `amcp_media {action:"asset_usage",asset_id,limit:50}` for the
original IMAGE receipt's bounded current campaign-logo view. Literal enabled brand guidelines and exact
Performance Max campaign/image identity are required. LOGO/LANDSCAPE_LOGO link configuration, removed and
unknown links remain distinct. Campaign links are not ads or asset groups. The default ad view and explicit
asset-group view remain independent. Google handoffs retain the original asset, chosen view and bounded
limit; the website waits for an explicit read and clears view choices when another asset is opened. No
write grant, serving/performance/history or all-format absence is established. See [qualification](review/DELIVERY-2026-10-04-GOOGLE-PMAX-CAMPAIGN-LOGOS.md).

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
CSV fields. MCP handoffs preselect exact source IDs/price without an automatic read. See [qualification](review/DELIVERY-2026-10-04-WOOCOMMERCE-SOURCE.md).

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
MCP handoffs preserve the original asset/bound without an automatic read. See [qualification](review/DELIVERY-2026-10-04-SNAPCHAT-TOP-SNAP-REFERENCES.md).

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
original controls. See [local browser setup and scope](LOCAL-BROWSER-QA.md) and
[delivery evidence](review/DELIVERY-2026-10-04-RENDERED-WORKFLOWS.md). Hosted CI remains owner-paused;
continue exact local source/report/full gates with required FFmpeg. Full Arabic privacy, broader
populated states, assistive technology and live/deployed/provider acceptance remain separate.

### Batch 150 — product readability and source mapping blockers

Product labels in the selected commerce preview/source tables remain readable inside their named
keyboard-scroll regions. A source SKU/name with surrounding whitespace stays exactly as read and
cannot be selected for Meta; correct the original store value and explicitly reread it. The supplied
Meta preview applies the native destination's product-field validation before offering a plan.
No identifier is trimmed or invented, and products keep their separate ownership/read-back/write-review
requirements. See [delivery evidence](review/DELIVERY-2026-10-04-COMMERCE-READABILITY.md) and
[local browser checks](LOCAL-BROWSER-QA.md). Broader inventory/variants and live acceptance remain separate.

### Batch 151 — complete privacy languages

The published privacy policy is fully readable in English/Arabic without login or JavaScript.
/privacy keeps English by default; /privacy?lang=en and /privacy?lang=ar select static versions.
Ordinary policy language links work without scripts, and the selected website language determines
website privacy-link destinations. The choice does not change workspace preference, consent or
provider permissions. English policy content, date, anchors and linked destinations remain.
See [qualification](review/DELIVERY-2026-10-04-ARABIC-PRIVACY.md). Structural/rendered checks do not
replace human legal/editorial or assistive/live/deployed acceptance.

Selected WooCommerce variation sources use the existing encrypted one-store wc/v3 Read connection.
Choose exact parent/child IDs; keys are never entered on Commerce. Six fixed GETs bracket currency
and repeat parent membership/child projections with current authorization, a shared 30-second deadline,
4 MiB and 102 collected-row bounds. Unsupported fields stay visible blockers. Exact reviewed titles
and parent-SKU Meta groups create only unapproved drafts; there is no automatic sync or deletion.
See [workflow and qualification](review/DELIVERY-2026-10-04-WOOCOMMERCE-VARIATIONS.md). Owner-directed hosted CI skipping remains active.

Website Meta canonical and explicitly mapped supplier CSVs accept optional retailer_product_group_id
through the existing reviewed product field contract. No group is inferred, native strings are
preserved and blank optionals remain omitted. X refuses group intent. Column evidence binds the
selected account/login/gateway and is invalidated on scope changes; WooCommerce mode hides unrelated
CSV controls. Native group proof/cache/receipt behavior remains unchanged. See [qualification](review/DELIVERY-2026-10-04-META-GROUP-CSV.md).

Recent GA4 event tables now use authored captions and readable event-name columns in both languages,
with literal exact native count/stream display. The isolated browser qualification treats Google's
exact runRealtimeReport POST as a semantic read and refuses event senders/other provider actions.
No native contract, permissions, event delivery, retained snapshot or tracking-health claim changes.
See [scope and evidence](review/DELIVERY-2026-10-04-GA4-EVENT-LAYOUT.md).

Saved evidence now supports explicit 10/25/50/100-row local page bounds with current-view/source
validation, pending-control fences, scoped retry and first-page reset under the active search.
The original 151-row synthetic browser journey verifies an all-row same-language Excel download
from a one-row filtered view. No provider request, native mutation, report revision or retained binary
is added. See [scope and proof](review/DELIVERY-2026-10-04-RETAINED-ROW-BROWSING.md).

Google keyword/day evidence uses the existing v25 Search read with exact positive Search criterion/view
identity, native text/match type and bracketed account/page source hashes. Complete paging and every
current-authority checkpoint precede persistence. Guided keyword evidence is excluded from the original
negative-exclusion and campaign-budget plan predicates. Retained filters/downloads add no provider read;
old workbook headers remain. See [scope and local proof](review/DELIVERY-2026-10-05-GOOGLE-KEYWORD-EVIDENCE.md).

Saved evidence controls use scoped first-party styling with readable type, usable dimensions and
explicit selector focus. Native values, query/page bounds, pending/current-view guards and download
semantics remain. The original strict CSP is unchanged. See [local qualification](review/DELIVERY-2026-10-05-EVIDENCE-CONTROL-LAYOUT.md).

Selected Google reporting failures and their recovery hints use authored English/Arabic display.
The original API messages, codes, request references and native details remain exact. Failed
collection is not retained; a retry is a separate explicit capture using current authority and
full original completeness guards. No automatic retry or provider write is added. See
[connected negative/recovery evidence](review/DELIVERY-2026-10-05-GOOGLE-CAPTURE-RECOVERY.md).

## Campaign/device/day evidence qualification

The sixth Google preset uses the existing v25 Search read contract and bounded collector, with
exact two-field date/device grain and full campaign resources. Preserve literal native enums,
complete row-count/page evidence and both customer checks; missing categories are not zero proof.
Keep this grain separate from campaign allocation and exclusion workflows. See [scope and local
release evidence](review/DELIVERY-2026-10-05-GOOGLE-DEVICE-EVIDENCE.md). Hosted Actions remains owner-skipped; current local checks
do not establish Linux/Docker, deployed Railway or native-provider acceptance.

## Persistent evidence capture feedback

Current guided failures retain the existing reason/remediation/reference in a form-linked alert;
the shared toast/formatter/native collector remain unchanged. Explicit edits or new submission
clear that current message and superseded replies stay silent. Capture transport errors do not
automatically prove that no report was saved; follow the displayed reason before another submit.
See [baseline and qualification](review/DELIVERY-2026-10-05-PERSISTENT-CAPTURE-FEEDBACK.md); no automatic retry is introduced.

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
