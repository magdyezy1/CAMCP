---
status: record
tier: engineering
---

# Snapchat pixel names — 2026-09-27

Base revision: `85f8ec8` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Snapchat pixels could be read but not renamed. The account-level update (two rows with its
alias) and the organization-level update (one row) were blocked writes.

Contract source: the Snapchat Marketing API "Snap Pixel" reference, read on 2026-09-27. Key facts:

- Pixels are created in Ads Manager. `PUT /v1/adaccounts/{ad_account_id}/pixels` with
  `{pixels: [{id, name, ad_account_id}]}` and `PUT /v1/organizations/{organization_id}/pixels` with
  `{pixels: [{id, name, organization_id}]}` update them; "Attributes that can be updated: name".
- `GET` on the same paths lists the pixels of the account or organization; replies list each pixel
  with its `sub_request_status`.

## Change

New reviewed family `snapchat_pixel_names` (`src/snapchat-pixel-names.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–10 pixels, each with exactly `id`, `name` (1–375 characters) and the owner in the path (`ad_account_id` or `organization_id`); no query or header overrides |
| Scope | The selected ad account; the organization path must be that account's organization, read through a marker bound to the account just read |
| State | The account (for its organization) and the account's or organization's pixels |
| Checks | Each pixel is listed for the owner; the organization is the account's; unchanged names are refused |
| Safety | No spending confirmation; tracking and ad squads are unaffected |
| Receipt | `request_status: SUCCESS` and SUCCESS for every pixel with the same IDs; anything else is a failure never resubmitted |
| Verification | The pixels listed again and each name compared |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 16). Guidance: "Snapchat pixel names" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/snapchat-pixel-names.test.mjs`, three tests:

1. A pixel of the account and one of its organization are renamed and verify, and the alias action renames again; a replay sends nothing.
2. Nine malformed requests (empty list, other fields, a missing or foreign owner, an organization id at account level, blank or long names, the same pixel twice, another organization in the body) are refused before any request; a pixel not listed for the account, another organization and an unchanged name are refused after reading, without writes.
3. An error reply is never resubmitted; ignored renames are not verified; the ledger lists all three writes in the family.

Red/green against a build of `85f8ec8`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-pixel-names-20260927/red-check.log`.

## Verification

- Targeted: 193 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,964/1,964.
- Guidance coverage: 324 write-path refusals across 190 modules accounted for.
- Full qualification: see
  [SNAPCHAT-PIXEL-NAMES-VERIFICATION-2026-09-27.json](SNAPCHAT-PIXEL-NAMES-VERIFICATION-2026-09-27.json).

Remaining rows: 747 (three Snapchat rows reviewed; Snapchat blocked writes 69 → 66). Live
acceptance is unverified; it needs the updated deployment and a Snapchat ad account with a pixel.
