# Meta ad image deletion and custom conversion creation — 2026-09-27

Base revision: `9782618` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: two single Meta rows block routine account upkeep: deleting unused images from the ad account
library, and creating the custom conversions that ad sets optimize for.

Contract source: the Marketing API v25.0 "Ad Image" reference (Reading, Deleting) and "Ad Account
Customconversions" reference (Creating), read on 2026-09-27. Key facts:

- `DELETE act_{ad_account_id}/adimages` takes the image `hash` and answers `{success}`; "You can only
  delete ad images not currently being used in an ad creative". Images read with status `ACTIVE`,
  `INTERNAL` or `DELETED`, and the list takes `hashes`.
- `POST act_{ad_account_id}/customconversions` requires `name` and takes `rule`,
  `event_source_id`, `custom_event_type` (20 values), `default_conversion_value`, `description`,
  `advanced_rule` and `action_source_type`; it answers the new ID. Updating and deleting are not
  available on that edge.

## Change

Two new reviewed families:

| Family | Behaviour |
|---|---|
| `meta_ad_images` (`src/meta-ad-images.ts`) | Deletion by hash only; the image is listed by hash first (it must exist and not be DELETED); Meta's refusal for an image in use is a failure never resubmitted; owner deletion rules apply; verification lists the image again and expects it gone or DELETED |
| `meta_custom_conversions` (`src/meta-custom-conversions.ts`) | Creation with a name of up to 100 characters, a pixel of the account, an explicit JSON-object rule and the documented optional fields; advanced multi-source rules are refused; pixels and custom conversions are listed first (names unique in any case among unarchived ones); no spending confirmation; verification lists the conversions and compares the new one, the rule as JSON |

Both read through account-scoped list paths, so no object ownership is needed. Other code:
`src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Meta contract version 14). Guidance: "Ad images and custom conversions"
in `Skills/amcp-campaign-builder/references/meta.md` and two executable inspect examples.

## Tests

`tests/meta-ad-images.test.mjs`, three tests:

1. An unused image is deleted and verifies as DELETED or as gone, and a replay sends nothing; an owner deletion rule refuses the deletion.
2. Three malformed requests fail before any request; an unknown and a deleted image are refused after reading.
3. Meta's refusal for an image in use is never resubmitted; an ignored deletion is not verified; the ledger lists the write in the family.

`tests/meta-custom-conversions.test.mjs`, three tests:

1. Two custom conversions are created on pixels of the account without spending confirmation and verify (the second reuses an archived name); a replay sends nothing.
2. Ten malformed requests fail before any request; an unknown pixel and a name taken in another case are refused after reading.
3. A conversion stored on another pixel or never stored is not verified; the ledger lists the write in the family.

Red/green against a build of `9782618`: all six tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/meta-library-20260927/red-check.log`.

## Verification

- Targeted: 182 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,928/1,928.
- Guidance coverage: 311 write-path refusals across 179 modules accounted for.
- Full qualification: see
  [META-IMAGES-CONVERSIONS-VERIFICATION-2026-09-27.json](META-IMAGES-CONVERSIONS-VERIFICATION-2026-09-27.json).

Remaining rows: 776 (two Meta rows reviewed; Meta blocked writes 119 → 117). Live acceptance is
unverified; it needs the updated deployment and a Meta ad account with a pixel.
