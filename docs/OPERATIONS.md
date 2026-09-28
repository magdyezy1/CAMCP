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

`npm run admin -- backup <new-file>` uses SQLite's consistent backup API. Protect database and backup files using host ACLs. Keep the master key separately and back it up in the secret manager; losing it makes encrypted tokens unrecoverable. Restore into a new path, point MIRROR_DB there, inject the same key, and run `npm run admin -- audit-verify`. Do not copy only the main SQLite file while WAL writes are active.

For encrypted archives, use `npm run admin -- backup-encrypted <new-file>`.
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

Ordinary failures remove private staging directories. A terminated process can
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
