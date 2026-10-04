# Batch 134 — exact X catalog prices and receipt recovery

Baseline `c72af32`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This advances B01/B05/B15/B16/B21 by correcting F-204 in already qualified X product and product-set contracts.
It adds no native action, reviewed family, credential scope, entitlement or advertising mutation. All writes in
the tests are synthetic in-memory callbacks; they never contact X or an external destination.

## The reproduced precision defect

AMCP already accepts native price strings with up to 12 integer digits and six decimal places. Converting those
amounts to JavaScript Number collapsed `999999999999.000001 SAR` and `999999999999.000002 SAR` to the same value.
The original synthetic lifecycle accepted a changed before-state after review, marked a rounded price read-back
verified, rejected a real price-only change as a no-op, and rejected a genuinely lower sale price. Five corrected
baseline tests failed: **5 total / 0 passes / 5 failures, 680.885 ms**. This is a reproduced source defect, not a
claim about a live provider incident or the admissibility of these large amounts in a real account.

## Exact comparison with unchanged native requests

Supported amounts now compare as bounded fixed-scale integers internally. Public money projections contain a
canonical decimal **string** and the original currency, including ordinary values such as `"250"`. Leading integer
zeros and trailing fractional zeros normalize for comparison: `00250.000000 SAR` equals `250 SAR`; neighboring
millionths remain different. Zero stays zero, missing values stay missing, unsupported source values remain raw,
and no BigInt enters the JSON result. Sale prices must be strictly lower in the same currency using the same
exact comparison. Non-string product prices are refused before a provider request.

Native price/sale-price strings, SKU/product keys, catalog/account IDs, JSON bodies, reviewed request fingerprints
and original source bytes remain unchanged. Product-set price and sale-price filters use the same exact views.
Changed product prices or existing filter definitions invalidate frozen before-state before an unsent mutation.
The existing whole-array filter disagreement remains visible with exact expected/observed filter values.

Primary [X catalog reference](https://docs.x.com/x-ads-api/catalog-management/reference), checked 2026-10-04,
defines decimal text plus currency, a strictly lower sale price, and price/sale-price filters. It identifies the
endpoints as early-access only and does not establish AMCP's entire accepted numeric range as provider-approved.
Actual account entitlement and provider acceptance remain unverified. Existing limits, ownership/paging checks,
product variants and unsupported filtered-set updates are not broadened by this correction.

## Upgrade and recovery behavior

An unsubmitted legacy review with numeric money projections needs a fresh review; the stored request is not
silently rewritten or executed. An already accepted mutation retains its original key, native receipt and frozen
request. Repeating execute recovers that receipt without resubmission. Verification derives exact expected prices
from the original request and performs read-only recovery.

The two affected families stamp verified-cache receipts with `verification_cache_version:x-catalog-decimal-v2`.
An old verified cache without that marker cannot bypass a fresh read. Current exact caches still reuse verified
results for the existing ten-second period, subject to current actor/account authority. Other families keep their
existing cache behavior. Rounded read-back is first inconclusive and, on a second stable round, mismatch with
exact expected/observed values. It never resets idempotency or authorizes automatic corrective writes. Corrections
require a new explicitly reviewed request.

## Qualification and limits

Fifteen new checks cover supported boundary neighbors, decimal equivalence, JSON output, malformed/missing
prices, exact sale ordering, no-op detection, post-review price/filter changes, legacy unsent reviews, accepted
receipts, retirement of old false verified caches, stable disagreement, unchanged native bodies, current cache
reuse and withheld recovery after account or client access is removed. Existing X catalog/product/set/feed checks
also pass: **34/34/0/0, 4.392 seconds**.

The real MCP SDK journey validates advertised input schemas and JSON-serialized text/structured output parity.
It preserves exact price and sale-price strings in the original native body, identifies rounded read-back,
recovers verification after a synthetic exact observation, reuses the guarded cache, recovers the original accepted
receipt and refuses a revoked client. **Eight tool calls, 19,292 structured response bytes, 36 synthetic GETs,
one synthetic PUT, zero external requests.** The in-memory SDK transport retains optional undefined properties;
parity is measured after JSON serialization, as on the JSON-RPC wire.

Related and fresh sanitized release/exact committed-source checks follow below. Original ledger totals remain
**3,247 actions / 167 families / 800 reviewed writes**. The roadmap remains **13 implemented / 14 partial /
one open**. Live store connections, other destination adapters, full inventory reconciliation, production capacity,
external-client acceptance, new browser/assistive qualification and deployed/provider acceptance remain separate.
Work continues through the original roadmap.

The broader related set passed **3,197 tests / 3,192 passes / no failures / five expected local FFmpeg skips,
86.694 seconds** across 347 files. All three public reports regenerated unchanged from a fresh sanitized
candidate after local build; the private root sample was not read. Exact source and full release gates follow.

## Batch 134 sanitized release preflight

Fresh offline install/build/early report freshness/full check/Railway gates passed, each exit zero. Main suite
**4,116 total / 4,111 passes / no failures / five expected local FFmpeg skips, 100.469 seconds**; capture
**4/4/0/0, 80.313 ms**. The website retains 34 scripts and 3,315 selected Arabic messages; documentation
index contains 300 documents. Manifest: 1,691 public source files plus one generated empty sample; source hash
`e6815ddf23f955847b2c7d7049ba601d480b4a54a0b7b622b91c9c3edb24e316`. All three public report artifacts
regenerated unchanged and retained their bytes throughout qualification. The private root sample was not read.
These evidence paragraphs follow preflight; fresh exact committed-source parity and all gates precede the
sole Work-here push. No local Docker/FFmpeg, new browser, deployed or live-provider result is inferred.
