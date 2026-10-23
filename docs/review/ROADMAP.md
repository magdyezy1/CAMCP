# Roadmap

## Current implementation — 1 October 2026

The owner authorized work after receiving the full review. Since 2026-10-10 each B01–B28 package reports source,
native/live and manual/deployed acceptance separately in [package status](PACKAGE-STATUS.md) (owner decision D25); the
[implementation and qualification matrix](IMPLEMENTATION-2026-10-01.md) keeps the historical narrative of delivered
scope, partial scope and open expansions. See [Product workflows](../PRODUCT-WORKFLOWS.md) for the website and MCP
behavior. B17 objective launch packs and B24 Arabic localization are partially delivered; B25 conditional provider
programs is partial (its three program workflows exist, and LinkedIn's private programs and a DV360 advertiser stay
blocked outside AMCP). No production or live-provider action is included.

## Original review-first sequence — 1 October 2026

The owner requested a comprehensive review before implementation, on `magdyezy1/CAMCP`, branch `Work-here` only.
The [new review](../archive/REVIEW-2026-10-01.md) evaluates the existing system, separates reproduced defects from hypotheses
and opportunities, and gives acceptance criteria. The [full product blueprint](PRODUCT-BLUEPRINT-2026-10-01.md)
adds 28 consolidated work packages, dependencies and acceptance criteria for workflows, provider contracts, website
design and new capabilities. Its three detailed specifications include ten journeys and 21 page/view layouts.
The table below preserves the original proposed sequence. Use the current matrix above for implementation status.

| Order | Priority | Proposed batch | Findings / outcome |
|---:|---|---|---|
| 1 | P0 | Privacy and dispatch authority | F-118–F-121: safe errors/audit; pause and personal-data revocation stop unsent writes, including upload chunks |
| 2 | P0/P1 | Browser identity and navigation lifetime | F-122, F-123, F-131: no old identity/route content; deliberate draft handling |
| 3 | P0/P1 | Reporting arithmetic and missing-data behavior | F-124, F-125, F-127: null/empty semantics, X period reconciliation and reliable pagination |
| 4 | P1 | Media and report/export recovery | F-126; validate job retry, stream recovery, cumulative requests and resumed lineage |
| 5 | P1/P2 | Dependencies and current documentation | F-129, F-130: narrowly patched dependencies and evidence-backed current records |
| 6 | P1/P2/P3 | Readable review, recovery and operations | F-128, F-132–F-135; exact cap requirements, before/after money/delivery summary, keyboard focus and useful sanitized diagnostics |
| 7 | P2 | Repeatable qualification | Browser journeys, race/property tests, FFmpeg/container checks and owner-run provider acceptance kit |
| 8 | P2/P3 | Measured simplification | Extract large-module seams, aggregate request budgets, selective asset loading with evidence |
| 9 | P1–P3 | Full product and capability development | Blueprint B05–B28: existing-engine workflow completion, recipes, measurement, commerce, monitors, creative lineage, reporting depth, localization and qualified provider expansion |

No safety loosening is proposed. The previously declined out-of-band spending approval remains declined. Live
provider acceptance, new scopes, deployment and outbound notification destinations remain separate decisions.

## Historical roadmap

Ordered by the brief's priorities. Each milestone lands as focused commits, each qualified in a fresh release
candidate (`npm run check` + `node deploy/check-railway.mjs`). IDs refer to [FINDINGS.md](FINDINGS.md). Items marked
**owner** wait for a decision; the recommendation is given so the decision can be a yes or no.

## P0 — security, money and data correctness

| Item | Findings | State |
|---|---|---|
| Structural spend confirmation, numeric statuses, Reddit budgets in the owner policy | F-01, F-02, F-03 | done (batch 1) |
| Predictable confirmation model: `execute_requirements`, no pre-filled spend flag, `native_request` refused in writes | F-05, F-06, F-07, F-34 | done (batch 1) |
| Sign-in and OAuth limits keyed on the client, per-person two-step limit, sign-in time kept across workspace switches, client pruning, transport headers | F-08, F-09, F-10, F-11, F-17 | done (batch 1) |
| Unit-aware workspace spending defaults | F-04 | done (batch 11: caps per platform under `per_gateway`, in account currency where the unit is documented; a single native default warns) |
| Out-of-band approval for spend and activation | F-05 follow-up | declined by the owner (2026-09-28): the confirmation flags at execute stay the control |

## P1 — correctness and reliability of reviewed writes and reporting

- Campaign plans: `account_id` only where the schema declares it (F-26); `REVIEW_EXPIRED` with a ready re-prepare call
  and automatic re-prepare in plans (F-27); code-specific remedies with `next_call` (F-28); idempotency key defaults
  to the review id with one error code (F-33).
- Data: audit minimisation, retention and purge on disconnect; encrypted-only backups (F-18). GCM tag length and key
  ids (F-19). Dot-segment rejection in `buildUrl` (F-20). Drive inspection limits (F-21). Provider-text labelling
  (F-22).
- Auth follow-ups: **done in batch 6:** challenge caps per kind (F-12), e-mail flows that do not wait on delivery
  (F-13), reviewer sessions (F-14), code-replay revocation and grant pruning (F-25). **Done since:** idle timeout and
  change alerts (F-25, batch 11), the administrator and reviewer passwords (F-16, batch 18).
- Contracts: one LinkedIn version constant (F-53), Snapchat `lifetime_budget_micro` unit mapping (F-55, done in batch 33), Reddit lead
  forms in `CONTRACTS.md` (F-54), runtime write pause (F-24), remove dead `maxBudgetChange` (F-23), report output
  files (F-69).

## P2 — refactors that unblock everything else

1. **Typed family registry** (`src/reviewed-families.ts`): one `ReviewedFamily` descriptor per module (kind,
   assert, snapshots, reader, state validation, prerequisites, impact, outcome, verification, observed, authorize,
   policy amounts, spend declaration). The core iterates the registry. Equivalence proof: the action ledger,
   `CONTRACTS.md` and guidance coverage are unchanged, plus a disjointness test over every ledger route and a
   runtime guard that refuses a plan matched by two families. Migrate the 83 families of the nested reader chain
   first, then the rest (F-59, F-60, F-63). **Passes 1 and 2 done:** 57 families registered (verification
   hooks take `before`, scope hooks the plan, spend messages may depend on the request, `snapshotState` and
   `verifiedResources` hooks; the DV360 write scope is a family hook). **Pass 3 done (batch 31):** 12 more (the
   Snapchat families with their own reviews, DV360 ad assets, Demand Gen ads and SDF, Criteo catalog and promoted
   products), 71 in all, proven by replaying 46,187 captured lifecycle calls with 0 differences. **Done in batch 33:**
   the other 72, so all 143 are registered and the lifecycle modules name none of them; the reader chains and the
   20 named spend-text exemptions are gone. Hooks now also cover whole-state reads, follow-up reads, actor checks,
   report-job admission and receipts, preview delivery and a family's own verification. The seven platforms' entity
   writes stay gateway logic by design, as does compile-time path rewriting (ADDING-A-REVIEWED-FAMILY.md).
2. **Guarded reader helper** replacing the 15 hand-copied wrappers in `state()` (F-61). **Done in batch 17**: one
   reader in the review and one in the verification replace 31 wrappers.
3. **Stage split** of `write-review.ts` / `write-verification.ts` along the lifecycle. **Done for `write-review.ts` in
   batch 23** (outcome, state validation, shape and snapshot-plan stages in their own modules), and for
   `write-verification.ts` in batch 24 (the verification plan in `verification-reads.ts`).
4. **Formatting** — **done in batch 8**: Prettier at 120 columns, `.editorconfig` with LF, module by module in
   format-only commits, each proven neutral by syntax-tree equality (a Prettier-normalised `dist/` comparison turned
   out not to be a proof, because Prettier keeps some input line breaks); `format:check` runs first in
   `npm run check` (F-62). `web/` followed in batch 21.
5. Adding-a-family guide showing the one-module, one-test, one-registration workflow. **Done:**
   `docs/ADDING-A-REVIEWED-FAMILY.md`.

## P3 — website and MCP workflow

- Website: page-level error states, confirmations for destructive actions, focus handling, contrast and target sizes,
  one token file, MFA setup with QR, team flow, responsive fixes, back-button scoping, caching and compression
  (F-35 … F-46). **Reporting**: clearer states, `Intl` formats from the user's locale, metric definitions per
  platform, currency and time-zone labels, accessible table and exports. **Done**: batch 19 finished contrast, the
  token file and right-to-left text, and batch 27 the WCAG 2.2 target sizes (F-82).
- MCP: opt-in compact outputs (`evidence:"ref"`), compact tool list flag, accurate descriptions, "use this when"
  guidance, canonical argument names (F-29 … F-32).

## P4 — performance and developer experience

- Parallel tests by default (measured 4× faster) and a related-suites runner (F-65, F-68).
- Lazy loading of generated route data (F-64); asset caching/compression (F-45).
- `docs/implementation/` index and changelog in place of append-only handoffs.

## P5 — functionality and contracts

- Provider lifecycle: dated sunset registry with a 90-day alarm (done in batch 20); Google Ads v23 → v25 (done in
  batch 14), Microsoft REST evidence (SOAP ends 2027-01-31; done in batch 32), Criteo 2026-01 → 2026-07 (done in batch 32), Meta v26 (done in batch 15)
  (F-49 … F-52, F-56). Every upgrade is done, so no upgrade order is left to decide.
- Write coverage, platform by platform ([COVERAGE.md](COVERAGE.md)): the 558 blocked writes sorted by the decision
  each needs, with a recommendation per owner-decision kind and 79 candidates ordered by value and evidence. Batch 34:
  TikTok pixels, LinkedIn planning reads, and recorded reasons for eleven rows.
- Newly implementable ledger rows (F-58), each to the full family standard: Google customer label removal and Meta
  ad video removal **done** in batch 33. TikTok creative portfolio deletion and X analytics job deletion stay blocked
  on evidence (the ledger says why); they wait for TikTok's documentation to be readable and for X to document the
  deletion again.

## P6 — the owner's live tests (2026-09-29)

- Google items 1–10 and Snapchat S1–S14: **done** (F-84 … F-106; records in
  `docs/implementation/GOOGLE-BRIEF-2026-09-29.md` and `SNAPCHAT-BRIEF-2026-09-29.md`).
- The owner's decisions (2026-09-29, "do what you think is best"): **done** in batch 30. All-or-nothing Google
  builds (F-108) and the recovery of a refused build (F-109); paused parents on Snapchat, Meta and TikTok (F-107);
  lapsed ownership renewed automatically (F-70); the activation policy kept, its refusal clearer; the origin
  allowlist left empty with a rule for when to set it (a Railway change).
- Whether a Snapchat, Meta or TikTok refusal after submission proves nothing was applied: **checked 2026-09-29, it
  does not**, so a refused step of these platforms still stops the plan. Snapchat documents the opposite: its create
  and update endpoints take several records sharing a parent, answer `request_status: PARTIAL` with a status per
  record, and say of media copies "This request is not atomic"
  ([API patterns](https://developers.snap.com/marketing-api/Ads-API/api-patterns),
  [media](https://developers.snap.com/marketing-api/Ads-API/media)). Meta's
  [error-handling guide](https://developers.facebook.com/docs/graph-api/guides/error-handling) names the error fields
  and when to retry, and says nothing on whether a refused write changed anything. TikTok's Business API pages still
  render only in a browser. Only Google's all-or-nothing builds recover after a refusal (F-109).
- Clone for TikTok and LinkedIn: **done** in batch 31 (F-110). Snapchat by-ID reads: **done** in batch 32, from
  Snapchat's documentation. Meta keeps its native copies.
