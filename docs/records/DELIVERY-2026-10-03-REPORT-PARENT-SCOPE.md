---
status: record
tier: engineering
---

# Tag Manager and Business Profile report recovery

Batch 121, 2026-10-03. Repository magdyezy1/CAMCP; sole branch Work-here. Baseline d91cfd7.

Operations and MCP can recover retained read-only reports whose original Tag Manager path or Business Profile
resource name supplies the native account parent. The original definition and result remain unchanged. Current
tenant, connector, selected login and exact resource grants still control status, result retrieval and recovery.
The website names the four measurement providers in English/Arabic and keeps the mobile header controls fitted.

## Confirmed findings

- **F-193, high, S, fixed:** `src/report-resource-scope.ts:115` omitted Tag Manager paths and Business Profile names
  from retained metadata scope. Baseline synthetic tests both rejected valid canonical-only reports and exposed
  a different parent's retained result through a currently allowed alias. A further red test at
  `tests/report-parent-scope.test.mjs` reproduced a contradictory location selector hidden by a location grant.
  `reportingResourceAccounts` now checks canonical account/location anchors and repeated selectors together.
- **F-194, low, S, fixed:** `web/operations-center.js:110` rendered gateway codes as provider names. Actual browser
  observations and a failing bilingual renderer regression confirm the problem. Selected friendly names now
  localize while source names, native account IDs and MCP arguments remain original.
- **F-195, medium, S, fixed:** `src/delegated-native.ts:489` accepted Business Profile GET_LOCATION and GET_LODGING
  without readMask. Their pinned discovery descriptions require it but omit the required flag. The current
  normative provider parameter tables agree. A baseline compiler test accepted a missing mask; both reads now
  require the caller's explicit nonempty mask before dispatch. Other routes and explicit native mask bytes are
  unchanged. This is a reproduced local contract gap, not an inspected live provider failure.
- **F-196, low, S, fixed:** `web/identity.css:2081` let the Arabic phone breadcrumb grow to 84 px in a 68 px header,
  from y=-8.5 through 75.5. Actual DOM measurement confirms vertical clipping. Narrow headers now keep the page
  label on one line where space allows; phones up to 420 px use the main heading for context. Navigation, language,
  search, sign-out and account controls remain visible. This is measured reflow, not full accessibility certification.

## Scope and contract behavior

The bounded SQL adapter recognizes existing compiler aliases for Tag Manager path, parent and account ID, and
Business Profile name, parent, account ID and location ID in the selected original envelopes. It normalizes only
the native account parent: accounts/{id} becomes the account ID, locations/{id} stays an exact location grant.
Opaque IDs retain their original bytes. Location selectors must agree with a canonical child/location grant;
an existing account parent remains its separate legacy account context. This does not establish a location's
ownership outside the compiler's independent scope/ownership checks.

The existing 128 KiB retained-envelope, 64 KiB argument and eight-selector limits remain. Duplicate raw JSON,
normalized-key conflicts, malformed/nontext values, invalid envelopes and exceeded bounds fail closed. Metadata
returns only the account anchor and existing compact fields; full definitions, child paths and result rows remain
outside the feed. Unsupported historical shapes remain unavailable. Fresh query schemas still reject uncaptured
wrapper/field shapes and reporting cannot execute native writes.

Business Profile field selection is explicit, for example query.readMask="name,title" for a location or a deliberately
selected "*" for lodging. Missing, empty or whitespace-only masks fail locally; AMCP does not supply an all-fields
default. Older retained results keep their original metadata access; a new execution must satisfy the current
compiler. No route, OAuth scope, grant, family, mutation control or action-ledger row is added.

## Evidence and observations

Final focused tests passed 140 / zero failures / zero skips in 3.572 seconds. Fourteen new regressions cover
canonical parents, exact/repeated aliases, current authority and revocation, bounded projection, original-source
preservation, captured query schemas, real SDK recovery, provider labels and the required masks. The parent SDK
journey made seven calls and returned 9,267 structured response bytes; the existing resource journey made eight
calls / 10,732 bytes. Both used synthetic retained jobs with zero provider requests or advertising mutations.

An actual disposable in-memory browser workspace showed both allowed completed original reports and a prepared
run while withholding both conflicting reports' names. Keyboard Enter expanded the original result handoff in
each language; the exact run IDs and account/location bytes were retained. English/Arabic report details fit at
1280x900 (1265 px document/client width) and 375x900 (360 px). After the header correction, actual measurements at
320, 375, 425, 590, 850 and 1280 px in both languages showed fitted controls, no breadcrumb clipping and matching
document/client widths. At 320 px those widths were 305/305. The temporary tab, viewport override and owned local
fixture were cleaned up. Screenshots, red/green logs and measurements remain in `.runtime/report-parent-scope-20261003/`.

The action ledger remains 3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes.
B13/B16/B24 remain partial for broader formats, telemetry, editorial/assistive qualification and live/deployed
acceptance. The implementation matrix remains 13 implemented / 14 partial / one open.

## Primary contract sources

Checked 2026-10-03 against the pinned discovery routes and the normative parameter tables:
[Tag Manager account names](https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts/get),
[Business Profile account names](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/get),
[location field selection](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations/get),
and [lodging field selection](https://developers.google.com/my-business/reference/lodging/rest/v1/locations/getLodging).
No live credentials, provider access, account samples, advertising mutations or production changes were used.

## Qualification

Fresh sanitized release and exact committed-source qualification are recorded below before the sole authorized push.
Tracked public report freshness must pass without regeneration during qualification. Docker/FFmpeg and deployed
Railway behavior are separate evidence states.

Fresh `.release/report-parent-scope-preflight-20261003` passed install/build/freshness/check/Railway, each exit
zero: 3,882 total / 3,877 passed / zero failed / five expected local FFmpeg skips in 97.717 seconds; four capture
checks 76.680 ms; 33 browser scripts / 2,990 selected Arabic messages / 287 documents. Local build/report generation
in a separate sanitized candidate proved all three public reports already current; no artifact changed. The fresh
qualification preserved their original bytes. Its manifest includes 1,621 public source files plus one generated
empty sample; source hash 43e19d95be0fa977781856b74c7c1f8ee8ae3ec2212337cd4f3cf816b5d09aa2.
This preflight precedes its own recorded paragraphs; exact committed-source qualification follows before push.
