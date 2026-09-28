# Criteo Retail Media 2026-01 → 2026-07: preparation (2026-09-28)

Last in the owner's upgrade order. This records what the upgrade involves and why it was prepared rather than
carried out in this review.

## Why it is not carried out yet

AMCP checks every Criteo request against its pinned OpenAPI document
(`.mirror/VENDOR/criteo-retail-2026-01.json`, fetched from `https://api.criteo.com/2026-01/retailmedia/open-api-specifications.json`).
The 2026-07 document lives at the same place, but `api.criteo.com` and `developers.criteo.com` are outside the review
environment's network policy.

Criteo's official Java SDK on GitHub (`criteo/criteo-api-java-sdk`, `sdks/retailmedia_2026-07/api/openapi.yaml`)
bundles a copy of each version's document, and it is reachable. It is not a faithful copy, though: compared with the
pinned official 2026-01 document, the SDK's 2026-01 copy has generator-added examples, `required` lists and parameter
styles, one fewer report metric in `AsyncCampaignsReport` (40 instead of 41), and schemas inlined or missing. Pinned as
the contract, it would make AMCP refuse valid requests (a missing enum value) or check the wrong rules. So it is used
below only to compare the two versions with each other, processed the same way, and not as the contract.

To carry out the upgrade: allow `api.criteo.com` in the environment's network settings (or supply the official
2026-07 document), pin it like the 2026-01 one, and do the work below.

## What changes for AMCP (SDK 2026-01 copy compared with SDK 2026-07 copy)

Of AMCP's 108 Criteo routes:

| Change | Routes | Effect in AMCP |
|---|---|---|
| Unchanged in structure | 98 | Path version only. |
| `poNumber` renamed `retailerPoNumber` | `CreateBalanceByAccountId`, `AddFundsByAccountAndBalanceId` | Both are blocked writes; no family to change. |
| Balance operations replaced by V1 versions (`GetPageOfBalancesV1` on the same `/accounts/{id}/balances` path, `GetBalanceV1`, `AppendCampaignsToBalanceV1`, `DeleteCampaignsFromBalanceV1`); balance history and modify removed | `GetBalancesByAccountId`, `GetBalanceHistory`, `ModifyBalanceByAccountAndBalanceId`, `AppendCampaignsByBalanceId`, `DeleteCampaignsByBalanceId` | The campaign write family (`src/criteo-campaign-writes.ts`) reads the account's balances to check a campaign's budget; its read and state projection must move to the V1 page. The writes are blocked. |
| The V2 asynchronous account, campaign and line item reports removed; new asynchronous performance, attributed-transaction and missed-opportunity reports, and synchronous reports | `GenerateAsyncAccountsReportV2`, `GenerateAsyncCampaignsReportV2`, `GenerateAsyncLineItemsReportV2` | The report job family (`src/criteo-report-jobs.ts`) and the Criteo reporting in `amcp_reporting` must be rebuilt on the new reports, whose filters, dimensions and row/date limits differ. This is the bulk of the work. |
| Added: store inventory upsert and delete per merchant | — | Not in the captured catalog, so not exposed. |

## Timing

F-51 infers 2026-01's end of life at about January 2027 from Criteo's 12-month version policy. The report rebuild is
the item that must be finished before then; the balance read and the version move are small.
