---
status: record
tier: engineering
---

# Arabic Operations and monitor controls — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `4bb4182`. Implementation: `482c4fb`. Batch 66 continues B24 through Operations and workbook/monitor controls.

Operations now translates filtering, pagination, original-work links, owner support-bundle controls, workbook-run
recovery and saved-query editing. Query confirmation names the account and number of active schedules to pause;
the original query revision, advanced JSON, created run and unsent state remain unchanged. Workbook schedule
editing translates frequency/day choices and complete change confirmations. Preview dates use the chosen
interface language and the saved/proposed clock timezone, while native recurrence values and numeric fields
remain exact. The existing English lowercase enabled/paused diff is preserved.

The monitor inbox translates incident triage, rules, evidence context, snooze/resume, version changes and personal
email controls. Authored state labels distinguish email-provider acceptance from confirmed mailbox delivery.
Rule/account names, original source definitions, attribution, thresholds, IDs, versions, provider guidance and
unknown codes remain original data. Advanced JSON, timezone, account and threshold fields use LTR isolation.
No notification recipient, retention policy, delivery transport or advertising authority is changed.

Four new tests were observed failing on missing Arabic behavior, then passed with the real controllers. They
compare complete English/Arabic request transcripts for original-run recovery, exact-query review/save,
schedule preview/save and personal notice opt-in/retry. Cancelled confirmation makes no mutation. Exact IDs,
versions, leading-zero money strings, clock values and measurement semantics are preserved. A schedule assertion
uses the runtime's real Arabic date formatter, avoiding an assumption about numeric versus named month styles.
Five existing isolated fixtures now load the real language helper; their original assertions are unchanged.
The related group passed **16/16**; the full suite passed **3,273 tests: 3,268 passed, zero failed, five local
FFmpeg skips, 72.68 seconds**. The final date assertion also passed all four focused tests.

The catalog contains **1,723 messages** and **1,622 required source messages**. The source checker now covers
operation-state and schedule-field display maps without translating their native keys. Fresh sanitized release
and exact-HEAD evidence are recorded in [PROGRESS.md](PROGRESS.md); ignored logs are in
`.runtime/operations-localization-20261001/`.

The matrix remains **13 implemented / 14 partial / 1 open**. Reporting, client, portfolio, measurement and commerce
screens still need translation. Visual/keyboard/assistive-technology qualification is unavailable while CUA cannot
initialize its kernel-assets path. These controller checks are synthetic, not browser, deployed or live acceptance.
