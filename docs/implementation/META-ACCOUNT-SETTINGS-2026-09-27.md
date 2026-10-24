---
status: record
tier: engineering
---

# Meta ad account name, EU payor and beneficiary — 2026-09-27

Base revision: `e53b8ce` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: ads that reach the EU name a payor and a beneficiary (Digital Services Act), which an ad account
can hold as defaults, but `POST /act_{ad_account_id}` (captured as `meta_ad_account_id_create`) was a
blocked write, so neither the defaults nor the account name could change.

Contract source: the Marketing API v25.0 "Ad Account" reference, read on 2026-09-27. Updating takes
`name`, `default_dsa_payor` and `default_dsa_beneficiary` ("can be set to both of them or none of
them ... To unset the values: pass two empty strings at the same time"), `is_notifications_enabled`,
`spend_cap` (in standard units, "e.g. 23.50 for USD $23.50", while the field reads in the account's
minor units) and `spend_cap_action`, and `end_advertiser`, `media_agency` and `partner` ("Once it is
set to any values other than NONE or UNFOUND, it cannot be modified any more"); it returns
`{success}`. Reading `/act_{ad_account_id}` returns the same fields.

## Change

New reviewed family `meta_account_settings` (`src/meta-account-settings.ts`):

| Part | Behaviour |
|---|---|
| Request | `name` (1–100 characters), both DSA defaults (up to 512 characters each) or both `""`, `is_notifications_enabled`. Spending caps, permanent fields, agency declarations, business information and deprecated settings are refused |
| State | The ad account: name, DSA defaults, notifications and status |
| Checks | Unchanged values are refused; writes need `ads_management` |
| Safety | No budget, spending cap or delivery changes, so no spending confirmation; unsetting the DSA defaults is named in the review |
| Receipt | A reply without `success` is a failure never resubmitted |
| Verification | The ad account read again, comparing the fields written |

New refusal code: `INVALID_META_ACCOUNT_SETTING`; `INSUFFICIENT_SCOPE` and `INCOMPLETE_STATE` are
reused.

Other code: `src/preflight.ts` (spending exemption), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Meta contract
version 16). Guidance: "Ad account name, EU payor and beneficiary" in
`Skills/amcp-campaign-builder/references/meta.md` and an executable inspect example.

## Tests

`tests/meta-account-settings.test.mjs`, three tests:

1. The account is renamed, its EU payor and beneficiary set and then unset, and notifications turned off; each verifies and a replay sends nothing.
2. Nine malformed requests (a spend cap, a spend cap reset, an end advertiser, a media agency, a payor alone, one empty value, a long name, notifications as text, an empty payload) are refused before any request; unchanged values are refused after reading; a connection without `ads_management` is refused.
3. An error reply is never resubmitted; an ignored change is not verified; the ledger lists the row in the family.

Red/green against a build of `e53b8ce`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/meta-account-settings-20260927/red-check.log`.

## Verification

- Targeted: 208 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,052/2,052.
- Guidance coverage: 340 write-path refusals across 202 modules accounted for.
- Full qualification: see
  [META-ACCOUNT-SETTINGS-VERIFICATION-2026-09-27.json](META-ACCOUNT-SETTINGS-VERIFICATION-2026-09-27.json).

Remaining rows: 709 (one Meta row reviewed; Meta blocked writes 115 → 114). Live acceptance is
unverified; it needs the updated deployment and a Meta ad account with `ads_management`.
