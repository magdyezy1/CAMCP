# Criteo promoted products — 2026-09-27

Base revision: `78c1252` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: an auction line item serves only the products it promotes. After the line item family
(`78c1252`), products still could not be added, removed, paused or unpaused, so a line item
created through AMCP stayed in draft.

Contract source: the pinned Retail Media 2026-01 OpenAPI document (`FetchPromotedProducts`,
`AppendPromotedProducts`, `DeletePromotedProducts`, `PausePromotedProducts`,
`UnpausePromotedProducts`) and the [Promoted Products](https://developers.criteo.com/retail-media/docs/promoted-products)
guide in its current and [2026.01](https://developers.criteo.com/retail-media/v2026.01/docs/promoted-products)
versions, read on 2026-09-26. Key facts:

- Append adds products; for a product already on the line item it only changes the bid
  override. A bid override of 0 removes it, so the line item's target bid applies.
- Once a line item has products, at least one must remain.
- Pause and unpause take product IDs only. Product IDs are catalog IDs of up to 500
  characters. Criteo suggests at most 1500 products per line item.
- All four writes answer 204 without a body; append may answer 200 with warnings.

## Change

New reviewed family `criteo_promoted_products` (`src/criteo-promoted-products.ts`).

| Part | Behaviour |
|---|---|
| Request | 1–500 distinct product IDs; append may set `bidOverride` (0 or more); status and other attributes are refused |
| Ownership | The line item was listed in the account, or created and verified through AMCP |
| State | The line item reader of `78c1252` now also reads the line item's products (up to 1500, ended by an empty page) |
| Checks | An existing product needs a new bid override; delete keeps at least one product; pause takes active and unpause takes paused products; unknown products and archived or preferred line items are refused |
| Safety | Append and unpause need `spend_change_confirmed`; they count as activation unless the line item is paused (bid override changes alone do not); delete counts as a deletion |
| Receipt | 204 without a body, or 200 without errors or warnings |
| Verification | Each product in the request: present with the requested bid override, absent after deletion, or paused or active |

Verification keys products by a hexadecimal form of their ID. The read-back comparison folds
key case, and catalog IDs are case-sensitive, so `sku-A` and `Sku-a` would otherwise be
compared as one product. One test pauses `sku-A` while `Sku-a` is already paused; if Criteo
ignores the pause, verification is inconclusive and names `sku-A`.

The 2026.01 line items guide shows a capitalized day (`Weekends`) in a read sample, while the
pinned enum and requests are lower case. The line item projection now compares days
case-insensitively, so such a read-back still verifies.

Other code: `src/criteo-auction-line-items.ts` (product reads, product keys, lower-case days),
`src/write-review.ts`, `src/write-verification.ts`, `src/scope.ts`, `src/write-impact.ts`,
`src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`, `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract
version 6). Guidance: "Promoted products of auction line items (2026.01)" in
`Skills/amcp-campaign-builder/references/criteo.md` and an executable inspect example.

## Tests

`tests/criteo-promoted-products.test.mjs`, seven tests:

1. Appending two new products (whose IDs differ only in case) and removing a bid override needs spending confirmation, writes once and verifies; a replay makes no second write.
2. Pause, unpause and delete verify; pause and delete need no spending confirmation; the last product of a line item cannot be deleted.
3. Fourteen malformed requests fail without network requests.
4. An unlisted line item, a product in the wrong state, unknown products (matched case-sensitively), an unchanged or missing bid override, archived and preferred line items and more than 1500 products are refused before any write.
5. Owner policies: new or unpaused products on an active line item count as activation, not on a paused one and not for bid overrides; deleting products counts as a deletion.
6. A 200 response with warnings stays a failure and is not resubmitted, a product list changed after review stops execution with `STATE_CHANGED`, and ignored pauses or bid overrides are inconclusive and name the product.
7. The routes, permissions, 204 responses and request model match the pinned document.

`tests/criteo-auction-line-items.test.mjs` gains a creation whose flight days Criteo returns
capitalized.

Red/green against a build of `78c1252` (with the pinned document present): the six product
behaviour tests and the capitalized-day check fail, while the pinned-document test and the
other six line item tests pass; all pass with this change. Local log:
`.runtime/criteo-promoted-products-20260927/red-check.log`.

## Verification

- Targeted: 134 related suite files, 1,624/1,624.
- Guidance coverage: 261 write-path refusals across 141 modules accounted for.
- Full qualification: see
  [CRITEO-PROMOTED-PRODUCTS-VERIFICATION-2026-09-27.json](CRITEO-PROMOTED-PRODUCTS-VERIFICATION-2026-09-27.json).

Remaining rows: 902 (four Criteo rows reviewed; Criteo blocked writes 41 → 37). Keywords, bid
multipliers and preferred line items remain. Live acceptance is unverified; it needs the
updated deployment and a Criteo retail media account.
