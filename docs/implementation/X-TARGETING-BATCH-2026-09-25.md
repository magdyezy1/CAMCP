# X atomic targeting batch

Base: `a28930443ca38afd21fc3d73048d9b61de356915`, Codex-branch.
No live provider, credential, permission or deployment changes.

## Implemented

The mapped v12 batch targeting route was refused by the reviewed-write gate.
Two baseline tests failed before implementation. The new `x_targeting_batch`
family enables the canonical create/delete batch action with native JSON and
OAuth 1 signing. It reuses existing reviewed requests, account grants, policies,
one-attempt SQLite claims and verification jobs; no new table, dependency or
service is needed.

Before preparation, validate closed fields, selected account/origin, native IDs,
operation types and finite input bounds. Resolve every deletion's parent, then
read the account, paused line items, campaigns, complete targeting collections
and projected private references twice. Current account, actor, write grant and
login are checked before/after each request and transport retry. All reads have
page/count/byte/monotonic deadlines; failed or incomplete sources never establish
absence or successful empty state.

The projected set rejects duplicated/opposing criteria, multiple age buckets,
custom audiences mixed with their lookalikes and unsupported negative lookalikes.
Custom audiences must currently be targetable under the selected account;
provider-shared definitions do not confer AMCP ownership. Own-content targeting
needs the exact FULL promotable user. This does not inspect private audience
members or certify delivery, policy approval or every provider placement rule.

Only validated data enters the state hash. Collection rows sort by identity;
known placements are sets; unknown arrays remain ordered. Envelope metadata,
display-only criterion names, timestamps, serving observations and estimated
audience size do not create conflicts. Real targeting, bid, budget, name,
permission, parent and unknown configuration changes remain protected.

Mixed POST batches containing Delete are destructive for owner policy purposes.
Paused targeting edits do not activate ads or change budgets. The native atomic
request is sent once. Every ordered receipt must match its operation, parent,
requested fields, account echo and new/removed identity. Partial, lost, reused,
foreign and out-of-order results cannot be treated as successful. Accepted
receipts are retained before any late permission check; unauthorized result
delivery remains denied. No automatic resubmission is enabled.

Verification reads two complete resulting sets and their parents, retaining
untouched criteria and matching every addition/removal. Extra, missing, ignored
or externally changed configuration produces inconclusive results and hashes/
changed-field paths. Verification is read-only and rechecks current authority.

## Explicit limits and compatibility

The provider documents 500 operations; AMCP qualifies 100 operations/192 KiB,
20 affected line items, 25 private references, 10 pages/10000 rows per collection,
320 reads/8 MiB/60 seconds per state operation. Larger atomic batches need
separate capacity qualification, not automatic splitting. Active parents,
TV_SHOW locale-dependent creation, APP_LIST/TAP, preroll-only types and GTE/LT
remain outside this family. Generic targeting PUT remains refused.

Existing single-criterion contracts remain compatible. The legacy test asserting
all batches were unsupported now checks the unqualified Update batch variant;
its single-criterion/delete/PUT assertions remain. The provider descriptor moves
from version 5 to 6, and first-party guidance gains a locally executable inspect
example. Rollback disables new batch submissions; stored native JSON receipts
remain readable. Verification of these receipts requires this new family code.
Do not delete idempotency records during rollback.

X does not provide a conditional-write primitive for this snapshot. Another
operator can activate or modify a line item after the last read and before the
batch. The paused precondition reduces this exposure but cannot make it atomic.
Native sandbox acceptance and live shared-audience behavior are still unverified.

## Evidence

Official sources checked 2026-09-25:

- [X campaign-management reference](https://docs.x.com/x-ads-api/campaign-management/reference#post-batch-accounts-account-id-targeting-criteria):
  JSON batch, Create/Delete, group atomicity, ordered responses, item errors,
  native targeting fields and complete filtered collection pagination.
- [X audiences reference](https://docs.x.com/x-ads-api/audiences/reference):
  account-scoped identity, targetability, permission/owner metadata and estimated
  size; source also pinned by the earlier audience-estimation evidence fixture.

`tools/x-targeting-evidence.mjs --source <public-reference.md> [--check]`
extracts and pins the documented request/response examples, source hash and
explicit difference between vendor and AMCP bounds. It does not contact accounts.

Logs under `.runtime/contract-completion-20260924/x-targeting-batch-*.log`:

- baseline: 0/2, route correctly refused before a reviewed contract existed.
- first build: TypeScript unknown-return narrowing errors; corrected explicit
  validated-envelope return type, without weakening validation.
- core: 6/6.
- adversarial: 22/23. The synthetic revocation attempted an invalid enabled
  connection with zero accounts, which threw before returning a receipt. This
  was a fixture defect, not a demonstrated production receipt-loss defect.
  The separate receipt-baseline log retains the exact diagnostic.
- adversarial-2: 23/23 after revoking the selected account while retaining another
  valid account; access remains denied and the receipt remains complete.
- selected: 158/158, no failures/skips, 33679 ms, including 34 new batch tests
  and existing audience, single targeting, draft, creative, review, state, policy,
  per-attempt authority and executable guidance regressions.

Full sanitized candidate `.release/continuation-20260925-i` passes **2013 main
tests and four capture tests**, zero failures/skips, with required FFmpeg and
the Railway Dockerfile compatibility check. The 654-file manifest hash is
`6e88e7fe283bd07310cdac13c80a5d4e57a3ba6bb6d38f72c557ed1ad5e390d3`.
All 593 non-generated code/test/guidance manifest files match the Git index
after LF normalization. Exact commands, initial failures and log hashes are in
`X-TARGETING-VERIFICATION-2026-09-25.json`. Docker and live provider qualification
remain separate gates; the previous pushed revision's CI is not this batch's CI.
One captured action moves to a qualified family; unqualified variants stay
explicit. The other provider families and broader R2–R12 backlog remain.
