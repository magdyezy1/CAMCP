---
status: record
tier: engineering
---

# Isolated encrypted backup restoration

This batch implements part of operational ticket R10. It does not qualify a
production restore, rollback, RPO/RTO or recovery of remote provider mutations.
No live database, private credential file or deployment was accessed.

## Problem and change

`backup-verify` previously constructed the configured `Store` before verifying its
archive. A synthetic reproduction proves that it created `MIRROR_DB` despite
being a verification-only command. If that configured database was unavailable
or corrupt, independent recovery could fail before reading the backup. The CLI
also had no way to retain a verified decrypted restoration.

`backup-verify` now runs independently of the configured store. The new
`backup-restore <encrypted-file> <new-sqlite-file>` command streams into a private
temporary file, authenticates GCM before SQLite access, checks integrity/foreign
keys, supported AMCP schema, audit chain and encrypted connection records, then
publishes only a complete verified file using an exclusive same-filesystem hard
link. It refuses existing target files/directories/links and orphaned SQLite
sidecars. A late competing writer cannot be overwritten. A filesystem without
hard links returns an explicit error, with no unsafe publication fallback.

The archive is read through one pinned descriptor; its receipt hashes the bytes
actually authenticated. Replacing the source pathname mid-read cannot substitute
another archive or produce a receipt for different bytes. Short writes are
handled explicitly. Snapshot data is flushed; directory syncing is reported
separately because support differs by OS/filesystem. No power-failure guarantee
is inferred from these local tests. Ordinary failures clean private staging;
forced termination can leave protected staging but no published destination.

Restoration does not change `MIRROR_DB`, start processes, activate schedules,
replay writes or complete unresolved idempotency records. It preserves the
snapshot's pending work and clearly requires reconciliation before activation.
Backups cannot contain post-snapshot provider receipts, permission changes or
session revocations; their comparison requires independent records and an
authorized operational drill. A new database path does not make an uncertain
advertising write safe to retry.

No database migration, dependency or backup format change. Existing encrypted
archives remain supported. Existing plaintext backup creation remains separate.
Integrity checks now reject authenticated SQLite files that are not AMCP databases
or contain broken foreign keys, and future schema versions fail before output.
Windows destination permissions inherit the operator's directory ACLs; POSIX
snapshots use mode 0600. Restrict destination directories on the host.

## Reproductions and validation

Logs are under `.runtime/contract-completion-20260924/`:

- `backup-recovery-baseline.log`: **0/2 passed** — verification created its
  configured database; retained encrypted restoration was missing.
- `backup-recovery-core.log`: **1/2 passed** — Windows requires a writable file
  descriptor for snapshot flushing. The private staging descriptor was changed
  from `r` to `r+`; both tests then passed.
- `backup-recovery-expanded.log`: **10/11 passed** — the intended unrelated SQLite
  fixture had zero bytes because no table was committed. Creating an unrelated
  table made it a valid SQLite/non-AMCP specimen; the schema assertion is unchanged.
- `backup-recovery-selected.log`: **38/39 passed** — the interruption fixture used
  a Windows path as a Node ESM import specifier. It now uses `pathToFileURL`.
- `backup-recovery-final-selected.log`: **39/39 passed**, no skips, 4237 ms:
  `node --test --test-concurrency=1 tests/backup-recovery.test.mjs dist/tests/recommendations-hardening.test.js dist/tests/compiler.test.js dist/tests/meta-action-aliases.test.js`.
  Fourteen new backup tests cover corruption, wrong keys, real CLI isolation,
  concurrent publication, late filesystem races, failed hard links, short writes,
  source replacement, unresolved jobs/idempotency, invalid connection encryption
  and subprocess termination before publication. Existing backup assertions remain.

Official references checked 2026-09-25: [SQLite online backup](https://www.sqlite.org/backup.html)
and [Node filesystem API](https://nodejs.org/docs/latest-v24.x/api/fs.html).
Execution uses Node 24.19.0, with synthetic databases and injected synthetic keys.
The combined sanitized candidate F now passes the full required-FFmpeg release
check: **1936 main/four capture tests, zero failures/skips**, all later check
stages and Railway compatibility. Its 641-file manifest and comparison of 584
staged code/test/guidance files are recorded in
[the exact verification record](AUDIENCE-BACKUP-VERIFICATION-2026-09-25.json).
This proves local synthetic recovery; production restore/activation and Docker
remain unverified. Initial failures above remain in the hashed evidence.
