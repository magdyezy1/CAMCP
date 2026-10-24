---
status: record
tier: engineering
---

# Catalog import comparison and focused review drafts

Batch 116, 2026-10-03. Repository `magdyezy1/CAMCP`, branch `Work-here` only.

Operators can now compare a supplied Meta product import with the current catalog before creating a draft.
`amcp_workspace` action `catalog_compare` accepts the same selected account/login/catalog, 1–50 source products
and explicit `allow_upsert` policy as the existing local preview. It reads only those exact retailer IDs using
the already qualified product family. It creates no native reviews, saved campaign plans or advertising changes.
An authorized reader can compare with an existing `ads_read` or `ads_management` grant; no write grant is inferred.

The result distinguishes new products, changed supplied fields, matching supplied fields and unknown fields.
Create-only mode separately blocks every existing product, including a matching one. The blocked count overlaps
the four comparison categories. `review_retailer_ids` includes new, changed or unknown products that the selected
policy permits; it excludes matching and blocked products. Omitted source fields are not declared unchanged.
Products outside the supplied import are neither inspected nor deleted; this is not a whole-catalog orphan scan.

Prices remain exact. The existing documented `price_amount` filter checks equality in native hundredths against
the exact product ID; formatted native prices remain unparsed display text. A missing currency or other supplied
field remains unknown. Every retailer lookup requires a complete bounded page, exact string identifiers and
qualified field types. Duplicate retailers, foreign product/filter IDs, malformed responses or a continuation
cannot establish a comparison. Product fields are read again after each price filter. The selected account and
catalog/business ownership bracket collection. Changes during these checks are refused, while the result still
states that sequential current reads do not establish a point-in-time inventory snapshot.

Each attempt rechecks current actor, account, login, recorded permission and credential identity before egress
and after the response. Collection has a shared limit of **180 attempts including retries, 150 product rows,
2 MiB response bytes and 60 seconds**. No partial comparison is returned after a limit or authority failure.
The result includes its selected scope, original source hash, evidence hash, observation times and attempt count.
No comparison snapshot is saved. The source data and native mutation contract remain unchanged.

The English/Arabic website preview now has one row per source product, exact source/native amounts, explicit
existing-ID policy, named keyboard-scroll regions and row/column headers. Comparison is an explicit read action.
It shows field differences and unknowns, keeps long native IDs intact and offers a draft containing only eligible
products needing review. The separate all-products action is named explicitly. Source fields and hashes remain
available in collapsed details. Editing the source/scope, changing identity, leaving the page or starting another
comparison invalidates late responses and obsolete save controls. A website handoff selects only the currently
available original account/catalog; it sends no product content in the URL and starts no automatic read.

Saving either draft still uses the existing campaign engine: fresh native before-state reviews, explicit write
authority and per-product receipt/read-back are required before execution. Comparison never authorizes a write.
Live WooCommerce synchronization, destination adapters and full inventory reconciliation/removal remain separate
unfinished work. Native product-edge DELETE is not introduced; the qualified product endpoint does not support it.

Three existing defects were reproduced before correction:

- **F-182 (medium):** a read-permission refusal named `catalog_management` and `ads_management` as required and
  directed users toward write/app-review configuration. The read check itself already accepted `ads_read` or
  `ads_management`. Its message and structured `required_any` now describe that existing read requirement.
  Existing write requirements remain unchanged; no credentials, scopes or provider app settings were changed.
- **F-183 (medium):** an accepted safe integer price of `9007199254740893` displayed as `90071992547408.94 SAR`
  instead of `90071992547408.93 SAR` in native review impact. Integer hundredths now render through BigInt division
  and remainder for both price and sale price, preserving zero and the whole supported safe integer range.
  The native integer and price-filter verification were already exact; no live monetary incident is claimed.

Focused qualification: **136 passed / zero failed / zero skipped, 3.272 seconds**. The tests cover native product
family regressions, all four comparison states, create-only conflicts, unknown versus zero, foreign/partial/
malformed evidence, changed ownership/identity/fields, revoked access, retry counting, whole-job bounds,
50-row imports, exact large-price display, bilingual escaping, compact row layout and stale callbacks/handoffs.
The real MCP SDK journey discovers and validates the schema, compares four products, saves exactly three source
products as an unapproved draft, inspects their original native prices and rejects a revoked key. It recorded
**four tool calls, 7,542 structured response bytes and 15 synthetic native GETs; zero advertising mutations**.
Runtime evidence is in `.runtime/catalog-comparison-20261003/`; no synthetic acceptance is called live acceptance.

The Meta Product Catalog Products reference was requested on 2026-10-03 and returned HTTP 429. No unavailable
document is treated as fresh provider qualification. This work reuses the recorded 2026-09-29 routes, ownership
checks, product fields and price-filter semantics; it adds no native family, action or permission requirement.

Batch 115 exact HEAD `ed8649f58cef6648385842614aac589cd6bdcf12` passed all five sanitized stages:
**3,790 tests / 3,785 passed / zero failed / five expected local FFmpeg skips, 91.547 seconds**, four capture
checks in 76.948 ms, 33 scripts, 2,927 selected Arabic messages and 281 documents. Its **1,595 public source
files equal HEAD**, plus one generated empty sample; source hash
`a130c15d691da040acb74cde0c67ed189d065ce157a3046ae3d891a88b955fec`.

[CI169](https://github.com/magdyezy1/CAMCP/actions/runs/37109416534) succeeded on batch 114 `f076d80`.
Job `111164267957` logs were inspected: host/Docker each **3,779 passed / zero failed/skipped**, 828.683/829.517
seconds, four capture checks, Railway and both synthetic container smoke modes passed.
[CI170](https://github.com/magdyezy1/CAMCP/actions/runs/37112106986) succeeded on batch 115 `ed8649f`.
Job `111171864383` logs were inspected: host/Docker each **3,790 passed / zero failed/skipped**, 844.667/858.314
seconds, four capture checks, Railway and both synthetic container smoke modes passed. These are CI/container
results, not deployed behavior or live-provider acceptance.

Blueprint remains **13 implemented / 14 partial / one open**. Native ledger remains
**3,247 / 167 / 1,712 / 800 / 502**. B21 gains bounded source-product comparison and filtered drafts; its live
store, destination and complete inventory reconciliation/removal work remains partial.


Sanitized preflight .release/catalog-comparison-preflight-20261003 passed all five stages:
install/build/report/check/Railway each exited zero. **3,808 tests / 3,803 passed / zero failed / five expected
local FFmpeg skips, 96.550 seconds**; four capture tests passed in 79.011 ms; 33 browser scripts, 2,955 selected
Arabic messages and 282 documents. **1,599 public source files + one generated empty sample**, source hash
`8c57afed8ed2ae5d7b9f6a7ffadb14668773903dfe9ecfa638b9ad2e18078d48`.
Exact committed-source qualification follows before the sole Work-here push.


**F-184 (low), found during batch 116 browser QA:** after switching language, the footer replaced the session’s
read-only/reviewed-write access label with the generic HTML localization marker. A real locale-lifecycle red test
reproduced the overwrite from the production footer assignment. The current session’s access label now updates
both text and its localization marker, so final/same-language relocalization preserves that mode. Server authority
is unchanged. Source/native names and form defaults remain intact.

The final 136-check run includes the production footer locale lifecycle in both read-only and reviewed-write
sessions. Browser checks used an in-memory local fixture with `ads_read` only, synthetic products and a transport
that refuses non-GET or non-Meta requests. English/Arabic desktop and 375-pixel mobile views showed no document
overflow. The named mobile table regions scroll by keyboard: English positive scroll and Arabic -40 pixels.
The complete Arabic comparison panel fit the normal 900-pixel desktop viewport without resizing to fit content;
the separate all-products button remains below that panel. Native IDs stay unwrapped. The Arabic filtered-save
action opened an unapproved draft with exactly retailer IDs 001, 002 and 004; matching 003 was omitted.
The full browser session recorded 60 synthetic native GETs and no advertising mutations. Screenshots and bounded
browser evidence are retained in `.runtime/catalog-comparison-20261003/`; none is live-provider acceptance.

The first exact-HEAD qualification of `82a538a` failed eight historical navigation tests: the small DOM adapter's
footer child exposed text only and lacked `setAttribute`, which the F-184 production correction now uses.
The adapter now implements that normal DOM method; the production correction is retained. Navigation and locale
checks pass 24/24, and the combined comparison/native-product/CSV/account/MCP/locale/navigation group passes
145/145 with zero failures or skips in 3.219 seconds. The failed sanitized candidate is preserved; the corrected
committed source is qualified in a fresh candidate before any push.
