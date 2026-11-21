---
status: current
tier: operator
---

# Schema migrations and rollback

How the database schema is migrated at start-up and how a release is rolled back. A section of the [operations runbook](../OPERATIONS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

Every start runs the schema bootstrap in one serialized `BEGIN IMMEDIATE` transaction (OPS-08): the core tables, the
version 1 to 2 upgrade, every later additive step, and the website tables, including the two `amcp_users` columns
that earlier ran outside the transaction. Each step is idempotent and recorded once in
`schema_migrations(id, applied_at, release)`. A database created before the ledger records today's steps
(`store-0001` to `store-0016`, `web-0001`, `web-0002`) as its baseline at its first start. The start line reports
`migration_ms` and `migrations_applied`; owner health and the support bundle show `runtime.schema_ledger`. Only the
store layer changes the schema: `tools/check-storage-boundary.mjs` fails on a `CREATE`, `ALTER` or `DROP` anywhere
else (ARC-02).

- **`store-0016-mcp-rate-limits`** (ARC-02) creates the `/mcp` request bucket table at start-up. Earlier releases
  created the identical table on the first admitted request, outside the ledger, so the step is additive (schema 2,
  minimum reader 2) and a rolled-back image starts and keeps using the same table.
- **The document-kind registry and repositories** (ARC-02) are code only: no table, column or row changes, and the
  service records keep their reserved partition ids (`__service_limits__`, `__amcp_system__`), so quota counters,
  heartbeats and the volume marker survive a rollback. Rolling back is deploying the previous image.

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
3. If that release cannot run, restore a backup made by this release to a new volume ([restore drill](ERASURE-AND-RETENTION.md#restore-drill))
   and reconcile everything after the backup time before enabling workers or writes.

Policy for later changes (expand, then contract):

- **Additive** (a new table, a nullable or defaulted column, an index, a trigger): a new ledger step; `schema_version`
  and `MIN_READER_VERSION` stay, so a rolled-back image still starts.
- **Document fields** (a new document kind or field inside the existing documents table, such as COM-03's
  `catalog_lineage` on campaign_run and `catalog_mapping_profile`): no SQL change and no ledger step; older releases
  ignore them. Declare a new kind, with its retention, in `src/document-kinds.ts`; a change an older release would
  misread raises the kind's `version` and, when stored documents must be rewritten, ships a ledger step
  ([Adding a document kind](../ADDING-A-DOCUMENT-KIND.md)).
- **Contracting** (a drop, a rename, a changed meaning): ship the expand step and readers of both forms first; in a
  later release bump `SCHEMA_VERSION` and raise `MIN_READER_VERSION` together (`src/schema-migrations.ts`), so older
  images refuse instead of misreading.
- **Before any `schema_version` bump** (owner): take a Railway volume backup and an AMCP encrypted backup, verify it,
  and run the new release once on a restored copy to measure `migration_ms`.
- **Health check window.** The bootstrap runs before `/healthz` answers and Railway waits 120 s. A step that takes
  more than about 60 s on the restored copy (typically a large index) is split or moved after start-up.
- **Rollback drill** (owner): start the previous image on a restored copy that the new release has opened; additive
  releases must start, contracting releases must refuse with `SCHEMA_TOO_NEW`.
