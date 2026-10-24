---
status: record
tier: engineering
---

# DV360 line item duplication — 2026-09-27

Base revision: `37b18b3` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: copying a working line item is the usual start of a new flight or test in DV360. The
single line item creation is reviewed, but `lineItems.duplicate` was a blocked write, so every
setting had to be restated.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`advertisers.lineItems.duplicate`, `DuplicateLineItemRequest`, `DuplicateLineItemResponse`,
`LineItem`), [duplicate](https://developers.google.com/display-video/api/reference/rest/v4/advertisers.lineItems/duplicate)
and [Activate Line Item](https://developers.google.com/display-video/api/guides/managing-line-items/activation),
read on 2026-09-27. Key facts:

- `targetDisplayName` names the copy (at most 240 UTF-8 bytes); `containsEuPoliticalAds` must be
  set for a new line item unless the advertiser declares that it does not contain EU political
  ads. The response returns `duplicateLineItemId`.
- "Line items must be created in a draft state"; YouTube & Partners line items cannot be created
  through the API. "This method regularly experiences high latency."

## Change

New reviewed family `dv360_line_item_duplicate` (`src/dv360-line-item-duplicate.ts`):

| Part | Behaviour |
|---|---|
| Request | One line item of the selected advertiser; `targetDisplayName` (1–240 UTF-8 bytes, no control characters) and `containsEuPoliticalAds`, both required |
| State | The advertiser, the line item (insertion order, type, status, EU declaration) and its insertion order |
| Checks | YouTube & Partners line items, archived line items and archived insertion orders refused |
| Safety | The copy is created in draft and serves nothing: no spending confirmation, and the display name never triggers one |
| Receipt | A new line item ID other than the source; a timeout is a lost receipt, never resubmitted |
| Verification | The copy read back: insertion order and type of the source, the name and EU declaration sent, draft status |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (DV360 contract version 13). Guidance: "Line item duplication" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect
example.

## Tests

`tests/dv360-line-item-duplicate.test.mjs`, five tests:

1. An active line item is duplicated once into a draft copy in its insertion order, without spending confirmation, and verifies; a replay sends nothing.
2. Eight malformed requests fail before any request; a name of exactly 240 bytes is accepted.
3. YouTube & Partners, archived line items, archived insertion orders and unknown line items are refused after reading, without writes.
4. A receipt naming the source is a failure that is never resubmitted; a copy that is not draft, or missing, is not verified.
5. The method matches the pinned Discovery document, and the ledger lists it in the family.

Red/green against a build of `37b18b3`: all five tests fail (no reviewed family: the route was a blocked write). Local log:
`.runtime/dv360-duplicate-20260927/red-check.log`.

## Verification

- Targeted: 154 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, media, scope
  and security suite, with FFmpeg configured: 1,804/1,804.
- Guidance coverage: 274 write-path refusals across 152 modules accounted for.
- Full qualification: see
  [DV360-LINE-ITEM-DUPLICATE-VERIFICATION-2026-09-27.json](DV360-LINE-ITEM-DUPLICATE-VERIFICATION-2026-09-27.json).

Remaining rows: 875 (one DV360 row reviewed; DV360 blocked writes 43 → 42). Live acceptance is
unverified; it needs the updated deployment and a DV360 line item that is not YouTube & Partners.
