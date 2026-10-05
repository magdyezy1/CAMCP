# Website account diagnostics and safe error references — 5 October 2026

Repository: magdyezy1/CAMCP. Sole working/push branch: Work-here.
Workspace: CAMCP-Codes-final-branch. Baseline: eb9fdae21ec64e73ea2de762ce9d88c4872da142.
Batch 170 addresses F-242 and F-243. B13/B16/B24 remain partial; the 28-package matrix
remains 13 implemented / 14 partial / one open. Hosted Actions remain waived by the owner.

## Observed account and support gaps

Thirteen website server files contain 232 distinct direct authored MirrorError sentences.
Only 39 already have Arabic catalog entries; 193 are missing. The affected reasons cover
sign-in, invitations and roles, OAuth cancellation/callbacks, Google reauthorization,
account and asset discovery, selected-resource authority, media uploads and early HTTP errors.
Principal page labels being translated does not make these server-generated refusals bilingual.

Early non-MCP errors reaching the shared HTTP error handler return only the existing error code
and message. They lack a reference users can report and a corresponding diagnostic event.
The existing browser requestError/errorMessage formatter already accepts meta.requestId.

## Delivered boundaries

The Arabic catalog gains 193 authored entries and preserves all 4,222 earlier key/value pairs.
The maintained locale gate now requires all 232 exact owned sentences across the thirteen files.
Total catalog: 4,415 entries; required interface inventory: 4,245, with zero locale problems.
The selector resolves the actual imported MirrorError constructor, including an import alias,
and excludes type-only imports, lexical shadows, dynamic/native fallbacks, unrelated constructors
and data fields. Original English reasons, native identifiers, protocol types, tokens and limits stay exact.
This is selected static diagnostic coverage; other backend/dynamic copy and full Arabic acceptance remain open.

| Selected source | Distinct exact reasons |
| --- | ---: |
| server/account-routes.ts | 4 |
| server/account-security.ts | 30 |
| server/asset-discovery.ts | 49 |
| server/google-account-discovery.ts | 8 |
| server/google-reauthorization.ts | 11 |
| server/http-app.ts | 5 |
| server/media-source-routes.ts | 5 |
| server/password-hashes.ts | 1 |
| server/platform-oauth.ts | 25 |
| server/social-signin.ts | 17 |
| server/user-accounts.ts | 29 |
| server/web-store.ts | 15 |
| server/website.ts | 36 |

Three sentences appear in more than one file; the union is 232 rather than the sum of file counts.

The common non-MCP error handler adds a server-generated UUID as meta.requestId while preserving
the original HTTP status and error object containing code/message. It does not add execution, retry
authority, raw details or a different service envelope. It ignores a supplied client reference.
One new event uses exactly six fields: level, event, status, code, requestId and at.
4xx errors use http_refused/warn; 5xx errors use http_failed/error. The new event does not include
URL/query, method, origin, headers, cookies, credentials, body, identity, error message, stack or details.
Failure of an optional log sink still returns the original refusal and generated reference.
The production server/http.ts entry already connects this sink to stdout/stderr; a library caller
without a configured sink retains its existing no-op logger. Log collection/retention and deployed
observation remain separate operational evidence. Existing MCP JSON-RPC and its finish log stay unchanged.

OWASP recommends interaction identifiers, excluding credentials/session values and testing logging
failures. This selected design follows those principles; it is not a full security-logging certification.
See [the primary logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
W3C describes identifying rejected input in text; translating authored reasons supports that workflow,
without establishing full accessibility conformance. See
[Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html).

## Checked local contracts

Twelve new tests qualify imported ownership and shadow exclusions, every selected translation,
native tokens/quantities, actual English/Arabic formatters and future missing-message detection.
They also exercise four actual owned HTTP error cases: missing callback state, malformed sign-in
JSON, repeated callback parameters and an internal platforms-list failure. Each retains its original
status/code/message, no-store response, fresh UUID, exact corresponding six-field log and unchanged
local evidence. No provider call, OAuth progress, plan, review or report is created. A failing optional
sink still returns the reference; early MCP authorization keeps its exact original JSON-RPC response
and single existing mcp_refused classification. These are synthetic local refusals, not live OAuth acceptance.

Corrected prototype: 12/12/0/0 in 1,057.408 ms. Existing HTTP/MCP/security/website regressions plus
new tests: 213/213/0/0 in 8,530.4259 ms. Applied-source focused localization/HTTP tests:
92/92/0/0 in 3,207.5623 ms. Root build and the maintained website gate pass.

The first prototype rejected two tests that assumed a different existing HTTP envelope and one
that rejected an earlier valid Arabic spelling of one character. A later privacy regex mistakenly
matched a canonical error code, and an internal-failure test guessed a nonexistent route. Tests now
assert exact field keys and the actual /api/platforms route; production refusals were not weakened.
Failed sources/logs remain retained. An orchestration attempt used an incorrect draft cwd and
failed before any source write; its rerun is not qualified evidence. An initial preservation probe
also guessed the MCP AST selector; the corrected proof checks the exact original selector and bytes.

Source preservation verifies 537 other tracked files: 424 backend, 53 other website and 60 other
tool files. Nine previous locale selector functions and all 45 original complete-gate statements
remain byte-identical, with one added required-message loop. Two other HTTP functions, all 20
original setup statements, all three error-normalization statements and the original MCP branch
selector/response remain exact. Original native execution, authorization/CSRF, provider scopes,
write reviews, workers, browser controllers, styles and maintained browser helpers remain unchanged.

## Release qualification policy

Fresh sanitized default full checks with required FFmpeg, build/report regeneration/freshness and
the complete working/committed 408-case served browser proof must qualify the sole guarded push.
Three tracked report files will be checked against actual regenerated public artifacts.
No hosted workflow is started or queried. Deployment/source-image, Linux/Docker, physical assistive
technology, live OAuth/provider entitlement and remaining plan expansion are not inferred from local checks.

## Complete working-source qualification

All six fresh sanitized install/build/regenerated-report/freshness/default-full/Railway stages pass.
Main 4,553/4,553/0/0 in 147.528 seconds; capture 4/4/0/0 in 87.7679 ms.
Required FFmpeg runs at default concurrency with zero skips. The fresh working candidate contains
1,838 public files and one literal empty generated sample; digest f3c23a87b0abeb2c150df7efe12c8d3f4505bda39f54e37f0a382e0f2b8561f1.
All three tracked reports regenerate identically. Closing documentation follows this candidate;
a fresh exact committed candidate and full clean-head served proof qualify the sole guarded push.

All 408 maintained served journeys pass from 2026-10-05T09:59:31.188Z through 2026-10-05T10:25:16.970Z.
Website digest 4be9acc84956807a03e48ea58eeacfa08ade4770d439f6fbfc2a75b2f2745ec8. All preceding 408 identities and original
1,368 workbook rows, 360 scoped controls, 160 labeled fields, eight About Us views and every
capture/provider/measurement/permission/form/metadata/navigation/inventory assertion remain required.
The selected inventory refusals retain all 48 manual-only recovery assertions and their original
fixed native reads with zero external provider requests or mutations. Twelve new HTTP/VM tests
qualify selected website diagnostic ownership and early error correlation separately; they do not
represent a live OAuth callback roundtrip or physical assistive-technology acceptance.

Source preservation verifies 537 other tracked files: 424 backend, 53 other website and 60 other
tool files. All 4,222 previous Arabic values stay exact; 193 entries are added. Nine old locale
selectors/all 45 complete-gate statements remain, with one added required-message loop. Two other
HTTP functions/all 20 setup statements/all three normalization statements and the original MCP
branch selector/response retain exact bytes. Native execution, scopes/auth/CSRF, reviews, workers,
browser controllers/styles/helpers and old test assertions remain unchanged. The actual production
entry already connects the optional sink to stdout/stderr; deployed log retention is unverified.
Prototype assumption failures and the rejected probe remain preserved. Hosted Actions stay waived
and unpolled. B13/B16/B24 and the 13 implemented / 14 partial / one open matrix remain unchanged.

## Exact committed-source receipt

Code commit 72f74f49e5700272a158dcb6b20faac11349a8e1; qualified tip 7a5e4de91f1e460cd831473dff24f83f48502182 [skip ci].
All six fresh sanitized stages pass with required FFmpeg and identical tracked reports.
Main 4553/4553/0/0 in 153470.3801 ms; capture 4/4/0/0 in 79.8836 ms.
The exact public-source digest is 86d2d64292d203ffff01581c0da71a4aff83bedde43c676d1bacdbe88663ebfe.
All 408 clean-head served journeys pass from 2026-10-05T10:30:14.695Z to 2026-10-05T10:56:09.610Z.
The sole Work-here push was confirmed against the actual remote at 2026-10-05T10:57:19.802Z,
with a clean working tree. Hosted workflows were neither started nor polled. This receipt
qualifies local committed source; it does not attest the current Railway backend/image.
