# DV360 line item targeting — 2026-09-26

Base revision: `d72743b` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: DV360 campaigns, insertion orders and line items could be created paused, but no line item
targeting could be assigned. A line item without geography, environment or exclusions is not a
usable campaign, so this was the largest remaining DV360 campaign blocker. Google's developer
documentation is reachable from this environment again.

Contract source: Display & Video 360 API v4, read in the rendered reference on 2026-09-26, and the
pinned Discovery document `.mirror/VENDOR/dv360-v4.json` (revision 20260902):

- [advertisers.lineItems.bulkEditAssignedTargetingOptions](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.lineItems/bulkEditAssignedTargetingOptions):
  deletes, then creates, for 45 documented targeting types; the response lists updated and failed
  line items with errors.
- [advertisers.lineItems.targetingTypes.assignedTargetingOptions](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.lineItems.targetingTypes.assignedTargetingOptions)
  and its create and delete methods: the details union must match the targeting type; aliases may
  replace IDs when deleting; limits of one audience group, viewability and authorized seller status
  option, four negative keyword lists and 5,000 direct negative keywords; browser, carrier/ISP and
  language options share `negative`; YouTube & Partners line items cannot be updated.
- [Assign targeting](https://developers.google.com/display-video/api/guides/tasks/run-ad-campaign/assign-targeting):
  line items inherit partner and advertiser targeting, which cannot be updated at line item level;
  existing targeting is read with the bulk list method; a failed change leaves that line item
  unchanged but does not stop other line items of the same request.

## Change

New reviewed family `dv360_line_item_targeting` (`src/dv360-line-item-targeting.ts`) for
`DV360_ADVERTISERS_LINE_ITEMS_BULK_EDIT_ASSIGNED_TARGETING_OPTIONS` and the single
`..._TARGETING_TYPES_ASSIGNED_TARGETING_OPTIONS_CREATE` and `..._DELETE` routes.

| Part | Behaviour |
|---|---|
| Request | 1–10 line items of the selected advertiser as decimal strings; each targeting type once per delete and create list; each option holds only the details member of its type; output-only fields and `*_UNSPECIFIED` values are refused; at most 1,000 changes across the line items; no query or header overrides |
| Types | All 45 documented types can be deleted. Assigning audience groups, inventory sources and inventory source groups is refused because the review cannot yet read the advertiser's access to them |
| Values | Keyword length, words and bytes; no keyword policy exemptions (allowlisted Demand Gen only); explicit app platform; day and time hours; proximity radius ranges and 0.1 steps; one third-party verifier |
| State | Each line item (refusing YouTube & Partners, Demand Gen, archived and deletion-scheduled line items), every page of its assigned targeting of the edited types (bulk list filtered by type, up to 20 pages and 20,000 options, repeated tokens refused) and each assigned channel, negative keyword list or location list under the selected advertiser, with the matching location type |
| Checks | Deletions must exist and must not be inherited; identical assignments (including inherited ones) are refused; the documented limits and shared `negative` rules are checked on the line item's own assignments after the edit |
| Safety | `spend_change_confirmed` is required; deletions count as removals under the owner's deletion policy; an owner policy that forbids activation forbids targeting edits of active line items |
| Receipt | Bulk: every line item must be listed as updated and none as failed; a partial receipt is kept as a failure, never resubmitted and not verified as success. Create: the returned option must have the exact name, ID and type. Delete: an empty response |
| Verification | The complete targeting of the edited types is read again for every line item and compared, per line item and type, with the expected set of options after the edit, ignoring output-only fields |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`, `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (DV360 contract
version 4). Guidance: "Line item targeting" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect example.

## Tests

`tests/dv360-line-item-targeting.test.ts`, eight tests:

1. A bulk edit of a paused and an active line item reads both line items, both pages of their targeting and the assigned channel and negative keyword list; shows which line item serves; needs spending confirmation; deletes a region and an environment (by alias), adds regions, an environment, a channel exclusion, a negative keyword list and a negative keyword; writes once, verifies and replays without a second write.
2. The single create and delete routes add and remove a language on one line item and verify.
3. YouTube & Partners and archived line items, an inherited exclusion, an absent assignment, a duplicate region, a partner channel, a proximity list used as a regional list, mixed browser targeting and two viewability options are refused before any write.
4. Thirteen malformed requests (audience group, details of another type, output-only field, keyword exemption, long keyword, app without platform, reversed hours, oversized radius, unspecified enum, YouTube-only type, eleven line items, numeric IDs, empty edit) and another advertiser fail without network requests.
5. A partial bulk receipt is kept as a failure naming the failed line item, is replayed rather than resubmitted, and verification returns `WRITE_PARTIAL_OR_FAILED`.
6. Owner policies: a removal is refused when deletions are forbidden; targeting of an active line item is refused when activation is forbidden, and a paused line item is still accepted.
7. A row of another advertiser and a repeated page token never become complete state; a new assignment after review stops execution with `STATE_CHANGED`.
8. The pinned Discovery document has the three methods and a details member for each of the 45 types, which match the documented list; the contract refuses header and query overrides and another advertiser directly.

Red/green: all eight fail against a build of `d72743b` (the routes had no reviewed family,
`WRITE_CONTRACT_UNAVAILABLE`, and the module did not exist) and pass with this change. Local
log: `.runtime/dv360-line-item-targeting-20260926/red-check.log`.

## Verification

- Targeted: 114 related suites, 1,417 tests. The first run had one failure, the known Windows
  `EPERM` temporary-directory teardown flake in `tests/google-upload-restart.test.mjs`; that file
  passed 3/3 alone. Logs are under `.runtime/dv360-line-item-targeting-20260926/`.
- Guidance coverage: 253 write-path refusals across 133 modules accounted for.
- Full qualification: see
  [DV360-LINE-ITEM-TARGETING-VERIFICATION-2026-09-26.json](DV360-LINE-ITEM-TARGETING-VERIFICATION-2026-09-26.json).

Remaining rows: 926 (three DV360 rows moved to the reviewed family; DV360 blocked writes 62 → 59).
Live acceptance is unverified; it needs the updated deployment and a test advertiser with a paused
line item.
