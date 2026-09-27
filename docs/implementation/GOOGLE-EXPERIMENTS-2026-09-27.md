# Google Ads experiments and experiment arms (setup) — 2026-09-27

Base revision: `0679aef` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: experiments are how advertisers test a bid strategy or other campaign change against the
campaign itself before adopting it. Setting one up takes two mutate services, experiments and
experiment arms, whose eight rows (the v23 mutate actions and six legacy aliases) were blocked
writes. Scheduling, ending, promoting and graduating are a separate batch.

Contract source: the pinned Google Ads API v23 Discovery document (`ExperimentService.MutateExperiments`,
`ExperimentArmService.MutateExperimentArms`, `Experiment`, `ExperimentArm`, the operation types and
the `ExperimentError` and `ExperimentArmError` enums) and the
[System-managed experiments](https://developers.google.com/google-ads/api/docs/experiments/system-managed)
guide, read on 2026-09-27 (the guide shows v25; its v23 rules are those below). Key facts:

- An experiment is created in `SETUP` with a unique name, a type and a suffix "appended to the end of
  the names of the treatment campaigns"; `syncEnabled` exists for search and display experiments.
- "All arms must be created in a single request": "exactly one control arm and one or more treatment
  arms", the control arm naming "exactly one campaign", and "the sum of traffic splits across all
  arms must be 100". Treatment arms get in-design campaigns that are changed before scheduling.
- The error enums add: names unique among active experiments; status cannot be set to REMOVED or
  GRADUATED; arm campaigns and traffic splits cannot change after the start; the control campaign
  cannot use a shared or custom budget and must carry the EU political advertising declaration.

## Change

New reviewed family `google_experiments` (`src/google-experiments.ts`):

| Part | Behaviour |
|---|---|
| Request | Experiments: 1–10 operations; create `{name, type, suffix, status: SETUP}` with optional description, dates and sync; update of name, description, suffix or dates by `updateMask`; remove. Arms: all arms of one experiment created together (one control with one campaign, 1–9 treatments without campaigns, splits 1–99 summing to 100, distinct names), or updates of name and split and removals. Legacy aliases take only their own operation |
| Types | SEARCH_CUSTOM, DISPLAY_CUSTOM, YOUTUBE_CUSTOM and HOTEL_CUSTOM (system-managed) |
| State | The customer; every experiment not removed; the arms named and every arm of each experiment involved; the control campaign with its budget |
| Checks | Name clashes are `CONFIGURATION_EXISTS`; experiments and arms change only in SETUP; arms are created once per experiment; the control campaign is BASE, of the experiment's channel, not removed, with its own daily budget and the EU declaration; after updates or removals the arms stay valid or none remain; unchanged values are refused |
| Safety | Nothing serves in SETUP, so no spending confirmation; removals count as deletions |
| Receipt | Every result names an experiment or arm of the customer, the same one for updates and removals; otherwise a failure never resubmitted |
| Verification | Experiments and arms read again: every field written, removed ones absent |

Other code: `src/preflight.ts` (the spending keyword heuristic does not apply to this family),
`src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (Google contract
version 23). Guidance: "Experiments (setup)" in `Skills/amcp-campaign-builder/references/google-ads.md`
and an executable inspect example.

## Tests

`tests/google-experiments.test.mjs`, five tests:

1. An experiment is created in SETUP, edited (snake_case input) and removed, each verified; no spending confirmation; a replay sends nothing.
2. Three arms are created together and verified; splits are changed, a treatment removed while another takes its share, and the remaining arms removed, each verified.
3. Twenty malformed requests fail before any request (a foreign customer's experiment is refused by the legacy adapter).
4. A duplicate name, experiments past SETUP, a removed experiment, unchanged values, dates out of order, arms already present, five unsuitable control campaigns, an unknown campaign, broken split sums, a lone arm and unknown arms are refused without writes; a removed experiment's name can be reused.
5. A receipt naming another customer's experiment is a failure never resubmitted; an ignored update is not verified; the models match the pinned document; the ledger lists the eight writes in the family.

Red/green against a build of `0679aef`: all five tests fail (no reviewed family: the eight rows were blocked writes). Local log:
`.runtime/google-experiments-20260927/red-check.log`.

## Verification

- Targeted: 163 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,851/1,851.
- Guidance coverage: 285 write-path refusals across 161 modules accounted for.
- Full qualification: see
  [GOOGLE-EXPERIMENTS-VERIFICATION-2026-09-27.json](GOOGLE-EXPERIMENTS-VERIFICATION-2026-09-27.json).

Remaining rows: 831 (eight Google Ads rows reviewed; Google Ads blocked writes 87 → 79). Live
acceptance is unverified; it needs the updated deployment and a Google Ads customer with a campaign.
