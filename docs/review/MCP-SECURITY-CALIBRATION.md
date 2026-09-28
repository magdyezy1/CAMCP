# MCP read and write controls: calibration

Question from the owner (2026-09-28): are the read and write controls reached through MCP too tight or too loose, and
can they be made logical and predictable instead of "stumpers"?

Principle used below: **a control earns its friction only if it stops something.** Friction that protects nothing is
removed or made automatic; protection that is missing is added; and every control a client meets should be
predictable from what it asked for, announce itself before it blocks, and say exactly how to proceed.

Legend for "Change": **done** (implemented in this review with tests), **next** (protection-neutral, scheduled in
the roadmap), **decision** (changes the level of protection; needs the owner's yes).

## 1. Read path

| Control | Today | Verdict | Change |
|---|---|---|---|
| Bearer token + reader/operator scope | Hashed, expiring, revocable; rechecked per call | Right | — |
| Selected-account boundary (`ScopeGuard`) | Every read authorized against the selected accounts / properties / sites | Right | — |
| Standalone resource ownership (`RESOURCE_SCOPE_REQUIRED`) | A Meta/Snapchat/… object id must first appear in an account-scoped collection read | **Right protection, stumper UX**: the error does not say which read establishes ownership, so a simple "raise this ad set's budget" costs a list call the model has to guess | **next**: the error names the collection action and gives a `next_call`; **decision**: let AMCP run that read itself when the provider's own record states the owning account |
| Independent read classification | 17 unqualified reads stay blocked | Right (fail closed) | — |
| Pagination / size limits | 8 MB responses, bounded pages | Right | — |
| `inspect_google_drive_media` | Any role, buffers up to 128 MiB, no concurrency limit | **Too loose** (resource exhaustion) | **next**: semaphore and streaming hash (F-21) |
| Untrusted provider content | One response-wide label | Too coarse | **next**: label paths that carry provider text (F-22) |

## 2. Write path

| Control | Today | Verdict | Change |
|---|---|---|---|
| Deployment kill switch | `MIRROR_ALLOW_WRITES`, read at start-up | Right, but no emergency stop without redeploy | **next**: owner "pause all writes" switch checked on every execute (F-24) |
| Role + account write grant | Operator/admin plus per-account grant | Right | — |
| inspect → prepare → execute, 5-minute review, state hash, fingerprint | Frozen request, re-read before execute | Right; expiry is the one sharp edge | **next**: `REVIEW_EXPIRED` returns a ready re-prepare call; `amcp_campaign` re-prepares instead of failing the step (F-27) |
| `confirmed: true` | Always required at execute | Cheap, deliberate act; keep | — |
| `idempotency_key` | Must be passed and must equal `review_id` | **Friction without protection**: the key is the review id either way; three different error codes for the same mistake | **next**: default it to `review_id`; one error code (F-33). Protection unchanged |
| `spend_change_confirmed` — when | Decided only at execute; first attempt fails | **Stumper** | **done**: `prepare` returns `execute_requirements` with reasons and fields (F-06) |
| `spend_change_confirmed` — coverage | Text match on budget/bid/spend + string ACTIVE | **Too loose** for bid targets, pacing, schedules, targeting, optimization, numeric statuses | **done**: structural, fail-closed rule (F-01, F-03) |
| `spend_change_confirmed` — false positives | Any value containing "bid"/"budget"/"spend" (e.g. a campaign *named* "Budget test") | **Too tight**, and it trains models to always send the flag, which weakens it | **decision**: match field names only, now that the structural rule covers the value-only cases. This removes confirmations, so it waits for a yes |
| `spend_change_confirmed` — who sets it | The model; `amcp_campaign` pre-filled it | **Too loose** | **done**: never pre-filled (F-05); **decision**: an out-of-band approval (MCP elicitation or a website approval bound to the review's state hash) for spend and activation |
| `creative_edit_confirmed` | Must be sent at prepare *and* execute | Logical once announced | **done**: `execute_requirements` lists it |
| Owner spending policy | Budgets only; unconfigured accounts unprotected; workspace default unit-less | **Too loose** in three ways | **done**: Reddit `goal_value` counted (F-02), numeric status = activation (F-01). **decision**: unit-aware workspace defaults (F-04), optional bid ceiling (F-57), a default policy on first connection |
| Paused creation | New serving entities must be created paused/draft | Right | — |
| Enhanced `native_request` in writes | Accepted | **Too loose** (action/path spoofing) | **done**: refused in `amcp_write` (F-07) |
| Plan steps for DV360/Amazon | `account_id` injected into schemas that forbid it | **Too tight by accident** (a bug) | **next**: add `account_id` only where declared (F-26) |
| Error remedies | Generic "prepare again" for most codes, including execute-time confirmations | **Stumper** | **next**: code-specific remedies with `next_call` (F-28) |

## 3. Resulting model (what a client can rely on)

1. `inspect` never touches the network and tells you whether a reviewed contract exists.
2. `prepare` reads live state and returns the frozen review, the impact, the spending-policy result and
   `execute_requirements`: exactly which flags execute will ask for and why.
3. `execute` needs the review id and `confirmed: true`, plus exactly the flags `execute_requirements` named, set only
   after the user approved them. Nothing else is required, and nothing that was required at prepare is a surprise.
4. Every refusal names the next call.
5. The owner policy, account grants, the kill switch and paused creation are hard limits that no flag overrides.
