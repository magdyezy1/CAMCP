---
status: record
tier: engineering
---

# Meta catalog product field proof — 4 October 2026

Batch 148 fixes F-209: optional fields accepted by a reviewed native catalog write could be absent from its
read-back contract and still yield `verified`. Three independent synthetic provider-discard cases reproduced
this for a product-group key, a custom label and a sale start date. Their native receipts were accepted, the
fields were absent, and verification incorrectly succeeded. No customer data or live provider write was used.

## Complete accepted-field observation

The existing original-business/catalog/retailer and receipt-bound price checks now include all 35 accepted
observable fields. Fixed explicit field selection includes native text/enums/URLs, labels and group key,
exact integer inventory, ordered additional image URLs and literal sale dates. Nothing is inferred from
formatted prices or converted through floating point. Missing fields remain null and cannot verify a supplied
value; malformed native types refuse the evidence. `allow_upsert` remains explicit execution intent. Unknown
legacy frozen fields have no current complete observation contract and are refused at verification.

The endpoint, accepted native payload set, source-import field set and write authority are unchanged. The
Meta website CSV/WooCommerce workflow still uses its qualified supplied-product projection. Observing a native
group key is a foundation for further variant work, not full variant reconciliation or live eligibility.
Provider normalization of URLs, ordered images or date text may prevent an exact match; no unqualified
normalization is guessed. Inventory is current read evidence, not ongoing availability or serving proof.

## Original receipts and pending workflow continuity

The versioned `meta-catalog-product-fields-v2` proof retires earlier partial caches. A current read preserves
the original accepted result, key and review. Pending dependency chains now obtain the current contract
version from the reviewed family, retaining the existing Google value-strategy fallback. Preparation,
execution, approval and whole-plan continuation cannot use a retired predecessor proof without current
read-back. Changed or unverified evidence stops that continuation. The accepted mutation is never resubmitted;
current complete cache reuse and current actor/login/account checks remain enforced. Historical completed
runs are not reset.

## Evidence, interface and contract research

- Three behavioral baseline failures: **3/0/3/0, 955.591 ms**. The same synthetic provider-discard cases after
  the fix: **3/3/0/0, 5.805 seconds**, each with one accepted fake mutation and inconclusive verification.
- Ten added tests include the independent 35-field SDK model, every missing observable field, native type
  refusals, original image order/date/inventory stale-review checks, discarded fields, cache retirement,
  pending predecessor continuation and a real MCP SDK journey. The combined catalog/cache/Google-value/X
  regression passes **72/72/0/0, 20.744 seconds**. Fixture-only omissions of the campaign brief, an unnecessary
  confirmation override, an unsupported `verify_next` action and a native argument connection-ID location
  were corrected without weakening application checks.
- Real MCP SDK: **five calls, 21,805 structured bytes, eleven synthetic reads, one synthetic mutation and
  zero external provider requests**. Input schemas, text/structured parity, exact advanced fields, current
  proof, original receipt replay and revoked client access are checked.
- Twenty-two selected authored catalog diagnostics were added to Arabic; all 3,741 previous values are
  preserved, with 3,763 total entries. Website checks cover 34 scripts, three pages and 3,557 explicitly
  selected messages. Native IDs/statuses/types/field details remain exact. Actual rendered browser and
  assistive-technology acceptance are separate.

[The contract record](../implementation/META-CATALOG-PRODUCT-FIELDS-2026-10-04.md) links the current versioned
official Meta SDK sources, exact hashes, field types and offline extractor. The Meta reference pages returned
429 and are not new qualification evidence. WooCommerce's current official variant and product contracts
were also inspected; variant name/image/parent semantics are separate from the standalone source mapping.

## Release and remaining work

The preceding batch's exact committed source `2225a6c0716d663c5cc2546273765ae0e4ccec40` passed all local
sanitized gates with required FFmpeg: main **4,293/4,293/0/0, 137.982 seconds**; capture **4/4/0/0, 73.255 ms**.
Maintained proof matched 1,753 public Git blobs, one generated literal empty sample and three tracked reports,
source hash `b6758de7b8e486e599ef7438bd7135262e4252b0de57ff9db3ae3f3c5c9890bf`. It was pushed solely to
CAMCP `Work-here` with the owner's `[skip ci]` marker after local source/report qualification.

This batch requires fresh sanitized report regeneration and full local source/build/freshness/check/Railway
gates before its sole push. The private root sample is not read. Required local FFmpeg keeps all media cases
enabled. The owner paused GitHub Actions after exhausted minutes; no further hosted CI runs are requested.
Previous CI200 qualifies only its own source. New Linux/Docker, deployed/browser/provider acceptance and
remaining contract/capability work are separate. The matrix remains **13 implemented / 14 partial / one open**;
this delivery does not close the entire plan. Actual source-specific gate results follow their execution.

## Batch 148 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Required local FFmpeg ran all media cases: main **4,303/4,303/0/0, 157.794 seconds**; capture **4/4/0/0, 73.648 ms**.
Website checks cover 34 scripts, three pages and 3,557 selected Arabic messages; documentation index 315.
The manifest contains 1,757 public source files plus one generated literal empty sample, source hash
`89a67f7fb2ead8496e5a513304f75207fa749c6572c4cb341427b2e5f146db19`. All three public reports regenerated unchanged after the
final sanitized build and preserved their bytes throughout qualification. The private root sample was not
read. This record follows that candidate; the final committed source requires fresh maintained Git blob/
manifest/report/sample proof and full gates before the sole Work-here push. GitHub Actions are skipped
at the owner's direction; no new Linux/Docker, deployed/browser or live provider acceptance is inferred.
The full plan continues with the remaining scope recorded in the package matrix.

## Exact committed-source release follow-up

Batch 148 committed code `c876384e6b3f924101e8a438c524b32a354731e7` and docs tip
`3166051a28db25203b35c4e48121c56e40f1e813` with the owner-directed [skip ci] marker.
A fresh clean-HEAD candidate verifies 1,757 exact Git blobs, one generated literal empty sample
and all three tracked report blobs, source hash
`3396592f200bdbdd4614920f07c5cbfaec2887e6b274997f379334c798018e19`. Offline install,
build, early report freshness, full checks and Railway compatibility all passed with required FFmpeg.
Main 4,303/4,303/0/0 in 129.835 seconds; capture 4/4/0/0 in 78.726 ms. Report bytes were preserved.
The sole authorized Work-here push succeeded. No hosted CI was started; actual later-source rendered
qualification is recorded separately in batch 149. The full improvement plan continues.
