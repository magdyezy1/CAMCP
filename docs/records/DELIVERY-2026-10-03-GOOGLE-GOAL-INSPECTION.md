---
status: record
tier: engineering
---

# Current Google conversion goals and primary-action prerequisites

Batch 118, 2026-10-03. Repository magdyezy1/CAMCP; sole branch Work-here. Baseline c10579c.

The two conversion Search recipes now inspect the selected account's current conversion configuration when
recipe_eligibility is called with live:true. The default live:false remains local. Existing Google v25 search
contracts supply customer identity/currency/timezone/conversion-customer settings, account-default goals and
conversion-action settings. This is read-only configuration evidence: no events, goals, account settings,
credentials, permissions or advertising objects are changed.

Only the exact selected client using its own conversion customer is qualified. Manager accounts, shared
conversion customers and missing conversion-customer evidence keep goal/action readiness unknown; no other
customer is read. An existing adwords scope is required. Current actor, tenant, login, account, credentials,
profile revision, workspace controls and brief freshness are checked before every attempt and after responses.
Changed authority refuses the response and prevents the next read, including while a retry is pending.

Complete evidence requires two matching collections: customer/goals/actions, then actions/goals/customer.
Rows are normalized and sorted by exact native resource identity before consistency comparison. Counts,
enumerations, selected fields, owner scope, duplicate resources and complete pagination are validated. Matching
enabled explicit primary actions must share the category/origin of a biddable default goal. Hidden/secondary
actions and primary actions for unbiddable or different goals do not establish this prerequisite.

The selected biddable field is a non-optional proto3 bool; omitted false is normalized narrowly. The selected
primary_for_goal field is optional: missing/null stays unknown. A creation-time default does not establish a
current read flag. System actions may omit an owner; an explicit foreign owner is refused. A complete absence
of biddable defaults or matching primary actions becomes a named configuration blocker. Relevant unknown primary
flags remain unknown rather than asserting absence.

One inspection shares a 64-attempt allowance including retries, 4,000 rows including consistency reads, 2 MiB
of wire responses and a 60-second monotonic deadline. Each collection is limited to ten pages and 1,000 rows.
Exhaustion, changing settings, invalid rows or failed/partial responses discard partial goal/action proof.
Safe constant diagnostics carry a code and, for aggregate limits, the dimension; raw provider diagnostic text
is withheld. Complete results retain six resource/pass source references with each page's request query,
response hash, capture time and row count, plus collection and normalized-state hashes. Opaque page tokens
are not projected. Counts/hashes cover the complete collected sets; display lists show at most 20 goals and
20 matching primary actions with explicit omissions.

Readers and read-only deployments can inspect configuration under existing read access. Current write blockers
remain. A complete customer read can supply exact currency/timezone evidence when the write preflight is skipped;
its actual source reference is retained. Currency failure in native preflight avoids the extra inspection.
Goal configuration does not prove event delivery, objective acceptance, performance, an atomic account snapshot
or continuing authorization. Settings can change before activation; activation and every later write still need
their existing independent review and native read-back. Saving remains an unapproved local paused draft.

The English/Arabic view shows current counts, a named keyboard-scrollable goal table, biddability, matching-action
counts and expandable original native references. Matching primary action names/IDs remain original escaped data.
Native source details remain available. Long IDs were moved behind per-row expandable details after browser QA
showed that a native-first table hid the matching count at desktop width.

F-187 (low) was reproduced in the existing prerequisite display: a disabled-write blocker showed only
deployment_writes_disabled: current_workspace_prerequisite. Five existing first-party control codes now have
readable bilingual explanations. Diagnostic codes and the complete source record remain intact. The red test
initially matched the whole HTML, including intentionally retained collapsed source; it was corrected to check
the visible explanatory portion. No production authorization or source evidence was removed.

F-188 (low, test harness) comes from actual CI172: host qualification passed all 3,828 tests, but Docker's
ledger-check child exceeded its existing 30-second deadline with ETIMEDOUT. The child now has a bounded
90-second deadline for that observed parallel-suite contention. Exact output-byte checks, expected failures for
changed/missing ledgers, no-rewrite assertions and eventual disposable-directory cleanup remain mandatory.
The two unchanged artifact assertions passed locally in 7.158 seconds. This does not establish corrected Docker
acceptance; the new committed source requires its own CI.

Official evidence inspected on 2026-10-03:

- [Google v25 CustomerConversionGoal](https://developers.google.com/google-ads/api/reference/rpc/v25/CustomerConversionGoal)
  defines goal category/origin grouping, biddability and exact resource naming.
- [Google v25 ConversionAction](https://developers.google.com/google-ads/api/reference/rpc/v25/ConversionAction)
  defines primary-action semantics and the nullable system-action owner.
- [Official conversion-action proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/resources/conversion_action.proto)
  declares optional primary_for_goal. Its creation default is not a read-observation substitute.
- [Official customer-goal proto](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/customer_conversion_goal.proto)
  declares non-optional biddable. Local pinned Google v25 schemas supply exact enums and selected customer fields.
- [Conversion-goal overview](https://developers.google.com/google-ads/api/docs/conversions/goals/overview)
  supplies account-default goal semantics. The joined readiness result is an implementation inference bounded
  to the current settings, not a Google certification of campaign or event acceptance.

Twenty-four new regressions cover local/no-egress behavior, both recipes, complete paging, implicit false versus
unknown optional flags, hidden/secondary/mismatched actions, shared/manager accounts, changes during rereads,
ordering, read-only grants, malformed/scope/duplicate/count envelopes, output omissions, bytes/rows/pages/retries,
the exact 64-attempt ceiling, missing scope and in-flight authority/profile changes. Website regressions cover
bilingual readable projections, original references, escaping, incomplete-result refusal and blocker reasons.
Initial feature tests failed before implementation. Fixture corrections made the page-size/count expectation and
account-grant mutation valid; no production safeguard was weakened. Final focused qualification follows below.

The actual MCP SDK journey validates advertised schemas across six calls, reads current settings with read access,
preserves the write blocker, saves a six-step unapproved paused draft, opens it and rejects revoked access.
Native transport and credentials are synthetic. Evidence remains in .runtime/google-goal-inspection-20261003/.

Browser QA used a disposable in-memory read-only workspace and fake selected-account searches. English and Arabic
1280x900 desktop pages had 1265/1265 body/client width; the collapsed goal tables fit their 826-pixel regions.
375x900 mobile pages had 360/360 body/client width. Named regions were 238 pixels and expanded native tables were
716/751 pixels; keyboard arrows advanced English +40 and Arabic -40 pixels without document overflow. Original
customer/goal/action resources remained exact. Arabic save created six pending steps with exact 15250001 target
micros, an empty execution journal and a cleared old inspection. Across preliminary/final browser checks the
fake transport recorded 24 successful read queries and zero advertising mutations. Screenshots and
browser-evidence.json are retained in the runtime directory. This is synthetic responsive/keyboard observation,
not a complete accessibility, Arabic editorial, deployed or live-account acceptance audit.

Previous batch 117 exact HEAD c10579c12e2701c3094947d1dd8dc483fb9ca386 passed all five local sanitized stages:
3,828 tests / 3,823 passed / zero failed / five expected FFmpeg skips in 96.743 seconds; four capture tests
in 79.183 ms, 33 browser scripts, 2,969 selected Arabic messages and 283 documents. Its 1,602 public source
files equal HEAD plus one generated empty sample; source hash
3f2748dbe7ee8343b51bf7903353187ba899d367e4332e6c0ab38a86bf727cb7. Sole Work-here push succeeded.
[CI172](https://github.com/magdyezy1/CAMCP/actions/runs/37121211388) passed all host tests with zero skips
in 846.708 seconds and four capture checks in 55.583 ms; Railway compatibility passed. Docker passed 3,827
of 3,828 tests with one ledger child timeout in 889.422 seconds. Container smoke was skipped after that failure.
The failed run is preserved; no Docker/deployed/live success is inferred.

The native ledger remains 3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes.
The blueprint remains 13 implemented / 14 partial / one open. B08/B17 gain specific current Google configuration
evidence; B24 gains selected authored explanations. Shared/manager goal scope, other objective packs, actual events,
conditional provider entitlements and independent acceptance remain outside this bounded qualification.

Final focused qualification: 191 passed / zero failed / zero skipped in 10.629 seconds, including the two
existing exact-ledger assertions with the revised bounded child deadline. Missing adwords scope refuses before
any request, and the ten-page case refuses before an eleventh request without retaining partial proof.
Sanitized preflight and exact committed-source qualification follow before the sole Work-here push.

Final SDK observation: six tool calls, 32,404 structured response bytes and 14 synthetic provider requests;
zero events or advertising mutations. Response lengths include observation times and may vary between runs.
Sanitized preflight .release/google-goal-inspection-preflight-20261003 passed install/build/report/check/Railway,
each exit zero: 3,852 tests / 3,847 passed / zero failed / five expected local FFmpeg skips in 98.586 seconds;
four capture checks in 89.305 ms, 33 scripts, 2,980 selected Arabic messages and 284 documents. It contains
1,606 public source files plus one generated empty historical sample, source hash
d603f0516c5928c047676458d3a816b56a2c443f9f391069bc874b7fff5f60f3. The committed-source candidate is qualified
separately before push; this earlier preflight does not include its own subsequently recorded result paragraph.
