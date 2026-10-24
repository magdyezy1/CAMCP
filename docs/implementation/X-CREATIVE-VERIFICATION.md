---
status: record
tier: engineering
---

# X creative implementation: verification evidence

Baseline: 51c08b162f09625ccc74aeee41d84aef231364a2 on Codex-branch. See [scope, findings and decisions](X-CREATIVE-REVIEW.md). Windows Node 24.19.0 / npm 11.17.0 / TypeScript 7.0.2. No live advertising requests, credential/permission changes or deployments.

## Current source check

Command from the implementation checkout:

    node .implementation/run.mjs x-creative-full-check npm run check

Started 2026-09-14 00:23:35 UTC; exit 0, 131.733 seconds. The wrapper strips inherited application environment, uses a disposable test temp directory and rejects unmocked external fetch.

- 520 built-in Node tests: 519 passed, zero failed, one skipped because local FFmpeg is unavailable.
- Four catalog-capture tests: all passed.
- generate:check and generate:vendor:check passed.
- report passed: 13 reviewed-write gateways, 177 refusal codes across 37 reachable modules; no missing guidance codes.
- All ten shipped browser scripts passed syntax validation.
- providers:check passed for fourteen stored public-schema captures. This is local integrity verification, not a live provider compatibility check.
- No test-count reduction relative to the 497-test baseline: 23 additional tests.
- Existing account/connection, OAuth, reporting, CSV/Sheets, scheduling, media memory/leases, recovery and worker regression checks remain in the suite. No new website interaction test is claimed for the creative workflow.

Raw local log: .implementation/1789345415005-x-creative-full-check.log. The durable local checks.jsonl records exact commands, timestamps and exits. First-party public summaries contain no credentials or account exports.

## Focused checks and initial failures

| Check | Initial/current evidence |
|---|---|
| X build | First build failed TypeScript control-flow narrowing around a never-returning arrow helper. Changed to a function declaration; build passed. Logs 1789343510005-x-creative-build and 1789343534212-x-creative-build retain both outcomes. |
| Initial focused six-file run | 105 tests, 103 pass, two fail. Fixtures expected a later numeric-ID error instead of the existing UNSAFE_NUMERIC_ID guard, and stored a spending policy under an unhashed key. Corrected fixtures to use the real public policy API and exact earlier refusal. |
| Focused retry | 105 tests, 104 pass, one fail. A special upload alias is deliberately intercepted by the media workflow and requires a source, producing MEDIA_SOURCE_REQUIRED before write-contract validation. Corrected the fixture expectation and preserved the no-egress assertion. Log 1789344065848-x-creative-focused-2. |
| X/media/policy focused run | 98 tests passed, zero skipped, log 1789344539418-x-creative-focused-4. Includes destructive override, changed usage, partial/unknown envelopes, concurrent claims, restart replay, lost response and media-library readiness. |
| Cross-platform fixture build | Initially failed on a fixture object inference and wrong NativeStep property name. Corrected JsonObject typing and used the actual input field; source build and tests passed. No production assertion was weakened. |
| Cross-platform refinements | Initial flat TikTok fixture was insufficiently representative. Official SDK review showed nested creatives; replaced the fixture and fixed the actual serving-status and read-back contracts. Final source suite includes that realistic negative case. |
| X durable chain | 17 X tests passed, zero skipped. Log 1789345059095-x-durable-focused. Explicit amcp_campaign preflight and execution resolve media/card/Tweet references only after predecessor verification. |
| Guide examples | Five guide/contract tests passed, log 1789345394107-x-guide-check. New X routes, nested TikTok creation and LinkedIn intendedStatus inspect without credentials or egress. |

Focused test invocations were:

    node --test --test-concurrency=1 dist/tests/x-creative-writes.test.js dist/tests/x-targeting-writes.test.js dist/tests/write-review.test.js dist/tests/media-upload.test.js dist/tests/write-platforms.test.js dist/tests/spend-policy.test.js
    node --test --test-concurrency=1 dist/tests/creative-chain-audit.test.js dist/tests/media-creative-chain.test.js dist/tests/workflows.test.js
    node --test --test-concurrency=1 dist/tests/x-creative-writes.test.js
    node --test --test-concurrency=1 dist/tests/guidance.test.js tests/guide-contract-examples.test.mjs

All were invoked through the environment-isolating wrapper with npm run build first. An early finder probe that merely asserted today's JSON array serialization was removed from the regression suite; a known gap should not become a test preventing its future correction. Its observed behavior and the needed protocol tests remain in the review report.

## External evidence and blockers

- WhatHead tool help and six X DESCRIBE_ACTION calls succeeded, metadata only, no account ID or provider request. See [recorded observations](x-reference-metadata.json). These confirm route names/methods, not working payloads or safety.
- Public X/LinkedIn/TikTok/Google/Snap documentation was checked; exact links and versions are in the review. Meta optional-field deprecation pages could not be fetched, so those claims remain unresolved.
- GitHub connector reads returned 404 for this private repository. Authenticated host Git could read the requested branch; the existing browser session also opened the branch without entering or collecting credentials.
- Local FFmpeg and Docker are unavailable. The repository's existing Linux CI installs FFmpeg, requires its media test, runs the assembled release check and performs read-only/write-enabled container smoke tests. Its result must be tied to the pushed SHA rather than borrowed from the baseline run.
- No live create, destructive-edit reproduction, cross-connector media reuse, current API grant, provider approval, production deployment or ad delivery evidence was collected. These acceptance criteria remain unverified.

## Assembled candidate and final branch

Fresh candidate command:

    node tools/prepare-public-release.mjs .release/x-creative-20260914-0032

The assembler copied 375 allowlisted files and validated their hashes. Source tree hash: b35585f7e8f4bf1f6e8d0d2a7feaa212714426c1827054c2c3478c52c0bc086b. The candidate is inside the independent Codex-branch checkout, not the parent's historical .release/AMCP directory.

From that fresh directory, through the same environment-isolating wrapper:

    npm ci --offline --ignore-scripts --no-audit --no-fund --userconfig=.implementation/empty-user.npmrc --globalconfig=.implementation/empty-global.npmrc
    npm ci --ignore-scripts --no-audit --no-fund --userconfig=.implementation/empty-user.npmrc --globalconfig=.implementation/empty-global.npmrc
    npm run check
    node deploy/check-railway.mjs

The first offline install failed with ENOTCACHED for zod-to-json-schema and a Windows cleanup warning; this was a new empty cache, not an application test failure. The normal-registry retry installed all 107 locked packages in 4.652 seconds with install scripts disabled and empty user/global npm configurations. No dependency or lockfile changed.

The independent candidate check started 2026-09-14 00:34:44.789 UTC and passed in 142.240 seconds: 520 tests, 519 passes, zero failures, one unavailable-FFmpeg skip; all four capture tests and generation, report, ten browser-script and fourteen stored-provider-integrity checks passed. The deployment configuration check passed without contacting Railway. Candidate log: .release/x-creative-20260914-0032/.implementation/1789346084789-x-candidate-full-check.log. Original install failure and retry logs remain alongside it.

After this check, only the progress and verification Markdown received result updates. Runtime source, tests, guidance, schemas, dependencies and deployment files remain identical to the tested candidate. GitHub's existing workflow assembles again from the pushed commit and records the exact final manifest, full required-FFmpeg check and both container smoke logs in its release-evidence artifact. Use that commit's AMCP checks result for Linux/container evidence; this local check does not establish it.

Immediately before commit, authenticated remote verification still returned baseline 51c08b162f09625ccc74aeee41d84aef231364a2 for Codex-branch and 067871481d79fc59a6cb976d8a13b62d409e283a for main. The sandboxed Git read had exited 1 without output; the authorized host read succeeded. The push is restricted to HEAD:refs/heads/Codex-branch, with no force update, merge into main or deployment.
