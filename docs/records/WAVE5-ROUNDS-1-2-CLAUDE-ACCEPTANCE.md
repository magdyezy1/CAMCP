---
status: record
tier: engineering
---

# Wave 5 rounds 1 and 2: audit and acceptance

The audit and acceptance record of the owner's mandate of 2026-11-05: Codex's rounds 1 and 2 (to `cfdbf507`), the independent target they were measured against, and the remediation made on top of them, in packages by Sonnet 5.5 agents under the principal engineer's review, up to the integration head `7e409d1d` (`claude/v2-integration`; the push follows this record (section 20)). It says what is implemented, tested, committed and merged. Nothing is deployed and no live check has run: staging does not exist (V2 plan D20), so the live line of every ticket is blocked.

Written by Claude Opus 5.5, AMCP's principal engineer, from 2026-11-05. The evidence sections (4 to 10, 12 to 14 and 16 to 21) were refreshed by a Sonnet 5.5 records agent from the sources each one names; the agent states facts and leaves every verdict to the principal engineer, whose sections are 22 and 23 (the final acceptance and the readiness for Round 3). Every number is copied from the source named beside it, and data that is not available says MISSING. Evidence that lives outside the repository (reports, registers, gate results and logs under `.runtime/`) is named by its path from the repository root and is local, not in the repository.

Terms: **R1** and **R2** are rounds 1 and 2; **V2 plan Dnn** is an owner decision from section 12 of the approved V2 plan (`docs/DECISIONS.md` numbers other decisions the same way, so the plan's decisions are always cited with the prefix); **S1** to **S4** are severities (S1 blocks acceptance, S4 is a record). A SHA is the first eight characters of a commit id of this repository's history; the exceptions are named where they occur (`dc41950e`, the Codex evidence commit, is not in the integration's history, and `8eb1af93` in section 9 is a blob id). Commits that exist only locally are marked as such.

States are kept apart throughout: **implemented** (code exists), **tested** (a test that failed without it passes), **committed**, **merged** (on `claude/v2-integration`), **pushed** (on `origin/Work-here-V2`), **deployed** (served by amcp.shop) and **live-verified** (checked against a real provider account through V2 code).

## Contents

1. Independent target architecture
2. Original baseline assessment
3. Exact Codex handoff state
4. Implementation inventory (state at the final integration head 7e409d1d)
5. Code audit findings
6. Plan-compliance matrix
7. Architectural defects (state at the final integration head 7e409d1d)
8. Security findings
9. Functional defects (state at the final integration head 7e409d1d)
10. Compatibility findings (state at the final integration head 7e409d1d)
11. Keep, rework or rebuild
12. Remediation changes
13. Remaining round 2 implementation
14. Sonnet contributions
15. Opus architectural decisions
16. Test and quality-gate evidence
17. MCP and provider qualification
18. Cross-system integration evidence
19. Git history and merge verification
20. Push status
21. Remaining risks or blockers
22. Final Round 1–2 acceptance
23. Readiness for Round 3
24. Addendum (2026-11-15): the Linux build of `b90e9fcb`, its fix and the go-live decision
25. Addendum (2026-11-16): the live qualification on production, and the label decided again

## 1. Independent target architecture

The target is `docs/records/WAVE5-INDEPENDENT-TARGET.md` (on the integration branch as b7d56c89, indexed by a3f677b5).
It was written from the approved plan, the owner's decisions in sections 12 and 12.1, the `Work-here` baseline at
4035ad7c and the public provider documentation, before any Wave 5 diff or handoff file was read.

Timing, checked against the session transcript rather than asserted: the record was written at 2026-11-05 21:09:12 UTC
and committed at 21:09:18 UTC as 97865657 on the local branch `claude/v2-target-record`. The first tool call in the
session that names `Codex changes.md` came at 21:09:24 UTC, and the first read of its content at 21:09:28 UTC. No
earlier call names it. 97865657 stays local, because its parent is the Codex evidence commit dc41950e (section 19).

What the target fixed in advance, so that the audit measured the code against it and not against the code's own
explanation:

- one rule table for levels, options and defaults, read by validation, bootstrap and the MCP input schema;
- sources expanded into source-by-level units inside one budget, resumable without doubled rows or requests;
- row assembly, objective resolution, result selection and coverage as pure modules outside `work()`;
- stored forms that read v3 and write v4 while `Work-here` can still read them after a rollback (V2 plan D21);
- lineage stored once, a three-level TikTok `get` under a third of the baseline's bytes;
- objective precedence `user_override` > `provider` > `provider_mapped` > `user_fallback` > `unknown`, and results from
  the platform's own number where it exists (Meta `results`, TikTok `result`);
- SDK v2 as a package of its own, typed config and outputs, tasks only where declared, truthful annotations, bounded
  responses with caller-bound continuations, D17 byte-identical;
- one chart specification with three renderers sharing the arithmetic, and output encoding as a security requirement;
- a framework-free website whose shell survives route changes, with the logo kept exact;
- the security controls (tenant and client boundaries, cursors, redaction, encoding, error detail, limits, audit), the
  error-handling rules, the provider semantics per platform, the required tests, and 22 audit probes.

Its decision rule (section 13 of the target) is the one applied in section 11 below.

## 2. Original baseline assessment

The baseline is `Work-here` at 4035ad7c (wave 4c), the code amcp.shop served throughout this work (section 20).
Section 2 of the target record holds the assessment made before the audit: strengths to keep (the reviewed-write
model, the collection engine's budget and checkpoints, the provider registries and seam rule, honest unknowns, the
website's foundations, the gates) and the weaknesses that drive the redesign (a 1,836-line reporting module, one level
per platform, the objective resolved in three places with the user's choice beating the platform, all-or-nothing
summaries, lineage copied into every row, rules a client must know living only in code, opaque MCP schemas, native
gateways that declare `readOnlyHint:false`, hand-rolled 2026-07-28 framing on SDK v1, and a shell with 14 breakpoints).

The audit confirmed two baseline defects that matter for the owner's decisions:

- **Unauthenticated crash (L4).** On the baseline's dependency tree one unauthenticated gzip request to `/register`
  stops the server process. V2 fixes it (f32c79b1). Production keeps this exposure until V2 is deployed.
- **Attribution windows (F-LEAD-02, found by the lead's live Meta read on 2026-11-07).** When a report asks Meta for
  explicit attribution windows, `actions[].value` is the ad set's own setting and the requested window's count is under
  the key named for it. The baseline reads `.value`, so such a report shows the default-window number under a label
  naming the requested window. It does not show when the requested windows match the ad set's setting, which is the
  usual case. V2 fixes it for v4 reports; v3 reports keep the baseline behaviour (section 21).

## 3. Exact Codex handoff state

Codex (GPT-6.1, "Sol Max") implemented R1 and R2 serially, without subagents, until the owner ended the assignment at
R2 Task 12. Its commits are authored `Claude <noreply@anthropic.com>` with `Co-Authored-By: Codex (GPT-6)` in the
message. The handoff header of `wave5-plans/round-2.md` (written by Codex) states the boundary: "Application coding
stopped at cfdbf507", and Task 13 onward, the closing tasks 21 to 24 and Round 3 were not started.

| Item | State at handoff, checked in Git |
| --- | --- |
| `origin/Work-here` | 4035ad7c, the protected baseline, untouched by Wave 5 |
| `origin/Work-here-V2` | bdda0cbd: R1, 44 commits from 4035ad7c, pushed by Codex |
| `codex/v2-round2` (local) | dc41950e: 21 R2 commits, unpushed. The last application commit is cfdbf507 (Task 12, X line-item and promoted-tweet reporting). dc41950e adds only `Codex changes.md` and `codex-changes-evidence/`. |
| Working tree | Clean; the only untracked file was the owner's protected prompt, which was never read |
| Production | `GET https://amcp.shop/versionz` on 2026-11-05: digest fa3bfeba…82dc, 2,160 files, 61,376,054 bytes: wave 4c, not V2 |
| Codex's own last gate | 8,451/8,451 tests in 939 files (a related subset, not the full suite); 16 focused browser cases |

What Codex reported as not done, and what the audit found it had left: Apple paging (Task 13); charts (V2-EXP-01); the
typed reporting contract, progress and tasks (V2-MCP-02); the truthful smaller surface (V2-MCP-06); components
(V2-WEB-02); the shell (V2-WEB-03); the closing gates; every live check; Meta's `results` shape unverified. Codex's
change accounting reconciled exactly with Git: 336 paths (96 added, 240 modified including one withheld private-mixed
report, 0 deleted) over 64 commits. Codex had also dropped the full-profile qualification stages (mutants, wire sweep,
Meta pin, journey evaluation, provider drift) from its gates (F-L10-04), and its last full browser run was at
3b950b2d, before its own R2 commits (F-L10-03).

The evidence commit dc41950e cannot be published: the package it adds is private to the owner, and this record says only
that the package exists (F-L10-01). Integration therefore starts from cfdbf507, and a pre-push guard in the lead's scan
refuses any range or tree that contains dc41950e, `Codex changes.md` or `codex-changes-evidence/` (tested: the Codex
branch is refused, cfdbf507 and the integration branch pass).

## 4. Implementation inventory (state at the final integration head 7e409d1d)

Who built each requirement, and who corrected or completed it. Codex's work: round 1 is 44 commits, 4035ad7c..bdda0cbd (on Work-here-V2); round 2 is 20 application commits, bdda0cbd..cfdbf507, plus the evidence checkpoint dc41950e, which is kept off pushed branches (F-L10-01). Everything after cfdbf507 was built under the lead's review (section 14). "Merged" means in the final integration head 7e409d1d.

| Requirement | Round | Codex built | Corrected or completed by (packages) | State at the final head |
| --- | --- | --- | --- | --- |
| V2-RPT-01 TikTok collection | 1 | yes | tiktok | merged |
| V2-RPT-02 Objective precedence | 1 | yes | objectives, levels (X) | merged |
| V2-RPT-04 LinkedIn levels and numbers | 1 | yes | objectives; linkedin-windows; final-fixes (P2C-02) | merged (windows: Merge E; P2C-02: Merge G) |
| V2-RPT-05 Errors | 1 | yes | tiktok, web-report; the redaction packages sec-hardening, sec-followup, sec-followup-2, final-fixes | merged (P2C-01: Merge G) |
| V2-PRV-01 Selection and paging | 1 | yes | previews | merged |
| V2-PRV-02 LinkedIn previews | 1 | yes | previews | merged |
| V2-PRV-03 Snapchat links | 1 | yes | previews | merged |
| V2-MCP-01 Quick wins | 1 | yes | mcp; mcp-typed (F-L3-08's remainder) | merged; F-L3-08's `amcp_workspace` note stays in help (27 bytes of room) |
| V2-WEB-01 Tokens | 1 | yes | previews (Arabic strings), brand (the owner's logo amendment) | merged |
| V2-MCP-13 SDK v2 | 2 | Package A and the advisory follow-up | mcp | merged |
| V2-RPT-03 Results by objective | 2 | Package B (Tasks 6-7) | results; meta-results | merged (Meta: Merge C) |
| V2-RPT-06 Reporting engine V2 | 2 | Package C (Tasks 8-11) | stored, engine-core, engine-surfaces, web-report, closing-fixes; website-get; nf-fixes, jobcontrol | merged (website `get`: Merge D; NF-1 and LD-28: Merge G) |
| V2-RPT-07 More levels | 2 | Task 12 (Snapchat, X); Task 13 not started | levels (Apple paging, Snapchat above 144 campaigns, X objectives) | merged |
| V2-EXP-01 Charts | 2 | not started (Tasks 14-15) | charts | merged (Merge C) |
| V2-MCP-02 Typed reporting contract | 2 | not started (Tasks 16-17) | mcp-typed | merged (Merge C) |
| V2-MCP-06 Truthful and smaller surface | 2 | not started (Task 18) | mcp-surface | merged (Merge D) |
| V2-WEB-02 Components | 2 | not started (Task 19) | web-components | merged |
| V2-WEB-03 Shell and IA | 2 | not started (Task 20) | web-shell | merged (Merge C; closing-small in Merge D) |

## 5. Code audit findings

The audit read the Codex tree at cfdbf507 (its last application commit) against Work-here 4035ad7c in ten read-only lanes. Each lane read every changed file and hunk in its scope, the unchanged callers and tests around them, and the plan text it was checking. Lane reports: `.runtime/wave5-claude/audit/L1.md` to `L10.md`. The register (`acceptance/findings-register.md`, compiled 2026-11-07 and refreshed 2026-11-14 to `7e409d1d`) holds the 153 audit findings and 74 items found since (227 in all).

| Lane | Scope (requirements the findings cite) | S1 | S2 | S3 | S4 | Total |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | TikTok collection and errors (V2-RPT-01, 05) | 0 | 1 | 6 | 5 | 12 |
| L2 | Objectives and LinkedIn (V2-RPT-02, 04) | 0 | 2 | 10 | 3 | 15 |
| L3 | Previews, MCP quick wins, tokens (V2-PRV-01 to 03, V2-MCP-01, V2-WEB-01) | 0 | 1 | 7 | 5 | 13 |
| L4 | SDK v2 migration (V2-MCP-13) | 0 | 2 | 5 | 7 | 14 |
| L5 | Reporting engine and results (V2-RPT-03, 06) | 2 | 13 | 14 | 6 | 35 |
| L6 | Stored definitions, upgrade and rollback (V2-RPT-06, D21, D22) | 1 | 3 | 5 | 3 | 12 |
| L7 | More levels (V2-RPT-07) | 0 | 3 | 10 | 5 | 18 |
| L8 | The website's report experience (V2-RPT-06 on the site, V2-WEB) | 0 | 3 | 6 | 7 | 16 |
| L9 | Security controls of the target (section 6) | 0 | 2 | 0 | 2 | 4 |
| L10 | Process, records, Git and gates | 0 | 2 | 9 | 3 | 14 |
| | All | 3 | 32 | 72 | 46 | 153 |

State on 2026-11-10 before Merge C: 129 fixed (every cited commit reachable from bee1db0e), 9 owned by open packages (`docs`, `mcp-typed`), 12 recorded, 3 blocked. Changes since the register was compiled: F-L4-02 is done (supply chain and the SDK differential review); F-L5-12 is fixed on v4 in `meta-results`, waiting for Merge C; F-L10-01's missing guard now runs in the lead's pre-push scan; the attribution-window clause of F-L2-15 became the package `linkedin-windows`. The register named two orphans, both now homed: F-L10-01's guard (above) and the second half of F-L2-13 (`docs`).

State at `7e409d1d` (the register refreshed 2026-11-14; its "Counts" tables): of the 153 audit findings FIXED 139, RECORDED 12, OWNER 2 and OPEN 0 (S1: 3 fixed; S2: 29 fixed, 2 recorded, 1 owner; S3: 67 fixed, 4 recorded, 1 owner; S4: 40 fixed, 6 recorded). The eight rows that were still open on 2026-11-14 morning were all owned by the package `docs` (F-L4-09, F-L4-14, F-L8-10, F-L8-15, F-L10-05, F-L10-09, F-L10-10, F-L10-14) and Merge F fixed them; F-L4-14, F-L8-15, F-L10-05 and F-L10-14 are fixed only in part, and the register's "Partly covered" table says what is left. With the findings added since, the register holds 227 items (the 16 items of the closing security skills, section 8, included): FIXED 186, RECORDED 35, OWNER 6, OPEN 0; nothing is pending. The two clauses that had no owner on 2026-11-07 both have one and are done. Three records the audit asked for are carried here and nowhere else: **F-L10-06**, the approved Round 1 plan was edited by the implementer, including a ticked step that did not run (Round 1 Task 28 step 4): the lead unticked it with a note and kept a dated copy of the plan as it stood before the lead's notes (`round-1.before-lead-notes-2026-11-07.md`, local); the lead's original text of those lines is not recoverable because it was never in Git, so the implementer's other edits stay and the audit's list of them is the record. **F-L8-16**, three of Codex's baseline commits bundle two fixtures and the mutant catalogue was edited inside two feature commits (cosmetic); history is not rewritten. **F-L10-13**, commit-message hygiene in Round 2 (subjects, bodies, trailer form): no history rewrite is asked; the single `Co-Authored-By` trailers of three Sonnet packages are in section 14. F-L4-10 ("tests pass unchanged" is not literally true: client changes moved some assertions) is stated in section 16.

What the audit could not see: live provider behaviour (no staging, V2 plan D20), the eight round 2 tasks Codex never started (Tasks 13 to 20), and browser behaviour beyond the runs on record. Defects found after the audit are in sections 8 and 9.2.

## 6. Plan-compliance matrix

Source: `.runtime/wave5-claude/acceptance/requirements-matrix.md` and `.runtime/wave5-claude/acceptance/findings-register.md`, refreshed 2026-11-14 to `7e409d1d` (local files, not in the repository). One row per requirement of the approved plan's ticket list that Rounds 1 and 2 carried (the plan's section 10.2, "Tickets"). The states are kept apart as on the first page: a row says what is implemented, tested and merged. Nothing is deployed and nothing is live-verified, and every ticket's "Live:" line is blocked: no staging (V2 plan D20); the owner's named test accounts have not been used. "Tested" means the package's tests failed before the fix and pass now (the implementer's red-then-green, the lead's review), and the whole suite passes on the final head `7e409d1d`: 10,451 tests, 10,450 pass, 0 fail and 1 skipped (the history guard of P2C-03, which a candidate without `.git` cannot read), and 4 of 4 capture tests with FFmpeg required (gate2 `claude-r2-merge-g`, 616 s); the full qualification profile passed 10,380 of 10,380 on `e876960e` and 10,454 of 10,455 on `7e409d1d`, with one named skip (section 18). Every package is merged and no row is pending. Finding IDs are those of the register; the tests named are files at `7e409d1d`.

| Requirement | What the plan asked | State | Evidence | Still missing |
| --- | --- | --- | --- | --- |
| V2-RPT-01 TikTok collection | Fixtures for a short last page, an empty first page, mismatched totals, duplicates and missing page fields; requests carry `STATUS_ALL` and `enable_total_metrics`; daily spans within 30 days; "-" parses as unknown; live: campaign and ad group levels on both qualification advertisers | Implemented, tested, merged (tiktok, Merge A `359c000c`) | F-L1-01, 02, 07, 10, 12 fixed; `tests/tiktok-report-completion.test.mjs`, `tests/tiktok-report-spans.test.mjs`, `tests/tiktok-report-totals.test.mjs`; probe 3: 14 of 14 (section 18) | The live line (blocked: no staging, V2 plan D20); TikTok's API v1.3 against v2.0 (owner item, section 21) |
| V2-RPT-02 Objective precedence | Rows carry the campaign's native objective and its source; a fallback never replaces a provider value; an override wins and is labelled; new and edited reports store the fallback and overrides | Implemented, tested, merged (objectives, levels, stored: Merge A; reason codes: Merge B; Meta objectives: Merge C; the two meanings of `objective` documented: docs, Merge F) | F-L2-03, 04, 05, 09, 11, 12, 13 fixed; `tests/report-objectives.test.mjs`, `tests/report-objective-inheritance.test.mjs`, `tests/report-notices.test.mjs` | The live line (TikTok ad rows, LinkedIn creative rows, Meta campaign rows); a live parse of the two Google campaign fields (F-L2-04); the group `objectiveType` pin (recorded, F-L2-15) |
| V2-RPT-04 LinkedIn levels and numbers | Three levels with parents; a group's objective in three steps; mixed groups never summed; a one-time note; zero delivery shown as "platform omitted"; a fake clock at 01:00 Cairo gives a complete window; attribution windows from the account's conversion rules (plan 4.7) | Implemented, tested, merged (objectives, stored: Merge A; linkedin-windows: Merge E `8a3131b3`; final-fixes and jobcontrol: Merge G) | F-L2-01, 02, 06, 07, 08, 10, 14 fixed; LD-03, P2B-08, P2C-02 and LD-28 fixed; `tests/linkedin-levels.test.mjs`, `tests/linkedin-windows.test.mjs`, `tests/linkedin-group-objective.test.mjs`, `tests/linkedin-overview-windows.test.mjs` | The live line (a 7-day report at three levels) and a live read of the account's conversion rules; the window basis of F-L2-01 is an owner item; post-commentary names go to round 3 (V2-PRV-04) |
| V2-RPT-05 Errors that say what happened | A provider-data status and category; recovery actions by category; upstream details kept everywhere; a data error's card shows neither "HTTP 400" nor "Manage connections" | Implemented, tested, merged (tiktok, web-report: Merge A; sec-hardening: Merge C; sec-followup: Merge D; sec-followup-2: Merge E; final-fixes: Merge G) | F-L1-03 to 06, 08, 09, 11, F-L8-01, 13 fixed; DR2-01, DR2-02, P2A-01, 02, P2B-01, 05, P2C-01 fixed; `tests/report-error-categories.test.mjs`, `tests/redaction-prose-and-headers.test.mjs`, `tests/error-detail-redaction.test.mjs` | The owner's confirmation that `INCOMPLETE_REPORT` stays outside the provider-data category (no entry in `docs/DECISIONS.md`); the S4 residuals NF-4 and NF-5 of the post-patch validation (ruling 19: with SE-01, in Round 3) |
| V2-PRV-01 Selection and paging | An ID outside the first 100 is previewed; paused and old ads excluded by default; cursor paging; campaign and ad set filters | Implemented, tested, merged (previews: Merge A; Arabic names: closing-fixes, Merge C; nf-fixes: Merge G) | F-L3-03, 05, 06, 10, 12, F-L9-03 and NF-2 fixed; `tests/ad-previews-selection.test.mjs`, `tests/ad-previews-paging-ui.test.mjs`, `tests/meta-ad-identity-oracle.test.mjs`; browser kind `ad-previews` 16 of 16 in the full browser run (section 18) | The live line (an ad beyond the first 100) |
| V2-PRV-02 LinkedIn previews | `account={sponsoredAccountUrn}` sent and allowed; the contract pinned; the iframe's `src` returned with its 3-hour expiry | Implemented, tested, merged (previews, Merge A) | F-L3-13 fixed; `tests/linkedin-ad-previews-account.test.mjs` | The live line (a LinkedIn creative returns a preview link) |
| V2-PRV-03 Snapchat links | `creative_preview_link` allowed in the preview path only; `expires_at` shown; URL secrets stay redacted everywhere else | Implemented, tested, merged (previews, Merge A) | F-L3-04 fixed; `tests/snapchat-preview-links.test.mjs` | The live line (the link opens without a login) and the capture of the real response shape as a fixture |
| V2-MCP-01 Quick wins | `next_call` after run and export; routing summaries naming roles; schema limits equal code limits; help on every first-party tool; short descriptions; tool-list bytes measured | Implemented (not the `amcp_workspace` limit note), tested, merged (mcp: Merge A; mcp-typed: Merge C; mcp-surface: Merge D) | F-L3-01, 02, 07, 09, F-LEAD-01 fixed, F-L3-08 partly; tool list 94,857 (reader) and 97,253 (operator) bytes of the 97,280 limit; `mcp-eval` 64 runs, 0 regressions on both profiles (section 17) | F-L3-08's `amcp_workspace` note (27 bytes of room); an optional live Claude client check of the root-`anyOf` fix |
| V2-WEB-01 Tokens | Old tokens aliased; contrast checked in both themes; the Arabic font subset to WOFF2; route bytes measured; the logo files are the owner's kit, byte for byte (amendment of 2026-11-07) | Implemented, tested, merged (previews, brand, web-components, web-shell, closing-small) | F-L3-11 recorded; the five logo files match their pins (`tests/brand-mark.test.mjs`; the merge reports' logo proofs); `tests/web-tokens-v2.test.mjs`, `tests/web-arabic-font.test.mjs` | Pages adopting the token sheet beyond the eight static pages, the report builder and the component page; the F-L3-11 follow-up and the Arabic review (round 4) |
| V2-MCP-13 SDK v2 | The v2 packages at the approved versions and nothing on v1; every MCP test and journey passes; today's protocol and 2026-07-28 both work; the help schema of V2 plan D17 byte-identical; container parity and the full gate; supply-chain and differential reviews recorded | Implemented, tested, merged (mcp, Merge A) | F-L4-01, 03 to 06, 08, 11 to 13, DR-01 fixed; F-L4-09 and F-L4-14 fixed by docs (Merge F); supply-chain run: 21 direct and 210 transitive packages, 0 advisories on the manifests of `bee1db0e` (still the manifests of `7e409d1d`); container-layout parity 10,379 of 10,380 with one skip at `e876960e` and 10,453 of 10,455 with two skips at `7e409d1d` (section 18) | Owner ratification of the dependencies beyond the approved list and the exit plan for `@modelcontextprotocol/server-legacy` (F-L4-07, F-L10-02, DR-02, DR-04); the live real-client checks (ACC-02); the third dependency tree of F-L4-14 (not built); NF-3 (S4, ruling 19: recorded for Round 3) |
| V2-RPT-03 Results by objective | Pinned tables tested value by value; a Meta row's result equals insights `results`; a TikTok ad group's result equals its `result` metric; mixed-objective summaries never add different results | Implemented (not Microsoft's value-based results), tested, merged (engine-core; results: Merge B; meta-results: Merge C) | F-L5-02, 12, 13, 17, 21, 29, 32 fixed; F-LEAD-02, LD-02, LD-09 to LD-14 fixed; `tests/meta-results-*.test.mjs`, `tests/report-mixed-results.test.mjs`; the Meta shape pin `docs/records/META-RESULTS-PIN-2026-11-07.md` (section 17) | Microsoft value-based results; the live check that a Meta row's result equals insights `results`; v3 Meta reports under explicit windows stay unchanged (owner decision, LD-23) |
| V2-RPT-06 Reporting engine V2 | Saved hand-chosen objectives become fallbacks with a one-time note (V2 plan D22); stored v3 forms stay readable for a rollback (V2 plan D21); three levels in a snapshot; scope filters; a plain `get` under a third of today's bytes; v3 runs unchanged; totals carry coverage and the cross-level check is shown | Implemented, tested, merged (stored, engine-core, web-report, results, engine-surfaces, closing-fixes, mcp-typed, website-get; nf-fixes and jobcontrol: Merge G) | The 57 audit findings of the ticket and DR2-04, P2B-06, LD-04, LD-05, LD-07, NF-1 and LD-28 fixed; Work-here oracle tests 23 + 9, migration tests 37 + 8 (section 18); the website's `get` for the audit's three-level report: 14.3% of the baseline's bytes; probes 8, 12, 13 | The rollback drill and a real Work-here image (blocked: no staging); the owner's rollback rule (v4-only definitions fail closed); engine-core's own "not done" list (typed `ReportRow`, other bigint formatters) |
| V2-RPT-07 More levels | A fixture per platform and level; bootstrap names every level natively; a live read-only check per reconnected platform; Apple through an owner runbook | Implemented (Apple's campaign report stays off the shared paging helper), tested, merged (levels: Merge A; results: Merge B) | F-L7-01 to 18 fixed (F-L7-12 and F-L7-17 partly); `tests/snapchat-population-scale.test.mjs`, `tests/apple-report-paging.test.mjs`, `tests/x-overview-detail.test.mjs` | Every live read (Snapchat, X, Apple by runbook); unpinned provider facts; F-L7-17's checkpoint half; Apple's campaign report is not on the shared paging helper |
| V2-EXP-01 Charts | Golden SVGs per chart type; a PDF render check by text extraction; the palette validator passes in both themes; every chart has its table and is axe-clean with keyboard tooltips; charts never mix currencies or results | Implemented, tested, merged (charts, Merge C `400258d9`; sec-followup: Merge D; sec-followup-2: Merge E) | 23 golden SVGs in `tests/fixtures/charts/`, `tests/report-chart-golden.test.mjs`, `tests/report-chart-pdf.test.mjs`, `tests/report-chart-palette.test.mjs`, `tests/report-chart-table.test.mjs`; probes 16 and 17: 124 of 124; P2A-05, P2A-07, P2B-02 fixed | A human contrast check of the dark theme's "Other" colour and the light third hue (2.77:1); the HTML and XLSX report layouts (round 3) |
| V2-MCP-02 Typed reporting contract | Config typed from the server tables; bootstrap rules and defaults; filters on `get` and `list`; include flags; typed output schemas; progress notifications; the tasks extension where the client declares it | Implemented, tested, merged (mcp-typed, Merge C `0f634ee3`; sec-followup: Merge D) | F-L5-15 fixed; P2A-03, P2A-04 fixed; `tests/mcp-typed-*.test.mjs`, `tests/mcp-progress.test.mjs`, `tests/mcp-tasks.test.mjs`; probes 14, 18, 19: 64 of 64 (section 18) | Typed output and config cover the common fields only; progress and tasks cover `run_background` and `export` only; NF-7 (S4, ruling 19: recorded for Round 3) |
| V2-MCP-06 Truthful and smaller surface | Native gateways read-only in the annotations; `MEDIA_REVIEW_REQUIRED` with a `next_call`; truncation and continuation on every list path; guide sections under a cap; new defaults opt-in per client (V2 plan D26) | Implemented, tested, merged (mcp-surface, Merge D `ea090d6d`; sec-followup-2: Merge E) | Ruling 12: seven gateways read-only under the v2 profile (a walk of 5,109 calls found no write); probe 15: 26 of 26; probe 18; LD-18, LD-19, DR-01, P2B-03 fixed | The owner's confirmation of V2 plan D26; the Round 3 switch (the profile has no writer in production); P2B-04 and P2B-07 recorded |
| V2-WEB-02 Components | A members-only component page showing every state; zero raw HTML writes; browser cases per component in English and Arabic in both themes | Implemented, tested, merged (web-components, Merge B) | Browser kind `components` 16 of 16 in the full browser run (section 18); DR2-03 and P2A-06 fixed | The stylesheet-loader test's stub matches any selector naming the file (S4); the report builder's route budgets carry no headroom |
| V2-WEB-03 Shell and IA | `check-routes` passes on the new registry; no clipping at 800 px height; a one-row top bar at 320 px; section-level loading; error links follow `parent` | Implemented, tested, merged (web-shell, Merge C; closing-small: Merge D) | Browser kind `shell` 68 of 68 in the full browser run; probes 20 and 21 (section 18); LD-15, LD-20, LD-21 fixed | The items web-shell left and no package took (no avatar menu, a failed page replaces its own heading, Home's first-name greeting for the round 4 visual sign-off, V2 plan D25) |

Rows for the findings that no ticket owns (process, records, security reviews) are in the register; their statuses are in sections 5 and 8 to 10.

## 7. Architectural defects (state at the final integration head 7e409d1d)

Measured against the target (`WAVE5-INDEPENDENT-TARGET.md` sections 3 and 4): one model per concept, provider facts in one table each, the engine owning row assembly, the site and MCP reading the engine's rules rather than restating them, and no hidden ordering.

| ID | Sev | Defect | Fix | State |
| --- | --- | --- | --- | --- |
| F-L5-14 | S2 | Row assembly still lived in the worker's `work()`, not in the engine (target 3.1) | engine-core a5148f5d, f126e8a3 | fixed |
| F-L5-15 | S2 | Level, option and default rules were restated: the MCP schema read nothing from the table and the website restated window lists | website: engine-surfaces 76996256; MCP: `mcp-typed` | fixed (website: Merge B; MCP: Merge C) |
| F-L4-01 | S2 | Hand-written MCP framing stayed beside the SDK's handler with no measured need | mcp 0514d462 | fixed |
| F-L7-06 | S3 | The legacy level lookup was completed by an import-time side effect, so load order decided whether X had levels | levels e8d52a5e | fixed |
| F-L6-04 | S3 | Stamp-notice state was inferred from History rather than stored | stored fe11674f | fixed |
| F-L6-05 | S3 | The listing gate and the payload read different forms of a saved definition | stored 67185200 | fixed |
| F-L6-07 | S3 | Every `queue()` scanned every snapshot of the workspace | stored fe11674f | fixed |
| F-L5-31 | S4 | Coverage had several shapes, none the target's | engine-core 7e2a576f, 5ac6a9f5, e16fc2db | fixed |
| F-L2-14, F-L7-18 | S4 | Rules parsed twice (LinkedIn zero cost) and registry flags repeated in a second list | objectives, levels | fixed |
| (lead) | S2 | The website asked `get` for everything on every load, so the V2-RPT-06 payload model did not reach the site (section 9.2) | package `website-get` | fixed (Merge D) |
| (lead) | S2 | LinkedIn attribution windows lived only in the guided presets, not in the shared report model (section 9.2) | package `linkedin-windows` | fixed (Merge E) |
| (lead) | S3 | Every Meta action-stats list reaches one count hook, but only two lists were read by the requested windows | `meta-results`, rulings 2 and 3 | fixed (Merge C) |
| (lead) | S4 | The monitor form copies the server's level order; a test now holds the copy equal | closing-fixes, item 3 | recorded: the server could publish the order instead |
| (post-patch) | S3 | The calculation passes after row assembly (summaries, window summaries, grouped advice) ran in one block on the thread that also serves the website and `/mcp`: NF-1, a residual of F-L9-01 (section 8) | nf-fixes `ea7f560b` | fixed; merged (Merge G, `cc72be88`) |
| (post-patch) | S3 | A report is one stored document (a 25,000-row report with 30 custom metrics is 170 MB): its write holds the shared thread for about 1 s, and every authority check of a job read it again (NF-1b) | nf-fixes `c4c424db` (ruling 17, candidate 1: the monitors evaluate the record the job has just written and the guard reads three fields): the longest stop at 25,000 rows 5.2 s to 2.3 s | fixed in part; merged (Merge G, `cc72be88`); candidate 2, rows stored apart from the report's header, is architectural and is recorded for the owner as a Round 3 item |

None of these called for a rebuild: each was a local fix inside a structure that matches the target (section 11).

## 8. Security findings

Sources: audit lane L9 (target section 6, thirteen controls), the security-relevant findings of the other lanes, the lead's own reading of every security-relevant diff, the supply-chain run on bee1db0e's manifests (`supply-chain-bee1db0e/`), the differential review of the SDK v2 migration (`differential-review-sdk-v2.md`), and the differential review of the twelve packages merged by bee1db0e (`differential-review-round2-part1.md`: no S1 or S2; a differential fuzz of the rewritten redaction against the old code found no regression in 600,000 comparisons). Parts 2a (Merge C), 2b (Merge D and the then-held linkedin-windows) and 2c (Merge E, Merge F and the runner fix) cover the packages merged after bee1db0e (`differential-review-round2-part2a.md`, `part2b.md`, `part2c.md`). The post-patch validation (`post-patch-validation-round2.md`, read-only, 2026-11-14) re-checked 27 security fixes against the merged code at `e876960e`: 19 closed, 8 partly closed (six of them S4 residuals only) and 0 not closed; its two S3 residuals, NF-1 and NF-2, were fixed by nf-fixes in Merge G. The closing security skills of 2026-11-14 (insecure-defaults and sharp-edges) are in 8.1.

Eleven of the thirteen controls held as Codex built them: tenant and client boundaries, reviewed writes, cursors, redaction, output encoding, error detail, resource limits and audit, among others. The two that did not, and every other security finding:

| ID | Sev | Finding | Fix | State |
| --- | --- | --- | --- | --- |
| F-L9-01 | S2 | A crafted custom metric set (three forms) blocked the worker thread, which in production also serves the website and `/mcp`, for seconds to about a minute | engine-core e640e5c7, afa7210a | fixed, tested |
| F-L9-02 | S2 | Run, resume and the scheduler rewrote saved definitions with no audit record | stored 67185200 | fixed, tested |
| F-L10-01 | S2 | Pushing the Codex branch would publish the private evidence package that its last commit adds | integration from cfdbf507; pre-push guard in the lead's scan | held by process |
| F-L3-03, F-L9-03 | S3, S4 | A client-limited reader could tell whether an ad ID exists in another client's account through the Meta identity probe | previews 5e78889c, e0c3d939, c95a2f82 | fixed, tested |
| F-L1-04 | S3 | The upstream-detail sanitiser let signed-URL parameters (`X-Amz-*`, `x-signature`, `Policy`, bare `token=`) reach cards, Copy details and the MCP envelope | tiktok 9b2e0a8f; regression repair daf4b1ba | fixed, tested |
| (lead) | S2 | The first version of that fix (`pairPass` in `src/security.ts`) leaked a secret nested inside a non-secret parameter's value. Caught by the lead's reading of the diff before merge. | daf4b1ba | fixed, tested |
| F-L4-13 | S4 | Corrupt gzip and unknown content encodings answered 500, reachable without a token on `/register`; on the baseline's dependencies the same request stops the process | f32c79b1 (dependencies), b3d78b70 (status mapping) | fixed, tested |
| F-L9-04 | S4 | A negative v4 metric became text with an apostrophe (`'-3`) in the CSV (formula guard misapplied) | engine-core 48b8ddee | fixed, tested |
| DR-01 | S3 | No test of tenant isolation across interleaved 2026-07-28 calls; the factory's refusal without an actor untested | mcp-surface dfbd4f3f (`tests/mcp-tenant-isolation.test.mjs`, 4 tests) | fixed, tested; merged (Merge D) |
| DR-02 | S3 | OAuth authorization-server helpers come from `@modelcontextprotocol/server-legacy`, which upstream deprecates as a frozen migration copy | owner item (section 21) | recorded |
| DR-03 | S4 | The SDK's protected-resource metadata helper sets `Access-Control-Allow-Origin: *`; AMCP does not use it | none needed | recorded |
| DR-04, F-L10-02, F-L4-07 | S4 | Dependencies beyond the owner's approved list: `@modelcontextprotocol/node` 2.1.2, `@hono/node-server` 2.1.6, zod 4.6.6 and six advisory overrides | owner ratification | blocked on the owner |
| DR2-01 | S3 | Query and text redaction used a narrower list of credential names than object keys and JSON text: `?apikey=`, `?client-secret=`, `?developer_token=` and 14 other spellings stayed readable. Work-here has the same gap. | sec-hardening ceee99fa (one list; 120,000-input differential against the frozen head); b16e81f3 adds `id_token`, `oauth_signature` (ruling 10 B; `code` not) | fixed, tested; merged (Merge C) |
| DR2-02 | S4 | Prose and header forms (`access_token=` after a space, `Authorization: Basic …`, `Cookie:`) survived `redact()`; the source card hid some of them in private rules, so the card, the MCP envelope and the audit row disagreed | sec-hardening 35a0e474; the refusal side narrowed by ruling 10 A (000d0dc7) | fixed, tested; merged (Merge C) |
| DR2-03 | S4 | The component library's `AmcpUI.button` and `amcpAction` accepted any link scheme, `javascript:` included; every caller passes a literal path today | sec-hardening fb976160 (parsed against a fixed placeholder origin) | fixed, tested; merged (Merge C); the other URL-bearing names in `AmcpUI.attrs` were taken by sec-followup (P2A-06) |
| DR2-04 | S4 | Audit rows of saved-definition and schedule changes did not name the client access set, as other audit rows do | sec-hardening a717325f (`accessSetAudit` exported from `src/access-sets.ts`) | fixed, tested; merged (Merge C); `src/workspace-core.ts`'s inline copy moved onto it by closing-small a078ade9 (Merge D); the post-patch validation's residual NF-9 (S4) is below |
| P2A-01 | S2 | DR2-02 removed the report card's own rule, so a credential name glued to `?`, `&`, `#` or `;` with white space around `=` (`&access_token = x`) shows its value on the card (288 of 3,003 enumerated shapes); a regression of 35a0e474 | sec-followup 3c0f45ec (one lookbehind alternation; table over the old card's 13 names x 4 leads x 6 spacings) | fixed, tested; merged (Merge D) |
| P2A-02 | S3 | `redact()` now hides whole lines of ad text beginning `Cookie:` or `Authorization:` in the MCP write review's `request`, so an approver can read `[REDACTED]` where the frozen plan sends text; a regression of 35a0e474 | sec-followup fa7271cb (the request shown through the credential view; `redacted` lists paths), 1e12c527 (ruling 13: paths only, no hash of the hidden value) | fixed, tested; merged (Merge D); the display residuals by sec-followup-2 (P2B-05, ruling 16 (8)), Merge E |
| P2A-03 | S3 | No test pins that a completed MCP task is read again under the caller's current rights; working, failed and cancelled tasks are described without an access re-check | sec-followup 994ba902 (every status re-read under current rights; tests for a narrowed set, a deleted report, a deactivated actor) | fixed, tested; merged (Merge D) |
| P2A-04 to P2A-07 | S4 | Progress-hold cap shared by every caller and `notify` not raced with the deadline; the chart text fit re-measures per character (a PDF export can block for seconds); a long-address regex, URL-bearing `attrs` names and `emptyBlock` hrefs in the website; no test of the chart baseline's access check | sec-followup 75f2e5cc (a share of 2 holds per actor; notify raced with the deadline), bc05c848 (binary-search cut), f4fb9f3b (address length, attrs names, emptyBlock same-site), 93b8d268 (test) | fixed, tested; merged (Merge D) |
| P2B-01 | S3 | sec-followup's P2A-01 alternative swallows a following credential's name when the two are joined by punctuation, so `redact()` shows a secret 6c80be71 hid (13 of 120,000 fuzz bodies) | sec-followup-2 ae9add56, 89ff586c (ruling 16 (6): 0 of 200,000 generator bodies show a credential 6c80be71 hid) | fixed, tested; merged (Merge E); part 2c: closed |
| P2B-02 | S3 | A combining mark after a space or a no-break space in a provider-controlled name makes the PDF text measure throw under shaping, failing the whole report PDF export | sec-followup-2 e1107d67, 8c9fd3c7; browser kind `report-pdf-export` d3d25bb2 (HTTP 500 before the fix, 200 after) | fixed, tested; merged (Merge E); part 2c: 0 throws in 338,496 measured shapes |
| P2B-03, P2B-05, P2B-06 | S4 | v2 transport refusals are not audited; `before_state` of a review still over-hidden without `redacted`; a retained projection marker contradicts ruling 14 | sec-followup-2 bbb88848, 2244d2ff (P2B-03); 4e972e53, 4db843be (P2B-05; the campaign step view 58ac2a7a, ruling 16 (8)); 13edbc40 (P2B-06) | fixed, tested; merged (Merge E); part 2c: closed |
| P2B-08 | S4 | Four notes on linkedin-windows: the request estimate, the login bracket of the rules read, "verified per rule" wording, `ACCOUNT_SCOPE_RESTRICTED` missing from `accessRefusalCodes` | linkedin-windows follow-up 50c72153, 03f910a5, cd27c5bc, 8049f78a, 996a7054, fa9f99b0 | fixed, tested; merged (Merge E); part 2c: closed for a to d, with P2C-02 in the same `catch` and the validation's residuals NF-8 and NF-10 (S4) below |
| P2B-04 | S4 | The contract profile is a field of the OAuth client's registration row, which has no workspace: latent until Round 3's switch, which must then be per workspace or per grant | Round 3 design note | recorded |
| P2B-07 | S4 | The read-only walk of ruling 12 gives each action one read and one write argument set and trusts AMCP's own read classification | recorded; the hint stays true for what the walk and the service's preview refusal cover | recorded |
| P2C-01 | S3 | DR2-02's header rule hides to the end of the line before the Bearer and JSON rules run, so a Bearer token folded onto the next line of a header and a JSON secret whose string holds a header word are shown by `redact()` (369 of 3,107,251 mutated texts), where bee1db0e hid them: a regression of DR2-02 against bee1db0e (not against 6c80be71) | final-fixes 77726e59 (`redact()`), 5dcfdf7b (the credential view a review shows) | fixed, tested; merged (Merge G, `19375498`). Ruling 18: held to bee1db0e and the old card; two markers in 100,000 texts of the glued-name class stay shown (the P2B-01 class), accepted and recorded |
| P2C-02 | S4 | The LinkedIn rules read's `catch` took a lost lease, a cancelled job and a transient 429 or 503 for LinkedIn's refusal, leaving the windows unknown with the report complete; nothing wrong is saved | final-fixes 13246798 | fixed, tested; merged (Merge G, `19375498`). The same flaw in seven other optional reads is LD-28 (section 9.2) |
| P2C-03 | S4 | The `.gitignore` comment and the guard test say the Codex evidence package was "never committed"; it is in the history of two local branches (dc41950e), and no test checks history | final-fixes 1400f714 (the wording; a test over `git rev-list HEAD -- <the two paths>`) | fixed, tested; merged (Merge G, `19375498`). What to do with the history of the two local branches is the owner's decision |
| P2C-04 | S4 | The readiness page, the status page and the runs record cited the V2 plan's decisions and the owner's deferral by a bare number in parentheses (as D20, D26 and C11), which `docs/DECISIONS.md` and the assistive-technology criteria define as other things | final-fixes 9a89379a, d94dacfa (41 citations now read "V2 plan Dnn"; `tools/docs-lint.mjs` refuses an unqualified `(Dnn)` or `(Cnn)` whose row has another subject) | fixed, tested; merged (Merge G, `19375498`). The V2 plan's decisions are defined only outside the repository: the owner may move them into `docs/DECISIONS.md` under their own prefix |
| NF-1 | S3 | The calculation passes after row assembly still blocked the shared event loop for seconds at the 25,000-row ceiling (a residual of F-L9-01); reproduced through the real worker: stalls of 2.3 s to 25 s across shapes | nf-fixes ea7f560b (the passes yield every 20 ms and sum each input once: the calculation's longest stop 48 ms), c4c424db (ruling 17: the tail, 5.2 s to 2.3 s) | fixed, tested; merged (Merge G, `cc72be88`); candidate 2 (the document write) recorded for the owner |
| NF-2 | S3 | A client-limited reader could tell a foreign Meta ad from an absent one through the activity history (a residual of F-L3-03 and F-L9-03) | nf-fixes da694be9 (the probe's two refusals are one audit error), 19871eaa (test) | fixed, tested; merged (Merge G, `cc72be88`) |
| NF-3 to NF-13 | S4 | The post-patch validation's other residuals: body-parse errors that still answer 500 (NF-3); a credential nested in a percent-encoded value (NF-4, the baseline's gap too); deny-list name gaps (NF-5); the group prepare answer omits `redacted` (NF-6); `tasks/cancel` before the rights check (NF-7); three classifiers that swallow `ACCOUNT_SCOPE_RESTRICTED` (NF-8); most audit writers do not name the access set (NF-9); cached LinkedIn rules skip the login comparison (NF-10); two own-site tests lack the tab removal (NF-11); the progress cap is per client id (NF-12); transport-refusal audit rows are uncapped (NF-13) | a Round 3 hardening package (ruling 19) | recorded by ruling 19 as residuals, none blocking: NF-4 and NF-5 go with SE-01; NF-8 is the class of LD-28, so nothing wrong is saved because the next guard raises the refusal, and Round 3 moves the three classifiers onto the shared `accessRefusalCodes` and `jobControlCodes`; NF-12 is by design; NF-13 has the property of the in-service audit, and Round 3 caps the stored arguments; each is listed with its location in the register (a local file) |
| Ruling 10 residuals | S4 | After the precise refusal: a pasted `api_key: <token>` with a space after the colon is not refused (it was not refused at bee1db0e either, and the display still hides it); `Authorization: Pending approval` is refused (scheme word and an 8-character word); a Bearer token under 8 characters is no longer refused | none | recorded |
| `file_destinations` | S4 | Bootstrap lists every export destination name in the workspace to a client-limited user | closed, not a defect: a tenant-scoped record of a name, formats and presentation with no connection or account link, so there is nothing for an access set to filter | recorded |

Supply chain on bee1db0e's manifests (`package.json` and `package-lock.json` are unchanged from bee1db0e to 7e409d1d, `git diff --stat` empty, so the run stands): 21 direct and 210 transitive packages, 0 advisories in OSV, `npm audit` 0 at every level with and without dev dependencies. Seven of the 21 direct packages carry a non-advisory finding, three of them in production: `@modelcontextprotocol/server-legacy` deprecated upstream, `ajv-formats` without a release since 2024-08-18, `bidi-js` with a single publisher. No install script is flagged. The run is repeated if the lock file changes.

### 8.1 The closing security skills (2026-11-14)

Two skills ran read-only on a `git archive` export of `cc72be88` (the integration head after the first two packages of Merge G: final-fixes and nf-fixes) that held only the production paths (`src`, `server`, `web`, `deploy`, `Dockerfile`, `railway.json`, `package.json`, `.env.example`, `.dockerignore`, `.npmrc`; 961 files). No private file of the checkout was in scope, and the jobcontrol package (merged as `7e409d1d`) was not: the lead reviewed it and it carries its own tests. The insecure-defaults workflow (13 agents) found 30 candidates, confirmed 1 and refuted 29, with none left unadjudicated (ID-01). The sharp-edges analyzer reported 15 items, F1 to F15, which the register numbers SE-01 to SE-15. The reports and the lead's triage are local files, not in the repository: `.runtime/wave5-claude/acceptance/insecure-defaults-round2.md`, `sharp-edges-round2.md` and `security-closing-triage.md`. Severities are the lead's, on the S1 to S4 scale of the differential reviews; the skill's own label is in brackets. "Pre-existing" means the same code or behaviour is at `Work-here` `4035ad7c`.

The lead's triage: **no S1 or S2. Every item that Rounds 1 and 2 introduced is S4** (SE-09, SE-10, SE-12). Nothing blocks the push. The pre-existing items are recorded for the owner, and a Round 3 hardening package is recommended.

| ID | Sev | Finding | Origin | Disposition | State |
| --- | --- | --- | --- | --- | --- |
| ID-01 | S4 (low) | `/versionz` returns the exact Node, FFmpeg and operating-system versions, the Git revision and the component digests to an anonymous caller; the values are pattern-validated, so no paths, environment values or secrets leak, and the deploy smoke test and the production-digest check read it | pre-existing: `35fb5485` (2026-10-09, wave 1, an ancestor of `4035ad7c`) | Round 3: keep the release identity public, move the toolchain versions behind the owner session or an operator token | recorded |
| SE-01 | S3 (high) | Object-key redaction is narrower than the text forms: ten object-key names, among them a bare `token` and a bare `key`, stay visible, and so does JSON text with a number or an object under a secret name; the text form `token=` and the keys `access_token`, `api_key`, `password`, `client_secret`, `authorization`, `cookie` and `developer_token` are hidden. AMCP's own tokens are never in a response: the path is a provider echo or a user input that holds a secret under one of those names. The lead's probe on the `cc72be88` build confirmed it | pre-existing: the same key set at `4035ad7c` | Round 3, by the differential method of rulings 10, 16 and 18: one exported name set shared by `keyReplacement`, `isSecretName`, `jsonSecrets` and `workspaceCredentialKey`, the unambiguous names added; the owner checks bare `token` and `key` (pagination and provider fields are named `key`) | recorded |
| SE-02 | S4 (medium) | A write outcome is verbatim on the first call and redacted on replay; `errorResult` passes `details` through; `nestedError` copies by key name | pre-existing design (provider data goes verbatim to the account's own client; the transport redacts `upstream`, and a family's `safeOutcome` is optional) | Round 3: validate `nestedError`'s values as `providerFactDetails` does, and return the same body on replay | recorded |
| SE-03 | S3 (medium, design) | Approval defaults to `assistant_ack`, so the client that prepared a write can confirm it; the opt-in modes `website_approval` and `distinct_approver` exist, a cap override is the owner's only, and a review lasts 5 minutes and is bound to a state hash | pre-existing (the spend policy, earlier waves) | **For the owner, before the first live write check (round 4 or later, V2 plan section 10.1):** choose the default approval mode for spend, cap and deletion | owner |
| SE-04 | S3 until verified (medium) | The generic write-shape checks, paused creation included, are opt-in per family. Per-platform tests exist (`paused-parents-platforms`, `creative-chain-audit`, `snapchat-writes`, `google-atomic-builds` and others); no test checks across the whole registry that every create-capable family enforces a paused or draft state | pre-existing | **Before the first live write check (round 4 or later):** a registry-wide invariant test that every family whose kind can match a create of a serving entity enforces paused or draft creation | recorded |
| SE-05 | S4 (medium) | `.env.example` turns writes on with the operator role, and an unscoped OAuth registration gets read and write on a write-enabled deployment, after consent; the Dockerfile and `server/config.ts` default writes to off | pre-existing | Round 3: make the example read-only and an unscoped registration read-only | recorded |
| SE-06 | S4 (medium) | The client-address source defaults to `socket` behind Railway; decision D5 of `docs/DECISIONS.md` covers the setting, and the production value is the owner's Railway setting, which was not readable here | pre-existing | Round 3: warn at start-up when `RAILWAY_*` is present and the source is unset | recorded |
| SE-07 | S4 (medium) | Only the exact value `off` disables client-metadata documents, and unset hosts means any host; the analyzer did not read the SSRF guard in `server/client-metadata.ts` | pre-existing (at `4035ad7c` and `bdda0cbd`) | Round 3: a strict enum with a start-up refusal, as `AMCP_CLIENT_IP_SOURCE` has | recorded |
| SE-08 | S4 (low) | The rollback switches read `!== 'false'`, `MIRROR_FLAGS` is unvalidated JSON, and documented zeros turn limits off; a typo falls in the safe direction for the rollback switches | pre-existing | none | recorded |
| SE-09 | S4 (low) | `taskLimits` and `progressLimits` are mutable exported objects, `maxBudgetChange` is a dead cap, and `readOf` lets callers override its read flags; the limits are not reachable from the environment, and the review re-classifies every state read itself | Rounds 1 and 2 for the limits (SDK v2 tasks and progress, V2-MCP-13); pre-existing for the other two | none | recorded |
| SE-10 | S4 (low) | The actor kind is inferred from a `userId` prefix; only the trusted local stdio actor could take an `oauth/` id, and a profile changes the contract shape and the annotations, not authority | Rounds 1 and 2 for the profile lookup (V2-MCP-06, beside P2B-04); pre-existing for the prefixes | recorded with P2B-04, the Round 3 per-workspace switch | recorded |
| SE-11 | S4 (low) | `createKey(ttlMs)` is unvalidated and a NULL expiry never expires; every caller passes a constant | pre-existing | none | recorded |
| SE-12 | S4 (low) | Both redactions have the same type; the refusal view is deliberately narrower | Rounds 1 and 2 (ruling 10); the ruling stands | none | recorded |
| SE-13 | S4 (low) | CSV neutralisation applies only to string cells: an array or object cell is stringified without it, and whether one reaches a CSV export is not determined | pre-existing | Round 3 hardening: neutralise every non-numeric cell | recorded |
| SE-14 | S4 (low) | `entrypoint.sh` runs `chown` without `-h` after its symlink check, base images are tags, and `.npmrc` has `audit=false`; it runs only at container start, as root, before `gosu` | pre-existing | Round 3: `chown -h` and digest pins | recorded |
| SE-15 | S4 (low) | The review fingerprint is an unkeyed sha256; it detects drift, not tampering, and tampering needs write access to the database | pre-existing | none | recorded |

What neither skill examined (the analyzer's own list, stated as the triage states it): the provider families one by one; `server/client-metadata.ts`; the sign-in, MFA and password modules; the PDF drawing code; most of `web/`. Both skills are static: nothing was executed against a deployment, and the jobcontrol package was outside their scope. These items are rows of the register (RECORDED 15, OWNER 1: SE-03).

## 9. Functional defects (state at the final integration head 7e409d1d)

"Fixed" in this section means: the package's report names the fix and the test that failed before it, the merge gate passed with that test in it, and the cited commit is reachable from the integration. On 2026-11-10 every one of the register's 129 fixed findings was checked: each cites at least one commit, and all of them are ancestors of bee1db0e (`lead-register-reach.mjs`). On 2026-11-14 the refreshed register was checked against `7e409d1d` by membership in `git log --format=%H 7e409d1d`: of the 301 distinct commits it names, 299 are in the history of `claude/v2-integration` and 2 are not commits of it by design: the Codex evidence commit dc41950e (section 3) and 8eb1af93, a blob hash of `web/mark.svg` that the 2026-11-07 matrix named, not a commit. The lead read every shared-module diff and the fixes named in section 12; it did not re-derive every one of the 129. Security findings are in section 8 and compatibility findings in section 10.

### 9.1 The audit's S1 and S2 findings

| ID | Sev | Requirement | Defect | Fix | State |
| --- | --- | --- | --- | --- | --- |
| F-L5-01 | S1 | V2-RPT-06 | Partial totals (28 campaigns, cost missing on 2) read as complete on the card, CSV, XLSX, PDF and Sheets | engine-surfaces 5a7fcf58 | fixed, tested, merged |
| F-L5-02 | S1 | V2-RPT-03 | v4 summaries added conversions across different TikTok optimization events, so a cost per result mixed events | engine-core 77df61f0 | fixed, tested, merged |
| F-L1-01 | S2 | V2-RPT-01 | An empty TikTok report was refused as incomplete when its page fields were zero or missing | tiktok 7cb39bbc | fixed, tested, merged |
| F-L2-01 | S2 | V2-RPT-04 | A rolling "last complete days" window was partial for LinkedIn at 01:00 Cairo on the default path | objectives d25df55a | fixed; the change of window basis is an owner item (21) |
| F-L2-02 | S2 | V2-RPT-04 | A LinkedIn group that was not mixed lost its result and cost per result when an undelivered member had another objective | objectives 0a046af2 | fixed, tested, merged |
| F-L5-03, F-L5-04 | S2 | V2-RPT-06 | A unit failing with a retryable error, or an error after collection, discarded the finished levels and left the report running | engine-core 73210d01 | fixed, tested, merged |
| F-L5-05 | S2 | V2-RPT-06 | The cross-level check was never shown on any view or export | web-report 78c09a2a; engine-surfaces (PDF, XLSX) | fixed, tested, merged |
| F-L5-06 | S2 | V2-RPT-06 | Monitors never evaluated a v4 snapshot | engine-surfaces d1120de1 | fixed, tested, merged |
| F-L5-07 | S2 | V2-RPT-06 | XLSX and Sheets received v4 metrics as text, so a sum gave 0 | engine-surfaces 51ebd708 | fixed, tested, merged |
| F-L5-08 | S2 | V2-RPT-06 | A Google `ad_ids` scope could not select any ad | results 0698f9ae | fixed, tested, merged |
| F-L5-09 | S2 | V2-RPT-06 | Rollups lost campaign status and objective when attribution differed between levels (X, Microsoft, Reddit, Apple, Google) | engine-core f050c136 | fixed, tested, merged |
| F-L5-10 | S2 | V2-RPT-06 | The source card reported only the first unit's error and wrongly said the source was excluded | engine-core 736d59da | fixed, tested, merged |
| F-L5-11 | S2 | V2-RPT-06 | Rolled-up summaries carried no label on the tile or in XLSX | engine-surfaces 67e9f70e | fixed, tested, merged |
| F-L5-12 | S2 | V2-RPT-03 | Meta results were mapped from actions instead of read from Meta's own `results` | package meta-results (c7130186 and after) | fixed, tested on v4; merged (Merge C) |
| F-L5-13 | S2 | V2-RPT-03 | Google and Microsoft value-based results (ROAS) were not implemented | results d4e4bd6e, 5c4cd98e | fixed, tested, merged; Microsoft's limit in 21 |
| F-L5-14 | S2 | V2-RPT-06 | Row assembly still lived in the worker's `work()` (target 3.1) | engine-core a5148f5d, f126e8a3 | fixed, merged |
| F-L5-15 | S2 | V2-RPT-06 | Level, option and default rules were restated by the MCP schema and the website instead of read from the table | website half engine-surfaces; MCP half package mcp-typed | fixed, tested, merged (website: Merge B; MCP: Merge C) |
| F-L7-01 | S2 | V2-RPT-07 | The Snapchat all-campaign ad-squad level failed above 144 campaigns, and the estimate said 11 requests | levels 34d98a22 | fixed, tested, merged |
| F-L7-02 | S2 | V2-RPT-07 | Apple ad group and ad levels refused at 1,000 rows, parents beyond 1,000 were unknown, the total's field name disagreed, and there was no runbook | levels ce6d4b08, 9606efeb, 448b34f6 | fixed, tested, merged; Apple's paging limit in 21 |
| F-L7-07 | S2 | V2-RPT-07 | X objectives were all inferred, and line items that differed showed "unknown" instead of "mixed" | levels 9731e811 | fixed, tested, merged |
| F-L8-01 | S2 | V2-RPT-05 | The failed-source card's Retry did nothing in a real browser | web-report 55cca474, browser case 863b2caa | fixed, tested, merged |
| F-L8-02 | S2 | V2-RPT-06 | On every v4 snapshot the table lost its objective group label and the source of the objective | web-report 78c09a2a | fixed, tested, merged |
| F-L8-03 | S2 | V2-RPT-06 | The site showed no "n of m rows" coverage and no cross-level result | web-report 78c09a2a | fixed, tested, merged |

### 9.2 Defects the lead found after the audit

| Ref | Sev | Defect | Found by | Fix | State |
| --- | --- | --- | --- | --- | --- |
| F-LEAD-02 | S2 | Under explicit attribution windows, Meta's `value` of an action is the ad set's own setting; every path reading `value` showed that number under the requested windows. Work-here has the same defect. | The owner-authorized live read of 2026-11-07 (nine insights GETs and one metadata call, read only) | meta-results 9a66cd14 (counts), 7d19b9e7 (cost per action); ruling 3 for every other action-stats list | v4 fixed and merged (meta-results ebc93efd, Merge C batch 1, bcf04347); guided captures by ruling 5 (below); v3 kept unchanged (section 10) |
| (lead) | S3 | Three generic Meta result definitions, and the selected-action override, gave one label to different results | Lead's review of meta-results | bbcd9812; ruling 4 (in ebc93efd) | fixed, tested, merged (Merge C batch 1) |
| (lead) | S2 | LinkedIn attribution windows were never joined into the overview (plan 4.7; round 1 call 12 left it to V2-RPT-06 and no round 2 task did it), so every LinkedIn conversion source says "unknown" | Lead's plan-compliance pass | linkedin-windows (22 commits `f98b8987` to `996a7054`: the package, the lead's pin commit `2b517033` and the P2B-08 follow-up) | fixed, tested; merged (Merge E `8a3131b3`) |
| (lead) | S2 | The website asks `get` for native values and lineage on every load and every poll: 148.6% of the baseline's `get` for audit L5's three-level TikTok report, where V2-RPT-06 made a plain `get` 11.6% | Lead's reading of `web/reporting-overview.js` against audit L5's measurements | website-get 0ef5f14b (ruling 14: the compact row keeps the evidence and results by objective; the page asks 100 rows and the charts, polls the status only): page load 2,308,993 -> 215,835 bytes (14.3% of the baseline), export poll 1,813,102 -> 24,806 | fixed, tested; merged (Merge D) |
| (lead) | S2 | The period comparison journey failed 16 of 16 browser cases from Codex's 1c8e0922 (2026-11-05), which added Meta campaign metadata reads the fixture did not answer; no full browser run followed that commit | Lead's full browser run lead-es-full-1 on 0b30f779 | closing-fixes a3e3831d, 7bcc9aa7 (the fixture's second campaign delivers in the earlier window, as the v4 run keeps delivered rows) | fixed; 16 of 16 pass |
| (lead) | S3 | Ad previews in Arabic: 8 of 8 media cases failed axe `label-content-name-mismatch` (WCAG 2.5.3) | lead-es-full-1 | closing-fixes, item 1 | fixed; 0 violations in the package's runs |
| (lead) | S3 | The monitor form offered one context several times on a v4 report (per level and per objective group), and a lower level when the top level was incomplete | Lead's review of the consumers of d1120de1 | closing-fixes, item 3 | fixed, tested |
| (lead) | S2 | The first version of the signed-URL redaction leaked a secret nested in another parameter's value | Lead's reading of the diff | daf4b1ba | fixed (section 8) |
| (lead) | S2 | A Meta cost per action under one requested window showed the ad set's own cost beside a cost per result from the windowed count (2 where 2.5) | Lead's ruling 2 on meta-results | 7d19b9e7 | fixed in the package |
| (lead) | S2 | Guided captures (presets, dimension packs, allocation evidence) still read a Meta action entry's `value` under explicit windows (F-LEAD-02 outside the overview) | Lead's review of meta-results (ruling 5) | meta-results 3253db97 | fixed, tested; merged (Merge C) |
| (lead) | S3 | Meta's own result for an action and the selected action shared one id, so advice counted two definitions as one | Lead's review (ruling 6) | meta-results 5f87c77e | fixed, tested; merged (Merge C) |
| (lead) | S2 | After ruling 5, the allocation outcome review would compare evidence counted the old way with a realized count read the new way | Lead's review (ruling 7) | meta-results 6447e653, test gap 5191dbd8 | fixed, tested (18 mutants, all killed after 5191dbd8); merged (Merge C) |
| (lead) | S2 | The analyze baseline and reconciliation compared captures counted two ways | Lead's review (ruling 9) | meta-results a0ff340d | fixed, tested (7 mutants killed); merged (Merge C) |
| (lead) | S2 | `combine` added the counts of captures counted two ways | Lead's review (ruling 11) | meta-results e55382ec, docs caaec5f6 | fixed, tested (five mutants, all killed after 3245643a); merged (Merge C) |
| (merge) | S3 | web-shell's deployed smoke check asserted a static navigation link the package removed on purpose: both `tests/deployment-smoke.test.ts` cases red on web-shell's own head | Merge C, the charts merge's wider selection | fixed in the charts merge commit (the check reads the route registry) | fixed, tested |
| (merge) | S3 | charts' chunk planner treated a page's stylesheets as message chunks (ENOENT in `tests/report-source-warnings-localization.test.mjs` on charts' own head) | Merge C | fixed in the charts merge commit | fixed, tested |
| (merge) | S4 | `tools/related-tests.mjs` misses tests that build `web/<name>` paths at run time (79 of 1,130 files) | Merge C | Merge C's final check runs every test file; planner fix in closing-small item 7 (c2bdc012) | fixed; merged (Merge D) |
| (mcp-typed) | S3 | Four monitor actions answer `INTERNAL_ERROR` when `id`, `monitor` or `notification_id` is missing (`src/monitor-delivery.ts:105`, `src/report-monitors.ts:333`) | mcp-typed's contract audit | mcp-surface f1fab4a7 | fixed, tested; merged (Merge D) |
| (mcp-typed) | S3 | `get` of a failed overview snapshot offers no next step (J9 `dead_end`); a running one carries no `next_call` or `poll_after_ms` | mcp-typed's eval | mcp-surface f1fab4a7 | fixed, tested; merged (Merge D) |
| (web-shell) | S3 | The connection result header shows the White lockup only (white on white under a light forced palette); error toasts leave after 6 s (WCAG 2.2.1) | web-shell's report | closing-small ac0cf4b7, 2bbec22d | fixed, tested; merged (Merge D) |
| (web-shell) | S4 | Arabic "Reports" (group) and "Reporting" (hub) read alike | web-shell's report | closing-small cd1855ce | fixed; merged (Merge D) |
| (lead) | S4 | `optionalReadRefused` took a cancelled job (`JOB_CANCELLED`, status 400) for a provider's refusal in seven optional reads (Apple twice, LinkedIn metadata, the overview parents, Reddit, TikTok, X), so a cancelled report kept collecting until its next guard; nothing wrong is saved (LD-28) | Lead's check of final-fixes' report | jobcontrol e49c0b45 (the root fix: the set `jobControlCodes`), 323e3052 (the two variants the lead found: `xRefusedRead`, which three readers ask, and TikTok's ad group read on a v3 source; 20 new tests written first and seen red) | fixed, tested; merged (Merge G, `7e409d1d`); v3's other legacy failures in the TikTok read stay (section 10) |
| (merge) | S4 | The browser case `shell-feedback-…` failed once in the first full run of Merge E and again in Merge F (2 of the 6 full browser runs that included the shell kind in Merges D to F): the case's own 500 interception of the overview stayed on for the whole context, so the page its Back link opens was refused too and the assertion passed only while the page sampled a first frame; a test-harness defect, not a product one | Merge E and Merge F (the cause shown red 3 of 3 in Merge F) | e876960e (the case removes its own interception before it clicks Back; the shell kind 68 of 68 three times in a row afterwards) | fixed; merged (Merge F) |
| (docs) | S4 | `tests/runtime-toolchain.test.mjs:125`: the first health call started the host's own FFmpeg probe, which shadowed the test's stub, so the test read the host's FFmpeg and passed only where one was configured (it was the one red test of every earlier full run on a host without FFmpeg) | docs item 10 | docs 70b7b4bd (the test lets that probe finish and resets it; it asserts on every host and skips nothing) | fixed; merged (Merge F) |

## 10. Compatibility findings (state at the final integration head 7e409d1d)

The plan's compatibility promises: v3 definitions run unchanged (V2-RPT-06); a rollback to Work-here keeps every report working that Work-here can run, and refuses the rest plainly (V2 plan D21); today's MCP clients keep working, with new defaults opt-in per client (V2 plan D26); the old pages keep their addresses (V2-WEB-01); the logo changes only as the owner's amendment says.

| ID | Sev | Finding | Fix | State |
| --- | --- | --- | --- | --- |
| F-L6-01 | S1 | The rollback form was refused by Work-here for the default new-report path and for re-saved TikTok and Snapchat definitions, and Work-here then paused the schedule | stored c3e32ea2, Work-here oracle 284ecdf5, visibility 4567a829 | fixed, tested against Work-here's own validator (F-L6-08) |
| F-L6-02 | S2 | "v3 definitions run unchanged" was false for TikTok and Snapchat campaign level (complete became partial; `complete_only` deliveries skipped) | stored 6169635a | fixed, tested |
| F-L6-03 | S2 | One-time notes were spent by a snapshot that was not the next delivery | stored fe11674f, feebee4f | fixed, tested |
| F-L6-12 | S2 | An idempotent retry of a v4 schedule creation failed instead of returning the existing schedule | stored e7458c8d | fixed, tested |
| F-L3-01 | S2 | Two listed tools carried a root-level `anyOf`, which the Claude API does not accept | mcp a5035720, golden d60f0e8b | fixed, tested |
| F-L4-01 | S2 | The hand-written framing stayed beside the SDK handler with no measured need | mcp 0514d462 | fixed, tested |
| F-L4-04 | S3 | Stdio served 2026-07-28 whatever the rollout flag said | mcp 9e49297b | fixed, tested |
| F-L4-05 | S3 | No committed test ran today's SDK 1.32.1 client | mcp 7a6ebad0, f7b671aa | fixed, tested |
| F-L4-06 | S3 | The result stamp overwrote a result that was not complete | mcp 0514d462 | fixed, tested |
| F-L5-16 | S3 | In-flight v3 TikTok and LinkedIn jobs were refused after a platform contract change | engine-core 126ae180 | fixed, tested |
| F-L6-05, F-L6-06 | S3 | A stale v4 config won after a rollback edit; the v3 upgrade was not total (667 of 4,033 fuzz inputs became an internal error) | stored 67185200, e7458c8d | fixed, tested |
| F-L7-11 | S3 | An edited single-campaign Snapchat ad-squad report lost its way back to Work-here | stored c3e32ea2 | fixed, tested |
| F-L8-05 | S3 | Opening an old v3 snapshot from History edited it with v4 defaults | web-report 72c301d4 | fixed, tested |
| F-L10-11 | S3 | On rollback a v4-only report refused with a message that blamed the level, and the runbook said nothing | stored 4567a829 | message and runbook fixed; v4-only definitions still fail closed on rollback, an owner item (21) |
| F-L4-14 | S4 | The rollback tree the record relies on no longer matches the lock after the dependency patches | docs ac44dc8a (the statement) | fixed in part: the third dependency tree is not built; merged (Merge F) |
| F-L4-10 | S4 | "Tests pass unchanged" is not literally true: client changes moved some assertions | recorded as an exception (16) | recorded |
| F-LEAD-02 on v3 | S2 | Kept on purpose: a v3 Meta report under explicit windows still shows the ad set's own count, because V2-RPT-06 says v3 runs unchanged | none; owner decision whether to fix v3 with a notice (21) | kept, visible |
| Rulings 7, 9, 11 | S3 | Retained Meta captures and allocation proposals made before V2 cannot be compared, combined or reviewed against captures made after it: refused with `REPORT_SEMANTICS_MISMATCH` naming `action_count_basis` (the website's baseline picker still offers such a baseline and then shows the refusal) | by design; owner informed (21) | recorded |
| (mcp-typed) | S4 | A client that sends a progress token on `run_background` or `export` sees the answer held up to 25 s (SSE when it accepts `text/event-stream`), as the brief specified | none | recorded |
| (web-shell) | S4 | The navigation is drawn by script from the route registry (`web/index.html` holds no links); old addresses still resolve; Home lost its first-name greeting (V2 plan D25 sign-off) | none; the deployed smoke check reads the registry | recorded |
| (charts) | S4 | The report builder loads the V2 layer: +32,132 bytes on en `/reporting-overview`; `ar /reporting-overview` at about 0.975 of its pre-WEB-07 bytes (ruling 8); 0.98220 at Merge D and 0.983868 after Merge E (ruling 15); at the final head 591,768 of its budget 601,471 bytes, which is 0.983868 and 2,485 bytes under ruling 15's 0.988 (Merge F's report says 2,467: an arithmetic slip, the ratio and the 9,703 bytes under the budget are the same) | route-budget commits of Merges C, D and E; no route moved in Merge G | recorded |
| final-fixes found-not-fixed 1 | S4 | The credential view a review shows is not idempotent for a Bearer token folded after an authorization header that is followed by `,` or `;`: the authorization rule's `\S{8,}` takes the already hidden `[REDACTED],`, so a second pass hides more. The frozen old view has the same property; the new view reaches it in 477 of 3M texts of the shape fuzz | none: a change could make the refusal refuse less | recorded |
| final-fixes found-not-fixed 4 | S4 | Two texts of the package's grammar fuzzer (1.5M draws) show a value that the head (`f7f43b54`) and `6c80be71` hid and the fixed build shows: a JSON string that holds a line break makes the header's line run on, so the header sweep takes a later credential name whose value sits on the next line. Neither text is a header form; `bee1db0e` shows both too (0 against `bee1db0e`), and the reviewer's mutation and positional probes (4M each) show 0 against the head. Ruling 18 holds the differential to `bee1db0e` and the old card | none | recorded |
| jobcontrol found-not-fixed 1 | S4 | On a v3 TikTok source every other non-retryable failure of the ad group events read (`src/tiktok-report-source.ts`) is still taken for "unavailable events": AMCP's own access refusals, `REPORT_*` codes and non-retryable 5xx included, because old saved v3 reports were collected under that rule (V2-RPT-06: v3 runs unchanged). A job's next guard raises an access refusal again, so what stays is a false reason, never a wrong saved value. The lead's call: v3 keeps its legacy rule and a control table pins it | none | recorded; whether v3 should follow v4 is for the lead and the owner |

Evidence at `7e409d1d`: the v3 collect golden is byte-identical to the one at `f7f43b54` and a regeneration into scratch from the Merge E build is byte-identical to it (73 scenarios, 32 refusals, 219 requests: `merge-e-REPORT.md` section 3); it is an always-run test (`tests/report-collect-golden.test.mjs`, in the 100 of 100 of every merge's checks); the tool-surface golden, `tests/journeys/baseline.json`, the collect golden and the evaluation baselines did not move in Merges E, F and G (`merge-g-REPORT.md` section 6); the conformance tests for today's client and for 2026-07-28 (`tests/mcp-client-conformance.test.ts`, `tests/mcp-sdk-v1-exchange.test.mjs`, `tests/mcp-typed-compat.test.mjs`) are in the suites that passed in full (section 18); the old page addresses are pinned by `tests/route-registry.test.mjs` and `tests/website-routes.test.mjs` (same suites); the logo's five blobs match their pins and equal the blob ids of `f7f43b54` (`merge-f-REPORT.md` check 7, and again at `7e409d1d` in `merge-g-REPORT.md` section 4). The rollback evidence (the Work-here oracle) is in section 18.3. Not re-checked in this pass (MISSING): the tool-surface golden's diff against the baseline holding only announced changes, and the legacy `-32002` kept on legacy wires (`keepLegacyGuideErrors`).

## 11. Keep, rework or rebuild

**Decision: PATH A, keep and improve.** The evidence meets the target's rule for keeping: the structure matches
sections 3 to 8 of the target in substance, and the defects are local.

Evidence:

- Ten independent audit lanes read every changed file and hunk from 4035ad7c to cfdbf507 with their callers, and
  reported 153 findings (S1 3, S2 32, S3 72, S4 46). None of them calls for a design to be replaced. The three S1s
  (F-L5-01, F-L5-02, F-L6-01) are local defects with local fixes.
- The gates are real: nine of nine behaviour mutants on the gates were killed (L8), 33 of 33 mutants in the L10 private
  copy, the wire sweep and the MCP evaluation pass, and Codex's change accounting is exact.
- Eleven of thirteen security controls hold as built (L9), and the two that did not were fixed locally (F-L9-01,
  F-L9-02).
- The arithmetic of the reporting engine is sound; L5 lists what must be kept (L5.md, lines 751 to 763).
- SDK v2 is complete, with no v1 import left, D17 byte-identical, and OAuth and Host behaviour identical to the baseline
  (76 of 76 and 45 of 45 cases).

Risks of this path, and how they are held: Codex's partial evidence (a related subset, no full browser run since
3b950b2d) is replaced by full gates and full browser runs on the integrated tree; the lead reads every security-relevant
diff personally (this caught a redaction regression in `pairPass`, fixed in daf4b1ba); every package starts from the
merged head, so fixes are not re-applied twice.

Maintenance: the kept code follows the seam rule and the single rule table, which keeps provider rules out of shared
modules. Benefit over a rebuild: R1 is already published and qualified, saved reports and MCP clients keep working, and
the effort goes into the defects rather than into reproducing 26,757 added lines. Validation is the closing gate in
sections 16 to 18. Rollback: `Work-here` stays at 4035ad7c and can be redeployed at any time; v4-only definitions fail
closed on `Work-here` rather than misreading (F-L10-11, an owner item in section 21).

PATH B and PATH C were rejected: no module violates a boundary or a compatibility obligation beyond local repair, and
nothing in the foundations is unsound or unsafe.

## 12. Remediation changes

Every change after Codex's last commit (cfdbf507) was made in a package: a brief by the lead, a Sonnet 5.5 implementer at maximum effort in its own worktree and branch, tests first, the lead's review of the report and the diffs, then a `--no-ff` merge by a Sonnet merge agent, reviewed by the lead before the integration branch moved. From cfdbf507 to 7e409d1d: 433 non-merge commits and 29 package merges (`git log cfdbf507..7e409d1d`: 462 commits; 28 packages, `meta-results` merged twice). The findings each package closed are in the register (`acceptance/findings-register.md`) and sections 5 and 7-10.

| Merge | Package | Merge commit | What it changed |
| --- | --- | --- | --- |
| A | stored | 3d6c069d | Saved definitions: audited migration, the rollback form Work-here accepts, v3 runs unchanged, one-time notes spent on delivery, idempotent v4 schedules (F-L6-01..12, F-L9-02) |
| A | tiktok | 359c000c | TikTok collection and paging, empty reports complete, signed-URL redaction (F-L1-*, F-L1-04) |
| A | objectives | df264c0f | Objective precedence and inheritance, LinkedIn group results, the window basis (F-L2-*) |
| A | levels | 78a9f5b5 | Campaign, ad group and ad levels for every platform within bounded requests; Snapchat, Apple and X fixes (F-L7-*) |
| A | previews | e74bd708 | Ad previews behind a provider hook, the Meta probe on the previews path only (F-L3-*) |
| A | mcp | d152e020 | MCP quick wins and the SDK v2 framing: one handler, stdio defaults, conformance tests (F-L3-01, F-L4-*) |
| A | web-report | 45bb1dfa | The report page: objective groups, coverage, cross-level results, Retry (F-L8-*) |
| B | engine-core | 3425c4d8 | The v4 engine: summaries by result definition, partial units kept, rollups, row assembly out of the worker, metric-set limits (F-L5-*, F-L9-01, F-L9-04) |
| B | brand | 2e41aced | The owner's AMCP brand kit, byte for byte, with forced-colour variants |
| B | results | c883f1c1 | Google and Microsoft value-based results; Google ad scopes (F-L5-08, F-L5-13) |
| B | web-components | 3fc2eaa2 | The V2 component layer and its members-only page (Task 19) |
| B | engine-surfaces | a9d0cdfd | Exports, monitors and the website read the v4 model (F-L5-01, 05, 06, 07, 11, 15) |
| C | closing-fixes | 0c8de036 | Browser and accessibility defects the lead's full run found; the monitor contexts |
| C | meta-results | bcf04347, 06bf2140 | Meta's own results and counts under explicit windows (F-L5-12, F-LEAD-02; rulings 1-7, 9, 11) |
| C | mcp-typed | 0f634ee3 | Typed schemas, get and list filters, page-cursor continuations, progress, the hand-built tasks extension (Tasks 16-17) |
| C | web-shell | 6dfb55f3 | One route registry, seven groups, the shell, section loading, scoped errors (Task 20) |
| C | charts | 400258d9 | Server-computed charts in the page, the builder and the PDF (Tasks 14-15) |
| C | sec-hardening | bcd68382 | DR2-01..04 and ruling 10 (one credential list; card, envelope and audit hide the same; safe component links; access sets in library audit rows) |
| C | (route budgets) | 6c80be71 | D13 for Merge C; ruling 8 |
| D | sec-followup | f78ceb42 | Differential review part 2a: P2A-01..07 and ruling 13 |
| D | mcp-surface | ea090d6d | Task 18: the per-client contract profile (V2 plan D26), ruling 12 hints, MEDIA_REVIEW_REQUIRED, the v2 byte budget, compact lists, guide sections, DR-01 tests, two contract defects |
| D | website-get | 12e50cfb | The page asks get only for what it renders (ruling 14): 153% -> 14.3% of the baseline's bytes per load |
| D | closing-small | e9720cae | Error toasts until dismissed, forced-colour header, the Arabic hub name, the chunk gate in check:fast, one audit helper, the test planner |
| D | (route budgets) | f7f43b54 | D13 for Merge D; ruling 15 |
| E | linkedin-windows | 8a3131b3 | LinkedIn conversion-rule windows in the overview (plan 4.7) with the P2B-08 notes (LD-03; the lead's pin commit 2b517033 under the owner's approval of 2026-11-14) |
| E | sec-followup-2 | fe25d717 | Differential review part 2b: P2B-01 with ruling 16 (6), P2B-02, P2B-03, P2B-05 and the campaign step's `redacted`, P2B-06; the browser kind `report-pdf-export` |
| E | (route budget) | 1f2e1c51 | V2 plan D13 for Merge E: `en /reporting-overview` 222,339 -> 222,517 |
| F | docs | 747e805a | Records and two ratchets: the V2 section and tool-list budget of `docs/CURRENT-READINESS.md`, the runs record `QUALIFICATION-V2-RUNS-2026-11-14.md`, the SDK record's corrections, the live-check wording of fifteen documents, the guard for the Codex evidence paths, the test planner's batches, two clock-frozen tests, a host-independent FFmpeg test (F-L10-01, 05, 09, 10, 14; F-L4-09, 14; F-L2-13) |
| F | (runner fix) | e876960e | The shell feedback case removes its own overview refusal before it clicks Back (the browser flake of Merges E and F) |
| G | final-fixes | 19375498 | Part 2c: P2C-01 (a Bearer token folded onto the next line of a header and a JSON secret whose string holds a header word stay hidden in `redact()` and in the credential view of a review), P2C-02 (the LinkedIn rules read ends on a lost lease, a cancelled job and a retryable failure), P2C-03 (the evidence-path guard reads history), P2C-04 (the V2 plan's decisions cited as "V2 plan Dnn", with a docs-lint rule) |
| G | nf-fixes | cc72be88 | The post-patch validation's two S3 residuals: NF-1 (the passes after row assembly yield every 20 ms and sum each input once; ruling 17: the job's guard reads three fields of the report and the monitors evaluate the record the job just wrote) and NF-2 (the identity probe's two refusals are one audit error) |
| G | jobcontrol | 7e409d1d | LD-28: a cancelled report or a lost lease is never a provider's refusal of an optional read (the set `jobControlCodes`), in the seven optional reads, in `xRefusedRead` and in TikTok's ad group read |

## 13. Remaining round 2 implementation

Codex's handoff left Tasks 13 to 20 (eight implementation tasks) and the closing Tasks 21 to 24.

| Task | Work | Done by | State |
| --- | --- | --- | --- |
| 13 | Apple bounded multi-page collection, owner runbook | levels ce6d4b08, 9606efeb, 448b34f6 | merged; Apple's campaign report is not on the shared paging helper (it would change the v3 request and its golden): recorded (21) |
| 14-15 | Shared chart specs and SVG, DOM and PDF renderers; golden SVGs, PDF text, palette, keyboard and axe cases | charts 97003af1 (21 commits) | merged (Merge C, 400258d9) |
| 16-17 | Typed config and output schemas from the server tables, `get` and `list` filters, include flags; request-scoped progress; the tasks extension | mcp-typed 34575f6a | accepted; merged in Merge C (0f634ee3); the tasks extension is built in AMCP's server layer from the pinned specification, on the 2026-07-28 path only and only for a client that declares it, because the SDK v2 core dropped tasks and the separate `@modelcontextprotocol/ext-tasks` package is not approved |
| 18 | Read-only annotations on the native gateways, MEDIA_REVIEW_REQUIRED hand-off, bounded continuation, split guide; legacy defaults kept, opt-in per client (V2 plan D26) | mcp-surface | merged (Merge D, ea090d6d); brief amended 2026-11-12 (listing room, cursor rule, two contract defects, DR-01 tests) |
| 19 | Components, members-only component page, per-component browser cases | web-components 3fc2eaa2 | merged |
| 20 | One route registry, seven groups, one-row 320 px header, no clipping at 800 px, section loading, scoped errors | web-shell e7aa8e9d | accepted (514 of 514 browser cases); merged in Merge C (6dfb55f3) |
| (plan 4.7) | LinkedIn attribution windows joined into the overview | linkedin-windows | merged (Merge E, 8a3131b3) |
| (audit L5) | The website asks `get` only for what it renders | website-get | merged (Merge D, 12e50cfb) |
| (closing) | Meta results (F-L5-12, F-LEAD-02, rulings 1 to 11); security hardening (DR2-01 to DR2-04, ruling 10); closing fixes; closing small fixes | meta-results, sec-hardening, closing-fixes, closing-small | all merged (closing-fixes, meta-results, sec-hardening: Merge C; closing-small: Merge D) |
| 21-24 | Reviews, docs, generated contracts, the V2 plan's D13 and D14 records, full gate with FFmpeg, full browser, container parity, evaluation, differential reviews, public record, pre-push scan, push | lead, docs package | docs merged (Merge F); the differential reviews 2a, 2b and 2c and the post-patch validation are done; the closing gates ran on `e876960e` (section 18); the three fix packages are merged (Merge G, `7e409d1d`); the final gate on that head is in section 16, the pre-push scan and the push in section 20 |

## 14. Sonnet contributions

The owner asked that implementation and merges run on Sonnet 5.5 under Opus's guidance and review. Every package after cfdbf507 had a written brief from the lead (`.runtime/wave5-claude/impl/<name>.md`), ran at maximum effort in its own worktree, and was reviewed by the lead (report and diffs) before it was merged.

- From cfdbf507 to 7e409d1d (`git log cfdbf507..7e409d1d`): 433 non-merge commits and 29 merge commits (28 packages; `meta-results` was merged twice). Sonnet 5.5 agents made 429 of the 433 (375 with the agreed pair of trailers and 54 with a single `Co-Authored-By: Claude Sonnet 5.5`) and all 29 merges (every merge commit carries the agreed pair; the merge reports are the sources, section 18.5). The lead made four, each with `Co-Authored-By: Claude Opus 5.5` alone: b7d56c89 (the independent target record), a3f677b5 (its index entry), c4d72cc6 (the status report regenerated after the first merges) and 2b517033 (the two Arabic catalogue pins of linkedin-windows, under the owner's approval of 2026-11-14). At bee1db0e the same count was 211 non-merge commits (208 Sonnet, 3 lead) and 12 merges.
- Packages merged, with the commits of each (from the merge reports where they state it, Merges C to G, and from `git log --no-merges <first parent>..<second parent>` of each merge, which gives the same numbers): Merge A stored 10, tiktok 18, objectives 13, levels 18, previews 23, mcp 19, web-report 12; engine-core 26; Merge B brand 12, results 17, web-components 19, engine-surfaces 18 (`merge-b-REPORT.md`: 66 of the 71 commits above its base are the packages' own); Merge C closing-fixes 6, meta-results 19 and 11, mcp-typed 25, web-shell 15, charts 21, sec-hardening 7 (`merge-c-REPORT.md` section 1); Merge D sec-followup 9, mcp-surface 16, website-get 12, closing-small 8 (`merge-d-REPORT.md` section 1); Merge E linkedin-windows 22 (one of them the lead's) and sec-followup-2 12 (`merge-e-REPORT.md` section 1); Merge F docs 23 (`merge-f-REPORT.md` section 1); Merge G final-fixes 6, nf-fixes 4 and jobcontrol 2 (`merge-g-REPORT.md` section 1; jobcontrol is cut at final-fixes' head). That is 423 of the 433 commits; the other 10 are the first-parent commits that are not merges (the route-budget and runner commits bee1db0e, 6c80be71, f7f43b54, 1f2e1c51 and e876960e, the status regeneration c4d72cc6, the golden and ratchet records 51b4a571 and 6f2c8d97) and the two before the first merge (b7d56c89, a3f677b5).
- Trailers: of the 429 Sonnet commits, 375 carry the agreed pair (`Implemented-By: Claude Sonnet 5.5`, then `Co-Authored-By: Claude Opus 5.5`). The 54 commits of three packages carry a single `Co-Authored-By: Claude Sonnet 5.5` instead: `engine-core` 15, `engine-surfaces` 18 and `charts` 21 (counted over each merge's second-parent range); the agents' own environment suggests that form, and those three followed it over the brief. The authorship they state is right and history is not rewritten, so this is recorded only (F-L10-13). The 12 commits of the three packages of Merge G (final-fixes 6, nf-fixes 4, jobcontrol 2) all carry the agreed pair (`git log` over the second-parent range of each merge).
- Audit: seven of the ten lanes ran on Sonnet 5.5 (TikTok and errors; objectives and LinkedIn; previews, MCP quick wins and tokens; stored data; levels; the website, locales and test integrity; the reconciliation of Codex's record against Git). Three ran on Opus 5.5: the SDK v2 migration, the reporting engine, and security.
- Read-only Sonnet 5.5 passes compiled the findings register and the requirements matrix (2026-11-07; refreshed on 2026-11-14 to f7f43b54, then to e876960e and then to the final head 7e409d1d), ran the Round 2 differential review (parts 1, 2a, 2b and 2c) and the post-patch validation of the Round 2 security fixes.
- The lead (Opus 5.5) kept: the independent target, the audit's judgement, every ruling (1 to 20) and brief, the review of each package before its merge, the security reading of shared modules (which caught the `pairPass` leak and the remaining Meta window lists), the differential review of the SDK migration, the live Meta read, and the final gates and acceptance.

## 15. Opus architectural decisions

Decisions the principal engineer took, with the reason. None of them is presented as an owner decision.

| Decision | Reason |
| --- | --- |
| PATH A (section 11) | The target's decision rule, applied to the audit's evidence. |
| Integrate from cfdbf507, never from dc41950e | The evidence commit adds a package that is private to the owner and cannot be published (F-L10-01). |
| Work in packages from the merged head, one worktree and branch each, merged `--no-ff` by a merge agent and reviewed by the lead before the integration branch moves | Fixes are applied once, every merge is reviewable, and a package can be reverted alone. |
| `INCOMPLETE_REPORT` stays outside the provider-data category (F-L10-07) | It describes AMCP's own collection, not the provider's data. Owner item. |
| An empty TikTok `page_info` settles plan 4.6; `null` page counts stay refused | An empty report is complete; a report that cannot state its pages is not. |
| One durable notice ledger, spent on successful delivery | D22's one-time note must be shown once, and only once a report reached the reader. |
| Sidecar fingerprint `config_v4_basis`; automatic sidecar writes do not bump the revision and are audited as `report_definition_migrated` | D21 rollback safety without changing what the user saved. |
| `requiresCompleteWindowDeclaration` applies to detail levels only | Campaign-level reports keep running as before. |
| Snapchat keeps the per-campaign stats route, partial at the end of the budget | Bounded requests, stated coverage. |
| The level table has one declaration, `src/overview-levels.ts` | Principle 2 of the plan: rules in one place. |
| Apple pins `pagination{offset,pageSize,totalCount}`; X objectives from docs.x.com | Provider documentation as the pin. |
| Previews sit behind a provider hook; the Meta preview probe runs on the previews path only (F-L3-03) | Seam rule; redaction stays everywhere else. |
| MCP: keep `validate()`, six advertised protocol versions, one `createMcpHandler`; `responseMode:'json'` removed | One path for every client, measured against the baseline. |
| Stdio `next` defaults to off and is `on` only when asked; stdio discovery lists one revision; legacy keeps −32601 for `resources/templates/list` | D26 opt-in, and no change for existing clients. |
| Route rule: never move or trim code to fit a byte budget; re-record only routes over budget, at the measured value, in a commit of its own (V2 plan D13) | Budgets measure the product; they must not shape it. |
| Shell rule: the shell loads only what it uses; a component that adds more than about 10 KB to the shell alone comes to the lead first | Performance anti-goal of the plan. |
| `file_destinations` is closed and not a defect | Recorded as S4 in section 8. |
| F-L5-12: Meta `results` read first on v4, the mapping kept as a labelled fallback; F-LEAD-02 fixed on v4 only | The live read pinned the shape; V2-RPT-06 says v3 runs unchanged. |
| Logo: the five kit files byte for byte, pinned by hash | The owner's amendment of 2026-11-07 (V2 plan D19 superseded for the logo; the name stays fixed). |
| Period comparison: keep the fixture's earlier-window delivery for the second campaign (7bcc9aa7) | The v4 run keeps only rows with activity by default; the journey's assertions are unchanged and reached by the product's own rule. |
| Meta action-stats lists under explicit windows (ruling 3, 2026-11-10): lists that add (`actions`, `action_values`, `conversions`, `conversion_values`, catalog and converted-product lists) sum the requested windows' keys; attributed lists that do not add (costs, ROAS, unique counts) give one window's own key or nothing; any other list is read by its keys when it carries a window name and by `value` when Meta did not split it | Every list of `{action_type, …}` entries reaches the same count hook, and Meta types them all as one kind; a cost, a ratio or a unique count cannot be summed across windows. |
| Meta result labels carry their own value (`Custom conversion {id}`, `Meta action {action}`, `Meta result {indicator}`, `Selected Meta action {action}`) | Results are grouped by definition, so totals never merged, but two groups under one label cannot be told apart by a reader. |
| Ruling 5: guided captures (presets, dimension packs, allocation evidence) read Meta action entries through the same count hook; a number that does not add under several windows is unknown with a reason, never an omitted zero; retained Meta captures are stamped `action_count_basis`; the v3 Overview capture keeps `.value` | One reading of a Meta count everywhere a person asks for one; v3 runs unchanged (V2-RPT-06). |
| Ruling 6: Meta's own result for an action has the id `meta:result:actions:<type>`, distinct from the selected action `meta:action:<type>` | Two definitions must never share an id, or advice counts them as one. |
| Rulings 7, 9, 11: the allocation outcome review, the analyze baseline, reconciliation and `combine` refuse two captures counted two ways (`action_count_basis` differs, present on one side included) with `REPORT_SEMANTICS_MISMATCH` naming the field; no stamp on either side behaves as before | A count read one way must never be compared with, or added to, a count read the other way; refusing with the field named is the existing contract, and needs no new copy. |
| Ruling 8: the byte margin of `ar /reporting-overview` is the merged measured ratio + 0.005 (rounded up to three decimals), every other Arabic page keeps 0.95, set in the D13 commit | The charts script and the V2 layer on that one route are announced product weight; the guard stays tight everywhere else. |
| Ruling 10: the credential refusal of saved reporting queries and settings reads only credential-shaped text (`redactCredentialShapes`); display, storage, the card, the MCP envelope, job errors and audit rows keep the full `redact()` | DR2-02 widened `redact()` for what is shown, which made the refusal reject ordinary campaign text (`Cookie: Spring sale`); a refusal must be precise, a display may over-hide. |
| Merge C budgets: a route's budget becomes its merged measured value only where that exceeds bee1db0e's budget, in one D13 commit with a table by package; the localization pins are measured on the merged tree, never summed | Packages measured partial trees; only the merged tree is the product. |
| web-shell keeps the V2 core off signed-in routes; Home's first-name greeting is left for the round 4 visual sign-off (V2 plan D25) | The core would cost 13,193 Brotli bytes per route (`/connections` at 97.9% of its 95% guard); the greeting is a visual call. |
| mcp-typed: continuations use `page-cursor` (bound to tenant, person, role, client and every argument); progress and tasks cover `run_background` and `export` only; a long run with a progress token is held at most 25 s; typed output types the common fields only and `charts` stays untyped under the open `data` | Listing room (27 bytes left of 97,280) and D26: nothing new for a client that did not ask. |
| The tasks extension is built in AMCP's server layer from the pinned specification, not from `@modelcontextprotocol/ext-tasks` | The SDK v2 core dropped tasks and the package is not approved (no download without the owner). |
| Ruling 13: a display that hides a value of a reviewed request lists where it hid it, never a hash of it | An unsalted hash of a short secret is reversible offline; the path tells the approver what was hidden. |
| Ruling 14: the lean v4 report row keeps `recommendation.evidence` and `results_by_objective` when present | Both are AMCP's own values the page shows; without them the website had to ask for the full row (153% of the baseline's bytes) on every load and poll. |
| Ruling 12: under the v2 client profile only, `readOnlyHint: true` on the seven native gateways a walk of 5,109 calls proved never write (meta, tiktok, snapchat, google_ads, dv360, linkedin, x_ads); ga4, Search Console, Business Profile, Microsoft and `amcp_native_action` keep today's annotations; CIMD clients stay legacy | An annotation is a promise to the client: it is set only where it is true, and only for a client that opted in (V2 plan D26). |
| The findings of differential review part 2a go to one package (`sec-followup`), cut from the integration head, and are fixed before any push | Two of them are regressions of a round 2 fix (DR2-02); a push must not carry a known regression of a control. |
| Merge interactions are fixed in the merge commit, not sent back: web-shell's deployed smoke check now reads the route registry; charts' chunk planner skips stylesheets; the `include.charts` note; the shell-loading test lets the report builder load the layer through its charts script | Each was proven on the package's own head or caused by the meeting of two packages; the fix belongs where both are present. |
| Ruling 15: after closing-small's shell growth `ar /reporting-overview` is at 0.98220 of its pre-WEB-07 bytes, over Merge C's 0.982 margin; in Merge D's route-budget commit its margin becomes the measured ratio + 0.005 rounded up (0.988), as ruling 8; the trend (0.9755, 0.9768, 0.9822) goes to the owner and any further growth on that page comes to the lead first | The guard measures the product and must not shape it; a margin follows the measurement, never the other way round. |
| Ruling 16 (sec-followup-2, 2026-11-14): the first branch of the redaction keeps its DR2-02 run and also hides the value of a credential head the run ends in, because the stop the ruling first named measured worse; the browser kind `report-pdf-export` exists and fails on the code before P2B-02; the compact view of a campaign step keeps `redacted` | A credential that 6c80be71 hid must stay hidden (0 of 200,000 generator bodies on both name lists show one); the PDF fix needs a browser case; an approver must be told where a value was hidden. |
| Ruling 17 (nf-fixes, NF-1b): the monitors evaluate the record the job has just written and the job's guard reads three fields of the stored report instead of parsing it, every authority check unchanged against the store; the roughly 1 s single-document write (candidate 2: rows stored apart from the report's header) is architectural and is recorded for the owner as a Round 3 item, not built. Addendum, accepted with `c4c424db`: the stopgaps (a), the checks once per stretch, and (b), a revision-validated read, are declined because they read the store less often or cache, which this ruling excludes. Also recorded, not changed: the dead first `recommendationV4` in the row loop, and exact-value sharing between metrics | The ruling keeps every check as fresh as before: the longest stop at 25,000 rows falls from 5.2 s to 2.3 s without weakening a guard; a larger change to the storage contract belongs to Round 3. |
| Ruling 18 (final-fixes, P2C-01): the differential of the folded-Bearer and JSON-secret fix is held to bee1db0e and the old card, not to 6c80be71; the lead's probe found 2 markers in 100,000 texts shown that 6c80be71 hid, both of the glued-name class of P2B-01, accepted and recorded | 6c80be71 hid them only through its broken JSON span over the following lines, and shows the same shape in every other text; bee1db0e and the old card show both. |
| Ruling 19 (the post-patch validation's residuals NF-3 to NF-13, all S4): recorded for a Round 3 hardening package, none blocking. NF-4 and NF-5 go with SE-01. NF-8 (three classifiers with their own lists swallow `ACCOUNT_SCOPE_RESTRICTED`: the period loop, TikTok's v3 events read and the LinkedIn allocation read) is the class of LD-28; Round 3 moves them onto the shared `accessRefusalCodes` and `jobControlCodes`. NF-12 is by design. NF-13 (the transport-refusal audit stores arguments uncapped) has the property of the pre-existing in-service audit; Round 3 caps the stored arguments | Nothing wrong is saved by NF-8, because the next guard raises the refusal again; the residuals are S4 and none blocks the push, and the redaction items (NF-4, NF-5, SE-01) are fixed once, by the differential method of rulings 10, 16 and 18, in the hardening package. |
| Ruling 20 (the closing gates at `7e409d1d`): the full qualification profile ran with one named `--allow-skip` for the history guard of P2C-03, which cannot run in a candidate without `.git` (by its design, accepted with final-fixes) and passes 5 of 5 in the worktree, as in every worktree run; accepted as a named, single, visible allowance. In Round 3 the profile names that skip itself, or the guard runs from the pre-push scan, so that the recipe passes as written | `node tools/qualify.mjs --profile full` fails any skipped test that is not named with `--allow-skip`, and a release candidate has no history to read; the allowance is one test, stated in 16.3 and 18.2, and the guard is read where history exists (16.1, 18.2). |

## 16. Test and quality-gate evidence

Every gate below names its revision, command, numbers and source, and each number is copied from that source. "Tested" in this record means that the package's tests failed before the fix and pass now and that the gates below pass; it does not mean live-verified. No gate called a provider, a Google endpoint, an OAuth endpoint or amcp.shop, and nothing was deployed. Gate2 is the lead's full gate: `npm run check` in a public candidate made from the Git tree, with FFmpeg required, so that the run sees what a release would contain and nothing private. All runs are on one Windows host.

### 16.1 On the final head `7e409d1d`

| Gate | Command and scope | Result | Source |
| --- | --- | --- | --- |
| Gate2 `claude-r2-merge-g` | `npm run check` in the public candidate of `7e409d1d` (3,613 files, source tree hash `78ac73ea…`), FFmpeg required | `check` exit 0 in 616 s. Main suite: 10,451 tests, 10,450 pass, 0 fail, 0 cancelled, 1 skipped. Capture suite: 4 tests, 4 pass, 0 skipped. The one skip is "no commit reachable from HEAD touches a private path (P2C-03) # no .git here: a copy of the tree has no history to read": the history guard cannot run in a candidate that has no `.git` | `.runtime/engineering-review/gates/claude-r2-merge-g/result.txt`, `check.log`, `assemble.json` and `source-head.txt` (local, not in the repository) |
| Build | `npm run build` | exit 0, 8 s | `merge-g-REPORT.md` section 4, check 1 |
| Fast qualification | `npm run check:fast` | passed: 17 stages, `failed_stages` empty, `worktree_clean` true, 96 s; `sunset_alarms` 20, which never blocks | same, check 2 |
| Every test file | 1,168 files (213 `.ts`, 955 `.mjs`) in 20 batches of 60 at `--test-concurrency=4`, FFmpeg set | 10,451 tests, 10,450 pass, 0 fail, 0 cancelled, 1 skipped (the entrypoint test that needs a POSIX `sh`; the 20 tests that earlier full runs skipped for want of FFmpeg ran and passed); 14.4 minutes of batch time | same, check 3 |
| MCP evaluation | `node tools/mcp-eval.mjs --check` and `--profile v2` | legacy: passed, 64 runs, 0 regressions, 0 improvements; v2: passed, 64 runs, 0 regressions, 1 improvement (the listing); nothing re-recorded | same, check 4 |
| Tool list bytes | `node tools/measure-tool-list.mjs` | unchanged: legacy operator 97,253 and reader 94,857; v2 operator 97,239 and reader 94,843 | same, check 5 |
| Website checks | `node tools/check-web.mjs` | exit 0: 51 browser scripts, 10 pages, escape-by-default markup and theme tokens within their baselines, 60 of 60 routes at or below their bytes before WEB-07 | same, check 6 |
| Documentation | `node tools/docs-lint.mjs`; `node tools/docs-index.mjs --check` | lint exit 0: 161,328 reference words, equal to the recorded baseline; owner and operator current pages 24,994 of 25,000; index: 612 documents, every link resolves | same, checks 7 and 8 |
| Browser subset | `node tools/browser-workflow-qa.mjs --kinds granular-reporting,report-pdf-export --https` | 18 of 18 passed (8 English and 8 Arabic cases of `granular-reporting`, 1 and 1 of `report-pdf-export`), 2.22 minutes; WCAG violations by rule: none; Arabic leaks 0; 0 provider mutations and 0 external provider requests. A development subset (`qualification_mode` false), not a qualification | same, check 9 |
| Pre-push scan | the lead's `prepush-scan.mjs` (`.runtime/engineering-review/amcp-engineering-review-20261008/work/`, local, not in the repository) from `e876960e` to `HEAD` | exit 0: 2,740 added lines, 0 hits in all 14 patterns, the tracked live-read sample unchanged, 15 commits, 0 without `[skip ci]`, private evidence: no commit in history, 0 paths in the range, 0 in the tree | same, check 10 |
| Other checks | locales, oracles, architecture, doc facts, markup, `contracts:actions`, provenance, locale chunks, logo proof, capture tests | locales: 12,112 in the catalogue and 10,987 required (unchanged); oracles: 1,168 test files, 807 code-less refusal assertions and 195 bare throws (the committed totals); architecture: 812 modules, no regression; doc facts current in 9 pages; markup: 302 sinks and 1,137 unescaped (unchanged); `contracts:actions`: 3,261 actions with no diff; provenance current, 25 artifacts; the logo's five files equal their pins and the blob ids of `f7f43b54`; no file under `web/` changed since `e876960e`; the four capture tests 4 of 4 | same, check 11 |

Merge G changed 56 files and no route, so no route budget and no Arabic margin moved (section 19; `merge-g-REPORT.md` section 5).

### 16.2 The gate2 series

Gate2 passed at each step of the integration, with the test count rising as the packages brought their tests:

| Revision | Gate2 run | Result | Source |
| --- | --- | --- | --- |
| `3425c4d8` (engine-core) | `claude-r2-engine-core` | 9,401 of 9,401 tests, 0 skipped, 4 of 4 capture tests, 526 s, no report diff | the lead's line in `.runtime/wave5-claude/STATE.md` (local, not in the repository) |
| `6c80be71` (Merge C) | `claude-r2-merge-c` | 10,123 of 10,123, 0 skipped, 560 s | `merge-c-REPORT.md` section 7; `STATE.md` |
| `f7f43b54` (Merge D) | `claude-r2-merge-d` | 10,311 of 10,311, 0 skipped, 527 s | `merge-d-REPORT.md` section 6; `STATE.md` |
| `1f2e1c51` (Merge E) | `claude-r2-merge-e` | 10,369 of 10,369, 631 s | `merge-e-REPORT.md` section 6; `STATE.md` |
| `e876960e` (Merge F) | `claude-r2-final` | 10,376 of 10,376 main tests and 4 of 4 capture tests, FFmpeg required, 504 s | `STATE.md` |
| `7e409d1d` (Merge G) | `claude-r2-merge-g` | 10,451 tests, 10,450 pass, 1 skipped (above), 4 of 4 capture tests, 616 s | 16.1 |

The 75 tests between `e876960e` and `7e409d1d` are the packages' own: 27 of final-fixes, 28 of nf-fixes and 20 of jobcontrol, each written first and seen red (`merge-g-REPORT.md` section 2). Codex's own last gate, at the end of its work, ran 8,451 tests in 939 files, a related subset and not the full suite (section 3). The per-merge checks before Merge G (the planner's selections, `check:fast`, browser subsets) are in 18.5.

### 16.3 The closing gates

The closing gates are the gates that need the whole integrated tree: container-layout parity, the full qualification profile, the full browser qualification over https, the MCP evaluation on both profiles, the Work-here oracle with the migration tests (V2 plan D21), and the target's probes. They ran on `e876960e` on 2026-11-14 (section 18, from `.runtime/wave5-claude/acceptance/closing-gates-2026-11-14.md`) and, after Merge G had changed 56 files, again on the final head `7e409d1d` (from `.runtime/wave5-claude/acceptance/closing-gates-final-7e409d1d.md`); both files are local and not in the repository. All six passed on both heads, each run once and none re-run. On `7e409d1d` the full qualification profile differs from the recipe of `e876960e` in one named allowance and one setup step, which the table's second row and the paragraph after it state (ruling 20).

| Closing gate | On `e876960e` (detail) | On `7e409d1d` |
| --- | --- | --- |
| Container-layout parity: `node tools/container-parity.mjs` from the clean public candidate | exit 0, `passed` true, 1,489 s; 10,380 tests, 10,379 pass, 0 fail, 1 skipped (the entrypoint ownership test, which needs a POSIX `sh`); a layout check outside Git on Windows, not the Linux image (18.2) | exit 0, `passed` true, 1,703 s; 10,455 tests, 10,453 pass, 0 fail, 2 skipped (the history guard of P2C-03, which has no `.git` to read in a copy, and the `sh` entrypoint test); 3,613 files; the same layout check, not the Linux image (18.2) |
| Full qualification profile: `node tools/qualify.mjs --profile full` | run 2 passed in 689 s: 10,380 of 10,380 tests, 0 skipped, 33 of 33 mutants killed, 29 stages (28 passed and `sunset_alarms`, which is recorded as an alarm and never blocks). Run 1 failed only because the one test skipped (no `sh` on the PATH) and this profile fails on any skip that is not allow-listed (18.2) | passed in 861 s with one named `--allow-skip` (the history guard of P2C-03) and `sh` on the PATH from the start: 10,454 of 10,455 tests pass, 1 skipped (that guard), 33 of 33 mutants killed, 29 stages (28 passed and `sunset_alarms`, recorded as an alarm); one run (18.2) |
| Full browser qualification: `node tools/browser-workflow-qa.mjs --qualification --https` | exit 0 in 3,530 s: 1,524 of 1,524 cases, 134 scenarios, 75 kinds, 26 presentation variants; WCAG violations by rule: none; 0 provider mutations (18.1) | exit 0 in 3,750 s (62.32 minutes): 1,524 of 1,524 cases, 134 scenarios, 75 kinds, 26 presentation variants; WCAG violations by rule: none; 0 provider mutations and 0 provider writes (18.1) |
| MCP evaluation: `node tools/mcp-eval.mjs --check` on both profiles | 64 runs on each, no regression; v2: 1 improvement (17.1) | the closing run: 64 runs on each profile, 0 regressions, v2 1 improvement; the tool list unchanged (94,857 and 97,253 bytes; v2 94,843 and 97,239). Merge G's own run gave the same (16.1) |
| Work-here oracle and migration tests (V2 plan D21); the rollback drill is blocked | 23 + 9 oracle tests and 37 + 8 migration tests pass; the storage-boundary check passes (18.3) | the same counts pass: 23 + 9 oracle tests, 37 + 8 migration tests (77 in all) and the storage-boundary check; the rollback drill stays blocked (18.3) |
| Target probes 3, 8 and 12 to 21 | all answered, every named test passed (18.4) | all answered again, every named test passed: 282 tests in seven runs, and the browser `shell` kind for probes 20 and 21 (18.4) |

**How the full qualification profile on `7e409d1d` differs from the recipe of `e876960e` (ruling 20).** It carries one `--allow-skip`: `node tools/qualify.mjs --profile full` fails any skipped test that is not named with that flag (`tools/qualify.mjs` and `docs/operations/QUALIFICATION.md`), and the test "no commit reachable from HEAD touches a private path (P2C-03)", added by final-fixes after the recipe, skips whenever the working directory has no `.git`, as a release candidate has none. The recipe's command has no such flag, so by the tool's own rule it cannot pass on this head; it was not run without the flag. The guard holds where history exists: `tests/private-evidence-paths.test.mjs` run in the worktree passes 5 of 5 with 0 skipped, so no commit reachable from `7e409d1d` touches either private path. Inside the candidate this run does not read the history of `7e409d1d`; the worktree runs do (Merge G's own full run among them). The profile also ran once, with `sh` on the PATH from the start (the recipe's own fix), so there was no run 1 that failed for want of `sh`. The lead accepted the allowance as named, single and visible (ruling 20); in Round 3 the profile names that skip itself, or the guard runs from the pre-push scan, so that the recipe passes as written.

### 16.4 Test integrity

- **Skips.** The full test runs skip one test on a host without `sh`. Gate2's public candidate skips the history guard of P2C-03, because a candidate has no `.git`; the container-layout parity run on `7e409d1d` skips that guard and the `sh` test (2 skips), and the full qualification profile on that head names the guard as its one allowed skip (ruling 20, above). A search of the added lines of `git diff --unified=0 cfdbf507 7e409d1d -- tests` for `skip`, `only` and `todo` as calls or options found 5 lines: 1 is that runtime skip, inside the guard the test itself writes (`tests/private-evidence-paths.test.mjs`, which reads `git` history when there is one), and 4 are prose in comments and a test title. No test was disabled to make a gate pass.
- **Baselines and goldens.** Each was re-recorded in commits of its own that name their reason. Over `cfdbf507..7e409d1d`, from `git log -- <file>` (merge commits that combined two edits included): the collect golden `tests/fixtures/report-collect-golden.json` in 8 commits, the last Merge B's `a9d0cdfd`; the journey and evaluation baseline `tests/journeys/baseline.json` in 3, the last `1acb4346` (V2 plan D14); the tool-surface golden `tests/fixtures/tool-surface-golden.json` in 7, the last `384f82d9` (V2 plan D14); the route byte budgets `tools/web-route-bytes-baseline.json` in 21, the last Merge F's `747e805a` (V2 plan D13: re-recorded only for a route over its budget, at the measured value; the merge-level commits are `bee1db0e`, `6c80be71`, `f7f43b54` and `1f2e1c51`); the architecture ratchet `docs/review/architecture-baseline.json` in 2, the last `6f2c8d97` (limit 193 to 195, for two provider-prefixed names in the shared level table); the docs-lint reference-word baseline `tools/docs-lint-baseline.json` in 54, the last final-fixes' `9a89379a` (+6 words, written by the tool; 161,328 now). Merge G moved only that last baseline. The Arabic margin of `ar /reporting-overview` is 0.988 (rulings 8 and 15).
- **Mutants.** 33 of 33 mutants of the catalogue were killed in the full profile on `e876960e` (121.8 s) and again on `7e409d1d` (161.7 s). The packages' own mutant runs are in sections 8 and 9.2 (for example the allocation outcome review, 18 mutants all killed; the analyze baseline, 7).
- **F-L4-10, an exception to the claim "the tests pass unchanged" (V2-MCP-13).** The claim is not literally true. `tests/mcp-help-introspection.test.mjs` now expects the code -32602 from the SDK v2 client and moved the -32002 and `index` checks to a raw wire capture, and `tests/mcp-client-conformance.test.ts` forwards `iss`, moves `extra.signal` to `extra.mcpReq.signal` and registers by method string. No assertion was removed or weakened, and the SDK record discloses the first change. The audit's measurement P15 shows that the edits were needed only because the test client changed: the old file passes 4 of 4 with a v1 client (`.runtime/wave5-claude/audit/L4.md`, local, not in the repository). No code change was asked; the exception is stated here.

### 16.5 What the gates do not show

They are local and synthetic: no provider, account or deployed site was reached, and the live line of every ticket is blocked because staging does not exist (V2 plan D20). The container-layout parity run is a layout check on Windows, not the Linux image. The browser runs are one host, one browser engine (Chromium) and loopback https. Gate2 and the parity run use a public candidate without `.git`, so a test that needs history skips there and runs in the worktree. The full qualification profile needs Git's `usr\bin` at the end of the PATH to find `sh`: on `e876960e` that was run 2 (run 1 failed for want of it), and on `7e409d1d` it was set from the start (18.2).

## 17. MCP and provider qualification

Scope. Everything here is local and synthetic, with one exception that qualifies no V2 code: the read-only session of 2026-11-07 that pinned the shape of Meta's `results` (the Meta row of 17.2). The gate numbers are copied from two local files that are not in the repository: the closing-gates file for `e876960e`, the integration head before Merge G (`.runtime/wave5-claude/acceptance/closing-gates-2026-11-14.md`; its logs are under `.runtime/closing-gates-2026-11-14/`), and the closing-gates file for the final head `7e409d1d` (`.runtime/wave5-claude/acceptance/closing-gates-final-7e409d1d.md`; its logs are under `.runtime/closing-gates-2026-11-14b/`). The six closing gates ran once on each head, on one Windows host, and passed on both; 18.1 to 18.4 give the two runs side by side. Merge G, which changed 56 files between the two heads, also ran the tool list and both evaluations itself (`merge-g-REPORT.md` section 4). In the gates no provider, Google, OAuth endpoint or amcp.shop was called, no MCP tool of a connected account was used, and nothing was deployed. A live qualification needs the owner's staging, which does not exist (blocked: no staging, V2 plan D20). The owner's named test accounts have not been used, for a read or a write.

### 17.1 MCP

- **Evaluation.** `node tools/mcp-eval.mjs --check`: exit 0, 64 runs, profile legacy, no regression, 0 improvements. `node tools/mcp-eval.mjs --check --profile v2`: exit 0, 64 runs, no regression, 1 improvement (the listing, as `docs/operations/QUALIFICATION.md` says). The same stage ran as `journey_evaluation` in the full qualification profile and passed (6.8 s). On `7e409d1d` the two runs gave the same result (legacy: passed, 64 runs, no regression, 0 improvements; v2: passed, 64 runs, no regression, 1 improvement, the listing), and `journey_evaluation` passed in 11.4 s. The evaluation had 60 runs at Merges A and B and 64 from Merge C on (the merge reports); the journey baseline `tests/journeys/baseline.json` was re-recorded under V2 plan D14 by `mcp-surface` (`1acb4346`).
- **Tool-list bytes** (`node tools/measure-tool-list.mjs`, exit 0, 0 provider requests): `tools/list` is 94,857 bytes for the reader and 97,253 for the operator, 25 tools each; under the v2 client profile 94,843 and 97,239 (14 bytes saved). The limit is 97,280 bytes (95 KiB); the operator listing has 27 bytes of room, which is why the `amcp_workspace` limit note (F-L3-08) stays in action help. Also measured: capabilities summary first page 14,649 bytes (one connection) and 26,064 bytes (six providers, 20 accounts), dashboard summary 1,808 and 7,931 bytes, help root 6,902 bytes, the largest gateway help 39,716 bytes (`amcp_workspace`). The run on `7e409d1d` (exit 0, 0 provider requests) gave every one of these figures again. At Merges A and B the operator listing was 97,181 bytes and the reader 94,536 (`merge-a-REPORT.md`, `merge-b-REPORT.md`); from Merge C on it is 97,253 and 94,857 (`merge-c-REPORT.md`), and the v2 profile is 14 bytes smaller (`merge-d-REPORT.md`).
- **The SDK v2 record and its review.** The record is `docs/records/QUALIFICATION-V2-R2-SDK-2026-11-04.md`; the docs package corrected it (F-L4-09: the four protocol-error changes that "Other errors are untouched" had hidden; F-L4-14: after the dependency patch a rollback reverts both the patch and the SDK commit, and a rollback that kept the patches would need a third tree that is not preserved). The differential review of the migration (`.runtime/wave5-claude/acceptance/differential-review-sdk-v2.md`, 2026-11-10, range `4035ad7c..bee1db0e`) found no S1 or S2 and DR-01 to DR-04 (section 8). The supply-chain run on the manifests of `bee1db0e`: 21 direct and 210 transitive packages, 0 advisories in OSV, `npm audit` 0 at every level; `package.json` and `package-lock.json` are unchanged from `bee1db0e` to `7e409d1d` (`git diff --stat` empty), so the run stands. The closing runs used a dependency tree with the MCP SDK client and server at 2.4.0. The dependencies beyond the owner's approved list and the exit plan for `@modelcontextprotocol/server-legacy` wait for the owner (section 21).
- **Conformance and probes** (all green in the closing gates, section 18.4): an SDK v2 client over the real HTTP stack in both protocol eras, and the recorded SDK 1.32.1 client's 31 exchanges replayed (`tests/mcp-sdk-v1-exchange.test.mjs`, `tests/mcp-typed-compat.test.mjs`): every call it sent validates against today's listed input schema and every result against its output schema; probe 14 (a continuation or task handle used by another tenant or another actor is refused), probe 15 (an upload after the annotation change stores nothing and answers `MEDIA_REVIEW_REQUIRED`), probe 18 (a continuation with changed arguments is `INVALID_CURSOR`) and probe 19 (an old `level` string is valid against the listed schema); two-tenant interleaving (`tests/mcp-tenant-isolation.test.mjs`, DR-01).
- **Rulings** (section 15): ruling 12, under the v2 client profile only, `readOnlyHint: true` on the seven native gateways whose actions a walk of 5,109 calls proved never write (meta, tiktok, snapchat, google_ads, dv360, linkedin, x_ads); ga4, Search Console, Business Profile, Microsoft and `amcp_native_action` keep today's annotations (`tests/mcp-v2-annotations.test.mjs`). The per-client contract profile (V2 plan D26): `legacy` for every client until a record says `v2`; read at every request from the AI client's registration record and settable by no request (`tests/mcp-contract-profile.test.mjs`, 9 tests); clients identified by a metadata document stay legacy; no production code writes a profile, so nothing changes for any client; an SDK client caches its lists for 300 s, so a later switch can show up to 5 minutes late. Ruling 13, a display that hides a value of a reviewed request lists the path it hid, never a hash.
- **Not done.** A real client of today's or the 2026-07-28 protocol against a deployed server (the live ACC-02 checks); a live Claude request to confirm the root-`anyOf` fix (optional, F-L3-01); `@modelcontextprotocol/ext-tasks` is not approved, so the tasks extension is built in AMCP's server layer from the pinned specification.

### 17.2 Providers

For every provider below the live read qualification has not run and the live write qualification has not run (blocked: no staging, V2 plan D20). The synthetic evidence is fixtures shaped from the provider's public documentation and fakes of the reviewed-write path; the browser qualification recorded 0 external provider requests, 0 provider mutations and 0 provider writes (28 synthetic writes). "Writes" is the number of reviewed write actions in the action ledger (`docs/CURRENT-READINESS.md` section 6, generated).

| Provider (API version; writes) | What Rounds 1 and 2 changed | Synthetic or fixture evidence | What no live check has shown |
| --- | --- | --- | --- |
| Meta (v26.0; 74) | Results read from Meta's own `results` first, the mapped table kept as a labelled fallback; counts under explicit attribution windows (F-LEAD-02); the preview identity probe; seven older objectives pinned (v4 only) | `tests/meta-results-reader.test.mjs`, `tests/meta-results-windows.test.mjs`, `tests/meta-results-objectives.test.mjs`, `tests/fixtures/meta-results-samples.json` (the shape only, numbers invented), `tests/meta-ad-identity-oracle.test.mjs`; the stage `meta_creative_features_pinned` passed | The shape of `results` was pinned from one read-only session on 2026-11-07 (nine insights requests and one metadata request on the owner's named Meta test account, through the production connector: `docs/records/META-RESULTS-PIN-2026-11-07.md`, which says such a read does not qualify undeployed code). The `1d_ev` key and the action-stats lists other than `actions` were not read live |
| TikTok (v1.3; 71) | Paging until the total, short and empty reports, `STATUS_ALL` and `enable_total_metrics`, 30-day spans, error mapping; results from TikTok's `result` metric | `tests/tiktok-report-completion.test.mjs`, `tests/tiktok-report-spans.test.mjs`, `tests/tiktok-report-totals.test.mjs`, `tests/tiktok-report-collection.test.mjs`, `tests/tiktok-report-inventory.test.mjs`, `tests/fixtures/tiktok-report-pages.mjs` | Both levels on the qualification advertisers; the recorded `page_info` pattern; `src/provider-sunsets.ts:84` still carries `unknown('tiktok', 'v1.3')` while TikTok launched Reporting API v2.0 (owner decision) |
| Snapchat (v1; 72) | Ad-squad level across all campaigns beyond 144 campaigns (per-campaign stats route kept), preview links | `tests/snapchat-population-scale.test.mjs` (200 and 1,300 campaigns), `tests/snapchat-overview-population.test.mjs`, `tests/snapchat-time-zones.test.mjs`, `tests/snapchat-preview-links.test.mjs` | The stats API, by-ID reads and the `optimization_goal` enum are unpinned (runbooks); the real preview-link response was never captured |
| Google Ads (v25; 219) | Value-based results (conversion value, ROAS), `ad_ids` scope, campaign objective fields on ad group and ad rows | `tests/google-value-bidding.test.mjs`, `tests/google-value-advice.test.mjs`, `tests/google-ad-scope.test.mjs` | The GAQL for `campaign.advertising_channel_type` and `campaign.bidding_strategy_type` from `ad_group` and `ad_group_ad` was not parsed live (F-L2-04) |
| LinkedIn (202609; 68) | Three levels with objective and window rules, previews with the documented `account` parameter, conversion-rule attribution windows in the overview | `tests/linkedin-levels.test.mjs`, `tests/linkedin-windows.test.mjs`, `tests/linkedin-results.test.mjs`, `tests/linkedin-overview-windows.test.mjs`, `tests/linkedin-ad-previews-account.test.mjs`, `tests/fixtures/linkedin-conversion-rules-docs.mjs` | A 7-day report at three levels, the conversion-rules endpoint and the 3-hour preview link were never read live; two LinkedIn products answer 403 for the owner-selected account (`docs/CURRENT-READINESS.md` section 6) |
| X (12; 67) | Line items and promoted tweets by synchronous stats; objectives from the documented table | `docs/records/X-ADS-API-PINS-2026-11-06.md`, `tests/x-overview-detail.test.mjs`, `tests/x-objective-table.test.mjs`, `tests/x-campaign-objectives.test.mjs`, `tests/x-hour-boundaries.test.mjs`, `tests/x-time-zones.test.mjs` | Echo facts, metric types, history depth and the placement list are unpinned (runbook); no live read |
| Apple Ads (v1; 21) | Detail levels beyond one page (`pagination` with `offset`, `pageSize`, `totalCount`) and allowance handling | `docs/records/APPLE-ADS-PLATFORM-PINS-2026-11-06.md`, `tests/apple-report-pages.test.mjs`, `tests/apple-report-paging.test.mjs`; owner runbook `docs/acceptance/ROUND2-APPLE-READ-ACCEPTANCE.md` | Apple is not connected: the live read is an owner runbook step; Apple's campaign report is not on the shared paging helper |
| Microsoft Advertising (v13; 16) | Conversions in the v4 results and rollups; keeps its annotation under ruling 12 (a report submission creates a provider job) | The shared v4 engine tests; standing tests (for example `tests/microsoft-portfolio.test.mjs`) | Value-based metrics need a Campaign Management read that was not made |
| Reddit (v3; 13) | Rollups of results with different attribution; video result | `tests/reddit-video-result.test.mjs`, `tests/reddit-report-scope.test.mjs` | The deprecation `reddit_report_breakdowns_2026_12` takes effect 2026-12-08 (24 days left on 2026-11-14); no live read |
| Display and Video 360 (v4; 62) | No ticket; the v2-profile read-only hint (ruling 12) | Standing tests (for example `tests/dv360-ad-assets.test.mjs`); `tests/mcp-v2-annotations.test.mjs` | No DV360 advertiser is configured (`docs/CURRENT-READINESS.md` section 6) |
| Google Analytics 4 (2), Search Console (4), Business Profile (14), Tag Manager (64) | No ticket; they keep today's annotations (ruling 12) | Standing tests (for example `tests/ga4-campaign-report.test.ts`, `tests/google-business-access.test.ts`, `tests/gtm-audit-grouping.test.mjs`) | No live read or write |
| Adjust (0), Google Drive and Google Sheets | No ticket; the XLSX and Sheets exports receive v4 metrics as numbers (F-L5-07) | `tests/adjust-reporting.test.ts`, `tests/sheets-authority.test.mjs`, `tests/sheets-delivery-recovery.test.mjs` | No live Sheets export (not permitted during development); the inline Sheets note is an owner decision |
| Criteo, WooCommerce, Amazon Ads | Parked (`owner_parked`, `owner_parked`, `unimplemented`); not offered | Standing tests of the parked adapters | Not offered |

The standing synthetic stages passed on `e876960e` in the full qualification profile (section 18.2): `wire_contract_sweep` (26.1 s), `providers_check`, `providers_lifecycle` and `providers_sunsets`. `sunset_alarms` is recorded as an alarm and never blocks: 20 alarms on 2026-11-14, one deprecation (Reddit, 24 days left) and 19 stale checks, each provider's last check 46 or 47 days old; dated versions Google v25 2027-08, LinkedIn 202609 2027-09, Criteo 2026-07 2027-07. On `7e409d1d` the same stages passed in the full qualification profile (`wire_contract_sweep` 29.0 s, `meta_creative_features_pinned`, `providers_check`, `providers_lifecycle` and `providers_sunsets`), and `sunset_alarms` was recorded as an alarm again with the same 20 alarms on 2026-11-14.

## 18. Cross-system integration evidence

Sources: the closing-gates files for `e876960e` (`.runtime/wave5-claude/acceptance/closing-gates-2026-11-14.md`) and for `7e409d1d` (`.runtime/wave5-claude/acceptance/closing-gates-final-7e409d1d.md`), both local and not in the repository, and the merge reports. Each of 18.1 to 18.4 gives the run on `e876960e` (before Merge G) first and the run on the final head `7e409d1d` (after it) second. The runs on `e876960e` are on revision `e876960e63c85a48a3d965bf8ce4d28ce608b479` (`claude/v2-integration`), on one Windows 11 host (20 logical CPUs, 16,005 MB RAM, Node v24.19.0, npm 11.17.0, FFmpeg and ffprobe `n9.0.2-22`, Python 3.14.2), from a public candidate made from the Git tree (manifest version 2, `source_tree_hash` `7f02dd62…`, 3,610 files). The candidate's package digest is `ff95cc93…` and its public asset version `4bb1b8a9…`. Each step wrote a stdout log, a stderr log and an exit file under `.runtime/closing-gates-2026-11-14/` (local, not in the repository). The full gate that precedes them (gate2 `claude-r2-final`: 10,376 of 10,376 main tests and 4 of 4 capture tests with FFmpeg required, 504 s) is the lead's earlier run.

The runs on `7e409d1d` are on revision `7e409d1db194b912dbd29d17bbfbedba8985228c` (`claude/v2-integration`), on the same host and with the same dependency tree (the MCP SDK client and server at 2.4.0). Container-layout parity and the full qualification profile ran in a public candidate made from the Git tree by the lead's gate2 `claude-r2-merge-g` (manifest version 2, `source_tree_hash` `78ac73ea…`, 3,613 files, package digest `7d5de56b…`, public asset version `4bb1b8a9…`, which is the value at `e876960e` because no web file changed); the browser run, the evaluations, the oracle and migration tests and the probes ran in the clean worktree of that revision. Each step wrote a stdout log, a stderr log and an exit file under `.runtime/closing-gates-2026-11-14b/` (local, not in the repository). The steps were started from PowerShell through a small runner that writes each exit file in the format of the earlier run, because the Bash tool failed on this host for every command tried.

**What Merge G changed between the two runs.** Three package merges brought 56 files (`git diff --name-only e876960e 7e409d1d`; 2,740 insertions and 222 deletions): 16 under `src/`, 15 under `tests/`, 22 under `docs/`, 2 under `tools/` (`docs-lint.mjs` and its baseline) and `.gitignore`. No file under `web/`, `server/`, `deploy/`, `codegen/`, `generated/` or `.mirror/` changed, and `package.json` and `package-lock.json` did not. All six closing gates were run again on `7e409d1d` and passed, each once and none re-run (18.1 to 18.4). What else was run on that head is in 18.5 (row G) and in section 16.

### 18.1 Browser qualification

The command is `node tools/browser-workflow-qa.mjs --qualification --https` (`--qualification` runs every kind; `--kinds` is refused with it). The figures below are those of `e876960e`; the run on `7e409d1d` is the last bullet. On `e876960e`: exit 0 in 3,530 s (58.78 minutes of a 75-minute budget). **1,524 of 1,524 cases passed, 0 failed, 0 unhandled rejections**, 134 distinct scenarios, 75 kinds, 26 presentation variants; at `3b950b2d` the run had 1,392 of 1,392. Chromium 148.0.7778.96 (headless shell), Playwright 1.62.1, axe-core 4.14.0 with the tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a and wcag22aa, over HTTPS with a loopback certificate made for the run (trusted by nothing, errors ignored for that certificate only); `working_tree_clean` true.

- Accessibility: automated WCAG violations by rule: none. Needing manual review (axe "incomplete"): `aria-required-children` 64, `aria-valid-attr-value` 64, `color-contrast` 1,412, `label-content-name-mismatch` 868. Focus rings measured 3,984, 0 below 3:1, 0 without an indicator, 12 not focus-visible when probed.
- Arabic: the six critical routes at zero leaks; of the 121 route keys with a leak count, 119 sit exactly at their committed limit in `tools/arabic-leak-baseline.json`, none above or below, 2 have no limit (report-only).
- Safety: 0 external provider requests, 0 provider mutations, 0 provider writes, 28 synthetic writes in the fixture; write-journey outcomes accepted 4, refused 4, uncertain 4. The only non-empty `failed_responses` are the 16 not-found cases (404 for `/no-such-page`).
- Per kind (passed of cases): `empty` 264 of 264, `reviewer` 100 of 100, `shell` 68 of 68, `shell-chrome` 24 of 24, `brand-no-script` 10 of 10, `export-outcomes`, `spend-policy-edit`, `write-journey` and `version-skew` 4 of 4 each, `report-pdf-export` 2 of 2, and 65 kinds of 16 of 16 (English and Arabic, light and dark, 320, 375, 768 and 1,280 px; among them `ad-previews`, `components`, `granular-reporting` and `period-comparison`): 264 + 100 + 68 + 24 + 10 + 4 × 4 + 2 + 65 × 16 = 1,524.
- Scope, as `docs/LOCAL-BROWSER-QA.md` says for `--https`: the same cases on pages security software cannot rewrite; nothing about the deployed site's certificate or headers.
- **On `7e409d1d`** (the same command in the clean worktree of that revision; the output is in an ignored runtime folder): exit 0 in 3,750 s (62.32 minutes of the 75-minute budget, `within_runtime_budget` true). **1,524 of 1,524 cases passed, 0 failed, 0 unhandled rejections**, 134 distinct scenarios, 75 kinds, 26 presentation variants, with no re-run; the totals per kind are those above. `working_tree_clean` true; Chromium 148.0.7778.96 (headless shell), Playwright 1.62.1 and axe-core 4.14.0 with the same six tags, over https with a loopback certificate made for the run; the website source, the runner source and the input map have the digests of the run at `e876960e`, because no web file and not the runner changed. Automated WCAG violations by rule: none. Needing manual review (axe "incomplete"): `aria-required-children` 64, `aria-valid-attr-value` 64, `color-contrast` 1,413 (1,412 at `e876960e`) and `label-content-name-mismatch` 868. Focus rings measured 3,984, 0 below 3:1, 0 without an indicator, 12 not focus-visible. Arabic: the six critical routes at zero leaks; of the 121 route keys with a leak count, 119 sit exactly at their committed limit, none above or below, 2 have no limit (report-only). Safety: 0 external provider requests, 0 provider mutations, 0 provider writes, 28 synthetic writes; write-journey outcomes accepted 4, refused 4, uncertain 4; the only non-empty `failed_responses` are the 16 not-found cases. The slowest axe inspection took 7,378 ms against a 20,000 ms deadline (1,047 ms at `e876960e`), and the run took about 3.5 minutes longer than the earlier one.

### 18.2 Container-layout parity and the full qualification profile

- **Container-layout parity**: `node tools/container-parity.mjs` from the clean public candidate with the dependency tree of the closing runs. On `e876960e`: exit 0, `passed: true`, 1,489 s. 3,610 files copied, 0 excluded by `.dockerignore`, `git_repository` false, Node v24.19.0, FFmpeg required, 2 test workers, one step (`npm_run_check`) with exit 0. Tests 10,380, pass 10,379, fail 0, skipped 1, cancelled 0, todo 0: main suite 10,376 (10,375 pass, 1 skipped) and capture suite 4 (4 pass). The one skip is the entrypoint ownership test (`# needs a POSIX sh`; the host's PowerShell PATH has no `sh`), the same skip as at `3b950b2d` (8,688 passed of 8,689). **Scope, as the record says: a layout check outside Git on Windows, not the Linux image.**
- **Container-layout parity on `7e409d1d`**: the same command in the public candidate of that revision, with the same dependency tree. Exit 0, `passed: true`, 1,703 s (the `npm run check` step 1,672,996 ms). 3,613 files copied, 0 excluded by `.dockerignore`, `git_repository` false, Node v24.19.0, FFmpeg required, 2 test workers, one step (`npm_run_check`) with exit 0. Tests 10,455, pass 10,453, fail 0, skipped 2, cancelled 0, todo 0: main suite 10,451 (10,449 pass, 2 skipped) and capture suite 4 (4 pass). The two skips are the history guard of P2C-03 (`# no .git here: a copy of the tree has no history to read`, which is the point of the layout check) and the entrypoint ownership test (`# needs a POSIX sh`; the host's PowerShell PATH has no `sh`, as at `e876960e`). The tool records skips and does not fail on them. At `e876960e` the run had 10,380 tests and 10,379 passes with one skip (the `sh` test); the added test is the history guard. Scope, as the record says: a layout check outside Git on Windows, not the Linux image.
- **Full qualification profile**: `node tools/qualify.mjs --profile full` in the public candidate. On `e876960e`, run 1 failed (exit 1) only because that one test was skipped (no `sh` on PATH) and the full profile fails on any skip that is not allow-listed; every later stage was `not_run`. Run 2 with Git's `usr\bin` appended to the end of PATH passed in 689 s: 10,380 of 10,380 tests (10,376 `test_suite` in 454.6 s and 4 `test_capture`), 0 skipped, `mutant_catalogue` 33 mutants 33 killed (121.8 s), `wire_contract_sweep` 26.1 s, `check_web` 17.0 s, `journey_evaluation` 6.8 s; 29 stages (28 passed, `sunset_alarms` recorded as an alarm). The 28 passed stages: build_typescript, build_release_identity, format_check, test_oracles_check, generate_check, generated_provenance_check, generate_vendor_check, generate_wsdl_check, generate_feeds_check, generate_cloudflare_check, generate_bids_check, report_check, contracts_check, contracts_actions_check, docs_index_check, locale_chunks_check, architecture_check, ffmpeg_probe, test_suite, test_capture, mutant_catalogue, wire_contract_sweep, meta_creative_features_pinned, check_web, journey_evaluation, providers_check, providers_lifecycle, providers_sunsets. These are the full-profile stages that F-L10-04 asked to return to the gate. The record's `scope` says: local synthetic qualification only, no provider, live account, Linux container or deployed acceptance implied.
- **Full qualification profile on `7e409d1d`**: `node tools/qualify.mjs --profile full --allow-skip "no commit reachable from HEAD touches a private path (P2C-03)"` in the public candidate, with Git's `usr\bin` at the end of the PATH from the start, so that `sh` resolves. Exit 0, result `passed`, 861 s (the record's own `started_at` and `finished_at` give 860 s), `failed_stages` empty; the record's `source_tree_hash` equals the candidate manifest's. Totals: 10,455 tests, 10,454 pass, 0 fail, 1 skipped, 0 cancelled; `test_suite` 10,451 tests, 10,450 pass, 1 skipped in 542.4 s, its `skipped_tests` the one named guard and `unexpected_skips` empty, and `test_capture` 4 of 4. 29 stages, 28 passed and `sunset_alarms` recorded as an alarm: `mutant_catalogue` 33 mutants, 33 killed (161.7 s), `wire_contract_sweep` 29.0 s, `check_web` 28.4 s, `journey_evaluation` 11.4 s; the 28 passed stages are the ones listed above. The record's `scope` says: local synthetic qualification only, no provider, live account, Linux container or deployed acceptance implied.
- **How the full profile on `7e409d1d` differs from the recipe of `e876960e` (ruling 20).** (1) It carries one `--allow-skip`. The tool fails any skipped test that is not named with it (`tools/qualify.mjs` and `docs/operations/QUALIFICATION.md`), and the test `no commit reachable from HEAD touches a private path (P2C-03)` (`tests/private-evidence-paths.test.mjs`, added by final-fixes after the recipe) skips whenever the working directory has no `.git`, as a release candidate has none. The recipe's command has no such flag, so by the tool's own rule it cannot pass on this head, and it was not run without the flag. The guard holds where history exists: run in the worktree, the test file passes 5 of 5 with 0 skipped, so no commit reachable from `7e409d1d` touches either private path. Inside the candidate the history of `7e409d1d` is not read by this run; the worktree runs read it. (2) It ran once, with `sh` on the PATH from the start (the recipe's own fix), so there was no run 1 that failed for want of `sh`.

### 18.3 The Work-here oracle (V2 plan D21) and the migration tests; the rollback drill is blocked

The tests that judge a rollback use the Work-here oracle: a vendored copy of the validator of Work-here at `4035ad7c` (`tests/fixtures/work-here-v3-validator.mjs`, with `tests/helpers/rollback-fixture.mjs` and `tests/helpers/editor-default-config.mjs`), which imports nothing from `src`, so what V2 stores is judged by what Work-here accepts. Run in the worktree with `node --test --test-concurrency=2`; the table gives the run on `e876960e`, and the paragraph after it the run on `7e409d1d`, which has the same counts:

| Run | Files | Result |
| --- | --- | --- |
| Rollback oracle | `tests/report-rollback-form.test.mjs`, `tests/report-rollback-visibility.test.mjs`, `tests/report-definition-sidecar.test.mjs` | 23 tests, 23 pass |
| Oracle users | `tests/report-library-requests.test.mjs`, `tests/report-library-audit-access-set.test.mjs`, `tests/workspace-audit-access-set.test.mjs` | 9 tests, 9 pass |
| v3 unchanged and migration | `tests/report-v3-run-unchanged.test.mjs`, `tests/report-v4-migration.test.mjs`, `tests/report-v4-schedule-migration.test.mjs` | 37 tests, 37 pass |
| Schema migrations | `tests/schema-migrations.test.mjs` | 8 tests, 8 pass |
| Storage boundary | `node tools/check-storage-boundary.mjs` | pass (12 modules outside the store layer hold SQL; 94 document kinds registered) |

On `7e409d1d` the same five runs (`node --test --test-reporter=spec --test-concurrency=2` in the worktree, with FFmpeg and Python set) exited 0 with the same counts: 23 of 23, 9 of 9, 37 of 37 and 8 of 8 tests pass, and the storage-boundary check passes (12 modules outside the store layer hold SQL, with 131 literals and 22 `json_extract`; 12 use the database handle; 8 document kinds are named by their SQL; 94 kinds registered). None of these test files changed between `e876960e` and `7e409d1d`, so the counts are the earlier ones, now against the final sources (16 `src/` files changed in the 15 commits).

What they pass, by the tests' own names: a corpus of 59 definitions Work-here accepts keeps a way back after V2 runs, edits or re-saves them, on every platform, including a report made with the editor defaults and one made by an MCP client that sends only levels; only what Work-here cannot express fails closed (several levels, ID scopes, statuses, undeclared detail windows, v4 metrics), and the owner can see it first (`rollback_safe` per definition, the bootstrap count of reports that stop on a rollback, the "Before a rollback" section of `docs/OPERATIONS.md`); a report edited on Work-here during a rollback keeps that edit after the roll forward, with a warning; each migrated stored definition is journalled once; v3 definitions and schedules run unchanged; a database newer than the release refuses with `SCHEMA_TOO_NEW` and changes nothing. A control shows that the vendored validator refuses what Work-here refuses.

**Blocked: no staging (V2 plan D20); never run:** the rollback drill of `docs/operations/MIGRATIONS.md` (start the previous image on a restored copy that the new release has opened); the volume backup, the encrypted backup and the measured `migration_ms` that the page asks for before any `schema_version` bump (none is pending: `schema_version` stays 2); a real saved report run on the real Work-here image after a real rollback; the restore drill and any backup of production data. The oracle is a copy of the validator of that build, not the build.

### 18.4 The probes of the target record (3, 8 and 12 to 21)

Each is answered at `e876960e` and again at `7e409d1d` by the test files named, run with `node --test --test-concurrency=2`, or by the browser run of 18.1. Every named test passed on both heads (on `7e409d1d` a script looked up each of 53 names and fragments as a passing line in 9 logs), and every row has the same result on both. On `7e409d1d` the seven probe runs total 14 + 22 + 16 + 64 + 26 + 124 + 16 = 282 tests, all pass; probe 12 is the oracle run of 18.3 and probes 20 and 21 also the browser `shell` kind. Probes 1, 2, 4 to 7, 9 to 11 and 22 were not asked for here.

| Probe | Answered by | Result |
| --- | --- | --- |
| 3. TikTok empty report, page fields 0 or missing: empty and complete | `tests/tiktok-report-completion.test.mjs` | 14 of 14 |
| 8. A failed unit of a three-level source: finished levels kept, report partial | `tests/report-failure-paths.test.mjs`, `tests/report-source-failures.test.mjs` | 22 of 22 |
| 12. A v4 definition read by the Work-here validator: accepted | the rollback oracle run (18.3), including the 59-definition corpus | 23 of 23 |
| 13. The V2 plan D22 note delivered once, never again, shown in History | `tests/report-notices.test.mjs` (and the migration run) | 16 of 16 (migration run 37 of 37) |
| 14. A task handle or continuation used by another tenant, and by another actor of the same tenant: refused | `tests/mcp-typed-probes.test.mjs`, `tests/mcp-tasks.test.mjs`, `tests/mcp-response-budget.test.mjs`, `tests/mcp-typed-filters.test.mjs`, `tests/mcp-typed-config.test.mjs`, `tests/mcp-typed-compat.test.mjs` | 64 of 64 (probes 14, 18 and 19 together) |
| 15. A native gateway upload after the annotation change stores nothing and answers `MEDIA_REVIEW_REQUIRED` | `tests/mcp-media-handoff.test.mjs`, `tests/mcp-v2-annotations.test.mjs` | 26 of 26 |
| 16. A chart title holding `</svg><script>` is escaped in every renderer | `tests/report-chart-render.test.mjs`, `tests/report-chart-pdf.test.mjs`, `tests/report-charts.test.mjs`, `tests/report-chart-table.test.mjs`, `tests/report-chart-parity.test.mjs`, `tests/report-chart-page.test.mjs`; the `granular-reporting` browser kind (16 of 16) fails if anything a chart draws opens a dialog | 124 of 124 (probes 16 and 17 together) |
| 17. A chart with two currencies is split or refused | the same run | 124 of 124 |
| 18. A truncated result continued with changed arguments is refused | the same run as probe 14 | 64 of 64 |
| 19. A client validating against `inputSchema` calls with an old `level` string: valid | the same run as probe 14 (a real SDK v2 client over the real HTTP stack in both protocol eras) | 64 of 64 |
| 20. A route change on a slow connection keeps the shell and header and lands focus correctly | browser kind `shell`, cases `loading` and `sections` (4 of 4 each); `tests/shell-loading.test.mjs`, `tests/shell-sidebar.test.mjs` | browser 8 of 8; units 16 of 16 (7 and 9) |
| 21. The sidebar at 800 px height, every group open, in Arabic: nothing clipped | browser kind `shell`, case `height` (12 of 12, six of them Arabic); `tests/shell-sidebar.test.mjs` | browser 12 of 12; units 16 of 16 (the same run as probe 20) |

A real slow connection on a deployed site is blocked: no staging (V2 plan D20).

### 18.5 The merge reports

Each merge was `git merge --no-ff --no-commit` by SHA, resolved, checked on the merged tree, committed with the subject `Merge package <name> into the V2 integration [skip ci]` and the two trailers, and reviewed by the lead before the integration branch moved. The reports are `.runtime/wave5-claude/impl/merge-<letter>-REPORT.md` (local, not in the repository); the numbers are copied from them and from the lead's gate2 lines in `STATE.md`.

| Merge | Packages (merge commits) | Final head | Checks copied from the report | Source |
| --- | --- | --- | --- | --- |
| A | stored `3d6c069d`, tiktok `359c000c`, objectives `df264c0f`, levels `78a9f5b5`, previews `e74bd708`, mcp `d152e020`, web-report `45bb1dfa` | `45bb1dfa` | The planner's selection 998 of 1,051 test files: 9,012 tests, 8,990 pass, 21 skipped, 1 fail (the expected no-FFmpeg test); `mcp-eval` 60 runs, 0 regressions; operator listing 97,181 bytes, reader 94,536; browser `granular-reporting` 16 of 16; `check:fast` failed only `report_check` (the stale status file, regenerated afterwards in `c4d72cc6`) | `merge-a-REPORT.md` |
| (engine-core) | engine-core `3425c4d8` | `3425c4d8` | gate2 `claude-r2-engine-core`: 9,401 of 9,401 tests, 0 skipped, 4 of 4 capture tests, 526 s, no report diff | `STATE.md` (the lead's line) |
| B | brand `2e41aced`, results `c883f1c1`, web-components `3fc2eaa2`, engine-surfaces `a9d0cdfd`, then route budgets `bee1db0e` | `bee1db0e` | `check:fast` passed (16 stages); the planner's selection 1,035 of 1,094 files: 9,351 tests, 9,329 pass, 21 skipped, 1 fail (the expected no-FFmpeg test); `mcp-eval` 60 runs, 0 regressions; browser `empty,components,granular-reporting` 334 of 334 | `merge-b-REPORT.md` |
| C | closing-fixes `0c8de036`, meta-results `bcf04347` and `06bf2140`, mcp-typed `0f634ee3`, web-shell `6dfb55f3`, charts `400258d9`, sec-hardening `bcd68382`, then route budgets `6c80be71` | `6c80be71` | Every test file: 1,138 files, 10,123 tests, 10,099 pass, 21 skipped, 3 fail before the route-budget commit (the no-FFmpeg test and the two route-byte tests); browser 430 of 430; `mcp-eval` 64 runs, 0 regressions; gate2 `claude-r2-merge-c`: 10,123 of 10,123, 0 skipped, 560 s | `merge-c-REPORT.md` section 7; `STATE.md` |
| D | sec-followup `f78ceb42`, mcp-surface `ea090d6d`, website-get `12e50cfb`, closing-small `e9720cae`, then route budgets `f7f43b54` | `f7f43b54` | Every test file: 1,156 files, 10,311 tests, 10,287 pass, 21 skipped, 3 fail before the route-budget commit; browser 434 of 434 and `export-outcomes` 4 of 4; `mcp-eval` 64 runs, 0 regressions on both profiles; legacy listing 97,253 / 94,857, v2 97,239 / 94,843; gate2 `claude-r2-merge-d`: 10,311 of 10,311, 0 skipped, 527 s | `merge-d-REPORT.md` section 6; `STATE.md` |
| E | linkedin-windows `8a3131b3`, sec-followup-2 `fe25d717`, then route budget `1f2e1c51` | `1f2e1c51` | Every test file: 1,165 files, 10,369 tests, 10,346 pass, 21 skipped, 2 fail before the route-budget commit (the no-FFmpeg test and `en /reporting-overview` over its budget); browser 436 of 436 (seven kinds, including `report-pdf-export`) and `export-outcomes` 4 of 4; one case failed once in the first run (`shell-feedback-connections-ar-…`) and passed in every re-run (its cause was found and fixed in Merge F); gate2 `claude-r2-merge-e`: 10,369 of 10,369, 631 s | `merge-e-REPORT.md` section 6; `STATE.md` |
| F | docs `747e805a`, then the browser runner fix `e876960e` | `e876960e` | Every test file: 1,166 files, 10,376 tests, 10,355 pass, 21 skipped, 0 fail; browser 436 of 436 and `export-outcomes` 4 of 4; the flake's cause (the case's own 500 interception stays on, so the Back target fails too) shown red 3 of 3 and fixed (`e876960e`: shell kind 68 of 68 three times in a row, seven kinds 436 of 436) | `merge-f-REPORT.md` sections 5 to 7 |
| G | final-fixes `19375498` (package head `d94dacfa`), nf-fixes `cc72be88` (`c4c424db`), jobcontrol `7e409d1d` (`323e3052`) | `7e409d1d` | Three clean merges, no conflict, no fix commit and no route-budget commit. Every test file: 1,168 files, 10,451 tests, 10,450 pass, 0 fail, 1 skipped (the entrypoint test that needs a POSIX `sh`), with FFmpeg set (the 20 FFmpeg tests ran); `check:fast` passed (17 stages, 96 s); `mcp-eval` 64 runs on each profile, 0 regressions (v2: 1 improvement, the listing); tool list unchanged (97,253 / 94,857; v2 97,239 / 94,843); `check-web` 60 of 60 routes with no route moved; docs lint 161,328 words (the baseline, +6 from final-fixes' own commit `9a89379a`); browser `granular-reporting` and `report-pdf-export` over https 18 of 18, no WCAG violation, 0 provider writes (a development subset, not a qualification); the pre-push scan from `e876960e`: 2,740 added lines, 0 hits in 14 patterns, 15 commits, 0 without `[skip ci]`. The lead's gate2 `claude-r2-merge-g` on `7e409d1d`: `check` exit 0 in 616 s, 10,451 tests, 10,450 pass, 0 fail, 1 skipped (the history guard of P2C-03: no commit reachable from HEAD touches a private path, which a candidate without `.git` cannot read), capture 4 of 4. The six closing gates on this head, all passed: 18.1 to 18.4 | `merge-g-REPORT.md` sections 3 to 5; gate2 `claude-r2-merge-g`: `.runtime/engineering-review/gates/claude-r2-merge-g/result.txt` and `check.log` (local, not in the repository) |

The 21 skips of the merge runs up to Merge F are the same in every full run: 18 FFmpeg tests (FFmpeg is not configured for those test runs on the host), 1 that needs a POSIX `sh`, and 2 bare `# SKIP` lines in their own files; gate2 up to Merge F ran with FFmpeg required and had 0 skipped. Merge G's full run had FFmpeg set and skipped only the `sh` test. Gate2 `claude-r2-merge-g` skipped one test, the history guard of P2C-03, because its public candidate has no `.git`; the same test file, `tests/private-evidence-paths.test.mjs` (5 tests), ran and passed in Merge G's own worktree, where the Git history exists (`merge-g-REPORT.md` section 3).

### 18.6 Not run

Blocked, no staging (V2 plan D20): every live read or write, the deployed site, the rollback drill on a restored copy, the real Work-here image, a real slow connection, the live real-client MCP checks. Not the Linux image either: the parity run is a layout check on Windows. Probes 1, 2, 4 to 7, 9 to 11 and 22 were not asked for at the closing gate. The browser run is one host, one browser engine (Chromium) and loopback HTTPS.

## 19. Git history and merge verification

Source: the history of the checkout read on 2026-11-14 with `git log`, `git diff --name-only` and `git ls-tree -r` (read only, no network). This section shows what each merge changed and where it differs from the package it merged. It is not a verdict on whether a merge was right: that is the lead's review before each merge moved the integration branch (section 12) and the gates of section 16.

### 19.1 The history

- **Heads.** The integration branch `claude/v2-integration` is at `7e409d1d` (local only; section 20). Its history holds 2,470 commits (membership test: `git log --format=%H 7e409d1d`).
- **Range.** `git log cfdbf507..7e409d1d` holds 462 commits: 433 without a merge and 29 merges (28 packages; `meta-results` was merged twice). `cfdbf507` is the last Codex application commit (section 3).
- **First-parent chain.** `git log --first-parent cfdbf507..7e409d1d` holds 39 commits: the 29 merges and ten others, which are the target record and its index entry, the status report, two baseline records (the collection golden and the architecture ratchet), four route-budget commits and the browser runner fix (table below).
- **Ancestry** (membership in the history of `7e409d1d`). The first Round 1 branch head `bdda0cbd` (`origin/Work-here-V2`), the baseline `4035ad7c` (`origin/Work-here`) and `cfdbf507` are ancestors. The Codex evidence commit `dc41950e` is not in the history, and no path of its package exists in the tree of `7e409d1d` (3,613 paths) or in the files changed from `bdda0cbd` to `7e409d1d` (`git ls-tree -r --name-only` and `git diff --name-only`: 0 hits). `origin/main` (`755f3de4`) is not an ancestor and is not part of this work.
- **The target record.** Its first commit, `97865657` (the local branch `claude/v2-target-record`, 2026-11-05), has the Codex evidence commit `dc41950e` as its parent, so it is not in the integration's history and is never published. The same record entered the integration as `b7d56c89`, cut from `cfdbf507`, with the same file content (`git diff` of the file between the two commits is empty).
- **Hygiene.** 0 of the 462 subjects lack `[skip ci]`. Every merge commit has two parents (none is an octopus), the subject `Merge package <name> into the V2 integration [skip ci]` and both trailers, `Implemented-By: Claude Sonnet 5.5` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (section 14 has the counts of the other commits).
- **Package heads.** The second parent of each merge is the package head. The branches of the three packages of Merge G are at the heads that were merged (`d94dacfa`, `c4c424db`, `323e3052`), and every one is an ancestor of `7e409d1d`.

### 19.2 The first-parent chain, merge by merge

Steps follow section 12: `target` is the lead's target record, `A` to `G` are the merges of that section and `engine-core` is the package merged alone between A and B. The columns, all from Git:

- **Package commits**: `git log --no-merges <first parent>..<second parent>`; **package files**: the files those commits changed (`--name-only`, each once; a file that the integration side already holds in the same version needs no change from the merge, so the other columns need not add up to this number).
- **Merge changed**: `git diff --name-only <first parent> <merge>`.
- **Same as package**: the merged file's blob id equals the package head's (`git ls-tree -r`).
- **Combined**: the package changed the file and the merged blob differs from the package head's, because the integration side changed the file too and the merge kept both changes.
- **Merge-only**: files the merge changed that none of the package's commits changed (listed below the table).
- **Not carried**: package files whose merged blob equals the first parent's and differs from the package head's, so the merge kept the integration side's version.

| # | Step | Commit | What | Package head | Package commits | Package files | Merge changed | Same as package | Combined | Merge-only | Not carried |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | target | `b7d56c89` | The independent target record (the lead) | | | | | | | | |
| 2 | target | `a3f677b5` | The target record in the docs index (the lead) | | | | | | | | |
| 3 | A | `3d6c069d` | Merge of the package stored | `feebee4f` | 10 | 31 | 31 | 31 | 0 | 0 | 0 |
| 4 | A | `359c000c` | Merge of the package tiktok | `f05c6803` | 18 | 33 | 34 | 32 | 1 | 1 | 0 |
| 5 | A | `df264c0f` | Merge of the package objectives | `8370ccbe` | 13 | 31 | 31 | 24 | 7 | 0 | 0 |
| 6 | A | `51b4a571` | The collection golden records the objectives package’s `objective_unread` row field | | | | | | | | |
| 7 | A | `78a9f5b5` | Merge of the package levels | `ccd8c9c7` | 18 | 66 | 66 | 46 | 20 | 0 | 0 |
| 8 | A | `e74bd708` | Merge of the package previews | `f39cf450` | 23 | 56 | 55 | 47 | 8 | 0 | `web/locales/ar/workspace.json` |
| 9 | A | `6f2c8d97` | The architecture ratchet records two more provider-prefixed names in the shared level table (limit 193 to 195) | | | | | | | | |
| 10 | A | `d152e020` | Merge of the package mcp | `f7b671aa` | 19 | 42 | 42 | 34 | 8 | 0 | 0 |
| 11 | A | `45bb1dfa` | Merge of the package web-report | `7f414227` | 12 | 28 | 28 | 19 | 9 | 0 | 0 |
| 12 | A | `c4d72cc6` | The status report regenerated after the first-wave merges (the lead) | | | | | | | | |
| 13 | engine-core | `3425c4d8` | Merge of the package engine-core | `5ac6a9f5` | 26 | 62 | 62 | 62 | 0 | 0 | 0 |
| 14 | B | `2e41aced` | Merge of the package brand | `426528c5` | 12 | 42 | 42 | 40 | 2 | 0 | 0 |
| 15 | B | `c883f1c1` | Merge of the package results | `62db262a` | 17 | 48 | 48 | 32 | 16 | 0 | 0 |
| 16 | B | `3fc2eaa2` | Merge of the package web-components | `11471399` | 19 | 62 | 62 | 41 | 21 | 0 | 0 |
| 17 | B | `a9d0cdfd` | Merge of the package engine-surfaces | `0b30f779` | 18 | 54 | 54 | 35 | 19 | 0 | 0 |
| 18 | B | `bee1db0e` | Route budgets of `en /report-library` and `en /reporting-overview` re-recorded at their measured values (V2 plan D13) | | | | | | | | |
| 19 | C | `0c8de036` | Merge of the package closing-fixes | `a3f75c4f` | 6 | 16 | 16 | 16 | 0 | 0 | 0 |
| 20 | C | `bcf04347` | Merge of the package meta-results | `ebc93efd` | 19 | 33 | 34 | 28 | 5 | 1 | 0 |
| 21 | C | `0f634ee3` | Merge of the package mcp-typed | `34575f6a` | 25 | 56 | 56 | 49 | 7 | 0 | 0 |
| 22 | C | `6dfb55f3` | Merge of the package web-shell | `e7aa8e9d` | 15 | 75 | 68 | 58 | 9 | 1 | 0 |
| 23 | C | `400258d9` | Merge of the package charts | `97003af1` | 21 | 97 | 101 | 75 | 20 | 6 | `docs/CURRENT-READINESS.md`, `tests/fixtures/tool-surface-golden.json` |
| 24 | C | `bcd68382` | Merge of the package sec-hardening | `b16e81f3` | 7 | 16 | 16 | 14 | 2 | 0 | 0 |
| 25 | C | `06bf2140` | Merge of the package meta-results | `3245643a` | 11 | 21 | 21 | 18 | 3 | 0 | 0 |
| 26 | C | `6c80be71` | Route budgets of Merge C set from the merged tree, with the Arabic report builder’s margin (V2 plan D13) | | | | | | | | |
| 27 | D | `f78ceb42` | Merge of the package sec-followup | `70da06de` | 9 | 18 | 18 | 18 | 0 | 0 | 0 |
| 28 | D | `ea090d6d` | Merge of the package mcp-surface | `3a8b4b7c` | 16 | 53 | 53 | 50 | 3 | 0 | 0 |
| 29 | D | `12e50cfb` | Merge of the package website-get | `0ef5f14b` | 12 | 18 | 18 | 13 | 5 | 0 | 0 |
| 30 | D | `e9720cae` | Merge of the package closing-small | `4588f382` | 8 | 34 | 34 | 29 | 5 | 0 | 0 |
| 31 | D | `f7f43b54` | Route budgets of Merge D set from the merged tree, with the Arabic report builder’s margin (V2 plan D13) | | | | | | | | |
| 32 | E | `8a3131b3` | Merge of the package linkedin-windows | `996a7054` | 22 | 24 | 24 | 16 | 8 | 0 | 0 |
| 33 | E | `fe25d717` | Merge of the package sec-followup-2 | `4d215294` | 12 | 26 | 26 | 25 | 1 | 0 | 0 |
| 34 | E | `1f2e1c51` | The route budget of Merge E set from the merged tree (V2 plan D13) | | | | | | | | |
| 35 | F | `747e805a` | Merge of the package docs | `5f8236f7` | 23 | 38 | 38 | 35 | 3 | 0 | 0 |
| 36 | F | `e876960e` | The shell feedback case removes its own overview refusal before it clicks Back (the browser flake of Merges E and F) | | | | | | | | |
| 37 | G | `19375498` | Merge of the package final-fixes | `d94dacfa` | 6 | 34 | 34 | 34 | 0 | 0 | 0 |
| 38 | G | `cc72be88` | Merge of the package nf-fixes | `c4c424db` | 4 | 15 | 15 | 14 | 1 | 0 | 0 |
| 39 | G | `7e409d1d` | Merge of the package jobcontrol | `323e3052` | 2 | 9 | 9 | 9 | 0 | 0 | 0 |

Merge-only files (nine, in four merges; each is an interaction the merge resolved, named in the merge report of its step):

- `359c000c` (tiktok): `tools/docs-lint-baseline.json`
- `bcf04347` (meta-results): `tests/fixtures/period-comparison-data.mjs`
- `6dfb55f3` (web-shell): `tests/monitor-source-contexts.test.mjs`
- `400258d9` (charts): `deploy/smoke-api.mjs`, `src/first-party-contracts.ts`, `src/report-tool-schema.ts`, `tests/mcp-typed-filters.test.mjs`, `tests/shell-loading.test.mjs`, `tools/locale-chunks.mjs`

### 19.3 Reading the table

- **Merges that equal their package.** In six merges (stored, engine-core, closing-fixes, sec-followup, final-fixes and jobcontrol) every file the package changed is the package's own version and the merge changed nothing else. In Merge G the 56 changed files are exactly the union of the three packages' files (34, 15 and 9 files, with `docs/REPORTING-OVERVIEW.md` and `tests/linkedin-overview-windows.test.mjs` in two packages each); the merged tree equals each package's version on its own files, except `docs/REPORTING-OVERVIEW.md`, which holds both packages' hunks (the lead's review of Merge G; `merge-g-REPORT.md` section 2).
- **Combined files** are where two packages touched one file, mostly the baselines, goldens, catalogues and documents that every package records itself in; the combined result was checked on the merged tree by the merge's own build, focused tests and the gates of section 16.
- **Not carried.** The previews merge kept the integration side's `web/locales/ar/workspace.json`, a catalogue chunk that `node tools/locale-chunks.mjs --write` regenerates (`.runtime/wave5-claude/impl/tiktok-REPORT.md`, local, not in the repository); Merge A's report states no reason for keeping it (MISSING). The charts merge kept the integration side's `docs/CURRENT-READINESS.md` and `tests/fixtures/tool-surface-golden.json`; both are named in Merge C's report (`.runtime/wave5-claude/impl/merge-c-REPORT.md`, local).
- **What this does not show.** Equal blobs show that a package arrived whole, not that it is correct; the red-then-green tests of each package, the lead's review of every report and diff, and the gate2 runs of section 16 are what say that. The merge reports (`.runtime/wave5-claude/impl/merge-<letter>-REPORT.md`, local, not in the repository) hold each merge's own checks (18.5).

## 20. Push status

When this record is written, nothing of Wave 5 after Round 1 has been pushed. This section records the facts that hold before the push. The push itself is reported in the lead's final owner report, because a file cannot record the push that carries it.

### 20.1 The remote state before the push

Read on 2026-11-14 from the remote-tracking refs of the checkout with `git log` (no fetch and no network access were used for this record):

| Ref | Commit | Commit date | Relation to the final head `7e409d1d` |
| --- | --- | --- | --- |
| `origin/Work-here-V2` | `bdda0cbd` | 2026-11-04 | an ancestor: the end of Round 1, 44 commits above the baseline, pushed by Codex |
| `origin/Work-here` | `4035ad7c` | 2026-10-31 | an ancestor: the protected baseline (wave 4c), untouched by Wave 5 |
| `origin/main` (also `origin/HEAD`) | `755f3de4` | 2026-09-26 | not an ancestor; not part of this work |

Both `origin/Work-here-V2` and `origin/Work-here` are ancestors of `7e409d1d` (membership in `git log --format=%H 7e409d1d`, 19.1).

### 20.2 What a push of the final head would carry

- `git log bdda0cbd..7e409d1d`: 482 commits, 453 without a merge and 29 merges. They are the 20 Round 2 application commits Codex made after Round 1 (`bdda0cbd..cfdbf507`, local only so far) and the 462 commits of the integration (433 without a merge and 29 merges, section 12). From the baseline `4035ad7c` the range is 526 commits, the 44 of Round 1 included.
- `git diff --shortstat bdda0cbd 7e409d1d`: 754 files changed, 92,806 insertions and 4,544 deletions. From the baseline `4035ad7c`: 790 files, 107,021 insertions and 6,580 deletions. From `cfdbf507`: 661 files, 80,564 insertions and 4,839 deletions.
- The Codex evidence commit `dc41950e` and its package are not in that range: the commit is not in the history, and no path of the package is in the tree or among the changed files (19.1).
- Every subject in the integration range ends with `[skip ci]` (0 of 462 lack it).
- This record, the runs record row, the readiness link and the regenerated status page and docs index are committed on top of `7e409d1d` in one or two commits that change documentation only. The head that is pushed is the head after them; the lead's final owner report names it.

### 20.3 The guards

- **The pre-push scan** is the lead's `prepush-scan.mjs` (`.runtime/engineering-review/amcp-engineering-review-20261008/work/`, local, not in the repository). It checks the added lines against 14 patterns (credentials and tokens of several providers, private keys, a personal mailbox, a local user path and the workstation account name), `[skip ci]` on every commit, that the tracked live-read sample is unchanged, and the private evidence (the commit `dc41950e` in the history; the paths of its package in the range or the tree). Its guard on the private evidence was tested: the Codex branch is refused, and `cfdbf507` and the integration branch pass (section 3). Merge G ran it from `e876960e` to `7e409d1d`: exit 0, 2,740 added lines, 0 hits in all 14 patterns, 15 commits, 0 without `[skip ci]`, private evidence: no commit in the history, 0 paths in the range, 0 in the tree (16.1).
- **The scan over the whole push range**, and over the commits that carry this record, is run by the lead before the push and reported in the final owner report. This file cannot hold the result of a scan of itself.
- **The baseline** `origin/Work-here` stays at `4035ad7c` as the rollback target (section 11); nothing in this work moves it.

### 20.4 States, kept apart

| State | Wave 5 after Round 1, at this record |
| --- | --- |
| Implemented and tested | Yes, as sections 6, 16 and 18 record; tests are local and synthetic |
| Committed | Yes, locally: 462 commits above `cfdbf507` on `claude/v2-integration` |
| Merged | Yes, on `claude/v2-integration` at `7e409d1d` (29 package merges, section 19) |
| Pushed | Not yet; `origin/Work-here-V2` is at `bdda0cbd` |
| Deployed | No: production runs the baseline `Work-here` (section 3) |
| Live-verified | No: every live line is blocked because staging does not exist (V2 plan D20) |

## 21. Remaining risks or blockers

**Blocker.** Live qualification: every ticket's "Live:" line needs the owner's staging (V2 plan D1 and D20), which does not exist yet; the lead's live write checks on the owner's named test accounts wait for it. Synthetic tests are never presented as live qualification. This alone makes the label BLOCKED (section 22).

**Owner ratification (needed before V2 is deployed to staging or production; the push to Work-here-V2 deploys nothing).** The dependencies beyond the approved list: `@modelcontextprotocol/node` 2.1.2, `@hono/node-server` 2.1.6, zod 4.6.6 and the overrides of body-parser, proxy-addr, qs, fast-uri, hono and ip-address (F-L10-02, F-L4-07, DR-04); an exit plan for `@modelcontextprotocol/server-legacy` (DR-02); `@modelcontextprotocol/ext-tasks` not approved, so the tasks extension is built in AMCP's server layer.

**Behaviour the owner should know.** Retained Meta captures and allocation proposals made before V2 cannot be compared, combined or reviewed against captures after it (rulings 7, 9, 11: refused with the field named). A client that sends a progress token on a long run is held up to 25 s. The website's navigation is drawn by script from the route registry; Home lost its first-name greeting (round 4 sign-off, V2 plan D25). The report builder carries the charts and the V2 layer (en /reporting-overview 222,517 Brotli bytes after Merge E, from 178,919 at bee1db0e); the Arabic report builder is at 0.983868 of its pre-WEB-07 bytes (591,768 of 601,471), 2,485 bytes under its 0.988 margin (rulings 8, 15; Merge F's report says 2,467, an arithmetic slip that Merge G's report corrects), and the trend of that page (0.9755, 0.9768, 0.9822, 0.983868) goes to the owner; `en /report-library` and `en /reporting-overview` have no headroom and `en /about` 5 bytes (`merge-f-REPORT.md` section 4). The per-client contract profile (V2 plan D26) has no switch yet: SDK clients cache their lists for 300 s, so a switch can show up to 5 minutes late; clients identified by a metadata document (CIMD) stay legacy; the profile lives on a client registration row that has no workspace, so Round 3's switch must be per workspace or per grant (P2B-04). Error toasts now stay until dismissed.

**Decisions still open (owner).** v4-only definitions fail closed on rollback (F-L10-11); INCOMPLETE_REPORT outside the provider-data category (F-L10-07); the Snapchat direct gateway signature; F-L2-01's window basis; TikTok v2.0 against v1.3; policy and key-pair-id redaction; reports of purged snapshots; the inline Sheets note; a memory limit before a large three-level client; F-L7-17's second half; F-L5-25's tolerance; nine read-only Meta reads; F-LEAD-02 on v3 (kept unchanged by V2-RPT-06, with or without a notice); the history of the two local branches that hold dc41950e (P2C-03); whether the V2 plan's decisions move into `docs/DECISIONS.md` under their own prefix (P2C-04); the design that stores rows apart from the report's header (NF-1b, candidate 2, a Round 3 item); the default approval mode for spend, cap and deletion (SE-03), which the lead's triage puts before the first live write check (round 4 or later, V2 plan section 10.1); the hardening items of the closing security skills, recommended as a Round 3 package (section 8.1).

**Production.** Production still runs the baseline (Work-here), with the gzip `/register` crash (F-L4-13) and the redaction gaps DR2-01 and DR2-02 until V2 ships; no production change is made in rounds 1 and 2.

**Unverified until staging.** The rollback drill on a restored copy and the real Work-here image (section 18.3); provider facts pinned from documentation only; Google GAQL not parsed live; Microsoft value-based metrics need a Campaign Management read; Apple's campaign report is not on the shared paging helper; Meta's `1d_ev` key and the action-stats lists other than `actions` were not read live.

**Residuals recorded, not defects of the release.** The post-patch validation's S4 residuals NF-3 to NF-13, which ruling 19 records for a Round 3 hardening package, none blocking: NF-4 and NF-5 go with SE-01; NF-8 (three classifiers with their own lists swallow `ACCOUNT_SCOPE_RESTRICTED`: the period loop, TikTok's v3 events read and the LinkedIn allocation read) is the class of LD-28, so nothing wrong is saved because the next guard raises the refusal, and Round 3 moves them onto the shared `accessRefusalCodes` and `jobControlCodes`; NF-12 is by design; NF-13 (the transport-refusal audit stores arguments uncapped) has the property of the pre-existing in-service audit, and Round 3 caps the stored arguments. Ruling 10's (a pasted `api_key: <token>` with a space is not refused, as at bee1db0e; `Authorization: Pending approval` refused; a Bearer token under 8 characters not refused); the pair-pass residual of P2A-01 and P2B-01 (a second credential inside the value run of an earlier `name=value`, unchanged since bee1db0e); ruling 18's glued-name residual (2 markers in 100,000 texts) and the credential view's non-idempotence for a folded Bearer token after an authorization header followed by `,` or `;` (477 of 3,000,000 texts, as in the old view); LinkedIn conversion rules cached within a job and replayed for later periods compare no login stamp; the read-only walk of ruling 12 covers one read and one write argument set per action (P2B-07); every route budget re-recorded under V2 plan D13 has no headroom; v3's other legacy failures in the TikTok ad group read, taken for "unavailable events" as old saved v3 reports were collected (a false reason, never a wrong saved value), the credential view and fuzzer cases of final-fixes' found-not-fixed items 1 and 4 (section 10), and the duplicated job-control code lists that could fold into the exported set (a cleanup, not a defect); the light third chart hue (2.77:1) relies on direct labels and the table, and a human contrast check of the dark Other and light third hue is worthwhile; the logo's trace roughness, no trademark clearance, and unused Android and social assets of the kit.

## 22. Final Round 1–2 acceptance

**Label: BLOCKED.**

The owner's mandate of 2026-11-05 says: "If mandatory verification remains blocked, preserve the work safely, identify the blocker, and do not claim final acceptance". One mandatory verification is still blocked, so the label is BLOCKED. It is not ACCEPTED, and no part of this record claims a live result.

### The blocker

Every ticket of Rounds 1 and 2 has a live line in the approved plan: reads on the owner's provider accounts, writes where the ticket has them, and the deployed site.

- **Live checks.** They need the staging environment that the owner sets up from `Work-here-V2` (V2 plan D1 and D20), with the platforms reconnected there. Staging does not exist, so not one live check has run. The one live read of this work, the owner-authorized Meta read of 2026-11-07, fixed the shape of a fixture. It qualified no V2 code (section 17).
- **Rollback drill.** The production move of V2 plan D21 needs the same environment, so its rollback drill is blocked too. The synthetic part of that move passed on the final head: the Work-here oracle and the migration tests (section 18.3).
- **Container image.** The container check checks the layout outside Git on Windows. It did not build or run the Linux image, because Docker is not installed on this host.

### What is verified on the final code head `7e409d1d`

These checks are synthetic, local and repeatable. Sections 16 to 19 give each figure with its source.

- **The full gate:** gate2 `claude-r2-merge-g`, with FFmpeg required. It ran 10,451 tests: 10,450 pass, 0 fail and 1 skipped. The skip is the history guard of P2C-03, which needs `.git` and passes in the worktree. The 4 capture tests pass too.
- **The closing gates, run again on this head after Merge G:**
  - container-layout parity: 10,455 tests, 10,453 pass, 0 fail, 2 skipped (that guard, and the POSIX-shell test);
  - `qualify --profile full`: 10,454 of 10,455 pass, the one skip being that guard, named by ruling 20. All 33 of 33 mutants are killed, and the stages Codex had dropped run again;
  - browser qualification over https in both languages and both themes: 1,524 of 1,524 cases, with no automated WCAG violation and no provider write;
  - the MCP evaluation: 64 runs on each profile, 0 regressions;
  - the Work-here oracle and the migration tests: 77 tests and the storage boundary;
  - the target probes: 282 tests.
- **Merge G's own checks:** every test file with FFmpeg set, `check:fast`, the website and docs checks, the two report browser kinds over https, and the pre-push scan (section 16.1).
- **Security:**
  - the differential reviews of Round 2 (parts 1, 2a, 2b and 2c) and the SDK v2 review;
  - the post-patch validation, whose two S3 residuals are fixed;
  - the closing insecure-defaults and sharp-edges skills.

  Nothing at S1 or S2 is open, and every item Rounds 1 and 2 introduced is S4 (sections 8 and 8.1; rulings 18 to 20).
- **The findings register:** 227 items. FIXED 186, RECORDED 35, OWNER 6, OPEN 0.

This record is committed on top of `7e409d1d` in commits that change documentation only. They pass the docs checks and the docs tests, `check:fast` and the pre-push scan. The lead's final owner report names the pushed head.

### The states of the work

- **Implemented, tested, committed and merged:** yes, every Round 1 and Round 2 ticket, within the limits that sections 6 and 13 name.
- **Pushed:** to `origin/Work-here-V2`, as a fast-forward from `bdda0cbd`, after this record. The final owner report confirms the push and the remote SHA.
- **Not touched:** `Work-here` stays at `4035ad7c`, and `main` stays at `755f3de4`.
- **Deployed:** no. Production keeps serving `Work-here`, and the lead confirms its digest is unchanged after the push.
- **Live-verified:** no.

### What moves this to ACCEPTED

1. The owner sets up staging (V2 plan D1, D20).
2. The lead runs the Round 1 and Round 2 live checks there. They are read-only, apart from the writes the plan names on the owner's named test accounts, under the owner's limits. They follow the plan's runbooks.
3. Every check passes, or the failure is fixed, gated and checked again.
4. The owner ratifies the dependencies beyond the approved list before V2 is deployed (section 21).

Then the label is decided again, on that evidence.

## 23. Readiness for Round 3
24. Addendum (2026-11-15): the Linux build of `b90e9fcb`, its fix and the go-live decision

**Not started.** Round 3 needs the owner's explicit authorization, and nothing of it has begun.

### Technically ready

- The integration head is gated and pushed.
- No finding is open.
- The architecture that Round 3's tickets build on is in place: the typed reporting contract, the per-client contract profile, the shell and components, and the report engine.
- Round 3 itself (V2 plan section 10.1) holds V2-PRV-04 to 09, V2-EXP-02 to 05, V2-MCP-03, 04, 07, 10 and 11, the per-client opt-in defaults of V2 plan D26, and V2-WEB-04.

### To settle before or during Round 3

1. **Staging (V2 plan D1, D20).** It lets the Round 1–2 live checks run and moves the label of section 22. The plan's own Round 3 live checks need it too.
2. **The owner's open decisions** (section 21):
   - ratifying the dependencies beyond the approved list and an exit plan for `@modelcontextprotocol/server-legacy`;
   - confirming the opt-in defaults of V2 plan D26;
   - the `INCOMPLETE_REPORT` category (F-L10-07);
   - v3 Meta reports under explicit windows (F-LEAD-02 on v3);
   - the per-workspace or per-grant contract-profile switch (P2B-04);
   - the report storage change, candidate 2 of ruling 17;
   - whether the V2 plan's decisions become rows of `docs/DECISIONS.md` under their own prefix (P2C-04);
   - the history of the two local branches that hold the Codex evidence commit, which must never be pushed as they are (P2C-03);
   - the other items of section 21.
3. **Before the first live write check** (round 4 or later, per the plan):
   - choose the default approval mode for spend, cap and deletion (SE-03);
   - add a registry-wide test that every family able to create a serving entity creates it paused or as a draft (SE-04).
4. **A security hardening package, recommended first.** It holds:
   - SE-01 with NF-4 and NF-5;
   - ID-01, SE-05, SE-06, SE-07, SE-13 and SE-14;
   - the residuals of ruling 19;
   - the full profile naming the history guard's skip itself (ruling 20).

   Each redaction change follows the differential method of rulings 10, 16 and 18.
5. **The recorded residuals** of sections 9, 10 and 21.

## 24. Addendum (2026-11-15): the Linux build of `b90e9fcb`, its fix and the go-live decision

Written by the principal engineer after the push of `b90e9fcb` (section 20).

**What happened.** Railway built `Work-here-V2` at `b90e9fcb` with the Dockerfile's `npm run check`, on `node:24-bookworm-slim`. That tag had moved to Node v24.22.3 (2026-11-10, a security release that bundles SQLite 3.54.1). 30 of 10,451 tests failed, so nothing was deployed and production kept serving `Work-here`:

- **29 report-scope tests.** From SQLite 3.54 on, a scalar subquery's JSON result loses its JSON subtype inside `json_array` and `json_object`: `json_array((SELECT json_group_array(...)))` is `[[]]` on 3.53.3 and `["[]"]` on 3.54.1. The saved reports' account selectors therefore reached the code as strings and were refused with `REPORT_SCOPE_UNAVAILABLE`. That SQL is in `Work-here` too (wave 4c), so a fresh `Work-here` build fails on that Node as well.
- **1 test of the browser runner's TLS helper.** Round 2 added it, and it needs `openssl`, which the Linux image does not install.

**Why the gates did not see it.** Every gate of sections 16 and 18 ran on one Windows host with Node v24.19.0 (SQLite 3.53.3), and the container check is a layout check, not the Linux image (16.5). The image's base tag floats. The build's own `npm run check` is what kept the failing image from deploying.

**The fix.** Package `sqlite354` (`904c186d`, `ffdba18f`, on `b90e9fcb`):

- `json(...)` now wraps the five JSON-valued scalar subqueries that a JSON function receives: the encoded and resource account selectors, the media library's usage references and resources, and the Operations feed's plan scopes. The text is the same on every SQLite version.
- A new test pins the nested values on the running SQLite. On Node v24.22.3 it failed 5 of 6 before the change.
- The TLS test checks the certificate where openssl exists and the tool's own refusal where it does not, and it checks the refusal on every host.

The checks that passed:

- **Every test file, on both Node versions.** 10,458 tests, 10,457 pass, 0 fail, 1 skipped on each (`.runtime/wave5-claude/impl/sqlite354-REPORT.md`, local).
- **Gate2 on `ffdba18f`, on both Node versions.** `claude-r2-sqlite354` (Node v24.19.0) and `claude-r2-sqlite354-n22` (Node v24.22.3): `check` exit 0 in 540 s and 539 s; 10,458 tests, 10,457 pass, 0 fail, 1 skipped (the history guard of P2C-03, which a candidate without `.git` cannot read); 4 of 4 capture tests. Results are in `.runtime/engineering-review/gates/` (local).

The Node v24.22.3 used here is the official Windows build, checked against nodejs.org's SHA-256 list and downloaded with the owner's approval of 2026-11-14.

**The go-live decision.** The principal engineer asked the owner which Railway service builds `Work-here-V2`, and whether a passing build may deploy V2 to production. On 2026-11-15 the owner answered: "Push, and V2 may go live". This push may therefore deploy V2.

- V2 goes live with the dependencies that section 21 lists for ratification before any deployment.
- `Work-here` stays at `4035ad7c` as the rollback target (V2 plan D21); v4-only definitions fail closed on it (F-L10-11).
- The deployment and the checks after it are in the principal engineer's final owner report, because this file cannot record the push that carries it.
- The label of section 22 stays BLOCKED. Going live is not a live qualification, and the live checks still need the owner's staging (V2 plan D1 and D20).

## 25. Addendum (2026-11-16): the live qualification on production, and the label decided again

**Why live checks now run on production.** Section 22 left the label BLOCKED because no live check had run, and staging did not exist (V2 plan D1, D20). On 2026-11-15 the owner moved production to V2 ("Push, and V2 may go live") and allowed live tests on production. They run on their agreed test accounts only, never a client account. Objects created for a check are named DNU, kept paused with no spend, and deleted right after the check. On 2026-11-16 the owner also named accounts for preview checks only: previews, and the reads a preview needs, with no reports and no writes.

So the lead ran the Round 1 and 2 live checks there, between 2026-11-15 and 2026-11-16:
- the reads through AMCP's own tools;
- the writes the lead made personally, under the owner's limits.

Every result is kept in local evidence, `.runtime/wave5-claude/live/r12-live-checks.md`, which is not in the repository.

**What the checks found, and what was fixed.** Each defect below was diagnosed live, fixed test-first, passed through the full release gate on Node 24.19 and Node 24.22.3, deployed, and checked again live:

| Ticket | Defect found live | Fix, gate, re-check |
| --- | --- | --- |
| V2-RPT-01 | TikTok reported a one-page report's row count as `page_info.page_size`, so AMCP refused every report of 1 to 999 rows (`REPORT_INCOMPLETE`, `page_not_echoed`) | r25-hotfix, deployed at `a5cc8e04`. Re-checked: campaign, ad group and ad levels complete (7/7, 14/14, 28/28); totals agree across levels |
| V2-RPT-05 (provider reads) | Reddit added a response field, and AMCP's pinned schema refused the whole account read | r25-hotfix: reads tolerate added fields and report them as `vendor_schema_drift`; writes stay strict. Re-checked: the read succeeds and names the added field |
| V2-RPT-07 | Snapchat leaves out its finalization times for a campaign with no data, so one empty campaign failed the all-campaign ad squad report | r12-fix, deployed at `43fed678`. Now an empty answer counts as no rows only with finalization evidence; otherwise the report is partial with a count. Re-checked: complete, totals equal the guided capture |
| V2-RPT-07 | X draft line items were not listed, so their promoted Tweets' parents were missing and the whole level was refused | r12-fix: reads include drafts; the ownership guard stays. Re-checked: complete at both levels, 0 unmatched |

**What passed live without a fix:**
- TikTok collection and objectives on ad rows (V2-RPT-01, 02).
- Meta campaign objectives without a hand-chosen objective, Meta results including the `1d_ev` key, and the three levels agreeing (V2-RPT-02, 03).
- LinkedIn campaign group and campaign levels with objective-led results (V2-RPT-04).
- TikTok results from the `result` metric (V2-RPT-03).
- Previews on Meta, TikTok and LinkedIn, with the documented account parameter and a rendered ad (V2-PRV-01, 02). The LinkedIn preview was checked again on a preview-only account after M0's wording change.
- The Snapchat preview link (V2-PRV-03): its shape on the agreed account, and, on a preview-only account, a link that opens without a sign-in (HTTP 200).
- The guided Snapchat ad squad capture (V2-RPT-07).
- GA4 reporting.
- The deployed MCP server answering a real client of the current protocol: over 100 calls, no protocol error (V2-MCP-13, ACC-02).

**Found live and fixed in M2; the live re-check follows the M2 deploy.** Neither item counts as passed until it is checked on the deployed head. Both results go in the next addendum.
- **Google shareable previews.** On a preview-only account, Google answered HTTP 200 and AMCP's response check refused the answer. So the call reported `WRITE_PARTIAL_OR_FAILED`, the links stayed in encrypted recovery storage, and the review summary had a blank entity. Nothing changed in the account. Fixed in r12-gpreview: the check accepts Google's documented v25 response and nothing else, the summary names the operation, and the remedy says the answer did not match AMCP's contract.
- **X Tweet previews.** These were not qualified until now. They are now qualified, in r12-xpreview, from X's public documentation and a read-only capture of the live answer. The preview link is returned only when it is X's own preview page, and X's HTML is never passed through.

**Not checkable on the agreed accounts, each for a reason outside AMCP:**
- **LinkedIn creative level (V2-RPT-02, 04).** The test account's only activity is older than LinkedIn's six-month creative window.
- **Microsoft Advertising.** The account is blocked by Microsoft, pending an appeal. Microsoft previews also have no preview AMCP can read.

**Dependency ratification (section 21).** The owner approved the plan's recommendation Q10 on 2026-11-15: "ratify, with the Node-parity evidence on the deployed commit". Every deployed head passed the full gate on Node 24.22.3, Railway's runtime, and on Node 24.19.0.

**The label: ACCEPTED,** with the exceptions above, each listed until it is closed:
- the LinkedIn creative level and Microsoft Advertising, which are platform limits, not AMCP defects;
- the Google and X preview re-checks, which are pending after the M2 deploy.

The label rests on two facts:
- Every Round 1 and 2 check that could run on the agreed accounts passed, or was fixed, gated, deployed and checked again.
- Production runs the qualified package: `/versionz` `matches_build`, and the package hash equals the gated one.
