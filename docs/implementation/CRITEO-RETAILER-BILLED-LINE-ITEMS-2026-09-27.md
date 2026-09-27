# Criteo line items in retailer-billed campaigns — 2026-09-27

Base revision: `3123374` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the Criteo guide says auction line items work in auction campaigns "including retailer-billed
ones", but every review in a retailer-billed campaign stopped at the campaign read. The pinned
2026-01 document types the campaign's `retailerId` as an int32. AMCP accepted only a numeric string
there, so the review ended with "The campaign retailer is malformed." before it compared the
retailer. Promoted product, keyword and bid multiplier reviews share that read and stopped the same
way.

Contract source: the pinned Criteo Retail Media 2026-01 OpenAPI document, checked 2026-09-27:

- `CampaignV202301.retailerId`: integer (int32), nullable; null for campaigns not billed to a retailer.
- `SponsoredProductsLineItemCreateRequestModel.targetRetailerId` and `CommonLineItem.targetRetailerId`:
  string (long-id).

## Change

`src/criteo-auction-line-items.ts`: the campaign read accepts the retailer as a positive integer (or
a numeric string) and keeps it as a string, the form line items use. A retailer-billed campaign then
admits only line items that target its retailer, as the guide states. Any other value still stops
the review as incomplete state. Criteo contract version 8 (`src/provider-contracts.ts`).

## Tests

`tests/criteo-auction-line-items.test.mjs`:

- The fixture's retailer-billed campaign returns its retailer as the integer `77`, as the pinned
  document types it. The existing review test then refuses a line item for retailer 55 ("billed to
  retailer 77") and prepares one for retailer 77.
- The model test pins both types: an integer on the campaign, a string on the line item.

Red/green against a build of `3123374`: the review test fails, because the retailer-billed campaign stops with "The campaign retailer is malformed." (6/7 pass). Local log:
`.runtime/criteo-retailer-id-20260927/red-check.log`.

## Verification

- Targeted: 152 related suite files, including every Criteo, Google, DV360, LinkedIn, Snapchat, media, scope
  and security suite, with FFmpeg configured: 1,794/1,794 on the second run (the first run hit an
  unrelated EPERM temporary-directory flake in one LinkedIn upload test, which then passed alone
  three times).
- Guidance coverage: 271 write-path refusals across 150 modules accounted for (unchanged).
- Full qualification: see
  [CRITEO-RETAILER-BILLED-LINE-ITEMS-VERIFICATION-2026-09-27.json](CRITEO-RETAILER-BILLED-LINE-ITEMS-VERIFICATION-2026-09-27.json).

Remaining rows: 877 (a defect fix; no ledger row changes). Live acceptance is unverified; it needs
the updated deployment and a retailer-billed Criteo auction campaign.

Criteo preferred (onsite display) line items stay blocked. Criteo's line item documentation says
Preferred Deals are "currently in beta and available only to our Retailer partners", with details from
the account manager, while AMCP connects demand accounts.
