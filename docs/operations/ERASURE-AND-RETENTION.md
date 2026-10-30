---
status: reference
tier: operator
---

# Account erasure, retention and the restore drill

What AMCP deletes and when (owner decision P3), how erasures survive a restore, backups that complete, and the restore drill. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

## Account erasure and retention

Revoking access keeps an account; erasing it (SEC-07) removes the account and its own workspace:

1. `npm run admin -- erase-account <email> --dry-run` prints the plan: per-table counts and the audit records that will
   be tombstoned, changing nothing. It reports `refused` (exit code 2) for the deployment owner's account (the
   `AMCP_TENANT_ID` workspace) and for a workspace other active members still use: remove them or move their work
   first.
2. `npm run admin -- erase-account <email> --confirm` erases, irreversibly: every session, emailed link, queued e-mail
   about the person, connector key and AI-client grant ends; the workspace's documents, saved logins, jobs, write
   claims, media, memberships and the workspace itself are deleted; the person's memberships (with the client access
   set each one limited them to), invitations, monitor subscriptions and notices and keys in other workspaces go (the
   document kinds `src/document-kinds.ts` declares with `person`); the account, its sign-in identities and two-step
   secret are deleted.
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

Every stored document kind has a declared retention (owner decision P11): the document-kind registry,
`src/document-kinds.ts` (ARC-02), declares it once per kind, the sweeps apply it from there, and
[Document kinds and retention](../DOCUMENT-KINDS.md) lists every kind with its rule. Report records follow the report
retention: finished Overview snapshots with their presentations and files, analyses, resolved incidents, terminal
Sheets delivery receipts and finished report jobs are deleted once older than the workspace owner's period (Settings →
Storage & retention, 7–365 days) or, without one, the deployment default `AMCP_REPORT_RETENTION_DAYS` (365 days;
7–3650, or `off` to keep them). Before this, a workspace without a saved period kept them forever. Each hourly cleanup
that deleted something appends `report_retention_applied` (period, its source and counts per kind) to that workspace's
audit. Audit records, write receipts, active work and archived plans (their own opt-in period) are not covered.

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
