# Persistent feedback for current evidence capture

Batch 160 keeps failed guided-capture feedback beside the original submit control until the user
edits settings or explicitly submits again. The reason, recovery hint and original request
reference use the existing error formatter. A descriptive English/Arabic title and instruction
frame one role=alert / aria-atomic region. Form and submit aria-describedby include that region
only while the current failure is shown, preserving unrelated descriptions. Literal native
diagnostics are assigned with textContent. The shared toast and its timer remain unchanged;
this capture failure is handled once in the form, without a duplicate toast or forced focus.

The title says **Capture needs attention**, without asserting that every transport error proves
no report was saved. Current account/preset validation also uses this feedback before any capture
request. Existing target/settings, complete-declaration rules, provider wire inputs and workspace
binding focus restoration remain. New submission clears old feedback before awaiting the read.
Current settings edits clear it without reading the provider and retain the original completeness
invalidation. Superseded responses after setting, form, route or identity changes cannot paint
errors, open evidence or start a retry. Only another explicit submission makes a new read.

## Baseline and research

The existing capture handler rethrows a current failure to workspaceBind, whose toast hides after
6,000 ms. Two actual owned English/Arabic 375-pixel browser captures measured the result after
6,600 ms: the toast is hidden, the form has no visible request reference and no inline alert exists.
Each original malformed keyword capture stops after three synthetic reads and saves no report.
There is no live incident claim. These baseline artifacts remain in the ignored runtime.

The current [W3C error-identification explanation](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)
supports descriptive text for unsuccessful submissions. Its
[status-message explanation](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
describes exposing changes without taking focus. The
[timing explanation](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html)
distinguishes temporary messages with an alternative means of accessing the same information
from messages that disappear without that alternative. These informative sources guide this
scoped persistent presentation. Source/Chromium/description/focus checks do not by themselves
establish a previous WCAG failure, screen-reader interoperability or full accessibility acceptance.

## Connected verification

The first focused run passes 43 cases and fails thirteen legacy capture cases because their old
DOM doubles omit getAttribute/removeAttribute, newly needed for description links. The fixture
now models those native attribute methods and uses the original website error formatter. Its
current-capture assertion checks the visible persistent reason; original scenario/allocation
rejection, wire equality, completeness and stale-response assertions remain. Fresh verification
passes 57/57/0/0 in 1.740 seconds, including seven new meaningful controller tests. They exercise
all setting edits, explicit retry, original wire scope, current local target validation, preserved
unrelated descriptions, literal unknown diagnostics/API objects, silent superseded errors and
late success/failure after setting/form/root/route/identity changes.

The maintained served browser suite retains the original 192 cases, strengthens eight explicit
failed-capture/recovery journeys and adds eight delayed-response cases at English/Arabic
320/375/768/1280. Recovery checks the original API message/code/reference, authored inline message
and hint, single alert, form/submit descriptions, original submit focus, visible feedback after
6,600 ms, clearing on explicit measurement edit and a separate complete capture. The delayed
loopback response returns the original failed capture after the user edits attribution; its
obsolete message stays silent and the changed settings remain. Only a separate explicit submit
retains valid evidence. Every original row still downloads after retained match filtering.
All provider responses are fixed synthetic reads; actual egress and mutations are zero.

Only two authored Arabic messages are added, preserving every prior 3,828 pair. The website gate
passes 34 scripts/four pages and 3,622 explicitly selected messages. The native collector,
presets/mappings/workbooks, authorization, error envelope/formatter and shared binding remain
unchanged. Final full and rendered qualification results are recorded below.

## Release boundaries

Fresh sanitized build/report/default full checks require FFmpeg and zero skips. Only three
validated public report artifacts may return to the checkout; root private samples remain
unread. Exact committed-source and clean-head browser qualification precede the sole guarded
Work-here push, with the final [skip ci] documentation commit. Hosted Actions remains owner-skipped.
Independent assistive technology, engines/devices, current Linux/Docker, deployed Railway and
live-provider acceptance remain separate. B15/B16/B24 advance within this qualified local scope;
the whole-plan count stays 13 implemented / 14 partial / one open and work continues.

## Stable submit identity correction

The first maintained browser attempt reaches 192 passed / eight failed among 200 cases. The
new focus assertion catches a pre-existing capture submit without an ID or data key: the shared
focus helper therefore falls back to the form’s first control after disabling the button. An
explicit stable capture-submit ID now lets that unchanged helper return to the original submit.
The later alternating recovery failures are fixture-phase fallout from the earlier aborted case,
not separate native acceptance evidence. No focus assertion is removed. The first full sanitized
suite passes 4,379/4,379/0/0 and capture 4/4/0/0, but this earlier source/browser attempt remains
diagnostic. Fresh corrected-source full and maintained browser gates must qualify the complete fix.

## Local gate follow-through: optional worker health and render readiness

The corrected-source full check passes 4,378 of 4,379 tests with zero skips and fails the actual
four-process queue test at BEGIN IMMEDIATE during a worker health write. The original isolated
five queue tests pass, but a separate owned two-connection SQLite baseline reproduces the exact
ERR_SQLITE_ERROR / errcode 5 refusal while a writer lock is held. This is a real contention case,
not a disposable-file cleanup failure. No failed source is published.

ReportWorker.heartbeat now returns false only for SQLite BUSY health/cleanup contention. It does
not advance a failed observation or cleanup timestamp, and the next existing cycle tries again.
Missing or old observations remain not_observed or stale under the original 90-second health
rule. Other SQLite failures and unexpected exceptions still propagate. Critical job claims,
lease renewal and result transactions retain their original behavior. In particular, a blocked
health update no longer aborts a completed job or prevents independent lease renewal, while a
failed critical renewal still withholds the result. No transaction callback or provider mutation
is automatically replayed; Store and its five-second busy timeout remain unchanged.

Four new regressions use actual two-connection SQLite writer locks: recovery without inventing
health; critical writes still refused; initial/working/final health failures preserve exactly one
completed result; independent original lease renewal succeeds despite busy health, while critical
renewal failures and non-busy health errors retain their failure rules. These four tests plus
existing multi-process concurrency, queue and operations tests pass 19/19/0/0 in 7.900 seconds.
The [SQLite transaction documentation](https://www.sqlite.org/lang_transaction.html) describes
one simultaneous writer and BEGIN IMMEDIATE contention. The
[busy-handler documentation](https://www.sqlite.org/c3ref/busy_timeout.html) explains the bounded
wait and eventual BUSY result. The installed
[Node 24.19 SQLite API](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)
executes synchronously. These primary sources support the narrow failure boundary, not a
production throughput or database migration claim.

The corrected maintained browser attempt passes all sixteen current/stale error journeys and
199 of 200 overall cases. Its sole failure counts zero headings on an empty Connections page
before the asynchronous render finishes, with no page error, failed response or external request.
The maintained check now awaits a visible primary heading within its existing timeout before
retaining the original exact count and visibility assertions. No wait timeout or assertion is
weakened. Fresh full and served-browser gates qualify this complete follow-through before commit.

## Complete working-source qualification

The fresh sanitized follow-through passes install/build/regenerated report/freshness/default full
checks/Railway: main 4,383/4,383/0/0 in 194.050 seconds; capture 4/4/0/0 in
76.2556 ms. Required FFmpeg runs with zero skips. The candidate contains 1,795 public
sources and one generated empty sample, digest da3e2abc200c80c7c51d0ed6c2ed7a97ccf6321d16cacdfc15155ae4d1a93d0b.
All three public reports regenerate identically and retain their tracked bytes; private root samples
stay unread. The actual four-process queue and new held-writer tests pass in this default full run.

The maintained browser suite passes 200/200/0, 2026-10-05T00:12:05.268Z through
2026-10-05T00:19:10.107Z, website digest 0fc083d0303ac319195c8c89e09f376df252009fbe36f9aa2b662a395b9fbdf7.
All eight current failures remain visible after 6,600 ms with original reference, hint, form/submit
descriptions and submit focus. All eight delayed obsolete failures stay silent after settings edits.
Forty populated retained-report journeys inspect 1,368 original downloaded rows, 360 original
44-pixel controls and 160 retained labeled 16-pixel fields. Earlier native values and workbook
assertions remain. Provider egress/mutations are zero. Fresh exact committed-source and clean-head
browser checks follow before the sole Work-here push; Actions remains owner-skipped.
