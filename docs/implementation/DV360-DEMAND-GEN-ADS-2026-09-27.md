# DV360 Demand Gen ads — 2026-09-27

Base revision: `e8e4a8a` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: a Demand Gen campaign serves ads. Line items, ad groups, targeting and YouTube video assets
were qualified in earlier batches, but ads were blocked, so a Demand Gen campaign could not be
completed through AMCP.

Contract source: the pinned Display & Video 360 API v4 Discovery document (`AdGroupAd`,
`DemandGenVideoAd`, `DemandGenImageAd`, `DemandGenCarouselAd`, `DemandGenProductAd`,
`CarouselCard`, `adGroupAds.create`, `patch` and `delete`) and
[Create a Demand Gen ad](https://developers.google.com/display-video/api/guides/tasks/serve-demand-gen-ad/create-dg-ad),
read on 2026-09-27. Key facts:

- An ad belongs to one ad group and is one of four types; the ad group and the type are fixed.
- Ads reference YouTube video assets by ad asset ID (`videos[].videoAssetId`) and images by asset
  ID (`{assetId}`).
- Video and product ads take a listed call to action; a carousel card takes free text of up to 10
  characters.
- An ad serves only while it, its ad group and its line item are active; the guide creates ads
  paused.
- Patch takes a top-level `updateMask`; output-only fields (IDs, resource name, image metadata,
  YouTube details, tracking URLs) are refused on write and returned on read.

## Change

New reviewed family `dv360_demand_gen_ads` (`src/dv360-demand-gen-ads.ts`):

| Part | Behaviour |
|---|---|
| Request | Create: `adGroupId`, `displayName` (1–255 UTF-8 bytes), `entityStatus` (paused or active) and exactly one ad type. Patch: `updateMask` of top-level writable fields, body with exactly those fields, at most one type. Delete: no body. |
| Creative rules | Complete http(s) URLs without spaces or credentials; text lists of 1–15 distinct items; video ads 1–5 distinct videos and a listed call to action; image ads at least one marketing image; carousels 2–10 cards, each with an image and a call to action of up to 10 characters; product ads a listed product call to action; images `{assetId}` only |
| State | The ad (patch, delete), its ad group and line item through the Demand Gen ad group reader, and each video asset by ID |
| Checks | Archived ad groups, line items, ads and videos are refused; an ID that is not a YouTube video asset of the advertiser is a target mismatch; non–Demand Gen ads, type changes and patches that change nothing are refused |
| Safety | An active ad needs `spend_change_confirmed` and is an activation under owner policies; deletion is a deletion. Ad text such as "budget" is not a spending change. |
| Receipt | The advertiser, ad and ad group (create) or ad ID (patch) and an ad type; an empty body for deletion |
| Verification | The ad read again: name, status, type and every creative field sent, ignoring output-only fields; a deleted ad must be gone |

Other code: `src/write-review.ts`, `src/write-verification.ts` (the ad reader joins the reader
chain after the ad group reader), `src/write-impact.ts`, `src/review-state.ts`, `src/preflight.ts`
(ads are exempt from the generic "bid/budget/spend" heuristic), `src/reviewed-routes.ts`,
`src/types.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (DV360 contract
version 9). Guidance: "Demand Gen ads" in
`Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an executable product ad
inspect example.

## Tests

`tests/dv360-demand-gen-ads.test.mjs`, seven tests:

1. A paused video ad is created once, verifies against a read that includes output-only fields and is not replayed; activating it needs spending confirmation and verifies.
2. Image, carousel and product ads verify; a patch of the name and creative verifies; a deletion verifies absence.
3. Sixteen malformed requests fail without network requests (one already at the pinned model).
4. The review refuses an archived line item, an archived video, an image asset ID used as a video, a non–Demand Gen ad, a type change and an unchanged patch, with no writes.
5. Owner policies: an active ad is an activation and a deletion is a deletion; ad text about budgets is not a spending change.
6. An ad changed after review stops execution; when the provider ignores a write, verification is inconclusive.
7. The ad model, methods and scopes match the pinned Discovery document.

Red/green against a build of `e8e4a8a` (with the pinned document present): the six behaviour
tests fail (no reviewed family: `WRITE_CONTRACT_UNAVAILABLE`), while the pinned-document test
passes; all pass with this change. Local log:
`.runtime/dv360-demand-gen-ads-20260927/red-check.log`.

## Verification

- Targeted: 139 related suite files, including every DV360 suite, 1,660/1,660.
- Guidance coverage: 266 write-path refusals across 145 modules accounted for.
- Full qualification: see
  [DV360-DEMAND-GEN-ADS-VERIFICATION-2026-09-27.json](DV360-DEMAND-GEN-ADS-VERIFICATION-2026-09-27.json).

Remaining rows: 888 (three DV360 rows reviewed; DV360 blocked writes 48 → 45). Image asset upload
remains, so image, carousel and logo assets must already exist in DV360. Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser with Demand Gen enabled.
