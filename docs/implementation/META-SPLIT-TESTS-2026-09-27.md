# Meta split tests — 2026-09-27

Base revision: `b271e1f` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: split tests (A/B tests of ad sets or campaigns) could not be set up through AMCP:
`POST /{business_id}/ad_studies` and `POST /{ad_study_id}` were blocked writes.

Contract source: Marketing API v25.0 "Ad Study" reference (updated 2026-03-24) and "Split Testing"
guide (updated 2026-08-14), read on 2026-09-28. A SPLIT_TEST study has a name, a description,
`start_time` and `end_time` (Unix seconds) and cells of `{name, treatment_percentage, adsets |
campaigns}`: "treatment_percentage for each cell should be at least 10", "The sum of
treatment_percentage for all study cells should be less or equal to 100", "Each cell must have at
least one object associated with it"; an advertiser runs at most 100 concurrent studies, a study at
most 150 cells of at most 100 objects. Updates change fields of a study: "Once the study runs, you
cannot update start_time, treatment_percentage for cells ... However, you can update end_time to the
future time if the study is not yet ended." A study reads with its business, times and cells
(`/{ad_study_id}/cells` with their ad sets and campaigns).

## Change

New reviewed family `meta_split_tests` (`src/meta-split-tests.ts`):

| Part | Behaviour |
|---|---|
| Create request | `params.business_id`; `type: SPLIT_TEST`, a name of 1–255 characters, an optional description, `start_time` before `end_time`, and 2–10 cells at one level (ad sets or campaigns), each named, at least 10 percent (100 in total at most) and naming 1–10 IDs (20 in the study), every ID in one cell; nothing else |
| Update request | `params.ad_study_id`; `name`, `description` and/or `end_time` only |
| State | The ad account's business; for a new study, each ad set or campaign by ID (account, name, configured status) with the studies it is in; for an update, the study and its cells |
| Checks | The business owns the selected account (`RESOURCE_SCOPE_REQUIRED`); every object belongs to the account, is not ARCHIVED or DELETED and is not in a running split test; an updated study is a split test of that business, not canceled, and a new end is in the future, after the start and not on an ended study; unchanged updates are refused |
| Scope | `src/scope.ts` accepts the validated writes and the marked account and study reads; ad sets and campaigns are read by ID under the usual ownership rule, so list them first |
| Safety | A study divides the audience of its objects, so creating one or moving its end needs `spend_change_confirmed=true` |
| Receipt | The new study `id` (or `success: true` for an update); anything else is a failure never resubmitted |
| Verification | The study and its cells read again: name, type, times, business, percentages and objects |

Lift studies need Meta, and creative tests (`SPLIT_TEST_V2` with a test budget) stay out: the
reference allows 2–5 cells, the guide 2–7. The cell and object bounds are AMCP's: the review reads
every object twice. New refusal code: `INVALID_META_SPLIT_TEST`.

Other code: `src/write-review.ts` and `src/write-verification.ts` (with the connection scope check),
`src/write-impact.ts`, `src/preflight.ts` (spending confirmation), `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/scope.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts`
(Meta contract version 17). Guidance: a split test section in
`Skills/amcp-campaign-builder/references/meta.md` and an executable inspect example.

## Tests

`tests/meta-split-tests.test.mjs`, three tests:

1. An ad set split test is refused without spending confirmation, then created and verified; a replay sends nothing; a campaign split test verifies; the study is renamed and extended with confirmation and re-described without it, each verified.
2. Sixteen malformed studies (a lift study, a creative test, a test budget, viewers, one cell, eleven cells, a 5% cell, 110%, mixed levels, both levels in a cell, an empty cell, an ad set in two cells, repeated cell names, a whole ad account, an end before the start, a padded name) and three malformed updates are refused before any request; another business, a busy, an archived and an unlisted ad set, a study of another business, an ended study, an unchanged name and a missing study are refused after reading; a connection without `ads_management` is refused.
3. An error reply is never resubmitted; an ignored creation and an ignored update are not verified; the ledger lists both rows in the family.

Red/green against a build of `b271e1f`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/meta-split-tests-20260927/red-check.log`.

## Verification

- Targeted: 213 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 2,067/2,067.
- Guidance coverage: 345 write-path refusals across 207 modules accounted for.
- Full qualification: see
  [META-SPLIT-TESTS-VERIFICATION-2026-09-27.json](META-SPLIT-TESTS-VERIFICATION-2026-09-27.json).

Remaining rows: 702 (two Meta rows reviewed; Meta blocked writes 114 → 112). Live acceptance is
unverified; it needs the updated deployment and a Meta business with an ad account whose ad sets can
be tested.
