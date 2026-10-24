---
status: current
tier: operator
---

# Backup and recovery

Take an encrypted backup, verify it and restore it to a new offline copy, which is quarantined by default. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03); the restore drill is in [erasure and retention](ERASURE-AND-RETENTION.md#restore-drill).

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
