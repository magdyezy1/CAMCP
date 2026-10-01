# Recent GA4 event observations — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `85239e1`. Batch 83 expands B20/B15/B24; no new provider write contract or dependency.

Measurement now combines the existing GTM configuration audit with an on-demand GA4 realtime aggregate read.
Choose one currently authorized GA4 login/property, 1–20 exact event names, a 1–30 minute window and optionally
one numeric stream ID. The website supports English/Arabic, exact integer strings, event summaries, minute/stream
details, request/return times and an inspectable source hash. No polling, event sending or retained report snapshot
is introduced. Missing event rows remain null; a returned zero remains the exact string `"0"`.

`amcp_workspace {action:"measurement_events",gateway:"ga4_native_action",account_id,connection_id,
requirements:{event_names,minutes?,stream_id?}}` returns `record_kind:measurement_events` and a handoff to
`/measurement`. The first-party property and optional stream must be exact positive numeric strings; the property
does not include `properties/`. Minutes default to 30. Event names retain case and spelling, including Unicode
letters/digits, and are bounded to 40 characters starting with a letter. Unknown requirement fields are refused.

The existing delegated `ga4_data_report/realtime` action issues the documented read-only POST to
`v1beta/properties/{id}:runRealtimeReport`. The exact case-sensitive event filter, optional stream filter,
`eventName/minutesAgo/streamId` dimensions, integer `eventCount`, inclusive minute range and 1,000-row limit
are fixed by the adapter. Three requests including transport retries, 1,000 rows, 2 MiB and 30 seconds bound the
collection. Current actor/account/login, Analytics read scope and credential identity are checked around the read.

Only the expected headers and exact event/minute/stream grains qualify. Changed headers, out-of-scope rows,
duplicate grains, unsafe/noninteger counts, row-count mismatch, continuation tokens, threshold/restriction flags,
unknown envelopes and provider errors fail. Canonical decimal count strings aggregate with BigInt. An empty
qualified response may omit rows and zero rowCount under ProtoJSON default rules; a nonempty response cannot.
Unknown provider fields are withheld. No raw provider object is returned.

Observed aggregate activity does **not** identify a particular test event or prove deduplication, consent,
attribution, conversion configuration or overall tracking health. A missing/zero count does not establish a
broken tag, and realtime processing can lag. Minutes ago refer to provider request processing, not exact event
timestamps. These limits appear beside the counts. The broader diagnosis/repair work remains partial.

Twelve new tests: eight backend cases, three website cases and one real-SDK journey. The original backend
baseline had four failing positive cases and three already-passing negative cases; the later Unicode case,
three UI cases and SDK discovery case were separately observed red. Focused **39/39** passed. The SDK checks
the published schema, both result envelopes, website handoff, invalid-window refusal and disabled-login refusal:
**3 calls / 3,281 structured bytes / one synthetic read-only POST / zero provider mutations**. Website tests cover
native request parity across English/Arabic, escaping, missing inputs, optional streams, missing results,
out-of-order results and changed form/route/identity/DOM. The result-details test stub now escapes like the real helper.
Static checks cover **32 browser scripts / 2,538 selected Arabic messages**. This is synthetic/VM evidence; actual
browser, assistive-technology and live/deployed GA4 acceptance are not claimed.

The delegated compiler probe confirms the existing native method, account binding and vendor-documented mapping.
Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**. No private root samples were read, and no production
deployment, authorization expansion or event mutation occurred. Local evidence: `.runtime/measurement-events-20261002/`.

Primary references checked 2 October 2026:
- [GA4 realtime request/response](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runRealtimeReport)
- [Realtime dimensions and metrics](https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema)
- [Event naming rules](https://support.google.com/analytics/answer/13316687?hl=en)
- [Event collection limits](https://support.google.com/analytics/answer/9267744?hl=en)
- [ProtoJSON default omission](https://protobuf.dev/programming-guides/json/)

Batch 82 exact committed-source qualification on `85239e1` passed all checks/Railway: **3,405 passed, zero failed,
five local FFmpeg skips; 77.14 seconds**, four capture tests, **1,492 public files + one generated empty sample**,
source hash `a9ebe89cef17d58eeb0866b378c27de10c5891ae71bf63dcb7b542e65ece4249`.
[CI137](https://github.com/magdyezy1/CAMCP/actions/runs/36940352973) and
[CI136](https://github.com/magdyezy1/CAMCP/actions/runs/36938607034) were still running at this check.
[CI135](https://github.com/magdyezy1/CAMCP/actions/runs/36936557694) succeeded on `b6edd65`: host and Docker each
passed **3,391 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110618075594` uploaded release-evidence artifact `11199411608`.

Root suite: **3,422 tests; 3,417 passed, zero failed, five local FFmpeg skips; 74.30 seconds**.


Sanitized preflight `.release/measurement-events-preflight-20261002` passed every check/Railway stage:
**3,417 passed, zero failed, five local FFmpeg skips; 77.27 seconds**, four capture tests, 32 browser scripts
and 249 documents. Its **1,495 public source files** plus one generated empty sample have hash
`894af954301eb1df851a95562a38201fa44f99540c03cfc9cccb08c267c59344`. Exact committed-source checks follow before push.
