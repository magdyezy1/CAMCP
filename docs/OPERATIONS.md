# Operations

This runbook covers the current single-host deployment with read access by default and optional reviewed writes. It does not certify production release.

## Configuration

Use environment injection from a secret manager. `.env.example` documents names; the program does not automatically load `.env` files. Set `MIRROR_MASTER_KEY` to a base64 encoding of 32 random bytes. `MIRROR_DB` defaults to `.runtime/mirror.sqlite`. Set a tenant ID for stdio or create tenant-bound API keys for HTTP. A credential connection has explicit account bindings; broad vendor token permissions never replace those bindings.

Connection credentials: Meta/TikTok/Snapchat/LinkedIn use access tokens; Google Ads access belongs to the OAuth client's Cloud project and may need loginCustomerId (developer tokens were sunset on 2026-09-09: AMCP never sends one and warns at startup and in owner health while `AMCP_GOOGLE_DEVELOPER_TOKEN` is set). X requires consumerKey, consumerSecret, accessToken and tokenSecret for OAuth 1.0a. Refresh-capable connections also need their own clientId/clientSecret/refreshToken/expiresAt. Reddit uses a bearer access token, a connection userAgent, and Basic client authentication when refreshing. Tokens are refreshed shortly before expiry for supported providers; unsupported refresh modes return a reauthorization error. App registration, granted scopes and vendor approval are prerequisites and are not performed by this CLI.

Requests are bound to the connection's login revision, not to its token bytes. The store bumps the revision when a new authorization, reauthorization, re-provisioning or direct credential replacement writes different credentials; AMCP's own token refresh keeps it. A refresh by any worker therefore never interrupts a read, discovery, review or export, while a replaced login still stops in-flight work with `CONNECTION_AUTHORITY_CHANGED` (restart with the current login; do not reconnect). Scope loss still returns `INSUFFICIENT_SCOPE`, and `REAUTHORIZATION_REQUIRED` remains for credentials that no longer work. TikTok report tasks keep their exact-token binding (`TIKTOK_REPORT_TOKEN_CHANGED`). `AMCP_AUTHORITY_FENCE=fingerprint` temporarily restores the previous byte comparison as a rollback; it will be removed one release after acceptance. The revision covers credentials only: narrowing a connection's scopes or its selected accounts does not bump it, and those changes are caught by the separate scope (ScopeGuard) and account-selection checks that every authority decision repeats.

Provider OAuth grants live in one registry, `src/provider-grants.ts` (CON-03): per gateway, the scopes AMCP requests (read, plus write scopes only when reviewed writes are allowed; Reddit `adsedit` is now requested only then), the scopes read and reviewed-write enforcement require, where the granted permissions are learned and whether readiness has an exact account read. The OAuth configuration, measurement, Google Ads, Snapchat, Microsoft and Reddit write checks, readiness and capability eligibility all read it; existing logins keep the scopes they were granted. Scopes echoed by a token response are recorded exactly (TikTok's returned list verbatim). Meta's exchanges return none, so every Meta connect, ad-account sync and reauthorization reads `/me/permissions` once (after the ad-account listing succeeds) and records granted, declined and expired permissions with `checked_at` in `website_connection.grants`; the recorded scopes become the granted list, which also covers Facebook Login for Business configurations (`AMCP_META_CONFIG_ID`) that grant permissions such as `catalog_management`. A failed or unreadable permissions read never blocks connecting: it records `known:false`, and readiness reports the permission as unknown, never granted. X records only the access type AMCP requested. Recorded scopes remain a local prerequisite; the provider's own check at execution is the authority. `AMCP_CAPABILITY_GRAPH_VERSION=2` restores the version 2 capability graph placeholders as a rollback.

Credential health is a `connection_health` document per connection, bound to its login revision and removed on disconnect. Token refresh records success (access and, for LinkedIn, login expiry), a documented grant rejection (`invalid_grant`, `invalid_token`: `reauthorization_required`, after which refresh fails fast with `REAUTHORIZATION_REQUIRED` and no token request until the login is reauthorized or an administrator chooses Retry renewal), or another failure (`refresh_failed`, bounded back-off from 30 seconds to 15 minutes). A dead login therefore costs one token-endpoint call and one `token_refresh_failed` audit row. MCP `connection_ops status` and the `amcp_workspace dashboard` `connections` section return the stored record with zero network requests. Operations lists a login whose current record is `reauthorization_required` or `refresh_failed` (or one that cannot renew itself and has ended), and a turned-off connection as deferred, to workspace administrators only as `kind:connection` (OPS-06). Every browser-OAuth platform can reauthorize in place from Connections; set `AMCP_REAUTHORIZATION_DISABLED=meta,linkedin` (or `all`) to return a platform to "Connect another" only. Credentials are replaced only after verification, so the flag is always safe to set.

Disconnect is local by default: AMCP deletes its copy of a login, and the provider grant stays until it is removed in the provider's settings. `AMCP_PROVIDER_REVOCATION=on` (owner decision D19 (4), CON-05; any other value or unset is off) adds an unchecked **Also revoke AMCP's access at Google** to the disconnect dialog of a Google login. Checked, AMCP audits `provider_revocation_requested` (with the login revision), sends the login's token once in the form body to `https://oauth2.googleapis.com/revoke`, audits `provider_revocation_result`, and disconnects only after a 200 or `invalid_token`; any other answer or a lost response keeps the login (`PROVIDER_REVOCATION_FAILED`), and so does a reauthorization that lands meanwhile (`CONNECTION_CHANGED`). A session or CSRF check that fails after Google answered (say the sign-in must be confirmed again) also keeps the login, and its error carries `details.provider_revocation` with Google’s answer; after a revocation, the retry once signed in again finds the token already invalid and disconnects. Other providers have no revocation wired, test accounts (the shared reviewer password and invited test accounts) are never offered it, and MCP disconnects stay local. Google revokes the grant of one OAuth client for a Google account as a whole, and every Google surface uses the `AMCP_GOOGLE_CLIENT_ID` client unless it names its own, so the owner answers **Q25** before turning it on:

1. With a disposable Google account, connect two Google surfaces that share the client (for example Google Ads and Sheets) in one workspace and one of them in a second workspace.
2. On a deployment with `AMCP_PROVIDER_REVOCATION=on`, disconnect one login with the revocation checked; the message says its access was revoked at Google (audit outcome `revoked`).
3. Sync each other login right away and again after an hour (an access token AMCP already holds is used until it nears its expiry, at most an hour, and Google says revocation can take time). A sync that Google refuses, or a login that then shows **Reauthorization required**, means the grant is shared as the dialog warns; record the result with Q25 and keep the flag on only if that effect is acceptable.

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

GA4, GTM and Search Console have website OAuth onboarding and explicit property/account/site selection. Google Business Profile does too (CON-06): Connections lists it on the shared Google client (or `AMCP_GBP_CLIENT_ID`/`AMCP_GBP_CLIENT_SECRET`) with `business.manage`, PKCE and offline access, but only once the owner declares that Google approved the Cloud project for the Business Profile APIs (`AMCP_GBP_API_APPROVED=true`) or sets the dedicated pair; until then the card reads setup required. A new login is saved disabled, its sync lists business accounts and their locations with the collector `sync_assets` uses (100 accounts, 500 locations each), and the owner selects `locations/<id>` (and business accounts for account-level changes). Readiness reads the exact selected location (`readMask=name,title,storeCode`) or business account. A project Google has not approved answers with a quota of 0 requests per minute (or `SERVICE_DISABLED`): AMCP refuses with `BUSINESS_PROFILE_API_NOT_APPROVED`, an owner action and no retry. Renewal uses the shared Reauthorize. Amazon Ads is not offered (owner decision, CON-06 option b): it has no website login, profile discovery or implementation modules, so `amazon_native_action` is not listed in `tools/list`, the Capability Center contract reference or the Overview's provider evidence, and a call (or `amcp_tool_help`, `amcp_write` or `amcp_workspace contracts` naming it) is refused with `GATEWAY_NOT_OFFERED` before anything is read; `AMCP_PROVIDERS=amazon` offers it again for an operator-provisioned connection. Apple Ads uses client-credentials authentication with optional automatic ES256 signing; see [measurement and Apple setup](MEASUREMENT-AND-APPLE.md). Meta initial user tokens are exchanged for long-lived tokens. TikTok's current advertiser tokens are long-term and require reauthorization if revoked; its separate short-term user-token refresh API is not used for advertiser credentials.

Globally addressed Meta/Snapchat objects need recent ownership evidence from an account-scoped collection. Otherwise provision explicit resourceBindings with an accountId, exact pathPrefix and any required query invariants. These are administrator grants, not arbitrary caller input. GA4 connections bind property IDs; GTM binds account IDs; Search Console binds exact property URLs or sc-domain properties. Business Profile locations can be explicitly bound as `locations/<id>`.

Every entry point (HTTP, worker, stdio) reads the environment once through `server/config.ts`, which derives the public origin the same way everywhere and checks the production preconditions before the database opens: the HTTP server needs `MIRROR_MASTER_KEY` and an administrator password, and the standalone worker needs `MIRROR_MASTER_KEY`. In production the database must also lie inside a declared persistent mount (`RAILWAY_VOLUME_MOUNT_PATH` or `AMCP_DATA_MOUNT`) on a different device from the root file system; otherwise start-up logs `storage_not_persistent` and exits non-zero. `AMCP_ALLOW_EPHEMERAL_DB=true` overrides this for local and development use, and health then reports `storage: not_persistent`. A verified start logs `storage_verified` and checks the volume marker (`.amcp-volume-id` beside the database, matched by a database row): a mismatch after a restore or a volume move logs `storage_volume_changed` and shows in owner health until `npm run admin -- restamp-volume` re-stamps it deliberately. In production, admin commands that open `MIRROR_DB` are refused as root (run them as `gosu node npm run admin -- …`) unless `--allow-root` is given; see [Railway deployment](DEPLOY-RAILWAY.md).

Set `MIRROR_ALLOW_WRITES=true` to enable `amcp_write` prepare and execute (a read-only deployment lists it with `inspect` only), grant specific accounts, and issue operator access. The review service reads provider state, freezes requests for five minutes, verifies state again before submission, and persists idempotency across restarts. Lost or partial responses are retained and must be reconciled before new submissions. There is no automatic rollback. See [write operations](WRITE-OPERATIONS.md).

Reviewed-write execution switches, each optional and read at call time (`.env.example` lists them with their defaults): `AMCP_WRITE_NOT_SENT_RELEASE=false` records a refusal raised before the request was sent as uncertain again instead of releasing the claim; `AMCP_WRITE_REJECTED_OUTCOME=false` records a provider refusal proven non-applied (CMP-04) as uncertain again instead of rejected; `AMCP_WRITE_TARGET_LOCK=false` stops serializing executes of one target and `AMCP_WRITE_TARGET_WAIT_MS` (default 10000, at most 60000) bounds how long a second execute waits before `STATE_BUSY`; `AMCP_WRITE_GROUP_PART_SECONDS` (0-120) fixes the time each group part is given; `AMCP_PLAN_SUMMARY_HASH=false` accepts a plan approval by `plan_hash` alone; `AMCP_PROVIDER_VALIDATION` (true or false only) lets a read-only deployment run provider validation; `AMCP_PROVIDER_JOBS` (true or false only) makes provider report and export jobs their own effect, allowed in a read-only deployment and for readers on accounts granted report jobs, with `AMCP_PROVIDER_JOB_HOURLY_LIMIT` (default 1000) bounding jobs per provider account and hour (see [provider jobs](WRITE-OPERATIONS.md#provider-report-and-export-jobs)); `AMCP_WIRE_CONTRACTS` (`shadow` by default, `enforce` or `off`; anything else stops startup) decides what a request body that differs from its pinned vendor contract does, with violations counted per gateway in owner health as `wire_contract_violations` (writes, the enforcement gate), `wire_contract_read_violations` (reads, never enforced) and `wire_contract_check_failures` (the validator itself failed; the request still went out unless it was an enforced write). See [write operations](WRITE-OPERATIONS.md) and its [pinned vendor contracts](WRITE-OPERATIONS.md#pinned-vendor-contracts).

`MIRROR_FLAGS` takes a JSON object of opt-in enhancements. `{"compactSchemas":true}` lists each action once in the
tool schemas: the DV360 tool otherwise lists all 173 actions twice, with and without the `DV360_` prefix, and the
flag removes about 7 KB from every `tools/list`. The unprefixed legacy names stay accepted. Without the flag the
schemas match the captured gateway schemas exactly. The owner should enable it in production (MCP-01); whether it is
on there is a dashboard setting this repository cannot observe.

Each action of the AMCP tools reads only the arguments its contract row lists (`src/first-party-contracts.ts`, MCP-07).
In this release an argument of another action is reported under `meta.argument_warnings` and the call runs as before;
`{"actionArguments":"enforce"}` refuses it with `INVALID_ARGUMENT` naming the field. Turn it on after one release of
report-only warnings; remove it to roll back.

The MCP surface is sized for an AI client's 10,000-token output warning (owner decision D14). `tools/list` carries
routing summaries of at most 2,000 characters; `amcp_tool_help {gateway}` returns each tool's whole description and
`amcp_tool_help {gateway, operation}` the part about one action. `{"compactDescriptions":false}` lists the whole
descriptions again (rollback only). `amcp_workspace capabilities` returns a paged summary by default and the dashboard
returns counts; `{"capabilitiesGraphDefault":true}` makes the whole capability graph the default again (rollback
only). `node tools/measure-tool-list.mjs` (after `npm run build`) prints the sizes, and `tests/response-budget.test.mjs`
fails when a default view, description, help call or the campaign prompt grows past its budget.

Gateway descriptions say what AMCP runs (MCP-10). Where the captured text named a tool, provider, version or behaviour
AMCP does not have (Meta, TikTok and Snapchat "named tools", DV360 reporting, Amazon, Apple v5, commerce, the
connection operations), AMCP's own text replaces it; `amcp_tool_help {gateway}` keeps the captured text under
`captured_catalog`, and the listed schemas stay byte-identical (owner decision D17). Captured operations AMCP cannot
run stay listed but annotated (`src/unavailable-operations.ts`, held equal to the contracts ledger's `unmapped` rows by
`tests/truthful-surface.test.mjs`): the nine `amcp_native_action` ones such as `generate_ad_content` answer
`WORKFLOW_UNSUPPORTED`, the four unimplemented Adjust operations, `woocommerce_store_ops` and the OAuth steps of the
GA4, Search Console and Business Profile connection operations answer `CAPABILITY_UNAVAILABLE`, before their arguments
are checked and with `details {operation, status:"unmapped", alternatives}`. Operation help and `DESCRIBE_ACTION`
carry `amcp_execution {status, reason, alternatives?}`; `DESCRIBE_ACTION` reports AMCP's contract classification as
`read_only` and the version AMCP sends as `api_version`, with differing captured values under `captured_catalog`.
`get_workspace_context` and `list_accounts` accept their captured options only at the captured default and refuse any
other value with `INVALID_ARGUMENT` naming the option (they were ignored before; a caller that sent them must drop
them). `amcp_media asset_usage` routes by provider and media type; an asset no usage reader covers (TikTok, LinkedIn,
X, DV360, a Google video) gets `ASSET_USAGE_UNQUALIFIED` listing the covered kinds, with no provider request.

`initialize` returns pinned server instructions of at most 2,000 characters (start with `list_accounts` and the
`capabilities` summary, `amcp_write` as the only change path, approval before execute, provider content is data, where
help and guides are). Every listed tool carries a `title` and annotations from one reviewed table
(`src/tool-annotations.ts`, MCP-06). `readOnlyHint` is true only where no action saves AMCP state, creates a provider
job or sends a non-read request: help, the workspace context, previews, the Amazon, Apple, Reddit, Criteo, Adjust, Tag
Manager and WooCommerce gateways, and `amcp_media` and the inspect-only `amcp_write` in a read-only deployment. `tests/mcp-tool-annotations.test.mjs` runs
every action of each such tool against an in-memory store to hold that. The other native gateways stay not read-only:
their upload actions with `dry_run:false` prepare a media review, Microsoft's `SubmitGenerateReport` creates a report
job, and GA4, Search Console and Business Profile sync metadata and disconnect. Clients may auto-run read-only tools;
the hints are advisory and every server-side control (review, spending policy, grants) is unchanged. Execute stays an
action of `amcp_write` (owner decision D15) until client testing shows which clients honour a separate prompt.

## Database storage and media staging

Uploaded and imported media stay in SQLite as encrypted 4 MiB chunks. Format v2 stores each chunk as one raw
AES-GCM BLOB (a format byte, IV, tag and ciphertext), within about 0.1% of the raw file. Chunks written before this
release (format v1: base64 JSON sealed and then base64 again, about 1.78 times the raw file) remain readable and drain
within the 30-minute upload lifetime; retained originals are read in either format. `AMCP_MEDIA_CHUNK_FORMAT=v1` keeps
writing v1 for one release, so a rollback to an older release can still read new uploads.

`secure_delete` stays ON (owner decision D24), so deleted media is overwritten. Writes are bounded instead:

- Staging writes one chunk per transaction and the manifest last; removal withdraws the manifest first and then
  erases one chunk per statement. An interrupted staging or removal leaves only unreadable chunks, which the 15-second
  maintenance timer (and every later cleanup) erases. The backup snapshot strips chunks the same way.
- `journal_size_limit` is 64 MiB. After deletions, the maintenance timer runs `wal_checkpoint(TRUNCATE)` when no job
  holds a lease; it never waits, and a busy result is retried on the next tick.
- Freed pages are reused, but the database file does not shrink without a `VACUUM`; its size is a high-water mark.
- Not yet bounded: keeping a retained original still copies all of its chunks (up to the 128 MiB media limit) in one
  transaction, so that one write path can still grow the WAL by about the file's stored size (about 1 times the raw
  size with v2, instead of 1.78 times with v1). Free-space admission counts that copy; `journal_size_limit` returns
  the WAL to 64 MiB after the next checkpoint.

`npm run benchmark:media-storage` stages and removes one synthetic 32 MiB file per format on a temporary database
(`-- --check` exits non-zero outside the bounds). On the review workstation (2026-10-09) the staging peak was 1.127
times the encoded size in both formats (the review's scratch measurement of the earlier code found about 2 times,
because one transaction held the whole file in the WAL), the deletion log peaked at 1.01 chunks, and v2 stored 1.001
times the raw size.

Before admitting media, AMCP reads the free space of the database volume. A website upload (at its declared size), a
link or Drive import (at the 128 MiB media limit, since its size is not known yet), a review or variant staging (at
its exact size) and a retained copy are refused with retryable `STORAGE_LOW` (HTTP 503) when free space would fall
below twice the stored size plus a floor: `AMCP_STORAGE_FLOOR_MB` when set (0 to 65536), otherwise the larger of
256 MiB and 10% of the volume, capped at 1 GiB. If free space cannot be read, nothing is refused. On a small volume
this refuses large imports early; size the volume for the expected media (at least 4 GiB is a reasonable start) or
lower the floor deliberately.

Transactions retry only their `BEGIN IMMEDIATE` after `SQLITE_BUSY`, with jittered pauses, for at most 5 seconds in
total including SQLite's own wait (the same five seconds a single `BEGIN` could wait before); nothing has run when BEGIN
fails, so every kind of work may retry it. The wait blocks the HTTP process, so it is not longer than before.

### Video conversion time

`npm run benchmark:media-variants` uses the FFmpeg and ffprobe named by `AMCP_FFMPEG_PATH` and `AMCP_FFPROBE_PATH`. It
makes a synthetic 180-second 1080p H.264/AAC source (a moving test pattern with camera-like noise, about 98 MiB),
converts it to five preset variants with the production settings (libx264 veryfast, CRF 23, two threads) and reports
each time, whether the streams were copied, and the share of `VIDEO_CONVERSION_TIMEOUT_MS`. `-- --check` exits non-zero
when a conversion takes more than half of the limit; `-- --seconds=N` shortens the source and `-- --source=2160p`
measures a 4K source, which fit also converts.

Measured on the review workstation (FFmpeg 9.0, i7-12700H), which other builds shared at varying CPU load:

| Run | Landscape contain | Vertical crop | Vertical contain | Portrait contain | Square crop | Fit |
|---|---|---|---|---|---|---|
| 2026-10-11, light load | 63.7 s | 46.5 s | 42.6 s | 45.9 s | 42.4 s | no conversion |
| 2026-10-12, heavy load | 135.6 s | 167.2 s | 97.6 s | 110.8 s | 105.5 s | no conversion |
| 2026-10-12, after the changes below | 2.9 s (copied) | 147.6 s | 103.2 s | 44.9 s | 41.1 s | no conversion |

A 60-second 2160p source took 113.6 s to fit to 1920 × 1080 and 86.6 s for a vertical crop (2026-10-11).

The first run used 53% of the earlier 120-second limit, so `VIDEO_CONVERSION_TIMEOUT_MS` became 180 seconds, still
inside the five-minute reservation a variant or review holds while it is prepared (a fit conversion also uses part of
that review's five minutes). Under heavy load the earlier limit would have refused two variants, and the vertical
crop used 93% of the new one, so two conversions now do less work instead of the limit growing further (MED-04):

- A video already stored at the preset's exact size as upright H.264 (yuv420p, square pixels) with AAC or no audio is
  copied into the MP4 variant without re-encoding, as fit already does for media that fits.
- A crop cuts the centered region of the preset's shape and scales only that region (a 608 × 1080 region of a 1080p
  frame for vertical), instead of scaling the whole frame up and discarding most of it. On a 30-second clip at the same
  load this took 21–29 s instead of 31–33 s; the encode, not the scaling, remains most of the time.

What remains: a noisy 180-second 1080p source turned vertical stays the slowest case and kept less than twice its time
under heavy load; on a host that slow it can reach the limit and is refused with `MEDIA_CONVERSION_TIMEOUT`, never cut
short. A 180-second 2160p source that fits the 128 MiB media limit needs about three times the 60-second times above,
so its fit or crop variant is refused the same way. A noisy 1080p variant re-encoded to 1920 × 1080 comes close to the
128 MiB media limit, and a larger output is refused with `MEDIA_TOO_LARGE`. The production image (FFmpeg 5.1 in the
Docker build) has not been measured; run the same command in the container before relying on its headroom.

## Health and diagnostics

`/healthz` is anonymous and answers at most once per ten seconds. It reports only the state of each check, never
paths or numbers:

- `database`: a read answers. `database_write`: one small committed write to the single-row `health_probe` table
  (`ok`, `busy`, `full` or `failed`). The probe runs no cleanup scan; record expiry runs from the maintenance timer at
  most once a minute.
- `storage`: `ok`, `low` (free space below the media admission floor), `full` (under 1 MiB free, or the write failed
  for lack of space), `not_persistent` (the production start-up guard ran with the ephemeral override) or `unknown`
  (free space cannot be read, as for an in-memory database).
- `media_retention`: `stale` when the 30-minute expiry last succeeded more than four 15-second intervals ago.
- `mcp`: the offline help completes through a real MCP client and server in memory.

The status is `unavailable` (503) when a read or the committed write fails, storage is full, or MCP fails. It is
`degraded` (200) on write contention, low or ephemeral storage, stale media expiry, or unknown storage in production.
Railway runs the health check only at deploy time, so point an external uptime monitor at `/healthz` every minute and
alert on `degraded` or `unavailable` (an owner step).

Owner health (`amcp_workspace health`) and the support bundle add the deployment's storage figures (volume free and
total bytes, database, write-ahead-log and free-list bytes, page size, admission floor, mount), the release identity,
Node, SQLite and FFmpeg versions, uptime, schema version, `BEGIN` busy retries and a process-local list of the last 20
kinds of SQLite failure (name, code, surface, first and last time, count; never messages or SQL).

### Correlation and runtime identity

Metadata-only signals for following one request or job across the website, MCP, the worker and the audit (OPS-08):

- **Request IDs.** Every HTTP response carries `X-AMCP-Request-Id`, a UUID the server generates (a client's value is
  never echoed or trusted; browsers may read it on allowed MCP origins). The `/mcp` refusal and failure lines name it as
  `request_id`, a website failure uses the same ID in its body and log line, and an `mcp_tool_failed` line written
  inside that HTTP request adds it as `http_request_id` beside `requestId`, the audit record's ID.
- **Job lines.** The worker writes one `job_started` (`job_id`, `kind`, `attempt`) and one `job_finished` line per
  leased job, adding `duration_ms`, `outcome` (`complete`, `retry_scheduled`, `failed`, `released` or `lease_lost`) and
  the error `code`. Never the input, result, workspace, message or details.
- **Event-loop delay.** The HTTP server and a long-running worker sample `perf_hooks.monitorEventLoopDelay` (20 ms
  resolution). Owner health and the support bundle show `event_loop` for the process that answered: mean, p50, p99 and
  maximum delay in milliseconds for the current fixed 15-minute window and the one before. This is the baseline for
  moving collection, schedules or media out of the HTTP process; none is recorded yet (owner step).
- **Stage durations.** `operations.worker.stages.<stage>.duration` adds runs and the last, maximum and mean duration of
  each worker stage since the loop started.
- **Start line.** `http_listening` (and `runtime_started` for `npm run worker`) adds the release identity, Node, SQLite
  and FFmpeg versions, the schema version, minimum and reader versions, `migration_ms` and the ledger steps this start
  applied. It waits at most 1.5 s for the FFmpeg probe, otherwise says `checking`; `/healthz` never waits for it.
- **Recent job errors.** Owner health's newest job errors read the `jobs_tenant_updated` index in order instead of
  scanning and sorting every job.

An MCP tool call that fails on SQLite capacity returns `STORAGE_FULL` (503), and one that fails on contention returns
`DATABASE_BUSY` (503; `read_retry_safe: true`, but a write is never resubmitted: inspect its receipt). Any other
unexpected failure stays `INTERNAL_ERROR`. Every envelope keeps its request ID. When the failure's own audit append
fails too, the envelope says `audit_recorded: false` rather than pointing at an audit row that does not exist. Each such
operator-relevant failure writes one `mcp_tool_failed` log line (request ID, tool category, code, status, audit state
and the SQLite diagnostic), because JSON-RPC responses are HTTP 200 and the `/mcp` status log does not see them.

## Backup and recovery

Backups are encrypted only. `npm run admin -- backup <new-file>` (and its older name `backup-encrypted`) takes a
consistent SQLite snapshot and writes it as one AES-256-GCM archive under a key derived from `MIRROR_MASTER_KEY`
(format v2; "Secret rotation" below). Verification and
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

### Restore quarantine

A backup taken before a compromise still holds the sessions, keys and grants revoked since, so `backup-restore` and
`backup-drill` quarantine the copy by default (SEC-07). Before publishing it they end every website session, provider
authorization in progress and emailed link; revoke every API key (connector tokens, AI-client access, service keys);
end every AI-client grant (`restore_quarantine`, shown to the client and on the MCP page); clear queued e-mail payloads;
set the owner write pause on every workspace that has none; pause every active report schedule
(`pause_reason: restore_quarantine`); append `restore_quarantined` with the backup's SHA-256 and the counts to each
workspace's audit; and check the audit chain and SQLite integrity again. The receipt's `access` lists the counts.
After switching to the copy, people sign in again, owners reissue keys and AI-client authorizations, review the
restored state, then resume writes and schedules. `--preserve-access` is the explicit opt-out, for a benign restore
(a disk replacement, a drill whose copy will be discarded): the copy keeps every credential it held. Before starting
a restored copy, re-apply the erasures made since the backup (`erasure-reapply`, "Account erasure and retention").

## Secret rotation

**App secrets (`AMCP_<PLATFORM>_CLIENT_SECRET`, `AMCP_MICROSOFT_DEVELOPER_TOKEN`, `AMCP_APPLE_*`).** A saved login keeps
its own tokens and the client ID it was authorized with; the client secret, developer token and Apple signing key of
that client are read from the environment whenever the login is used (SEC-07). To rotate one, create the new secret
at the provider, set it in Railway (both services), redeploy, then revoke the old secret at the provider: no login
needs reconnecting. Logins saved before this change still hold a copy; the environment's value is used instead, and
the copy is dropped at the login's next token renewal, reauthorization or `admin rekey`. Changing the client ID itself
is a new OAuth app: logins of the earlier app keep renewing with the copy of its secret they still hold and show
`client_changed` until reauthorized; a login with no copy left asks for reauthorization without contacting the
provider. `AMCP_APP_SECRETS=copy` is the rollback lever: logins written afterwards carry the copies again, which a
release from before this change needs; set it and let logins renew before rolling back. A Google Ads login customer is
not an app secret: each login keeps its own (provisioned per login, or recorded per account by a website login's sync,
CON-05), and `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` is never injected into, or stripped from, a saved login.

**Master key (`MIRROR_MASTER_KEY`).** It seals every stored secret (logins, two-step secrets, AI-client secrets, staged
and retained media, report files, job authority, e-mail links) and, through a derived key, the backups. To rotate it:

1. Generate a new key (`npm run admin -- keygen`). In Railway, on both services, set `MIRROR_MASTER_KEY_PREVIOUS` to
   the current key and `MIRROR_MASTER_KEY` to the new one, and redeploy. Every value keeps opening (with either key)
   and new values are sealed with the new key. Website sessions, AI-client access and known-device cookies stay.
2. On the service, run `npm run admin -- rekey`. It re-seals every stored value that still opens only with the
   previous key under the new one (media chunks one per transaction, other tables in pages), drops copies of app
   secrets the environment supplies, and appends `secrets_rekeyed` to each workspace's audit. The report gives counts
   per table and the keys by fingerprint (`key_ids`), never the keys. Exit code 2 means something still needs the
   previous key; `unreadable` values open with no configured key and are left untouched.
3. Run `npm run admin -- rekey --dry-run` until it reports `complete` (writes during step 2 by an older process are
   caught here), take a new backup, then remove `MIRROR_MASTER_KEY_PREVIOUS` and redeploy.

Keep the replaced key in the secret manager while older backups are kept: verifying or restoring one needs it in
`MIRROR_MASTER_KEY_PREVIOUS`, and `rekey` on the restored copy moves it to the current key. Backups are written in the
v2 format, whose key is derived from the master key (HKDF) and named in the archive header; v1 archives (the master
key itself) are still read. `AMCP_BACKUP_FORMAT=v1` keeps writing v1 for a release that cannot read v2. Without the
previous key configured, a rotation looks to the website like an administrator password change made from the
environment: door sessions and the AI-client access approved from them end.

## Account erasure and retention

Revoking access keeps an account; erasing it (SEC-07) removes the account and its own workspace:

1. `npm run admin -- erase-account <email> --dry-run` prints the plan: per-table counts and the audit records that will
   be tombstoned, changing nothing. It reports `refused` (exit code 2) for the deployment owner's account (the
   `AMCP_TENANT_ID` workspace) and for a workspace other active members still use: remove them or move their work
   first.
2. `npm run admin -- erase-account <email> --confirm` erases, irreversibly: every session, emailed link, queued e-mail
   about the person, connector key and AI-client grant ends; the workspace's documents, saved logins, jobs, write
   claims, media, memberships and the workspace itself are deleted; the person's memberships, invitations, monitor
   subscriptions and keys in other workspaces go; the account, its sign-in identities and two-step secret are deleted.
   AMCP does not contact providers: the person removes AMCP's authorization in each provider's own settings.
3. Audit records of the erased workspace keep their place in the one hash chain with a tombstone instead of their
   payload; `account_erased` in the deployment's audit names how many and their digest, and `admin audit-verify`
   accepts a tombstone only with that receipt. Records of other workspaces keep the person's random user id.
4. Run `npm run admin -- erasure-receipts` and keep its output (random ids only) with the off-host backups. After any
   restore (an AMCP archive or a Railway volume), run `npm run admin -- erasure-reapply <receipts-file>` with
   `MIRROR_DB` naming the restored copy, before starting it: it erases again what a receipt names and the copy still
   holds, and appends `account_erased` with `reapplies`.

Retention follows owner decision P3 (2026-10-11: designed to GDPR and the KSA PDPL). The worker's hourly sweep erases
sign-ups never approved 30 days after they were made (`AMCP_PENDING_ACCOUNT_DAYS`, 1–365, or `off`) and accounts
revoked 90 days after their revocation (`AMCP_REVOKED_ACCOUNT_DAYS`, 1–3650, or `off`); each is receipted like a
confirmed erasure (`reason: pending_retention` or `revoked_retention`, `by: system:retention`), at most 100 of each an
hour. A pending account with a membership in another workspace (invited there, awaiting the owner's approval) is
kept, and so is an account whose own workspace other active members still use: the owner's access list counts those
(`retentionBlocked`) until the members are removed or the account is erased by hand. A run that erased or refused
anything appends one `retention_sweep` record (counts and periods) to the deployment's audit and writes a
`retention_sweep` log line with the counts only. The first hourly sweep after deploying this release erases pending
sign-ups older than 30 days and accounts revoked more than 90 days ago; set either variable to `off` beforehand to keep
them. An unknown value stops start-up.

People delete their own account in Account → Delete your account (`GET /api/account/deletion` previews,
`POST /api/account/delete` erases; `reason: self_service`, `by: self`). It needs the account's email address (or name,
without one) typed exactly and a sign-in or "Confirm it's you" from the last 15 minutes. It is refused for the
administrator and reviewer sign-ins and reviewer test accounts, the AMCP owner, an account whose workspace other active
members use (AMCP cannot transfer a workspace: remove them first), and while a job or a reviewed write is running in
the workspace. The answer is the erasure receipt, which the page offers as a download, and a confirmation e-mail is
queued when e-mail is configured. `AMCP_ACCOUNT_SELF_DELETION=off` turns it off (the rollback); deletion is then the
operator's `erase-account`. Add self-service erasures to the receipts kept with the backups like any other.

Report records follow a retention per document kind (`src/data-retention.ts`, until ARC-02's registry owns it):
finished Overview snapshots with their presentations and files, analyses, resolved incidents, terminal Sheets delivery
receipts and finished report jobs are deleted once older than the workspace owner's period (Settings → Storage &
retention, 7–365 days) or, without one, the deployment default `AMCP_REPORT_RETENTION_DAYS` (365 days; 7–3650, or `off`
to keep them). Before this, a workspace without a saved period kept them forever. Each hourly cleanup that deleted
something appends `report_retention_applied` (period, its source and counts per kind) to that workspace's audit.
Audit records, write receipts, active work and archived plans (their own opt-in period) are not covered.

Erasure and retention are application retention, not instant cryptographic erasure of every copy. The rows go from the
live database at once; SQLite zeroes freed pages (`secure_delete`), and an erasure asks the next maintenance pass to
truncate the write-ahead log. Copies made before then remain until they expire: AMCP backups and Railway volume
snapshots are not rewritten, and leave only by their own retention (keep it bounded, for example 35 days, and delete
older archives), by re-applying the erasure receipts to any restored copy, and, for a suspected leak of old copies, by
rotating the master key ("Secret rotation") and removing the previous key once the backups it opens have expired.

### Backups that complete

- **One step.** The snapshot is copied in a single SQLite backup step from one read snapshot, so writes by the site
  or the worker cannot restart it (the earlier 100-page steps restarted on every write from another connection; a
  local probe of a 94 MiB database with an external writer at ten writes per second did not finish in 30 s, while
  one step took 0.35 s). The WAL grows while the step reads and is checkpointed afterwards.
- **Space.** Before copying, the command checks free space: three database sizes (`page_count x page_size`) in the
  staging directory (the snapshot, VACUUM's working copy and WAL, then the verification copy) and one in the
  destination, or three in total when both share a device. It refuses with `BACKUP_SPACE_INSUFFICIENT`, naming the
  need and what is available. Set `AMCP_BACKUP_TMPDIR` to stage elsewhere; `--skip-space-check` overrides an
  estimate that is too high.
- **Destination.** With `NODE_ENV=production` (the Docker image), a destination on the same volume as `MIRROR_DB` is
  refused with `BACKUP_SAME_VOLUME`, because losing the volume would lose both; `--allow-same-volume` overrides it
  deliberately. Elsewhere the receipt reports `destination_same_volume`.
- **Receipt.** The receipt adds `created_at`, `duration_ms`, `database_bytes`, `snapshot_bytes`, `backup_steps` and
  `space_check`. Owner health shows the newest receipt by verification time with `age_hours`, and the website's
  backup card shows the age.

### Restore drill

Run one drill before relying on recovery, and again after a storage or release change:

1. **Railway volume backups (primary copy, owner).** Enable scheduled backups on the service volume in Railway. To
   drill, restore a backup to a new volume attached to a scratch service with `MIRROR_ALLOW_WRITES=false`,
   `AMCP_RUN_WORKER=false` and access restricted to the owner. Time it from starting the restore until `/healthz`
   answers; that is the recovery time. Never attach the restored volume to the production service during a drill.
2. **AMCP encrypted backup (off-host copy).** On the service (or the scratch service), run
   `npm run admin -- backup /tmp/amcp-<date>.amcp`, copy the archive off-host and delete the local copy. On a private
   machine with the same `MIRROR_MASTER_KEY` in the environment, run
   `npm run admin -- backup-drill <archive> <new-sqlite-file> --record <new-json-file>`. It restores and verifies
   exactly like `backup-restore`, then records `recovery_time_ms`, the recovery point (the newest audit event or job
   update in the copy, and its age), counts of workspaces, connections, documents, audit events, queued and running
   jobs and uncertain writes, and the reconciliation steps. It never opens `MIRROR_DB`, starts workers or contacts a
   provider, and the record holds no secrets.
3. **Record and clean up.** Keep the drill record with the date, the Railway recovery time and the AMCP record's
   recovery point (outside the repository). Delete the restored copies and the scratch service afterwards: they hold
   live encrypted credentials.

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

The audit chain (one SHA-256 chain across all workspaces) detects changes to retained records and SQL triggers prevent updates/deletes, except an erasure's receipted tombstone ("Account erasure and retention"). It has no external checkpoint service and cannot detect rollback to a previously valid backup. Keep independent backup/checkpoint records for a production deployment. Report retention applies to the selected finished report/job and resolved-incident records: the workspace owner's 7–365-day period, else the deployment default (`AMCP_REPORT_RETENTION_DAYS`, 365 days; owner `health` shows the period in force as `report_retention`, see "Account erasure and retention"); active work, open/acknowledged incidents, audit records and write receipts are preserved. Archived campaign plans are deleted only when the owner opts in (`save_retention` with `archived_campaign_plans_days` 7–3650, `0` turns it off; Settings → Campaign plans): the cleanup deletes the plan documents archived longer than that, audits `campaign_plans_purged`, and keeps audit records, write receipts and reviews; plans that are not archived are never deleted (CMP-05). Owner `health` reports `plan_inventory` (`active` plans against the `limit` of 500, and `archived` plans that do not count), the read-only baseline for how close a workspace is to the bound; Settings → Campaign plans shows the same counts. General all-record retention, external monitoring and independent checkpoints remain separate.

Local subprocess tests verified consistent backup while the source database remained open in WAL mode, restoration of encrypted credentials and committed documents, audit verification after restore, and refusal to overwrite an existing backup. Concurrent process startup now serializes database bootstrap/migrations in a transaction. Unsupported schema versions roll back attempted schema changes and close the connection. These tests do not qualify host-level disaster recovery or a production deployment.

## Schema migrations and rollback

Every start runs the schema bootstrap in one serialized `BEGIN IMMEDIATE` transaction (OPS-08): the core tables, the
version 1 to 2 upgrade, every later additive step, and the website tables, including the two `amcp_users` columns
that earlier ran outside the transaction. Each step is idempotent and recorded once in
`schema_migrations(id, applied_at, release)`. A database created before the ledger records today's steps
(`store-0001` to `store-0013`, `web-0001`, `web-0002`) as its baseline at its first start. The start line reports
`migration_ms` and `migrations_applied`; owner health and the support bundle show `runtime.schema_ledger`.

- **Versions.** `schema_version` stays 2. Each release records in `schema_meta` the oldest reader that may open the
  database it wrote (`min_reader_version`, with `min_reader_for_version`). A version 1 database is upgraded; a newer
  version opens only if its declared minimum reader is this release or older.
- **Refusal.** Otherwise start-up stops with `SCHEMA_TOO_NEW`, changes nothing and writes one `startup_failed` line
  (`stage`, `code`, the database, minimum and reader versions and this section's address; never a path or SQL). Any
  other start-up failure after the volume guard writes the same line with its stage and, for SQLite, the diagnostic.
- **Backups.** `backup-verify`, `backup-restore` and `backup-drill` accept versions 1 and 2 and any newer version
  whose declared minimum reader this release meets.

Recovering from `SCHEMA_TOO_NEW` (an older image started on a database a newer release wrote):

1. Leave the database and volume untouched; never delete the ledger or edit `schema_version`.
2. Redeploy the release that wrote the database (the line's `database_version` names its schema), or a later one.
   With a volume attached, Railway may already have stopped the previous deployment, so check which one serves first.
3. If that release cannot run, restore a backup made by this release to a new volume ([restore drill](#restore-drill))
   and reconcile everything after the backup time before enabling workers or writes.

Policy for later changes (expand, then contract):

- **Additive** (a new table, a nullable or defaulted column, an index, a trigger): a new ledger step; `schema_version`
  and `MIN_READER_VERSION` stay, so a rolled-back image still starts.
- **Document fields** (a new document kind or field inside the existing documents table, such as COM-03's
  `catalog_lineage` on campaign_run and `catalog_mapping_profile`): no SQL change and no ledger step; older releases
  ignore them. Record them in the change's own documentation instead.
- **Contracting** (a drop, a rename, a changed meaning): ship the expand step and readers of both forms first; in a
  later release bump `SCHEMA_VERSION` and raise `MIN_READER_VERSION` together (`src/schema-migrations.ts`), so older
  images refuse instead of misreading.
- **Before any `schema_version` bump** (owner): take a Railway volume backup and an AMCP encrypted backup, verify it,
  and run the new release once on a restored copy to measure `migration_ms`.
- **Health check window.** The bootstrap runs before `/healthz` answers and Railway waits 120 s. A step that takes
  more than about 60 s on the restored copy (typically a large index) is split or moved after start-up.
- **Rollback drill** (owner): start the previous image on a restored copy that the new release has opened; additive
  releases must start, contracting releases must refuse with `SCHEMA_TOO_NEW`.

## Workers and schedules

Both the embedded HTTP worker and standalone `npm run worker` use the same stage loop. Schedule,
mail and job-stage failures emit only stage/code/count/timestamp metadata and wait one second
before a new continuous cycle. Successful work drains immediately; idle cycles wait one second.
`npm run worker -- --once` runs one cycle and propagates a failed stage, so its exit remains
unsuccessful. The original one-shot exception presentation is unchanged. Shutdown waits for an
already awaited stage and starts no later mail/job stage or claim once its stop flag is observed.
Existing lease, authority, uncertain-mutation and listener cleanup rules remain. See
[local qualification and platform limits](review/DELIVERY-2026-10-05-WORKER-LOOP-RECOVERY.md).

Each stage keeps its own failure state. A stage that has been failing for more than ten seconds backs off
(2 s, 4 s, ... at most 60 s, with jitter that only shortens the wait) while the other stages keep running; a
success resets it. SQLite "full" (primary code 13) pauses every stage, since each one writes, and a small storage
probe runs every 30 seconds until a write succeeds (`worker_storage_paused` and `worker_storage_resumed` lines).
The log carries a stage's first failure at once and then at most one `worker_stage_failures` summary per stage per
minute. Owner health shows `operations.worker.stages` for the worker loop of the process that answers (the embedded
worker on Railway): each stage's state, consecutive and total failures, last code and next attempt.

Shutdown (SIGTERM or SIGINT) is graceful. The worker takes no new job and logs `shutdown_started`. A running
read-only job (`report`, `report_overview`, `report_file_export`, `write_verification`) goes back to the queue
at once, available a second later and without counting the attempt, and a report's collection budget stops charging
time for the downtime (`jobs_released`). A job that may be mid-mutation (`sheets_export`, `media_upload`,
`campaign_run` and any other kind) is never interrupted: the process waits for it. A `campaign_run` job is the
server run of an approved plan of uploads (`amcp_campaign run_background`, MED-03): it runs as the person who queued
it, one plan per person at a time (a per-person lock renewed while it runs), yields between uploads about every 20
seconds or when media capacity is busy (requeued, not failed; `CAMPAIGN_RUN_CONTINUES` while it waits, shown as
`running`), and stops after 500 turns with `BACKGROUND_RUN_TURN_LIMIT`. A background run is never queued twice for one plan: the
check and the queueing happen in one transaction. Like every job that may be mid-mutation, a `campaign_run` whose
worker process stopped twice while running it (two crashes or hard restarts during its turns) is set aside as failed
with `LEASE_EXPIRY_LIMIT` (`crash_quarantine`): the plan shows the push stopped, and the person runs it again; uploads
already done stay done and each remaining upload keeps its own review and key. `AMCP_SERVER_PUSH=false` refuses new
background runs (`BACKGROUND_RUN_DISABLED`) and returns the website push to driving each row from the page. It exits 0 (`shutdown_completed`) when everything has
settled, or 1 (`shutdown_deadline`) after `AMCP_SHUTDOWN_GRACE_MS` (default 25000, from 1000 to 600000). Keep the
platform's stop window above the grace period: on Railway, set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to at least
30 (an owner setting, recorded with the deploy settings).

Run `npm run worker` in a separate process on the same host/database. Jobs acquire 60-second leases, renew every 15 seconds, and require a matching lease token for completion. A job of any kind whose lease expires returns to the queue, and a stale worker cannot overwrite a newer result. Each expiry is counted, audited (`job_lease_expired`) and recorded as `LEASE_EXPIRED` on the job: the first is available at once (the worker died), later ones wait 5 s, 10 s, 20 s and so on up to five minutes. At the fifth expiry, or after two expiries of leases taken by another process boot that has stopped heartbeating (the job may be crashing its worker; a lease of a second worker process that still heartbeats is only slow and never counts as a crash), the job fails with `LEASE_EXPIRY_LIMIT`; inspect it, then resume it explicitly, which resets its attempts and expiry counters. Provider writes stay protected by their idempotency claims either way. Failed jobs retain their error. A prepared run never executes until activated. Reactivating a complete run does not repeat it; save/update a query or prepare a new run to request a new execution.

An Overview report saves its whole-job collection counters (written before every request) in one
`overview_report_budget` document, and each source's progress in `overview_checkpoint` documents: one per source and,
for daily, weekly or monthly grouping, one per calendar period (OPS-08). A save therefore writes only its own small
document instead of re-reading and rewriting the whole report with every row collected so far. A finished source keeps
one result document, and the snapshot assembles the rows once. Reports started by an earlier release resume from their
inline counters and checkpoints; nothing is migrated. The first save marks the report's inline counters as version 2,
so an older release refuses to resume it (`REPORT_DEFINITION_CHANGED`) rather than collect again without the counters.
Deleting a report (retention, deletion, disconnect) removes its parts in the same statement.
`npm run benchmark:report-checkpoints` measured one counter save at 25,000 retained rows on the review workstation
(2026-10-11): 21.3 ms p50 and 3.3 MB rewritten in the earlier layout, 0.09 ms and 862 bytes split, about the same as
with no rows (0.07 ms). The deployed before-and-after measure is the event-loop p99 during a large report (owner step).

Native jobs aggregate up to 25 pages and fail with REPORT_TRUNCATED if more remain. Split such queries before rerunning. JSON endpoints reject empty, malformed, null or scalar HTTP success payloads; endpoint-specific no-content or non-JSON handling must be added explicitly before implementing those routes. Reddit additionally validates request and response bodies against its saved official schemas. See docs/REDDIT.md for supported behavior. The CLI verification report excludes raw vendor response contents, but the local audit database retains redacted outcomes and must be protected as sensitive operational data.

Schedules use local IANA clock time, and enqueue atomically with the next-occurrence update. A missed occurrence is coalesced into one current run. Generic query_config accepts explicit date ranges or `{preset:"last_complete_days",days:7,timezone:"Africa/Cairo"}` under date_range; native gateway requests preserve their explicit dates. A local time that a spring DST change skips runs at the first valid time after it (for example 00:30 in a 00:00→01:00 gap runs at 01:30); autumn repeated local occurrences are deduplicated. Computing the following occurrence never drops or pauses the due run: if none is found, the schedule stays active with a `SCHEDULE_UNRESOLVED` warning (an Operations attention item) and its clock is re-evaluated after 6 hours. `AMCP_SCHEDULE_DST_POLICY=skip` restores skipping (with widened look-ahead). Each long-running worker logs a `worker_clock` line with the Node time-zone database (`tz_version`) and ICU version. Reporting Overview separately supports independent daily/weekly/monthly Sheets delivery schedules, owned destination tabs and content-bound delivery recovery; see [reporting setup](REPORTING-OVERVIEW.md). Their deliveries run as separate export jobs after collection; a failed delivery marks its schedule for attention, and repeated non-retryable failures pause it (`AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER`, default 3; see [scheduled delivery](REPORTING-OVERVIEW.md#scheduled-delivery)). Selected report retention, owned destination recovery and monitoring notification delivery/retry are implemented; see the current [workflow guide](PRODUCT-WORKFLOWS.md) for their exact scope. These do not provide generic all-provider job cancellation, arbitrary dead-letter replay or all-record retention. Inspect original run status, audit records and destination receipts before any explicit recovery.

## Provider request pacing

Each tenant/gateway pair holds a 30-request burst that refills one request every 250 ms, in process, and a shared durable budget of the same size refilling every 200 ms. A burst is _shaped_, not rejected: a request that arrives with the burst spent waits for its refill, so a bounded operation that legitimately exceeds 30 calls — Google account discovery across many accessible customers, a long paged read — completes instead of failing partway. Only a caller that stays beyond the sustained rate long enough to owe more than 2 seconds receives `TENANT_RATE_LIMIT` with an accurate `retry_after_ms`. The in-process refill is deliberately faster than the durable budget's so that shaping never starves the shared limiter. HTTP 429 responses from a provider still open a shared cooldown, and repeated failures still open the per-gateway circuit.

### Provider quota by issuer

Providers ration requests per app, not per workspace: Google per Cloud project per day, Meta per app. With AMCP-owned
credentials, one workspace's scheduled reporting could spend the quota of every workspace. Each provider permit
therefore also counts the request against its **issuer** (OPS-08), a one-way hash of the gateway and the credential
field that names the app (OAuth client ID, X consumer key, Microsoft developer token or Apple team; never the raw
value). Counts are per UTC day and workspace: requests, reserved requests, operations (Google Ads mutate operations
count one each), provider 429s, refusals and would-be refusals. They live in SQLite, so every process shares them and
they survive a restart, and they are kept for eight days.

- **Observe (default).** `AMCP_PROVIDER_QUOTA_MODE=observe` only counts. Owner health (`provider_quota`) lists the
  issuers the workspace used: deployment-wide daily counts beside the workspace's own, the profile and what remains of
  the general pool. Record seven days of this baseline before setting any profile (owner step).
- **Profiles.** `AMCP_PROVIDER_QUOTA_PROFILES` maps a gateway to `daily_requests`, `reserved_fraction` (0 to 0.5,
  default 0.1) and `tenant_share` (above 0 up to 1, default 0.5). The general pool is `daily_requests` less the
  reserved slice; one workspace may use `tenant_share` of the pool. An invalid mode or profile stops start-up.
- **Enforce.** `AMCP_PROVIDER_QUOTA_MODE=enforce` refuses a request before anything is sent, with retryable
  `PROVIDER_QUOTA_SHARE_EXHAUSTED` (429, `retry_after_ms` to the next UTC day), once the workspace's share or the pool
  is spent. Write verification read-backs and reauthorization checks may also use the reserved slice, up to
  `daily_requests`. An Overview report run, scheduled or not, asks before it starts, so a spent issuer defers the
  whole run instead of stopping it at its first request. Roll back with `observe`.
- **Not counted.** Credentials that name no app (for example a bare access token) are not issuer-counted.

## HTTP deployment

Default bind is loopback. External bind requires MIRROR_PUBLIC_ORIGIN as an HTTPS origin and a TLS reverse proxy. The service validates Host and Origin, authenticates bearer tokens, limits JSON bodies to 4 MiB, and supports stateless POST requests. Provision a distinct mirror key per operator with an appropriate role. Keys expire after 30 days by default; provision replacements and revoke old keys with `npm run admin -- revoke-key <protected-token-file>`. A key from `npm run admin -- create-key` is service-owned (SEC-06): no member's password, email or two-step change ends it, unlike the connector tokens and AI-client access the administrator door issued, which the owner account's security changes still end. The owner's health view (`service_keys`) lists every live service key of the workspace by label, role and expiry, including older server keys created before this rule; the owner's security notice says how many connector tokens and AI-client connections a change ended. `npm run admin -- mfa-reset <email>` is the instance owner's offline reset of a member who lost their authenticator and recovery codes: it turns two-step verification off and ends that person's sessions, connector tokens and AI-client connections (audited as `account_mfa_reset`); confirm the person's identity outside AMCP first ([MFA support runbook](USER-ACCOUNTS.md#required-two-step-verification-and-recovery)).

Claude remote clients can dynamically register with `client_secret_post`; public clients retain `none`. Both require S256 PKCE and consent by an active workspace member, capped by that member's role (viewers grant read only). Client secrets are encrypted at rest and must accompany token, refresh and revocation requests. Optional trusted proxy CIDRs affect rate-limit attribution only. See [OAuth hardening](OAUTH-HARDENING.md) for configuration and regression coverage.

The maintained GitHub workflow defines Docker builds and synthetic read-only/write-enabled startup, volume ownership, authentication, MCP access, restart-persistence and revocation checks. Hosted Actions are waived at the owner’s direction after exhausted minutes; no new run is started or treated as passed. Fresh exact-source/default-full/required-FFmpeg/report checks continue locally; current Linux/Docker and deployed acceptance require actual host evidence, which each Railway build supplies through its in-build check ([per-release Linux evidence](DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds), ACC-04). This does not qualify the TLS proxy, multi-host load, provider authorization, or recovery under production traffic. SQLite/WAL remains a single-host storage choice.

## Qualification records

`npm run qualify` (`tools/qualify.mjs`) composes the existing commands and writes one record per tested tree to
`.runtime/qualifications/<source_tree_hash>.json`, plus one `index.jsonl` line. The record is local and never committed
(owner decision D25 in [decisions](DECISIONS.md)); delivery notes cite its `source_tree_hash` instead of retyping counts.

- **Stages.** The deterministic freshness gates run first: TypeScript build, release identity, format check, the
  test-oracle ratchet (`check:oracles`), the `generate:*` checks, `report -- --check`, `contracts:check`,
  `contracts:actions:check` and `docs:index:check`. The full profile then probes FFmpeg and ffprobe, runs the suite with
  `AMCP_REQUIRE_FFMPEG=true`, the capture tests, the mutant catalogue (`mutant_catalogue`), the wire-contract sweep, the
  Meta creative feature pin (`meta_creative_features_pinned`: it fails unless
  `tests/fixtures/meta-creative-features-sdk-v26.json` is hashed from the SDK 26.0.2 files, as pinned on 2026-10-16, so
  a transcribed allowlist cannot qualify a release; `node tools/meta-creative-features.mjs --source-dir <directory>`
  pins it again), `check:web`, the journey and MCP evaluation
  (`journey_evaluation`, below) and the provider checks. Each stage records argv, exit code, duration, output SHA-256
  and the test totals (total, pass, fail, skipped, cancelled). Any skipped test fails the run unless named with
  `--allow-skip "<test name>"`; without FFmpeg the run fails at `ffmpeg_probe` (`FFMPEG_UNAVAILABLE`).
- **Bytes.** The record holds `source_tree_hash` (equal to a release candidate's manifest for the same tree), revision,
  `worktree_clean` and `differs_from_revision`, the lockfile SHA-256, Node, npm, OS and the FFmpeg version line, the
  packaged identity from `dist/release-identity.json` and the public asset version.
- **Sunset alarms.** The `sunset_alarms` stage runs `providers:sunsets -- --alarm` offline and records the alarms; an
  alarm never fails the run (`--now <date>` checks a later date). Date-dependent output stays out of the Docker build.
- **Reuse.** `--reuse` still runs every freshness gate. A later commit whose changes lie outside the package scope and
  `tests/` (for example docs only) and whose rebuilt package digest and asset version are equal is recorded with
  `reuse_of` instead of rerunning the suites; anything else runs the full profile again.
- **Test oracles (QA-02).** A test that expects a refusal names it: `assertRefused(result, 'CODE', {writes})`
  (`tests/helpers/assert-refused.mjs`, `.ts`) also fails on `INTERNAL_ERROR` and on any provider write.
  `npm run check:oracles` (`tools/check-test-oracles.mjs`) counts code-less `success === false` assertions and
  `assert.throws`/`rejects` without a matcher per test file against `tests/fixtures/test-oracle-allowance.json`: a new
  one fails, write, auth and export test files are held at zero, and `--update` lowers counts after a burn-down
  (`tools/oracle-burndown.mjs` rewrites only sites whose observed refusal was named, never a crash).
  `tools/refusal-exits.mjs` lists every refusal on the write, export and schedule paths that leaves something paused,
  busy, uncertain or expired, each with its exit test or the reason it is terminal
  (`tests/fixtures/refusal-exits.json`). `tests/reviewed-family-conformance.test.mjs` drives each family descriptor
  (`tests/family-descriptors/`) through review, a decisive change (`STATE_CHANGED`), a paginated snapshot and a partial
  answer; families still without one are listed under a ceiling that only falls. Contract-faithful fakes
  (`tests/helpers/contract-fakes.mjs`) check a fake's requests against the pinned vendor contracts PRV-05 enforces, with
  generators for provider doubles and cursor pages; `tests/schedule-timezone-sweep.test.mjs` sweeps every IANA zone over
  2026-2027. Every reviewed write family of an active provider has a descriptor (the pending ceiling is 0). The 11
  Criteo families are lifecycle-parked exemptions (the `parked` list of
  `tests/fixtures/family-conformance-pending.json`), valid only while `parkedProviders` in `tools/provider-lifecycle.ts`
  includes criteo: once Criteo is unparked the test fails until each ships a descriptor, and the parked list can only
  shrink. A family whose state reads are single resources the vendor never pages says so (`unpaginated`), one whose own
  prerequisite refuses the changed value at execute names that refusal (`decisive.refusal`), a spend-affecting family
  (the registry asks `spendConfirmation`) is never labelled `settings`, and a second request shape a family serves runs
  the same checks as a variant (`tests/family-descriptors/variants/`). Still open from QA-02: the manual reviewer
  samples remain with the owner.
- **Risk evidence (QA-02).** Each record carries `risk_evidence` (`tools/risk-evidence.mjs`) instead of headline
  totals: every risk class of the qualification plan (R1 money and deletion to R8 website, defined with their register
  items in `tests/fixtures/risk-classes.json`) against its evidence. `fixture` is the named synthetic test files as
  `test_suite` ran them (the stage records its `failing_files`); `conformance` is the family descriptors of the class's
  risks (R1: activation, budget, destructive) with `family_conformance` counting all descriptors by risk and the
  pending ones; `mutants` is the class's catalogued mutants as `mutant_catalogue` killed them (the stage records each
  outcome); `live` names the owner-run acceptance (ACC-01 to ACC-07) and stays `owner_step`, because a record is local
  synthetic qualification. `gaps` lists each class without conformance, mutants or recorded live evidence. A stage that
  did not run reports `not_run`, never `passed`. Every catalogued mutant belongs to a class: classify a new one in
  `tests/fixtures/risk-classes.json` (`tests/risk-evidence.test.mjs` fails until it is).
- **Mutant catalogue.** `node tools/mutants.mjs [--only <id>]` copies the candidate (tracked and untracked sources and
  the built `dist/`) to `.runtime/mutants/`, applies each catalogued defect of `tests/fixtures/mutant-catalogue.json`
  to its compiled module in turn, and runs the tests named to kill it, then the critical set. Every mutant must be
  killed: a survivor or an edit that no longer applies fails the full profile. The first full run (33 mutants,
  2026-10-11) killed 22 and recorded 10 survivors and one timeout; each survivor was then given a killing test or
  replaced where the guard is redundant by design (a second check refuses the same case), and the catalogue now runs
  with all 33 killed. Add a mutant together with the test that kills it.
- **Fast gate.** `npm run check:fast` runs only the freshness gates and writes no record. `tools/pre-push.sample` runs it
  before a push; opt in with `cp tools/pre-push.sample .git/hooks/pre-push` (never installed automatically).
- **Related tests.** `npm run test:related` selects by import-graph closure, adds the tests that read a changed `web/`
  file and a small critical set, prints selected and possible counts, and appends the freshness checks when `src/`,
  `server/`, `tools/`, `docs/`, `generated/`, `codegen/` or `.mirror/` change. `--direct` keeps the old literal-import
  selection and `--plan` prints the selection only.
- **Release candidates.** `prepare-public-release` writes manifest v2 with `worktree_clean` and `differs_from_revision`;
  the verifier still reads v1 and refuses a v2 candidate assembled from a tree that differed from its revision.
  `NOTICE.md` and `.gitattributes` ship; every allow-listed file must be tracked. File and Git failures print
  `RELEASE_PATH_UNAVAILABLE` or `RELEASE_GIT_UNAVAILABLE`, never an absolute path. Point candidates at one shared npm
  cache (`npm ci --offline --prefer-offline --cache <one absolute directory>`) instead of a cache per candidate.
- **Deployed comparison.** `npm run check:public-website -- --origin https://amcp.shop --expect-record <record.json>`
  GETs `/versionz` and `/` (no credentials, no redirects), compares package SHA-256, components, lockfile component,
  source revision and asset version with the record, and appends the observation to the record file.
- **Container parity.** `npm run qualify:container` (`tools/container-parity.mjs`, ACC-04) copies the release scope
  minus `.dockerignore` to a new directory outside any Git repository, links the installed dependencies and runs
  `npm run check` there with FFmpeg required and two test workers, as Railway's Dockerfile build does;
  `-- --test <file>` runs the build and the named tests only. Its record holds counts, hashes and exit codes.
- **Railway build evidence.** `npm run evidence:railway` turns a build log the owner exported read-only into a
  counts-only record of the Linux check for that deployment
  ([per-release evidence](DEPLOY-RAILWAY.md#per-release-linux-evidence-from-railway-builds)).
- **Pruning.** `node tools/qualify.mjs --prune --dry-run [--keep-last 5] [--keep-package <sha256>]` lists `.release`
  candidates that no record, deployed package or `.retain` file keeps. It deletes nothing; deletion stays a manual owner
  action after reviewing the list, and `--prune` without `--dry-run` is refused.

### Journey and MCP evaluation (QA-04)

`npm run eval:mcp` (`tools/mcp-eval.mjs`) measures B15's "correct next actions with fewer unnecessary calls". It runs
locally in about half a minute with zero egress. A real MCP SDK client talks to AMCP's MCP server over an in-memory
transport. The website API runs on a loopback listener over the same store, and every provider is a synthetic
in-process fake that refuses and counts any other host.

- **Journeys** (`tests/journeys/journeys.mjs`). J1 first visit to readiness, J2 brief to reviewed outcome, J3 creative
  source to lineage, J4 evidence to recommendation, J5 snapshot export, receipt and safe retry, J6 measurement repair,
  J7 failure to resume, and J8 multi-client ownership. Each has four branches: success, failure, unavailable account
  and incomplete evidence. A run records user actions, website actions, MCP tool calls, refused and repeated refused
  calls, provider requests and mutations, response bytes, approvals, and its end state. The end state is one of
  success, a handled failure (the last response offered a next step) or a dead end.
- **B15 tasks** (`tests/journeys/b15-tasks.json`). The six blueprint jobs plus two hold-out tasks that must never be
  used to tune tool descriptions. Each task runs twice. The *reference* run is the shortest correct scripted sequence
  and proves the job can be done. The *guided* run is a client that knows only the first call and then follows the
  next calls AMCP offers. Both are measured on the four B15 measures: correct tool choice, unnecessary calls, repeated
  refused calls and handoff success (the website link opens the same object).
- **Baseline.** `tests/journeys/baseline.json` is committed. `--check` (the default, and the full qualification's
  `journey_evaluation` stage) fails when a count rises or an outcome gets worse. It also fails when response bytes,
  tool-list bytes or instruction bytes grow more than 10 % plus 512 bytes, or when the tool count changes. A guided
  run that newly reaches its goal, or a dead end that gains a next step, counts as an improvement. A failure branch
  that newly "succeeds" is a regression, because a safeguard stopped holding. `--fault strip-next-call` and `--fault
  hide-attention` apply deliberate regressions so the check can be seen to fail. `--write-baseline` is the only way
  to change the baseline, and it refuses a subset or a fault. Re-baseline deliberately after a change to the MCP
  surface, such as MCP-07, and record the earlier file's git blob and its measures beside the new ones (below).
- **What the first baseline shows.** All reference runs complete. Guided runs reach the goal for T3, T5 and H2 only.
  AMCP offers no next call from `capabilities` to the live `check` (T1), from `create` to `preflight` (T2), from a
  plan summary to its uncertain step (T4), from the media library to an asset's detail (T6), or from a failed
  export's status to `retry` with the job ID that `retry` needs (H1). These are inputs to MCP-07. The baseline was
  captured after MCP-01 merged, so it is the "before" state for MCP-07 only.
- **Re-baseline after the wave 2 merges (2026-10-11).** The first baseline is git blob
  `fbbe59e8c6d4e5b03781d5369badcad381f6587a` (`git cat-file -p fbbe59e8`), captured on the wave 2 base before
  MCP-07 and the other wave 2 packages. Against the current file only sizes and the tool count differ: 28 → 27 tools
  (CON-06 no longer offers Amazon Ads), tools/list 108,128 → 97,261 bytes (MCP-07 and MCP-10 descriptions and output
  schemas), instructions 1,446 bytes in both, and response bytes per run from −4 to +6,136 (J1's four branches grow
  about 10 % with the wave 2 readiness and attention data). No count, end state, tool choice or handoff changed, so
  guided runs still reach the goal for T3, T5 and H2 only.
- **Transcript privacy.** A sanitized transcript keeps argument keys only when they name a parameter (a plain
  identifier of at most 40 characters without a run of four digits); keys made of data, such as account IDs, names or
  metric IDs used as map keys, become `<key>`. A website path keeps route segments only and otherwise becomes
  `<path>`. `args_digest` is an HMAC under a random key of the run, so it tells repeats apart within one transcript
  and cannot be reversed by hashing guesses. While a fixture is open the global `fetch` is replaced too: only the
  loopback website passes, and any other call is refused and counted (`globalEgress`), so each run asserts zero
  egress for direct calls as well as for the synthetic providers.
- **External clients** (owner decision D14). Run the same task prompts in each must-pass client, repeated so the
  results are ranges. Turn each raw call log into a sanitized transcript locally with `--sanitize <raw.json> --output
  <new file>`, then measure the runs with `--external <runs.json>`. A transcript keeps argument shapes, result codes,
  states and sizes. It is refused if it carries argument values, provider text or bodies. Record the results with
  [the evaluation record template](review/MCP-EVALUATION-RECORD-TEMPLATE.md).

The Dockerfile base image `node:24-bookworm-slim` and the apt `ffmpeg` package are tags, not digests. Pinning the base
image by digest needs the digest from a registry the owner trusts; record it in the Dockerfile with a dated comment
and refresh it monthly or on a Node 24 security release (owner action). The Railway build evidence record names the
digest the last build resolved (`base_image.digest`), which is the value to pin (OPS-08). `/versionz` reports the observed `toolchain`
(Node version, FFmpeg first line, OS ID and version, each strictly validated or `unavailable`) and the
`public_asset_version`, and owner health reports `media_processor` (`available`, `unavailable` or `not_checked`).

## Provider lifecycle

- **Dated deprecations.** `src/provider-deprecations.ts` records what a provider stops accepting inside a version
  (a route, enum value, header or field), each with its effective date (UTC), primary source and the values that stay
  accepted. From the date the named module refuses the request with `PROVIDER_DEPRECATED` before any provider request,
  citing the source: X v5 recommendation reads (now `provider_unsupported`), DV360 line item and ad group
  sensitive-category and content-rating exclusions (2026-10-01; advertiser-level targeting stays provider-checked),
  DV360 YouTube video ads without a business name and logo when the advertiser has no defaults (2026-10-12), and
  Reddit report breakdowns (2026-12-08; the reporting bootstrap lists affected saved reports and schedules first). The
  Google `developer-token` header is no longer sent.
- **Sunsets.** `providers:sunsets` keys `src/provider-sunsets.ts` by provider and version and requires an entry for
  every version AMCP can be configured to send, so it works during the Meta rollback (`AMCP_META_API_VERSION=v25.0`)
  and lists each Meta version's status. `--alarm` also reports deprecations within 90 days and a `stale_check` when a
  version's recorded check is more than 45 days old; the qualification runner records these without failing.
- **Documentation watch.** `providers:lifecycle` is offline by default: it lists unbaselined sources, `stale_check`
  sources (no successful read in 45 days), parked providers (Criteo) and the manual checks with their owner and due
  day; `--strict` exits 1 on any of them. The owner runs `--live` (public documentation GETs only, no provider API
  call) on a machine they control. Each page reports `unchanged`, `changed_requires_review`, `baseline_required`,
  `unavailable` (with a reason such as `blocked_or_empty`, `http_503` or `cross_domain_redirect`) or `parked`; only a
  change, a moved final URL or an overdue manual check exits 1. Same-registrable-domain redirects are followed and the
  final URL is recorded. After review, `--live --refresh` rewrites `.mirror/VENDOR/lifecycle-pages.json` (unavailable
  pages keep their earlier baseline); inspect `git diff` before committing it. TikTok, Amazon and Adjust are manual
  checks (the TikTok portal blocks automated reads): update `last_checked` in `tools/provider-lifecycle.ts` after
  reading.
- **Meta currency offsets.** Meta caps stated in account currency convert through
  `.mirror/VENDOR/meta-currencies.json`, captured on 2026-10-11 from Meta's Marketing API Currencies page
  (`https://developers.facebook.com/docs/marketing-api/currencies`, 66 currencies; rechecked 2026-10-12,
  `rechecked_at`). Its `sha256` seals the rows (`JSON.stringify(currencies)`); the server ignores the whole capture
  when the digest, the Meta source, the date or any row fails, and Meta caps then stay native (owner health:
  `meta_currency_offsets: not_pinned`). The page is on the documentation watch, new and without a baseline until the
  next owner-run `--refresh` records one. When it reports `changed_requires_review`, read the page, update the rows,
  `captured_at` and `sha256` together, and commit them with the watch baseline. Saved account policies keep the
  offset that converted them in `native_unit`.
  The rows were read from Meta’s public documentation during implementation (`capture` describes the readings), not
  from a byte-exact page copy: `sha256` seals the rows as recorded, so it cannot prove them against the page. Before
  release the owner checks the 66 rows against Meta’s Currencies page, or records that such public documentation
  reads were allowed, and runs the documentation watch’s `--refresh` to set its baseline; until then treat the
  offsets as awaiting owner verification.

## Accounts, reporting and operating controls

See [account setup](USER-ACCOUNTS.md), [Reporting Overview](REPORTING-OVERVIEW.md) and [implementation/acceptance notes](RECOMMENDATIONS-IMPLEMENTED.md) for owner migration, team access, MFA, custom metrics, scheduled Sheets exports, campaign preflight/recovery, spending policies, asynchronous media and encrypted backups.

### Workbook records withheld from Operations

The Operations feed shows a workbook report run or schedule only when its retained account and connection scope can
be established; others are withheld from everyone. Owner health (`withheld_workbook_records`, and the Background
work panel on the settings page) counts them by reason: `scope_unavailable` (path-only or opaque bodies, conflicting
anchors), `connection_unavailable` (the connection or account is no longer selected), `metadata_unreadable` and
`scope_check_failed` (the scope check of one record failed unexpectedly; it is counted, never fatal to the view). It
scans at most 5,000 of each and reports `truncated`, and it never lists IDs, names or bodies. A zero count in
production closes the path-only and opaque-format adapter question for B13 ([package status](review/PACKAGE-STATUS.md)).

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
[provider access register](PROVIDER-ACCESS.md) with their dates, marked stale after 90 days; the logins' last
successful sync and last sync refusal code; the latest unexpired observation of each live program check
(`program:linkedin_forecast`, `program:linkedin_audience_insights`, `program:dv360_advertiser`); the programs listed for
discovery only; and the provider acceptance ledger's counts. It is computed from stored state only, never from a
provider request, and shows no token, account ID or login name. A declaration grants nothing.

To declare an approval, edit `src/provider-access.json` (status, a short value such as `Standard`, and the day of the
declaration), run `npm run build` and `node tools/acceptance/provider-access.mjs`, and deploy. Live acceptance results
reach the ledger only through the acceptance harnesses ([acceptance runbooks](acceptance/README.md)).

### Website feature loading

The initial document contains eight shared scripts; `web/route-assets.js` declares fixed same-origin feature
dependencies. Keep top-level initialization dependencies explicit when adding a controller, especially wrappers
that capture another function. Navigation awaits all required scripts before rendering. Download errors retry
only failed files; uncertain evaluation/timeouts require full reload, since removing a script cannot establish
that it never evaluated. Existing authorization applies after loading. No account data is stored in the loader.

Each page binds every file it uses to one public snapshot (`/assets/v/<version>/…`): HTML `src`/`href`, stylesheet
`url()` references (fonts, images) and the addresses scripts build through `AMCPAssets.url`. A deploy that changes
`web/` replaces the snapshot, and the server answers `409 ASSET_VERSION_CHANGED` for the old one. When a feature
script or the Arabic catalog then fails, the page sends one `HEAD` probe (5-second bound); a 409 shows "AMCP was
updated" with **Reload page** instead of "Try again", and a reload with unsaved edits on the page asks first. Unversioned
`/assets/…` paths (legacy links only) stay `no-cache` and are compressed off the event loop at Brotli quality 5.

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
[WRITE-OPERATIONS](WRITE-OPERATIONS.md#human-approval-and-the-destructive-tier).

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
[workflow, requirements and qualification](review/DELIVERY-2026-10-04-X-CATALOG-IMPORT.md).

### Read exact supplied X catalog differences

After local source validation, choose Compare current catalog products. The read shares complete scans of at
most 1,000 listed products, repeats selected evidence and brackets catalog ownership. Grouped/unknown native
records block ambiguous missing products; unsupported/missing fields remain unknown. Matching/blocked rows
are excluded from the eligible subset. Each saved product still needs fresh native review; saving all does
not bypass the same variant guards. A saved product that still holds every supplied value when the plan reaches it
is recorded as `skipped_unchanged` with the read evidence and is not sent, so the plan can complete; it is not a
failure and needs no correction. Any difference gets an ordinary review. Unsent legacy group projections need fresh review; accepted receipts
retain original recovery. No inventory deletion or point-in-time/complete variant proof is inferred. See
[workflow and exact collection bounds](review/DELIVERY-2026-10-04-X-CATALOG-COMPARISON.md).

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
than rewriting it. See [qualification and recovery](review/DELIVERY-2026-10-04-X-CATALOG-IDENTITIES.md).

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
See [workflow, exact limits and synthetic qualification](review/DELIVERY-2026-10-04-X-CATALOG-REMOVAL.md).

**Listed products outside the source (COM-02 B; P9, as recorded in the [decision record](DECISIONS.md)).** A discontinued SKU that is no longer in the
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
[decision record](DECISIONS.md); before P9 it stayed matching); for X it stays a note on a matching product. The native
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

The measurement evidence ledger (MSR-03, owner direction P8) reads Google Ads, GA4, Meta pixels and datasets,
Snapchat and TikTok pixels, Search Console sites and Adjust apps read-only; no test event, Conversions API call or
validate request is sent ([product workflows](PRODUCT-WORKFLOWS.md)). To withdraw an adapter without a release, set
`AMCP_MEASUREMENT_LEDGER_OFF` to a comma-separated list of gateways (for example `meta_native_action`) and restart;
the ledger then refuses that gateway with `MEASUREMENT_LEDGER_UNQUALIFIED` before any provider request and lists the
remaining ones. Meta Dataset Quality needs `ads_management`, or `ads_read` with `business_management`; a login
without either keeps that layer unknown. Snap asks for review before Signal Readiness data is displayed publicly, so it
stays on signed-in workspace pages.
