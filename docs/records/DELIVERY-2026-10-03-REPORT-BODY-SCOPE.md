# Batch 115 — scoped encoded report bodies and credential containment

Baseline: `f076d8059050470166cdfa274e1f099be866606d`. Sole repository `magdyezy1/CAMCP`, sole branch `Work-here`.

## Recovery behavior

Operations, original workbook-run status, query discovery and workbook schedule scope can recover exact account
identifiers retained inside JSON-encoded bodies for **DV360, LinkedIn and X**. These are the three existing direct
compilers that already parse encoded native bodies; their shared allowlist now also governs metadata recovery.
Ordinary object bodies nested under `params.payload` and `params.body` are included alongside existing locations.
No new native action, native request format, scope, provider permission, migration or dependency is introduced.

SQLite projects only known account aliases from `payload`, `body`, `params.payload` and `params.body`, including
the existing delegated argument envelope. Body text and arbitrary fields never enter the Operations/status
projection. Supported encoded bodies must be JSON objects no larger than 64 KiB in UTF-8. Exact text identifiers
remain required; numeric/array identifiers are refused. The current actor, tenant, login/account grants and
connection ambiguity rules still apply on each page. Original retained job/query bytes remain unchanged.

Every account occurrence is considered, including repeated JSON keys. Conflicting first/last-key identities
cannot gain access through differences between SQLite and JavaScript parsing. Each body projects at most nine
occurrences, enough to reject more than eight. Malformed JSON, arrays/scalars, oversized encoded bodies, conflicting
aliases and unsupported sole-anchor formats fail closed. Resource-path inference and other unqualified historical
formats remain separate work; this is not a general opaque-text or URL parser.

## Credential safeguards

**F-180 (medium):** an actual disposable probe against the prior qualified revision created a saved definition for
a recognized LinkedIn read containing a credential key inside JSON text. The previous validator accepted it,
stored that synthetic value in the local query, and returned it in query detail. This proves the application
containment gap; no real secret, provider request or vendor acceptance was involved.

The same credential rules used for ordinary workspace objects now inspect decoded native JSON before saving.
The existing unsafe-property, identifier and nesting guards also apply. Encoded native bodies over 64 KiB are
refused before parsing. New saved definitions and newly prepared copies of unsafe legacy definitions are refused.
The report worker checks retained input before invoking collection, so legacy queued/resumed runs containing
recognized credential fields fail without native egress or a provider retry.

Legacy query detail, bootstrap, run retrieval and execution previews mask credential fields in supported encoded
bodies. Ordinary JSON credential keys use the same projection protection. Valid harmless JSON text preserves its
exact original spacing and integer text; a changed/redacted body is a public projection only. Query detail sets the
existing `configuration_redacted` flag. No retained original, query revision, source hash, job input or historical
audit record is rewritten or deleted. Existing data containing real credentials would still require an owner to
review the definition and rotate those values through the appropriate credential workflow.

**F-181 (high):** the first guard correctly refused a synthetic encoded credential definition, but a separate red
service test proved the refused value survived in its permanent error audit. Reporting-aware redaction now covers
the known query-definition containers before error audit insertion, while retaining the prior personal-data,
connection, place-action and Meta-post protection paths. The refusal response and new audit contain no credential
marker. Existing historical audit rows are preserved; no historical cleanup or real incident is claimed.

## Verification

Eleven new tests cover supported bodies in all four locations, exact source preservation, bounded metadata,
malformed/numeric/array/oversized values, conflicting duplicate keys, occurrence limits, current account withdrawal,
tenant isolation, all three real read-contract validators, decoded credential/nesting checks, legacy projection
redaction, refused-input audit containment and worker refusal before collection.

Actual HTTP MCP SDK discovery/status calls recover the original run and exact login/account; token revocation
refuses the following call. The provider transport rejects egress and its call count remains zero. Public projections
contain no arbitrary body marker. No independent third-party client or live/deployed acceptance is claimed.

Final focused qualification passed **55 tests / zero failed / zero skipped** in **4.714 seconds**, including existing
workbook operations, management, schedule, association/rebinding/retirement and reporting-worker regressions.
An initial import-order fixture error was corrected before the four behavioral red tests. A probe path error,
incorrect revocation fixture signature, depth/message fixture mismatch and unused imports were corrected; they
are not application findings and did not weaken checks. The saved-definition and audit gaps were reproduced
separately against actual built code. Final sanitized full-suite qualification follows.

No website controller or authored user-interface message changed. Existing Arabic configuration-redaction/error
behavior, native diagnostics and current-scope controls remain in place. Native classification remains
**3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**. The package matrix remains
**13 implemented / 14 partial / one open**. B13 gains supported encoded-body recovery; broader observability and
unqualified path/other historical formats remain partial. Real tenant load/capacity and external acceptance remain
separate evidence requirements.

## Previous delivered release

Batch 114 exact HEAD `f076d8059050470166cdfa274e1f099be866606d` passed install/build/report/check/Railway in
`.release/service-timings-work-here-head-20261003`: **3,779 tests / 3,774 passed / zero failed / five expected local
FFmpeg skips**, **92.796 seconds**, four capture checks in **73.365 ms**, 33 scripts, 2,927 selected Arabic messages,
3,079 catalog entries and 280 documents. All **1,593 public source files** matched committed HEAD before/after;
the single generated historical sample was empty. Source hash:
`025817521167c1aab6666932ec239afe7e39b60f5e5ea572b0c169e42b702fb1`. The sole Work-here push succeeded.

[CI169](https://github.com/magdyezy1/CAMCP/actions/runs/37109416534) on that revision was still in progress at the
last read. No result or log qualification is inferred from its running state.


## Sanitized preflight

`.release/report-body-scope-preflight-20261003` passed install/build/report/check/Railway: **3,790 tests /
3,785 passed / zero failed / five expected local FFmpeg skips**, **94.561 seconds**, four capture checks in
**86.588 ms**, 33 scripts, 2,927 selected Arabic messages and 281 indexed documents. **1,595 public source
files plus one generated empty historical sample** have source hash
`6ce075f4967f5aa7c6a44a4cd2529936e81539fd34840e765dcbe07c04673cef`. Exact committed-source qualification
follows before the sole Work-here push.
