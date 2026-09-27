# Snapchat audience segment deletion — 2026-09-27

Base revision: `7c5d198` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Snapchat audience segments could be created and updated through reviewed requests but not
removed. Segment deletion (two rows with its alias) was a blocked write.

Contract source: the Snapchat Marketing API Audiences reference ("Delete a Segment") and the example
targeting specs, read on 2026-09-27. Key facts:

- `DELETE /v1/segments/{segment_id}` answers `request_status: SUCCESS` with an empty `segments` list;
  "Deleted Audience segments cannot be retrieved so use this method with caution."
- Ad squads name segments in `targeting.segments` as `{segment_id: [...]}`, optionally with
  `operation: EXCLUDE`. The reference does not say what happens to them when a segment is deleted.

## Change

New reviewed family `snapchat_segment_deletions` (`src/snapchat-segment-deletions.ts`):

| Part | Behaviour |
|---|---|
| Request | The segment in the path only; no body, query or header overrides |
| Scope | The segment path needs a segment listed from the selected ad account, as for segment updates |
| State | Every segment and every ad squad of the account, following cursors (up to 5000 each) |
| Checks | The segment belongs to the account; one that an ad squad includes or excludes is refused with `AUDIENCE_IN_USE` |
| Safety | Deletions count as deletions under owner policies; no spending confirmation |
| Receipt | `request_status: SUCCESS`; anything else is a failure never resubmitted |
| Verification | The account's segments listed again: the segment is gone |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Snapchat contract version 11). `tests/snapchat-segments.test.mjs` no
longer lists deletion among the blocked segment writes. Guidance: "Snapchat segment deletion" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/snapchat-segment-deletions.test.mjs`, three tests:

1. An untargeted segment is deleted after reading every segment and two pages of ad squads, and verifies gone; a replay sends nothing.
2. Segments that ad squads include or exclude are refused with `AUDIENCE_IN_USE`; an unlisted segment is refused by scope and an unknown one after reading; an owner deletion rule refuses the deletion.
3. An error reply is never resubmitted; an ignored deletion is not verified; the ledger lists both writes in the family.

Red/green against a build of `7c5d198`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-segment-delete-20260927/red-check.log`.

## Verification

- Targeted: 183 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,931/1,931.
- Guidance coverage: 312 write-path refusals across 180 modules accounted for.
- Full qualification: see
  [SNAPCHAT-SEGMENT-DELETION-VERIFICATION-2026-09-27.json](SNAPCHAT-SEGMENT-DELETION-VERIFICATION-2026-09-27.json).

Remaining rows: 774 (two Snapchat rows reviewed; Snapchat blocked writes 83 → 81). Live acceptance
is unverified; it needs the updated deployment and a Snapchat ad account.
