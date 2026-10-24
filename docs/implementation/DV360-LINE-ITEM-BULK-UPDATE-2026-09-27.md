---
status: record
tier: engineering
---

# DV360 line item bulk status updates — 2026-09-27

Base revision: `903b5c5` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: pausing, activating or archiving many line items is routine campaign management (for example
at the end of a flight). The single line item update is reviewed, but `lineItems.bulkUpdate` was a
blocked write, so each line item needed its own review.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`advertisers.lineItems.bulkUpdate`, `BulkUpdateLineItemsRequest`, `BulkUpdateLineItemsResponse`,
`LineItem.entityStatus` and `containsEuPoliticalAds`), read on 2026-09-27. Key facts:

- `updateMask` supports only `entityStatus` and `containsEuPoliticalAds`; `targetLineItem` holds
  the values for every line item in `lineItemIds`.
- A line item cannot return to draft; an active line item spends only while its insertion order
  is active. YouTube & Partners line items cannot be updated through the API.
- The response lists updated, skipped (no change) and failed line items with errors; the call must
  not run concurrently with other updates of the same line items.

## Change

New reviewed family `dv360_line_item_bulk_update` (`src/dv360-line-item-bulk-update.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–100 distinct line items as decimal strings; `updateMask` of the two supported fields, each once; `targetLineItem` with exactly those fields; active, paused or archived status; a specific EU value |
| State | The advertiser, each line item (type, status, EU declaration) and each insertion order (status) |
| Checks | YouTube & Partners and archived line items refused (unless archiving); a request that changes nothing refused; line items already set are shown as unchanged |
| Safety | Activation needs `spend_change_confirmed` and is an activation under owner policies; the impact names the insertion order status |
| Receipt | Updated and skipped line items together equal the request, with no failed line items or errors; otherwise a failure that is never resubmitted |
| Verification | Every line item read again; the updated fields compared |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (DV360 contract version 12). Guidance: "Line item bulk status updates"
in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable inspect
example.

## Tests

`tests/dv360-line-item-bulk-update.test.mjs`, six tests:

1. Pausing two line items reads each line item and insertion order, updates once and verifies; the already paused one is shown as unchanged and skipped by DV360.
2. Activation needs spending confirmation and verifies; the EU declaration alone does not; an owner policy that forbids activation refuses it.
3. Nine malformed requests fail before any request.
4. YouTube & Partners, archived, unknown and unchanged line items are refused after reading, without writes.
5. A partial result is a failure that is never resubmitted; an ignored update is not verified.
6. The method matches the pinned Discovery document, and the ledger lists it in the family.

Red/green against a build of `903b5c5`: all six tests fail (no reviewed family: the route was a blocked write). Local log:
`.runtime/dv360-line-item-bulk-20260927/red-check.log`.

## Verification

- Targeted: 151 related suite files, including every Google, DV360, LinkedIn, Snapchat, media, scope and
  security suite, with FFmpeg configured: 1,789/1,789.
- Guidance coverage: 270 write-path refusals across 149 modules accounted for.
- Full qualification: see
  [DV360-LINE-ITEM-BULK-UPDATE-VERIFICATION-2026-09-27.json](DV360-LINE-ITEM-BULK-UPDATE-VERIFICATION-2026-09-27.json).

Remaining rows: 878 (one DV360 row reviewed; DV360 blocked writes 44 → 43). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser.
