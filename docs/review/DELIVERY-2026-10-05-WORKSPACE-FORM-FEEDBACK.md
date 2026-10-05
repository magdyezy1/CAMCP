# Persistent shared workspace form feedback

Batch 165 extends the shared workspace form binding beyond the two GA4 controllers already
qualified. GTM configuration audit and LinkedIn conversion settings demonstrate the actual
before/after behavior. Batch 164 was exact-qualified and pushed as d76bfcf before these changes.

## Resulting behavior

An unhandled current form failure now remains in a full-width, described alert inside the form.
The existing formatter retains the original native reason, recovery hint and request reference;
authored labels/hints use the selected interface language. The handler does not reset selected
settings or start a retry. Input/change and the next explicit submit clear the current alert.

The form and its submit control reference the current alert while it is visible, retaining other
description tokens. Existing control IDs are preserved; an otherwise unidentified submit receives
a stable form-scoped ID for focus restoration. Text is assigned as textContent. A provider access
denial is a form-level diagnostic; the handler does not mark every input invalid.

Navigation, identity, edited settings, a newer attempt and detached form/alert suppress an old
failure. An older completion cannot re-enable the control of a newer outstanding request.
An edited outstanding form regains its control when that attempt completes without restoring
obsolete feedback or moving focus. Successful re-rendering retains the existing replacement
control/heading focus behavior. A connected intentionally focused control keeps focus.

Non-form actions retain their existing toast presentation, with current identity, attachment and
attempt guards. A callback that handles its own diagnostic does not also show a shared failure.
The existing GA4/capture feedback behavior and native operations remain independent.
Individual controllers retain responsibility for guarding successful results and selecting request
inputs; the shared handler governs current diagnostic, control and focus behavior.

The new populated LinkedIn journey also exposes a layout defect: the conversion rule/name/ID
column lacked the readable native-row minimum used by other evidence tables. Scoped styles now
provide that width and keep literal LTR IDs, types and precise amount/currency values together
inside the existing named keyboard-scroll region. Other tables, native values and collectors keep
their preceding behavior.

## Observed baseline and evaluation

The original served GTM and LinkedIn forms each performed one synthetic native GET, displayed the
original provider denial/hint/reference only in the toast, and lost all visible diagnostic text
after 6,600 ms. No report or effect was created. The ignored baseline records actual served code,
rather than an inferred timeout.

Twenty-three maintained shared-handler cases exercise English/Arabic messages and original
native envelopes, safe text, description ownership, settings/edit clearing, outstanding obsolete
responses, overlapping attempts, focus across success/error/re-render, stable IDs, a missing
submit, the real superseded helper, and existing non-form presentation. Two real SDK
Client/InMemoryTransport cases preserve original schema/text/structured-result parity, provider
denial/category/retry metadata and explicit unchanged-scope recovery. The original four binding
checks remain; the focused run passes 29/29/0/0 in 828.2294 ms.

GTM recovery reads the exact account then its container inventory. It retains the huge native
container ID and null publication readiness; event delivery remains not_measured. LinkedIn
recovery reads account → owned conversion collection → account. Exact ID, decimal USD value
and native 30/7-day windows survive. Event delivery, deduplication, consent and historical
attribution remain unverified; campaign membership is not_collected. Both stop on their first
refused native read, require explicit resubmission, broaden no grants, and save no report,
campaign plan, review or conversion snapshot.

Thirty-two new maintained served journeys cover current refusal/recovery and delayed obsolete
responses in both forms, English/Arabic at 320/375/768/1280 pixels. They require described alert
persistence after 6,600 ms, original submit focus/settings/reference, clearing without a read,
explicit original-scope recovery and exact native values. The previous 280 cases remain,
bringing the maintained selection to 312.

All 425 backend files and 51 website files outside workspace.js/workflows.css/ar.json retain
their preceding d76bfcf bytes. All 4,059 preceding Arabic pairs remain; only two generic alert
labels are added. The locale gate selects 3,853 messages from 4,061 pairs with zero problems.
Fresh default full checks with required FFmpeg, regenerated reports, exact Git-source parity
and clean-head browser qualification are recorded below as completed.

## Research and limits

Descriptive form error text and programmatically exposed status are consistent with the
[W3C error-identification guidance](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)
and [W3C status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
Selected browser/keyboard/reflow checks do not certify complete accessibility or real assistive
technology acceptance.

The owned GTM fixture follows the account get and container-list read shapes documented by
[Google accounts.get](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts/get)
and [Google containers.list](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/list).
The current LinkedIn configuration read retains its existing selected-account finder, without
the optional shared-rule request. The official
[LinkedIn account finder](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api?view=li-lms-2026-09)
distinguishes default owned rules from the optional owned/shared query; configured windows are
rule settings, not historical report attribution.

Every native response in this evaluation is synthetic and scoped. There is no live advertising
provider traffic/mutation, sender, grant change, customer login or external MCP-client acceptance.
The handler does not change source collectors, provider authorization, review/idempotency,
receipt reconciliation or mutation retry safety. Other provider-specific/dynamic reason copy,
remaining task coverage, real assistive technology, Linux/Docker, deployed workers/destinations
and live provider acceptance stay separate. B15/B16/B24 remain partial; counts remain
13 implemented / 14 partial / one open. About Us remains delivered and included in maintained QA.
Hosted Actions remain waived at the owner's direction.

## Rejected intermediate browser evidence

The initial 312-case run was rejected: the new kinds lacked the saved-evidence baseline used by
the no-effect assertions. Their early failures shifted subsequent fixed native-response phases;
all preceding 280 cases passed. The baseline predicate was corrected without weakening any
assertion. A fresh run then exposed the eight populated LinkedIn table-width failures above;
the remaining journeys passed. Both earlier outputs remain in ignored evidence directories.
Final qualification uses fresh source and output directories after the scoped layout correction.

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages
pass. Main 4,468/4,468/0/0 in 135.688 seconds; capture
4/4/0/0 in 98.4570 ms. Required FFmpeg runs with zero skips at default
concurrency. The candidate contains 1,816 public files and one literal empty generated sample,
digest d5d4e8f5f500da2303b2d24deff4a8e6c93c45ad35ca500e4914a60dcb1c3076. All three tracked public reports regenerate identically.
All 425 backend files, 51 other website files and 4,059 preceding Arabic pairs remain unchanged.

All 312 actual served cases pass from 2026-10-05T04:01:28.138Z through 2026-10-05T04:19:10.421Z,
website digest 088b85e9a56054792ffec0fc0be7871480c3d71a4bbdbb0d5a28a94625831df9. Every preceding 280 assertion remains,
including 1,368 original workbook rows, 360 scoped controls, 160 labeled fields, provider/Google
capture refusal and original measurement current/obsolete/native-denial behavior. The 32 new
shared form cases include sixteen persistent original native-403/reference/hint/settings/focus
and explicit original-scope recovery journeys and sixteen delayed obsolete responses. Their
thirty-two refused reads and forty explicit recovery GETs save no reports/plans/reviews, retry
nothing automatically and broaden no access or mutation authority. Representative Arabic
320-pixel GTM/LinkedIn alerts are visually inspected. External provider traffic/effects remain
zero. B15/B16/B24 and whole-plan counts remain partial and 13/14/1 respectively.

Fresh exact committed-source/default full and clean-head served checks follow before the sole
Work-here push. Hosted Actions remain waived by the owner.
