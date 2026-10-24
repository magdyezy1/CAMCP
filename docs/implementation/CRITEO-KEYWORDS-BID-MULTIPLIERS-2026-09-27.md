---
status: record
tier: engineering
---

# Criteo keywords and bid multipliers — 2026-09-27

Base revision: `c96529c` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: after line items (`78c1252`) and their products (`c96529c`), the remaining bid and
targeting controls of an auction line item were blocked: keywords (positive and negative),
keyword bids and bid multipliers per page type.

Contract source: the pinned Retail Media 2026-01 OpenAPI document (`FetchKeywords`,
`AddRemoveKeywords`, `SetKeywordBids`, `GetBidMultipliersByLineItemId`,
`UpdateBidMultipliersByLineItemId`) and the 2026.01 [Keywords](https://developers.criteo.com/retail-media/v2026.01/docs/keywords)
and [Bid Multipliers](https://developers.criteo.com/retail-media/v2026.01/docs/bid-multipliers)
guides, read on 2026-09-26. Key facts:

- Keywords are added or removed by phrase and match type (`PositiveExactMatch`,
  `NegativeExactMatch`, `NegativeBroadMatch`). Criteo indexes them by a normalized phrase
  (the guide shows `egg` for `eggs`) and lists the phrases supplied for it.
- Bids are set by phrase on positive keywords, also in review, in the retailer's default
  currency; null returns to the line item bid.
- Bid multipliers range from 0.5 to 6.0 per page type. The PUT replaces all of them; a page
  type left out returns to 1.0.
- Keyword review is a retailer action (supply accounts), so it is not part of this batch.

## Change

Two reviewed families in `src/criteo-line-item-bidding.ts`:

| Part | `criteo_keywords` | `criteo_bid_multipliers` |
|---|---|---|
| Request | 1–100 phrases (1–255 characters, each once); `{phrase, matchType, isDeleted}` or `{phrase, bid}` | Every page type, 0.5–6.0 (`aiAssistant` may be null) |
| State | The line item reader now also reads the line item's keywords or its bid multipliers | |
| Checks | Phrases compare case-insensitively within their match type: an added phrase is new, a removed one is listed, a phrase under another match type is removed first, bids go to listed positive keywords, phrases of one normalized keyword share a bid, and a real change | Page types unknown to the contract are refused (the PUT would reset them), and a real change |
| Safety | Widening changes (new positives, removed negatives) and bids need `spend_change_confirmed`; widening counts as activation unless the line item is paused | `spend_change_confirmed` |
| Verification | Each phrase under its match type: present, absent or with the requested bid | Every page type |

Owner deletion policy: the delegated compiler marks every action whose name contains
`DELETE`, `REMOVE` or `CLEAR` as destructive. `ADD_REMOVE_KEYWORDS` is therefore refused
under a policy that forbids deletion even when it only adds keywords. This fail-closed
default is kept; a test and the guide state it.

The generic preflight rule asks for spending confirmation whenever a request body mentions
"bid", "budget" or "spend". The line item bidding families and promoted products now decide
confirmation themselves, so a phrase such as `budget tv` or a product ID such as
`budget-bid-spend` is not treated as a spending change.

Other code: `src/criteo-auction-line-items.ts` (keyword and bid multiplier reads, keys and
projections), `src/write-review.ts`, `src/write-verification.ts`, `src/scope.ts`,
`src/write-impact.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract
version 7). Guidance: "Keywords and bid multipliers of auction line items (2026.01)" in
`Skills/amcp-campaign-builder/references/criteo.md` and two executable inspect examples.

## Tests

`tests/criteo-line-item-bidding.test.mjs`, seven tests:

1. Keywords are added and removed by match type through Criteo's normalized keywords; widening needs spending confirmation and narrowing does not (including a phrase that mentions a budget); each verifies and a replay makes no second write.
2. Bids set through any supplied phrase (in any case) verify, a bid returns to the line item bid with null, and a complete bid multiplier PUT verifies although Criteo returns the line item ID as a JSON number.
3. Seventeen malformed keyword, bid and multiplier requests fail without network requests.
4. An unlisted line item, existing, missing and retyped phrases, bids on negative or shared keywords, unchanged bids or multipliers and unknown page types are refused before any write.
5. Owner policies: widening keywords count as activation unless the line item is paused; `ADD_REMOVE_KEYWORDS` is a deletion, additions included; bids and multipliers are neither.
6. A response with warnings stays a failure and is not resubmitted, a keyword changed after review stops execution with `STATE_CHANGED`, and ignored bids, keywords and multipliers are inconclusive and name the field.
7. The routes, permissions and request models match the pinned document.

`tests/criteo-promoted-products.test.mjs` gains a pause of a product whose ID mentions a bid,
budget and spend, without spending confirmation.

Red/green against a build of `c96529c` (with the pinned document present): the six keyword and
multiplier behaviour tests and the product ID test fail, while the pinned-document test and
the seven earlier product tests pass; all pass with this change. Local log:
`.runtime/criteo-keywords-bid-multipliers-20260927/red-check.log`.

## Verification

- Targeted: 135 related suite files, 1,632/1,632.
- Guidance coverage: 263 write-path refusals across 142 modules accounted for.
- Full qualification: see
  [CRITEO-KEYWORDS-BID-MULTIPLIERS-VERIFICATION-2026-09-27.json](CRITEO-KEYWORDS-BID-MULTIPLIERS-VERIFICATION-2026-09-27.json).

Remaining rows: 899 (three Criteo rows reviewed; Criteo blocked writes 37 → 34). Live
acceptance is unverified; it needs the updated deployment and a Criteo retail media account.
