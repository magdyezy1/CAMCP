---
status: record
tier: engineering
---

# Google Ads account settings, automatically created asset removal and YouTube uploads — 2026-09-27

Base revision: `e9db0db` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: three small Google Ads gaps, seven blocked rows. Account settings (auto-tagging, tracking
template, final URL suffix, call reporting, video suitability) are set before campaigns report
correctly; automatically created assets are removed when they do not fit a brand; and videos
uploaded through the API need their privacy changed or their removal.

Contract source: the pinned Google Ads API v23 Discovery document (`CustomerService.MutateCustomer`,
`Customer`, `CallReportingSetting`; `AdGroupAdService.RemoveAutomaticallyCreatedAssets`,
`AutomaticallyCreatedAssetRemovalService.RemoveCampaignAutomaticallyCreatedAsset`, the asset links'
`source`; `YouTubeVideoUploadService.UpdateYouTubeVideoUpload` and `RemoveYouTubeVideoUpload`,
`YouTubeVideoUpload`), read on 2026-09-27. Key facts:

- Customer settings are "Only mutable in an update operation"; the time zone and currency are
  immutable; `videoBrandSafetySuitability` is EXPANDED, STANDARD or LIMITED inventory.
- The campaign removal request requires `partialFailure`; both removals name the asset and its field
  type; asset links carry `source` ADVERTISER or AUTOMATICALLY_CREATED.
- Upload updates change "metadata, but only for videos uploaded using this API": the title,
  description and channel are immutable, and the privacy is "only mutable for videos uploaded to the
  advertiser owned (brand) YouTube channel". Removal "removes YouTube videos uploaded using this API".

## Change

Three new reviewed families:

| Family | Requests | Checks | Safety | Verification |
|---|---|---|---|---|
| `google_customer_settings` (`src/google-customer-settings.ts`) | One update of auto-tagging, tracking template (with `{lpurl}`), final URL suffix, descriptive name, call reporting fields or video suitability | The customer's settings; a call conversion action must be enabled; unchanged requests refused | Suitability changes need `spend_change_confirmed`; a broader suitability counts as activation | Settings read again |
| `google_auto_assets` (`src/google-auto-assets.ts`) | Removal from one ad (`assetsWithFieldType`) or from campaigns (`operations`, `partialFailure: false`), 1–50 | The ad or campaign and its automatically created links; advertiser assets and unlinked assets refused | Removals count as deletions; a partial failure is a failure never resubmitted | Links read again, removed ones gone |
| `google_youtube_uploads` (`src/google-youtube-uploads.ts`) | Privacy of one upload (`updateMask: videoPrivacy`), or removal of 1–20 | Each upload, its channel and state, and the video assets that use it | Removal counts as a deletion; the review names affected video assets | Privacy read again, or uploads gone |

Other code: `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract version 25). Guidance: the
"Account settings", "Automatically created assets" and "YouTube video uploads" sections of
`Skills/amcp-campaign-builder/references/google-ads.md` and three executable inspect examples.

## Tests

- `tests/google-customer-settings.test.mjs` (4): tracking settings, name, call conversions and auto-tagging (snake_case input) are updated and verify; a suitability change needs confirmation and only a broader one is activation; twelve malformed requests fail before any request; unchanged settings, removed or unknown conversion actions, a receipt for another customer and an ignored update are handled; the model matches the pinned document; the ledger lists the write.
- `tests/google-auto-assets.test.mjs` (3): removals from an ad and a campaign verify; an owner deletion rule refuses them; six malformed requests fail before any request; advertiser assets, unlinked assets and unknown campaigns are refused; a partial failure is never resubmitted; an ignored removal is not verified; the ledger lists both writes.
- `tests/google-youtube-uploads.test.mjs` (3): a brand channel video becomes public and verifies; removal names the video asset that uses it and verifies gone; the deletion rule applies; five malformed requests fail before any request; Google-managed channel videos, failed uploads, unchanged privacy and unknown uploads are refused; a receipt naming other uploads is never resubmitted; an ignored update is not verified; the ledger lists the four writes.

Red/green against a build of `e9db0db`: all ten tests fail (no reviewed family: the seven rows were blocked writes). Local log:
`.runtime/google-account-assets-20260927/red-check.log`.

## Verification

- Targeted: 167 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,867/1,867.
- Guidance coverage: 291 write-path refusals across 164 modules accounted for.
- Full qualification: see
  [GOOGLE-ACCOUNT-SETTINGS-ASSETS-UPLOADS-VERIFICATION-2026-09-27.json](GOOGLE-ACCOUNT-SETTINGS-ASSETS-UPLOADS-VERIFICATION-2026-09-27.json).

Remaining rows: 816 (seven Google Ads rows reviewed; Google Ads blocked writes 71 → 64). Live
acceptance is unverified; it needs the updated deployment and a Google Ads customer.

Also checked and left: `configureCampaignLifecycleGoals` and `configureCustomerLifecycleGoals` (four
rows) carry only output-only fields in v23, so there is nothing to write; the v23 `Goals` and
`CampaignGoalConfigs` services cover customer retention goals, whose targeting option is allowlisted.
