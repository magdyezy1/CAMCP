---
status: record
tier: engineering
---

# Supplier CSV column mapping for Commerce — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `e75b5aa`. Batch 84 expands B21/B15/B24 through the existing reviewed Meta product workflow.

Commerce now accepts an explicit mapping from supplier/export columns instead of requiring a separately renamed
file. The existing AMCP-column mode remains the default. Choose **Map supplier or WooCommerce export columns**,
load the selected local file, select each source column, then validate and preview. Matching AMCP field names are
preselected; arbitrary supplier columns, regular versus sale prices and currencies are never guessed.

Select a stable retailer ID, product name, decimal price and image column. Currency comes from one selected column
or an explicit uppercase three-letter constant for every row; using both is refused. A selected currency column's
missing values never fall back to the constant. Image handling is explicit: retain one literal URL or take the first
entry in a comma-separated list. Only that explicit list mode trims the selected first image. Other source values,
including leading-zero SKUs and decimal price strings, are preserved. All source rows are included; optional blank
fields are omitted from the request. The importer does not infer variant relationships, stock flags, active sales,
tax treatment or store currency. Select the intended rows when exporting and the intended price column when mapping.

Only selected product fields reach `catalog_preview`/`catalog_plan`; unused source columns remain in the local
page and are not sent to AMCP. The product preview includes expandable exact mapped fields as well as the existing
native-price summary. Saving reuses the exact previewed products and source hash, creates a draft, and still requires
the normal native before-state review, explicit write approval and independent per-item read-back. Mapping does not
grant account/catalog access or execute a provider change. It introduces no source-file retention or automatic feed
deletion. The original source file remains unchanged.

The parser retains quoted commas/quotes and Unicode text, accepts a leading UTF-8 BOM including before a quoted
header, and rejects malformed quoting/row widths, empty/duplicate headers, more than 100 columns, header names
over 200 characters/control characters, more than 50 product rows or input over the existing 128 KiB file bound.
Required mapping selections and row values fail before preview. Exact native field/value restrictions continue
through the existing backend product validation and reviewed native contract.

Loaded mappings belong to the selected File object. Changing files or layout clears them; every input change
invalidates the old preview/save action. Pending local reads, previews and plan responses remain fenced by the
current form, request order, route, identity and attached view. Mapping controls and errors are English/Arabic.

Seven new tests: four parser/mapping cases and two website cases observed red, plus one real-SDK draft journey.
Focused **42/42** passed, covering literal comma URLs, per-row currency, fixed currency conflicts, exact strings,
selected price/image behavior, unused-field withholding, BOM/quoting/limits, missing values, English/Arabic request
parity, changed files and stale form/identity results. The SDK exercises the actual browser mapping function,
published schemas, both result envelopes, preview, compact draft creation and explicit full-plan inspection:
**3 calls / 4,164 structured bytes / zero provider requests or mutations**. Static checks cover **32 browser scripts /
2,569 selected Arabic messages**. No new backend API, dependency, native route classification or schema migration.
These are synthetic/VM checks, not a live store/catalog or actual browser acceptance claim.

The [official WooCommerce CSV documentation](https://woocommerce.com/document/product-csv-importer-exporter/)
was checked on 2 October 2026 for the distinct SKU, Name, Regular price, Sale price and Images columns and the
first-image convention. This feature maps a local export; a live WooCommerce connector, supplementary feeds,
cross-destination reconciliation and deletion remain separate work. B21 remains partial, and the blueprint stays
**13 implemented / 14 partial / 1 open**. Native ledgers remain **3,247 actions / 167 families / 1,712 native reads /
800 reviewed writes / 502 blocked writes**. Logs: `.runtime/catalog-mapping-20261002/`.

Batch 83 exact-source qualification on `e75b5aa` passed every check/Railway stage: **3,417 passed, zero failed,
five local FFmpeg skips; 76.90 seconds**, four capture tests and **1,495 public files + one generated empty sample**.
Source hash: `03c2a89443f365385ddf8ecbb1de7542e64bf72261603e09cd188cdb74b2062a`.
[CI138](https://github.com/magdyezy1/CAMCP/actions/runs/36942604511) was running at this check.
[CI136](https://github.com/magdyezy1/CAMCP/actions/runs/36938607034) succeeded on `c7a086c`: host and Docker each
passed **3,401 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110624618959` uploaded release-evidence artifact `11199564339`.

Root suite: **3,429 tests; 3,424 passed, zero failed, five local FFmpeg skips; 76.25 seconds**.

Sanitized preflight `.release/catalog-mapping-preflight-20261002` passed every check/Railway stage:
**3,424 passed, zero failed, five local FFmpeg skips; 80.75 seconds**, four capture tests, 32 browser scripts
and 250 documents. Its **1,497 public source files** plus one generated empty sample have hash
`df242af2d4f4f2a2a3187cea2665e6489fef14ff9216d5d8ada1e79a3bb8d53b`. Exact committed-source checks follow before push.
