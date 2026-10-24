---
status: record
tier: engineering
---

# Meta native copies — 2026-09-26

Base revision: `a99dfdd` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). The session began with a
campaign clone; Meta's `/copies` edges clone campaigns, ad sets and ads natively, and all
three were blocked writes.

Contract source: Meta Marketing API reference, checked 2026-09-26:

- [Ad Campaign Group /copies](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/copies/): `deep_copy`, `start_time`/`end_time`, `status_option` (`ACTIVE`/`PAUSED`/`INHERITED_FROM_SOURCE`, default `PAUSED`), `parameter_overrides`, `rename_options`; returns `copied_campaign_id` and `ad_object_ids`; synchronous deep copies take at most 3 children.
- [Ad Campaign /copies](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/copies/) (ad sets): the same, plus the target `campaign_id` and `create_dco_adset`; returns `copied_adset_id`; at most 3 child ads synchronously.
- [Adgroup /copies](https://developers.facebook.com/docs/marketing-api/reference/adgroup/copies/) (ads): target `adset_id`, `creative_parameters`, `rename_options`, `status_option`; returns `copied_ad_id`.

## Contract

`meta_campaign_id_copies_copy`, `meta_ad_set_id_copies_copy` and `meta_ad_id_copies_copy`
form the new reviewed family `meta_copies` (`src/meta-copies.ts`). The three share one path
shape, so the action name decides the copied type.

| Stage | Behaviour |
|---|---|
| Validation | Before any read, `INVALID_META_COPY` unless the copy is explicitly `status_option: "PAUSED"`. Campaign copies are shallow only. Refused: `parameter_overrides`, `creative_parameters`, `create_dco_adset` and other undocumented keys. Also checked: `rename_options` enum/length, numeric target IDs, and ad set times as UNIX seconds with the end after the start (or 0) |
| Reads | The source with fields only its type has (`objective` / `optimization_goal` / `adset_id`), so a mistyped ID fails at Meta; the target parent; and, for a deep ad set copy, one complete page of the source's ads. All IDs must already be owned |
| Checks at review and execution | Source and target must be in the selected account (`STATE_TARGET_MISMATCH`). A deep ad set copy with more than three ads is `META_COPY_TOO_LARGE`, with the count |
| Spending | The source's `daily_budget`/`lifetime_budget` are passed to the owner spending policy as newly created budgets, so `POLICY_BUDGET_LIMIT` and the other caps apply. A source budget change between review and execution is `STATE_CHANGED` |
| Impact | `creative_impact` names the source, target parent, expected number of copies and copied budgets; `may_activate: false` |
| Receipt | `copied_<type>_id` numeric; every `ad_object_ids` entry has a type and numeric source and copy IDs. Copied campaigns, ad sets and ads become owned by the connection |
| Verification | Every copied campaign, ad set and ad is read and must be `PAUSED`, in the selected account and under the expected parent (target, or the source's own). A deep copy missing any source ad in `ad_object_ids` is `META_COPY_INCOMPLETE` |

Not qualified: deep campaign copies, asynchronous (batch) copies, `parameter_overrides`,
`creative_parameters` and `create_dco_adset`. A larger structure is cloned step by step:
the campaign, then each ad set (with up to three ads) into it, then any remaining ads.

Other code: `src/reviewed-routes.ts`, `src/write-review.ts`, `src/write-impact.ts`,
`src/spend-policy.ts`, `src/scope.ts`, `src/write-verification.ts`,
`src/provider-contracts.ts` (Meta contract version 8, reviewed 2026-09-26),
`src/action-contracts.ts`. Guidance: "Native copies" in
`Skills/amcp-campaign-builder/references/meta.md` and an executable ad set copy inspect
example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (968 rows).

## Tests

`tests/meta-copies.test.mjs`, nine tests:

1. The three actions inspect as reviewed with no network.
2. 17 invalid requests are refused before any request.
3. A campaign copy is unowned until owned; it reads only the source, reports the copied budget, POSTs once and verifies paused; replay makes no second POST.
4. A workspace `max_budget_native` below the source budget refuses the copy.
5. A deep ad set copy reads the source, target campaign and source ads, lands in the target, and verifies all three copies.
6. Four ads exceed the limit; a source ad that is not yet owned is refused; a target in another account, and a campaign action given an ad set ID (Meta rejects `objective`), fail before any write.
7. A receipt missing a copied ad is `unverified` (`META_COPY_INCOMPLETE`); a copy that reads back active is `inconclusive`.
8. A Meta-declared error (`UPSTREAM_ERROR`, then `WRITE_OUTCOME_UNCERTAIN`), an empty receipt (`WRITE_PARTIAL_OR_FAILED`) and a lost response (`WRITE_OUTCOME_UNCERTAIN`) each POST only once.
9. Concurrent execution submits once; a fresh service replays and verifies.

Red/green: all nine fail against a build of `a99dfdd` (`WRITE_CONTRACT_UNAVAILABLE`) and
pass with this change. Local log: `.runtime/meta-copies-20260926/red-check.log`.

## Verification

- Targeted: 624/624 across 57 related suites, including every Meta, spending-policy and
  concurrency suite.
- Guidance coverage: 233 write-path refusals across 109 modules accounted for, including
  the three new ones.
- Full qualification: see
  [META-COPIES-VERIFICATION-2026-09-26.json](META-COPIES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. It needs the updated deployment and owned test objects,
which this batch does not authorize. Whether Meta copies creatives in `ad_object_ids`
(`unique_adcreative`) for a given source is not relied on; those entries are ignored.
