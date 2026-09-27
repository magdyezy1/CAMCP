# DV360 advertiser settings — 2026-09-27

Base revision: `a7f4754` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the advertiser holds settings every campaign depends on (its status, domain, default business
name and logo for YouTube and Demand Gen ads, integration code, the EU political advertising
declaration). `DV360_ADVERTISERS_PATCH` was a blocked write (one row).

Contract source: the pinned Display & Video 360 API v4 Discovery document (`advertisers.patch`,
`Advertiser`, `AdvertiserGeneralConfig`, `AdvertiserTargetingConfig`, `IntegrationDetails`,
`AdAsset`), read on 2026-09-27. Key facts:

- `entityStatus` "controls whether or not insertion orders and line items of the advertiser can spend
  their budgets and bid on inventory"; SCHEDULED_FOR_DELETION deletes the advertiser after 30 days.
- `domainUrl` is given "with no path or query string"; `defaultLogoAssetId` is an ad asset uploaded
  with `advertisers.adAssets.upload`.
- `containsEuPoliticalAds` set to DOES_NOT_CONTAIN applies to new line items, and existing undeclared
  ones "within a day".
- Several creative flags are consents ("you, on behalf of your company, authorize Google"), and
  billing and ad server settings are required, some immutable.

## Change

New reviewed family `dv360_advertiser_settings` (`src/dv360-advertiser-settings.ts`):

| Part | Behaviour |
|---|---|
| Request | `updateMask` among the name, status (ACTIVE or PAUSED), domain, default business name and logo, integration code, TV viewability exemption and EU political declaration; the body carries exactly those fields |
| Out of scope | Deletion scheduling, billing, ad server, currency, partner, data access and consent flags |
| State | The advertiser; the logo ad asset when one is named (an active image asset) |
| Safety | Activating needs `spend_change_confirmed` and counts as activation; pausing does not; the review states the declaration's effect on line items |
| Receipt | 200 with the same advertiser; anything else is a failure never resubmitted |
| Verification | The advertiser read again, every field written compared |

Other code: `src/preflight.ts`, `src/spend-policy.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (DV360 contract version 15). Guidance:
"Advertiser settings" in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an
executable inspect example.

## Tests

`tests/dv360-advertiser-settings.test.mjs`, four tests:

1. The name, domain, default business name, logo and integration code change and verify, other settings untouched; a replay sends nothing.
2. Activation needs confirmation and verifies; the TV viewability exemption and pausing need none; an owner activation rule refuses activation but not a rename.
3. Ten malformed requests (deletion, billing, a consent flag, a domain with a path, the currency, unmasked fields, an unknown declaration, a logo name, a long name) fail before any request.
4. Unchanged settings, a video asset as logo and an unknown asset are refused without writes; a receipt for another advertiser is never resubmitted; an ignored update is not verified; the model and ledger match.

Red/green against a build of `a7f4754`: three of the four tests fail (no reviewed family: the advertiser patch was a blocked write); the malformed-request test passes because the base refuses the route before any request. Local log:
`.runtime/dv360-advertiser-settings-20260927/red-check.log`.

## Verification

- Targeted: 170 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,877/1,877.
- Guidance coverage: 296 write-path refusals across 167 modules accounted for.
- Full qualification: see
  [DV360-ADVERTISER-SETTINGS-VERIFICATION-2026-09-27.json](DV360-ADVERTISER-SETTINGS-VERIFICATION-2026-09-27.json).

Remaining rows: 810 (one DV360 row reviewed; DV360 blocked writes 36 → 35). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser.
