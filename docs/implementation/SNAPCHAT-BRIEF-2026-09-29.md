---
status: record
tier: engineering
---

# Snapchat brief S1–S14 — 2026-09-29

Source: the owner's engineering brief after two live Snapchat tests (25 and 29 September 2026) that cloned a LEADS
campaign as a paused copy (1 campaign, 2 ad squads, 4 creatives, 4 ads). Test B completed 11 of 11 steps but took
49 calls, one cancellation and responses up to 132 KB. Everything below was built against synthetic fixtures
(`tests/snapchat-plan-fixture.ts`, shaped like the live account, billing fields included). No live provider call,
credential, permission, deployment or DNS change was made.

## Step zero: the deployed build

The error text the brief could not find ("Page through the collection if the ID is not on the first page",
`details.ownership_reads`, `details.next_call`) is from commit `67a4f01` (2026-09-28, batch 5), which is on
`Codex-branch` and was pushed before the 29 September test. The brief compared against an older local copy
(`03ac8d3`, also an ancestor of `Codex-branch`). The deployed build is therefore a push of this branch; there was
nothing to reconcile. Line numbers in the brief refer to `03ac8d3`.

## Items

| Item | Status | Commit | Tests | Evidence |
|---|---|---|---|---|
| S1 compact plan responses | fixed | `64bced8` | `tests/campaign-plan-views.test.ts` | 11-step plan: `execute_next` 21.6 → 89 KB before, 2.5–3.6 KB after; 50 steps: 410 KB before, at most 7.7 KB after; `prepare_next` at most 4.3 KB. Budget: 12 KB per response, enforced |
| S2 amending a blocked step | fixed | `102c6f4` | `tests/campaign-plan-amendment.test.ts` | Blocked in preflight, amended through `next_call` with the operator's pixel, completed, no cancel, nothing sent before preflight passed |
| S3 known creatives by ID | fixed (option c) | this record's commit | `tests/snapchat-reads.test.ts` | 4 of 312 creatives in one call, under 10 KB |
| S4 `get_*_by_ids` | refused locally (undocumented) | this record's commit | `tests/snapchat-reads.test.ts` | All ten names refused before any request, naming the `result_ids` read |
| S5 stuck in verifying | fixed | `f34da9c` | `tests/campaign-plan-mismatch.test.ts` | Stable normalisation → `mismatch` with diff; acceptance by hash, audited, nothing sent; changed hash refused; transient difference still verifies |
| S6 pixel and organization reads | fixed | this record's commit | `tests/snapchat-reads.test.ts` | Listed pixel readable (already true), organization pixels after the account read; others refused |
| S7 health per role | fixed | `f34da9c` | `tests/owner-health-access.test.ts` | Four roles × six actions; administrator view without private data |
| S8 `list_accounts` metadata | fixed | `f34da9c` | `tests/snapchat-workspace-views.test.ts` | Before and after a live check, stale after a week, one shape per platform |
| S9 billing in reviews | fixed | `f34da9c` | `tests/snapchat-workspace-views.test.ts` | No billing key in any review or plan response; currency and status changes still refuse execution |
| S10 contracts summary filter | fixed | `f34da9c` | `tests/snapchat-workspace-views.test.ts` | Filtered page summarises one gateway |
| S11 errors that name the field | fixed | `102c6f4` | `tests/campaign-plan-amendment.test.ts`, `tests/snapchat-refusals.test.ts` | `recover_step` checks eligibility first; `confirmed: true` named; `requirements.currency` explained |
| S12 restated execute values | fixed | `f34da9c` (identical values accepted since batch 5) | `tests/snapchat-workspace-views.test.ts` | Identical accepted; different refused by field with the accepted fields |
| S13 plan-level spending notice | fixed | `f34da9c` | `tests/snapchat-workspace-views.test.ts` | One non-blocking warning per plan, gone once a policy exists |
| S14 docs and descriptions | done | all of the above | every example is a call a test makes | `Skills/amcp-campaign-builder/references/tiktok-snapchat.md`, `workspace.md`, `docs/WRITE-OPERATIONS.md`, the `amcp_campaign` description |

Safety guarantees kept: reviewed writes (prepare, five-minute frozen review, execute with confirmation and key), no
resubmission of an uncertain mutation, read-back verification (acceptance of an observed state is an audited
operator decision that sends nothing and needs the exact hash), account-scoped ownership (no request names an
unverified ID), `spend_change_confirmed`, and the untrusted-content label on every response that carries provider
text.

## Follow-up: the copy itself

The tests built the paused copy by hand (read the campaign, its squads and ads, then write 11 steps). With the
Google list's item 10 it is one call: `amcp_campaign clone` with `source: {campaign_id}` and a new `name` reads the
campaign, its ad squads and their ads from the account's lists and returns a draft plan (`campaign`, `squad_N`,
`squad_N_ads`), the campaign PAUSED, squads and ads keeping their own status under it, and each ad reusing its
creative by ID; `approve` and `run` complete it. Snapchat
never returns `placement_v2`, so the clone lists it under `not_copied`; add it with `changes.set` if the copy should
not use Snapchat's default. See `GOOGLE-BRIEF-2026-09-29.md` and `tests/campaign-clone.test.ts`.

## Decisions taken conservatively (for the owner)

The owner answered these on 2026-09-29 with "do what you think is the best way forward": 1, 2, 3 and 4 are kept as
built; 5 is done where the provider contract proves nothing was applied (a refused all-or-nothing Google build, F-109)
and unchanged for Snapchat, whose documentation this environment could not reach. Lapsed ownership is now renewed
automatically (F-70), and paused parents cover Snapchat squads and ads (F-107).

1. **Health permissions (S7).** Implemented the brief's suggestion: an administrator who does not own the workspace
   sees connection status and job queues only; operators, readers and reviewer test accounts are refused. Decide
   whether anyone else should see health, or whether administrators should not.
2. **S3 option.** Option (c), a server-side filter over the documented account list. Option (a) needs the
   by-ID body; option (b) needs documentation that an ad can only reference a creative of its own account.
   Snapchat's documentation site was unreachable from the build environment (proxy 403), so neither was possible.
3. **S4 documentation status.** The by-ID reads are refused locally with the working alternative. The 2026-09-26
   Snapchat record (`SNAPCHAT-WORKFLOW-2026-09-26.md`) noted that the public creatives reference documents no
   batch read. If Snapchat documents the body,
   send the page (or pin it under `.mirror/VENDOR/`) and the refusal gives way to a schema and a parser.
4. **S5 acceptance design.** A mismatch needs the same differing state in two verification rounds (one round of
   three reads spans under a second, too short to rule out propagation). Acceptance requires the user's
   `accept_observed: true` and the exact `actual_hash`, re-reads once, is audited, and marks the step
   `verified_with_acceptance`; workspace capability evidence still counts only `verified`. Confirm this design.
5. **A definitive provider refusal after submission** (for example HTTP 400 at execute) is still recorded as
   uncertain, so `recover_step` refuses it and the plan can only be cancelled. Treating documented validation
   refusals as "not applied" would loosen a safety rule and is the owner's decision.

## Retest plan (only when the owner asks)

Run the brief's section 7 scenario on a new paused copy named "AMCP retest <date> |":

1. Create the 11-step plan with the foreign pixel on both ad squads. Expect preflight to block both with
   `SNAPCHAT_PIXEL_NOT_OWNED`, a `next_call` with `choose.allowed_values`; follow it with an owned pixel (one
   `recover_step` per squad), with no cancel.
2. Read the 4 source creatives with `snapchat_creative_list` and `result_ids` (one call).
3. Call `amcp_workspace health` as the connected user; expect the view for that user's role.
4. Call `amcp_workspace check` with `live: true`, then `list_accounts`; expect the account's name, currency and
   timezone.
5. Run the plan; watch every response size (expected at most 12 KB).

Pass criteria from the brief: 0 cancellations, no response over 12 KB, 11 of 11 steps verified, about 30 calls or
fewer, everything paused and no spend. Report the created IDs; delete nothing without the owner's confirmation.
