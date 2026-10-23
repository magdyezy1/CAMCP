# Catalog product evidence and receipt verification

Batch 104, 2026-10-03. Work only in `magdyezy1/CAMCP`, branch `Work-here`.

F-160 (high) is reproduced with synthetic transports: malformed product rows, unfinished pages, foreign retailer,
account or catalog IDs, and coerced product/business IDs were accepted before a catalog product review. A price
filter for another product could incorrectly verify a retained wrong price. These eight failing cases are now
tracked in `tests/meta-catalog-products.test.mjs`; the existing pre-execution identity-change control already passed.
No incorrect live provider result is asserted.

The family now checks exact native account, catalog and business identity and business ownership before collecting
product evidence, including during verification. Every product row has an exact string ID and the full-field
lookup matches the requested retailer. Malformed fields, unknown/malformed paging, a next page or a response above
the requested row bound are refused instead of being discarded or interpreted as absence. Terminal string cursor
metadata without a continuation remains accepted.

The mutation receipt requires an exact string product ID. Verification binds the retailer lookup, price filter and
optional sale-price filter to that same receipt ID. Foreign or incomplete evidence cannot establish verification.
Original outcomes, idempotency and recovery are preserved; a failed read-back or malformed receipt never causes
another mutation. No product deletion, batch passthrough or additional native family is introduced.

Focused catalog checks: **30 passed / zero failed**. There are 25 new cases, including the eight observed red cases,
malformed catalog/account metadata, receipt arrays/numbers/nulls, terminal cursors, sale-price identity, post-submit
identity changes and replay. Root suite: **3,651 tests / 3,646 passed / zero failed / five local FFmpeg skips;
94.22 seconds**. Evidence: `.runtime/catalog-evidence-20261003/`.

This repair tightens evidence against the existing qualified product contract; no new provider behavior is claimed.
The Meta Product Catalog Products and Graph API results references were requested on 2026-10-03 but both returned
HTTP 429. The established recorded contract remains the baseline, and no unavailable documentation was treated as
fresh provider qualification. Live account acceptance remains separate.

Previous batch 103 exact committed-source qualification on `54dac3d` passed all stages and Railway: **3,621 passed /
zero failed / five local FFmpeg skips; 90.77 seconds**, four capture tests, **1,556 public files + one generated
empty sample**, source hash `e64d5ea00317a83117b74c93c2c57a6fca78764923af1010f0a11ef18e1743b6`.
[CI158](https://github.com/magdyezy1/CAMCP/actions/runs/36976170282) succeeded on that revision. Job `110740374653`
logs were inspected: host and Docker each **3,626 passed / zero failed/skipped**, four capture tests and web checks;
the host Railway check passed. This is release/CI evidence, not deployed or live-provider acceptance.

Blueprint remains **13 implemented / 14 partial / 1 open**. B21 retains live WooCommerce connection, destination
mapping and reconciliation/removal gaps. Broader browser, provider and deployed acceptance remain unfinished.

Sanitized preflight `.release/catalog-evidence-preflight-r2-20261003` passed all five stages and Railway:
**3,646 passed / zero failed / five local FFmpeg skips; 94.43 seconds**, four capture tests,
33 browser scripts, 2,777 selected Arabic messages and 270 documents. Its **1,557 public source files**
plus one generated empty sample have hash `0a38eb861c9a776718eeeb0558e98a697507bc321369be2627b9c1e91b17f862`.
The initial candidate completed its tests but failed the new delivery-document index entry; the corrected fresh
candidate above completed every stage. Exact committed-source qualification follows before the sole Work-here push.
