---
status: record
tier: engineering
---

# Snapchat native lead submissions and source-preserving performance — 4 October 2026

Batch 126 extends guided reporting to 19 presets across five platforms. New
`snapchat_campaign_leads`, `snapchat_adsquad_leads` and `snapchat_ad_leads` presets retain daily
submitted native-form counts with exact spend micros, impressions and swipes. Counts use `native_leads`;
missing counts remain unknown, including partial metric coverage, and integer strings retain precision beyond
JavaScript's safe numeric range. This does not read submitted lead records or establish lead quality.

The current account, currency, timezone and authorization are checked before and after bounded complete pages.
Every page must have non-conversion metric finalization through the selected end. The original purchase presets
retain their separate conversion processing and explicit swipe/view attribution requirements. Native-form
presets omit purchase windows, conversion-source flags and conversion-time controls and refuse those caller
inputs. Their generated measurement definitions replace unsupported caller claims. Optional native processing
metadata is omitted when absent, preserving real SDK text/structured parity.

Ad-squad and ad native-form capture requires the exact campaign UUID, observed in the account's bounded campaign
collection and independently checked before and after stats. This uses campaign stats rather than widening a
global parent scope. Campaign capture stays account-scoped. Original account/day/parent/cursor/row-budget and
current-authority guards are preserved. Comparisons require compatible presets, native definitions and original
parent campaigns; native lead and purchase results cannot be silently combined.

English and authored Arabic capture forms distinguish these counts, disable inapplicable purchase controls and
require a parent only for qualified child presets. Switching back restores the original purchase controls. Exact
wire values, source labels and identifiers stay unchanged. Nested purchase fields use the full grid width.
Compatible retained Snapchat linked-ad performance offers native lead and purchase snapshots separately, labels
the metric in otherwise identical saved-name choices and names submitted native forms in the result column.
Current asset/plan/ad/source access is required, with no fresh provider call. Historical creative assignment
remains unverified.

All-row evidence workbooks now include retained parent campaign identity and bounded parent read hashes alongside
account/page references, for both the new presets and existing parent-scoped evidence. Native requests and bodies
are not exported. Malformed parent references and more than 102 parent checks are refused; existing account/page,
cell/text/concurrency/revision/access limits remain unchanged. Workbook labels translate; native definitions,
IDs, counts, dates, precision and source hashes preserve the original evidence.

## Qualification

- Initial preset tests: three feature failures and one unchanged purchase control. Completed focused checks:
  **127 passed / zero failures / zero skips, 8.342 seconds**.
- Coverage includes all three levels, 201 entities / two pages / 402 retained rows, independent finalization,
  changed fields, foreign continuation, repeated entities, changing parent/account/permissions, malformed native
  integers, missing versus zero, incompatible reconciliation and retained-performance revocation.
- Real MCP SDK/InMemoryTransport journey: **six tool calls / 37,056 structured bytes / 15 synthetic GETs**.
  Advertised schemas, exact definitions, retained paging, text/structured parity and key revocation are checked.
  No advertising writes or submitted lead records are read.
- Authenticated HTTP capture makes seven synthetic GETs for the two-page ad report. English/Arabic all-row XLSX
  downloads preserve 402 rows and three parent hashes without additional provider reads; revoked access refuses
  the download. Existing artifact limits, private projections and asynchronous access/revision controls pass.
- Browser scripts and selected Arabic validation pass: **34 scripts / 3,078 selected messages**. The browser
  control runtime failed to initialize twice, including after reset, with a missing kernel-assets path. No actual
  visual, keyboard or assistive acceptance is claimed for this batch. No temporary browser server was launched.

An intermediate SDK test exposed an absent timestamp retained as `undefined` and an incorrect inherited purchase
provenance note in the new feature; both are corrected before release. The new pagination assertion initially
confused the default 50-row response with the full retained collection. It now checks the durable 402-row document
and the existing paginated view separately. Native purchase controls and their SDK journey still pass.

Official [Snap Measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), checked 2026-10-04,
defines `native_leads` as submitted native forms and distinguishes non-conversion finalization from off-platform
conversion processing. It documents daily metric availability, campaign breakdowns, paging and local-day request
boundaries. This batch conservatively requires an owned parent for the new child presets; it does not reinterpret
the original account-scoped purchase-ad contract as broken based on ambiguous breakdown wording.

## Release scope

The previous lead-launch exact HEAD `744c32b87ea7a5f20139ba10053136cf5abcec9e` passed offline install, build,
early report freshness, full check and Railway, each exit zero: **3,941 total / 3,936 passed / zero failures /
five local FFmpeg skips, 102.426 seconds**, four capture checks in 72.973 ms. All 1,642 public source files matched
HEAD plus one generated empty sample; source hash
`16f18572a46262969f1346243a8ce0fa38fa4380ebd74e1380d535194bcbe723`. All three tracked reports stayed byte-identical.
Its [CI180](https://github.com/magdyezy1/CAMCP/actions/runs/37160583045), exact same HEAD/source hash, completed
successfully: 3,941/3,941 host and Docker tests, zero failures/skips, in 654.562/654.069 seconds. Four capture
checks passed in each environment (72.750/72.365 ms); both recorded two CPUs/two file workers. Required FFmpeg,
tracked report freshness, Railway, image build and both synthetic container smoke modes passed. This verifies
the release candidate and synthetic container behavior; deployed Railway health and live provider acceptance
remain separate.

Native action coverage stays 3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes.
No new native route, OAuth permission, write family, lead export, conditional program or provider mutation is added.
B15/B16/B18/B22/B24 advance, while the original matrix stays **13 implemented / 14 partial / one open**.
Additional providers/dimensions, historical assignments, commerce, capacity, visual/assistive and live/deployed
acceptance remain distinct work. Fresh sanitized build/report generation, full preflight and exact committed-source
qualification precede the sole `Work-here` push; the new revision requires its own FFmpeg/Docker CI.

Final sanitized preflight passed offline install/build/early report freshness/full check/Railway, each exit zero:
3,974 total / 3,969 passed / zero failures / five expected local FFmpeg skips in 95.970 seconds, plus four
capture checks in 79.837 ms; 34 scripts / 3,078 selected Arabic messages / 292 documents. Separate sanitized
build/report regeneration confirmed all three public artifacts byte-identical, and qualification preserved them.
1,644 public source files plus one generated empty sample; source hash
b1a8a04d08822c558df5d99231c57b620537f79aeceb6edaebf834086a4ba592. This candidate precedes the subsequently
recorded CI180/final qualification paragraphs; exact committed-source qualification follows before the sole push.
The new revision requires its own FFmpeg/Docker CI. Visual/keyboard/assistive and live/deployed acceptance remain separate.
