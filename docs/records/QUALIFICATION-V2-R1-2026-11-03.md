---
status: record
tier: engineering
---

# V2 round 1 qualification completed 2026-11-04

This record covers V2-RPT-01, V2-RPT-02, V2-RPT-04, V2-RPT-05, V2-PRV-01, V2-PRV-02, V2-PRV-03,
V2-MCP-01 and V2-WEB-01. Implementation started from `4035ad7c` on `impl/v2-round1`. The owner assigned all
implementation, review and integration roles to one session; work was committed serially in the main checkout.
No lane merge was necessary. Existing detached reviewer worktrees were left alone.

**Local closing qualification passed on 2026-11-04 (Africa/Cairo).** Qualified head `ac9c5f48` was pushed to GitHub
and verified remotely. This receipt follow-up changes only the record.
The owner deferred live deployment and asked for the GitHub push (C11, 2026-11-03: "leave the live deployment for now,
push to github, live deployment in a later stage"). Task 29's live checks are blocked: no staging (D20). No live provider
acceptance is claimed. Production promotion belongs to the owner (D21).

## Implementation commits

| Tasks | Implementation and separate baseline commits |
|---|---|
| 1–2: error categories and source cards | `1ad98035` |
| 3: shared TikTok page rules | `387ba404` |
| 4: TikTok request shape and spans | `2b003d27`; recording `1d07b614` |
| 5: native totals and counts fallback | `99b8a5c7`; public coverage `e36542f5` |
| 6: source-owned objective tables | `d3d92657`; recordings `88bf2907` |
| 7: saved fallback and overrides | `9a59ca9d` |
| 8: parent objectives | `2cb32ce6`; recordings `cf6c3233` |
| 9: website fallback and provenance | `c93c10fc` |
| 10: LinkedIn native positions | `cfb082b0`; recordings `f01acbbb` |
| 11: group objective and Mixed | `037304aa`; recordings `2162b317` |
| 12: objective-led results and absent cost | `4e2fb6b6`; recordings `2a7fee18` |
| 13: UTC windows, retention and cap subdivision | `cf5fa6d7`; shared period allowance correction `fbaf94f5` |
| 14: source stamps and one-time notices | `a407a0e6` |
| 15: named previews, filters and signed paging | `8bd9744d`; golden `3a9ffac7` |
| 16: LinkedIn preview account, placements and expiry | `002b6994` |
| 17: scoped Snapchat signed links | `b85bc49b` |
| 18: next calls, polling and report handoffs | `dcb6f529` |
| 19: summaries, confirmation roles and contracts | `80dffc71` |
| 20: per-action limits and defaults | `da3a01a6` |
| 21: own help and guides | `3c9b78a4`; golden `6523277e`; translated validation reuse `db37a7af`; TikTok help correction `db528c16` and golden `fa3d9b83` |
| 22: executable reporting reference | `fb67f0ad` |
| 23: unloaded V2 tokens and brand pin | `823bf6ab` |
| 24: local Arabic WOFF2 subset | `b4142acb` |
| 27: final reference coverage | `7dc93e20` |
| 26: evaluation baseline (D14) | `a26860b2` |
| 26: reference-word total (D13) | `89966db9` |
| 28: delivery-history fixture dependency and notice escaping | `d0566cd7` |

## Decisions and compatibility

- Error diagnostics use seven closed categories. `INCOMPLETE_REPORT` remains a request-size limit rather than a
  provider-data retry code. MCP keeps its existing report family, and a code with its own remedy keeps that advice.
  Provider-data diagnostics omit the misleading HTTP badge while retaining sanitized provider details and page facts.
- TikTok reads the declared pages, rejects inconsistent or duplicate data, and retains fewer rows as partial in
  Overview. Comparable native totals decide completeness; otherwise counts decide. Guided evidence remains strict.
  The optional deleted-object filter has one refusal fallback with a warning. Daily windows use consecutive spans of
  at most 30 days within 366 closed advertiser-local days; campaign totals remain bounded to 365 days.
- Objective tables belong to the report sources. Campaign overrides and saved legacy choices precede provider
  resolution; fallback is last. Known unsupported values remain unknown. Mixed is a row label only. Google mappings
  are conservative; X line-item mapping remains deferred, Microsoft stays unknown with a reason, and Apple uses the
  explicit app-install mapping. Saved choices and unmatched overrides are preserved.
- LinkedIn uses campaign groups, campaigns and creatives in the three shared positions. Only delivered campaigns can
  establish a shared group objective. Qualified leads remain separate from one-click leads; reach is not additive.
  Absent cost becomes zero only with explicit zero impressions and clicks. Windows use UTC. Cap subdivision retains
  exact additive values and marks unavailable reach, missing entities and exhausted budgets.
- Closing review reproduced 62 and 124 analytics reads in a period because each metric batch/pivot reset its split
  allowance. The correction shares 32 reads across that period, preserves bounded partial output and prevents an
  incomplete companion from establishing the group objective. Both regression cases and the focused LinkedIn suite
  pass locally. Full reporting help also had one stale 31-day TikTok sentence; it now states 366 closed local days
  in spans of at most 30 days. The preset rules and public reference already stated the implemented limits.
- New source stamps and notices explain TikTok's changed historical totals and LinkedIn's hierarchy. There is no
  global contract bump or rewrite of retained snapshots. Objective regrouping can leave an old monitor incident open
  beside a new fingerprint. Overview conversion-rule attribution joins and cross-level comparison remain later work.
- Preview IDs, statuses, parent filters, account ownership and five-minute continuation bindings are checked before
  use. LinkedIn preview queries include the selected account and return only validated iframe sources. Snapchat's
  signed-field exception applies only to the exact read route, and only the documented browser URL is constructed.
  No preview URL is stored and no new external frame is loaded.
- Report/export next calls include five-second polling. A retry asks for confirmation through the user-approval addon;
  it does not silently authorize a mutation. Limits/defaults are per-action metadata and never fill caller input.
  Own help is local in every policy mode. The new root endpoint omits repeated summaries so the full description,
  schema and examples fit 40 KB; legacy help keeps its fields and captured schema. Stable `google_ads_v23_*` action
  identifiers and historical notes remain, while active version claims are current.
- V2 tokens remain unloaded. All legacy resolved values and the 283-byte brand mark are preserved. Contrast, density,
  fluid type and reduced motion are tested; data-3 requires direct labels. The Arabic browser subset is 68,180 bytes,
  retains weights 100–900, pins width to 100 and covers required Arabic characters. The original 844,676-byte PDF
  font is unchanged. The six approved font-tool versions were used in temporary folders and removed afterwards.
  One CSS comment was trimmed to retain the existing route budgets.

## Baselines and measurements

The tool-surface golden was recorded separately in `6523277e`; its native catalog, introspection and contract
sections were unchanged. The closing help correction in `fa3d9b83` changes only the three full-description service
digests, leaving every native section and default listing identical. Closing verification passes 14/14 with the
provider-version and docs-lint suites. The measured default
surface remains 25 tools: reader 94,468 bytes, operator 97,119 bytes, within the unchanged 95 KiB test.

Evaluation was recorded in `a26860b2` and the documentation total in `89966db9`. Reference words rise from 146,579
to 148,921 for the required coverage; current owner/operator pages remain 24,433 of 25,000 words. The evaluation
surface has 25 tools, 97,109 listing bytes and 1,534 instruction bytes, within its existing limits. No route,
response, token, colour or oracle allowance has been raised. The latest route measurements
include English Overview 177,596 / 177,616 bytes and About 15,777 / 15,848 bytes.

The full pre-baseline evaluation has 60 runs and no worse end state, handoff or tool-choice result. H1/guided improves
from a one-call dead end to the completed reference workflow: three calls, one approval and two synthetic requests,
with zero unnecessary calls. Its 3,952 response bytes are the aggregate of those three responses, matching the current
reference run; the old one-call dead end used 1,260. This intended completed-workflow cost is the planned D14
re-record, while the 40 KB response and 95 KiB listing tests stay unchanged. Both H1 and T7 reference/guided runs
reach success with `handoff_success:true`.

## Qualification results

| Check | Result |
|---|---|
| Per-task focused and related suites | Closing selection: 849 files, 7,685 tests, 7,684 passed, 0 failed, 1 existing POSIX-entrypoint skip on Windows |
| Closing LinkedIn cap regression | 80/80 focused tests; old cases made 62/124 reads, corrected cases stay within 32 |
| V2 tokens and localization follow-up | 69/69 focused tests; V2 related selection 125/125 |
| Arabic font and artifacts | 8/8 focused; related selection 147/147; original TTF and all required glyphs verified |
| Static web and route checks | Pass, 58/58 routes within their existing baselines |
| Closing fast qualification | Pass, no failed stages |
| Closing help correction | 44/44 affected help/preset tests, then 14/14 golden/version/docs checks |
| Full public candidate gate | `wave5-r1-gate-2`, source `1a7d7722`: 8,679/8,679 main tests and 4/4 capture tests, 0 failures/skips; every check stage passed with FFmpeg required in 515 s. First run had one isolated VM dependency omission, corrected in `d0566cd7` |
| Browser qualification | `wave5-r1-browser-3 --qualification`, source `1a7d7722`: 1,392/1,392 cases, 0 failures, 52.09 minutes of the unchanged 75-minute budget; exact candidate binding verified |
| Container layout parity | Passed outside Git with two workers and required FFmpeg: 8,682 passed, 0 failed, 1 POSIX-entrypoint skip, 8,683 total including capture; 1,331,019 ms. The skipped case passed in the Git Bash candidate. This is layout parity, not a Docker/Linux-image run |
| MCP evaluation | Canonical clean build: 60 synthetic runs pass, 0 regressions, no harness fault, 5,338 ms |
| Differential review | Manual source review of T, R, P, M and W against the base and representative rendered review completed; split allowance and stale help findings fixed; no unresolved source finding |
| Pre-push scan and remote reconciliation | Clean across all 43 published commits and 13,418 added lines; retained live sample unchanged; all required CI-skip/model endings verified. Fresh fetch confirmed an ancestor; push and remote head verification succeeded. The record-only receipt is scanned separately |
| Staging live reads | Blocked: no staging (D20); no live qualification operation performed |
| Deployment | Deferred by the owner (C11); no deployment operation performed |

The full gate used a filtered public candidate with a literal empty live sample and the reviewed local dependencies.
Its regenerated public reports matched the checkout. Synthetic requests and fixture writes are local evidence.
The fixture correction loads the same notice renderer required by the real route and adds a markup-escaping check;
all original download security assertions remain. Its focused delivery/notice suite passes 14/14. The differential
review was manual: no differential-review tool was exposed in the available catalogue.
No live provider/OAuth/production request, advertising mutation or real Sheets export was performed.
The protected local prompt was never read, staged or copied into a candidate. Arabic copy still requires the
owner/native-speaker review at the planned later sign-off.

## Rendered qualification and package binding

The accepted run started at 2026-11-03 23:26:49 UTC and finished at 2026-11-04 00:18:54 UTC. It ran every fixture kind:
120 distinct scenarios, 70 kinds and 22 presentation variants, matching the previous accepted round's coverage.
Playwright 1.62.1 used Chromium headless shell 148.0.7778.96 and pinned axe-core 4.14.0, engine SHA-256
`20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878`.

- Results SHA-256: `ee78fe4ced61d95c2cbcf701d4529bdba0bf524c35a2d26fd4ba7e9124126b42`.
- Package SHA-256: `90eb0d785dc5ecd453af21779bf2750412138078e4469d3b512a9c360433e8bb`, 2,166 files / 61,662,558 bytes.
- Browser input-map SHA-256: `dade19a5fbf76e057feb322ffd24a8456216c3be4ee3537641dc1cee7bfdc3ae`.
- The official browser attachment reports `bound_to_package:true` for the passing public candidate. Earlier
  interrupted runs are not accepted qualification. The browser's tracked tree was unchanged; `working_tree_clean`
  is false only because of an untracked file outside the release scope.

No selected automated WCAG A/AA rule was violated. All 3,878 measured focus indicators reached 3:1, with none missing;
the twelve unchanged `not_focus_visible` samples are the non-scrolling Connectors command block in empty/reviewer
fixtures. All six critical Arabic routes were probed at zero leaks. Accepted, refused and uncertain write journeys
each completed four times: 28 synthetic writes, 0 provider writes, 0 external provider requests and 0 unhandled
rejections. The slowest WCAG inspection took 685 ms of its 20-second deadline.

Incomplete rule counts match the previous accepted run exactly: color-contrast 2,648 and
label-content-name-mismatch 2,688. The icon-only navigation toggle and avatar initial retain their localized
accessible names; contrast checks that could not determine obscured backgrounds remain incomplete. The 33 new literal
selectors in the comparison are worker-health timing titles whose elapsed values vary between runs; no other new
incomplete target was found. These automated checks do not establish complete accessibility certification.

Representative English/Arabic, light/dark, narrow/desktop public and reporting screenshots were inspected, including
the Arabic export outcome. Arabic glyphs join and the sampled controls and tables remain contained and legible.
The later native-speaker, screen-reader and zoom sign-offs remain separate. Compared with the
[previous accepted round](QUALIFICATION-4c-r7-2026-10-31.md), coverage, incomplete-rule counts, focus results and
synthetic write outcomes are unchanged; duration is 52.09 rather than 55.0 minutes.

## Push boundary

Qualified head `ac9c5f487baa4509500e1204899744ab4890d28f` was pushed to `origin Work-here-V2` and verified by a
remote-head read at 2026-11-04 00:22:48 UTC. The update fast-forwarded the base; no force, other branch or tag was
pushed. This record-only receipt follows that publication; the local run journal records the final published head
including this receipt. Runtime and browser input digests remain those recorded above. No hosted CI or deployment
result is claimed. Live deployment remains deferred by the owner (C11); Task 29's live checks remain blocked: no staging
(D20).
