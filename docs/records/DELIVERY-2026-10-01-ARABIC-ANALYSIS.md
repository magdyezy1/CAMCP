# Arabic analytical explanations with original evidence — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `f31aee7`. Implementation: `5fd964d`. Batch 71 extends B24 without changing recommendation decisions or native write scope.

Arabic now explains the selected first-party campaign recommendations, decision-analysis proposals, confidence
labels, scenario/allocation limitations, budget-preview meaning and report-pack caveats. A restricted 42-message
set identifies authored analytical prose; other text remains original even when it coincides with an ordinary UI
label such as `Home` or `Complete`. The catalog checker extracts the specific explanatory positions from seven
backend modules and compares them with that display set. New, missing or unrecognized entries fail validation;
provider error text, protocol fields and user context are excluded.

New missing-target recommendations add `reason_localization:{key:'target_required',kpi,currency}` alongside the
unchanged English reason. The website renders this known structured message with the exact KPI and currency.
Unknown metadata and older dynamic reasons without that metadata retain their original text; the UI does not
parse or rewrite legacy prose. Recommendation thresholds, evidence, decisions, separate review requirements and
`automatic_execution:false` remain unchanged. Existing saved snapshots are not migrated or rewritten.

Only display text is translated. Raw JSON/source references keep the original explanation and data; no translated
message becomes an input to a recommendation, provider request or budget calculation. The real scenario,
allocation, report-pack and snapshot renderers are exercised in Arabic, with unchanged native values and objects.
Six new tests were observed red before implementation: four focused boundary/metadata checks and two controller
integration cases. The related group passed **45/45**. The catalog covers **2,442 entries / 2,346 required messages**.
Full-suite and sanitized/exact-HEAD qualification are recorded in [PROGRESS.md](PROGRESS.md). Logs are retained
under `.runtime/analysis-localization-20261001/`.
The full suite passed **3,312 tests; 3,307 passed, zero failed, five local FFmpeg skips; 78.25 seconds**.
Sanitized preflight `.release/analysis-localization-preflight-20261001` passed every check and Railway stage:
**3,307 passed, zero failed, five local FFmpeg skips; 77.56 seconds**, four capture tests, 29 browser scripts and
237 documents. Its **1,449 public source files** plus one generated empty sample have source-tree hash
`cb3509529a9a2b06a91f5d316e1d6fa958509b588665ee66f3de7042eed8f93f`.
Exact committed-source qualification follows before the only branch push.

Native ledgers retain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
No dependency, migration, new policy, OAuth change, external message, provider mutation or deployment was introduced.
Actual browser/keyboard/assistive-technology acceptance remains unverified because CUA cannot initialize its
kernel-assets path. Legacy diagnostics, full Arabic editorial/visual acceptance and server PDF/Excel artifact
language remain separate work. The blueprint remains **13 implemented / 14 partial / 1 open**.

Batch 70 follow-through: exact HEAD `f31aee7aedd1addd0226fde19075eba11702f5e6` qualified in
`.release/evidence-localization-work-here-head-20261001`: **3,301 passed, zero failed, five local FFmpeg skips;
77.84 seconds**, four capture tests, all check/Railway stages and byte parity for **1,447 public source files**
plus one generated empty sample. Hash: `36dcb3a98f5af129f620857c575ef7898443c204eeb05a7ccd22aad5ec5e26ca`.
The only branch push started [CI125](https://github.com/magdyezy1/CAMCP/actions/runs/36911219779), pending at this
record's latest check. [CI123](https://github.com/magdyezy1/CAMCP/actions/runs/36907141904) passed on `ac1be5f`:
host and Docker each passed **3,288 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and
read/write container smoke. Job `110520402471` uploaded artifact `11187210210`.
