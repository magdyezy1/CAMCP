---
status: record
tier: engineering
---

# Website discovery, OAuth and resumable media authorization — 2026-09-25

Base revision: `796c22660d16c68a7ecde71cb0d9363b3bf824bd`, on `Codex-branch`.
This is separate from the already-pushed MCP attempt-authorization batch. That
batch's exact [GitHub run #99](https://github.com/magdyezy1/AMCP/actions/runs/36073072256)
passed in 14m 56s, including required FFmpeg, Docker and both smoke modes.

## Confirmed defects and correction

**P2, high confidence: stale website discovery authorization.** A connection sync
could send subsequent retries using replaced credentials or continue after its
initiating browser session ended. A successful response could also overwrite
saved asset metadata after the login changed, and the HTTP route returned 200.
The race requires a concurrent session revocation, scope change, disconnect or
login replacement. It can disclose stale-login asset identities to an operation
whose authority was withdrawn, and contaminate the replacement login's inventory.
It does not itself create an advertising mutation or a new account grant.

`server/asset-discovery.ts` now checks the current connection, scopes and stored
credential fingerprint before each HTTP attempt and after reads. The website
passes a current administrator-session check. All 15 website providers use this
guard, including paginated collections, direct TikTok/Sheets/Microsoft requests,
Google hierarchy discovery and GA4/Search Console collection adapters. The guard
is a local closure for each sync, never mutable state shared between workspaces.
The result carries a private `assertCurrent` callback; `server/website.ts` invokes
it after awaiting discovery and before synchronous persistence. It is not part of
the public response, a client parameter or a new provider contract.

Discovery still works for new disabled connections with no selected accounts.
An administrator's provider inventory discovery is distinct from an AMCP selected
account grant. Concurrent deselection remains respected, and discovery does not
restore it. Label changes and a legitimate credential refresh do not invalidate
the operation. Scope removal and credential replacement do. Provider failures
remain incomplete asset groups with safe diagnostics; authorization withdrawal
is a fatal error that cannot be converted into successful empty discovery.

**P2, high confidence: Google reauthorization could continue after withdrawal.**
`server/google-account-discovery.ts` and `server/google-reauthorization.ts` now
carry the operation guard through root, hierarchy and selected-account reads,
including retries. Fresh proposed credentials are intentionally distinct from
the retained login. The guard checks the retained login's revision/fingerprint,
session and administrator role; it does not compare a new Google token to the
old token and reject every reauthorization. A concurrent refresh/replacement
requires restarting reauthorization and keeps the newer stored credentials.
Existing account selections and grants remain authoritative at commit.

**P1, high confidence: administrator demotion during OAuth exchange.** The
callback previously rechecked session existence but could still create a provider
connection using the role captured before the exchange. The exact window requires
an administrator to start OAuth and lose that role while the exchange is pending.
The consequence is persisting provider credentials and connection settings after
connection-management authority was removed. `server/website.ts` now checks the
current role and identity before/after exchange; `server/platform-oauth.ts` checks
between token responses, including before Meta's second exchange. Revocation or
demotion stops subsequent provider requests, connection persistence and discovery.
No provider token-revocation call is added; an already-sent exchange cannot be
recalled. The flow remains single-use and reports failure through its existing
OAuth progress record.

**P2, high confidence: Google media chunks retained withdrawn authority.** Two
full `amcp_media prepare → execute` reproductions initially sent a second chunk
after the stored Google login changed. Expanded fixtures also reproduce transfer
after the selected private Drive connection was disabled. Both a confirmed
non-final chunk and a lost reply with an offset-query recovery are affected.
`src/media-upload.ts` now binds Google's existing `beforeChunk` hook to the
credentials actually used for transfer and the current private Drive grant, in
addition to actor/account/review-expiry checks. It stops before the next chunk
or recovery query and keeps staged bytes, the original uncertain claim, upload
session and confirmed-byte journal. It never retries an uncertain finalization.

## Evidence

All requests use synthetic credentials, accounts and fetchers. No live provider
credentials were accessed or changed. Logs are under the ignored
`.runtime/contract-completion-20260924/` directory.

- `website-discovery-authority-baseline.log`: eight initial failing cases against
  unchanged website discovery (Meta, Google Ads, GA4, TikTok; actor/login races).
- `website-discovery-authority-first*`: build and 56 focused/compatibility tests pass.
- `website-discovery-authority-expanded*`: 47 tests, 45 passed/two failed because
  the Reddit fixture lacked its required User-Agent and never reached HTTP.
  Corrected the synthetic connection; the production User-Agent check remains.
- `website-discovery-authority-expanded-baseline.log`: 76 tests loaded against the
  immutable preceding release candidate; 31 passed/45 failed. This includes
  revoked retries, successful late responses, concurrent workspace isolation,
  exact metadata preservation, Google selected-account retries and role demotion.
  A new internal commit-guard contract also fails by absence on old code; it is
  not counted as a distinct security defect.
- `website-discovery-authority-final*`: 118 tests, 114 passed/four failed. The new
  HTTP fixtures compared persisted records to their input object, overlooking
  Store's `id` and `revision` fields. Fixed the fixtures to compare the entire
  actual pre-call stored record; no authorization assertion was loosened.
- `website-discovery-authority-compatible*`: build and all 118 tests pass, zero
  skips. Includes 45 added tests, plus stronger existing Meta exchange coverage.
  The full command is `node --test --test-concurrency=1` followed by compiled
  `website-discovery-authority`, `test-account-connections`, `website`,
  `google-reauthorization`, `google-sync-errors`, `measurement-apple`,
  `report-delivery-discovery` and `user-accounts` test files under `dist/tests/`.
- `website-discovery-authority-oauth-baseline.log`: the strengthened exchange
  regressions fail twice against the old immutable candidate. A revoked session
  still caused Meta's second exchange; administrator demotion still persisted a
  connection. Both cases pass with the correction.

The final combined candidate B passes the full required-FFmpeg check: **1746 main
tests and four capture tests, zero failures/skips, exit 0**. Generated catalogs,
pinned vendor/schema checks, website checks, reporting/lifecycle and action
contracts also pass. Its 617-file source manifest hash is
`4e32648a7ff776286a6015f14e22657e77e44fc8936196c768c1455fc1b06274`.
All staged code/test/guidance is compared to the tested candidate before commit.
Exact commands, runtime, original failures and log hashes are recorded in
`WEBSITE-DISCOVERY-AUTHORITY-VERIFICATION-2026-09-25.json`.
The post-push GitHub check remains a separate gate at this checkpoint.

Website-only candidate A passed the full required-FFmpeg check: 1742 main/four
capture, zero failures/skips. The additional media correction requires a fresh
candidate B, whose passing result is above; A does not establish coverage of
that later production change.
`media-chunk-authority-baseline.log` records two original failures;
`media-chunk-authority-expanded-baseline.log` records four failures against A.
`media-chunk-authority-fixed.log` records 67 passing media/compatibility tests,
zero failures and one optional FFmpeg skip on an unconfigured local invocation.
`media-chunk-authority-required-ffmpeg.log` then passes all 70 selected tests,
zero failures/skips, using the portable FFmpeg/ffprobe binaries. The fresh full
check remains separate; the initial optional skip is retained in the evidence.

## Compatibility and remaining boundaries

No database migration, package dependency, deployment-setting change, new OAuth
scope or new vendor action. Existing selections, failed-source reporting and
Google manager routing retain their compatibility tests. Permission withdrawal
returns existing authorization errors. For a changed login, refresh Connections
and sync using the intended identity; do not delete a working connection or
repeat a completed advertising write. A Google reauthorization race keeps the
current credential and requires a new consent attempt.

The shared MCP hardening and this website batch are complementary; neither
qualifies every separate HTTP client. Other direct media paths and scheduled export
delivery still need their lifecycle-specific retry/late-result review. Credential
refresh has its existing connection revision checks, but is not given a browser
session here. Simultaneous same-login inventory syncs still use the existing
metadata merge rules; no new cross-worker inventory lease is claimed.
Provider approvals, deployment behavior and live end-to-end accounts remain
unverified. Catalog coverage remains 1000 pending rows, including 886 blocked
writes; this safety work does not turn those into executable actions.

Next bounded engineering ticket: extend the media withdrawal fixtures to LinkedIn
part uploads, including organization binding and private Drive-grant withdrawal
between parts. This batch does not claim that boundary is qualified. Preserve
part identifiers/accepted receipts before any late delivery check, and retain
the current no-new-upload rule for uncertain outcomes. The Google counterpart
is now reproduced and corrected above.

Roll out after the earlier authorization commit. Rollback needs no data migration
and retains credential/audit formats, but reintroduces these races; prefer a
forward compatibility fix without removing the checks.
