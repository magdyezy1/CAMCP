# Operations

This runbook covers the current single-host deployment with read access by default and optional reviewed writes. It does not certify production release.

## Configuration

Use environment injection from a secret manager. `.env.example` documents names; the program does not automatically load `.env` files. Set `MIRROR_MASTER_KEY` to a base64 encoding of 32 random bytes. `MIRROR_DB` defaults to `.runtime/mirror.sqlite`. Set a tenant ID for stdio or create tenant-bound API keys for HTTP. A credential connection has explicit account bindings; broad vendor token permissions never replace those bindings.

Connection credentials: Meta/TikTok/Snapchat/LinkedIn use access tokens; Google Ads additionally requires a developer token and may need loginCustomerId. X requires consumerKey, consumerSecret, accessToken and tokenSecret for OAuth 1.0a. Refresh-capable connections also need their own clientId/clientSecret/refreshToken/expiresAt. Reddit uses a bearer access token, a connection userAgent, and Basic client authentication when refreshing. Tokens are refreshed shortly before expiry for supported providers; unsupported refresh modes return a reauthorization error. App registration, granted scopes and vendor approval are prerequisites and are not performed by this CLI.

Media execution locks and shared byte reservations use 45-second leases renewed
every 15 seconds and at transfer boundaries. After a worker crash, wait for lease
expiry and inspect `amcp_media recovery` for the original review. Do not delete
locks or create replacement uploads. Explicit resume is available only within the
original review: Google video uses its authoritative offset; LinkedIn video uses
versioned encrypted confirmed-part receipts and current `WAITING_UPLOAD` status.
Unknown PUT outcomes and attempted finalization cannot resume. Old LinkedIn
receipts without an intent marker remain unqualified. See
[media recovery evidence](implementation/LINKEDIN-MEDIA-RECOVERY-2026-09-25.md).

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

The audit chain detects changes to retained records and SQL triggers prevent normal updates/deletes. It has no external checkpoint service and cannot detect rollback to a previously valid backup. Keep independent backup/checkpoint records for a production deployment. General data retention and external monitoring are not implemented yet.

Local subprocess tests verified consistent backup while the source database remained open in WAL mode, restoration of encrypted credentials and committed documents, audit verification after restore, and refusal to overwrite an existing backup. Concurrent process startup now serializes database bootstrap/migrations in a transaction. Unsupported schema versions roll back attempted schema changes and close the connection. These tests do not qualify host-level disaster recovery or a production deployment.

## Workers and schedules

Run `npm run worker` in a separate process on the same host/database. Jobs acquire 60-second leases, renew every 15 seconds, and require a matching lease token for completion. Expired read jobs can be reacquired; a stale worker cannot overwrite a newer result. Failed jobs retain their error. A prepared run never executes until activated. Reactivating a complete run does not repeat it; save/update a query or prepare a new run to request a new execution.

Native jobs aggregate up to 25 pages and fail with REPORT_TRUNCATED if more remain. Split such queries before rerunning. JSON endpoints reject empty, malformed, null or scalar HTTP success payloads; endpoint-specific no-content or non-JSON handling must be added explicitly before implementing those routes. Reddit additionally validates request and response bodies against its saved official schemas. See docs/REDDIT.md for supported behavior. The CLI verification report excludes raw vendor response contents, but the local audit database retains redacted outcomes and must be protected as sensitive operational data.

Schedules use local IANA clock time, and enqueue atomically with the next-occurrence update. A missed occurrence is coalesced into one current run. Generic query_config accepts explicit date ranges or `{preset:"last_complete_days",days:7,timezone:"Africa/Cairo"}` under date_range; native gateway requests preserve their explicit dates. Spring DST skipped times are skipped; autumn repeated local occurrences are deduplicated. Reporting Overview separately supports independent daily/weekly/monthly Sheets delivery schedules, owned destination tabs and content-bound delivery recovery; see [reporting setup](REPORTING-OVERVIEW.md). General retention pruning, generic job cancellation, alert delivery and dead-letter retries still require further implementation. Poll run status and audit records to see failures.

## Provider request pacing

Each tenant/gateway pair holds a 30-request burst that refills one request every 250 ms, in process, and a shared durable budget of the same size refilling every 200 ms. A burst is *shaped*, not rejected: a request that arrives with the burst spent waits for its refill, so a bounded operation that legitimately exceeds 30 calls — Google account discovery across many accessible customers, a long paged read — completes instead of failing partway. Only a caller that stays beyond the sustained rate long enough to owe more than 2 seconds receives `TENANT_RATE_LIMIT` with an accurate `retry_after_ms`. The in-process refill is deliberately faster than the durable budget's so that shaping never starves the shared limiter. HTTP 429 responses from a provider still open a shared cooldown, and repeated failures still open the per-gateway circuit.

## HTTP deployment

Default bind is loopback. External bind requires MIRROR_PUBLIC_ORIGIN as an HTTPS origin and a TLS reverse proxy. The service validates Host and Origin, authenticates bearer tokens, limits JSON bodies to 4 MiB, and supports stateless POST requests. Provision a distinct mirror key per operator with an appropriate role. Keys expire after 30 days by default; provision replacements and revoke old keys with `npm run admin -- revoke-key <protected-token-file>`.

Claude remote clients can dynamically register with `client_secret_post`; public clients retain `none`. Both require S256 PKCE and administrator consent. Client secrets are encrypted at rest and must accompany token, refresh and revocation requests. Optional trusted proxy CIDRs affect rate-limit attribution only. See [OAuth hardening](OAUTH-HARDENING.md) for configuration and regression coverage.

GitHub CI builds the Dockerfile and checks both read-only and write-enabled startup, volume ownership, authentication, MCP access, restart persistence and revocation using synthetic credentials. This does not qualify the TLS proxy, multi-host load, provider authorization, or recovery under production traffic. SQLite/WAL remains a single-host storage choice.

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
