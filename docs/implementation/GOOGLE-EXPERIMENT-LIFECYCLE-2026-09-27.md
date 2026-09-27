# Google Ads experiment scheduling, ending, promotion and graduation — 2026-09-27

Base revision: `1970383` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: the previous batch sets experiments up; this one runs and finishes them. The four
`ExperimentService` actions and their legacy aliases were eight blocked rows.

Contract source: the pinned Google Ads API v23 Discovery document (`ScheduleExperiment`,
`EndExperiment`, `PromoteExperiment`, `GraduateExperiment`, `GraduateExperimentRequest`,
`CampaignBudgetMapping`, `Experiment.status` and `Experiment.promote_status` with their enum
descriptions) and the
[System-managed experiments](https://developers.google.com/google-ads/api/docs/experiments/system-managed)
and [asynchronous errors](https://developers.google.com/google-ads/api/docs/experiments/async-errors)
guides, read on 2026-09-27. Key facts:

- Scheduling converts the in-design campaign into an experiment campaign "that will begin serving ads
  if successfully created"; it returns a long-running operation. `INITIATED` means "campaigns pending
  materialization".
- Ending "immediately ends an experiment ... End date is updated to be the time of the request."
- Promotion applies "changes in the trial campaign to the base campaign", a long-running operation;
  `promote_status` moves through IN_PROGRESS to COMPLETED, COMPLETED_WITH_WARNING or FAILED.
- Graduation turns the experiment campaign into a full campaign; each mapped campaign "will be
  assigned a new budget", and the mapping list holds one entry.
- Long-running failures are listed by `ListExperimentAsyncErrors`.

## Change

The `google_experiments` family (`src/google-experiments.ts`) gains four actions:

| Action | Precondition | Safety | Verification |
|---|---|---|---|
| Schedule | SETUP, one control and at least one treatment arm with an in-design campaign, splits summing to 100 | `spend_change_confirmed`; activation under owner policies | Experiment ENABLED (not while INITIATED) |
| End | ENABLED and not yet ended (end date after today in the customer time zone) | None: it stops experiment campaigns | End date today or earlier |
| Promote | ENABLED or HALTED, not being or already promoted | `spend_change_confirmed`; activation | `promote_status` COMPLETED or COMPLETED_WITH_WARNING |
| Graduate | ENABLED or HALTED, not promoted; one mapping from a treatment arm's campaign to an enabled daily budget that is neither shared nor used | `spend_change_confirmed`; activation | Experiment GRADUATED and the budget on the campaign |

The reader now also reads the customer time zone, each experiment's `promote_status` and, for
graduation, the mapped campaign's budget and the new budget. Receipts: a long-running operation name
without an error for scheduling and promotion, an empty body for ending and graduation; anything else
is a failure never resubmitted.

Other code: `src/preflight.ts` and `src/spend-policy.ts` (confirmation and activation),
`src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract version 24). Guidance:
the "Experiments" section of `Skills/amcp-campaign-builder/references/google-ads.md`.

## Tests

`tests/google-experiment-lifecycle.test.mjs`, six tests:

1. Scheduling needs confirmation and verifies once ENABLED, not while INITIATED; an owner activation rule refuses it but not ending; a replay sends nothing.
2. Ending moves the end date to today in the customer time zone and verifies without confirmation; an ignored end is not verified.
3. Promotion needs confirmation and verifies on COMPLETED, not while IN_PROGRESS or after FAILED.
4. Graduation needs confirmation, puts the new budget on the experiment campaign and verifies; the legacy alias prepares too.
5. Six malformed requests fail before any request (two by the Discovery contract and the compiler first).
6. Eleven out-of-order or unsuitable actions (scheduling outside SETUP or without arms, ending a scheduled-but-ended or SETUP experiment, promoting twice, graduating a control campaign or with a used, shared or unknown budget, an unknown experiment) are refused without writes; the ledger lists the eight writes in the family.

Red/green against a build of `1970383`: all six tests fail (no reviewed family: the eight lifecycle rows were blocked writes). Local log:
`.runtime/google-experiment-lifecycle-20260927/red-check.log`.

## Verification

- Targeted: 164 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,857/1,857.
- Guidance coverage: 285 write-path refusals across 161 modules accounted for.
- Full qualification: see
  [GOOGLE-EXPERIMENT-LIFECYCLE-VERIFICATION-2026-09-27.json](GOOGLE-EXPERIMENT-LIFECYCLE-VERIFICATION-2026-09-27.json).

Remaining rows: 823 (eight Google Ads rows reviewed; Google Ads blocked writes 79 → 71). Live
acceptance is unverified; it needs the updated deployment and a Google Ads experiment.
