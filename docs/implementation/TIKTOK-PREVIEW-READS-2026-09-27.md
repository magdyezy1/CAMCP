---
status: record
tier: engineering
---

# TikTok previews and Smart Text — 2026-09-27

Base revision: `03d7b89` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: three TikTok requests use POST and change nothing in the ad account: the ad and creative
preview, the Upgraded Smart+ ad preview and Smart Text recommendations. The captured catalog marks
them as reads, but they failed independent read classification (a POST outside the TikTok read
allowlist, and a path with "create"), so their six rows were unqualified reads that could not run.
Buyers use previews to check an ad before creating it and Smart Text to draft ad texts.

Contract source, read in the rendered TikTok API for Business documentation on 2026-09-27:

- "Preview an ad or a creative" (`POST /v1.3/creative/ads_preview/create/`): `preview_type`
  `ADS_CREATION` (an ad you plan to create), `AD` (an existing ad), `CARD` (an interactive add-on),
  `PAGE` (an instant page), `SINGLE_VIDEO` or `SINGLE_IMAGE`, each with its own fields. The reply
  carries `preview_link`, `iframe` and `tips`; the link is valid for "30 days when preview_type is
  ADS_CREATION or AD" and "24 hours when preview_type is CARD, PAGE, SINGLE_VIDEO or SINGLE_IMAGE".
- "Preview Upgraded Smart+ Ads" (`POST /v1.3/smart_plus/ad/preview/`): `ADS_CREATION` with a
  `creative_list` of 1–31 creatives, up to 5 ad texts and up to 3 calls to action (not together
  with `call_to_action_id`), or `AD` with `smart_plus_ad_id`; the link is valid for 30 days.
- "Get Smart Text recommendations" (`POST /v1.3/creative/smart_text/generate/`): `adgroup_id`,
  `param_type` `RECOMMENDED` or `CUSTOMIZED` (default; then `language` `EN`, `JA`, `RU` or `VI`
  and `keywords` are required), `industry_id` and `limit` 1–20. Smart Text "is not available to
  ad accounts in the United States and Canada".

## Change

`src/tiktok-preview-reads.ts` validates the three requests during compilation and marks a valid
request read-only; `src/execution-risk.ts` classifies the three routes as reads (the preview's
"create" path word is not taken as a write for this exact route). They run through the normal
native read path with the advertiser scope check, and never through `amcp_write`.

| Request | Accepted |
|---|---|
| Ad or creative preview | A documented `preview_type` and only its fields: `ADS_CREATION` needs `objective_type`, `identity_id`, `identity_type` and `ad_format` from the documented values, a video (or TikTok post) for a single video, images for a single image, the Business Center of a `BC_AUTH_TT` identity or a store, at most 35 images and 20 showcase products; `AD` needs a numeric `ad_id`; `CARD` a `card_id`; `PAGE` a `page_id`; `SINGLE_VIDEO` and `SINGLE_IMAGE` the media, `display_name`, `ad_text` and `placements` |
| Upgraded Smart+ preview | `ADS_CREATION` with 1–31 creatives each with `creative_info`, 1–5 ad texts, 1–3 calls to action and not also `call_to_action_id`, and `catalog_id` when `catalog_enabled`; or `AD` with a numeric `smart_plus_ad_id` |
| Smart Text | A numeric `adgroup_id`; `RECOMMENDED`, or `CUSTOMIZED` with a language and 1–50 different keywords of up to 100 characters (AMCP's bound); `limit` 1–20 |
| All three | The selected advertiser as `advertiser_id`; every field in the JSON body (no query parameters); no header overrides; at most 64 KiB; `INVALID_TIKTOK_PREVIEW_READ` otherwise, before any request |

Compiled requests carry a warning: a preview link stays valid for 30 days (24 hours for add-on,
page, video and image previews) and opens for anyone who has it; Smart Text sends nothing back
about which text is used. Sending Smart Text feedback (`tiktok_creative_smart_text_feedback`)
stays a blocked write.

The captured catalog lists the required fields of every preview variant together (and a nested
Smart+ field), so no single valid preview carries them all. The enhanced mode's catalog preflight
(`src/compiler.ts`) now skips the two preview routes, whose own validation checks each variant's
required fields; Smart Text keeps the catalog preflight.

The action ledger now classifies the six rows as native reads. Other code:
`src/provider-contracts.ts` (TikTok contract version 26). Guidance: "TikTok previews and Smart
Text" in `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`, with three dry-run examples
(`tiktok_preview_reads` in `Skills/amcp-campaign-builder/examples/contracts.json`) that
`tests/guide-contract-examples.test.mjs` compiles without egress.

## Tests

`tests/tiktok-preview-reads.test.mjs`, five tests:

1. A reader runs an ad preview (and an existing ad preview through the alias) on a read-only deployment: one POST each with the exact body, and TikTok's link returned unchanged; dry runs are read-only, without a request, and state the 30-day or 24-hour link lifetime.
2. Upgraded Smart+ previews (planned and existing) and Smart Text (customized and recommended) run as reads through both action names.
3. Twenty malformed requests fail with `INVALID_TIKTOK_PREVIEW_READ` before any request (unknown preview type, fields of another type, missing or non-numeric IDs, unknown objective, missing Business Centers, media or placements, empty or oversized Smart+ lists, a CTA list with a CTA portfolio, Smart Text without language or keywords, 21 texts, an unsupported language, an extra field, a query parameter); another advertiser fails with `CONNECTION_REQUIRED` and a conflicting `advertiser_id` with `ACCOUNT_SCOPE_MISMATCH`.
4. In enhanced mode with catalog preflight, single preview variants compile as reads; Smart Text still needs `adgroup_id` from the catalog preflight.
5. The action ledger classifies the six actions as native reads; Smart Text feedback stays a blocked write.

Changed tests: `tests/compiler.test.ts` compiles every catalog action with placeholder arguments;
the three routes now validate their body during compilation, so the test gives each one variant's
fields, as it does for the X audience estimate and the Snapchat planning reads.
`tests/guide-contract-examples.test.mjs` compiles the three new examples.

Red/green against a build of `03d7b89`: all five tests fail (previews are refused as writes, LIVE_WRITES_DISABLED; the catalog preflight asks for every variant's parameters; the ledger lists them as unqualified reads). Local log:
`.runtime/tiktok-preview-reads-20260927/red-check.log`.

## Verification

- Targeted: 199 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,986/1,986.
- Guidance coverage: 331 write-path refusals across 196 modules accounted for.
- Full qualification: see
  [TIKTOK-PREVIEW-READS-VERIFICATION-2026-09-27.json](TIKTOK-PREVIEW-READS-VERIFICATION-2026-09-27.json).

Remaining rows: 729 (six TikTok rows are now native reads; unqualified reads 23 → 17). Live
acceptance is unverified; it needs the updated deployment and a TikTok advertiser.
