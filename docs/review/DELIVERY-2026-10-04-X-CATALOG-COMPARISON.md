# Batch 136 — exact X source reconciliation and native variant guards

Baseline `af5f23f`. Sole checkout `CAMCP-Codes-final-branch`, repository `magdyezy1/CAMCP`, branch `Work-here`.
This advances B01/B05/B15/B21/B24 through the existing read-only catalog comparison action and corrects F-206
in the existing X product review. No native action, reviewed family, scope or entitlement is added.
All qualification uses declared in-memory transports, records and synthetic credentials; no external provider,
store or advertising mutation occurs.

## Read the source differences before saving a native plan

After local validation, Commerce offers Compare current catalog products for Meta and X. X retains the exact
selected account/login/catalog and 1–50 supplied source products, with explicit upsert. It reads the selected
account's FULL promotable users and their catalogs through the already qualified internal read routes, verifies
the selected catalog, scans up to 1,000 listed products twice, and repeats catalog ownership. Every page/retry
rechecks current actor/account/login authority. The collection is bounded to 180 attempted requests including
retries, 5,000 collected rows, 4 MiB and 60 seconds. Partial paging, changed selected evidence or ownership,
repeated IDs/keys, numeric identities and failed or malformed responses cannot become a comparison.

Scans are shared across supplied SKUs. Fifty selected rows from 1,000 synthetic products require 26 GETs,
including both ownership observations, rather than repeating the inventory per SKU. A 1,001-product catalog
stops after ten product pages and returns CATALOG_SCAN_LIMIT. This is a declared request-count result; it does
not measure live latency, production capacity or rate-limit acceptance. The original Meta adapter and its
native price-filter proof, 150-row/2-MiB bounds and create-only policy are unchanged.

The response returns only supplied source IDs and their bounded original native fields. It identifies new,
changed, matching, unknown and blocked rows with exact generated product keys. Supported native prices compare
by the existing exact decimal parser, so adjacent millionths remain different and equivalent zero-padding
normalizes without Number conversion. Missing or unsupported prices stay unknown; links with credentials are
not echoed. Unrelated products, arbitrary native fields, original request/page bodies and credentials are not
returned. Native attributes outside the supplied update are listed by qualified field name only, with explicit
uncertainty about whether X preserves omitted values.

Grouped products are blocked. An absent source ID stays unknown/blocked if any listed group or unrecognized
group status could hide a variant. Missing group metadata is not interpreted as proof of an individual product.
Current catalog/product reads are sequential observations, not an atomic or complete variant inventory. Live
early-access entitlement, actual account acceptance and deleted/hidden inventory remain unverified.

Primary [X catalog reference](https://docs.x.com/x-ads-api/catalog-management/reference), checked 2026-10-04,
documents cursor-based product reads capped at 100 per page and says grouped retrieval returns the first
submitted variant. Its response example includes separate item_group_id, item_group_key, product_key and SKU id.
These semantics require preserving group uncertainty; the adapter does not infer hidden variant identity.

## English/Arabic comparison, source-preserving subset and native review

The same comparison action renders exact current/proposed prices, original source names/IDs, field differences,
unknown values and group blockers in English and Arabic. Source labels and native values are escaped, IDs retain
direction and tables retain headers/captions and a focusable scroll region. X explains exact decimal comparison;
Meta retains its native numeric-filter explanation. Ten selected authored interface/explanation/refusal entries
bring the active Arabic catalog to 3,340 messages. Arbitrary native/source diagnostics remain unchanged.

Save only products needing review excludes matching/blocked rows, preserves the original source product objects
and saves one unapproved local draft with one native step per eligible SKU. Save all supplied products remains
available, but native review applies the same variant guards independently. Neither comparison nor draft save
submits a product write or grants write authority. Pending reads and saves cannot cross an edited form,
destination, route, identity or detached view. The client validates scope, source hash, native identities,
exact decimal states, known differences, unknown fields, blockers, summary and eligible selection before offering
the subset action. Native ownership/current before-state, explicit approval, original keys/receipts and fresh
independent read-back remain mandatory for every executed product.

## F-206: review could overlook hidden or key-only variants

Three original synthetic native lifecycle regressions failed: **3 total / 0 passes / 3 failures, 657.283 ms**.
Native prepare treated an unreturned SKU as new even when a listed group could hide it. It also allowed an update
when only item_group_key identified the group, and an unsent reviewed request could cross a subsequent key-only
group change. This is reproduced source/lifecycle evidence, not a claim about a live incident.

A shared pure classifier now distinguishes individual/grouped/unknown native group evidence. The original native
product reader retains both original group fields and the derived status in before-state. Unreturned products
retain an explicit grouped/unknown-list flag. Upsert prerequisites withhold unknown absence or a grouped/unknown
existing product; known individual updates remain available even when other listed products are grouped.
Post-review group-key changes invalidate the unsent before-state before a PUT. Delete contracts, native JSON,
price comparison, accepted original receipts and current-authority recovery are unchanged. Legacy unsent views
without the newly required group evidence naturally require a fresh review; no stored native request is rewritten.

## Qualification and continuing scope

Sixteen new checks comprise eight comparison backend checks, four actual-controller fixture checks, one real
MCP SDK journey and three native variant guard checks. The original comparison feature baseline was
**8/4/4/0, 838.053 ms**; its four positive-feature cases failed, while negative cases were already refused because
the adapter did not exist. The UI feature baseline was **4/1/3/0, 612.956 ms**. Negative cases subsequently
exercise the implemented reads and validate the specific malformed, changed or revoked evidence paths.

The final focused suite passes **107/107/0/0, 7.333 seconds**, including existing Meta comparison/localization,
X imports, products, catalogs, sets, exact-price/cache recovery and SDK regressions. The small direct related
selection before the final native guard addition passed **66/66/0/0, 4.693 seconds**; fresh full gates below
qualify the final source. The real SDK validates published schemas, JSON-serialized text/structured parity,
exact comparison-to-draft-to-original-plan inspection and revoked client refusal: **five calls, 12,297 structured
response bytes, eight synthetic GETs, no provider mutations, one local draft and zero external requests** in
the final focused run. The earlier related run measured 12,296 bytes; timing/response metadata can vary in size.

The new UI has deterministic controller qualification, not new actual-browser/assistive certification. Local
Docker/FFmpeg remain unavailable; exact Linux/container CI is required before a subsequent push. Live store
connection, other destination mappings, complete inventory reconciliation/deletion, customer entitlement,
deployed acceptance, production load and external multi-client/assistive evaluations remain separate. Ledger
totals remain **3,247 actions / 167 families / 800 reviewed writes**, with **13 implemented / 14 partial / one
open** roadmap packages. Work continues through the original roadmap.

## Batch 136 exact-source push

Code `35a9afb`; evidence `d32321a`. Fresh sanitized release matched all 1,705 public source files to
exact committed Git blobs with filters disabled, plus one generated empty sample. Source hash
`bc2bbad057dc554f6a3d471532cb0416675e3ae53b3542e40d12a679e33c3bce`. All five gates passed:
**4,145/4,140/0/5, 95.595 seconds**; capture **4/4/0/0, 67.531 ms**. All three tracked public reports
regenerated unchanged and retained their bytes throughout qualification. Fresh exact Work-here fetch/ancestry
and verified preceding CI190 guards passed before the sole explicit push. [CI191](https://github.com/magdyezy1/CAMCP/actions/runs/37184989626)
is for this exact source; completion is required before the next push. No deployed/live-provider result is inferred.
