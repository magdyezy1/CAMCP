---
status: record
tier: engineering
---

# LinkedIn Audience Network publisher lists — 2026-09-27

Base revision: `00f480d` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: advertisers could not register an uploaded block or allow list, or apply lists at ad account
level. Publisher restriction creation and the account trust preferences update (two rows) were
blocked writes.

Contract source: the LinkedIn Marketing API "Manage Audience Restrictions" page
(li-lms-2025-10 to li-lms-2026-09), read on 2026-09-27. Key facts:

- A list is uploaded to a signed URL first; its `location` header names the media. `POST
  /rest/adPublisherRestrictions` with `{dataId, entity, fileName, type}` registers it (`type`
  BLOCKLIST by default, or ALLOWLIST); the new ID is in the `location` header.
- The finder `q=entity&entity={sponsoredAccount URN}` lists the account's files with `type` and a
  processing `status`.
- `PUT /rest/adAccountTrustPreferences/{sponsoredAccountId}` "performs an upsert" of
  `{offsiteAccountPreferences: {publisherRestrictionFiles: {include, exclude}}}` (204); `GET` on the
  same path reads it. With an allowlist "only ads on these domains/apps will be served"; with a
  blocklist "ads will not be served on these domains/apps".

## Change

New reviewed family `linkedin_publisher_restrictions` (`src/linkedin-publisher-restrictions.ts`):

| Part | Behaviour |
|---|---|
| Request | Registration: a CSV media URN, the selected account as `entity`, a file name of 1–255 characters and an optional type, with no query (upload and download URL actions stay outside); preferences: the selected account in the path and both `include` and `exclude` lists of at most 100 file URNs each, no file in both |
| Scope | Server-built reads only: the ad account, its publisher files (finder with paging) and its trust preferences |
| Checks | A file already registered is refused; preferences name files of the account, ALLOWLIST files in `include`, BLOCKLIST files in `exclude`, processed (SUCCESS) only; unchanged preferences are refused |
| Safety | No spending confirmation; the preferences review is marked as affecting serving and describes the resulting allow and block rules |
| Receipt | 201 with the new ID (`x-restli-id` or `location`) for a registration; 204 (or 200) for preferences; anything else is a failure never resubmitted |
| Verification | The files listed again with the new one's name, type and media, or the preferences read again with both lists compared |

The processing status of files is kept in the state only for preference reviews, which need it, so a
file finishing processing does not make a registration review stale.

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts` (checked before the generic
REST.li method refusal), `src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (LinkedIn
contract version 14). Guidance: "Reviewed LinkedIn Audience Network publisher lists" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-publisher-restrictions.test.mjs`, three tests:

1. An uploaded allowlist and a blocklist (default type) are registered and verify; account preferences are replaced and then cleared, each verified; an account without preferences gets them through the upsert; a replay sends nothing.
2. Ten malformed requests (another account, a URL instead of a media URN, blank names, unknown types, other fields, an upload URL action, a missing list, a file in both lists, a non-file URN, other preference fields) are refused before any request, and another account in the path is refused by the compiler; an already registered file, a file of another account, a blocklist in `include`, a processing file and unchanged preferences are refused after reading, without writes.
3. A refused update is never resubmitted; ignored registrations and updates are not verified; the ledger lists both writes in the family.

Red/green against a build of `00f480d`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-publisher-restrictions-20260927/red-check.log`.

## Verification

- Targeted: 194 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,967/1,967.
- Guidance coverage: 325 write-path refusals across 191 modules accounted for.
- Full qualification: see
  [LINKEDIN-PUBLISHER-RESTRICTIONS-VERIFICATION-2026-09-27.json](LINKEDIN-PUBLISHER-RESTRICTIONS-VERIFICATION-2026-09-27.json).

Remaining rows: 745 (two LinkedIn rows reviewed; LinkedIn blocked writes 96 → 94). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account with an uploaded list.
