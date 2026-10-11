# AMCP architecture

This is the module map, request lifecycle and trust-boundary view of AMCP as of `Codex-branch`
at `03ac8d3` (2026-09-28). It describes what the code does today; line numbers refer to that
revision. For generated contract facts (pinned versions, reviewed scope) `docs/CONTRACTS.md`
stays the source of truth.

## 1. Runtime shape

One Node.js 24 process (`dist/server/http.js`) hosts three things:

| Component | Entry | What it does |
|---|---|---|
| Website | `server/website.ts` + `web/` | Accounts, MFA, sessions, platform OAuth, account selection, MCP connector page, policies, plans, reporting |
| MCP endpoint | `server/http-app.ts` (`POST /mcp`) → `server/mcp.ts` | Stateless Streamable HTTP; bearer token → `Actor`; every tool call goes to `MirrorService.call` |
| Worker loop | `server/http.ts` (`ReportWorker`) | Report jobs, scheduled exports, write verification jobs, e-mail outbox |

`server/stdio.ts` is the local stdio MCP variant with the same `MirrorService`. State lives in one
SQLite file (`MIRROR_DB`, `/data/mirror.sqlite` on Railway) opened through `node:sqlite`
(`src/store.ts`, `server/web-store.ts`).

## 2. Module map

```
server/                         website, OAuth, MCP transport, worker loop
  http.ts ─ http-app.ts ─ mcp.ts ─────────────┐
  website.ts, user-accounts.ts, account-*.ts   │
  platform-oauth.ts, social-signin.ts,         │
  mcp-oauth.ts, web-store.ts                   │
                                               ▼
src/service.ts  MirrorService.call(tool, input, actor)
  ├─ catalog.ts (Registry: generated/registry.json, validation, help)
  ├─ compiler.ts / delegated-native.ts (tool args → CompiledRequest)
  ├─ execution-risk.ts (readOnly / destructive classification)
  ├─ preflight.ts (authorizeExecution: kill switch, role, confirmations)
  ├─ scope.ts (ScopeGuard: account + resource grants, ownership bindings)
  ├─ transport.ts (NativeTransport: origin allowlist, retries for reads, limits)
  ├─ auth.ts (CredentialProvider: sealed tokens, refresh)
  ├─ write-review.ts (amcp_write: inspect / prepare / execute)
  │    ├─ reviewed-routes.ts (route → family name; also used by the ledger)
  │    ├─ review-state.ts (snapshot normalization, state hash)
  │    ├─ write-impact.ts (impact summaries)
  │    ├─ spend-policy.ts + policy-decimal.ts (owner spending policies)
  │    └─ 148 family modules (x-entity-batches.ts, google-business-lodging.ts, …)
  ├─ write-verification.ts (amcp_campaign verify: read-back comparison)
  ├─ media-upload.ts, media-routing.ts (amcp_media, Drive transfer, FFmpeg)
  ├─ workflows.ts, campaign-runner.ts, campaign-preflight.ts (plans)
  ├─ reporting*.ts, report-*.ts, decision-reporting.ts, google-sheets.ts
  ├─ workspace.ts (readiness, spend policies, contracts listing)
  └─ store.ts (SQLite: tenants, connections, documents, idempotency, jobs, audit)
```

Generated inputs (never hand-edited): `generated/registry.json` (5.5 MB, captured tools and
actions), `generated/vendor-routes.json` (5.9 MB, routes from pinned vendor documents),
`generated/microsoft-contracts.json` (6.6 MB, WSDL-derived). The unused `generated/types.ts` is no longer generated
(MCP-07); the AMCP tools' per-action contracts are `src/first-party-contracts.ts`.
Ledgers and `docs/CONTRACTS.md` are produced by `tools/action-contracts.ts` and
`tools/generate-contracts.ts`.

## 3. Trust boundaries

```mermaid
flowchart LR
  subgraph Untrusted
    B[Browser user]
    C[MCP client / LLM]
    P[Provider APIs and their content]
    W[Web pages, Drive files]
  end
  subgraph AMCP process
    WS[Website routes<br/>session + CSRF + origin]
    M[/mcp<br/>bearer token → Actor/]
    S[MirrorService]
    R[Write review<br/>scope + policy + review]
    T[NativeTransport<br/>origin allowlist]
    K[Worker]
  end
  DB[(SQLite<br/>sealed secrets)]
  B -- cookies, forms --> WS
  C -- JSON-RPC --> M
  WS --> S
  M --> S
  S --> R --> T
  S --> T
  T -- HTTPS --> P
  S -- media fetch --> W
  K --> S
  S <--> DB
  WS <--> DB
```

| Boundary | Crossing | Control (where) |
|---|---|---|
| Browser → website | cookie session, form/JSON posts | session cookie, CSRF token, `Origin` check, MFA (`server/website.ts`, `server/web-store.ts`, `server/account-security.ts`) |
| MCP client → `/mcp` | bearer token | `store.authenticate` (hashed token, expiry, revocation), `Origin` pinned to public origin (`server/http-app.ts:48-70`) |
| Actor → tenant data | every tool call | `Actor.tenantId` on every store query; `assertActorActive` on every call (`src/service.ts:116-120`) |
| Actor → provider account | per request | `store.resolveConnection` + `ScopeGuard.authorize` (selected accounts, resource grants, ownership bindings) |
| Server → provider | HTTPS | `NativeTransport` origin allowlist, per-family read-only checks for snapshot reads (`applyExecutionRisk(read).readOnly`) |
| Provider content → LLM | tool output | `meta.untrusted_provider_content` label on every tool except `amcp_tool_help` (`src/service.ts:81-88`, `wrap`) |
| Money | reviewed writes only | kill switch, role, review, confirmations, spending policy, idempotency claim (§4) |
| Secrets at rest | SQLite | AES-256-GCM sealing with scoped additional data (`src/security.ts`), hashed bearer/session tokens |

A compromised MCP client is the most important adversary model: it holds an operator token and
can call any tool with any arguments. Everything below `MirrorService.call` must therefore be
safe for arbitrary, adversarial input from an authenticated operator; the owner's spending policy
and the review/confirmation protocol are the controls that still apply to that actor.

## 4. Reviewed write lifecycle

```mermaid
sequenceDiagram
  participant C as MCP client
  participant W as amcp_write (write-review.ts)
  participant P as Provider
  participant DB as SQLite
  C->>W: inspect {gateway, arguments}
  W-->>C: contract support, state reads (no network)
  C->>W: prepare {gateway, arguments}
  W->>W: compile, assertWriteShape, access()/ScopeGuard
  W->>P: snapshot reads (read-only, re-authorized per read)
  W->>W: validateState, normalizeSnapshot, prerequisites, impact, spend policy (check only)
  W->>DB: write_review {plan, reads, state, state_hash, fingerprint, expires +5 min}
  W-->>C: review_id, before_state, impact, spend_policy
  C->>W: execute {review_id, idempotency_key=review_id, confirmed, spend_change_confirmed?}
  W->>W: fingerprint check, authorizeExecution (kill switch, role, confirmations)
  W->>P: re-read snapshots → STATE_CHANGED if hash differs
  W->>DB: transaction: spend policy + reservation, idempotency claim
  W->>P: one mutation (never retried)
  W->>DB: receipt, audit, verification job
  W-->>C: outcome (+ verification next_call)
  C->>W: amcp_campaign verify {review_id}
  W->>P: verification reads → verified | inconclusive | unverified
```

Code anchors (formatted line numbers differ; search by name):

| Stage | Function | File |
|---|---|---|
| Input guard | `WriteReviewService.call` (unknown keys, delegated vs direct) | `src/write-review.ts` |
| Compile | `Compiler.compile` / `DelegatedNativeCompiler.compile` → `applyExecutionRisk` | `src/compiler.ts`, `src/delegated-native.ts`, `src/execution-risk.ts` |
| Membership | `reviewedWriteFamily(plan)` | `src/reviewed-routes.ts` |
| Validation | `assertWriteShape(plan)` (the family's `assert`, which may run the gateway's checks) | `src/write-shape.ts` |
| Scope | `access()` → the family's `actor`, `resolveConnection`, `assertAccountWrite`, the family's `scope`, `ScopeGuard.authorize` | `src/write-review.ts`, `src/scope.ts` |
| Snapshot plan | `snapshotPlans(plan)` (the family's `snapshots`, or its `state` reads the whole state) | `src/write-snapshots.ts` |
| Snapshot read | `state()` (`readThroughFamilies`: every registered reader, then the transport) | `src/write-review.ts` |
| Normalize | `validateState`, `normalizeSnapshot`, `reviewStateHash` | `src/write-state.ts`, `src/review-state.ts` |
| Prerequisites | the family's `prerequisites` and `stateChecks`, and the gateway's paused-parent checks | `src/write-review.ts` |
| Impact | `writeImpact` (the family's `impact`, else the gateway's) | `src/write-impact.ts` |
| Policy | `checkSpendPolicy` (activation, deletion, budget amounts, daily reservation) | `src/spend-policy.ts` |
| Confirmation | `authorizeExecution` (per-family spend confirmations, generic text match) | `src/preflight.ts` |
| Execute | `transport.request` once; `writeOutcome` (the family's `outcome`, `receipt`, `safeOutcome`) | `src/write-review.ts`, `src/write-outcome.ts` |
| Verify | `WriteVerifier.verify` (the family's `verify`, or `verificationReads`, `observed` and `readThroughFamilies`) | `src/write-verification.ts`, `src/verification-reads.ts` |

Invariants the lifecycle maintains (all verified in code; see `FINDINGS.md` for exceptions):

1. A non-read provider request can only be sent by `amcp_write execute` or `amcp_media`
   (`runPlan` throws `WRITE_REVIEW_REQUIRED` for any non-read plan, `src/service.ts` `runPlan`).
2. Execute uses the plan frozen at prepare; its fingerprint binds tenant, user, connection and
   plan; `arguments` at execute are refused.
3. The idempotency key equals the review id and is claimed inside the same SQLite transaction as
   the spend reservation; a claimed key is never re-sent (`WRITE_OUTCOME_UNCERTAIN`).
4. Snapshot reads are re-read at execute; any normalized difference refuses with `STATE_CHANGED`.
5. The mutation is sent once; the outcome is stored before any post-response permission check.
6. `verified` needs every expected field to match a read-back; otherwise `inconclusive`.

## 5. Family wiring (why adding one is expensive)

A reviewed family is one module that exports some of: `…Kind`, `assert…`, `…Snapshots`,
`read…`, `is…Read`, `validate…State`, `…Prerequisites`, `…Impact`, `…Outcome`,
`…Verification`, `…Observed`, `authorize…`, `…PolicyAmounts`, `…NeedsConfirmation`. The core
dispatches each hook through hand-written, order-sensitive `if (xKind(plan)) return …` chains:

| Chain | File | Entries |
|---|---|---|
| route → family name | `src/reviewed-routes.ts` | 130+ |
| outcome | `src/write-outcome.ts` (`confirmedMutationResult`) | 120+ |
| state validation | `src/write-state.ts` (`validateState`) | 100+ |
| shape assertion | `src/write-shape.ts` (`assertWriteShape`) | 100+ |
| snapshot plans | `src/write-snapshots.ts` (`snapshotPlans`) | 100+ |
| scope asserts | `src/write-review.ts` (`access`), `src/write-verification.ts` | 60+ each |
| nested readers | `src/write-review.ts`, `src/write-verification.ts` | 83 levels each |
| prerequisites | `src/write-review.ts` | ~100 calls |
| impact | `src/write-impact.ts` | 100+ |
| normalization | `src/review-state.ts` (`normalizeSnapshot`) | 90+ |
| scope authorize | `src/scope.ts` | 80+ |
| spend exemptions / confirmations | `src/preflight.ts` | 80 exemptions, 40 confirmations |
| activation / policy amounts | `src/spend-policy.ts` | 45 + 11 |
| ledger metadata | `src/action-contracts.ts`, `src/provider-contracts.ts` | 148 |

The typed registry replaces these chains family by family. Each family module declares one `ReviewedFamily`
(`src/reviewed-family.ts`) and `src/reviewed-families.ts` lists it; every chain above consults the registry once,
at the position of the first line it replaced, so the order of the lines still in the chain is unchanged.
`familyOf` refuses a request two registered families claim (`REVIEWED_FAMILY_CONFLICT`), and the nested reader
chains start with `readThroughFamilies`, which composes every registered reader. Pass 1 registered 41 families
and removed 734 lines of wiring from the ten lifecycle modules; pass 2 registered 16 more and removed another 310
(57 families; reader chains 83 → 42 → 26 and 80 → 39 → 23 levels; named spend-match exemptions 83 → 45 → 32).
Pass 3 (batch 31) registered 12 more, including the Snapchat families pass 2 left, and removed another 522 lines
(71 families; 27 → 17 and 23 → 13 nested readers; named exemptions 32 → 20). Its proof replays 46,187 distinct calls
of eleven lifecycle functions, recorded while the full suite ran on the previous commit, through the new build: 0
differences. Authorization is not among them, so its order was checked by hand: every authorizer the moved ones now
follow is guarded by another gateway, kind or read marker.

Pass 4 (batch 33) registered the other 72, so all 143 reviewed families are registered and the table above is
history: each stage consults the registry once and keeps only gateway logic (ADDING-A-REVIEWED-FAMILY.md, "Outside
the registry"). It removed 2,901 lines from the fifteen lifecycle modules (267 added) and both reader chains. A
family now owns what the chains could not express: whole-state reads, follow-up reads, actor checks, report-job
admission and receipts, preview delivery and its own verification. The lifecycle passes a family its read builders
and gateway fallbacks as arguments, so no family module imports a lifecycle module for them. The proof replays
46,614 distinct calls of thirteen functions (the eleven, plus spend-policy's activation decision and family amounts,
extracted as pure functions in the baseline too): 0 unintended differences; the 130 others are the two intended
ones (preview and X report redaction now inside `writeOutcome`, applied at the same point of execute; two LinkedIn
spend messages that now name `spend_change_confirmed=true`). The stateful stages (scope, review, verification) are
covered by the full suite, and the scope order by checking every generic authorizer's predicate against every family
request in the capture: none matches one.
`docs/ADDING-A-REVIEWED-FAMILY.md` is the guide, `ROADMAP.md` tracks the rest.

Families whose state reads need their own login binding or observation read through one guarded reader per side
(`WriteReviewService.guardedReader`, `WriteVerifier.guardedReader`, batch 17): the read must be read-only, and the
actor, connection and scope guard are checked again before the credentials are fetched, after, and after the
response; a family may add an actor or connection check, a login binding and an `after` step.

## 6. Data model (SQLite)

`src/store.ts`: `tenants`, `workspace_memberships`, `connections` (sealed credentials),
`documents (tenant_id, kind, id, data, revision)` — reviews, policies, plans, receipts,
reservations —, `idempotency (tenant_id, key, fingerprint, state, result)`, `jobs` (leases),
`audit` (hash chain per tenant), `resource_ownership`, `api_keys` (hashed MCP tokens),
`media_*`, `service_locks`, `provider_cooldowns`.
`server/web-store.ts`: `amcp_users`, `amcp_identities`, `amcp_web_sessions` (hashed),
`amcp_login_limits`, `amcp_oauth_states` (sealed), `amcp_mcp_clients`, `amcp_mcp_grants`,
`amcp_account_challenges`, `amcp_email_outbox`, `amcp_mfa` (sealed secret, hashed recovery codes).

Every tenant-owned table carries `tenant_id` in its primary key or first index column.

## 7. Measured baseline (2026-09-28, Linux container, Node 24.21.0)

| Measure | Value | How |
|---|---|---|
| Build (`tsc -p tsconfig.json`, TypeScript 7.0.2) | 5.1 s wall | `time node node_modules/typescript/bin/tsc -p tsconfig.json` |
| Cold start to constructed runtime | 1.08–1.14 s (import 0.32–0.38 s, construct 0.74–0.79 s) | `createRuntime()` from `dist/server/runtime.js`, 3 runs |
| Memory after start | RSS 197 MB, heap used 68 MB | same script |
| Source size | `src/` 3.65 MB in 263 modules (100,847 lines once formatted at 120 columns vs 31,750 today) | Prettier copy in scratch |

After batch 22 (F-64), measured the same way at `066739d` on 4 CPUs, median of 5: `createRuntime()` in 398 ms (import
252 ms, construction 147 ms; 860 ms before the change, when the code had grown since this baseline), RSS 146 MB, heap
used 68 MB. Generated artifacts are parsed once per process and frozen (`src/pinned-json.ts`), and tool validators
compile on first use.

Full-check timing and counts are in `PROGRESS.md`.
