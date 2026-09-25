# LinkedIn video recovery and media lease correction

Base revision: `7668016` on `Codex-branch`. This follows candidate F's qualified
X audience/Google availability/backup batch; F does not validate these later edits.
No live provider, credential, permission, deployment or advertising changes.

## Reproduced failures and implemented behavior

LinkedIn already retained encrypted upload instructions and ordered ETags, but
`amcp_media resume` accepted Google video only. It also lacked an in-flight PUT
marker: an empty receipt list could not distinguish an unsubmitted part from an
accepted part whose response was lost. The new two-test baseline fails **0/2**.

The new versioned transfer receipt binds the frozen file/hash/size, selected
connection/account, organization/person owner, credential fingerprint, original
scopes, signed-URL expiry, ordered instructions and ETags. Before each PUT it saves
the part index durably. A valid acknowledgement clears that marker and commits
its ETag before further authority checks. Public recovery returns counts/reasons;
signed URLs, upload tokens, ETags and credential hashes remain encrypted.

Explicit confirmed `resume` with the original review/key:

1. Checks actor, workspace, exact account/write grants, original owner and private
   Drive grant, unchanged frozen bytes and original five-minute review.
2. Requires a current versioned receipt with a fully acknowledged prefix, no
   in-flight part, no finalization attempt, the original login/scopes and an
   unexpired upload URL. Older receipts cannot be silently upgraded.
3. Reads the exact provider media, requires the expected owner/account and
   `WAITING_UPLOAD`, and rechecks authority after that read.
4. Sends only previously unsubmitted parts. If every part has a receipt, it
   sends no binary data and finalizes once using the original ordered ETags/token.
5. Persists the final receipt before a fallible processing read. Completed
   receipts replay without egress, including subsequent explicit resume calls.

Missing ETags, lost responses, provider processing/completion, replaced logins,
expired reviews/URLs and failed current authorization remain blocked. This does
not infer provider idempotency or retry uncertain PUTs/finalization. No fresh
initialization is used to recover the same upload. Current UI recovery controls
already consume `resume_available`; no platform-specific UI bypass is added.

A second reproduction exposed a shared recovery defect: five-minute media locks
and byte reservations survived a worker crash for the entire review window.
The real subprocess-exit test fails **0/1** with `MEDIA_MEMORY_BUSY` after advancing
the synthetic clock 46 seconds. Reservations and execution locks now use
45-second leases, renewed every 15 seconds and at authority boundaries. Renewal
requires the existing owner and an unexpired lease. Stale workers, backward clock
movement and missed monotonic lease windows stop before further requests while
retaining accepted receipts. Release cannot remove another holder's lock.

After a process exits at a confirmed-part checkpoint, another process can resume
after lease expiry if the original review and signed URLs still have enough time.
A process dying during a PUT still leaves an uncertain marker and cannot resume
that part. A crash near review expiry may leave no safe continuation window.

## Compatibility and rollout

No database migration, dependency, service or live configuration change. Existing
encrypted upload-session storage and media admission tables are reused. Other
media adapters keep their upload protocols and gain the same lease fencing.
Google retains authoritative-offset recovery; repeating an already-completed
resume now returns its stored receipt without egress. Its lost-finalization test
still requires refusal. New error remedies preserve the original upload instead
of suggesting preparation of a replacement. Unsupported provider-action copy no
longer incorrectly claims every unsupported alias was previously withdrawn.

Pre-upgrade leases keep their saved expiry; do not delete them manually to force
recovery. Pre-upgrade LinkedIn sessions remain non-resumable because the missing
intent marker cannot establish safety. Rollback leaves session JSON readable by
the prior release, which continues to refuse LinkedIn resume. Public progress and
new reason fields are additive. No uploads are automatically activated or resumed.

## Verification and primary evidence

The [official Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-05)
documents inclusive ordered byte ranges, PUT ETags, native token/finalization
fields, URL expiry, ownership and waiting/processing states. Public Markdown was
checked 2026-09-25 with requested version 202605; its returned shared document
includes that version and defaults to 202609. This source does not promise that
repeating a PUT or finalization is safe. Its hash and the distinction between
provider protocol and AMCP recovery decisions are in
`tests/fixtures/linkedin-recovery-evidence.json`. Regenerate/check:

```text
node tools/linkedin-recovery-evidence.mjs --source <public-videos-markdown>
node tools/linkedin-recovery-evidence.mjs --source <public-videos-markdown> --check
```

Logs: `.runtime/contract-completion-20260924/linkedin-resume-*.log`.

- `baseline`: 0/2, confirmed resume missing and missing pre-PUT marker.
- `core`: 65/65, initial resume plus existing media/authority regressions.
- `expanded`: 34/35. The concurrent-call fixture hit the default memory admission
  gate before the upload lock; its assertion expected the latter. The fixture now
  grants enough synthetic byte capacity to exercise the lock and always drains
  the held promise before closing SQLite. The default capacity guard is unchanged.
- `concurrency`: 36/36 after that fixture correction and a scope-loss case.
- `crash-baseline`: 0/1, old five-minute leases prevent real process recovery.
- `leases`: 59/59 after renewal/fencing, including real process exit and Google
  credential/Drive withdrawal races.
- `selected`: **129/129**, zero failures/skips, 50787 ms. Exact command:

```text
node --test --test-concurrency=1 tests/linkedin-media-resume.test.mjs tests/linkedin-media-authority.test.mjs tests/media-chunk-authority.test.mjs tests/google-upload-restart.test.mjs tests/operations-recovery.test.mjs dist/tests/media-upload.test.js tests/guide-contract-examples.test.mjs tests/provider-unavailable-actions.test.mjs
```

There are 43 new media-recovery tests. They cover actual SQLite reopen/process
termination, correct remaining bytes, one-time finalization, old/expired/malformed
receipts, current provider identity/status, lost acknowledgements, account/owner/
scope/login/actor/workspace changes, concurrent holders, stale renewal, backward
clock movement, encryption and redaction. The 128 MiB shared-capacity regression
also passes. All traffic is synthetic; no live LinkedIn upload was attempted.

Sanitized candidates G and H both passed **1979 main plus four capture tests**,
zero failures/skips with required FFmpeg, and all subsequent check stages plus
Railway Dockerfile compatibility. G's main duration was 442303 ms. H includes
an additional temporary-test cleanup path check and is the final tested source:
648 files, source hash
`bbd8ce98ed90c6751cd8ce28536a2bce3cc885b132052fb58ab93672d53d73c5`,
base `7668016`, main duration 440874 ms. No production code differs from G.
Offline clean npm installation passed. Exact staged-source comparison and hashed
logs are recorded in `LINKEDIN-MEDIA-VERIFICATION-2026-09-25.json`. Docker and
live provider qualification are not established by this Windows check.

The broader unresolved action
inventory remains **984**; this repairs recovery without claiming a new provider
action. Provider approval/live uploads, other missing families and the R2–R12
backlog remain separate work.
