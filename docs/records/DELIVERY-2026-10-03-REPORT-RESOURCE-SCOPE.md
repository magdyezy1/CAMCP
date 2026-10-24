---
status: record
tier: engineering
---

# Retained GA4 and Search Console reporting scope

Batch 119, 2026-10-03. Repository magdyezy1/CAMCP; sole branch Work-here. Baseline 54a7fef.

Operations, saved-query discovery, report status, result retrieval and recovery now recognize selected canonical
GA4 property/resource names and Search Console site selectors. They resolve the original retained definition
against the caller's current tenant, actor, login and account grants. The original job/query/result bytes are
preserved; this adds no provider route, write family, OAuth scope or external request.

## Confirmed findings

F-189 (high) was reproduced using a completed synthetic legacy report with explicit account_id 100 and native
property properties/200. Before the fix, the current account-100 login could retrieve its synthetic result because
metadata ignored the canonical property. Valid property-only and site-only definitions also failed scope recovery.
Additional actual red regressions exposed ignored native key normalization and first-key/last-key differences in
duplicate raw JSON selectors and configuration wrappers. No production account, credential or incident was inspected.

The common gate now combines the recognized native selectors with existing account/connection anchors and requires
one exact account and login. Contradictory, malformed, oversized or ambiguous inputs remain unavailable. Result/status
access and recovery use the same current-authority check; the Operations list withholds inaccessible records.

F-190 (low, module initialization) was reproduced by importing reporting metadata modules in fresh Node processes.
Operations vocabulary was evaluated through a Workspace import cycle; a second cycle evaluated workbook schedule
SQL before initialization. The vocabulary now lives in a dependency-free module. The Operations SQL is assembled
once on first use, after modules initialize. Exported values, query semantics and schemas retain their existing values.

F-191 (low) was observed in the actual Arabic browser journey: AMCP's workbook next-step instructions and a missing
revision remained English. Six explicitly selected first-party instructions now localize, with a localized unknown
revision and worker-attempt label. Unfamiliar/provider guidance stays source text. Original names, account/login/run
IDs, stored definitions, native request values and MCP arguments remain unchanged.

## Exact adapter and privacy limits

- GA4 recognizes property as a bare exact numeric ID or properties/{id}, and derives only that parent from a
  canonical name/parent resource. Fully qualified report_task_name and audience_export_name can provide the parent;
  bare child IDs cannot. Registered root/params/path_params selectors and nested request property fields contribute
  scope. Arbitrary endpoint paths, provider responses and unrelated request strings do not.
- Search Console recognizes siteUrl/site_url/site/property_url in the existing root/params/path_params/payload
  locations. It preserves domain-property and URL-prefix bytes, including trailing slash; credentials in URLs,
  invalid selectors and conflicting properties are refused. It does not invent a property from an inspected URL.
- A pure nativeParameterKey helper supplies the unchanged compiler comparison and a deterministic per-connection
  SQLite function. Bounded json_tree traversal retains repeated selector keys and matches native alias comparison.
  Conflicting duplicate configuration/gateway/argument/operation wrappers cannot substitute a different parsed source.
- The retained envelope must fit 128 KiB; its selected native argument object must fit 64 KiB. At most nine scope
  occurrences are projected to detect more than eight; values are bounded to 513 characters before exact validation.
  More than eight occurrences, nontext selectors, invalid supplied request/payload objects or exceeded bounds produce
  no partial account proof. Oversized historical source is retained unchanged for correction through a fresh query.
- SQL projects only bounded scope selectors and existing metadata. Operations/status/discovery never load complete
  source definitions, private request fields, report rows/results or native child paths into their responses. Authorized
  get_reporting_run still retrieves the original retained result through the existing result endpoint.
- This recovery does not widen captured fresh-query schemas. Legacy alias/name forms accepted by the native mapper
  but excluded by a captured schema remain invalid for fresh authoring. Native write requests remain REPORT_WRITE_FORBIDDEN.

The source baseline is the existing DelegatedNativeCompiler, ScopeGuard, reporting validation and pinned official
GA4 Data v1beta/v1alpha, Analytics Admin v1beta and Search Console v1 discovery snapshots. The route/action/family
ledger remains 3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes.

## Qualification

The regressions cover canonical selectors, native compilation parity, exact URL encoding, wrong-account legacy
results, nested and duplicate selectors/wrappers, malformed values, byte/occurrence bounds, source preservation,
metadata-only reads, unsupported gateways, reader access, tenant/login/account/key revocation, independent module
imports and the actual MCP SDK. The SDK journey makes eight schema-validated calls, recovers original GA4 and Search
Console results, hides conflicting scope and refuses revoked access with zero provider requests or advertising writes.
The bilingual UI regression uses an actual resource-scoped status and checks escaped source names, unchanged calls
and retained input/result bytes. Red and green logs are in .runtime/report-resource-scope-20261003/.

Browser QA and sanitized preflight are recorded below after completion. Exact committed-source qualification runs
separately before the sole Work-here push; it is not inferred from a pre-commit test result.

## Prior delivery qualification

Batch 118 exact HEAD 54a7fefddcda51ea99731d49a5baf5171cffea72 passed sanitized install/build/report/check/Railway:
3,852 total / 3,847 passed / zero failed / five local FFmpeg skips, 96.853 seconds; four capture checks, 74.658 ms;
33 scripts / 2,980 selected Arabic messages / 284 documents. Its 1,606 public sources equal HEAD, plus one generated
empty sample; source hash 9415c7a68317a54f467564049d8231ad08c6eadeb4f95229c074ce2265171c00. Sole push succeeded.

[CI173](https://github.com/magdyezy1/CAMCP/actions/runs/37124945430) subsequently passed all 3,852 tests on both
host and Docker with zero failures/skips, 980.037/980.886 seconds. Four capture checks took 72.270/72.526 ms;
Railway compatibility and both synthetic container smoke modes passed. This confirms that revision's CI, including
the bounded ledger child deadline correction. It does not establish this new revision's CI, a deployment or live
provider acceptance. CI172's earlier failure remains recorded in the prior delivery.

The blueprint remains 13 implemented / 14 partial / one open. B13 gains selected canonical resource scope recovery;
B24 gains selected first-party reporting copy. Broader telemetry, unqualified historical formats, full Arabic and
assistive acceptance, actual deployment and live/entitlement qualification remain separate work.


Final focused qualification: 128 passed / zero failed / zero skipped, 10.283 seconds. Fifteen new regressions
cover the resource adapter, import seams, real SDK and selected Arabic rendering. The SDK made eight calls /
10,732 structured response bytes / zero provider requests. Response sizes can vary with observation times.

Actual browser QA used a disposable in-memory read-only workspace. Operations showed both allowed original
reports and a prepared run while withholding the conflicting property's name. English/Arabic 1280x900 views
measured 1265/1265 body/client width; 375x900 views measured 360/360, including final English and Arabic guidance.
Keyboard Enter expanded the exact original result-retrieval handoff; native run IDs and account/site bytes remained
unchanged. The final Arabic guidance and missing revision translated; unknown/provider/source text stays original.
No document horizontal overflow was observed. The fake transport recorded zero provider requests or advertising
mutations. Screenshots and browser-evidence.json remain in .runtime/report-resource-scope-20261003/.
This is synthetic responsive/keyboard observation, not complete assistive, editorial, deployed or live acceptance.

Sanitized preflight .release/report-resource-scope-preflight-20261003 passed install/build/report/check/Railway,
each exit zero: 3,867 total / 3,862 passed / zero failed / five expected local FFmpeg skips in 97.846 seconds;
four capture checks, 82.006 ms; 33 scripts / 2,986 selected Arabic messages / 285 documents. It includes
1,613 public source files plus one generated empty sample; hash
0afebb9fd8ce3addf2845759fdde7ead746845a6f228adf7306d88dc4d3bda5f. Exact committed-source qualification follows before sole push;
this earlier preflight does not contain its own subsequently recorded result paragraph.
