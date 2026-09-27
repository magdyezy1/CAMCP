# DV360 SDF download tasks — 2026-09-27

Base revision: `f2c29f9` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: audits and bulk edits start from Structured Data Files of the advertiser's entities. Starting
an SDF download task was a blocked write because it is a POST, although it changes nothing.

Contract source: the pinned Display & Video 360 API v4 Discovery document (`sdfdownloadtasks.create`,
`sdfdownloadtasks.operations.get`, `CreateSdfDownloadTaskRequest`, `ParentEntityFilter`, `IdFilter`,
`InventorySourceFilter`, `Operation`), checked 2026-09-27. Key facts:

- "An SDF Download Task is a long-running, asynchronous operation"; "The response will not include
  the download files, which must be retrieved with media.download".
- The request names a version and an advertiser (or partner) and filters by parent entity, by ID or
  by inventory source; the operation reports `done`, `error` and, when done, the files' `resourceName`.

## Change

New reviewed family `dv360_sdf_downloads` (`src/dv360-sdf-downloads.ts`):

| Part | Behaviour |
|---|---|
| Request | The selected advertiser (never `partnerId`), an SDF version and exactly one filter; file and filter types from the pinned enums; an advertiser filter names the selected advertiser only; up to 200 filter IDs (150 per ID list) |
| State | The advertiser |
| Safety | Nothing changes, so no spending confirmation |
| Receipt | An operation name without an error; anything else is a failure never resubmitted |
| Verification | The operation read by the receipt's name through a read bound to it, until done without an error; the verified operation and its files' resource name are then authorized for the advertiser for five minutes, AMCP's window for resources it has seen |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (DV360 contract version 17). Guidance: "SDF download tasks" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect example.

## Tests

`tests/dv360-sdf-downloads.test.mjs`, three tests:

1. A task starts without spending confirmation; verification waits until it is done, and a replay sends nothing; the verified operation and its files are then readable, another task's operation and files are not; a task filtered by line item IDs verifies too.
2. Nine malformed requests fail before any request.
3. A failed operation is a failure never resubmitted; an ignored task is not verified; the models match the pinned document; the ledger lists the write in the family.

Red/green against a build of `f2c29f9`: two of the three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE); the malformed-task test passes because the base refuses the route before any request. Local log:
`.runtime/dv360-sdf-tasks-20260927/red-check.log`.

## Verification

- Targeted: 186 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,941/1,941.
- Guidance coverage: 315 write-path refusals across 183 modules accounted for.
- Full qualification: see
  [DV360-SDF-DOWNLOADS-VERIFICATION-2026-09-27.json](DV360-SDF-DOWNLOADS-VERIFICATION-2026-09-27.json).

Remaining rows: 769 (one DV360 row reviewed; DV360 blocked writes 33 → 32). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser. How the files' bytes are
transferred through `DV360_MEDIA_DOWNLOAD` is outside this batch.
