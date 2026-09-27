# Google Performance Max brand guidelines — 2026-09-27

Base revision: `3dac065` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Performance Max campaigns with brand guidelines keep their business name and logos at the
campaign level, with brand colors and a font for generated assets. Google migrated campaigns
with consistent brand assets automatically in 2025; the others need
`CampaignService.EnablePMaxBrandGuidelines`, which was a blocked write (two rows).

Contract source: the pinned Google Ads API v23 Discovery document (`EnablePMaxBrandGuidelines`,
`EnableOperation`, `BrandCampaignAssets`, `EnablementResult`, `Campaign.brand_guidelines_enabled`
and `brand_guidelines`, `CampaignAsset`), the campaign field reference (the brand guideline
fields are selectable) and [Asset requirements](https://developers.google.com/google-ads/api/performance-max/asset-requirements)
of the Performance Max guide, read on 2026-09-27. Key facts:

- At most 10 operations. `autoPopulateBrandAssets` is required; when false, `brandAssets` with a
  business name asset and square logo assets (optionally landscape logos) is required.
- Colors are hex codes set together; the font is one of eight Google Fonts; `finalUriDomain` is
  optional.
- "It is not possible to disable Brand Guidelines for an existing campaign"; travel goals are
  incompatible.
- Business name: one text asset of at most 25 characters. Logo: 1:1, at least 128 x 128. Landscape
  logo: 4:1, at least 512 x 128. A campaign has at least one logo and up to four more logos.

## Change

New reviewed family `google_pmax_brand_guidelines` (`src/google-pmax-brand-guidelines.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–10 distinct campaigns of the selected customer; the switch; brand assets only without automatic choice, one to five logos with at least one square logo, each asset once; paired hex colors; a documented font; a plain domain |
| State | The customer, each campaign (channel, status, brand guideline fields, travel account) and each asset sent (type, text, image size), and the enabled brand links of each campaign |
| Checks | Performance Max only; removed campaigns and travel goals refused; already enabled is `CONFIGURATION_EXISTS`; business name, logo and landscape logo requirements |
| Safety | Irreversible and applied at once to enabled campaigns: `spend_change_confirmed` is required; the impact says so |
| Receipt | One result per operation naming its campaign, without an enablement error; any error makes the outcome a failure |
| Verification | Brand guidelines enabled, the colors (without case) and font sent, and enabled campaign links of every asset sent, or at least one business name and logo chosen by Google |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/preflight.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Google contract version 20). Guidance: "Performance Max brand
guidelines" in `Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect
example.

## Tests

`tests/google-pmax-brand-guidelines.test.mjs`, six tests:

1. Explicit brand assets for an enabled and a paused campaign need spending confirmation, are sent once and verify links, colors and font; a replay sends nothing.
2. Assets chosen by Google verify by presence, through the legacy action name.
3. Fourteen malformed requests fail before any request.
4. Search, already enabled, travel goals, removed and unknown campaigns, and an over-long business name, a non-square or small logo, a landscape logo of the wrong ratio and an unknown asset are refused after reading, without writes.
5. A result with an enablement error is a failure and is not resubmitted; an ignored enablement is not verified.
6. The method and models match the pinned Discovery document, and the ledger lists both actions in the family.

Red/green against a build of `3dac065`: all six tests fail (no reviewed family: both actions were blocked). Local log:
`.runtime/google-pmax-brand-20260927/red-check.log`.

## Verification

- Targeted: 150 related suite files, including every Google, DV360, LinkedIn, Snapchat, media, scope and
  security suite, with FFmpeg configured: 1,783/1,783.
- Guidance coverage: 269 write-path refusals across 148 modules accounted for.
- Full qualification: see
  [GOOGLE-PMAX-BRAND-GUIDELINES-VERIFICATION-2026-09-27.json](GOOGLE-PMAX-BRAND-GUIDELINES-VERIFICATION-2026-09-27.json).

Remaining rows: 879 (two Google Ads rows reviewed; Google Ads blocked writes 96 → 94). Live
acceptance is unverified; it needs the updated deployment and a Performance Max campaign without
brand guidelines.
