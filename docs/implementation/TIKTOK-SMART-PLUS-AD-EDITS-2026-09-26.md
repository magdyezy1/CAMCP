# TikTok Upgraded Smart+ Spark Ad edits — 2026-09-26

Base revision: `3b009b2` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 row "TikTok Upgraded Smart+ ad edits" in the [2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md).
Smart+ Spark Ads can be created paused; changing their posts, landing page, CTA portfolio or name
is everyday management, and `/smart_plus/ad/update/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Update an Upgraded Smart+ Ad](https://business-api.tiktok.com/portal/docs/update-an-upgraded-smart-ad/v1.3):
  incremental updates, except that `creative_list` is replaced in full; `ad_material_id` is
  allowlist-only and makes TikTok ignore `creative_info`; `TRANSLATE_AND_DUB` cannot be added or
  removed after creation; the response carries the updated ad.
- [Get Upgraded Smart+ Ads](https://business-api.tiktok.com/portal/docs/get-upgraded-smart-ads/v1.3):
  the current posts, landing page, configuration and status, including
  `AD_STATUS_DELIVERY_AND_REAUDIT` for modifications under review.
- The identity, post and portfolio sources of the [Smart+ Spark Ad batch](TIKTOK-SMART-PLUS-ADS-2026-09-26.md).

## Contract

`tiktok_smart_plus_ad_update` (and its alias `tiktok_smart_ad_update`) is the new reviewed family
`tiktok_smart_plus_ad_edits` (`src/tiktok-smart-plus-ad-updates.ts`). The creation checks moved
into reusable parts of `src/tiktok-smart-plus-ads.ts`.

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_SMART_PLUS_AD` unless the request names the ad and edits at least one of the name, the posts, the landing page and the configuration, each validated as for creation. Status, `ad_material_id` and other keys are refused |
| Reads | The ad; for new posts, each identity and its posts; for a new configuration, the CTA portfolio. Before review and again before execution |
| Checks | Any Smart+ ad can be renamed; other edits need an ad from existing posts with one landing page and a CTA portfolio, not terminated. `TRANSLATE_AND_DUB` keeps its membership; a new configuration restates existing UTM parameters; the UTM parameters in effect repeat the landing page in effect |
| Impact | Name, landing page and configuration before and after; kept, added and removed posts; whether the ad is enabled |
| Confirmation | Removing posts from an enabled ad is refused with `CREATIVE_EDIT_CONFIRMATION_REQUIRED` until the review is prepared and executed with `creative_edit_confirmed: true` (the flag was X-only) |
| Receipt | Existing TikTok rule for updates: `code: 0` |
| Verification | One ad read comparing the edited fields |

Not qualified: status changes (the Smart+ status family), `ad_material_id`, uploads,
authorization-code posts, custom identities, ad texts, standard CTAs and add-ons.

Other code: `src/write-review.ts` (including the `creative_edit_confirmed` allowance),
`src/write-impact.ts`, `src/write-verification.ts`, `src/reviewed-routes.ts`,
`src/provider-contracts.ts` (TikTok contract version 15), `src/action-contracts.ts`. Guidance:
"TikTok Upgraded Smart+ Spark Ad edits" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-smart-plus-ad-updates.test.mjs`, seven tests:

1. Both action names inspect as reviewed with no network.
2. 9 invalid requests, including a status change, `ad_material_id`, an upload, a custom identity, an implicit automatic switch and UTM parameters missing from a new URL, are refused before any request, each on its own field; another advertiser is refused by the account scope check.
3. An ad with an uploaded video is renamed after reading only the ad, verifies, and replays without a second request.
4. Replacing the posts of a paused ad lists kept, added and removed posts, reads the identity and posts, and verifies although TikTok reorders them.
5. Removing a post from an enabled ad is refused until prepared with `creative_edit_confirmed`, execution without the flag is refused, and with it the edit verifies; adding posts needs no confirmation.
6. Post edits on an upload ad, a terminated ad, adding or removing `TRANSLATE_AND_DUB`, dropped UTM parameters, a new URL without them, a display card as CTA, a private account's post and a missing ad are refused before any write.
7. A drifted read-back is inconclusive; a TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.

Red/green: all seven fail against a build of `3b009b2` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/tiktok-smart-plus-ad-updates-20260926/red-check.log`.

## Verification

- Targeted: 1322/1322 across 98 related suites, including the Smart+ Spark Ad suite after the
  creation checks moved into reusable parts.
- Guidance coverage: 247 write-path refusals across 126 modules accounted for.
- Full qualification: see
  [TIKTOK-SMART-PLUS-AD-EDITS-VERIFICATION-2026-09-26.json](TIKTOK-SMART-PLUS-AD-EDITS-VERIFICATION-2026-09-26.json).

Remaining rows: 940 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment and a test advertiser with a Smart+ Spark Ad.
