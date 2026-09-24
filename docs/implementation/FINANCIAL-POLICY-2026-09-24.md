# Spending-policy arithmetic and native cap enforcement

Base: Codex-branch at 1605498aaeceddabe532210a6a5ae6a0a3e5f527.
Only the implementation checkout changes. This batch fixes shared financial policy
behavior; it adds no native actions and does not qualify an entire provider API.
The [machine checkpoint](FINANCIAL-POLICY-VERIFICATION-2026-09-24.json) retains
commands, original failures, hashes and sanitized candidates. Final full check passed; the completed result and candidate are recorded below.

## Confirmed defects and practical severity

**P2: Decimal boundaries were evaluated with binary floating-point arithmetic.**
The initial three regressions all failed: two native decimal creations of 33.10
and 33.20 were refused against a 66.30 daily cap; a REST.li change from 100.10 to
110.11 was refused at exactly 10%; a native string 100.10000000000000001 rounded
down and incorrectly passed a 100.1 maximum. The first two are realistic false
refusals at money boundaries. The third proves lossy policy interpretation; native
provider precision/minimum acceptance is not established by this synthetic value.
SQLite REAL SUM introduced another rounding boundary in persisted reservations.

**P1: Monetary policy did not account for explicit budget-cap clearing.**
Reviewed LinkedIn REST.li $delete and nested/null/empty money patches could be
accepted as zero increase even when an owner configured a finite numeric limit.
The same defect affected Snapchat JSON Patch remove. These paths require an
already authorized operator, enabled deployment writes and account write grants;
they are not unauthenticated attacks. They undermine the owner's independent
financial ceiling if a cap removal permits more delivery. Expected behavior is a
finite, policy-comparable replacement or a refusal before provider mutation.

**P1: Snapchat lifetime_spend_cap_micro was absent from the money mapping.**
A native patch raising 100000000 to 999000000 passed the local policy as zero
increase despite a maximum of 200000000. This field is an independently enforced
lifetime limit in microcurrency. The correction applies existing absolute,
percentage and cumulative controls to POST, collection PUT and JSON Patch.
An assertion-only JSON Patch test was conversely charged as a budget change; that
false positive is fixed while actual add/replace operations still count.

**Large aggregate edge, caught during implementation:** a reservation may sum
several valid native fields beyond Number.MAX_SAFE_INTEGER. Extracting its numeric
JSON value through SQLite INTEGER produced ERR_OUT_OF_RANGE on the next read.
The retained regression fails before the final reader and passes after it. The
individual field range is unchanged; aggregate arithmetic and persistence are exact.
This case is local storage evidence, not proof of provider acceptance of huge budgets.

## Implementation and preserved behavior

src/policy-decimal.ts uses bounded decimal coefficients/scales with BigInt.
Native string values retain decimal precision. Numeric JSON values use their
already parsed serialized value; the original lexeme cannot be reconstructed.
There is no rounding epsilon, foreign-exchange conversion or new runtime package.
Maximum 512 input characters / 324 fractional places, finite nonnegative values,
and the pre-existing safe per-field range remain explicit. Unsupported syntax,
overflow and underflow refuse rather than becoming zero. Percentages use exact
cross multiplication. Only positive deltas accumulate; decreases never offset them.
Equivalent decimal baselines compare equal; genuinely distinct baselines remain
ambiguous even if Number would collapse them to the same value.

src/spend-policy.ts retains owner selection, account/workspace precedence, UTC
windows, per-account allowances, read-only/activation/deletion gates and the
existing IMMEDIATE transaction. It streams only the current tenant/account/day
reservation rows selected in SQL and parses their original JSON text. It neither
loads lifetime history into JavaScript nor casts SQLite REAL values to rounded
text. SQLite still scans matching document-kind history using existing indexes;
this change does not claim constant CPU cost independent of history length.

New reservations store increase_decimal plus the compatible increase_native.
Responses similarly add requested_increase_decimal / reserved_today_decimal;
existing numeric fields remain. Legacy numeric-only reservations preserve their
recorded value, including historical rounding. Inconsistent new metadata refuses
execution. No SQL schema change/backfill/cleanup is required; receipts remain intact.

Budget inspection now recognizes explicit REST.li field deletion, JSON Patch
removal, null/empty/boolean money values and the exact Snapchat lifetime-cap key.
When a numeric owner limit applies, an unquantified cap removal is refused with
POLICY_AMOUNT_UNSUPPORTED. Unrelated field edits, explicit finite changes, native
integer units and policies without numeric limits keep their existing behavior.
Owner policies still do not replace native minimums, spending-to-date reduction
rules, funding, eligibility or delivery controls. A discovered mapping is not proof
that every inheritance/reset/default variant is qualified.

## Verification

- Original decimal regressions: 0 pass / 3 fail. First correction plus compatibility:
  51 pass / 0 fail. Expanded decimal tests: 12 pass / 0 fail, including independent
  SQLite workers, restart, legacy rows, current-day isolation and cent-valued oracle.
- Initial exact-decimal full candidate A: 1493 main + four capture pass; zero fail
  or skip, all npm run check stages exited 0 with required real FFmpeg.
- Native cap probes are retained in budget-cap-bypass-probe.json and
  snapchat-cap-bypass-probe.json under .runtime/contract-completion-20260924.
  The first Snap probe used the wrong patch URL and was correctly refused; the
  corrected account-scoped official route reproduced the policy gap. Do not treat
  that initial refusal as evidence the valid route was protected.
- All five original cap regressions failed before the mapping/removal correction.
  Final cap suite has eight tests, including real prepare/execute integration,
  policy changes after preparation, no mutation egress on refusal, correct native
  positive updates and STATE_CHANGED with the real lifetime-cap field named.
- Large SQLite aggregate: 0 pass / 1 fail before the final JSON-text reader.
- Final targeted suite: **97 pass / 0 fail / 0 skip**, including 13 decimal and
  eight cap tests, existing policy/Criteo/Apple behavior and executable guidance.
- Full candidate B: **1502 main + four capture pass, zero fail or skip**, all
  npm run check stages exit 0. Node 24.19.0, npm 11.17.0, Windows/PowerShell,
  bundled Python, portable FFmpeg/ffprobe 9.0.2 required. No private historical
  live-read fixture is read; the assembler supplies [].

The policy boundary is tested directly and through reviewed synthetic mutations.
No live campaign budgets, provider credentials or production data were accessed.
Linux/container smoke, deployed commit identity, provider approval and live write
acceptance remain separate verification requirements.

## Acceptance, rollout and rollback

Acceptance: exact cap/percentage equality passes; any strictly greater supported
amount fails; old and new reservations survive restart; independent workers cannot
overbook; cap removal cannot evade a numeric owner limit; finite Snapchat cap edits
use the scoped target baseline; meaningful provider state changes still conflict.
Existing independent reports, schedules, OAuth, media and reviewed-write checks
must continue to pass the complete release suite.

Ship the code and guidance together. Existing reviews are rechecked at execution;
there is no need to clear them or rewrite stored policies. Exercise known currency
and microcurrency amounts in an authorized staging account before production use.
Rollback binaries can read existing documents and ignore added decimal fields,
but restore old arithmetic and cap gaps. Disable affected writes during such a
rollback and retain all reservations/uncertain claims; never delete them to retry.

This fixes demonstrated shared policy defects. Remaining work still includes
provider-specific inheritance/implicit clearing/shared-budget transitions and
unqualified action families. Such concerns need their own exact before/after
scope and native evidence; this report does not claim those variants are safe.
The action ledger remains 432 reviewed-family and 888 blocked writes, plus other
explicit gaps in the current handoff. No count is inflated for these safeguards.

## Official evidence inspected 2026-09-24

- [ECMAScript Number type](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-number-type):
  binary64 arithmetic explains the observed boundary error. This is a rolling
  specification reference; verification uses the actual Node 24 runtime.
- [SQLite aggregates](https://www.sqlite.org/lang_aggfunc.html): floating SUM is
  approximate, integral SUM can overflow, and decimal_sum requires an extension.
  The implementation reuses the existing runtime instead of installing an extension.
- [Snap campaign rules](https://developers.snap.com/marketing-api/Ads-API/campaigns):
  distinct daily/lifetime limits, removability and microcurrency units; spending-
  to-date restrictions remain the provider's additional validation.
- [LinkedIn REST.li patch semantics](https://linkedin.github.io/rest.li/spec/protocol#partial-updates)
  and [campaign-group fields](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-09):
  $delete removes named fields, nested patches address records, and the native
  totalBudget is optional. Field/account eligibility still requires native acceptance.

Final full candidate: 571 files, tree b45a78eba2f874be584a5b3d96b4d3b26aee18f2b8bd5ce0cc8f1bb7d5288300.
Check log SHA256 7ed4351c9f147021a208c3ee95b3d7a516c18194eece96b9e0c896a861f949e5.
The final source delta is one corrected comment in spend-policy.ts; an exact
controlled text comparison proves unchanged logic. An optional TypeScript JS-API
comparison was unavailable in the installed TypeScript 7 package; that diagnostic
and the successful exact comparison are retained in the machine evidence. The
regular TypeScript CLI build passed. Static Railway Dockerfile compatibility and
git diff --check passed; neither establishes a live deployment or container run.

Final documentation candidate C: 573 files, tree eec1c11d151e0a790fb2fbec9ab010d3f0e15ed9e5a0d60c0eaba1f55dedfc5b.
The manifest delta is limited to evidence/handoff documents and the verified
comment correction; tests, generated files and guidance are byte-identical. The
full suite was not repeated for those nonfunctional changes. Subsequent edits
only record this verification evidence.
