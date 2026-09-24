# Business Profile discovery through MCP — 2026-09-25

Base revision: `b372c660a4d11df1fee2e37b55891ded1085f1b6`, only
`Codex-branch`. The captured `gmb_connection_ops/sync_assets` action previously
failed `WORKFLOW_ADAPTER_REQUIRED`. Three isolated service tests reproduce that
failure. The adapter now previews and performs bounded native discovery on an
existing provisioned Business Profile identity. No advertising or listing changes,
new provider permission, website OAuth or MCP authorization-code flow is added.

## Implementation and workflow

`src/google-business-assets.ts` owns the pure native collection contract.
`src/google-business-sync.ts` checks administrator authority and exact workspace
identity, reads credentials only on execution, takes a shared SQLite lease, and
atomically persists complete metadata with its audit event. `src/service.ts` and
`src/action-contracts.ts` share the classifier. Maintained tool help, provider
descriptor version 8, the measurement guide and two executable examples describe
the actual contract. Captured vendor material remains unchanged.

The user first selects the login through local status. Preview is the default and
shows effective fields and bounds without credential access, network or local
changes. Execution requires recorded business.manage and native access. An
explicit UUID is preferred; sole/unique enabled default selection remains
compatible. Administrators can discover a provisioned selection-required disabled
identity, but discovery never enables it or grants account access.

Account Management v1 lists accounts at page size 20; Business Information v1
lists each account's locations at page size 100 and a required read mask. Only
name, title and optional storeCode are collected for locations. Business account
IDs remain numeric to match existing native/review contracts. Location IDs retain
locations/{id}. Exact shared locations are merged with all discovered parents;
conflicting metadata fails. Native roles are metadata, not inferred AMCP grants.

At success, complete groups replace prior groups; current selected IDs and write
grants remain untouched. Account-only sync preserves old location rows and their
timestamps, and reports unchecked selected locations separately from missing
selections. Null/malformed/unknown pages, wrong resource types, duplicate IDs or
cursors, unexpected pagination, conflicting shared locations and error envelopes
fail instead of producing a successful empty discovery. Documented protobuf empty
objects remain valid empty collections. Empty optional storeCode is equivalent to
absence; a missing required title is invalid.

Bounds are 50 pages/collection, 250 native HTTP attempts including retries,
8 MiB collected JSON, 10000 unique assets, 60 seconds, 1–500 accounts and
1–500 locations/account. Defaults are 50 accounts and 100 locations/account.
The transport's native deadline covers the exact internal Business Profile GET
action. Each attempt rechecks current actor, scope, login fingerprint, lease and
time. OAuth refresh is separately bounded by the existing credential provider.
Native report text is marked untrusted; audits contain counts, not titles.

Failed runs retain previous rows with visible stale/incomplete status. Failure
persistence also rechecks authority and metadata revision, and cannot damage a
new login, revoked actor, stolen lease or newer selection. An expired operation
can mark unchanged retained rows stale while still owning its valid lease.
No partial new collection is saved and no broad grant is inferred from a parent.

## Verification

Synthetic logs retained under `.runtime/contract-completion-20260924/`:

- `business-sync-baseline-build.log` passed; baseline log has three expected
  missing-adapter failures.
- `business-sync-first*`: build and first three end-to-end fixtures passed.
- `business-sync-adversarial-build.log`: strict TypeScript caught two possibly
  undefined fixture array entries; corrected the fixture without runtime changes.
- `business-sync-adversarial2*`: build and 32 tests passed.
- `business-sync-expanded*`: 187 tests, 186 passed/one failed. The 250-attempt
  fixture exhausted the independent burst limiter first. It now advances both
  clocks by 210 ms per response, within the original 60-second deadline; neither
  production limiter nor expected exact attempt count was relaxed.
- `business-sync-final*`: build and all 187 focused/shared tests passed, no skips.
  Twenty-four Business Profile tests cover preview, identity, scopes, fields,
  native pagination, shared parents, bounds, retained failure, retry authority,
  actual attempt accounting, lease theft, two SQLite handles, restart, audit
  rollback, guide examples and provider-text handling. The shared transport
  deadline matrix now includes Business Profile.

Fresh sanitized candidate A passes the entire required-FFmpeg check: 1671 main
and four capture tests, zero failures/skips, exit code 0. Its 609-file manifest
hash is 0f4099b4b1e7d3d2a292af99be6d9e5852079c128d1e6357370f269387b966e1.
`GOOGLE-BUSINESS-SYNC-VERIFICATION-2026-09-25.json` records exact staged-source
comparison and retained initial failures. The exact post-push GitHub run remains
separate; do not infer full CI success from local tests. Local Windows validation, GitHub Ubuntu
checks, Docker execution and live provider qualification are distinct evidence.

## Sources and limits

Official v1 references accessed 2026-09-25:

- [accounts.list](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/list)
- [accounts.locations.list](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list)
- [Account resource](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts)
- [Location resource](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations)

Documented: exact origins, required read mask, scope, pagination and PERSONAL
versus other account location visibility. Synthetic: shared-parent merging,
grants/revocation, transport, failure, durability and capacity fixtures. Unverified
live: app approval, provider permissions, real metadata compatibility, listing
verification and production-scale behavior. This is an MCP metadata discovery
workflow, not website onboarding or a complete Business Profile API. There is no
resumable partial sync; account-only sync plus existing scoped reads is the bounded
alternative when the complete collection exceeds the fixed operation limit.

Inventory: 3241 actions, 438 reviewed-family, 886 blocked writes, 79 unmapped,
23 unqualified reads, eight input-dependent, four retired, 83 local workflows,
1704 native reads and 16 media workflows. Remaining CSV: 1000 rows, all 14 fields
preserved. Vendor denominator: 1208 pinned methods, unchanged. These are coverage
classifications, not a claim that every provider API or action works live.

No database migration, dependency or deployment configuration change. Roll out
code and maintained guidance together, then use an authorized read-only canary
with known direct/group/shared locations. Reconcile native IDs and membership,
verify grants are identical before/after, and validate incomplete/limit recovery.
Rollback leaves metadata and grants intact but returns this action to unsupported.
Follow-on work: website Business Profile OAuth/discovery using the same collector,
explicit schema-bound OAuth entry points, remaining native families, and live
provider approval/qualification. Do not bypass scope or reviewed-write controls
to qualify those areas.


## Confirmed GitHub result

[Run #98](https://github.com/magdyezy1/AMCP/actions/runs/36069983914) for
`8672f3a992fd423b99351a75ee904d4100988e04` succeeded in 16m 41s, observed
directly in the authenticated GitHub browser on 2026-09-25 (Cairo). The unchanged
workflow includes required-FFmpeg checks, Railway config, Docker build and both
container smoke modes. This qualifies that source batch in CI, not live provider
access or the separate subsequent authorization hardening.
