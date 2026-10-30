---
status: record
tier: engineering
---

# Batch 137 — typed X catalog identities and original receipt recovery

Baseline `d32321a`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This corrects F-207 across the existing X catalog, product, set and scheduled-feed contracts and advances
B01/B05/B15/B21. No native action, reviewed family, scope, entitlement or destination is added. All reads/writes
below use declared synthetic transports and in-memory records; no external account or store is contacted.

## Reproduced identity and recovery gaps

Eight corrected baseline regressions fail against the preceding compiled public source: **8 total / no passes /
8 failures, 722.825 ms**. That candidate was not modified. The shared catalog reader accepted numeric catalog IDs
by String coercion and ignored an explicit contradictory user owner. Product readers similarly coerced SKU and
generated product keys, including keys used by delete and manual-set membership. Unrelated missing/duplicate
identities, numeric cursors and responses exceeding the requested page size did not prevent native preparation.
Set/feed views accepted numeric generated IDs or contradictory catalog parents, and manual membership could be
coerced or inferred from missing values. Native outcomes and create-verification targets also derived string
identities from numeric original receipts.

A synthetic accepted product followed by numeric generated-key read-back was marked verified. Old verified
caches could reuse the previous identity interpretation. These are source/contract reproductions, not claims
about live provider data, a wrong real deletion, or a production incident. Even an apparently safe small integer
cannot substitute for an explicit native string identity; a larger parsed number may already have lost precision.

Primary [X catalog reference](https://docs.x.com/x-ads-api/catalog-management/reference), checked 2026-10-04,
defines string generated product/set/catalog identities and string SKU IDs, a string pagination cursor, native
product-key deletion and manual-set product selection. Its examples retain original string keys separately
from other numeric fields. The qualified adapter preserves this identity meaning without broadening early-access
entitlement, allowed accounts or the existing native numeric range.

## Exact collection and receipt boundaries

The same existing shared readers now require exact native string catalog/product/set/feed identities, unique
SKU/generated-key pairs across scanned pages, literal string continuation and the requested count ceiling.
Explicit returned user/catalog parents must agree with the account-owned collection that produced them.
Manual sets require an actual complete array of distinct literal SKU strings; omission is unknown, not an empty
membership. Normal individual/grouped product classification, the original scan bounds, scope and native request
bodies remain unchanged. No additional request is introduced. Other numeric fields, such as native feed repeat
values and exact supported prices, retain their established meaning.

Native outcome checks require exact original string identity, including product-key deletion responses. New
catalog/set/feed verification targets cannot be derived from a numeric or missing original generated ID. Such a
receipt remains preserved for investigation; the adapter does not invent an ID, rewrite the original native
response or resubmit the mutation. Exact existing target IDs remain bound to the original reviewed request.

All four affected families stamp fresh verification with verification_cache_version:x-catalog-identities-v3.
Earlier catalog/feed caches without a marker and product/set decimal-v2 caches require a fresh read. The change
does not reset accepted keys, receipts, native requests or other families' caches. Current v3 verified results
reuse the existing ten-second cache only under current actor/account/login authority. An unverified malformed
read cannot become cached success. Removing account/client access withholds recovery as before.

## Qualification and useful recovery behavior

Eight backend/native outcome/receipt checks cover the four families, numeric/contradictory catalog ownership,
missing/duplicate/numeric SKU/product keys, product deletion and manual-set key selection, numeric continuation,
oversized pages, set/feed parent and identity conflicts, manual membership, malformed read-back, original-key
recovery, old cache retirement, current cache reuse and refusal to derive a create target from a numeric receipt.
They pass **8/8/0/0, 941.493 ms**. A ninth new test runs the real MCP SDK.

The SDK validates published schemas and JSON-serialized text/structured parity, prepares/executed one synthetic
product update with its unchanged native body, withholds numeric-key read-back as unverified, recovers the original
accepted receipt by repeated execute without a second PUT, verifies after exact observations return, reuses
the current cache, retires an old decimal-v2 cache and refuses a revoked client before another read.
Final focused measurement: **eight tool calls, 21,143 structured response bytes, 20 synthetic GETs, one synthetic
PUT and zero external requests**. A separate SDK run measured 21,139 bytes; timing/response metadata vary in size.

The final focused suite passes **82/82/0/0, 5.760 seconds**, including all existing X catalog/product/set/feed,
exact-price/cache/variant, source import/comparison/UI/SDK and Meta comparison checks. The earlier single focused
failure was a fixture call that placed its synthetic AMCP login inside native gateway arguments; moving it to
the documented outer selected-connection field preserves the captured native schema. No native schema was relaxed.
The expanded related set and fresh sanitized/exact committed-source gates follow below.

Public website scripts, 3,340 selected Arabic messages and About Us remain unchanged. No new actual-browser,
assistive, deployed, live-provider, store or production-load result is inferred. Local Docker/FFmpeg remain
unavailable; exact Linux/container CI is required before another push. Full store synchronization, additional
destinations, complete inventory/deletion reconciliation, external-client acceptance and account-specific
entitlement remain separate. Native totals stay **3,247 actions / 167 families / 800 reviewed writes**, and
roadmap states remain **13 implemented / 14 partial / one open**. Work continues.

The expanded related set passed **3,197 tests / 3,192 passes / no failures / five expected local FFmpeg skips,
85.544 seconds**, across 346 files. This precedes the last additional missing-manual-membership case; that
eight-test native set then passed **8/8/0/0, 960.178 ms**. Fresh full gates qualify the final source. All three
public reports regenerated unchanged after an isolated sanitized build; the private root sample was not read.

## Batch 137 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway gates passed, each exit zero.
Main suite **4,154 total / 4,149 passes / no failures / five expected local FFmpeg skips, 100.113 seconds**;
capture **4/4/0/0, 88.980 ms**. Website: 34 scripts and 3,340 selected Arabic messages; documentation
index: 303 documents. Manifest: 1,708 public source files plus one generated empty sample; source hash
`9c53a771cde3171eaddc654889c30fb7685c1521c99ce3d176501e4ac1f3191d`. All three public reports regenerated unchanged after sanitized build and retained
their bytes throughout qualification. The private root sample was not read. These paragraphs follow preflight;
fresh exact committed-source parity and all gates precede the sole Work-here push. No local Docker/FFmpeg, new
browser/assistive, deployed or live-provider result is inferred.

## Batch 137 exact-source push

Code `1e34c56`; evidence `520f536`; release-document correction and verified preceding CI191 `18a3ac5`.
Fresh sanitized release matched all 1,708 public files to exact committed Git blobs with filters disabled, plus
one generated empty sample. Source hash `3cd315c42d1cf55140da2aff53afda67d6b3528995ade9b8d400692d3aa9fc10`.
All five gates passed: **4,154/4,149/0/5, 105.600 seconds**; capture **4/4/0/0, 77.297 ms**. The three public
reports regenerated unchanged and retained their bytes throughout qualification. The first exact-source attempt
refused a release note written to the wrong document; its target was corrected before a new committed-source
candidate and all gates. Fresh exact Work-here fetch/ancestry and verified CI191 guards passed before the sole
explicit push. [CI192](https://github.com/magdyezy1/CAMCP/actions/runs/37186820344) is for this exact source;
completion is required before another push. No deployed or live-provider result is inferred.

## Verified batch 137 exact-source CI192

[CI192](https://github.com/magdyezy1/CAMCP/actions/runs/37186820344) passed for exact
`18a3ac5fd5960de8935cf7396b3496af4d9facb8`, source hash
`3cd315c42d1cf55140da2aff53afda67d6b3528995ade9b8d400692d3aa9fc10`, 1,708 public source files
plus one generated empty sample. Linux host and Docker each passed **4,154/4,154/0/0**, in 711.974/707.045
seconds; capture **4/4/0/0**, 76.686/81.843 ms. All steps passed, including required FFmpeg, early tracked-report
freshness, full gates, Railway/image checks and both synthetic smoke modes. Both suites used two workers.
This verifies batch 137 source; selected-removal changes, deployed and live-provider acceptance require their own evidence.
