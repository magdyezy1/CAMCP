---
status: record
tier: engineering
---

# DV360 custom bidding scripts and rules — 2026-09-27

Base revision: `607d20d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: custom bidding algorithms could be created and renamed, but an uploaded script or rules file
could not be registered for them. Script and rules creation (two rows) were blocked writes.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`customBiddingAlgorithms.scripts` and `.rules`, create, list and get), checked 2026-09-27. Key
facts:

- `uploadScript` / `uploadRules` return a reference (`customBiddingAlgorithms/{id}/scriptRef/{ref}`
  or `.../rulesRef/{ref}`) and `media.upload` takes the file; both stay outside this contract.
- `POST .../scripts` with `{script: {resourceName}}` and `POST .../rules` with `{rules:
  {resourceName}}` register the file; all other fields are output only (ID, state, active, errors).
- "Requests creating a custom bidding script under an algorithm assigned to a line item will return
  an error", as do rules requests. Lists page with `pageToken` (up to 200 per page).

## Change

New reviewed family `dv360_custom_bidding_files` (`src/dv360-custom-bidding-files.ts`):

| Part | Behaviour |
|---|---|
| Request | The algorithm in the path, the selected advertiser in `advertiserId` (no `partnerId`), and a body with only the file reference, which must belong to that algorithm |
| Scope | Internal reads name the selected advertiser as accessor: the algorithm and its scripts or rules |
| State | The algorithm (owner, type, status) and the references of its files (up to 1000, following page tokens); processing state and the active flag are left out so they cannot make a review stale |
| Checks | The advertiser owns the algorithm; scripts need `SCRIPT_BASED`, rules `RULE_BASED`; archived algorithms and files already registered are refused |
| Safety | No spending confirmation: DV360 refuses files for an algorithm a line item uses |
| Receipt | 200 with the new ID for this algorithm and the same reference; anything else is a failure never resubmitted |
| Verification | The files listed again with the new ID and its reference |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (DV360 contract version 18). Guidance: "Custom bidding scripts and
rules" in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` (the algorithm section
now points to it) and an executable inspect example.

## Tests

`tests/dv360-custom-bidding-files.test.mjs`, three tests:

1. An uploaded script is registered for a script algorithm after following the page token, and verifies; a replay sends nothing; uploaded rules are registered for a rules algorithm and verify.
2. Five malformed requests (another algorithm's reference, a rules reference for a script, output fields, a script body for rules, a malformed reference) are refused before any request, as is partner access; an unknown algorithm, a partner's algorithm, the wrong type, an archived algorithm and a file already registered are refused after reading, without writes.
3. DV360's refusal for an algorithm a line item uses is never resubmitted; a receipt for another algorithm is not accepted; ignored registrations are not verified; the ledger lists both writes in the family.

Red/green against a build of `607d20d`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/dv360-custom-bidding-files-20260927/red-check.log`.

## Verification

- Targeted: 195 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,970/1,970.
- Guidance coverage: 326 write-path refusals across 192 modules accounted for.
- Full qualification: see
  [DV360-CUSTOM-BIDDING-FILES-VERIFICATION-2026-09-27.json](DV360-CUSTOM-BIDDING-FILES-VERIFICATION-2026-09-27.json).

Remaining rows: 743 (two DV360 rows reviewed; DV360 blocked writes 32 → 30). Live acceptance is
unverified; it needs the updated deployment and an advertiser with an uploaded custom bidding file.
