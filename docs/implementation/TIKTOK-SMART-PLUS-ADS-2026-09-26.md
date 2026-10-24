---
status: record
tier: engineering
---

# TikTok Upgraded Smart+ Spark Ads — 2026-09-26

Base revision: `bad418f` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 row "TikTok Upgraded Smart+ ads" in the [2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md).
Smart+ campaigns and website conversion ad groups could be created paused, but without ads a
Smart+ campaign cannot deliver; `/smart_plus/ad/create/` was a blocked write. Dynamic CTA
portfolios, its missing dependency, were qualified in the previous batch.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create an Upgraded Smart+ Ad](https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-ad/v1.3):
  at most 30 ads per ad group; `operation_status` defaults to `ENABLE`; Spark identities on the
  TikTok placement need `call_to_action_id`; `creative_auto_add_toggle` and
  `creative_auto_enhancement_strategy_list` default by allowlist status; `utm_params` only record
  parameters already in the landing page URL; the response carries `smart_plus_ad_id`.
- [Update an Upgraded Smart+ Ad](https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad/v1.3):
  `TRANSLATE_AND_DUB` cannot be added or removed after creation, so the review states that choice.
- [Upgraded Smart+ ad creative combinations by identity and ad type](https://business-api.tiktok.com/portal/docs/upgraded-smart-ad-creative-combinations-by-identity-and-ad-type/v1.3):
  Spark Ads from existing posts name 1-50 posts through `tiktok_item_id`, without video, image,
  music or ad text fields. Non-Spark ads no longer run on the TikTok placement.
- [Create a regular Upgraded Smart+ Web Campaign](https://business-api.tiktok.com/portal/docs/create-a-regular-upgraded-smart-web-campaign/v1.3):
  one landing page URL; Spark identities use only a dynamic CTA.
- [Get info about an identity](https://business-api.tiktok.com/portal/docs/get-info-about-an-identity/v1.3):
  `available_status`, `can_pull_video` and `is_gpppa` (such accounts cannot run Spark Ads).
- [Get info about TikTok posts](https://business-api.tiktok.com/portal/docs/get-info-about-tiktok-posts/v1.3):
  up to 20 `item_ids` per identity, each with `item_type` `VIDEO` or `CAROUSEL`; media URLs are
  signed and expire.
- [Get Upgraded Smart+ Ads](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ads/v1.3):
  returns the explicitly selected creatives, not automatically added ones.

## Contract

`tiktok_smart_plus_ad_create` (and its alias `tiktok_smart_ad_create`) is the new reviewed family
`tiktok_smart_plus_ads` (`src/tiktok-smart-plus-ads.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_AD` unless the ad is paused, named, and holds 1-20 existing posts (`SINGLE_VIDEO` or `CAROUSEL_ADS`, `TT_USER` or `BC_AUTH_TT` with its Business Center), one landing page, a CTA portfolio ID and both automatic creative switches set explicitly; UTM parameters must repeat the landing page's query exactly. Uploads, authorization-code posts, custom identities, ad texts, standard CTAs, add-ons and other keys are refused |
| Reads | The ad group, its ads, each identity, each identity's posts and the CTA portfolio, before review and again before execution |
| Checks | Website conversion ad group with the TikTok placement; fewer than 30 ads; identities available, able to use existing posts, not government or political accounts, in the stated Business Center; posts returned for their identity with the matching post type; a CTA portfolio (`INVALID_TIKTOK_CTA_PORTFOLIO` otherwise) |
| Review state | Signed media and profile URLs are left out, so unchanged posts and identities compare equal between review and execution |
| Spending | None: the ad is created paused |
| Receipt | `code: 0` with a numeric `smart_plus_ad_id` |
| Verification | One ad read comparing name, paused status, posts, landing page and configuration; TikTok's material IDs, added defaults and list order are ignored |

Not qualified: ad edits, uploads (Spark Ads Push), authorization-code posts, custom identities on
non-TikTok placements, catalog, lead generation and app ads, add-ons and disclaimers.

Other code: `src/tiktok-cta-portfolios.ts` (shared portfolio check), `src/write-review.ts`,
`src/review-state.ts`, `src/write-impact.ts`, `src/write-verification.ts`,
`src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok contract version 14),
`src/action-contracts.ts`. Guidance: "TikTok Upgraded Smart+ Spark Ads" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-ads.test.mjs`, six tests:

1. Both action names inspect as reviewed with no network.
2. 24 invalid requests, including an enabled or default status, uploads, custom and authorization-code identities, standard CTAs, implicit automatic switches and UTM parameters missing from the URL, are refused before any request, each on its own field; another advertiser is refused by the account scope check.
3. A video post, a photo post and a Business Center post read the ad group, its ads, both identities, their posts and the portfolio; although every read signs new media and profile URLs, execution needs no spending confirmation, creates once with the exact body and verifies despite TikTok's added material IDs, defaults and reordering; replay makes no second request.
4. A lead generation ad group, a Pangle-only ad group, a full ad group, a missing ad group, a private, a post-less and a political account, another Business Center, another account's post, a photo post as video and a display card as CTA are refused before any write.
5. An enabled or shortened read-back is inconclusive on that field; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.
6. Dependencies are read again before execution: an identity that became unavailable and a post that disappeared stop the ad.

Red/green: all six fail against a build of `bad418f` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-ads-20260926/red-check.log`.

## Verification

- Targeted: 1315/1315 across 97 related suites, including the CTA portfolio and Smart+ status
  suites after the shared portfolio check and the Smart+ ad read projection.
- Guidance coverage: 247 write-path refusals across 125 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-ADS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-ADS-VERIFICATION-2026-09-26.json).

Remaining rows: 942 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with a Smart+ website conversion ad group, an available
TikTok account identity with posts, and a CTA portfolio.
