---
status: record
tier: engineering
---

# Delivery — exact synthetic GA4 test-identifier observation

Date: 2026-10-03. Baseline: `2b47ebc`. Repository/branch: `magdyezy1/CAMCP`, `Work-here`.

## Delivered behavior

Measurement can inspect a particular synthetic test identifier that the customer's own test instrumentation
already sent. This is separate from the existing recent aggregate event counts. The new
`amcp_workspace action:measurement_event_identity` requires an exact selected GA4 property/login, one exact
event name, an `amcp-test-` identifier and explicit property-calendar dates covering at most seven days.
An optional numeric stream ID narrows the observation. Expected count is a declaration from 1 to 1,000,
defaulting to one; it is never represented as provider evidence.

The existing event-scoped `customEvent:amcp_test_id` dimension must be uniquely registered in the selected
property. Fresh native metadata reads bracket one bounded core `runReport` read with exact case-sensitive
event/identifier/optional-stream filters. The workflow uses existing GA4 contracts and existing Analytics read
scopes. It does not register a dimension, send an event, retain a report snapshot or change provider authority.

Returned stream rows and summed counts remain exact decimal strings through BigInt arithmetic. Missing rows
produce a null count; an explicit native zero remains zero. Comparisons distinguish matching, higher, lower and
unobserved counts. A higher count invites investigation; aggregate counts cannot prove duplicate delivery,
consent, attribution or overall tracking health. Core reporting can lag and filters can suppress observations.
These three checks remain independently unverified. This is not a raw event trace or a realtime identity lookup.

## Qualification and authority

Selected metadata must identify the exact property, dimension names and integer event metric. Changed registration,
foreign rows, duplicate stream grain, noncanonical counts, sampling, thresholding, other-row loss, schema restrictions,
truncation, unknown timezone and incomplete row counts are refused. Collection is bounded to three requests,
1,000 rows, 2 MiB and 30 seconds across the existing native admission/retry accounting. It never silently pages
beyond the qualified report. An omitted native row count is unknown and cannot establish a complete empty result.

Current actor, selected account, enabled login, read permission and credential fingerprint are checked around
every read and before returning evidence. Source references preserve selected request projections, times and
hashes for the three observations. Arbitrary native private fields are excluded. Matching selected registration
before and after is a bracketed observation, not an atomic provider snapshot.

The real MCP SDK journey validates advertised arguments, obtains the exact count, follows a first-party website
handoff carrying the original property/login/event/identifier/dates/stream/expectation and refuses a revoked key
without another native request. Its initial revocation test passed the wrong arguments to the fixture store;
using the existing single-token revoke API corrected the test. No authority checks or assertions were relaxed.

## Website flow and browser evidence

English and Arabic forms expose the exact test scope, property dates, optional stream and declared expected count.
The browser can generate a UUID-based synthetic identifier locally, before the customer's separate test.
Generation clears prior evidence and focuses the identifier input; it sends no request. Original MCP handoffs
prefill only a currently selected property/login with a unique, valid bounded scope and make no automatic read.
Foreign, duplicate, impossible-date and overlong-period handoffs clear the selection instead.

Counts, dates, native names/IDs and timezone remain unchanged between languages. The readable result names the
comparison and the unverified checks; its expandable evidence retains source provenance. The interface validates
row scope, canonical counts, duplicate grain and aggregate/comparison consistency before painting. Edits,
navigation, identity changes, detached controls, generation and newer requests invalidate pending results/errors.

The actual local browser used an in-memory database and fake native transport that refuses all unqualified
origins/routes and mutations. Desktop 1280 × 900 and mobile 390 × 844 observations in both languages show
**two counts against one declared expectation**, event `purchase`, property `123`, stream `900`, dates
`2026-10-01`–`2026-10-02`, timezone `Asia/Riyadh`. Result focus moves to its heading; Tab reaches the named
table region; Enter toggles the source disclosure. The two-column table fits the 297 px mobile content width,
with the document at its 375 px client width. The maximum 74-character synthetic identifier and null count also
fit in Arabic. Missing-count text uses normal text sizing rather than the numeric metric size.

Screenshots and structured observations are local under `.runtime/measurement-identity-20261003/`. They are
synthetic browser qualification; independent assistive technology, full Arabic editorial review, deployed behavior
and live provider acceptance remain separate. No live provider request, event or production configuration changed.

## Regression and release evidence

Initial backend red observed six failures and one pass for the unavailable action; the early invalid-input pass
does not qualify a guard. Interface red observed two missing-workflow failures. Additional interface qualification
reproduced two failures for invalid handoff dates and foreign row presentation before their guards were added.
Completed focused regression: **85 passed / zero failed**. Full local regression before the final additional
absent-versus-zero presentation test: **3,725 tests / 3,720 passed / zero failed / five local FFmpeg skips;
93.52 seconds**. The final additional presentation test passes in the focused suite and is included in release
qualification. The initial full attempt's unavailable `python` command was corrected by selecting the bundled
schema Python runtime; the test remained unchanged.

All **33 browser scripts**, **2,879 selected Arabic messages** and **3,012 catalog entries** pass their checks.
Generated workspace contracts advertise the new action. The native ledger remains **3,247 actions / 167 families /
1,712 reads / 800 reviewed writes / 502 blocked writes**; no native route classification changed.
Sanitized release qualification is recorded below when complete.

Batch 109's exact committed `2b47ebc4b80f72980e815ac6b0b1575659ec69ef` candidate passed install/build/report/check/Railway:
**3,706 passed / zero failed / five FFmpeg skips; 90.29 seconds**, four capture checks, **1,572 public sources plus
one generated empty sample**, source hash `3b44fe6bb6469bce648ae3bf50580068803cd9cadf9fd2a8bce5fbe07c33d2f8`.
It was pushed only to `Work-here`. [CI163](https://github.com/magdyezy1/CAMCP/actions/runs/37092189149) on batch 108
passed **3,706 tests without failures or skips** on host and Docker, four capture checks, Railway and synthetic
read/write container smoke. Job `111114685062` logs were inspected; no downloaded artifact inspection is claimed.
[CI164](https://github.com/magdyezy1/CAMCP/actions/runs/37094122155) on batch 109 also passed. Job `111120425780` logs show **3,711 passed / zero failed / zero skipped** on host and Docker, four capture checks, Railway and successful synthetic read/write container smoke. Host and container full tests took 769.33 and 762.61 seconds. No downloaded artifact inspection is claimed.

The matrix remains **13 implemented / 14 partial / one open**. B20 gains exact selected aggregate test identity;
raw event tracing, deduplication/consent/attribution diagnosis and reviewed repair plans remain partial. B15/B16/B24
gain SDK and bilingual browser evidence. Other remaining capability and external acceptance requirements are retained.

## Official native references checked 2026-10-03

- [Registered custom definitions](https://developers.google.com/analytics/devguides/reporting/data/v1/advanced)
  and [DimensionMetadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/DimensionMetadata)
  support the exact custom API name and property-specific custom definition flag.
- [getMetadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata)
  and [runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport)
  define the existing read paths, selected dimensions and native request fields.
- [API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
  defines event/stream dimensions and event counts;
  [ResponseMetaData](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)
  documents the quality, restriction and timezone indicators checked by the projection.


Sanitized preflight `.release/measurement-identity-preflight-20261003` passed install/build/report/check/Railway: **3,726 tests / 3,721 passed / zero failed / five local FFmpeg skips; 91.42 seconds**, four capture checks, 33 scripts, 2,879 selected Arabic messages and 276 documents. **1577 public sources plus one generated empty sample** have hash `ec05a4000f38838d5ccb9a340479ae8de5c4e78001dd887e265ce8cf77b3bd78`. Exact committed-source qualification follows before the sole Work-here push.
