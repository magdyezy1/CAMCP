# Operating and qualifying this candidate

The supported deployment remains one application replica with a persistent local SQLite volume. Coordination tests cover two workers sharing one database, not network filesystems or independent replica volumes. No new service is required.

## Release gates

Assemble with `node tools/prepare-public-release.mjs .release/<new-name>`. This rejects reused directories and symlinks, includes required guidance modules, excludes runtime/private files, and hashes every copied file. Inside that candidate run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run check`, and `node deploy/check-railway.mjs`. Release CI installs FFmpeg, requires its real transformation tests, builds that exact candidate, and runs both container write modes. Keep the manifest, test evidence and image digest together. A successful source-tree test is not a substitute for these gates.

Preserve the previous image and take an encrypted backup before a separately authorized deployment. This change adds tables/documents without removing existing fields. Older applications ignore these additions but also omit their security corrections. Rolling code back can therefore restore defects. Do not restore an older database with writes enabled: reconcile all remote changes and idempotency claims since that snapshot first.

## Recovery and support

`amcp_workspace` with `action: "health"` includes workspace provider request/error/429/latency counters, queue age, active byte reservations, and worker heartbeat state. `action: "support_bundle"` returns aggregate counters and recent job IDs/error codes without account names, payloads, credentials, source URLs or actor bindings. Both require owner access. Missing heartbeat means not observed; older than 90 seconds means stale. Public `/healthz` remains process liveness only.

Campaign `get` and media `recovery` expose a versioned operation journal. Claims commit before remote mutation. Recorded allocation IDs and byte offsets survive restart. These are diagnostic records; they cannot override write claims, actor checks, grants or job lease ownership. Legacy records have an unknown phase. Unknown creates/finalizations never receive a new automatic idempotency key. Completed steps replay stored receipts and use scoped read-back.

The Media library lists unfinished reviews for their current owner and account grants, with the original request/hash and only the applicable review or same-session resume control. After completion outside the runner, Campaign `reconcile_step` requires the completed original receipt and fresh scoped readiness/read-back. It cannot override an absent or uncertain claim, assign a guessed ID, or execute a provider mutation. Dependent work remains blocked until verification succeeds.

Google video upload capabilities are encrypted, bound to the workspace/review, and expire with the original five-minute review. Explicit media `resume`, with that same review/key and confirmation, is available only before any attempted finalization. It revalidates grants, account state, frozen bytes and Google's authoritative byte offset, then continues that existing session. A lost finalization remains uncertain; other providers have no newly assumed resume contract. See [Google's upload protocol](https://developers.google.com/google-ads/api/docs/assets/upload-videos), reviewed 2026-09-12, updated 2026-09-10. Qualification of real v23 accounts is still required.

Report creators are revalidated for queued work. A legacy ownerless job fails with `JOB_REAUTHORIZATION_REQUIRED`; a current operator explicitly resumes it. Revoked schedules require an authorized operator to resave them. This is an intentional security migration, not a reason to assign a permanent administrator worker identity.

## Capacity and retention

Media downloads stream to 4 MiB encrypted SQLite chunks. Upload/conversion still uses a bounded full-file buffer. Before download, inspection, conversion or upload, a shared byte reservation covers six times the file's size when AMCP already holds it (at least 64 MiB), and six times the configured maximum file size for a download of unknown size (MED-02; see [media capacity](../MEDIA-UPLOADS.md#media-capacity)). `AMCP_MAX_MEDIA_MB` defaults to 128. `AMCP_MEDIA_MEMORY_MB` defaults to 768 for that limit: still one maximum-sized operation at a time across workers, while small ones run together, at most eight at once and four per workspace. A configured budget must be an integer at least six times the file limit and at most 8192 MiB; invalid values use the conservative default. Raising concurrency requires a measured host budget, including Node, SQLite cache and FFmpeg. Reservations and staged bytes expire and are pruned by the worker. Never describe this as zero-copy or as a measured production capacity guarantee.

The local 128 MiB fixture measured approximately 223 MiB additional RSS for download/staging/materialization; it does not measure live multipart encoding or FFmpeg peak memory. CI requires real FFmpeg transformations. Measure host peak RSS, queue wait, provider 429s, job duration and disk growth at the agreed number of concurrent users before increasing limits. Workspace report retention is configurable from 7–365 days; write receipts and audit history remain protected. Provider maps refuse new load at 4096 active entries and prune inactive debt only after its refill window.

Fair dispatch rotates among workspaces with ready jobs while retaining each workspace's due order. Lease tokens fence expired workers. Wall-clock corrections cannot refill the shared provider budget twice; memory pacing uses monotonic time. A large forward clock jump can expire a lease, requiring fencing and revalidation. Operate with synchronized host time.

## Backup restoration exercise

The encrypted backup command in the CLI uses SQLite's backup API and AES-256-GCM. Verification decrypts only a disposable copy, checks SQLite integrity and the audit chain, and verifies credential decryption with the matching key. Receipts now include measured restoration duration and explicitly exclude a claim about production RPO/RTO. Keep the encrypted copy off-host and the master key separately. An owner must set backup frequency/retention, accept the target recovery point and duration, and exercise a recent authorized copy. Local synthetic tests establish mechanics only. After a real restore, keep writes disabled until post-snapshot provider mutations and outstanding schedules have been reconciled.

Initial proposed objectives are zero duplicate submissions of uncertain mutations and 99% of scheduled collections starting within five minutes at agreed capacity. These are owner decisions and staging acceptance targets, not currently established service promises.

## Provider and guidance ownership

`src/provider-contracts.ts` names the integration-maintainer role, API/header version, public documentation, fixture tests, capability limits and unverified live status for all 19 families. Assign a named maintainer operationally. Run `npm run providers:check` for captured contract integrity. The manually dispatched Public provider contract drift workflow compares only allowlisted public schemas; it receives no advertising credentials, opens no issues automatically and changes no catalog.

On drift: retain the report, classify endpoint removal/field or enum change/deprecation/approval issue, record a sunset date when officially announced, then update the owned request, scope, response, write-state and read-back fixtures together. Run generated catalogs, guides, formula/export reconciliation and release gates before rollout. A 403 is evidence of denial, not proof of one specific missing permission. App configuration, scopes, account roles, quota/project access and provider approval remain separate evidence.

Only an authorized live qualification can add an account/action/time/API-version-scoped readiness receipt. Public documentation and synthetic fixtures never promote live-read or live-write status. Business targets, conversion definitions, regulated-category declarations and provider approvals cannot be supplied by engineering defaults.
