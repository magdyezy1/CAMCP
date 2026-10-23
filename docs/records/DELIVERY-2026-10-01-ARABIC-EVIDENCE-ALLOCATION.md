# Arabic evidence, report packs and budget allocation — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `ef551fa`. Implementation: `ce120ec`. Batch 70 extends B24 and closes a reproduced B02 controller gap.

Arabic now covers detailed Google/Meta evidence capture, native preset names, attribution-window choices, budget
scenarios, constrained allocation, the Google daily-budget conversion preview, unapproved draft confirmation and
report-pack content/HTML downloads. Complete messages retain interpolated account IDs, currencies, exact decimal
amounts, micros and revisions. Selected-language formatting applies to numeric model outputs and display counts.
Native action names, measurement definitions, diagnostic text, source hashes, URLs and saved evidence remain original.
English/Arabic request transcripts match, including selected attribution windows, completeness, exact floor/cap
strings, preview ID/hash and explicit draft consent. Unknown metrics remain unknown and accounts are not combined.

Downloaded HTML declares the selected language and direction, uses logical table alignment and isolates code.
Original CSV, evidence and HTML filenames stay unchanged. This does not change the server-generated PDF/Excel
artifact language or introduce a fresh provider query. Backend-authored analytical explanations still need their
own translation pass; native/custom diagnostics stay untouched.

**F-143 (medium):** original detailed-capture discovery/results did not check identity and form changes, older
scenario responses could replace newer input/results, and stale model errors remained visible. Capture completeness
could remain checked after measurement edits. Obsolete allocation callbacks could still submit/download and stale
allocation errors could escape. The original controllers were reproduced against `ef551fa` in an ignored harness.

Capture and scenario requests now retain form/view/identity generations and attempt order across each await.
Measurement edits reset the completeness declaration; its own checkbox remains usable. Old results/errors cannot
open or paint a newer view, newer captures/scenarios win, and current failures remain visible. Allocation submission,
results/errors and download callbacks check current form/identity and proposal sequence. Report-pack print/HTML
callbacks reject departed views. Already submitted retained-evidence writes are not cancelled or repeated.

All **nine new tests** were observed red against the original controllers. Four existing isolated fixtures now load
the real language helper with their assertions intact. The related group passed **29/29**. The catalog contains
**2,389 messages / 2,293 required source messages**. Full-suite and sanitized/exact-HEAD evidence is recorded in
[PROGRESS.md](PROGRESS.md); ignored logs are in `.runtime/evidence-localization-20261001/`.
The full suite passed **3,306 tests; 3,301 passed, zero failed, five local FFmpeg skips; 73.76 seconds**.
Fresh sanitized preflight passed every check/Railway stage: **3,301 passed, zero failed, five local FFmpeg skips;
77.74 seconds**, four capture tests, 29 browser scripts and 236 documents. Its **1,447 public source files** plus
one empty sample have hash `385910ae4e3b5f61438798d854113f425c6ce7dc61fea7183c9141cc5d29721a`.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
No dependency, migration, new policy, OAuth change, provider mutation, external message or production deployment
was introduced. Browser/keyboard/assistive-technology acceptance remains unverified because CUA cannot initialize
its kernel-assets path. The blueprint remains **13 implemented / 14 partial / 1 open**.

Batch 69 follow-through: exact HEAD `ef551fa3453ce1a64d21350ea708066241e6b55c` qualified in
`.release/client-localization-work-here-head-20261001`: **3,292 passed, zero failed, five local FFmpeg skips;
81.44 seconds**, four capture tests and all check/Railway stages. All **1,445 public source files** matched HEAD
bytes, plus one generated empty sample; hash
`8b5a9c264e3348f2cb623e196bead6350677d10486999c9c71df18797b13a749`.
The sole branch push started [CI124](https://github.com/magdyezy1/CAMCP/actions/runs/36909015724), pending at this
record's latest check. [CI122](https://github.com/magdyezy1/CAMCP/actions/runs/36904291286) passed on `680fac7`:
host and Docker each passed **3,280 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and
read/write container smoke. Job `110510828313` uploaded artifact `11184553898`.
