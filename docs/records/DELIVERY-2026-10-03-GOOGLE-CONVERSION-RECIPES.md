---
status: record
tier: engineering
---

# Google Search conversion bidding and native strategy verification

Batch 117, 2026-10-03. Repository magdyezy1/CAMCP; sole branch Work-here.

Two guided business-input recipes now create paused Search plans through the existing six native families:
google_search_conversions uses Maximize Conversions without a CPA target; google_search_target_cpa uses
Maximize Conversions with an explicit exact positive decimal target CPA. Both require ACCOUNT_DEFAULT as the
explicit conversion-goal policy. They create a dedicated unshared daily budget, paused Search campaign,
Google-search-only targeting, exact keywords and a responsive search ad. Children remain enabled under the
paused campaign. Activation is separate. Target CPA values compile to exact native micros through BigInt;
numbers, zero, excess precision, overflow and contradictory strategy/goal inputs are refused.

The recipes leave native conversion goals unchanged. Account-default goals can change outside this plan;
they are neither frozen nor independently verified here. Current goal settings, primary conversion actions,
event delivery, landing-page policy and provider objective eligibility remain explicit unknown dependencies.
An account currency prerequisite read does not establish conversion readiness. The target CPA is an average
optimization target, not a per-conversion cap or performance guarantee. No conversion events, goals, credentials,
permissions or app settings were changed in engineering qualification.

Website controls and authored limitations are available in English/Arabic. The target CPA stays exact text;
reusable playbooks expose that value but do not supply goal-policy consent through their guided controls.
Inspection now presents the selected scope, paused intent, native daily-budget/target micros and goal limitations
before the original compiled plan/provenance details. This projection checks its exact native steps and metadata;
changed scope/currency/target/status falls back to source details. Saving still creates an unapproved draft.
Existing form, identity, navigation and request-order guards remain active.

F-185 (high) was reproduced against existing manual-CPC recipe behavior: after an accepted campaign creation,
the synthetic native record omitted manualCpc and reported TARGET_SPEND, but generic verification declared it
verified because the requested empty object had no scalar comparison leaves. The same weakness would affect
an untargeted Maximize Conversions message. Verification now selects and compares the exact native
campaign.bidding_strategy_type for the four existing standard schemes. Missing or wrong type cannot establish
verification or advance dependent creation. For Maximize Conversions it also selects target_cpa_micros and
compares the explicit target or the implicit proto3 zero default. That default is applied only under the correct
native strategy and an exact selected campaign field; malformed/null/positive unexpected values are not defaulted.
Original native write bytes are unchanged. No incorrect live bidding outcome is claimed.

Official references inspected on 2026-10-03:

- [Google v25 MaximizeConversions](https://developers.google.com/google-ads/api/reference/rpc/v25/MaximizeConversions)
  establishes standard target-CPA units and portfolio-only CPC limits.
- [Standard versus portfolio strategies](https://developers.google.com/google-ads/api/docs/campaigns/bidding/assign-strategies)
  establishes direct campaign strategy configuration.
- [Conversion goals](https://developers.google.com/google-ads/api/docs/conversions/goals/overview)
  establishes account defaults, campaign overrides and primary-action semantics.
- [Google v25 bidding proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/common/bidding.proto)
  declares MaximizeConversions.target_cpa_micros as a non-optional proto3 int64.
- [ProtoJSON defaults](https://protobuf.dev/programming-guides/json/)
  establishes omission of implicit default-valued scalars. This is narrowly scoped normalization, not a generic
  absent-evidence-to-zero rule.

Initial feature tests failed because both recipes were unavailable. Two later red strategy tests reproduced the
existing manual-CPC false verification and the absent-type/target issue before correction. An initial new test
incorrectly assumed that creating an inert unassigned budget required spend acknowledgement; it was corrected
to test the existing explicit review-confirmation boundary. No production safeguard was weakened.

Initial focused checks: 126 passed / zero failed / zero skipped in 10.482 seconds, including original clicks/manual recipe,
native verification, account prerequisites, profile provenance, bilingual forms/defaults/preview and actual MCP SDK
journeys. Both recipes completed six independent synthetic native review/execute/read-back steps while their
campaigns stayed paused. Wrong type/target and revoked access refuse dependent work without resubmission.
The real SDK journey validated advertised schemas and revocation: six tool calls, 22,398 structured response
bytes and zero provider requests; the saved plan remains an unapproved local draft.
Evidence is in .runtime/google-conversion-recipes-20261003/. All native activity is synthetic.

Previous batch 116 exact HEAD f579c9d7b2e9686af977e7fe973da86a70285ef3 passed install/build/report/check/Railway:
3,809 tests / 3,804 passed / zero failed / five expected local FFmpeg skips in 97.416 seconds; four capture checks
in 80.248 ms, 33 scripts, 2,953 selected Arabic messages and 282 documents. Its 1,599 public source files equal
HEAD plus one generated empty sample; source hash
290ddc2092948423a2eb245f20d3ce2bfef1fc7577dadf3b603e40121c89aad2.
It was pushed only to Work-here. [CI171](https://github.com/magdyezy1/CAMCP/actions/runs/37118590479) completed
successfully for that exact HEAD. Host and Docker each passed all 3,809 tests with zero failures/skips in
726.724 and 748.945 seconds; four capture checks passed in 48.747 and 48.439 ms. Railway compatibility and
read/write synthetic container smoke passed. This is not deployed or live-account acceptance.

The blueprint remains 13 implemented / 14 partial / one open. B17 now has eight guided recipes, with account-
specific eligibility, measurement acceptance and other objective packs remaining partial. Native ledger remains
3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes. No provider family is added.


Sanitized preflight .release/google-conversion-recipes-preflight-20261003 passed all five stages:
install/build/report/check/Railway each exited zero. 3,827 tests / 3,822 passed / zero failed / five expected local
FFmpeg skips, 92.965 seconds; four capture checks in 72.866 ms, 33 scripts, 2,969 selected Arabic messages and
283 documents. 1,602 public source files plus one generated empty sample; source hash
54ea79e00a7ce251195f8baa380a4206bdcfcf9a60494a759f9a78f203dacfdb.
Final preview pair layout/browser evidence and exact committed-source qualification follow separately.


Final browser qualification used an isolated in-memory read-only workspace and fake transport on localhost.
English and Arabic desktop (1280x900) and mobile (375x900) previews retained the exact 00015.250001 input,
15.250001 USD display, 15250001 native micros, 25 USD budget, google-login/123 scope and ACCOUNT_DEFAULT.
Body width equaled client width (1265 desktop, 360 mobile); no document horizontal overflow was observed.
All six preview pairs fit the desktop view; mobile values and lower notices were inspected by scrolling.
Keyboard Tab moved from the focused preview to its compiled-source summary. Arabic saving produced a
local DRAFT with six pending steps, no execution journal entries and no old unsaved preview. Names/native
values remained original data; dynamic saved brief/provenance remains source English. This is not complete
Arabic editorial, assistive-technology or live-account acceptance. Screenshots and browser-evidence.json are
retained under .runtime/google-conversion-recipes-20261003/. The transport recorded zero provider attempts.

F-186 (low) was found during this browser check: a successful recipe save left the inspection visible, including
the new 'No plan is saved' notice, beneath the saved draft. The successful-save path now clears the old preview
after opening the saved record. Refused saves preserve the inspected brief for correction. One new bilingual
save-lifecycle regression failed before the fix and now passes. Final focused qualification: 127 passed / zero
failed / zero skipped in 10.453 seconds. The earlier full preflight predates this regression and final layout;
the exact committed candidate includes both and receives a fresh full qualification before the sole push.
