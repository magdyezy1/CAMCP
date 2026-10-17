# Adding a document kind

How to store a new kind of record, or change an existing one, without weakening workspace isolation, retention,
account erasure or backups (ARC-02). The registry is `src/document-kinds.ts`; the reference generated from it, with
every kind's retention, is [Document kinds and retention](DOCUMENT-KINDS.md).

## Declare the kind

Add one entry to `documentKindSpecs` in `src/document-kinds.ts`. An application module that names a kind the registry
does not declare fails `tools/check-storage-boundary.mjs` and `tests/document-registry.test.mjs`.

- `scope`: `tenant` for a workspace's record. `service` only for deployment-wide records (limits, heartbeats, cursors,
  the volume marker), with the `partition` that stores them (`limits` or `system`); the store refuses a partition id as
  a workspace.
- `owner`: the module that owns the payload's shape. `summary`: one plain sentence about what a document holds.
- `version`: start at 1 (see "Changing a kind" below).
- `fields`: the store contract, the top-level fields the store layer reads (a retention clock, a login or person
  field), with their JSON types; a trailing `?` marks an optional one. `store.repo(kind).put` refuses a payload that
  breaks it. Every other field belongs to the owner module.
- `retention`: when its documents are deleted. Choose the narrowest rule that is true:
  - `report`: the workspace's report retention period, counted from the listed fields, in the hourly report cleanup's
    `order` (add its statement to `src/retention-repository.ts`; a test holds the two lists equal);
  - `with_parent`: deleted with another document (`link` names it);
  - `expires`: past a deadline field; `by: 'owner_module'` means the owner module calls
    `store.repo(kind, workspace).purgeExpired(now)`, and `strict`, `missing` and `unless` state the exact condition;
  - `period`: a fixed number of days after a clock field;
  - `owner_opt_in`: only after a period the workspace owner chooses;
  - `replaced`: one small document per key, rewritten in place;
  - `workspace`: kept while the workspace exists (it still goes when the workspace is erased);
  - `deployment`: kept with the deployment, for erasure receipts and the volume marker only.
- `person`: the document belongs to a person in someone else's workspace (their user id as the document id, or in a
  field, or their e-mail hash). Account erasure then deletes it in every workspace.
- `connection`: the document was read through a login. Also delete it in `src/connection-disconnect.ts`; a test holds
  the disconnect's list equal to the declarations.
- `backup`: leave the documents out of encrypted backups (`excluded`, or `excluded_upload_origin` for website uploads).
- `indexes`: the indexes and triggers on `documents` that serve the kind; the schema ledger creates them, and a test
  holds the database's indexes equal to the declarations.

Then regenerate the reference: `npm run build && node dist/tools/document-kinds-doc.js`.

## Read and write it

Use the kind's repository, which binds every statement to one workspace and kind: `store.repo(kind, workspace)`, or
`store.serviceRepo(kind)` for a service record. It offers `get`, `find`, `payload`, `text`, `has`, `list`, `put`,
`delete`, `deleteRevision`, `findBy`, `deleteBy`, `field`, `newest`, `sum`, `range`, `deleteRange`, `keepNewest`,
`fieldsByAge`, `purgeExpired` and `countUnexpired`. Field names are validated; values are always bound parameters.

A query the repository cannot express (a projection, a join, an aggregate) belongs in a store-layer repository module,
`src/<area>-repository.ts`, for example `src/report-repository.ts` or `src/workbook-repository.ts`, or, for the
website's own tables (sessions, sign-in identities, AI-client grants, attempt counters), `server/<area>-repository.ts`:
name a function for the question it answers, bind it to `tenant_id=?` and keep projections bounded (metadata only,
never whole rows of another record). Statements on deployment-wide tables (AI-client registrations, attempt counters)
say so in their module. Moving an existing statement, move it verbatim first and change it in a separate step.

## The storage boundary ratchet

`node tools/check-storage-boundary.mjs` (`npm run check:storage`; the test suite runs it too) counts, for every module
outside the store layer (`src/store.ts`, `src/schema-migrations.ts`, `src/document-kinds.ts`, the repositories
`src/*-repository.ts` and `server/*-repository.ts`, and `server/web-store.ts`), its SQL literals, `json_extract` uses,
database handle uses and the document kinds its SQL names, against `tests/fixtures/storage-boundary-allowance.json`.
Values may only fall: a module may not gain raw SQL, and a module without an allowance may not hold any. When a change
removes some, lower the allowance with `--update`. An integration that deliberately records new raw SQL uses
`--update --accept-increase` and says so in its commit; even then at most 15 modules outside the store layer may hold
SQL and their SQL may name at most 10 document kinds (the ARC-02 targets, held by `tests/storage-boundary.test.mjs`).
Schema changes (`CREATE`, `ALTER` or `DROP` of a table, index, trigger or view) outside the store layer always fail: add
a step to the schema ledger instead.

The modules that still hold SQL are listed in the allowance file. Most belong to the website's account flows
(`server/user-accounts.ts`, `server/account-security.ts`, `server/mfa-policy.ts`) or to the reviewed-write path
(`src/write-review.ts`, `src/write-groups.ts`, `src/write-approval.ts`, `src/spend-policy.ts`, `src/cap-overrides.ts`);
move their statements the same way, verbatim, one module at a time. `store.db` stays readable for tests and the store
layer; `store.sql()` is the store layer's accessor, and the ratchet counts both outside it.

## Changing a kind: versions, migrations and rollback

- **A new optional field** the store layer does not read: no version change and no ledger step; older releases ignore
  it. Note it in the owner module's documentation.
- **A field the store layer reads** (a retention clock, a person or login field): declare it in `fields` and keep
  writing it; documents written before it existed must still be handled by the rule (for example `missing`).
- **A change an older release would misread** (a renamed or re-typed field, a new meaning): raise the kind's `version`,
  ship readers of both versions first, and rewrite stored documents only when they must change, with a schema ledger
  step (`store-00NN-<what>` in `src/store.ts`) that is idempotent and bounded. Follow docs/OPERATIONS.md, "Schema
  migrations and rollback": an additive change keeps `MIN_READER_VERSION`; a contracting change raises it together
  with `SCHEMA_VERSION`, so an older image refuses with `SCHEMA_TOO_NEW` instead of misreading.
- **A new index or trigger**: a schema ledger step, declared in the kind's `indexes`.
- **Rollback**: the registry and the repositories are code. A release that only adds kinds, repositories or
  declarations rolls back by deploying the previous image; tables, rows and the service partition ids
  (`__service_limits__`, `__amcp_system__`) are unchanged.
