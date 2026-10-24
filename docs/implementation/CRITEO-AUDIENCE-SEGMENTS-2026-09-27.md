---
status: record
tier: engineering
---

# Criteo audience segments — 2026-09-27

Base revision: `3faac7b` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: retail media line items target audience segments. Creating, changing and deleting segments were
three blocked rows. The contact list add/remove and clear rows stay out: they carry customer data.

Contract source: the pinned Criteo Retail Media 2026-01 OpenAPI document (`bulkCreateAudienceSegments`,
`bulkUpdateAudienceSegments`, `bulkDeleteAudienceSegments`, `searchAudienceSegments`,
`SearchAccountRetailers`; `RmAudienceSegmentCreateEntityV1`, `RmAudienceSegmentUpdateEntityV1`,
`RmEventsCreateV1`, `RmEventsUpdateV1`, `RmContactListCreateV1`, `NillableString`,
`NillableDecimal`), read on 2026-09-27. Key facts:

- A segment has a name and a retailer (both required) and either Events rules (`shopperActivity` and
  `lookbackDays` required; categories, brands and a price range optional) or a contact list
  identifier type.
- Updates change the name, the description and event rules; nillable fields take `{value}`.
- Writes need `RetailMedia_Audience_Manage`, the segment search `RetailMedia_Audience_Read`, the
  retailer search `RetailMedia_Campaign_Read`.

## Change

New reviewed family `criteo_audience_segments` (`src/criteo-audience-segments.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–50 segments per request: creations with Events rules or an empty contact list; updates of name, description and event rules; deletions by ID |
| State | The account's retailer search (creations) or segment search (updates and deletions); both account-scoped |
| Checks | Unknown retailers and segments, other accounts' segments, event rules on contact lists and unchanged values are refused |
| Safety | New event rules need `spend_change_confirmed` and count as activation; deletion counts as a deletion; creation serves nothing |
| Receipt | 200 or 201 with one row per segment, no errors or warnings; anything else is a failure never resubmitted |
| Verification | The segments searched again: every field written, deleted ones gone |

Other code: `src/preflight.ts`, `src/spend-policy.ts`, `src/execution-risk.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Criteo contract version 10). Guidance:
"Audience segments (2026.01)" in `Skills/amcp-campaign-builder/references/criteo.md` and an executable
inspect example.

## Tests

`tests/criteo-audience-segments.test.mjs`, four tests:

1. An Events segment and an empty contact list segment are created together and verify; creation needs no confirmation; a replay sends nothing.
2. New event rules need confirmation and verify; a rename with a cleared description needs none; deletion verifies gone; owner deletion and activation rules apply.
3. Twelve malformed requests fail before any request.
4. An unknown retailer and segment, another account's segment, event rules on a contact list and an unchanged name are refused without writes; a response with warnings is never resubmitted; an ignored update is not verified; a connection without the manage scope is refused; the model and ledger match.

Red/green against a build of `3faac7b`: three of the four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE); the malformed-request test passes because the base refuses the route before any request. Local log:
`.runtime/criteo-audience-segments-20260927/red-check.log`.

## Verification

- Targeted: 171 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,881/1,881.
- Guidance coverage: 297 write-path refusals across 168 modules accounted for.
- Full qualification: see
  [CRITEO-AUDIENCE-SEGMENTS-VERIFICATION-2026-09-27.json](CRITEO-AUDIENCE-SEGMENTS-VERIFICATION-2026-09-27.json).

Remaining rows: 807 (three Criteo rows reviewed; Criteo blocked writes 32 → 29). Live acceptance is
unverified; it needs the updated deployment and a Criteo account with a retailer.
