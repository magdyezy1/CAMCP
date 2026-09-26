# TikTok dynamic CTA portfolios — 2026-09-26

Base revision: `b8338ab` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md), and the P1 row "TikTok Upgraded Smart+ ads" in
the [2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md). A dynamic call-to-action portfolio is the
first missing dependency of Smart+ website conversion ads on TikTok, and manual ads use the same
portfolios; `/creative/portfolio/create/` was a blocked write.

Contract source: TikTok API for Business v1.3, read in the rendered portal on 2026-09-26:

- [Create a portfolio](https://business-api.tiktok.com/portal/docs/create-a-portfolio/v1.3):
  `creative_portfolio_type` `CTA` with `portfolio_content` groups of `asset_content` and
  `asset_ids`; the response carries `creative_portfolio_id`. CTA IDs work only in the advertiser
  they were created for.
- [Get recommended CTAs](https://business-api.tiktok.com/portal/docs/get-recommended-ctas/v1.3)
  and [CTA recommendations](https://business-api.tiktok.com/portal/docs/cta-recommendations/v1.3):
  the recommended groups (`new_version: true` with objective and promotion type), then the
  portfolio, then `call_to_action_id` on manual or Smart+ ads.
- [Get a portfolio by ID](https://business-api.tiktok.com/portal/docs/get-a-portfolio-by-id/v1.3):
  the documented read-back returns CTA text in TikTok's own form (`learn_more`) and may omit the
  ID and type. [Get portfolios within an ad account](https://business-api.tiktok.com/portal/docs/get-portfolios-within-an-ad-account/v1.3)
  excludes CTA portfolios.
- [Create ads](https://business-api.tiktok.com/portal/docs/create-ads/v1.3) and
  [Update ads](https://business-api.tiktok.com/portal/docs/update-ads/v1.3): when both
  `call_to_action` and `call_to_action_id` are sent, `call_to_action` is ignored.

## Contract

`tiktok_creative_portfolio_create` (and its alias `tiktok_cta_portfolio_create`) is the new
reviewed family `tiktok_cta_portfolios` (`src/tiktok-cta-portfolios.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any request, `INVALID_TIKTOK_CTA_PORTFOLIO` unless the type is `CTA` and `portfolio_content` holds 1-20 groups, each exactly a nonempty CTA text and 1-20 numeric-string CTA IDs, with no text or ID repeated. Other portfolio types and keys are refused |
| Reads | The advertiser, before review and again before execution |
| Spending | None: a portfolio neither delivers nor spends until an ad names it |
| Impact | The CTA texts and ID counts, and that the portfolio cannot be edited afterwards |
| Receipt | `code: 0` with a numeric `creative_portfolio_id` (the generic TikTok create rule would look for `creative_id`) |
| Verification | One portfolio read comparing the CTA groups as sets; texts compare without case, spaces and underscores alike; a non-CTA type is a mismatch |

Manual ads that name a portfolio (`tiktok_entities`, `/ad/create/` and `/ad/update/`):

| Stage | Behaviour |
|---|---|
| Validation | `creatives[].call_to_action_id` must be a numeric ID, and `call_to_action` beside it is refused because TikTok would ignore it |
| Reads | Each named portfolio, before review and again before execution |
| Checks | TikTok's error for a missing portfolio is returned (`PLATFORM_ERROR`); an empty read is `STATE_TARGET_MISMATCH`; a non-CTA portfolio is refused |

Not qualified: card, sticker, showcase, gesture and superlike portfolios, portfolio deletion, and
`card_id` references.

Other code: `src/write-review.ts`, `src/review-state.ts`, `src/write-impact.ts`,
`src/write-verification.ts`, `src/reviewed-routes.ts`, `src/provider-contracts.ts` (TikTok
contract version 13), `src/action-contracts.ts`. Guidance: "TikTok dynamic CTA portfolios" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/tiktok-cta-portfolios.test.mjs`, six tests:

1. Both action names inspect as reviewed with no network.
2. 13 invalid requests, including a display card, sticker fields, numeric IDs and repeated texts, are refused before any request, each on its own field; another advertiser is refused by the account scope check.
3. A portfolio reads only the advertiser, needs no spending confirmation, is created once with the exact body and verifies although TikTok reads the texts back as keys and reorders groups and IDs; replay makes no second request.
4. A read-back that lost a CTA ID, or reports another portfolio type, is inconclusive on that field.
5. A TikTok-declared error and a lost response each POST once across a restart; concurrent executions submit once.
6. A manual ad naming a portfolio reads it before review; the pair with `call_to_action`, a malformed ID, the same pair in an ad update, a display card, a missing and an empty portfolio are refused before any write; a valid reference creates the paused ad and verifies; a portfolio deleted after review stops execution.

Red/green: all six fail against a build of `b8338ab` (`WRITE_CONTRACT_UNAVAILABLE`, and the ad
reference test because the pair was accepted) and pass with this change. Local log:
`.runtime/tiktok-cta-portfolios-20260926/red-check.log`.

## Verification

- Targeted: 1309/1309 across 96 related suites.
- Review state: the portfolio read projection is idempotent (checked on CTA, card and empty reads).
- Guidance coverage: 246 write-path refusals across 124 modules accounted for.
- Full qualification: see
  [TIKTOK-CTA-PORTFOLIOS-VERIFICATION-2026-09-26.json](TIKTOK-CTA-PORTFOLIOS-VERIFICATION-2026-09-26.json).
  The first full run failed one unrelated test in teardown (`tests/linkedin-media-resume.test.mjs`,
  `EPERM` removing its temporary directory while other suites ran in the working copy); it passed
  alone three times in the same candidate, and the full run was repeated without other load.

Remaining rows: 944 (the route and its alias). Live acceptance is unverified; it needs the
updated deployment, a test advertiser and CTA IDs recommended for it.
