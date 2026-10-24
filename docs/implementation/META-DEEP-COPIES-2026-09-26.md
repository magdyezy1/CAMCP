---
status: record
tier: engineering
---

# Meta deep campaign copies — 2026-09-26

Base revision: `e227872` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the "Meta deep campaign copies" follow-up in the
[2026-09-26 handoff](RESUME-HANDOFF-2026-09-26.md), recorded when the
[Meta native copies batch](META-COPIES-2026-09-26.md) qualified only shallow campaign
copies. Meta's
[Ad Campaign Group /copies](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/)
reference documents `deep_copy`, with at most three children for a synchronous call, and
`start_time`/`end_time` for the copied campaign's ad sets.

## Change

`meta_campaign_id_copies_copy` now accepts `deep_copy: true` (`src/meta-copies.ts`).

| Stage | Behaviour |
|---|---|
| Validation | `start_time`/`end_time` are accepted for campaigns only with `deep_copy: true` (UTC UNIX seconds; end after start or 0); otherwise `INVALID_META_COPY` |
| Reads | The source campaign, then one complete page each of its ad sets (`id,campaign_id,daily_budget,lifetime_budget`) and ads (`id,adset_id,campaign_id`). A paginated list stops the review (`INCOMPLETE_STATE`). Ad set deep copies read `id,adset_id,campaign_id` |
| Checks at review and execution | Every listed ad set belongs to the source campaign. Every listed ad belongs to it and to a listed ad set (`STATE_TARGET_MISMATCH`). Ad sets plus ads must number at most three (`META_COPY_TOO_LARGE`, with the count) |
| Spending | The campaign's budgets and each child ad set's budgets (for example `/copied_adset/{id}/daily_budget`) count as new budgets under the owner policy |
| Impact | `creative_impact` counts every expected copy and lists every copied budget |
| Verification | The copied campaign; each copied ad set under the copied campaign; each copied ad under the copy of its own source ad set, mapped through `ad_object_ids`. All must be `PAUSED` in the selected account. A receipt missing any source child is `META_COPY_INCOMPLETE` |

Not qualified: asynchronous (batch) deep copies above three children, `parameter_overrides`
and `create_dco_adset`. A larger campaign is still cloned step by step.

Other code: `src/provider-contracts.ts` (Meta contract version 10). Guidance: "Native
copies" in `Skills/amcp-campaign-builder/references/meta.md`.

## Tests

`tests/meta-copies.test.mjs` now has twelve tests (three new):

- A deep campaign copy with one ad set and two ads reads source, ad sets and ads, reports
  four copies and both budgets, and verifies four checks. Each ad lands under the copy of
  its own ad set.
- A campaign with four children is `META_COPY_TOO_LARGE`. A campaign whose child ad set
  budget (6000) exceeds a 4000 cap is `POLICY_BUDGET_LIMIT` on
  `/copied_adset/202/daily_budget`. The same campaign copied shallow duplicates no budget.
- A receipt missing one child is `unverified` (`META_COPY_INCOMPLETE`).

The validation test now refuses `end_time` on a shallow campaign copy instead of refusing
`deep_copy`, and the fixture serves both children lists with the requested fields.

Red/green: against a build of `e227872`, the three new deep campaign tests fail. The base
refuses `deep_copy` on campaigns and `start_time` on campaign copies (`INVALID_META_COPY`).
The three existing ad set deep-copy tests also fail there, because the fixture now requires
the new children field list (`id,adset_id,campaign_id`) and the base still reads
`id,adset_id`. That assertion throws inside the synthetic transport (`UPSTREAM_UNAVAILABLE`),
which pins the new read shape; the other six tests pass on the base. All twelve pass with
this change. Local log: `.runtime/meta-deep-copies-20260926/red-check.log`.

## Verification

- Targeted: 1107/1107 across 81 related suites.
- Guidance coverage: unchanged at 236 write-path refusals; no new refusal code was needed.
- Full qualification: see
  [META-DEEP-COPIES-VERIFICATION-2026-09-26.json](META-DEEP-COPIES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified; it needs the updated deployment and an owned campaign with at
most three children, which this batch does not authorize.
