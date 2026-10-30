---
status: record
tier: engineering
---

# DV360 inventory source groups — 2026-09-27

Base revision: `b45a4b5` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: programmatic buys run on deals and auction packages (inventory sources), and line items reach
them through inventory source groups. The six group and assignment writes were blocked (six rows),
and the line item targeting contract already refuses to assign groups it cannot read.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`inventorySourceGroups.create`, `patch`, `delete`, `get`, `list`;
`inventorySourceGroups.assignedInventorySources.create`, `delete`, `list`, `bulkEdit`;
`inventorySources.list`; `InventorySourceGroup`, `AssignedInventorySource`,
`BulkEditAssignedInventorySourcesRequest`) and the
[inventorySourceGroups reference](https://developers.google.com/display-video/api/reference/rest/v4/inventorySourceGroups),
read on 2026-09-27. Key facts:

- The advertiser named in `advertiserId` owns a group it creates; "the parent partner will not
  have access". A partner-owned group is written only by its partner; advertisers it is shared with
  can read it. The group resource has no owner field.
- `displayName` (required, at most 240 UTF-8 bytes) is the only writable field.
- bulkEdit "will delete the assigned inventory sources provided in ... deleted_assigned_inventory_sources
  and then create" the new ones; it names the owner in the body.
- `inventorySources.list` with `advertiserId` returns the sources that advertiser can access, without
  archived ones unless filtered; it cannot filter by ID.

## Change

New reviewed family `dv360_inventory_source_groups` (`src/dv360-inventory-source-groups.ts`):

| Part | Behaviour |
|---|---|
| Request | Groups: create `{displayName}`, patch with `updateMask=displayName`, delete. Assignments: create `{inventorySourceId}`, delete by assignment ID, bulk edit of 1–1000 distinct changes. Always `advertiserId` of the selected advertiser (query, or body for bulk edit); `partnerId` refused |
| Scope | A new authorizer admits these writes and advertiser-named reads of groups, assignments and inventory sources (get and list); partner access stays out of scope |
| State | The advertiser; the group with every assignment (bounded at 5,000); for sources to assign, the advertiser's inventory sources page by page until each is found (bounded at 5,000) |
| Checks | Unknown assignments, sources already in the group, sources the advertiser cannot use, a source removed and added again, an unchanged name and a missing group are refused |
| Safety | Membership changes and group deletion need `spend_change_confirmed`, count as activation under owner policies, and removals count as deletions; creating and renaming do not |
| Receipt | 200 with the created or updated group, the new assignment(s) naming the requested sources, or an empty deletion body; anything else is a failure never resubmitted |
| Verification | The group read again: its name, its absence, or every assigned inventory source |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`,
`src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (DV360 contract
version 14). Guidance: "Inventory source groups" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect example.

## Tests

`tests/dv360-inventory-source-groups.test.mjs`, six tests against a synthetic DV360 that pages two
rows at a time and refuses advertiser writes to a partner group:

1. A group is created (no spending confirmation), renamed and deleted (with confirmation), each verified; a replay sends nothing.
2. Sources are assigned, removed and bulk edited after reading every assignment and three pages of sources, each verified.
3. Thirteen malformed requests fail before any request.
4. An unknown assignment, an assigned source, an unshared source, a removed source added again, an unchanged name and a missing group are refused without writes.
5. A shared partner group is refused by DV360 and never resubmitted; owner activation and deletion rules apply; an ignored assignment is not verified.
6. The models match the pinned document; native reads are scoped to the advertiser (partnerId refused); the ledger lists the six writes in the family.

Red/green against a build of `b45a4b5`: all six tests fail (no reviewed family, and inventory reads were outside the scope guard). Local log:
`.runtime/dv360-inventory-groups-20260927/red-check.log`.

## Verification

- Targeted: 162 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,846/1,846.
- Guidance coverage: 283 write-path refusals across 160 modules accounted for.
- Full qualification: see
  [DV360-INVENTORY-SOURCE-GROUPS-VERIFICATION-2026-09-27.json](DV360-INVENTORY-SOURCE-GROUPS-VERIFICATION-2026-09-27.json).

Remaining rows: 839 (six DV360 rows reviewed; DV360 blocked writes 42 → 36). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser with inventory sources.
