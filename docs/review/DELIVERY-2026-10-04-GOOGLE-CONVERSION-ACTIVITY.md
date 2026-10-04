# Current Google conversion activity dates

Baseline: `764936e`. Batch 142 advances B08/B15/B16/B17/B20/B24 with selected aggregate observations for
the two guided value-bidding recipes. The original full improvement plan continues; no package or native
family is declared complete by this increment.

## Selected native evidence

The two value recipes now inspect `metrics.conversion_last_conversion_date` and
`metrics.conversion_last_received_request_date_time` through a separate bounded `conversion_action` query,
joined by exact resource name to the current enabled explicit primary actions matching biddable account-default
goals. Both fields are documented for that resource in Google's [v25 field reference](https://developers.google.com/google-ads/api/fields/v25/conversion_action).
The [v25 Metrics proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/common/metrics.proto)
declares optional string presence. These sources and the pinned v25 schema were checked on 2026-10-04.

The native last conversion date and last tag-detection time use the customer's timezone. A detected tag need
not have an attributable conversion. Missing/null/empty fields or absent metric rows therefore remain unknown;
none become a zero count or a healthy verdict. Qualified dates use the original `YYYY-MM-DD` and
`YYYY-MM-DD HH:mm:ss` strings, with up to six native fractional-second digits supported. Invalid calendar
dates, time components, coerced values, extra fields, foreign/unknown/repeated action IDs and unsupported
timezones cannot produce complete evidence. Original strings are preserved without UTC conversion, age
thresholds or timezone-offset assumptions.

All activity pages are collected twice. Their normalized hashes must match, alongside the original customer,
goal and action configuration reads. Two complete activity collections share the existing 64-request,
4,000-row, 2 MiB and 60-second budget, ten pages and 1,000 rows per collection. No limit or permission is
widened. Per-page native source references retain query, response hashes, capture clocks and counts.
Current login/account/profile/credential/key and brief checks continue before and after native work.
Shared/manager conversion customers remain unknown and are not read through another client.

`reported_conversion_activity` describes known optional dates only. Its ready state requires both selected
dates for every matching primary action, with no matching unknown primary flags. Counts cover the complete
primary collection, including actions beyond the twenty displayed rows. Missing rows/settings remain unknown.
Event delivery, received values, recent conversion volume, history requirements, bidding eligibility, consent,
deduplication and actual return remain separate unverified dependencies. No event-level record, event identifier,
person, event sender, mutation or saved reporting snapshot is introduced. Local and conversion-count checks
retain their original read behavior; disabled-write deployments and readers can inspect without write authority.

## Website, workflow and MCP

The prerequisite view adds a collapsed English/Arabic table with original action name/resource ID, last
conversion date and last tag-detection time. A separate timezone statement avoids misleading UTC presentation.
Known-date counters cover the whole primary collection. Original dates/IDs are LTR, source names are escaped,
and missing fields have an explicit label. The existing mobile scrolling table has a caption, column headers
and named keyboard-accessible region. Wrong scope, incomplete/incorrect selection, inconsistent counts,
duplicate rows or malformed date fields withhold the view. Existing form/navigation/session race guards remain.

The published MCP descriptor and recipe context explain the selected observations and limits. Save still
creates the original unapproved paused draft and grants no continuing advertising or activation authority.
The real SDK evaluation validates schema and JSON-serialized text/structured parity, follows the original
saved plan, and refuses revoked-client access before new native requests.

## Qualification and continuing scope

Feature baseline: **1/0/1/0, 991.882 ms**. Corrected baseline: **1/1/0/0, 3.270 seconds**.
Eight backend cases cover both recipes, account-local strings, optional/empty/partial dates, malformed values,
exact identities, complete repeated-read changes, unknown rows beyond twenty displayed actions, reader/write
separation, revocation, native paging limits, timezone qualification and unchanged local/count/shared behavior.
Two bilingual controller cases exercise the real localization module; one real SDK journey adds five calls,
39,698 structured response bytes and thirteen synthetic configuration requests, with zero external requests
or mutations. Combined feature/original-goal/value/SDK/controller suite: **66/66/0/0, 10.552 seconds**.
Final related suite: **159/159/0/0, 24.891 seconds**. Website checks pass for 34 scripts, three pages and
3,402 explicitly selected Arabic interface messages.

Fresh sanitized report generation and full qualification follow below. The private root sample and real
credentials are not read. Current external browser/assistive, provider and deployed acceptance remain separate.
Native totals remain 3,247 actions / 167 families / 800 reviewed writes. The 28-package matrix remains
13 implemented / 14 partial / one open, with twelve guided recipes. Recent volume/value histories, runtime
diagnosis, additional objectives and exact eligible-account acceptance remain within continuing scope.

## Batch 142 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Main **4,213/4,208/0/5, 126.785 seconds**; capture **4/4/0/0, 80.646 ms**. Five local skips require FFmpeg;
the exact Linux/Docker CI gates remain separate. Website: 34 scripts, three pages, 3,402 explicitly selected
Arabic messages. Documentation index: 308 documents. Manifest: 1,726 public source files plus one literal
generated empty sample; preflight source hash
`9a54eb6ac3d9b2d33b2e370ffe7191514720308ea39c12b0132d9c3102c07bf3`.
All three public reports regenerated unchanged after the fresh sanitized build and preserved their bytes
through full qualification. The private root sample was not read. This evidence follows preflight; the final
committed revision still requires a fresh maintained source proof and all full gates before the sole Work-here
push. Browser availability was checked again on 2026-10-04 at approximately 11:23 UTC and failed with the same
kernel-assets missing-path error (os error 3). Controller/SDK checks do not replace actual browser/assistive
acceptance, real provider data or deployed qualification. Work on the original full plan continues.
