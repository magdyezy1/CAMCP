---
status: record
tier: engineering
---

# Source-bound native budget drafts — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `db9e037`. Implementation: `38a469e`. Batch 60 advances B26 from an illustrative allocation to a separately reviewed native draft.

## Delivered behavior

An allocation from a guided Google campaign/day report can now become a durable, unapproved campaign plan. The
operator explicitly chooses equal-daily conversion, reads current campaign/budget ownership, inspects exact daily
currency amounts and micros plus rounding residuals, and confirms draft creation. Period totals are divided by the
number of closed reference days and rounded down to whole micros. An unrepresentable positive amount, unchanged
budget or rounding that violates a modeled floor is refused. A native average daily budget remains in effect until
separately changed; this flow adds no campaign end date or automatic period spending cap.

The read selects exact campaign IDs in the original account/login and requires complete unique results. Each
campaign must have an enabled, dedicated DAILY budget with one reference, the same account/currency/timezone and
an enabled or paused campaign. Shared, lifetime, removed, foreign, missing, duplicate and ambiguous results fail.
The read uses existing independently qualified Google search and bounded reporting transport. Source age,
completeness, sample size and model constraints are rechecked. No new native write family is registered.

A preview lasts ten minutes and binds its source revision/hash, exact options, native state, conversion and current
creator/session. At most 100 current previews are retained. Confirmed creation rechecks budgets and source and
uses a fenced local lock. Campaign creation now accepts optional stable keys; identical input returns the original
plan, while a changed creation body conflicts. The source binding is stored in the same write as the draft, so a
lost response cannot leave an unbound plan or cause a duplicate on retry. No approval is saved by this flow.

Before an unsent proposal-derived step is prepared or executed through Campaigns, the original source, step body
and current budget ownership/state must still match. Concurrent cancellation or revision changes stop the step.
The native write engine retains its own current before-state review, spending controls, confirmation, original
mutation identity and read-back. Already executing/uncertain work retains its original receipt recovery rather
than being resubmitted or blocked by a changed post-write budget. The draft targets named budget resources; it is
not an atomic transaction across all campaigns or an automatic rollback. Provider changes between separate reads
and writes remain subject to the existing native consistency limits.

## Website and MCP

The allocation result offers a conversion selector with no preselected choice. Its preview table shows account,
currency, timezone, campaign and budget IDs, current daily amount, modeled period total, proposed daily amount,
exact micros and residual. Creating a draft has a separate confirmation that states its ongoing-budget meaning.
The result links to the original Campaigns plan; its journal links back to the original report. Edits, conversion
changes, navigation and identity changes invalidate old previews and confirmations. Names and IDs are escaped.

`amcp_reporting preview_allocation_plan` takes report `id`, the original allocation `options`, and explicit
`conversion:"equal_daily"`. `create_allocation_plan` takes that report `id`, `preview_id`, `preview_hash` and
`confirmed:true`. Its typed result links to `/campaigns?id=...` and returns a read-only `amcp_campaign get`
handoff with `approval_required:true`. Creation is not `approve`, `prepare_next`, `execute_next` or `run`.
Native reporting reads still use the independent read classifier; the new local draft callback is separate.

`amcp_campaign create` accepts an optional `idempotency_key` of 8–100 letters, digits, hyphens or underscores.
Keys bind the creator, original name/brief, profile revision, variables and complete native step structure. A key
does not grant access, bypass approval or rewrite an amended existing plan.

## Verification and remaining scope

Ten backend regressions cover units/residuals/floors, native ownership, creator/session and source binding,
confirmation/expiry, revocation, creation races, cancellation, atomic source binding, lost-response recovery,
creation-key conflicts and separate native preparation/execution. A fake provider accepts and verifies both
separately approved budget updates, while repeated completion sends neither again. Three controller regressions cover explicit conversion,
exact amounts, escaping, confirmation cancellation, conversion changes and late response suppression. A three-call
MCP SDK journey checks advertised schemas, matching text/structured envelopes and the correct original-plan
handoff with two synthetic provider reads and zero advertising writes. The initial focused group passed 38/38
tests; the added full native-engine journey also passed.
The new API, baseline browser controls and stale-conversion confirmation case were observed red before fixes.

Full-suite and release evidence are in [PROGRESS.md](PROGRESS.md). Logs remain in ignored
`.runtime/allocation-plan-20261001/`. Visual acceptance is still unavailable because the browser control runtime
cannot initialize. These fixtures do not certify live account eligibility, deployed behavior or external MCP clients.

The matrix remains **12 implemented / 14 partial / 2 open**. B26 now has a Google budget-plan handoff; calibrated
forecasts and qualified budget-plan bindings for other providers remain work. The model remains illustrative,
without delivery guarantees or automatic optimization. No OAuth scope, dependency, migration, production change,
real credential or live advertising action was used.

Google field semantics were checked against its current [v25 campaign-budget field reference](https://developers.google.com/google-ads/api/fields/v25/campaign_budget)
and [budget creation guide](https://developers.google.com/google-ads/api/docs/campaigns/budgets/create-budgets).
The existing pinned v25 Discovery request contract still validates the native budget update and micros type.
