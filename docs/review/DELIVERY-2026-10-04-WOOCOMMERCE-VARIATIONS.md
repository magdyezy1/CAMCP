# Selected WooCommerce variations with reviewed Meta titles and groups

Batch 152 extends the read-only store source to explicitly selected published variations of one
published variable parent. The Commerce page preserves each child SKU, native attributes, selected
price string, currency and provider-reported image. The exact parent SKU becomes a Meta product
group only after an operator reviews a destination title and checks that child. No row is selected
automatically and neither a read nor a local preview publishes a product.

## Source and destination contract

The original standalone selector remains `requirements:{product_ids:["101"],price_field:"price"}`.
The new selector is `requirements:{source_kind:"variations",parent_product_id:"101",
variation_ids:["102"],price_field:"price"}` on `amcp_workspace catalog_source`, with the exact
`commerce_native_action` account and connection. Select 1–50 distinct canonical decimal child IDs
under one distinct canonical parent, and choose price, regular_price or sale_price. Mixed selectors,
caller URLs, coercion and duplicate IDs are refused before authenticated egress.

The [official variation schema](https://developer.woocommerce.com/docs/apis/rest-api/v3/product-variations/)
and [parent schema](https://developer.woocommerce.com/docs/apis/rest-api/v3/products/) were inspected
on October 4. They distinguish literal child attributes, image, SKU and string prices from the
parent's native name and variation membership. WooCommerce supplies no native variation name or
child parent_id in that schema. The source therefore returns name:null, requires_title_review:true
and a bounded parent/attribute-based suggestion. The suggestion is visibly an operator-reviewed
destination title. It is never asserted to be a native child name. No price is rounded, SKU invented,
parent image substituted or native attribute translated.

Six fixed GETs read currency, exact parent, selected children, repeated selected children, repeated
parent and final currency. The parent must be published/variable with native parent_id zero and a
bounded canonical unique membership set containing every selected child in both observations.
Selected child IDs/status/count headers and complete projected fields must agree. Reordering a
membership or child collection is harmless; a changed identity, membership, attribute, name, SKU,
selected price, image, modification value or currency withholds the whole source.

The encrypted one-store wc/v3 Read or Read/Write connection retains fresh public-DNS-checked HTTPS
sockets, fixed GETs, Basic credentials in headers, no redirects or retries, current actor/account/
login/key/scope/origin checks before and after requests and body chunks, one 30-second deadline and
a combined 4 MiB body bound. At most 102 parent/child rows and six requests are collected. No
snapshot, write review, campaign or provider mutation is created by this source. Selected repeated
evidence is sequential; it is not an atomic inventory snapshot.

Missing or surrounding-whitespace parent/child SKUs, a child SKU equal to its parent, missing parent
name, unsupported delivery, duplicate selected SKUs and invalid selected prices/images remain
visible blockers. Source strings remain unchanged. Backorders and unknown stock do not invent an
availability, tax is not calculated, and a provider-reported image does not establish custom-child
image ancestry. Suggestions beyond the native title bound remain absent for explicit human entry.

Meta supplied-product API preview/plan accepts optional retailer_product_group_id using the existing
qualified native field validator and complete field proof v2. Current group differences and omitted
group evidence remain changed/unknown in read-only comparison. The website's ordinary CSV column
mapping and all ten required X fields retain their existing surfaces. This selected variation flow
does not qualify full variant reconciliation, inferred missing-item deletion, feeds or X variants.

## Website and MCP journey

Commerce offers a source-kind choice, exact parent ID, selected child IDs and explicit price choice.
Navigation and source-field entry start no provider read. The source table presents escaped original
parent/child identities and literal attributes in a named keyboard-scroll region, with the existing
readable product-label column. Every eligible child has a destination-title input and an unchecked
selection labeled with its explicit parent-group mapping. Selection transfers the reviewed title,
exact child SKU and price, native currency/image and shown parent SKU to Meta preview. The preview
table displays the exact group ID alongside the native hundredths and source price.

Editing a title unchecks that child and clears the staged destination preview. Changing parent,
source kind, IDs, selected price or checkbox invalidates the relevant source/handoff. Route, identity,
detached-view and delayed-response fences remain active. MCP website links preselect the same
original store, parent, children and price without starting a read. Saving remains an unapproved
draft with independent native review/receipt/read-back for each child before any execution.

Eighteen authored Arabic entries extend the interface catalog to 3,783 entries while preserving every
one of the previous 3,765 key/value pairs. Native names, attributes, IDs, SKUs and money remain literal.
Website checks cover 34 scripts, four pages and 3,576 explicitly selected messages. The maintained
browser runner adds eight selected-variation cases at 320/375/768/1280 pixels in both languages.

## Qualification and remaining scope

Two initial feature baselines failed because the source did not accept selected children and Meta
preview did not accept an explicit group field. Backend fixtures now exercise exact large integer
IDs, reordered children/membership, 50-child bounds, malformed/foreign/private/duplicate collections,
changed parent/child/currency evidence, visible blockers and native literal preservation. Current
authority withdrawal is exercised at all six read boundaries, plus late parent/currency body chunks.
Combined body overflow, late length/error/redirect/UTF-8 failures and a shared aborted deadline
withhold all earlier hierarchy evidence without retries or credential disclosure.

The real MCP SDK journey validates advertised schemas and text/structured parity through source
metadata, selected variation source, explicit Meta preview, one original unapproved draft and its
full retained step. Mixed selectors and a revoked client cannot trigger another provider read. Its
measured seven tool calls return 9,513 structured response bytes, with six fake native GETs, one local
draft, zero provider mutations and zero external requests. English/Arabic controller checks include
native escaping, absent child names, unchecked reviewed titles, exact group/price mapping, title
bounds and stale form/route/identity responses. Fresh full/source/browser release evidence follows.

These are local synthetic contract and selected rendering checks. Live store setup/provider
acceptance, full inventory/variant reconciliation, tax, inventory inheritance, supplementary feeds,
additional destinations and absent-source deletion policy remain separate B21 work. B15/B16/B24
also retain broader human/multi-client/editorial/assistive/device/deployed acceptance. The blueprint
remains 13 implemented / 14 partial / 1 open; this delivery does not finish the broader plan. Hosted
CI remains skipped at the owner's direction, with full local required-FFmpeg release checks retained.

## Focused and rendered qualification

The combined twelve-suite check passes 55/55/0/0 in 6.008 seconds, including group comparison and
the unchanged standalone/X workflows. The maintained served-browser runner passes 144/144/0
from 2026-10-04T19:04:07.440Z through 2026-10-04T19:06:49.833Z; all eight new variation journeys
complete twelve fake GETs (two explicit six-GET source reads), exact local title/group previews,
unchecked rereads and title/parent invalidation with zero provider writes or external egress.
Actual English 1280 and Arabic 375 screenshots were inspected; original long fields remain in
captioned keyboard-scroll regions. Source-label widths and both directions retain their measured
checks. Website digest 547dd3bae56f595fed1f8a4b7d3bce0e7bd4765a6b0e4b4374bdc67212b613c0 records the served working-tree bytes;
its Git base is not claimed as qualification of uncommitted changes. Fresh sanitized report generation
passes after local build; all three validated public artifacts regenerated unchanged. The root
private sample was unread. Full required-FFmpeg and clean committed-source/browser gates follow.

## Batch 152 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway pass: main
4,328/4,328/0/0 in 146.264 seconds, capture 4/4/0/0 in
70.935 ms. Required FFmpeg runs all media cases with zero skips. Website
checks cover 34 scripts, four pages and 3,576 selected messages; docs index 320. The sanitized
source manifest contains 1,773 public files plus one generated literal empty sample, hash
93cd654b1eba87495e222e1220d6aab37f90959c11ed8a85dca4aec2d27ba3aa. All three public report artifacts regenerate unchanged and preserve
their bytes throughout full checks; the root private sample remains unread. The 144-case actual
working-tree browser proof remains bound to website digest 547dd3bae56f595fed1f8a4b7d3bce0e7bd4765a6b0e4b4374bdc67212b613c0.
Fresh clean committed-source/default/browser qualification follows before the sole Work-here push.
Hosted CI remains owner-skipped; the remaining improvement plan continues.
