# Roadmap

Ordered by the brief's priorities. Each milestone lands as focused commits, each qualified in a fresh release
candidate (`npm run check` + `node deploy/check-railway.mjs`). IDs refer to [FINDINGS.md](FINDINGS.md). Items marked
**owner** wait for a decision; the recommendation is given so the decision can be a yes or no.

## P0 — security, money and data correctness

| Item | Findings | State |
|---|---|---|
| Structural spend confirmation, numeric statuses, Reddit budgets in the owner policy | F-01, F-02, F-03 | done (batch 1) |
| Predictable confirmation model: `execute_requirements`, no pre-filled spend flag, `native_request` refused in writes | F-05, F-06, F-07, F-34 | done (batch 1) |
| Sign-in and OAuth limits keyed on the client, per-person two-step limit, sign-in time kept across workspace switches, client pruning, transport headers | F-08, F-09, F-10, F-11, F-17 | done (batch 1) |
| Unit-aware workspace spending defaults | F-04 | **owner** — recommendation: caps per gateway in canonical units with the account currency, and refuse a workspace default for a gateway without a unit mapping |
| Out-of-band approval for spend and activation | F-05 follow-up | **owner** — recommendation: MCP elicitation where the client supports it, otherwise a website approval bound to the review's state hash |

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
- Contracts: one LinkedIn version constant (F-53), Snapchat `lifetime_budget_micro` unit mapping (F-55), Reddit lead
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
   products), 71 in all, proven by replaying 46,187 captured lifecycle calls with 0 differences. Remaining: the 20
   families still named in the spend-text exemption (report jobs, the Google and Business families with dedicated
   spend refusals, X drafts, LinkedIn lead forms, TikTok custom conversions and saved audiences, Criteo keywords),
   Criteo overrides, TikTok negative keywords, the entity families and compile-time path rewriting.
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
  batch 14), Microsoft REST evidence (SOAP ends 2027-01-31), Criteo 2026-01 → 2026-07 (done in batch 32), Meta v26 (done in batch 15)
  (F-49 … F-52, F-56). **owner** for the upgrade order.
- Newly implementable ledger rows (F-58), each to the full family standard.

## P6 — the owner's live tests (2026-09-29)

- Google items 1–10 and Snapchat S1–S14: **done** (F-84 … F-106; records in
  `docs/implementation/GOOGLE-BRIEF-2026-09-29.md` and `SNAPCHAT-BRIEF-2026-09-29.md`).
- The owner's decisions (2026-09-29, "do what you think is best"): **done** in batch 30. All-or-nothing Google
  builds (F-108) and the recovery of a refused build (F-109); paused parents on Snapchat, Meta and TikTok (F-107);
  lapsed ownership renewed automatically (F-70); the activation policy kept, its refusal clearer; the origin
  allowlist left empty with a rule for when to set it (a Railway change).
- Still needing documentation this environment cannot reach: whether a Snapchat, Meta or TikTok refusal after
  submission proves nothing was applied (today it still stops the plan).
- Clone for TikTok and LinkedIn: **done** in batch 31 (F-110). Next without a decision: Snapchat by-ID reads once
  Snapchat documents their body. Meta keeps its native copies.
