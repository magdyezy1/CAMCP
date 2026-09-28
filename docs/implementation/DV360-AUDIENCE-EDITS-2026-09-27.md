# DV360 customer match audience names — 2026-09-27

Base revision: `7a4cda4` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertiser customer match audiences could be read and targeted through AMCP but not renamed:
`PATCH /v4/firstPartyAndPartnerAudiences/{id}` was a blocked write.

Contract source: the pinned Display & Video 360 API v4 Discovery document
(`firstPartyAndPartnerAudiences.patch` and `get`, `FirstPartyAndPartnerAudience`), read on
2026-09-28. The patch "Updates an existing FirstPartyAndPartnerAudience. Only supported for the
following audience_type: CUSTOMER_MATCH_CONTACT_INFO, CUSTOMER_MATCH_DEVICE_ID"; `updateMask` is
required and "Updates are only supported for the following fields: displayName, description,
membershipDurationDays"; `advertiserId` is "The ID of the owner advertiser". The description is
"Only applicable to first party audiences".

## Change

New reviewed family `dv360_audience_edits` (`src/dv360-audience-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | Query `advertiserId` (the selected advertiser) and `updateMask` of `displayName` and/or `description`; a body of exactly those fields: a name of 1–240 bytes, a description of at most 1,000 characters |
| State | The audience read with the advertiser as accessor: type, first- or third-party, source, name and description (not its changing sizes) |
| Checks | The advertiser can read the audience (`STATE_NOT_FOUND`); it is a customer match audience; a description only for first-party audiences; unchanged values are refused |
| Scope | `src/scope.ts` accepts the validated patch for the selected advertiser; the audience read uses the existing audience read rule |
| Safety | Names and descriptions change no delivery, so no spending confirmation |
| Receipt | 200 with the audience; anything else is a failure never resubmitted |
| Verification | The audience read again: the changed fields |

`membershipDurationDays` stays out: it decides how long uploaded customers remain members. Members
(`editCustomerMatchMembers`) are customer data and stay out as well. The 240-byte name bound follows
the other DV360 display names; the 1,000-character description bound is AMCP's. New refusal code:
`INVALID_DV360_AUDIENCE_EDIT`.

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/preflight.ts` (spend pattern exemption), `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (DV360 contract version 19). Guidance: an
audience edit paragraph in `Skills/amcp-campaign-builder/references/dv360-and-measurement.md` and an
executable inspect example.

## Tests

`tests/dv360-audience-edits.test.mjs`, three tests:

1. A contact list audience is renamed and re-described and a device ID audience renamed, without spending confirmation; each verifies; a replay sends nothing.
2. Eight malformed edits (a membership duration, a field outside the mask, a mask field missing from the body, a repeated mask field, a padded name, a 241-byte name, a 1,001-character description, members) and a partner read are refused before any request; a COMMON audience, a partner audience's description, a missing audience and an unchanged name are refused after reading; a connection without the display-video scope is refused.
3. An error reply is never resubmitted; an ignored edit is not verified; the ledger lists the row in the family.

Red/green against a build of `7a4cda4`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/dv360-audience-edits-20260927/red-check.log`.

## Verification

- Targeted: 215 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,073/2,073.
- Guidance coverage: 347 write-path refusals across 209 modules accounted for.
- Full qualification: see
  [DV360-AUDIENCE-EDITS-VERIFICATION-2026-09-27.json](DV360-AUDIENCE-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 698 (one DV360 row reviewed; DV360 blocked writes 30 → 29). Live acceptance is
unverified; it needs the updated deployment and a DV360 advertiser with a customer match audience.
