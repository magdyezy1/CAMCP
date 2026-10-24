---
status: record
tier: engineering
---

# Selected WooCommerce products into reviewed Meta imports

Batch 146 advances B21 with a native, read-only WooCommerce product source. Previously Commerce could map
supplier and WooCommerce CSV exports but could not read a configured store. It now reads an explicitly
selected published product subset and lets eligible products enter the existing Meta preview, comparison
and unapproved draft flow. The About Us page and other plan deliveries remain in place. This batch does
not close the full implementation matrix.

## Contract and connection

`amcp_workspace {action:"catalog_sources"}` lists current qualified connection metadata locally, without
reading credentials or making a store request. Then use:

```json
{
  "action": "catalog_source",
  "gateway": "commerce_native_action",
  "account_id": "store-1",
  "connection_id": "woo-login",
  "requirements": {
    "product_ids": ["101", "102"],
    "price_field": "price"
  }
}
```

Choose 1–50 unique canonical positive decimal product IDs and an explicit `price`, `regular_price` or
`sale_price` field. This selects published products only. There is no caller URL, key, arbitrary route,
query, order/customer read or write input. Both actions work for readers; source reads require no write
grant. The existing generic commerce catalog actions remain unmapped, with their previous classification.

An existing encrypted connection must bind exactly one selected store account, gateway
`commerce_native_action`, an exact public HTTPS origin on port 443, `apiVersion:"wc/v3"` and recorded REST
API key permission `scopes:["read"]` or `scopes:["read_write"]`. Its encrypted credentials contain the
store's `consumerKey` and `consumerSecret`. The deployment administrator may provision this through the
existing `admin provision` command and secret-file procedure; this delivery creates no real connection,
API key, permission grant or provider app configuration. Keys remain outside tracked files, workspace
documents, query strings and page forms. Subdirectory installations, alternate REST prefixes, HTTP,
redirect-based authentication and stores whose proxy strips the Authorization header are refused.

## Native evidence and egress boundaries

Exactly four fixed GETs run in one 30-second deadline: native store currency; selected products; the same
selected products again; native store currency again. Products use `/wp-json/wc/v3/products`, `context=view`,
explicit `include`, `status=publish`, ascending native ID order, page 1 and `per_page=100`. `_fields` selects
only the supported product fields and chosen price. Currency uses the exact
`/wp-json/wc/v3/settings/general/woocommerce_currency` option with `_fields=id,value`.

The dedicated HTTPS helper sends Basic credentials in the Authorization header on a fresh socket. Its
lookup resolves every address and connects to checked public addresses, refusing private/reserved IPs
and mixed public/private resolution. Redirects are never followed. The ordinary NativeTransport origin
allowlist stays intact, and its sandbox selection also refuses this unqualified custom-store route.
Only selected response headers are retained; response/error bodies never become refusal diagnostics.

Current actor, connection, sole account binding, API version, origin, original recorded permissions,
credential identity and credential expiry are checked before/after requests and body chunks. Missing,
foreign, duplicate or private product IDs; malformed counts; multiple native pages; changed supported
projections or currency; invalid UTF-8/JSON; transfer-length mismatch; unknown authentication responses;
body overflow and authority withdrawal refuse the entire response. Four attempts, 4 MiB of aggregate
body bytes and 100 collected product rows are AMCP operation bounds. No retries or snapshots are saved.
Source-aware JSON parsing preserves native integer IDs beyond JavaScript's safe range as exact strings.

The output retains SKU, name, exact selected price string, product type/status/parent, native stock/tax
settings, virtual/downloadable flags, first image ID/URL, product permalink and native modified text.
Unselected metadata, descriptions, downloadable file links, customers, orders and credentials are omitted.
Repeated equality applies to this supported projection, not every unselected field. Optional/unknown
fields stay null. The selected first image is never fetched by this read.

## Workflow, layout and honest limits

Commerce shows a separate bilingual source form and a focusable, named scrolling table. IDs, SKUs,
native statuses, prices and URLs keep their exact LTR content; names and labels are escaped. Product
type/grouping, digital/unknown delivery, missing stable SKU/name/image, duplicate selected SKUs and
unsupported Meta price precision/range are explicit row blockers. No product ID is invented from a
WooCommerce ID, no rounding occurs and no HTML description is converted into plain text.

Eligible products start unchecked. **Use selected products for Meta preview** maps the displayed SKU,
name, original price/currency and first image; a valid native product URL is optional. `instock` maps to
`in stock`, `outofstock` to `out of stock`; backorders and unknown stock omit optional availability.
Condition, brand and description are not inferred. X continues to require its ten explicit CSV fields.
The user chooses the destination account/catalog and explicit upsert policy, then validates, compares
current destination items if desired and saves an unapproved draft. Saving publishes nothing; each
destination product still requires its own native review, execution confirmation, receipt and read-back.
The supplied product subset has its own source hash; this is not an attestation that WooCommerce was
re-read when that draft was saved. Products outside the subset are retained.

Source form changes and checkbox changes clear staged imports. Request, route, identity and attached-view
guards withhold stale source, preview and save results. Qualified MCP links preserve the original current
store, IDs and chosen price field, and the website waits for an explicit source read. Ordinary CSV/X flows
remain available. Source connection metadata is exposed only for the current authenticated workspace and
is cleared from browser state on identity reset.

Tax treatment/calculation, scheduled sale activation, hidden/full inventory, grouped/variant mapping,
automatic store synchronization, absent-source deletions, additional destinations, actual WooCommerce
acceptance and destination eligibility remain separate unfinished qualification. A successful source
read does not authorize a destination write or establish a point-in-time inventory snapshot.

## Primary contracts consulted

- [WooCommerce HTTPS authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication/):
  API keys follow their selected WordPress user's roles and have Read/Write permission choices; HTTPS
  supports Consumer Key/Consumer Secret Basic authentication. AMCP does not use query-string credentials.
- [WooCommerce v3 products](https://developer.woocommerce.com/docs/apis/rest-api/v3/products/):
  product IDs, SKU, native price strings, parent/type/status, stock/tax/delivery, images and selection
  parameters. This source reader implements fixed GETs only.
- [WooCommerce setting options](https://developer.woocommerce.com/docs/apis/rest-api/v3/setting-options/):
  the exact general `woocommerce_currency` option and its current `value`.
- [WordPress pagination](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/):
  `page`, capped `per_page`, `X-WP-Total` and `X-WP-TotalPages`.
- [WordPress global parameters](https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/):
  `_fields` and supported nested-field selection.

These current official sources were inspected on 2026-10-04. The earlier oversized legacy WooCommerce
reference and unavailable GitHub directory were not used as qualified contract evidence.

## Synthetic verification

The baseline refused the new source action with `INVALID_ARGUMENT` (1/0/1/0, 819.074 ms). After the reader
was added, the same test passed (1/1/0/0, 557.897 ms). New backend/helper, authenticated viewer/session,
bilingual controller and real SDK tests cover the source boundaries and original Meta draft path.
Combined commerce, source, precision, removal and connection regression passes **100/100/0/0, 16.976 seconds**.
The related workspace/service/transport/website/metadata/locale suite passes
**3,256/3,251/0/5, 101.285 seconds**; five local FFmpeg tests remain expected skips. The latter ran before
the final dedicated sandbox getter/refusal was moved; the final sanitized full suite qualifies that source.

The real MCP SDK transcript uses **seven tool calls, 8,318 structured response bytes, four synthetic native
reads, one local unapproved draft and zero external requests/provider mutations**. It checks input schemas,
structured/text parity, original source handoff, exact supplied price, unchanged native draft arguments
and revoked client access. Website checks cover all 34 browser scripts and three pages, with **3,500**
selected Arabic messages. All 3,657 previous Arabic catalog values are preserved; 48 new entries bring
the catalog to 3,705. These controller tests are VM fixtures, not a rendered browser or assistive-technology
acceptance test. Browser automation remains unavailable in this session. Full report freshness, sanitized
preflight, committed source and new CI evidence are recorded separately after their actual results.

## Previous exact release CI200

Decoded [CI200](https://github.com/magdyezy1/CAMCP/actions/runs/37207099517), job `111450455240`, qualifies
exact revision `dcaedc3c27d78e9285ba2719e231baf29606b304` and source hash
`2c0534fa0a1c3c2bd77ad6bbd2e8a238c1f1d9cea6ee578d52607f8b1da9ba3b`: 1,738 public Git blobs,
one generated literal empty sample and all three tracked reports. All twenty job steps completed
successfully, including source proof before installation, early report freshness, Linux FFmpeg/full
checks, Railway checks, Docker image build/identification, both synthetic container smoke modes and
artifact upload. Linux main **4,255/4,255/0/0, 737.250 seconds**; capture **4/4/0/0, 74.134 ms**.
Docker main **4,255/4,255/0/0, 744.891 seconds**; capture **4/4/0/0, 74.175 ms**. This verifies the previous
revision's CI pipeline, not this later source, deployed service, actual browser or live provider acceptance.

## Batch 146 sanitized release preflight

Fresh offline install/build/early tracked-report freshness/full check/Railway all passed with every exit zero.
Main **4,273/4,268/0/5, 131.427 seconds**; capture **4/4/0/0, 95.699 ms**. Five local skips require FFmpeg;
Linux/Docker qualification remains source-specific. Website: 34 scripts, three pages, 3,500 selected Arabic
messages; documentation index 312. Manifest: 1,745 public source files plus one generated literal empty
sample; preflight source hash `9dbff02d88b95021599091e0e268fb931c61fb6dc37625111dd9a77b37ab19a7`. All three public reports regenerated
unchanged after the final sanitized build and preserved their bytes through qualification. The private
root sample was not read. This record follows that candidate, so the final committed source requires
fresh maintained Git blob/manifest/report/sample proof and full gates before the sole Work-here push.
No deployed/browser/live acceptance is implied. The full plan continues.

## Exact batch 146 local source and CI scheduling status

The final committed revision 29335ed8b38362c5196e59ddf3f5732ea843d7a0 passed fresh local install/build/
early report freshness/full check/Railway and maintained exact Git blob proof: 1,745 public sources, one
literal empty sample, three tracked reports and source hash
`682eea678ff3f299e43cfd9e377b2bd352799c85008e0635c6ba7ebd52198e49`. Main 4,273/4,268/0/5
(127.712 seconds), capture 4/4/0/0 (80.668 ms), with preserved report bytes. CI201
(run 37210299617) failed twice before runner assignment or any executed build step. The owner confirmed
exhausted Actions minutes and directed continuing without CI. No later Linux/Docker/deployed/provider
acceptance is implied. Batch 147 adds verified ignored local FFmpeg tools so all five skipped media
cases execute locally; that later Windows evidence does not alter this historical suite record.
