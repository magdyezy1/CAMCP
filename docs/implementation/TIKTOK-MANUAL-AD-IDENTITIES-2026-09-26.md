---
status: record
tier: engineering
---

# TikTok manual ads with custom identities — 2026-09-26

Base revision: `f440117` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P2 row "TikTok manual ads with custom identities" in the
[2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md). The reviewed manual ad creation
(`tiktok_entities`) accepted a non-Spark ad with a custom identity in any ad group, although
TikTok no longer accepts one where the ad group delivers on TikTok.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:
[Create ads](https://business-api.tiktok.com/portal/docs/create-ads/v1.3),
[Update ads](https://business-api.tiktok.com/portal/docs/update-ads/v1.3) and
[Create an Upgraded Smart+ Ad](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad/v1.3).
Creating non-Spark ads with custom identities in ad groups on automatic placement, or on
selected placements that include TikTok, is no longer supported for existing ad accounts, and
never for accounts created from 15 January 2026. Pangle and Global App Bundle placements are
not affected, and existing ads stay editable.

## Change

`src/tiktok-manual-ad-identities.ts` adds one check to manual ad creation. The ad group is
already read before review and again before execution; when a creative uses
`CUSTOMIZED_USER` and the ad group's `placement_type` is `PLACEMENT_TYPE_AUTOMATIC`, or its
`placements` include `PLACEMENT_TIKTOK`, the review refuses with
`TIKTOK_CUSTOM_IDENTITY_PLACEMENT` and names Spark identities as the alternative. Ad updates
are not affected. The action inventory does not change: the route was already reviewed.

Other code: `src/write-review.ts` (the check after the state reads),
`src/provider-contracts.ts` (TikTok contract version 18), `src/action-contracts.ts`.
Guidance: "TikTok manual ads with custom identities" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md`.

## Tests

`tests/tiktok-manual-ad-identities.test.mjs`, three tests:

1. A custom identity ad in an automatic-placement ad group and in one with TikTok among its selected placements is refused before any write, naming Spark identities.
2. A custom identity ad in a Pangle-only ad group is created and verifies, and a Spark ad in an automatic-placement ad group is not affected.
3. An ad group moved to automatic placement after review stops execution before any write.

Red/green: tests 1 and 3 fail against a build of `f440117` (the ad is accepted); test 2 passes
there too and guards the unaffected cases. Local log:
`.runtime/tiktok-manual-ad-identities-20260926/red-check.log`.

## Verification

- Targeted: 1351/1351 across 105 related suites, including the creative chain and CTA
  portfolio suites that create manual ads.
- Guidance coverage: 251 write-path refusals across 130 modules accounted for.
- Full qualification: see
  [TIKTOK-MANUAL-AD-IDENTITIES-VERIFICATION-2026-09-26.json](TIKTOK-MANUAL-AD-IDENTITIES-VERIFICATION-2026-09-26.json).

Remaining rows: 931 (unchanged). Live acceptance is unverified.
