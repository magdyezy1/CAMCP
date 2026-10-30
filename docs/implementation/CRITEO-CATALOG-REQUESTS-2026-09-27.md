---
status: record
tier: engineering
---

# Criteo catalog requests and exports — 2026-09-27

Base revision: `a20537d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: choosing promoted products starts from the products available to the account, which Criteo
provides as catalog files built on request. The four rows that request them (catalogs, seller
catalogs, brand and seller catalog exports) were blocked writes because they are POSTs.

Contract source: the pinned Criteo Retail Media 2026-01 OpenAPI document
(`CatalogApi_PostApiV1ExternalAccountCatalogsByAccountId`,
`Catalog_PostApiExternalV1AccountCatalogsSellersByAccountId`, `CreateBrandCatalogExport`,
`CreateSellerCatalogExport`, `GetCatalogStatus`, `GetCatalogOutput`), checked 2026-09-27. Key facts:

- Each POST "Create[s] a request for a Catalog available to the indicated account" and answers a
  catalog status with an ID; the status is `unknown`, `pending`, `success`, `failure` or `expired`,
  and the output is available "only ... when their associated status request is at a Success status".
- `ExternalCatalogRequest` takes `format` (`json-newline`) and `brandIdFilter`;
  `SellerCatalogRequest` requires `sellers` (`retailerId`, `sellerId`); the V2 exports take brand,
  retailer and seller filters, `includeFields` and `modifiedAfter`.
- The first two need `RetailMedia_Campaign_Read`, the exports `RetailMedia_Campaign_Manage`.

## Change

New reviewed family `criteo_catalog_requests` (`src/criteo-catalog-requests.ts`):

| Part | Behaviour |
|---|---|
| Request | The four request bodies with their documented fields only; identifiers are numeric and listed once (up to 500); `modifiedAfter` is a past date-time; no query or header overrides |
| Scope | The selected account and the documented permissions; the status read is bound to the catalog ID of the receipt |
| State | The account (type and currency) |
| Safety | Nothing that spends changes, so no spending confirmation |
| Receipt | A catalog status with an ID, pending or success; anything else is a failure never resubmitted |
| Verification | `catalogs/{catalogId}/status` read by the receipt's ID: pending or success; the catalog is then remembered as the account's for five minutes, AMCP's window for resources it has seen, so its status and output can be read natively |

Other code: `src/types.ts`, `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract version 12). Guidance:
"Catalog requests and exports (2026.01)" in `Skills/amcp-campaign-builder/references/criteo.md` and
an executable inspect example.

## Tests

`tests/criteo-catalog-requests.test.mjs`, four tests:

1. A catalog request and a seller catalog request are created without spending confirmation and verify pending, and a replay sends nothing; a catalog of another request is not readable natively, the verified one is.
2. Brand and seller exports verify with the manage permission and are refused without it.
3. Twelve malformed requests fail before any request.
4. A failed request is a failure never resubmitted; an ignored request is not verified; the models match the pinned document; the ledger lists the four writes in the family.

Red/green against a build of `a20537d`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/criteo-catalogs-20260927/red-check.log`.

## Verification

- Targeted: 179 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,918/1,918.
- Guidance coverage: 308 write-path refusals across 176 modules accounted for.
- Full qualification: see
  [CRITEO-CATALOG-REQUESTS-VERIFICATION-2026-09-27.json](CRITEO-CATALOG-REQUESTS-VERIFICATION-2026-09-27.json).

Remaining rows: 780 (four Criteo rows reviewed; Criteo blocked writes 27 → 23). Live acceptance is
unverified; it needs the updated deployment and a Criteo Retail Media account.
