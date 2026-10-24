---
status: record
tier: engineering
---

# Snapchat custom conversions — 2026-09-27

Base revision: `8becdaa` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Snapchat pixels could be read but their custom conversions could not be created or removed.
Pixel conversion creation and conversion deletion (two rows) were blocked writes.

Contract source: the Snapchat Marketing API Custom Conversions reference, read on 2026-09-27. Key
facts:

- `POST /v1/pixels/{pixel_id}/custom_conversions` creates conversions from
  `{custom_conversions: [{name, description, event_type, rules: [{key, values, operator}]}]}`; each
  item of the reply carries its `sub_request_status` and the created `custom_conversion`.
- `GET` on the same path lists the pixel's conversions; `DELETE /v1/custom_conversions/{id}` deletes
  one. No update is documented.
- Rule keys: `event_tag`, `item_id`, `item_category`, `currency`, `search_string`,
  `sign_up_method`, `page_url`, `category`, `category_id`, `brand`, `delivery_method`,
  `customer_status`, `price`, `number_items`. Operators: equality, containment, prefix (each with
  case-insensitive variants) and four comparisons.
- The reference states no limits on names, rules or conversions per request or per pixel, and says
  nothing about what happens to ad squads that use a deleted conversion. Mobile app conversions use
  the same shape under `/v1/mobile_apps/{app_id}`.

## Change

New reviewed family `snapchat_custom_conversions` (`src/snapchat-custom-conversions.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation: 1–10 conversions with name (1–375 characters, unique ignoring case), optional description (up to 1000), event type in capitals and 1–20 rules; deletion: the conversion in the path only, no body, query or header overrides |
| Rules | A documented key and operator; `price` and `number_items` take one number with a comparison, other keys take 1–50 strings with the other operators |
| Scope | The selected ad account; the review reads its pixels and, through a marker bound to a pixel just listed, their conversions |
| State | The account's pixels and each pixel's conversions (up to 1000 each; longer lists are refused as incomplete) |
| Checks | The pixel belongs to the account; names already taken on the pixel are refused with `CONFIGURATION_EXISTS`; a deletion needs a conversion of one of the account's pixels |
| Safety | No spending confirmation; deletions count under owner deletion policies |
| Receipt | `request_status: SUCCESS` and, for creations, SUCCESS with an ID for every conversion; anything else is a failure never resubmitted |
| Verification | The pixel's conversions listed again: each one created with its name, event type, rules and description, or the deleted one gone |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 12). Guidance: "Snapchat custom
conversions" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable
inspect example.

## Tests

`tests/snapchat-custom-conversions.test.mjs`, three tests:

1. Two conversions are created on a pixel of the account and verify; a conversion of another pixel is deleted and verifies gone; a replay sends nothing; an owner deletion rule refuses deletions but not creations.
2. Malformed conversions (empty list, unknown key or operator, comparisons on text, text operators on price, no rules, bad event type, duplicate names) are refused before any request; unknown pixels, taken names and unknown conversions after reading, without writes.
3. An error reply is never resubmitted; an ignored creation or deletion is not verified; the ledger lists both writes in the family.

Red/green against a build of `8becdaa`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-custom-conversions-20260927/red-check.log`.

## Verification

- Targeted: 188 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,948/1,948.
- Guidance coverage: 317 write-path refusals across 185 modules accounted for.
- Full qualification: see
  [SNAPCHAT-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-27.json](SNAPCHAT-CUSTOM-CONVERSIONS-VERIFICATION-2026-09-27.json).

Remaining rows: 762 (two Snapchat rows reviewed; Snapchat blocked writes 81 → 79). Live acceptance
is unverified; it needs the updated deployment and a Snapchat ad account with a pixel.
