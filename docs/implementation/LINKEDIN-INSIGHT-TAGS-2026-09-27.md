---
status: record
tier: engineering
---

# LinkedIn Insight Tags — 2026-09-27

Base revision: `993ee35` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: LinkedIn conversion tracking and website audiences start with the ad account's Insight Tag.
Creating it and switching its first-party tracking were blocked writes (two rows).

Contract source: the LinkedIn Marketing API "Conversion Tracking" guide (Insight Tags, Insight Tag
Permissions), li-lms-2025-10 to li-lms-2026-09, read on 2026-09-27. Key facts:

- `POST /rest/insightTags` with `{sponsoredAccounts: [urn]}` answers 201 with the ID in `x-restli-id`;
  "Passing multiple Ad accounts won't create insight tag"; "An account can have only one Insight Tag".
- A PARTIAL_UPDATE of `/rest/insightTags/{id}` sets `firstPartyTrackingEnabled`, which "will propagate
  to all the accounts with the same Insight Tag"; FULL access (not USE_ONLY) is needed to update a tag.
- `GET /rest/insightTags?q=account` finds the account's tag; `GET /rest/insightTagsPermission?q=account`
  gives its access role.

## Change

New reviewed family `linkedin_insight_tags` (`src/linkedin-insight-tags.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation for the selected account only; a PARTIAL_UPDATE that sets only `firstPartyTrackingEnabled`; versioned REST.li 2.0 headers; no query |
| Scope | Server-built reads of the account, its tag finder, its permission and the tag by ID |
| State | The ad account, the account's Insight Tag and, for an update, the tag with the accounts that share it and the account's access role |
| Checks | A second tag is `CONFIGURATION_EXISTS`; a tag that is not the account's, or without FULL access, is `ACCOUNT_SCOPE_MISMATCH`; an unchanged value is refused |
| Safety | Nothing spends or starts delivery; the review lists every account the setting reaches |
| Receipt | 201 with an ID for a creation, 204 for an update; anything else is a failure never resubmitted |
| Verification | The account's tag found again by the receipt's ID, or the tag read again with the new setting |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 11). Guidance: "Reviewed LinkedIn Insight
Tags" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-insight-tags.test.mjs`, three tests:

1. An account without a tag gets one and it verifies, and a replay sends nothing; the owner switches first-party tracking for both sharing accounts, verified.
2. Seven malformed requests fail before any request.
3. A second tag, a shared tag with USE_ONLY access, another account's tag and an unchanged setting are refused after reading; an ignored change is not verified; the ledger lists both writes in the family.

Red/green against a build of `993ee35`: two of the three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE); the malformed-request test passes because the base refuses the route before any request. Local log:
`.runtime/linkedin-insight-tags-20260927/red-check.log`.

## Verification

- Targeted: 184 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,934/1,934.
- Guidance coverage: 313 write-path refusals across 181 modules accounted for.
- Full qualification: see
  [LINKEDIN-INSIGHT-TAGS-VERIFICATION-2026-09-27.json](LINKEDIN-INSIGHT-TAGS-VERIFICATION-2026-09-27.json).

Remaining rows: 772 (two LinkedIn rows reviewed; LinkedIn blocked writes 105 → 103). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account.
