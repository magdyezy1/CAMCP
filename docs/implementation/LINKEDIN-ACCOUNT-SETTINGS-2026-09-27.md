---
status: record
tier: engineering
---

# LinkedIn ad account name and notifications — 2026-09-27

Base revision: `0f2ad86` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: an ad account could be read but not renamed, and its Campaign Manager notifications could not be
switched through AMCP: `POST /rest/adAccounts/{id}` was a blocked write.

Contract source: "Create and Manage Ad Accounts" (li-lms-2026-09), read on 2026-09-28. "Ad Accounts
can be updated through a partial update by patching the fields you want to change. A successful
response returns a 204 No Content HTTP status code." The schema lists `name` ("A label for the
account") and five notification switches; `status` values include PENDING_DELETION (deletion) and
CANCELED ("permanently canceled"); `test` is immutable, `type` and `currency` are set at creation, and
`reference` names "The entity on whose behalf the account is advertised".

## Change

New reviewed family `linkedin_account_settings` (`src/linkedin-account-settings.ts`):

| Part | Behaviour |
|---|---|
| Request | A versioned REST.li 2.0 PARTIAL_UPDATE of the selected account with `{patch: {$set}}` of `name` (1–255 characters) and/or the switches `notifiedOnCampaignOptimization`, `notifiedOnCreativeApproval`, `notifiedOnCreativeRejection`, `notifiedOnEndOfCampaign`, `notifiedOnNewFeaturesEnabled` (true or false) |
| State | The account: name, status, type and the switches (not its serving statuses, which change on their own) |
| Checks | Accounts that are CANCELED, pending deletion or REMOVED are refused; unchanged values are refused; writes need `rw_ads` |
| Scope | `src/scope.ts` accepts the validated update and its marked read for the selected account |
| Safety | Names and notifications change no delivery, so no spending confirmation |
| Receipt | 204 (or an empty 200); anything else is a failure never resubmitted |
| Verification | The account read again: the changed fields |

`status`, `reference` and the immutable fields stay out. The 255-character name bound is AMCP's; the
reference gives none. New refusal code: `INVALID_LINKEDIN_ACCOUNT_SETTING`.

Other code: `src/write-review.ts` (the check sits with the other REST.li families),
`src/write-verification.ts`, `src/write-impact.ts`, `src/preflight.ts` (spend pattern exemption),
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 18). Guidance: an account settings paragraph in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-account-settings.test.mjs`, three tests:

1. The account is renamed and two notification switches changed without spending confirmation; both verify; a replay sends nothing.
2. Nine malformed updates (a deletion status, a cancellation, another reference, a currency, a test flag, a padded name, a 256-character name, a switch as text, nothing) and a full UPDATE are refused before any request; an account pending deletion and an unchanged name are refused after reading; a connection without `rw_ads` is refused.
3. An error reply is never resubmitted; an ignored update is not verified; the ledger lists the row in the family.

Red/green against a build of `0f2ad86`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-account-settings-20260927/red-check.log`.

## Verification

- Targeted: 216 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,076/2,076.
- Guidance coverage: 348 write-path refusals across 210 modules accounted for.
- Full qualification: see
  [LINKEDIN-ACCOUNT-SETTINGS-VERIFICATION-2026-09-27.json](LINKEDIN-ACCOUNT-SETTINGS-VERIFICATION-2026-09-27.json).

Remaining rows: 697 (one LinkedIn row reviewed; LinkedIn blocked writes 88 → 87). Live acceptance is
unverified; it needs the updated deployment and a LinkedIn ad account the login manages.
