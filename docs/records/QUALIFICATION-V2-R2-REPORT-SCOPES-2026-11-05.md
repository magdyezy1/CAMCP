---
status: record
tier: engineering
---

# Round 2 report scope checkpoint qualification — 2026-11-05

Implementation `1c8e0922` passed a fresh filtered public checkpoint after the resumed review. This qualifies
source-owned activity/status filtering and its compatibility guards; Packages B/C and Round 2 remain incomplete.
The implementation details are in [the scope record](IMPLEMENTATION-V2-R2-REPORT-SCOPES-2026-11-04.md).

The candidate contains 3,307 public files. Its source tree is
`b79b760020d152f4bbb38959f5d4045b33b46d2981228991d5cd2488eb2483de`; its packaged runtime is
`b132eb0b43adba33c5811dc2e6298397591c8daad4fd7c592ab5b0fa5e1eedd6`. All 42 changed public inputs still matched
their frozen hashes before the implementation commit. Added-content review found no local paths or credential
patterns. Protected/private inputs were excluded before content reads; the release sample is the literal empty
fixture. This later documentation receipt changes no executable input.

The checkpoint passed 8,323 tests in 930 files, with zero failures, skips or cancellations. All six related freshness
checks passed, as did fast qualification, static browser checks and all 58 route budgets. The English reporting
page remains at 177,606 of its existing 177,616 Brotli-byte budget. HTML-write and manual-escape baselines, numeric
precision, response-size targets and tool-schema goldens were not relaxed. No mutation campaign, dependency
acquisition or live-provider check was performed for this follow-up.

The initial frozen scope candidate exposed two compatibility failures: a minimal legacy Snapchat collector did
not have a source object, and legacy provider refusals inside HTTP 200 responses were judged by their wrapper
status. Both were corrected without weakening their assertions. Credential-layer failures still fail the source;
temporary server failures still retry. A further regression verifies that changing the login during a refused
optional metadata read raises `CONNECTION_AUTHORITY_CHANGED`.

Resume review also reproduced an actual-collector precision edge: native spend `0.0000000001` became retained `0`
before delivery filtering. Campaign and detailed collection now record activity before rounding, while metric
values retain the existing nine-place contract. The regression passes at campaign, ad set and ad levels. The prior
candidate with 8,322 passing tests is preserved as superseded evidence; it is not the accepted source tree above.

Selected-ad-only ancestor rollups, automatic legacy migration and its durable notice lifecycle, schedules,
templates, website controls, exports, remaining Round 2 packages and final release gates still require work.
Meta's native result inner shape and all owner-deferred live/OAuth, amcp.shop, Railway, actual Sheets and deployment
checks remain unverified. Arabic additions still require the planned native-speaker review. No push is claimed.
