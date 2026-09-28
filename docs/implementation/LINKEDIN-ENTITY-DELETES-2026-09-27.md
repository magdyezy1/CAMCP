# LinkedIn campaign group and creative batch deletion — 2026-09-27

Base revision: `2e16202` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: single campaign groups and creatives could be deleted through the reviewed entity family, but
the batch forms (`DELETE /rest/adAccounts/{id}/adCampaignGroups` and
`DELETE /rest/adAccounts/{id}/creatives` with `ids=List(...)`) were blocked writes, so cleaning up
drafts took one review per entity.

Contract source: "Create and Manage Campaign Groups" and "Create and Manage Creatives"
(li-lms-2026-09, pages updated 2026-09-16), read on 2026-09-28. "Use DELETE method to delete DRAFT
campaign groups. To start the process of deleting non DRAFT campaign groups, update the status to
PENDING_DELETION." Creatives can be deleted when they are DRAFT, linked to a DRAFT campaign, or video
creatives whose processingState is PROCESSING_FAILED. "Batch operations may only be performed on
entities that belong to the same Ad Account." A success answers 204; the creative sample answers
per-entity `results` and `errors`, so part of a batch can fail. REMOVED "denotes that the creative was
deleted, but must remain fetchable due to the existence of performance data".

## Change

New reviewed family `linkedin_entity_deletes` (`src/linkedin-entity-deletes.ts`):

| Part | Behaviour |
|---|---|
| Request | `restli_method: BATCH_DELETE`, only `query.ids` (1–25 distinct IDs: numeric campaign group IDs, or `urn:li:sponsoredCreative` URNs as the reference shows) and no payload |
| State | Each entity, read by its own path (a missing one is recorded as absent); for each deletable DRAFT group, a campaign search of that group (all statuses but REMOVED, one row); for each creative that is not DRAFT, its campaign |
| Checks | Every entity exists (`STATE_NOT_FOUND`) and belongs to the selected account (`RESOURCE_SCOPE_REQUIRED`); groups are DRAFT and hold no campaigns; creatives are DRAFT or in a DRAFT campaign and not already REMOVED or PENDING_DELETION; writes need `rw_ads` |
| Scope | `src/scope.ts` accepts the validated write and its marked reads: the account, entity and campaign paths of the selected account and the one-row campaign search |
| Receipt | 204, or 200 whose results cover every ID with status 204 and no errors; anything else, a partial deletion included, is a failure never resubmitted |
| Verification | Each entity read again; gone (404) or REMOVED counts as deleted |

Refusing groups that still hold campaigns is AMCP's own rule: the reference does not say what
deleting a group does to its campaigns, and a DRAFT group may hold campaigns that served before the
group went back to DRAFT. Video creatives whose processing failed are not deleted by this family:
processingState is not a field of the creative schema, so the condition cannot be read. New refusal
code: `INVALID_LINKEDIN_BATCH_DELETE`.

Other code: `src/write-review.ts` (the check sits with the other REST.li families, before the generic
method override refusal), `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (LinkedIn contract version 16). Guidance: a batch deletion paragraph in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-entity-deletes.test.mjs`, three tests:

1. Two DRAFT groups are deleted with a 204 reply and a DRAFT creative and a creative of a DRAFT campaign with per-entity results; the second creative stays readable as REMOVED; both verify; a replay sends nothing; a DRAFT creative needs no campaign read.
2. Eight malformed batches (a single DELETE method, another query parameter, a payload, a repeated ID, no IDs, 26 IDs, a group URN, a numeric creative ID) are refused before any request; a group of another account, an ACTIVE group in a mixed batch, a DRAFT group with a campaign, a missing group, a live creative, a creative of another account and a REMOVED creative are refused after reading; a connection without `rw_ads` is refused.
3. An error reply and a partial reply are never resubmitted; an ignored deletion is not verified; the ledger lists both rows in the family.

Red/green against a build of `2e16202`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-entity-deletes-20260927/red-check.log`.

## Verification

- Targeted: 210 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,058/2,058.
- Guidance coverage: 342 write-path refusals across 204 modules accounted for.
- Full qualification: see
  [LINKEDIN-ENTITY-DELETES-VERIFICATION-2026-09-27.json](LINKEDIN-ENTITY-DELETES-VERIFICATION-2026-09-27.json).

Remaining rows: 706 (two LinkedIn rows reviewed; LinkedIn blocked writes 93 → 91). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account with draft entities.
