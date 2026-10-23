# Snapchat allocation evidence to reviewed daily-budget drafts

Batch 107, 2026-10-03. Baseline: `0cda06f`. Sole repository/branch: `magdyezy1/CAMCP`, `Work-here`.

## Delivered workflow

A retained `snapchat_adsquad` report can now list allocation candidates, model explicit period floors/caps and
preview an unapproved daily-budget draft. The existing exact-decimal allocator accepts this additional native
grain and exact UUID identities; it requires retained parent-campaign source and ownership evidence. It keeps the
existing recent closed-period, known measurement, minimum-conversion and exact feasible-bound requirements.
It is an illustrative sensitivity model; it supplies no forecast, statistical confidence or automatic approval.

The operator explicitly chooses `equal_daily`. Proposed period amounts round down to whole native micros; the
preview shows current/proposed daily amounts and residuals. A converted amount below the documented **5,000,000
micros** minimum or below its period floor is refused. These are ongoing daily budgets; the draft creates no new
end date or automatic period spending cap.

Current native inspection observes the selected campaign/ad squads through bounded account-scoped collections,
then checks exact resources under the selected login/account. Currency/timezone and campaign ownership bracket the
reads. Only an owned auction campaign with explicit `AD_SQUAD` pacing and explicit ad-squad `DAILY_BUDGET` qualifies.
Lifetime, campaign-level, reserved, shared and Smart Budget settings are refused. Current authority, scopes,
credentials, request/time/row/byte limits and restricted native cursors apply throughout. Every native read retains
its request, hash and time in one shared reference array, avoiding repeated copies for each target. Positive
collection membership establishes observed ownership, not a complete inventory or atomic snapshot.

Confirmation saves one parent-bound PATCH step per selected ad squad through the original campaign creator.
The original actor/session, report revision/hash, exact preview, ten-minute expiry and native budget signatures
bind creation. A lost creation response reuses the original draft. Before an unsent step is prepared/executed,
current source, parent and budget evidence are checked again. Each step still requires frozen native review,
explicit execution/spending confirmation and verified original-receipt read-back. Accepted or uncertain receipts
keep their original recovery. No reporting action sends an advertising change.

Reports exposes ad-squad selection, account/parent terminology, exact native conversion, expandable ownership
evidence and local-draft confirmation in English and Arabic. Conversion/form/navigation/identity guards retain
the existing workflow behavior. Native arguments are identical across languages. Google allocation drafts retain
their dedicated daily-budget behavior; other provider bindings remain unqualified.

## Confirmed defect and validation

**F-164, high:** the existing Snapchat nested-update review did not retain native ad-squad `delivery_constraint`.
A synthetic race changed the delivery mode after the allocation guard and before native dispatch; one PATCH was
submitted in the observed red run. The review now retains delivery mode as separate immutable read context,
including a parent ad squad where applicable. A change prevents dispatch. This context adds no mutable PUT/PATCH
field and grants no additional write permission. Native enum shape is checked when the field is present.

- Initial allocation feature suite: **five failed / one passed**. The malformed-response guard passed because the
  new provider binding was absent; the completed green suite exercises actual collection.
- Bilingual preview initial run: **one failed / three passed**. Delivery-mode race: **one failed / zero passed**.
- Completed focused suite: **125 passed / zero failed**, including existing Google allocation and Snapchat nested
  writes, exact rounding/floors/minimum, bounded ownership paging, foreign/failed/lifetime/Smart Budget refusal,
  authority withdrawal, source/budget drift, bilingual handoff and native execution/read-back.
- Real MCP SDK journey: **six tool calls / 13,827 structured-response bytes / 16 synthetic read-only GETs**.
  It inspects retained synthetic evidence, creates one unapproved draft, validates advertised schemas and proves
  revoked-key refusal without further egress. It sends no provider mutation.
- The local reviewed-write test uses fake PATCH/read-back only. It proves absent spending acknowledgement keeps
  the step review-ready and sends nothing, then separately confirms/executes/verifies one original receipt.

Logs are retained in `.runtime/snapchat-allocation-20261003/`. Development runs corrected two new fixture/API
assumptions: campaign results expose `current`, and refused spending acknowledgement is a successful workflow
response with a stopped step. The new lifecycle test uses the transport's real bounded admission sleeper; bypassing
sleep in the initial fixture exhausted the unchanged token budget. No safety limit was increased or removed.
No live incident, deployed acceptance or independent browser/accessibility certification is asserted.

## Contract basis and previous release

Official [Snap Ad Squads](https://developers.snap.com/marketing-api/Ads-API/ad-squads) and
[Snap Campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns), read **2026-10-03**, document
native budget units/minimum, daily/lifetime delivery modes, account collection reads, exact parent ownership and
the JSON Patch route. Existing registered actions and the `snapchat_nested_updates` family are reused. Native
classification remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**;
the family's test references now include the allocation regression.

Batch 106's exact committed-source candidate on `0cda06f` passed all five stages and Railway:
**3,683 passed / zero failed / five local FFmpeg skips; 102.97 seconds**, four capture tests, **1,563 public files +
one generated empty sample**, source hash
`95806204c03b12b32a10f29a6cec82033bafb09cab456556f61d89341bdb1a32`.
It was pushed only to `Work-here`.

[CI160](https://github.com/magdyezy1/CAMCP/actions/runs/37084547792) on batch 105 `3e87fee` passed. Job
`111092003379` logs show **3,670 passed / zero failed / zero skipped** on host and Docker, four capture tests,
Railway checks and successful synthetic read/write smoke. CI161 on `0cda06f` remains running at the last check.

Blueprint scope remains **13 implemented / 14 partial / one open**. B26 now includes a second provider's qualified
native draft binding. Calibrated forecasts, other providers, exact entitled-account acceptance, external clients,
real workloads and independent browser/Arabic/assistive-technology acceptance remain separate requirements.

Full local regression: **3,699 tests / 3,694 passed / zero failed / five local FFmpeg skips; 86.22 seconds**.
Arabic validation covers **2,828 selected messages / 2,953 catalog entries**. Native classification counts are unchanged;
only the nested-update family's test references change in the generated ledger.

Sanitized preflight `.release/snapchat-allocation-preflight-20261003` passed all five stages and Railway:
**3,694 passed / zero failed / five local FFmpeg skips; 90.91 seconds**, four capture tests,
33 browser scripts, 2,828 selected Arabic messages and 273 documents. Its **1,567 public source files**
plus one generated empty sample have hash `4ecc43ab16c18b1037c2ef0386f21e1d2010ed6f08dfd953877617dc8bb5c78b`.
Exact committed-source qualification follows before the sole Work-here push.
