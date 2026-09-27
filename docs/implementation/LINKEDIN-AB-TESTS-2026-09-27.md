# LinkedIn A/B tests — 2026-09-27

Base revision: `4298a36` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: comparing two LinkedIn campaigns with a controlled traffic split needs an A/B test
(`adExperiments`). Creating, updating and deleting them were blocked writes (five rows with the
alternate path parameter names).

Contract source: the LinkedIn Marketing API "A/B Testing Management API", li-lms-2025-10 to
li-lms-2026-09, read on 2026-09-27. Key facts:

- An experiment "must contain 2 cells" with campaigns "from the same campaign group", traffic weights
  of 1–99 summing to 100, a confidence of 51–99, a key metric (CPC, CPM, CPV, CPMS) and a schedule of
  at most 90 days ending no more than 180 days ahead; `account` is create-only.
- Updates are PARTIAL_UPDATEs that set whole top-level fields; "After the experiment starts, only" the
  name, description, scheduled end, auto stop, confidence, intended state and cell names and
  descriptions change; ended experiments are immutable.
- "To delete an experiment, its `executionState` must be PENDING."

## Change

New reviewed family `linkedin_ab_tests` (`src/linkedin-ab-tests.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation for the selected account (DRAFT or ACTIVE), PARTIAL_UPDATE of whole top-level fields, deletion; versioned REST.li 2.0 headers; no query |
| State | The ad account, the experiment and the campaigns of the cells |
| Checks | The experiment belongs to the account; two campaigns of one campaign group that are active, paused or draft; fields allowed by the execution state; deletion only while PENDING; unchanged values refused |
| Safety | An ACTIVE experiment needs spending confirmation and counts as activation under owner policies; LinkedIn's refusals (overlapping experiments, brand lift tests) are failures never resubmitted |
| Receipt | 201 with an ID for a creation, 204 for an update or deletion |
| Verification | The experiment read again with the fields sent, or gone after a deletion |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/spend-policy.ts`, `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (LinkedIn contract version 12). Guidance:
"Reviewed LinkedIn A/B tests" in `Skills/amcp-campaign-builder/references/linkedin-x.md` and an
executable inspect example.

## Tests

`tests/linkedin-ab-tests.test.mjs`, four tests:

1. A draft experiment is created without confirmation and verifies, and a replay sends nothing; running it needs spending confirmation and verifies; a pending experiment is deleted by the alias and verifies gone; an owner rule against activation refuses an active creation but not a draft.
2. A running experiment changes its name, end and cell names (alias route) and verifies; its key metric and weights do not change; an ended experiment is immutable.
3. Eleven malformed requests fail before any request.
4. Campaigns of different groups, a canceled or foreign campaign, a foreign, unknown or running experiment for deletion and unchanged values are refused after reading, without writes; an ignored change is not verified; the ledger lists the five writes in the family.

Red/green against a build of `4298a36`: three of the four tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE); the malformed-request test passes because the base refuses the route before any request. Local log:
`.runtime/linkedin-ab-tests-20260927/red-check.log`.

## Verification

- Targeted: 187 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,945/1,945.
- Guidance coverage: 316 write-path refusals across 184 modules accounted for.
- Full qualification: see
  [LINKEDIN-AB-TESTS-VERIFICATION-2026-09-27.json](LINKEDIN-AB-TESTS-VERIFICATION-2026-09-27.json).

Remaining rows: 764 (five LinkedIn rows reviewed; LinkedIn blocked writes 103 → 98). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account with two campaigns in one
group.
