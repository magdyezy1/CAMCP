# Readable product review and early destination validation

Batch 150 improves selected commerce tables and the source-to-review contract. It fixes reproduced
F-218 and F-219 while retaining original product values, unchecked selections, explicit provider reads
and separate native write review. No store or advertising product is changed.

## Product tables

Actual isolated Chromium measurements found that the supplied Meta preview and WooCommerce source
table could compress their product row labels below 38 pixels. Fourteen of sixteen selected cases at
320, 375, 768 and 1280 pixels in English/Arabic failed a readable-column threshold. At 375 pixels,
the four-row preview was 1,161.906 pixels tall in English and 1,790.906 in Arabic; the one-row source
table was 502.563 and 681.563 pixels tall. Page containment alone did not reveal this readability issue.

The selected product row headers now reserve 12 rem inside their existing named keyboard-scroll
regions. All sixteen measured cases keep at least 192 pixels for the product column. The four-row
preview is 423.906/632.906 pixels tall and the one-row source table 197.563/227.563 at 375 pixels.
Native names, IDs, decimal prices, currency and selection controls are preserved. The maintained
browser runner checks a minimum readable product-column width independently of the exact CSS value,
alongside existing whole-page containment and actual keyboard table scrolling.

The scope is the selected supplied-product/source tables. CSS table sizing is measured in the tested
engine, not assumed for every engine or assistive technology. The
[W3C responsive table guidance](https://www.w3.org/WAI/tutorials/tables/tips/) supports retaining
table relationships and scrolling within a bounded table region.

## Source and destination agreement

Two of four synthetic baseline contract checks failed. WooCommerce returned exact native SKUs/names
with surrounding whitespace and no mapping blocker, while the existing Meta native review refused
those same values. The local supplied-product preview similarly accepted incompatible required or
optional text and oversized URLs, delaying the refusal until native preparation.

WooCommerce now retains the original whitespace and presents an English/Arabic blocker before
selection. The operator can correct the original product in the store and explicitly read it again.
AMCP does not trim identifiers, rename products, truncate text or silently change the supplier data.
The [official WooCommerce product schema](https://developer.woocommerce.com/docs/apis/rest-api/v3/products/)
defines native SKU/name fields and string prices; the whitespace restriction here is the existing
qualified AMCP Meta destination contract, not a claimed WooCommerce API restriction.

The local Meta import preview and native review share the same product-field validator. Required and
optional text bounds, HTTPS URL bounds and exact types are checked before a proposed plan is offered.
Valid original Arabic text, large literal retailer IDs, optional supplier text and exact decimal-to-minor-unit
conversion remain unchanged. A local preview creates no native review, approval or provider request.
Existing X import validation, native ownership checks, receipts and write-review versions remain unchanged.

Two newly authored Arabic source diagnostics extend the catalog while preserving all 3,763 earlier
key/value pairs. The selected interface checker covers 3,559 messages. The focused eight-suite run
passes **75/75/0/0 in 7.485 seconds**, including rejection, exact-value preservation, source read
bracketing, bilingual unselectable blockers and native product lifecycle regressions.

## Qualification boundaries

All browser and service data are synthetic, stored in disposable encrypted in-memory applications.
External page requests and unqualified provider calls are refused. These measurements establish
local Chromium behavior, not current Linux/Docker execution, another browser, touch/assistive technology,
live credentials, provider entitlement, production deployment or complete store inventory/variants.
The owner requested no further hosted CI; fresh local source, report, FFmpeg, full-check and Railway
compatibility gates remain required. B16/B21/B24 stay partial and the remaining improvement plan continues.

## Batch 150 full local release preflight

Fresh offline install/build/early report freshness/full checks/Railway all passed; main
4,308/4,308/0/0 in 168.879 seconds and capture 4/4/0/0 in 77.489 ms.
Required FFmpeg ran all media cases. Source manifest 1,763 public files plus one generated literal
empty sample, hash 8fa4f3507cdbaafd7ec3594ee7091076fc9204aaaa2b9bdec6251ead9fccbb23. The three sanitized public reports regenerated
unchanged and preserved their bytes; the private root sample was unread. Website checks cover 34
scripts, three pages and 3,559 selected interface messages; documentation index 318.
Actual working-tree rendered QA passes 132/132/0, including 16 readable product-label cases, from
2026-10-04T17:49:56.523Z through 2026-10-04T17:52:18.712Z. Website digest
161c000455d15ad5032231ac0e1e3724e93d4e328379fbb9a78c21e93bb072da; this identifies the served working-tree bytes, not the earlier
Git base as qualification of uncommitted code. Fresh exact clean-HEAD and browser gates follow
before the sole Work-here push. Hosted CI remains owner-paused; remaining plan work continues.
