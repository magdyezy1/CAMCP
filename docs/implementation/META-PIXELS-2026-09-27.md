# Meta pixels — 2026-09-27

Base revision: `f19a883` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: custom conversions (reviewed earlier) need a pixel, but a pixel could not be created or
renamed. The two rows were blocked writes.

Contract source, read in the rendered Meta for Developers reference on 2026-09-27:

- "Ad Account Adspixels": `GET /act_{ad_account_id}/adspixels` lists the account's pixels (with
  paging); `POST` creates one with `name` and returns its `id`; errors 6200 "A pixel already exists
  for this account" and 6202 "More than one pixel exist for this account".
- "Ad Pixel": `POST /{ads_pixel_id}` updates `name`, `automatic_matching_fields`,
  `enable_automatic_matching`, `data_use_setting`, `first_party_cookie_status` and
  `server_events_business_ids`, returning `{success}`; `owner_business` is "the business that owns
  this pixel or null if the pixel has not been claimed by any business yet".

## Change

New reviewed family `meta_pixels` (`src/meta-pixels.ts`):

| Part | Behaviour |
|---|---|
| Request | Create with a name, or rename, 1–100 characters without surrounding spaces. Matching, data use, first-party cookie and server event settings concern customer data and are refused |
| State | The ad account's business and every pixel the account lists (id, name, owner business), following cursors |
| Checks | A renamed pixel must be listed for the account and belong to its business or to none (`STATE_TARGET_MISMATCH` otherwise); unchanged names are refused; writes need `ads_management` |
| Scope | The rename writes to `/{ads_pixel_id}`; `src/scope.ts` accepts it for the selected account once validated, and the review proves the pixel is listed |
| Safety | A pixel measures nothing until its code is installed, so no spending confirmation |
| Receipt | A creation without a pixel ID, or a rename without `success`, is a failure never resubmitted (including Meta's 6200 refusal of a second pixel) |
| Verification | The account's pixels listed again: the pixel present with the sent name |

New refusal code: `INVALID_META_PIXEL`; `STATE_NOT_FOUND`, `STATE_TARGET_MISMATCH`,
`INSUFFICIENT_SCOPE` and `INCOMPLETE_STATE` are reused.

Other code: `src/scope.ts`, `src/preflight.ts` (spending exemption), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Meta contract
version 15). Guidance: "Pixels" in `Skills/amcp-campaign-builder/references/meta.md` and an
executable inspect example.

## Tests

`tests/meta-pixels.test.mjs`, three tests:

1. A pixel is created after a paged pixel list and verifies; a replay sends nothing; a pixel of the business and an unclaimed pixel are renamed and verify.
2. Seven malformed requests (four customer-data settings, a long name, a trailing space, no name) are refused before any request; a pixel of another business, an unknown pixel and an unchanged name are refused after reading; a connection without `ads_management` is refused.
3. Meta's refusal of a second pixel is never resubmitted; an ignored rename and an ignored creation are not verified; the ledger lists both rows in the family.

Red/green against a build of `f19a883`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/meta-pixels-20260927/red-check.log`.

## Verification

- Targeted: 207 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,049/2,049.
- Guidance coverage: 339 write-path refusals across 201 modules accounted for.
- Full qualification: see
  [META-PIXELS-VERIFICATION-2026-09-27.json](META-PIXELS-VERIFICATION-2026-09-27.json).

Remaining rows: 710 (two Meta rows reviewed; Meta blocked writes 117 → 115). Live acceptance is
unverified; it needs the updated deployment and a Meta ad account with `ads_management`.
