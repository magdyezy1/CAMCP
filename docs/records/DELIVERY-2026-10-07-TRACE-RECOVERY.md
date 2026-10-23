# Scoped report recovery and supplied measurement traces

Batch 192 closes three identified source gaps on `magdyezy1/CAMCP`, sole branch
`Work-here`, in `CAMCP-Codes-final-branch`. Shopify, Salla, WooCommerce and Criteo
expansion/live acceptance remain parked. Native accounts remain read-only;
hosted Actions remain waived.

## Retained Reddit reports

The existing delegated compiler accepts the exact `ad_account_id` of its pinned
Reddit account routes. Retained-report recovery now recognizes that account
selector in root, `params` and `path_params` fields, including the compiler's
normalized alias spellings. The adapter uses the existing bounded SQLite
metadata projection; it does not read the whole query or result to decide
whether a caller may recover it.

Every observed selector must agree. Duplicate raw JSON keys, conflicting
accounts, non-text values, malformed/oversized envelopes, foreign connections
and revoked authority refuse recovery. Child IDs and arbitrary HTTP paths
cannot establish account scope. Existing run IDs, original state and native
write classification stay unchanged. The pinned route reference is
`generated/vendor-routes.json`: `GET_AD_ACCOUNT`,
`GET /api/v3/ad_accounts/{ad_account_id}`, captured from the Reddit Ads OpenAPI
source. This is pinned-contract/local qualification, not a fresh live Reddit
acceptance claim.

Four meaningful tests exercise the actual compiler, bounded metadata and the
real MCP SDK Operations-to-original-run handoff with no provider request. Both
JSON text and structured outcomes must carry the same result; authority is
checked again at recovery time.

## Browser-local trace inspection

Measurement has a fifth task, **Inspect a sanitized event trace**. Select a
current GA4 property and supply a sanitized JSON sequence. **Load a synthetic
example** fills the editor only; **Inspect trace locally** explicitly evaluates
it. There is no trace endpoint, provider request, event submission, tag change,
local-storage write or retained trace. Clear removes the editor and observations;
navigation and identity changes invalidate the original view.

Accepted version 1 has exactly `version`, `scope`, `coverage` and `steps`:

- Scope contains exact numeric text `property_id` and `stream_id`, and one
  `amcp-test-` synthetic identifier. Property must match the selected account.
- Coverage is explicitly declared `complete` or `partial`; neither declaration
  proves the supplied capture is exhaustive.
- There are 1–1,000 consecutive steps with nondecreasing relative integer
  `at_ms` within one day. Equal times retain the supplied order.
- `consent_default` and `consent_update` accept only `analytics_storage`,
  `ad_storage`, `ad_user_data`, `ad_personalization` and granted/denied values.
  Omitted default values are unknown; updates preserve unchanged state.
- An `event` contains its exact event name and the same synthetic test ID.
  Optional analytics/ad storage-write observations must be booleans. A
  purchase-only `transaction_key` may be an opaque SHA-256-shaped key; the
  original transaction identifier is never accepted or rendered.

The parser bounds UTF-8 input to 128 KiB and nesting to six levels. It rejects
duplicate JSON keys before parsing, including escaped equivalent spellings,
extra fields, malformed ordering, mismatched scope, raw URL/cookie/user-ID
fields and original transaction identifiers. It does not claim to independently
verify that user-supplied observations are true.

Findings identify missing/late/repeated defaults, updates without defaults,
declared storage writes under denied storage consent, unavailable purchase
identity and repeated opaque purchase keys. No event alone establishes a
consent violation: cookieless measurement is possible. A repeated key does not
prove that GA4 counted the purchase twice. Native deduplication, actual runtime
consent, attribution and live acceptance remain explicitly unverified.

This distinction follows the primary
[Google consent guidance](https://developers.google.com/tag-platform/security/guides/consent)
and [GA4 transaction-ID deduplication guidance](https://support.google.com/analytics/answer/12313109?hl=en).
The inspector observes supplied order; it does not replace GTM's consent APIs
or prove a native runtime's processing order.

The result retains the exact synthetic scope and native event names, shows
inherited/unknown consent states, and pages 25 rows at a time. A named focusable
scroll region, caption and scoped headers preserve keyboard access at narrow
widths. Paging focuses the result heading. Editing or changing the account
clears old observations; appearance changes preserve input and results. All
42 new owned messages have reviewed Arabic entries; protocol keys remain literal.

## Dynamic diagnostic translation

The existing server formatter can append native field names and diagnostic
reasons to a known authored base sentence. Only that exact formatter-produced
split now receives optional `meta.message_parts`. The website verifies that
base plus literal suffix reconstruct the original message before translating
the base. It checks again at display time. Unknown/provider messages and
untrusted upstream bodies stay literal. Original error message, code, details,
recovery, retry and request references remain unchanged. Forged or stale parts
cannot replace another message.

The Arabic catalog now has 8,589 pairs and covers all 8,402 selected owned
messages. The backend inventory remains 438 files with the existing 2,651
selected wrapper explanations; no generated native schema or action changes.

## Qualification at implementation freeze

The 82 related recovery, scope, diagnostic, trace, navigation and localization
tests pass without failures, cancellations or skips. The first rendered
prototype retains 16 passes/32 failures: older navigation assertions expected
four sections, and the new trace harness awaited a toast although validation
correctly uses persistent inline form feedback. Correcting those expectations
preserves the real interaction and all safety/assertion checks. The fresh
second prototype passes all **48/48** English/Arabic light/dark trace and
navigation journeys at 320, 375, 768 and 1280 pixels. It makes no provider
request and submits no trace to an HTTP endpoint.

The maintained browser matrix now contains 1,200 cases. Full sanitized
required-FFmpeg checks, generated public-report freshness, the complete browser
matrix, committed-source equality and deployed identity are still publication
gates; the completed results are recorded below after they actually run.
Prototype evidence does not qualify a later changed source automatically.

The [fifteen-package audit](../archive/COMPLETION-2026-10-07.md) remains honest about source
expansion, external-client/manual/container/load acceptance and unavailable
private programs. This delivery does not convert supplied traces into runtime
acceptance or declare all fifteen packages fully complete. The remaining live
write checks require designated test resources and explicit authorization
beyond the owner's current account-read restriction.


## Completed trace and recovery qualification

The public-only v17 candidate passes **5,096 main tests and four capture tests**,
with zero failures, cancellations, skips or TODOs and required FFmpeg. Offline
installation, build, report regeneration/freshness, every default-check stage
and Railway configuration exit zero. A fresh clean-source v18 candidate passes
its eight source/report/format/web/docs/Railway stages and exact Git verification:
1,948 public inputs plus one generated literal empty sample, no environment
file, and all three tracked public reports equal HEAD. Every actual full-suite
input is independently byte-identical to clean committed source
`be3a6301927511e84f6d9ed29f6ffb8394c8de99`; the original working-snapshot manifest's
HEAD claim is retained rather than relabelled.

The complete maintained browser matrix passes **1,200/1,200** on that exact
clean source: 600 cases in each language and initial appearance, with
344/256/256/344 cases at 320/375/768/1280px. All 61 populated fixtures use every
combination; selected empty baselines retain their maintained narrow/wide scope.
The actual run starts at `2026-10-07T07:28:39.028Z` and finishes
at `2026-10-07T08:27:03.497Z`. Its runner, fixture, helper,
website and hash-pinned axe-core 4.14.0 inputs match the frozen record. All 62
fixture lifetimes retain their actual tenant identity, with at most two active
and no overlap for a shared tenant. The sixteen local trace journeys submit no
trace HTTP request and make no provider request. Original prototype failures
remain preserved separately.

A fresh actual thirty-minute upload test also runs on this same source and
packaged application. The isolated in-memory Store/HTTP/real-FFmpeg service
retains the encrypted upload until its original deadline. Its independent
timer removes stored chunks and thumbnail metadata **629 ms after that
deadline**; the next thumbnail read returns 404. No clock is simulated and no
HTTP request or worker triggers cleanup after the initial upload. It touches
no production account or file and makes no provider request. This qualifies
application expiry on the stated host, not forensic erasure or production
deletion.

The independently bound packaged application has 1,356 files / 52,424,672 bytes,
SHA-256 `b033445640f7490fd6cdaa305494089ed2b88e413e0612f3aa372d1d4de2a3b2`.
Its public asset version is
`6fe1ff0f41f165e598ca43faba05d601b168cec5c54d42c40c2ddef129b2a5a0`.
The proof is `final-trace-browser-retention-qualification-v1.json`, retained
under the ignored local `.runtime/completion-20261007/` directory alongside
the actual logs and source proof. Root private environment/sample files remain
unread and no hosted Actions or native account mutations occur.

The supplied trace's property matches the current selection; its stream and
coverage are declarations. Native stream ownership and the truth of supplied
observations are not independently read or certified. Complete manual/physical
accessibility, a new Linux/image digest, actual production workload, live Sheets
delivery, native writes and positive private-program entitlement remain
separate. The host has no Docker/Podman runtime or installed WSL distribution.
The owner has not supplied the required designated test resources/write
authorization; LinkedIn private programs remain denied and no DV360 advertiser
is configured. Broader source expansions in the fifteen-package audit also
remain explicit. The matrix stays **13 implemented / 15 partial / zero open**.

The final documentation-only commit must independently pass fresh committed
source/report and packaged-identity verification before the sole Work-here
push. These actual main/browser/clock runs remain recorded on their true source;
deployment observations are separate from this qualification.
