# TikTok saved audience and identity deletion — 2026-09-27

Base revision: `5ca6357` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: saved audiences and custom identities could be created but not deleted; both rows were blocked
writes, and the creation tests asserted as much.

Contract source: TikTok API for Business v1.3 "Delete Saved Audiences", "Get details of Saved
Audiences", "Delete an identity" and "Get the identity list", read in the in-app browser on
2026-09-27. Key facts:

- `POST /dmp/saved_audience/delete/` with `{advertiser_id, saved_audience_ids}` (at most 100); "If you
  have already applied a Saved Audience to an ad group, then you can only delete the Saved Audience
  when the ad group has been deleted". `/dmp/saved_audience/list/` filters by up to 100 IDs.
- `POST /identity/delete/` with `{advertiser_id, identity_id, identity_type: CUSTOMIZED_USER}`; only
  custom identities can be deleted, and editing one means deleting it and creating a new one.
  `/identity/get/` pages custom identities 1–100 at a time.
- Both reply with `code` 0 and empty `data`.

## Change

New reviewed family `tiktok_deletions` (`src/tiktok-deletions.ts`):

| Part | Behaviour |
|---|---|
| Request | The selected advertiser and 1–100 distinct numeric saved audience IDs, or one custom identity (`identity_type` `CUSTOMIZED_USER`); nothing else |
| Scope | Reads use the vendor saved audience list, identity list, ad group and ad actions, whose required `advertiser_id` the TikTok scope rule confines |
| State | The named saved audiences or the custom identities (up to 10 pages of 100), and the advertiser's ad groups or ads (up to 10 pages of 1000) |
| Checks | Every named audience or identity belongs to the advertiser; one that an ad group (`saved_audience_id`) or ad (`identity_id`) uses is refused (`AUDIENCE_IN_USE`, `IDENTITY_IN_USE`) |
| Safety | No spending confirmation; deletions count under owner deletion policies |
| Receipt | `code` 0; anything else is a failure never resubmitted |
| Verification | The audiences or identities read again; the deleted ones must be gone |

The creation tests (`tests/tiktok-saved-audiences.test.mjs` and `tests/tiktok-identities.test.mjs`)
now expect deletion to be reviewed. Other code: `src/preflight.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (TikTok contract
version 25). Guidance: "TikTok saved audience and identity deletion" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` (the identity and saved audience
sections point to it) and an executable inspect example.

## Tests

`tests/tiktok-deletions.test.mjs`, three tests:

1. Two unused saved audiences are deleted and verify gone; a replay sends nothing; an unused custom identity found on the second page of identities is deleted and verifies gone; an owner deletion rule refuses deletions.
2. Six malformed requests (another advertiser, an empty list, an ID twice, 101 audiences, a TikTok-account identity, other fields) are refused before any request; unknown audiences and identities, a saved audience an ad group uses and an identity an ad uses are refused after reading, without writes.
3. An error reply is never resubmitted; ignored deletions are not verified; the ledger lists both writes in the family.

Red/green against a build of `5ca6357`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-deletions-20260927/red-check.log`.

## Verification

- Targeted: 198 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,980/1,980.
- Guidance coverage: 330 write-path refusals across 195 modules accounted for.
- Full qualification: see
  [TIKTOK-DELETIONS-VERIFICATION-2026-09-27.json](TIKTOK-DELETIONS-VERIFICATION-2026-09-27.json).

Remaining rows: 735 (two TikTok rows reviewed; TikTok blocked writes 180 → 178). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser.
