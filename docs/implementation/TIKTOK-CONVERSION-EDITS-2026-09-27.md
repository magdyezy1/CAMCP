# TikTok custom conversion edits — 2026-09-27

Base revision: `aef9f72` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: TikTok custom conversions could be created and used by new ad groups, but not renamed or
deleted. The update and delete rows were blocked writes, and the creation test asserted as much.

Contract source: TikTok API for Business v1.3 "Update a Custom Conversion", "Delete a Custom
Conversion", "Get the details of a Custom Conversion" and "Get pixels", read in the in-app browser
on 2026-09-27. Key facts:

- `POST /custom_conversion/update/` with `{advertiser_id, custom_conversion_id, name, description}`
  changes the name ("must start with a letter", letters, numbers, spaces, underscores or hyphens,
  at most 50 characters, not a standard event, "Duplicate names for Custom Conversion within an ad
  account are not allowed") and the description (at most 500 characters, no emoji).
- `POST /custom_conversion/delete/` with `{advertiser_id, custom_conversion_id}`. Both reply with
  `code` 0 and an empty `data`.
- The details read needs the event source, and `/pixel/list/` pages 1–20 pixels at a time.

## Change

New reviewed family `tiktok_custom_conversion_edits` (`src/tiktok-conversion-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | The selected advertiser and a numeric conversion ID; an update sets name, description or both, and nothing else |
| Names | The creation family's rule, now exported from `src/tiktok-custom-conversions.ts` as `tiktokConversionNameProblem` |
| Scope | Reads use the vendor pixel list, conversion list and ad group actions, whose required `advertiser_id` the TikTok scope rule confines |
| State | The advertiser's pixels (up to five pages of 20) and their conversions, with activity status left out; for deletions, the advertiser's ad groups (up to 10 pages of 1000) |
| Checks | The conversion belongs to a pixel of the advertiser; a name another conversion of the account uses and unchanged values are refused; a conversion an ad group optimizes for is not deleted (`CUSTOM_CONVERSION_IN_USE`) |
| Safety | No spending confirmation; deletions count under owner deletion policies |
| Receipt | `code` 0; anything else is a failure never resubmitted |
| Verification | The conversions listed again: name and description compared, or the deleted one gone |

The creation test (`tests/tiktok-custom-conversions.test.mjs`) now expects updates and deletion to
be reviewed. Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (TikTok contract version 24). Guidance: "TikTok custom conversion
edits" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example.

## Tests

`tests/tiktok-conversion-edits.test.mjs`, three tests:

1. A conversion whose pixel is on the second page of pixels is renamed and another re-described, each verified; an unused conversion is deleted and verifies gone; a replay sends nothing; an owner deletion rule refuses deletions but not renames.
2. Eight malformed edits (another advertiser, a non-numeric ID, nothing to change, a name starting with a digit, a standard event name, a long name, a rule change, emoji in the description) are refused before any request; an unknown conversion, a taken name, unchanged values and a conversion an ad group optimizes for are refused after reading, without writes.
3. An error reply is never resubmitted; ignored edits are not verified; the ledger lists both writes in the family.

Red/green against a build of `aef9f72`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/tiktok-conversion-edits-20260927/red-check.log`.

## Verification

- Targeted: 197 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,977/1,977.
- Guidance coverage: 329 write-path refusals across 194 modules accounted for.
- Full qualification: see
  [TIKTOK-CONVERSION-EDITS-VERIFICATION-2026-09-27.json](TIKTOK-CONVERSION-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 737 (two TikTok rows reviewed; TikTok blocked writes 182 → 180). Live acceptance is
unverified; it needs the updated deployment and a TikTok advertiser with a pixel conversion.
