---
status: record
tier: engineering
---

# Batch 138 — explicit X product removal with original receipt recovery

Commerce now supports selecting observed individual X products for an unapproved removal draft. Nothing is
selected by default. Products outside the explicit selection are retained; products missing from an uploaded
source are not inferred to require deletion. This extends B21 through the existing qualified native DELETE
contract, without adding provider actions, reviewed families, credentials or entitlement assumptions.

## Selected products, current evidence and unapproved native plans

After validating a supplied CSV or mapped supplier/WooCommerce export, compare the current X products.
Choose the exact observed rows to remove and select Preview selected removals. Missing, grouped, potentially
hidden and unknown-group products are unavailable. Each checkbox identifies its exact SKU. The second preview
shows the selected current names, source SKUs, native product keys and exact native prices. Changes since the
comparison require a new comparison before the website offers the draft save.

The workspace actions are `preview_catalog_removal` and `create_catalog_removal`. Preview takes the same
validated source product fields and explicit `allow_upsert:true` used by X source comparison, plus 1–50 distinct
`retailer_ids` belonging to that source. These inputs validate source meaning; the removal plan contains only
single-key DELETE bodies. No PUT is submitted or placed in the removal plan. Every selected product must be
observed as an individual product under complete, repeated bounded catalog scans and current FULL-promotable
user ownership. Source comparison bounds remain 1,000 listed products, 180 attempts including retries, 5,000
collected rows, 4 MiB and 60 seconds per collection.

The original scope, source hash, selected supported product evidence and credential/grant signature bind a
ten-minute preview to its author, role and session. Preview storage is bounded to 100 current records and
256 KiB per binding. Expired uncreated previews are reclaimed; created plans remain retained. Unknown provider
attributes are not projected into the response. Selected supported fields and qualified omitted-attribute names
are evidence; this does not claim a complete configuration or point-in-time inventory snapshot.

Save requires the original `preview_id`, `preview_hash` and `confirmed:true`. Scope/source/selection/name
overrides are refused. The server repeats selected evidence, checks current authority and creates one draft
with one original `x_product_catalogs_product_catalog_id_products_delete` step per key and no dependencies.
A guarded private save nonce prevents direct campaign creation from bypassing that collection. Concurrent saves
retain one original draft. A local retry, including recovery after losing only the preview-to-plan association,
returns the original plan without new provider reads or another draft. Private signatures/nonces are withheld.

Unsent steps recheck their exact original native definition and selected supported product evidence before
prepare and execute. The existing campaign plan hash, current account/client/login authority, frozen native
before-state, execution acknowledgement, original idempotency key and per-product read-back remain mandatory.
Accepted or uncertain requests preserve their original receipt/key recovery; source checks do not require the
already-deleted product to reappear or permit resubmission. Independent selected products retain separate outcomes.

[X's official catalog reference](https://docs.x.com/x-ads-api/catalog-management/reference), checked
2026-10-04, documents permanent product deletion by generated keys, representative-only grouped-product reads,
additive scheduled imports and early-access restrictions. A feed that still contains the product may restore
it later. Saving or completing a synthetic journey establishes no real account entitlement or provider acceptance.

## English/Arabic controls and qualification

The existing responsive scroll region gains a labelled selection column, explicit preview/save buttons and
focusable named preview headings. Provider text is escaped; native identities/prices retain exact text. A
selection change invalidates its old preview. Pending preview/save responses cannot cross edited forms, changed
destinations, navigation, identity changes or detached views. Saving navigates to the original unapproved campaign
plan. The selected authored notices/refusals are in the validated Arabic catalog; 34 scripts and **3,376 selected
messages** pass website checks. No native confirmation dialog or new CSS/system dependency is introduced.

The missing backend positive-feature baseline was **2/0/2/0, 868.987 ms**; the original website positive-feature
baseline was **1/0/1/0, 562.516 ms**. Eleven backend tests, three actual-controller fixture tests and one real MCP
SDK test pass **15/15/0/0, 16.019 seconds**. They cover typed explicit selection, untouched unselected products,
scope/session/credential changes, expiry, retention bounds, direct-creation refusal, unsent changes, independent
native deletion/read-back, original uncertain-key recovery, concurrent saves and mid-collection revocation/drift.

The real SDK validates published schemas, JSON-serialized text/structured parity, exact source-to-draft
inspection and the original native lifecycle: **eight calls, 17,461 structured response bytes, 45 synthetic GETs,
one synthetic DELETE, one local draft and zero external requests**. The broader related selection passes
**329/329/0/0, 37.730 seconds**, across 45 files, including campaign approval/recovery/views, source comparison,
other bound plan types, ownership, localization and existing native product/catalog/set/feed contracts.

The browser automation entry point was retried on 2026-10-04 and failed before initialization with
“failed to write kernel assets: The system cannot find the path specified. (os error 3)”. Controller tests do not
certify new actual-browser, visual, keyboard or assistive behavior. Local Docker/FFmpeg remain unavailable;
exact Linux/container CI is required before another push. Fresh sanitized and exact committed-source gates follow.

Native totals remain **3,247 actions / 167 families / 800 reviewed writes**, and the original roadmap remains
**13 implemented / 14 partial / one open**. Full inventory/variant reconciliation, absent-source deletion policy,
live WooCommerce, other destination mappings, external-client/assistive/deployed acceptance, provider entitlement
and production load remain separate. Work continues through those qualified roadmap gaps.

## Batch 138 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway gates passed, each exit zero.
Main suite **4,169 total / 4,164 passes / no failures / five expected local FFmpeg skips, 126.640 seconds**;
capture **4/4/0/0, 79.743 ms**. Website: 34 scripts and 3,376 selected Arabic messages; documentation
index: 304 documents. Manifest: 1,714 public source files plus one generated empty sample; source hash
`59eaa9b0450832c147ca2ebd59ed0ac097b2b58d61dff4cd0badf60f9ab566d0`. All three public reports regenerated unchanged after sanitized build and retained
their bytes throughout qualification. The private root sample was not read. These paragraphs follow preflight;
fresh exact committed-source parity and all gates precede the sole Work-here push. No local Docker/FFmpeg, new
browser/assistive, deployed or live-provider result is inferred.

## Batch 138 exact-source push

Code `e35f9d0`; evidence `d9447c3`. Fresh sanitized release matched all 1,714 public files to
exact committed Git blobs with filters disabled, plus one generated empty sample. Source hash
`af5f89d48414a463c0f71634281be4bb126218fdd53b98b46e83a65821649d93`. All five gates passed:
**4,169/4,164/0/5, 108.095 seconds**; capture **4/4/0/0, 76.795 ms**. All three public reports regenerated
unchanged and retained their bytes throughout qualification. Fresh exact Work-here fetch/ancestry and verified
preceding CI192 guards passed before the sole explicit push. [CI193](https://github.com/magdyezy1/CAMCP/actions/runs/37188983845)
is for this exact source; completion is required before another push. No deployed/live-provider result is inferred.

## Verified batch 138 exact-source CI193

[CI193](https://github.com/magdyezy1/CAMCP/actions/runs/37188983845) passed for exact
`d9447c3fa52b124194addabdfcc41927b0563c7c`, source hash
`af5f89d48414a463c0f71634281be4bb126218fdd53b98b46e83a65821649d93`, 1,714 public source files
plus one generated empty sample. Linux host and Docker each passed **4,169/4,169/0/0**, in 657.837/653.982
seconds; capture **4/4/0/0**, 67.012/67.699 ms. Every step passed, including required FFmpeg, early tracked-report
freshness, full checks, Railway/image checks and both synthetic smoke modes. Both suites used two workers.
This verifies batch 138 source; the new release command, deployed and live-provider acceptance require their own evidence.
