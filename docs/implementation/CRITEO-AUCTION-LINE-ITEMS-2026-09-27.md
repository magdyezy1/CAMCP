# Criteo auction line items — 2026-09-27

Base revision: `8fa32bf` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: a Criteo retail media campaign runs only through its line items. AMCP could create and
update auction campaigns, but creating and editing their Onsite Sponsored Products (auction)
line items was blocked, so a campaign could not be built end to end.

Contract source: the pinned Retail Media 2026-01 OpenAPI document (`CreateAuctionLineItem`,
`UpdateAuctionLineItem`, `GetAuctionLineItem`, `GetAuctionLineItemsByCampaign`,
`GetLineItemsByAccountId`), and the [Onsite Sponsored Products Line Items](https://developers.criteo.com/retail-media/docs/onsite-sponsored-products-line-items)
and [Line Items](https://developers.criteo.com/retail-media/docs/line-items) guides, read on
2026-09-26. Key facts:

- Creation needs a name, a start date and the target retailer; every other field takes a
  default. The new line item is in draft until products are added, and it serves only after
  it is set to active.
- The update is a complete PUT: a writable field left out becomes null or its default.
  Users set the status to active or paused; Criteo derives the other statuses.
- Names are unique within a campaign. The retailer and keyword strategy cannot change after
  creation. A retailer-billed campaign's line items must target its retailer.
- Automated bidding needs `maxBid` (at least 0.1; Criteo returns 0 for none), manual bidding
  needs `targetBid`. Automatic daily pacing cannot be combined with a daily amount and needs an
  end date and budget, or a monthly pace.

## Change

New reviewed family `criteo_auction_line_items` (`src/criteo-auction-line-items.ts`).

| Part | Creation | Complete PUT |
|---|---|---|
| Request | Every writable field explicitly (null where a limit is off), the retailer, an optional keyword strategy | Every writable field and `status` (`active` or `paused`); retailer and keyword strategy refused |
| Ownership | The campaign was listed in the account | The line item was listed in the account, or created and verified through AMCP |
| State | Account (currency, time zone), campaign in the account, the campaign's line item names (up to 1000) | Also the line item's account membership and its current configuration |
| Checks | Auction campaign; a retailer-billed campaign's retailer; a new name | A new name, not archived, no fields unknown to the contract, and a real change |
| Safety | `spend_change_confirmed`; owner limits on budget and paces; a null limit is refused under a monetary policy | The same, and `active` counts as activation |
| Receipt | HTTP 201, the line item in the campaign, no errors or warnings | HTTP 200, the same line item, no errors or warnings |
| Verification | Every field, campaign, retailer, keyword strategy and draft status | Every field and the status; a draft line item set to active cannot show it yet (reported unobservable) |

Other code: `src/write-review.ts` (the reader joins both read chains), `src/write-verification.ts`
(a verified creation records the new line item as owned), `src/scope.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract
version 5). Guidance: "Auction line items (2026.01)" in
`Skills/amcp-campaign-builder/references/criteo.md` and an executable inspect example.

## Tests

`tests/criteo-auction-line-items.test.mjs`, seven tests:

1. A draft line item needs spending confirmation, is written once and verifies, although Criteo returns UTC dates, 0 for no bid ceiling, a calculated daily pace and reordered flight legs; a replay makes no second write, and the new line item can be edited without another listing.
2. A complete PUT that activates a paused line item verifies with a derived status; a draft line item set to active verifies with its status reported unobservable.
3. Sixteen invalid, incomplete or unqualified requests fail without network requests.
4. Missing ownership, a duplicate name, the wrong retailer, a preferred campaign, an unchanged request, an unknown field, a foreign campaign and more than 1000 line items are refused before any write.
5. Owner policies: activation, the budget maximum, uncapped limits and the increase percentage.
6. A creation with warnings stays a failure and is not resubmitted, a line item changed after review stops execution with `STATE_CHANGED`, and a read-back that differs is inconclusive and names the field.
7. The qualified fields, required fields, status values, routes and permissions match the pinned models.

Red/green: all seven fail against a build of `8fa32bf` (the routes had no reviewed family) and
pass with this change. Local log: `.runtime/criteo-auction-line-items-20260927/red-check.log`.

## Verification

- Targeted: 133 related suite files, 1,617/1,617.
- Guidance coverage: 260 write-path refusals across 140 modules accounted for.
- Full qualification: see
  [CRITEO-AUCTION-LINE-ITEMS-VERIFICATION-2026-09-27.json](CRITEO-AUCTION-LINE-ITEMS-VERIFICATION-2026-09-27.json).

Remaining rows: 906 (two Criteo rows reviewed; Criteo blocked writes 43 → 41). Promoted
products, keywords, bid multipliers, budget overrides and preferred line items remain
separate. Live acceptance is unverified; it needs the updated deployment and a Criteo retail
media account.
