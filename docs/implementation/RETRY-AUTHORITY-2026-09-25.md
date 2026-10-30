---
status: record
tier: engineering
---

# Authorization at each provider attempt — 2026-09-25

Base revision: `8672f3a992fd423b99351a75ee904d4100988e04`, only
`Codex-branch`. This follow-on is separate from the original CI timeout repair
and the completed Business Profile discovery batch.

## Confirmed finding

P1, high confidence for the mutation path; P2 for extra read attempts. Existing
workflows checked actor/grants before entering the transport and after receiving
data, but the transport could wait for pacing or retry a transient error between
those checks. Revoking the initiating key during that wait still allowed the next
HTTP attempt. A reviewed mutation could be dispatched after revocation; a native
read could return data obtained with a login that had just been replaced. The
race requires revocation, permission removal or reauthorization while a request
is in flight. The consequence is an operation after AMCP authority was withdrawn,
including an advertising write on the mutation path. No live exploit was attempted.

Initial five isolated tests each observed two reads instead of one after a
synthetic HTTP 503 revoked the key. Expanded regressions executed against the
previous immutable Business Profile candidate: 25 tests, four passed/21 failed.
They also demonstrate first-attempt pacing races, changed credentials, removed
permissions, reviewed mutation dispatch, result delivery after revocation, media
preparation, readiness, GTM diagnostics and provider validate-only. After repair,
the same 25 pass; the original assertions are retained.

## Change

`src/native-authority.ts` binds a request to its current actor, exact tenant/login,
selected account, recorded permissions, native resource scope and encrypted
credential fingerprint. It runs immediately before each attempt, after transport
pacing, and before read results are used. The existing runtime-only transport
hook is never serialized into provider requests, saved reviews or client schemas.

Integration points: `src/service.ts` native reads on every gateway;
`src/write-review.ts` all reviewed preparation/state requests and mutation dispatch;
`src/write-verification.ts` every native read-back branch; `src/media-upload.ts`
account snapshots, upload steps and status reads; `src/gtm-diagnostics.ts`,
`src/meta-ad-library.ts`, `src/provider-validation.ts` and `src/workspace.ts`.
The existing stricter callbacks in `src/measurement-connection-sync.ts`,
`src/meta-existing-posts.ts` and `src/meta-creative-state.ts` now also run before
each retry, preserving their provider-specific checks and private Page-token
handling. Adjust and Business Profile already used per-attempt callbacks.

Unrelated label edits or added grants do not invalidate an otherwise authorized
read. Losing recorded permissions, removing/disablement of the selected login,
revoking the actor, losing the selected account or replacing credentials does.
There is no new scope, grant, credential, provider call, write bypass or retry of
an uncertain mutation. Reviewed mutations remain one attempt.

A provider may accept a write before revocation arrives. Its received outcome
must be committed before checking delivery authority: otherwise denial could
discard the receipt and invite a duplicate mutation. Accepted outcomes now remain
`complete`, with verification queued, while a revoked caller receives denial.
The catch path records `write_result_withheld` and never changes that receipt to
uncertain. A failed pre-dispatch check after an idempotency/spend claim still uses
the existing conservative uncertain/reservation behavior; no allowance is released
without a separately qualified no-dispatch receipt contract.

## Verification and rollout

Local logs in `.runtime/contract-completion-20260924/`:

- `retry-authority-baseline.log`: five expected failures before changes.
- `retry-authority-first*`: build and all five reproductions passed.
- `retry-authority-expanded*`: build and 164 compatibility tests passed.
  That initial command included two nonexistent test paths that Node ignored;
  no coverage is claimed for those names. The corrected command includes
  `workspace-operations.test.js`, while full validation uses the repository glob.
- `retry-authority-regressions*`: first 23 regressions passed.
- `retry-authority-extra-baseline.log`: all 25 against the previous sanitized
  candidate, four passed and 21 failed. This isolates the production-code delta.
- `retry-authority-final*`: build and 202 focused/shared tests passed, zero skips.
  Includes 25 new behavioral regressions, accepted-receipt preservation, read-back,
  supported platform writes, media, reporting prerequisites and both measurement
  connection-sync workflows. No test assertion was relaxed.

Candidate A completed with 1696 tests: 1691 passed, five failed, zero skipped.
Three existing Google verification assertions expected `INSUFFICIENT_SCOPE`;
the generic scope-removal guard initially returned `REAUTHORIZATION_REQUIRED`.
The TikTok preparation assertion expected `TIKTOK_REPORT_TOKEN_CHANGED` instead
of that same generic error. Corrected both classifications, retained the original
assertions, and added a TikTok acceptance/token-change receipt regression.

The fifth failure occurred in the media-capacity test's final directory removal
(`ENOTEMPTY` on Windows), after its streaming, memory and cleanup assertions.
Both SQLite handles were closed; the named synthetic temporary directory was
empty when inspected afterwards. Added five bounded 100 ms linear-backoff
filesystem removal retries, an explicit resolved-path check and a final absence
assertion. Persistent cleanup failures still fail; no exceptions are swallowed.
This uses documented Node 24 behavior: [fs.rmSync options](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsrmsyncpath-options),
checked 2026-09-25. The precise external holder was not identified, so this is
recorded as a transient Windows cleanup failure, not a proven database defect.

`retry-authority-compat*` records the corrected build and all 150 focused tests
passing, including the five initially failing cases and the additional TikTok
receipt case. Candidate A and its log remain intact. Candidate B was assembled
but superseded before its full check by these additional compatibility fixes;
fresh candidate C contains all corrections.

Fresh sanitized candidate C passes the complete required-FFmpeg check: 1697 main
tests and four capture tests, zero failures/skips, exit 0. Code generation, pinned
vendor/schema validation, website checks, provider lifecycle and action contracts
also pass. Its 613-file manifest has source hash
`fc1ebfdd80bbf58e114d75ad8764545a0c9d870aecab3f304a47067757cb208c`.
The Git index is compared to that immutable candidate before committing; the
website discovery follow-on stays unstaged and is not included in this claim.
`RETRY-AUTHORITY-VERIFICATION-2026-09-25.json` records exact commands, hashes,
runtime and retained initial failures. Exact post-push CI remains a separate gate.
There is no schema/database migration, dependency or deployment-config change.
Use the same release path and preserve existing receipts during rollback.
Reverting the authorization checks restores the reproduced race; prefer a forward
compatibility fix to bypassing the check. Live provider approval and deployed
behavior remain unverified.

## Explicit remaining boundaries

These changes qualify the named MCP execution paths, not every independently
implemented network client. Website `AssetDiscovery`, fresh Google reauthorization,
OAuth token exchange and direct/resumable media transfer have separate lifecycle
callbacks and need their own per-attempt/late-result race review. In particular,
`server/asset-discovery.ts` has a shared instance and cannot safely use a mutable
instance-wide actor/token field for concurrent requests. Pass an operation-local
guard through page/Google hierarchy reads (or an isolated async context), fence
credential/session changes before metadata persistence, and test two simultaneous
workspaces before extending this guarantee. Fresh OAuth credentials must be
verified without comparing them to the still-retained old login credentials.
This is implementation work, not a request for live credentials.

An HTTP request already delivered cannot be recalled by local revocation. These
checks stop subsequent attempts and result delivery; they do not claim provider
token revocation or cancellation of an accepted mutation. Existing provider
permissions, spend policies, reviewed state comparisons, frozen requests,
idempotency, read-back and deployment controls remain required.

## Exact pushed CI result

Commit `796c22660d16c68a7ecde71cb0d9363b3bf824bd` is pushed to `Codex-branch`.
[GitHub run #99](https://github.com/magdyezy1/AMCP/actions/runs/36073072256) passed
in 14m 56s: required-FFmpeg check, deployment-config validation, Docker build,
image capture and read/write container smoke modes. GitHub's check step took
6m 37s; CI test totals were not separately extracted from the virtualized logs.
The local exact-source totals remain 1697 main/four capture. This does not prove
deployed provider behavior or qualify the separate website/media follow-on.
