---
status: record
tier: engineering
---

# Delivery — explicitly retained encrypted creative originals

Date: 2026-10-03. Baseline: `2a11b96`. Repository/branch: `magdyezy1/CAMCP`, `Work-here`.

## Delivered behavior

A current workspace owner can explicitly retain one completed upload/import by confirming its exact SHA-256.
AMCP copies and re-encrypts the original into a separate `lib-…` source. The temporary source, its bytes and its
30-minute expiry remain unchanged. Retention is per file; deployment does not automatically archive existing
or future uploads. The library source stays available until owner-confirmed removal. Its original uploader and
workspace administrators retain the existing source access rules, with current member/session/token checks.

Both the website and `amcp_media` expose retention and removal. MCP uses `retain_source`/`remove_source`,
`source_id`, `confirmed:true` and the exact `expected_sha256`. `list` includes accessible retained sources;
the returned library source can be used for the existing plan, prepare, variant and eligibility workflows.
Preparing a provider upload still creates a separate frozen review and needs the original write authority and
confirmation. Saving an original neither uploads it nor publishes an ad.

The website names the file, hash, lifetime and shared quota in a Cancel-focused dialog. File details expose the
exact source ID/hash. Recent-source choices distinguish retained originals, long names wrap, and selection of a
temporary file followed by retention cannot duplicate an already selected library source. Navigation, identity,
draw-generation and detached-control guards prevent obsolete confirmations or responses from acting on a new
view. A successful retention focuses the replaced source region. Cancellation returns to its enabled control;
the common focus helper no longer treats a connected element inside a closed dialog as a valid focus target.

## Storage, quota and operator upgrade

Store initialization adds `retained_media` and `retained_media_chunks` tables. Existing schema version, documents,
temporary cleanup, review expiry, dependencies, master key and provider contracts are unchanged. Manifests and
bounded chunks are authenticated to tenant, purpose and exact ID. Every read/retry verifies count, order, byte
length and SHA-256; incomplete copy, corrupt chunks, expired staging or authority loss rolls back the copy and
success audit. A retry returns the same verified library ID without another successful retention audit.

Temporary and retained originals share the existing ceilings: **25 files / four times the configured media limit
per workspace**, and **50 files / eight times the limit for the service**. An unfinished upload reserves the full
limit; completed and retained files count exact bytes. Creating a retained copy costs another slot and its bytes
while the temporary original remains. Review/variant staging keeps its separate existing quota. Accounting
checks encrypted manifest size against the SQLite counter; a reduced counter cannot silently grant capacity.
Synthetic accounting fixtures exercise count/byte boundaries; they are not large binary or real-tenant load tests.

Keep the normal database/volume and existing master-key backup process. Actual encrypted backup/restore and a
SQLite Store restart preserve the synthetic original, source hash and provenance. No production migration,
deployment setting, storage ceiling or global retention policy was changed during this work.

Removal requires fresh owner authority and confirmation of the selected original hash. It removes the current
encrypted library bytes/source metadata and records an audit event. Provider uploads, historical receipts,
already frozen reviews and existing backups follow their existing lifecycles. Existing saved-plan references
are not rewritten: select the library ID for new work or explicitly amend an eligible unsent step under the
normal plan/review controls. Metadata alone cannot resurrect an expired temporary source.

Existing creative receipts can show their matching retained original after temporary expiry through the exact
source association. Removing that original makes the source unavailable while preserving historical receipts.
This association is not provider availability, external usage discovery or historical creative attribution.

## Reproduced fixes and qualification

F-174: a stale identified owner's actor carried `membershipRole:"owner"` after current membership changed to
administrator. Owner-only access now checks the current active owner membership rather than trusting that stale
fast path. Local administrator behavior without an identified owner user retains the existing contract. The
synthetic red test failed before the fix; no live misuse is claimed.

F-175: a long recent-source filename widened the actual mobile document to **419/375 px**. Scoped button/name
wrapping restores **375/375 px**. New exact-hash dialog copy also wraps inside its **279/279 px** content width.
F-176: a connected Cancel button in a closed dialog prevented the common helper from restoring control focus.
The red regression failed before the fix; the actual Arabic keyboard cancellation now returns to the file button.

The final focused suite passes **103 tests / 99 passed / zero failed / four local FFmpeg skips; 2.05 seconds**.
The earlier root full suite passes **3,756 tests / 3,751 passed / zero failed / five local FFmpeg skips;
95.77 seconds**. Three later UI regressions and final refinements are covered by sanitized full qualification.
Initial storage tests failed for the missing feature; the receipt association failed until its library lookup was
added. Two incomplete synthetic authority/delay fixtures were corrected without weakening an assertion.

Actual real-SDK HTTP MCP and website HTTP tests cover action discovery, exact consent, CSRF/Origin, token/member
revocation, reviewer isolation and zero provider egress. Other tests cover authenticated ciphertext isolation,
strict quota accounting, current pause/authority during copying, rollback, corruption, removal, original TTL,
receipt associations, restart and encrypted backup/restore. Test-only network transports refuse native requests.

Actual local browser observations cover English and Arabic desktop **1280 × 900** and mobile **390 × 844**,
exact synthetic filename/hash/ID, retention, idempotent selection, language refresh, keyboard focus wrapping,
keyboard disclosure and safe cancellation. Both languages fit **375/375 px** on mobile. Arabic removal disclosure
was opened and cancelled; no permanent removal occurred through the browser. HTTP unit fixtures separately
exercise deletion. Screenshots and structured evidence are local under `.runtime/retained-originals-20261003/`.
The browser fixture intentionally reports media inspection unavailable; it does not certify FFmpeg or provider
acceptance. Independent assistive technology, full Arabic editorial review and deployed/live acceptance remain
separate. Web checks pass **33 scripts / 2,915 selected Arabic messages / 3,051 catalog entries**.

Batch 111's exact committed `2a11b9647ee5e63247da30a0e8dd175ec2fc35ba` passed all five sanitized stages:
**3,734 tests / 3,729 passed / zero failed / five local FFmpeg skips; 90.84 seconds**, four capture checks,
**1,579 public sources plus one generated empty sample**, hash
`08240e538d7a240b8a638c8f8146d0936339a1a40427eac03c96f309425f41a2`. Parity with HEAD was verified before/after
qualification and the sole push was to `Work-here`. [CI166](https://github.com/magdyezy1/CAMCP/actions/runs/37098876458),
job `111134296051`, passed **3,734 tests without failures or skips** on host and Docker, four capture checks,
Railway and synthetic read/write container smoke. Host/container suites took **948.20/948.55 seconds**. Decoded
logs were inspected; no downloaded-artifact inspection is claimed. The new revision requires its own CI result.

The matrix remains **13 implemented / 14 partial / one open**. B10 gains owner-selected permanent original
storage; usage outside retained plans remains. B16/B24 gain bilingual browser/keyboard and HTTP/SDK evidence;
B23's real load/multi-worker acceptance remains. Native classification stays **3,247 actions / 167 families /
1,712 reads / 800 reviewed writes / 502 blocked writes**. Sanitized release results follow after completion.


Sanitized preflight `.release/retained-originals-preflight-20261003` passed install/build/report/check/Railway: **3,759 tests / 3,754 passed / zero failed / five local FFmpeg skips; 94.26 seconds**, four capture checks, 33 scripts, 2,915 selected Arabic messages and 278 documents. **1,583 public sources plus one generated empty sample** have hash `5f0cea4d7a3e626d53af63b81011bdef155e47e69e0e139172062c837896f55a`. Exact committed-source qualification follows before the sole Work-here push.
