---
status: record
tier: engineering
---

# X campaign and line item batches — 2026-09-28

Base revision: `fd8340b` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: X campaigns and line items could be created, edited and deleted one at a time, but the batch
routes `POST /12/batch/accounts/{id}/campaigns` and `.../line_items` were blocked writes. A batch
would otherwise bypass the per-entity spending policy: the policy needs one current budget per
change, and a batch changes several entities at once.

Contract source: the X Ads API v12
[Campaign Management reference](https://docs.x.com/x-ads-api/campaign-management/reference), read
on 2026-09-28. "The current maximum batch size is 40"; "Batch requests fail or succeed together as
a group and all API responses for both error and success preserve the item order of the initial
request"; request-level errors come under `errors` and item-level errors under
`operation_errors`. Items are `{operation_type: Create|Update|Delete, params}` with the parameters
of the single endpoints (POST for creates, PUT for updates); the reference lists them with their
types and values. Update and Delete items name the entity by `campaign_id` or `line_item_id`, as
X's Python Ads SDK sends them (`Batch.batch_save`, xdevplatform/twitter-python-ads-sdk).
"Deleting a campaign is not reversible."

## Change

New reviewed family `x_entity_batches` (`src/x-entity-batches.ts`):

| Part | Behaviour |
|---|---|
| Request | The selected account's batch path; a JSON array of 1–20 `{operation_type, params}` items of one type; creates carry the single-create fields with `entity_status: PAUSED` (campaigns need `funding_instrument_id` and `name`, line items `campaign_id`, `objective`, `product_type` and `placements`); updates name the ID and at least one single-update field; deletes name only the ID. Types, documented values, ISO 8601 times with zone, whole-micro amounts, daily not above total budget, no bid amount with AUTO bidding and end after start are checked before any request |
| State | The account; for creates each funding instrument (whether it can fund, without its description or credit amounts) or parent campaign; for updates and deletions each entity |
| Checks | Parents and entities exist in the account and are not deleted; the funding instrument can fund campaigns; an update changes something, and the budget, bid and time rules hold with the entity's current values |
| Policy | Budgets, bids and ACTIVE statuses need `spend_change_confirmed=true`; the owner spending policy compares each new budget with that entity's own current budget (`src/spend-policy.ts`); a Delete batch is destructive, so the owner deletion policy applies (`src/execution-risk.ts`) |
| Receipt | Every item back in order without `errors` or `operation_errors`; creates PAUSED, updates the same IDs, deletes the same IDs with `deleted: true`; anything else is a failure never resubmitted |
| Verification | Each entity read again (deleted ones with `with_deleted`), comparing the fields sent: placements and categories as sets, times as instants |

The 20-item bound and one operation type per batch are AMCP's. New refusal code:
`INVALID_X_ENTITY_BATCH`. `standard_delivery` is left out of campaigns, where X marks it
deprecated.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (X contract version 16). There is no
preflight exemption: budgets, bids and activations in a batch need spending confirmation like
single edits. Guidance: an X campaign and line item batch section in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-entity-batches.test.mjs`, three tests:

1. Two paused campaigns (after spending confirmation, with the funding instrument read and its card description not kept) and two paused line items (with the parent campaign read; placements and a time with an offset verify as a set and an instant) are created; two line items are updated (bid and name; a status) and a campaign renamed without spending confirmation; an ACTIVE campaign is deleted; each verifies; a replay sends nothing.
2. Twenty-one malformed batches (mixed types, 21 items, none, an `account_id`, an ACTIVE or status-less create, a deprecated or foreign field, no funding instrument, a daily budget above the total, a fractional budget, an unknown placement, a time without zone, an end before the start, a bid with AUTO, a repeated ID, an update without changes, an undocumented update field, a delete with fields, an unknown operation, an extra item key) are refused before any request; a missing or unfunded funding instrument, a deleted campaign or line item, an unchanged update, a bid under AUTO and a daily budget above the current total after reading; the owner policy refuses a 20% increase of one campaign while another rises 5% (each against its own budget), an activation and a deletion.
3. An error reply, an item-error reply and a short reply are never resubmitted; an ignored update and a drifted create are not verified; the ledger lists both rows in the family.

Red/green against a build of `fd8340b`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-entity-batches-20260927/red-check.log`.

## Verification

- Targeted: 222 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,159/2,159.
- Guidance coverage: 351 write-path refusals across 213 modules accounted for.
- Full qualification: see
  [X-ENTITY-BATCHES-VERIFICATION-2026-09-28.json](X-ENTITY-BATCHES-VERIFICATION-2026-09-28.json).

Remaining rows: 693 (two X rows reviewed; X blocked writes 35 → 33). Live acceptance is
unverified; it needs the updated deployment and an X Ads account. X does not document whether a
line item read returns `audience_expansion`; if it does not, a batch that sets it verifies as
inconclusive.
