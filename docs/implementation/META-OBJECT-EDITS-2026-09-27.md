# Meta creative and custom audience renames and deletions — 2026-09-27

Base revision: `bf6e4a1` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: keeping the creative library and the audience list tidy means renaming and deleting creatives
and custom audiences. Seven rows (the creative update and delete actions and the custom audience
update and delete actions with their aliases) were blocked writes.

Contract source: the Marketing API v25.0 "Ad Creative" and "Custom Audience" references (Updating and
Deleting sections), read on 2026-09-27. Key facts:

- A creative is updated with `POST /{ad_creative_id}` (name up to 100 characters, status, labels) and
  deleted with `DELETE /{ad_creative_id}`; both answer `{success}`; its status can be DELETED.
- A custom audience is updated with `POST /{custom_audience_id}` (name, description and rule,
  retention and opt-out fields) and deleted with `DELETE`; "When you delete a custom audience, it will
  be permanently removed from your account and your ads using it will stop running", and error 2656
  refuses deletion while lookalikes exist.

## Change

New reviewed family `meta_object_edits` (`src/meta-object-edits.ts`):

| Part | Behaviour |
|---|---|
| Request | Creative rename (`name`), audience rename (`name` and/or `description`), and deletion of either; no other fields |
| Scope | The object must have been listed from the selected account (owned creatives and audiences only, never shared audiences) |
| State | The object read by ID with its account; deleted objects and unchanged renames are refused |
| Safety | Deletions count as deletions under owner policies; the review says ads stop running when an audience goes |
| Receipt | `{success: true}`; anything else, including Meta's refusal, is a failure never resubmitted |
| Verification | The object read again: the new name, or gone ("does not exist", code 100 subcode 33) or DELETED |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Meta contract version 13). Guidance: "Renaming and deleting
creatives and custom audiences" in `Skills/amcp-campaign-builder/references/meta.md` and an
executable inspect example.

## Tests

`tests/meta-object-edits.test.mjs`, four tests:

1. A creative and an audience (by alias) are renamed and verify; a replay sends nothing.
2. A creative deletion verifies DELETED and an audience deletion verifies gone; the audience review names its effect; an owner deletion rule refuses deletions but not renames.
3. Five malformed requests fail before any request; an undiscovered creative, a shared audience, a deleted creative and an unchanged name are refused without writes.
4. Meta's refusal (lookalikes exist) and a reply without success are never resubmitted; an ignored rename is not verified; the ledger lists the seven writes.

Red/green against a build of `bf6e4a1`: all four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/meta-object-edits-20260927/red-check.log`.

## Verification

- Targeted: 172 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,885/1,885.
- Guidance coverage: 299 write-path refusals across 169 modules accounted for.
- Full qualification: see
  [META-OBJECT-EDITS-VERIFICATION-2026-09-27.json](META-OBJECT-EDITS-VERIFICATION-2026-09-27.json).

Remaining rows: 800 (seven Meta rows reviewed; Meta blocked writes 126 → 119). Live acceptance is
unverified; it needs the updated deployment and a Meta ad account.
