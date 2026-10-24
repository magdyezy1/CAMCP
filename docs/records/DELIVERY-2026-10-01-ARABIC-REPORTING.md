---
status: record
tier: engineering
---

# Arabic report building and delivery — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `96da3d6`. Implementation: `27590d1`. Batch 67 continues B24 through report building, library/snapshot display and delivery controls.

Arabic now covers saved report/template selection, account and objective choices, custom metric controls, reporting
windows, measurement context, source health, snapshot history, delivery destinations and recurring schedules.
Whole messages keep interpolated names, counts and dates in context. Authored metric/state/objective labels are
translated separately from custom labels, formulas, native metric names, source evidence and provider diagnostics.
Displayed numeric values and report dates follow the chosen Arabic interface; precise strings and UTC calendar
dates stay intact. English date formatting retains its existing viewer-locale fallback.

Report table alignment and spacing use logical CSS properties. Formula, metric identifier, native-field, currency
and timezone inputs are isolated left-to-right. These are source/controller checks; visual, keyboard and assistive
technology acceptance remains unavailable because CUA cannot initialize its kernel-assets path.

Seven new controller tests compare English/Arabic requests and rendered results. Six were observed failing on
the missing translations/locale before implementation; the seventh exercises the final rendered snapshot and
quality evidence. They preserve exact account IDs, custom names/formulas, original query values, both saved
revisions, schedule frequency/weekday/hour/minute and distinct delivery/reporting timezones. File formats and
retention consent remain unchecked; missing consent sends nothing. Cancelling deletion sends nothing. File links
retain the original export ID and allowed extension, ignoring supplied download URLs.

The locale checker also now follows conditional message alternatives: an added guard assertion failed before the
change, then passed. Catalog coverage includes the authored report label map and metric-definition labels, without
translating keys, aggregation/formula contracts or provider fields. Four existing isolated reporting fixtures load
the real language module with their original assertions intact. The related group passed **25/25**.
The catalog contains **2,103 messages**, with **2,007 required source messages**. The full suite passed
**3,280 tests: 3,275 passed, zero failed, five local FFmpeg skips; 81.46 seconds**. A fresh sanitized preflight
passed all check/Railway stages with the same counts in **80.76 seconds**, plus four capture tests.

Full suite, fresh sanitized candidate and exact committed-source evidence are recorded in [PROGRESS.md](PROGRESS.md).
Ignored logs remain in `.runtime/reporting-localization-20261001/`. The native action/family ledger is unchanged.
No dependency, migration, provider authority, recipient, retention policy or real external operation is introduced.

The matrix remains **13 implemented / 14 partial / 1 open**. Detailed evidence/allocation, client/report-pack,
portfolio, measurement and commerce interfaces and server-authored analytical explanation localization remain.
Browser and live-provider acceptance are separate from these synthetic checks.

Batch 64 follow-through: [CI119](https://github.com/magdyezy1/CAMCP/actions/runs/36894503267) passed on
`6bda0ad3b73e6160fe443abe5e9dd37c36e20cb2`. Host and Docker each passed **3,262 tests**, zero failures/skips,
required FFmpeg, four capture tests, Railway compatibility and read/write container smoke. Job `110477978933`
uploaded artifact `11181134142`. These results qualify that revision in CI, not a production deployment.

Batch 65 follow-through: [CI120](https://github.com/magdyezy1/CAMCP/actions/runs/36898306436) also passed on
`4bb4182fb571a4b4006cb0cc8bdc73291dc41b2e`. Host and Docker each passed **3,269 tests**, zero failures/skips,
required FFmpeg, four capture tests, Railway and read/write container smoke. Job `110490800200` uploaded artifact
`11182351125`.

Batch 66 follow-through: exact HEAD `96da3d612f615f0ba2a8d2fda8eed4ec3be72d58` passed fresh qualification in
`.release/operations-localization-work-here-head-20261001`: **3,268 passed, zero failed, five local FFmpeg skips;
77.37 seconds**, four capture tests and all check/Railway stages. All **1,439 public source files** matched HEAD
bytes plus one generated empty sample; source-tree hash
`6ce64a92cc0eb85d5f638ce253892708b5536752aacd83c45c7b589d16a8cd48`. The sole branch push started
[CI121](https://github.com/magdyezy1/CAMCP/actions/runs/36900882222), pending at this record's latest check.
