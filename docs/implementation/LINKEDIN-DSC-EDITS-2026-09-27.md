# LinkedIn DSC post edits and deletion — 2026-09-27

Base revision: `58cecd7` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Direct Sponsored Content posts could be created through the reviewed DSC family, but a typo in
the text or a changed landing page meant a new post and new creatives: `POST /rest/posts/{urn}` and
`DELETE /rest/posts/{urn}` were blocked writes.

Contract source: "Posts API" (li-lms-2026-09) and "Create and Manage Creatives" (Search for
Creatives), read on 2026-09-28. "Only the following posts fields are available to update through the
Posts API": commentary, contentCallToActionLabel, contentLandingPage, lifecycleState and adContext
(dscName, dscStatus), as a PARTIAL_UPDATE answering 204. "Post deletions are idempotent" (204);
"Batch delete of Posts is not supported". The creative search filters by `contentReferences` ("can
be share URN, or ugcPosts URN").

## Change

New reviewed family `linkedin_dsc_edits` (`src/linkedin-dsc-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | Edit: a versioned REST.li 2.0 PARTIAL_UPDATE of one `urn:li:ugcPost` or `urn:li:share` with `{patch: {$set}}` of commentary (1–3000 characters, as at creation), an HTTPS contentLandingPage and/or a documented contentCallToActionLabel. Deletion: one post, no payload |
| Scope | Only posts that AMCP created and verified with the same connection and account (the retained DSC record), with the organization binding and `w_organization_social` plus `r_organization_social` of their creation; `src/scope.ts` holds the check |
| State | The post (sponsoring account, author, editable fields) and the account's creatives that sponsor it (creative search by contentReferences, 100 a page, ten pages) |
| Checks | The post exists and is DSC of the selected account; a deletion is refused while any creative but a REMOVED one sponsors the post (`ASSET_IN_USE`); unchanged edits and a call-to-action label without a landing page are refused |
| Safety | An edit changes the ads that sponsor the post, so it needs `spend_change_confirmed=true`; the impact counts the active creatives |
| Receipt | 204 (or an empty 200); anything else is a failure never resubmitted |
| Verification | The post read again: the changed fields, or the post gone |

Lifecycle state and adContext stay out: DSC posts are created PUBLISHED with an ACTIVE DSC status,
and the reference does not document the values dscStatus accepts. The two-segment
`POST /rest/posts/{shared_id}/{ugc_posts_id}` row stays blocked: the reference has no such path. New
refusal code: `INVALID_LINKEDIN_DSC_EDIT`.

Other code: `src/write-review.ts` (the check sits with the other REST.li families),
`src/write-verification.ts`, `src/write-impact.ts`, `src/preflight.ts` (spending confirmation),
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 17). Guidance: a DSC edit paragraph in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-dsc-edits.test.mjs`, three tests:

1. A post with an active creative is edited only with spending confirmation and verifies; a replay sends nothing; an unused post and a post whose only creative is REMOVED are deleted through both action names and verify gone.
2. Seven malformed edits (a lifecycle change, an adContext change, empty commentary, 3001 characters, an HTTP landing page, an unknown label, nothing), a person URN, a full UPDATE and a deletion payload are refused before any request; a post AMCP did not create, a post of another sponsored account, a sponsored post, a missing post, an unchanged edit and a label without a landing page are refused; a connection without `w_organization_social` is refused.
3. An error reply is never resubmitted; an ignored edit and an ignored deletion are not verified; the ledger lists the three rows in the family.

Red/green against a build of `58cecd7`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-dsc-edits-20260927/red-check.log`.

## Verification

- Targeted: 214 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,070/2,070.
- Guidance coverage: 346 write-path refusals across 208 modules accounted for.
- Full qualification: see
  [LINKEDIN-DSC-EDITS-VERIFICATION-2026-09-27.json](LINKEDIN-DSC-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 699 (three LinkedIn rows reviewed; LinkedIn blocked writes 91 → 88). Live acceptance
is unverified; it needs the updated deployment and a DSC post created through AMCP.
