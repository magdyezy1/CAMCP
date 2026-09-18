# Audit recommendations implementation

Current contract-expansion pass: [ALL-ACTIONS-2026-09-18.md](ALL-ACTIONS-2026-09-18.md).
Its complete local-action and pinned-vendor-method ledgers supersede action-count assumptions
in historical checkpoints below. The broad request to execute every provider action remains
incomplete; blocked and unmapped contracts are explicitly retained in that pass's backlog.

Only the Git branch `Codex-branch` is authorized. Base: `067871481d79fc59a6cb976d8a13b62d409e283a`. Development and the old release checkout stay untouched. This branch incorporates the sanitized audited development candidate before corrections so new account/security/provider capabilities are preserved. No provider mutation, production deployment or credential change is part of this work.

Status values: pending, implementing, locally verified, external qualification required. A local implementation is not a live-provider qualification. Every recommendation is tracked below; no unfinished item may silently be declared complete.

Historical T01–T20 and M01–M12 checkpoint: the application candidate passed 486 tests with one local FFmpeg skip, plus all four capture tests. This is not the result or completeness claim for the later all-actions request. The chronological checkpoints below retain initial failures and subsequent corrections. Exact commands, candidate hash and browser boundaries are in [VERIFICATION.md](VERIFICATION.md); external qualification is in [OPERATIONS.md](OPERATIONS.md).

## Defects and engineering tickets

| Tickets / findings | Implementation and acceptance | Status |
|---|---|---|
| T01 / F15 | Dependency-complete sanitized assembly, clean artifact build and release CI | locally verified; release evidence below |
| T02 / F05 | Actual smoke contract, authenticated write-mode diagnostics | locally verified |
| T03 / F01 | Commit pending social registration without granting a session | locally verified |
| T04–T05 / F02 | Versioned revocable job authority, legacy job migration/resumption | locally verified |
| T06 / F03 | Administrator connector-revocation guard | locally verified |
| T07 / F04 | Post-await actor/account authorization | locally verified |
| T08 / F09 | Official Apple v1 report decoding and output reconciliation | locally verified |
| T09 / F10 | GA4 source quality and restricted metric handling | locally verified |
| T10 / F16 | Preserve selected-source status through UI/CSV/Sheets and schedules | locally verified |
| T11 / F11 | Identity-based unordered resource snapshot comparison | locally verified |
| T12 / F07 | Account/route-specific Google reauthorization | locally verified |
| T13 / F06/F08 | Reddit permanent authorization and advertiser discovery | locally verified |
| T14 / F06 | DV360 scoped advertiser discovery | locally verified |
| T15 / F13 | Compose DV360 parent/status filter | locally verified |
| T16 / F14 | Canonical public privacy and history navigation | locally verified; release evidence below |
| T17 / F12 | Executable guide examples, generated capability/limit references | locally verified; release evidence below |
| T18 | Guided forms for all three existing campaign recipes and retained drafts | locally verified; release evidence below |
| T19 | Provider-owned version/fixture/readiness records and drift checks | locally verified; release evidence below |
| T20 | Worker/recovery/restore fault tests and authenticated diagnostics | locally verified; release evidence below |

## Broader product/methodology acceptance

| Recommendation | Additional deliverables beyond defect fixes | Status |
|---|---|---|
| M01 | One authority contract, authorized job reassignment and resumption | locally verified; release evidence below |
| M02 | Versioned executable descriptors and evidence-scoped readiness, all offered families accounted for | locally verified; release evidence below |
| M03 | Meta/Google/Microsoft recipe UI, reusable context, input provenance and round-trip checks | locally verified; release evidence below |
| M04 | Versioned source semantics/formulas/snapshots, compatible aggregation and every-output reconciliation | locally verified; release evidence below |
| M05 | Explicit lag, conflicting evidence, seasonal/business annotations, conservative explainable recommendations | locally verified; release evidence below |
| M06 | Typed phase journal, safe next actions, crash checkpoints and provider resumability boundaries | locally verified; release evidence below |
| M07 | Byte admission before media inspection/preparation, bounded encrypted staging, cancellation/cleanup and RSS verification | locally verified; release evidence below |
| M08 | Provider versions/owners/qualification records, public drift/deprecation checks | locally verified; release evidence below |
| M09 | Test exact shippable artifact, provenance, private-file exclusions, immutable release evidence | locally verified; release evidence below |
| M10 | Worker/queue/provider metrics, bounded pacing maps, clock/lease/capacity tests, redacted support/restore runbook | locally verified; release evidence below |
| M11 | Task-oriented executable guidance, schema checks and injection fixtures | locally verified; release evidence below |
| M12 | Clear readiness/reconnect states, current reports list, keyboard/focus/mobile checks and canonical policy | locally verified; release evidence below |

## Remaining audit hypotheses

H1 provider HTTP-200 errors; H2 genuinely ordered scalar arrays; H3 media RSS; H4 Apple one-day campaign granularity; H5 Google recipe operation limits; H6 clock/pacing/worker fairness. Resolve locally wherever possible; preserve explicit unresolved external-contract evidence rather than inventing an answer.

## Verification and continuation

Initial branch verification succeeded. Windows Git schannel failed before remote access; OpenSSL with normal certificate verification succeeded. Remote target equals the audited older release. A clean `npm ci --ignore-scripts --no-audit --no-fund` installed dependencies in this independent checkout. Existing audit artifacts remain the baseline; new tests must assert corrected behavior.

Next: identity/job/review corrections, reporting contracts, provider setup, release gates, all methodology/UI/media/operations improvements, focused and whole-release tests, final branch-only diff review and push. External account grants, business targets, provider approvals and deployment behavior will be reported as unverified unless independently authorized evidence is available.

### Checkpoint: source corrections and contract gates

Focused suites pass: account authority (25), report quality/reconciliation (13), discovery and review projection (36), guide examples (3), public drift fixture (1). The first whole suite had 468 tests: 445 passed, 22 failed, 1 ffmpeg skip. All 22 failures came from an invented target_labels fixture that assumed unknown arrays were unordered. The positive fixtures now vary telemetry; ordered configuration retains negative tests. The focused write suite then passed. Original failures remain in .implementation logs.

Release assembler now creates an immutable allowlisted tree with per-file hashes, excludes private/runtime material, supplies empty historical account samples, and includes guidance-coverage. First candidate has 354 files; its independent dependency install and complete check are running. Generated catalog/vendor checks and all 8 existing browser script syntax checks passed. npm report initially flagged the new JOB_REAUTHORIZATION_REQUIRED guidance gap; it is now documented and the report passes.

H2 resolved with an explicit set-field list and unknown/ordered-array conflicts. H5 reproduced: the maximum Google recipe emitted 30 operations for a 25-operation contract; now split into two reviewed targeting steps (25 + 5) with no lost inputs. H1, H3, H4, H6 remain to close.

Still required: complete guided recipe UI and profile/input provenance; report quality/context UI and compact export metadata; recovery journal; media byte admission/RSS; worker observability/fairness/clock tests; backup restore exercise; public drift CI/runbook; documentation and browser QA; final fresh artifact/container checks where available; commit and push only Codex-branch. No commit or push yet.

### Checkpoint: product, media and operations implementation

All T01–T20 and M01–M12 now have implementations or explicit external qualification boundaries in OPERATIONS.md. Three guided recipes saved paused plans through real browser forms; invalid budget input remained visible with a correction message. Google recipe defaults carry field provenance and account currency is checked before mutation. Added Page suggestions, targeting lookup, current campaign/report history and a visible prerequisite action.

The first assembled artifact passed 473 tests (472 passed, one local FFmpeg skip). The later 482-test suite had 479 passed, two missing-helper errors in isolated browser test harnesses and one FFmpeg skip. Those harnesses now load the same report-quality script as the website; focused 16-test verification passed. Initial failures remain in local implementation logs; assertions were not weakened.

M06: transactional phase journals; encrypted expiring Google upload session; explicit same-review resume only before finalization, authoritative offset query, grants and frozen-byte checks. Restart success and lost-finalization tests pass; new-key retries remain refused. M07: shared 6x-file-size byte admission before inspection/preparation/upload, streamed 4 MiB encrypted staging, incremental bounded reconstruction, expiry/cancel cleanup. Local 128 MiB test observed 223 MiB additional RSS below its 768 MiB conservative reservation. No real FFmpeg/upload peak or production capacity claim. M10: fair tenant dispatch, heartbeat/queue age, scoped provider counters, redacted owner support bundle, map bounds/pruning, backward-clock protection, stale lease fencing and measured disposable restore duration. Six focused operation/fault tests passed.

M08/M09/M11: provider-owned descriptors for 19 families, executable guidance examples, manually dispatched public-schema drift CI, source/manifest assembly and whole-artifact CI. Guidance check passes with 172 refusal codes accounted for across 36 modules; all 10 browser scripts parse. The local check of 14 public-schema captures passes; no live provider calls were made.

H1 provider error/partial/unknown envelopes have existing negative regression coverage; live envelope changes remain provider qualification. H2 and H5 are corrected. H3 measured above; H6 clock/fairness/lease tests pass. H4: overview now requests aggregate Apple totalMetrics without unnecessary DAILY granularity; the documented adgroup single-day restriction is not generalized to every campaign route. Live one-day campaign reconciliation remains explicit.

Browser: canonical Privacy direct/footer/back/forward; all three recipes; retained invalid input; saved report row (USD100, 20 clicks, 4 conversions); escaped script-like provider names; CSV/evidence navigation; Sheets/schedule dialog and partial delivery selector; 390x844 and 1440x1000 widths without page horizontal overflow; Escape restores focus. An initially malformed synthetic report fixture (object instead of summary array, queued job with complete report) was corrected; these were fixture errors, not product defects. Final refreshed candidate, branch-only commit/push and CI results remain to record.

### Final recovery and candidate checkpoint

The 365-file fresh candidate (source tree hash 3d53011a1c334db8affaa84cc210415fb8b41520aba0fab60cc582a84f8adfa0) passed 484 tests: 483 passed, one local FFmpeg skip, no failures; four capture tests, generation/vendor/report and all ten browser script checks passed.

A subsequent recovery delta adds campaign reconcile_step against a completed original receipt plus fresh readiness/read-back, and an owned/scoped unfinished-upload list and website recovery controls. Five focused tests passed, including restart/resume, lost finalization, missing/uncertain receipt refusal, dependency gating, owner/workspace isolation and current authority. Browser verification found the uncertain image and focused its recovery view; no upload retry was offered and no JavaScript errors occurred. These additions receive a fresh artifact check before the branch push.

No production deployment, live ad calls, provider applications, credential changes or mutations on other branches were made. External qualification and operational decisions remain enumerated in OPERATIONS.md; they are not labeled as completed by synthetic tests.

### Follow-up: enable test-account platform connections

The test-account allow-list now includes browser OAuth start/callback/progress and the existing connection manager's read, asset selection, sync, reauthorization, default, write-grant and disconnect routes. Shared-password and individually invited reviewers can connect their own logins in their test workspace. Session, role, tenant, CSRF, OAuth state, account grant and deployment write checks remain in their existing handlers. Campaign/media execution, MCP connector access, owner administration and shared account-security changes remain excluded. Server-owned Apple credentials remain in the deployment owner workspace.

The shared sign-in copy explains that reviewers using the same password share that test workspace's connections; invited test accounts have individual workspaces. Added ten focused synthetic connection tests plus invited-user authorization coverage. All 51 focused checks pass; the full local check passes with 497 tests (496 passes, one unavailable-FFmpeg skip) and the four capture tests. Initial fixture/type failures and exact verification commands are recorded in VERIFICATION.md. Only `Codex-branch` receives this follow-up; real consent and deployment are external verification steps.

### Follow-up: X creative chain and cross-platform contract review

Starting from 51c08b162f09625ccc74aeee41d84aef231364a2, added qualified X card, library and nullcast Tweet writes; exact media identity/readiness; JSON card transport; activation-aware promotion; bounded per-line-item creative usage checks; frozen destructive-edit acknowledgement and recovery plans; and read-only verification that tolerates promotion visibility lag. The full Drive-video-to-promoted-Tweet journey also runs through the durable campaign runner with verified resource references.

The supplied brief was checked against current official documentation. Narrow additional fixes cover TikTok's nested creative serving status and LinkedIn's intendedStatus, with five-platform synthetic media/creative/ad/read-back evidence. Larger LinkedIn post/organization and finder contracts, TikTok identity/Smart+ support, and live access/delivery qualification remain explicitly scoped follow-up work. No provider permission change or live advertising request was made.

The full source check passed 520 tests (519 passes, one unavailable-FFmpeg skip), four capture tests and all generation, guidance, browser-script and stored-provider-integrity gates. Fresh assembly, final branch and CI evidence are maintained in [X-CREATIVE-VERIFICATION.md](X-CREATIVE-VERIFICATION.md); findings, the prompt decision register, capability table and engineering acceptance criteria are in [X-CREATIVE-REVIEW.md](X-CREATIVE-REVIEW.md). Only Codex-branch receives this follow-up.
