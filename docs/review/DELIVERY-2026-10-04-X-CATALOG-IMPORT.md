# Batch 135 — explicit source products into reviewed X catalog plans

Baseline `11304de`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This advances B05/B15/B21/B24 through an additional bounded destination for the existing source-product workflow.
It adds no native action, reviewed family, scope or entitlement. All provider responses and writes used below are
synthetic callbacks; no external advertising account or store is contacted.

## Source selection, native meaning and operator flow

Commerce now offers currently visible Meta and X accounts. The selected destination explains its actual import
requirements before preview. Operators can paste AMCP columns or map a local supplier/WooCommerce CSV export,
then preview 1–50 products and save an unapproved local campaign plan. Unused supplier columns stay local.
AMCP column mode refuses unsupported headers and directs the operator to supplier mapping. This is a bounded
file workflow: it does not connect to a store, infer stock, tax, currency, variants or sale prices, or delete
products absent from the source.

X requires explicitly supplied retailer_id, name, price, currency, image_url, url, availability, condition,
brand and a plain-text description. Currency comes from a selected column or explicit constant. Matching
product IDs can be updated, so X requires an explicit upsert choice; create-only imports are refused. Destination
changes invalidate the prior preview/save callback and never silently enable upsert. Meta retains its existing
required fields, exact conversion into native hundredths, create-only policy and qualified comparison flow.

The local X adapter preserves source strings and order. It maps retailer_id → id, name → title,
image_url → image_link and url → link; price is the original decimal text followed by the explicit currency.
It reuses the qualified native field validator, including bounded SKU/title/description lengths, credential-free
HTTPS links, native availability/condition values and the existing twelve-integer/six-fraction price syntax.
Plain-text multiline descriptions remain supported. The source hash covers the supplied products without
rewriting them. No floating-point conversion enters the X price preview or native request.

The preview presents exact source IDs, original names, native price strings, update policy and expandable native
fields in English and Arabic. Readable limitations distinguish a saved local draft from provider eligibility or
publication. Tables retain headers, a caption and a keyboard-focusable scroll container; source values are
escaped and preserve their native direction/text. X does not show Meta's source-comparison action because that
adapter is not qualified for X. Existing route, identity, detached-view and edited-form guards remain active.

Primary [X catalog reference](https://docs.x.com/x-ads-api/catalog-management/reference), checked 2026-10-04,
describes native product requests that create unknown IDs and update matching IDs, with decimal-text currency
prices, and identifies catalog endpoints as early-access only. This does not qualify AMCP's entire numeric range
or a customer's entitlement. The [WooCommerce exporter guide](https://woocommerce.com/document/product-csv-importer-exporter/),
checked the same date, distinguishes source SKU/name/price/image columns. The mapping requires operator choices;
it does not treat every WooCommerce row as an eligible native X product.

## Review, receipt and recovery remain separate for every SKU

Each source product composes one existing x_product_catalogs_product_catalog_id_products_put step containing
one product. Current connection/account checks remain on preview/save and native review. The existing campaign
runner then performs prepare → review → execute → independent read-back for each item. Native catalog ownership,
current before-state, original request hashes, author/session authority and spending acknowledgements are not
bypassed. Partial or uncertain execution retains each original accepted receipt and key; repeating the plan does
not repeat an accepted mutation.

An exact two-SKU synthetic plan completes with two independent verified receipts and two unchanged native PUT
bodies. A foreign catalog is withheld before a write review is retained. A supported exact large price followed
by rounded synthetic read-back remains mismatch, retaining its original accepted receipt through read-only
reconciliation without another PUT. These are source/lifecycle results, not live-provider acceptance.

F-205 corrects a separate first-party approval sentence: a stored product plan previously claimed that creation
"remains paused", although products are not paused campaign entities. One baseline Meta product-plan regression
failed in 551.024 ms. Generic approval now explains that a draft submits no provider changes and serving effects
are stated in each native review. Actual paused campaign recipes and their native payloads are unchanged.

## Qualification and remaining scope

Thirteen new checks comprise six backend/source/plan-lifecycle checks, five actual-controller fixture checks,
one generic product approval regression and one real MCP SDK journey. Backend coverage includes exact source
preservation, malformed/full-field requirements, duplicate IDs, native boundaries, explicit upsert refusal,
multiline descriptions, full approved-plan execution, foreign ownership, rounded read-back/original recovery
and current-account revocation. UI coverage includes English/Arabic native values and escaping, explicit supplier
mapping, unsupported canonical headers, destination changes and eight pending preview/save scope/form races.

Three original backend feature cases failed against the preceding compiled source: **3/0/3/0, 539.059 ms**.
Five original UI feature cases failed against the preceding committed controller: **5/0/5/0, 124.443 ms**.
The final focused set passes **78/78/0/0, 5.136 seconds**, including existing Meta import/mapping/comparison and
X product/set/decimal regressions. A broader related set before the final additional header-refusal case passes
**3,236 total / 3,231 passes / no failures / five expected local FFmpeg skips, 86.916 seconds**, across 351 files.
Fresh full release gates below qualify the final source, including that last client case.

The real MCP SDK journey runs actual browser column mapping, validates published input schemas and
JSON-serialized text/structured parity, previews exact native fields, saves one local draft, inspects the full
original plan and refuses create-only/revoked access. **Five calls, 6,384 structured response bytes, zero provider
requests, zero provider mutations, one local draft and zero external requests.** The selected Arabic catalog now
covers 3,330 active authored messages; twenty entries were added while replaced interface keys remain available.
Known authored explanations/refusals translate; arbitrary native/source diagnostics are not rewritten.

The browser automation runtime previously failed to initialize; deterministic controller tests do not certify
new visual, keyboard or assistive behavior. Local FFmpeg and Docker are unavailable; exact Linux/container CI
is required before a subsequent push. Deployed revision, real-account entitlement, store synchronization,
variants, additional destination mappings and full inventory reconciliation/deletion remain unverified or
unimplemented as recorded in the original roadmap. Ledger totals remain **3,247 actions / 167 families / 800
reviewed writes** and package totals remain **13 implemented / 14 partial / one open**. Work continues.

## Batch 135 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway gates passed, each exit zero.
Main suite **4,129 total / 4,124 passes / no failures / five expected local FFmpeg skips, 100.683 seconds**;
capture **4/4/0/0, 77.299 ms**. Website: 34 scripts and 3,330 selected Arabic messages; documentation
index: 301 documents. Manifest: 1,698 public source files plus one generated empty sample; source hash
`6f82c829f6ccddb2c55bd515507567a829451b282da533b49496c1fdd0908e3b`. All three public reports regenerated unchanged after sanitized build and retained
their bytes throughout qualification. The private root sample was not read. These paragraphs follow preflight;
fresh exact committed-source parity and all gates precede the sole Work-here push. No local Docker/FFmpeg, new
browser/assistive, deployed or live-provider result is inferred.

## Batch 135 exact-source push

Code `bd33aea`; evidence `af5f23f`. Fresh sanitized release matched all 1,698 public sources to exact
committed Git blobs with filters disabled, plus one generated empty sample. Source hash
`d89e326bdfc0002fa0dd8e19cfcc669353d844643e0cdab6702952bd447e406d`. All five gates passed:
**4,129/4,124/0/5, 109.863 seconds**; capture **4/4/0/0, 73.872 ms**. All three public reports remained
byte-identical after regeneration and throughout qualification. Fresh Work-here fetch/ancestry and verified
preceding CI189 guards passed before the sole explicit push. [CI190](https://github.com/magdyezy1/CAMCP/actions/runs/37183696538)
is for this exact source; completion is required before the next push. No deployed/live-provider result is inferred.

## Verified batch 135 exact-source CI190

[CI190](https://github.com/magdyezy1/CAMCP/actions/runs/37183696538) passed for exact
`af5f23f1b4a9e5838825b989bf5cf4406de2e81d`, source hash
`d89e326bdfc0002fa0dd8e19cfcc669353d844643e0cdab6702952bd447e406d`, 1,698 public source files
plus one generated empty sample. Linux host and Docker each passed **4,129/4,129/0/0**, in 486.873/488.342
seconds; capture **4/4/0/0**, 53.300/47.560 ms. All steps passed, including required FFmpeg, early tracked-report
freshness, full gates, Railway/image checks and both synthetic smoke modes. Both suites used two workers.
This verifies batch 135 source, not later reconciliation/native group changes or deployed/live-provider behavior.
