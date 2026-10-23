# Complete bounded WooCommerce inventory inspection

Batch 182 adds a read-only inventory mode to the existing `amcp_workspace catalog_source`
workflow. The sole repository is magdyezy1/CAMCP, branch Work-here. The baseline is
f14305d8b10d956b8d72458152e2a909eba70d50. Hosted Actions remain owner-waived; live account
changes, store setup, automatic grants and delivery tests remain outside authorization.

## Operation and native meaning

Select an already configured WooCommerce store in Commerce, choose its exact source price
field, and submit **Inspect published inventory**. The corresponding MCP input is:

```json
{
  "action": "catalog_source",
  "gateway": "commerce_native_action",
  "account_id": "SELECTED_STORE",
  "connection_id": "SELECTED_LOGIN",
  "requirements": {
    "source_kind": "inventory",
    "price_field": "price",
    "absent_source_policy": "retain"
  }
}
```

The two IDs above are placeholders for current discovery. `price`, `regular_price` and
`sale_price` are independent exact native selections. Inventory cannot be mixed with selected
product or variation selectors. The selected-source/variation workflows remain available.

Each complete scan reads published parent products in ascending native ID order and collects
all variation IDs reported by each variable parent using the native child collection's `any`
status. Two complete scans must agree on the supported material observations, even if native
modification dates do not change. Currency is checked before, between and after collection.
Grouped-product member IDs are preserved as reported, without independently verifying that
membership. Unpublished parent inventory, transactional snapshots and destination eligibility
are not established.

The combined parent/child inventory is limited to 1,000 rows per scan. Each collection uses
100-row pages and at most ten pages. All reads share 64 request attempts, 8 MiB of received
body bytes and a 60-second monotonic deadline. Native totals/pages, exact page lengths, strict
ID order, duplicate/disjoint identities and variable-parent membership must reconcile. A changed,
incomplete, malformed, oversized or unfinished collection refuses without returning partial
inventory as complete. Absent products are retained; absence never proposes deletion.

Only fixed authenticated GET routes on the originally selected public HTTPS store origin are
used. The encrypted key, read scope, login, store binding and API version are rechecked at
response/chunk boundaries. Withdrawn authority cancels the current body and prevents later
reads. Caller URLs, redirects and arbitrary destination reads are excluded.

Native IDs, selected price strings, statuses, SKUs and supported attributes stay exact, including
JSON integer tokens larger than JavaScript's safe numeric range. Empty or missing prices stay
unknown; variation titles require explicit review. Descriptions, downloads, image bodies,
private metadata and credentials do not enter the safe result. No snapshot, draft, review,
product or provider mutation is created.

## Interface and client workflow

The English/Arabic view searches and pages fifty local rows at a time, with named keyboard
scroll regions, table captions, scoped headers, escaped names and LTR native IDs/prices.
The complete safe inventory remains available in its original-evidence disclosure. Search,
Enter, clearing and paging make no new provider read. A local no-match result is not whole-store
absence. Form, selection, request, route and identity changes invalidate late success/failure.
Current errors preserve recovery guidance and the original request reference until an explicit
edit or retry. The selected-source handler also preserves that metadata.

MCP discovery describes the mode and its limits. The actual SDK validates inputs against the
advertised schema, checks text/structured parity and original hierarchy, and supplies an exact
store/login/price website handoff without automatically reading. A revoked continuation refuses.
Thirty-five authored Arabic entries preserve all 8,091 preceding values; the inventory-only
catalog stage contains 8,126 entries.

## Qualification and boundaries

The integrated working-source Commerce smoke passes 40/40 cases: retained selected-product and
variation journeys plus inventory, persistent current failure and obsolete failure, in English
and Arabic at 320/375/768/1280 CSS pixels. A subsequent complete maintained run passes 480/480,
zero failures, on the f143 baseline with explicitly recorded uncommitted source. It is not a
clean-head or live-provider qualification. Earlier failures are retained: a prototype module
path, inspecting hidden disclosure text and lost error metadata. The latter behavior was fixed
without replacing native failures. Focused backend, UI, actual HTTP and MCP regressions cover
the declared boundaries, unsafe IDs, exact prices, material changes, body cancellation and
authority withdrawal. Fresh committed-source full/report/browser gates still precede the push.

The newer worker-health delivery additionally measures two simultaneous actual HTTP MCP
clients with separate tenant credentials and identical native IDs, plus revocation of one
in-flight caller while another succeeds. Those are synthetic client evaluations; external
clients and live WooCommerce eligibility remain unverified. The authorized live discovery has
not supplied an eligible configured WooCommerce store, and no account is changed to create one.
The complete plan remains 13 implemented / 14 partial / one open.

## Primary references

The [official WooCommerce product contract](https://github.com/woocommerce/woocommerce-rest-api-docs/blob/trunk/source/includes/wp-api-v3/_products.md),
[variation contract](https://github.com/woocommerce/woocommerce-rest-api-docs/blob/trunk/source/includes/wp-api-v3/_product-variations.md)
and [WordPress pagination contract](https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/)
were checked for native collection filters, IDs, membership and pagination. These contracts
do not establish a particular store's permissions, snapshot consistency or destination approval.
