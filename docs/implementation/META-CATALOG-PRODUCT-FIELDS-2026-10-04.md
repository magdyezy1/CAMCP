# Meta catalog product field verification — 2026-10-04

The reviewed single-product create/upsert contract already accepted optional catalog fields, but its
read projection compared only eleven scalar fields and the two native price-filter results. A synthetic
provider could discard `retailer_product_group_id`, `custom_label_0` or `sale_price_start_date` and still
receive a `verified` result. F-209 records these three reproduced false positives; no live incident is inferred.

The current reader explicitly requests all 35 observable accepted fields plus the exact product ID.
Every submitted observable field must match its fresh original-catalog, retailer and accepted-receipt read.
`allow_upsert` is execution intent, not stored product state. Price and optional sale price retain the existing
receipt-bound `price_amount`/`sale_price_amount` filters; formatted native price strings are display evidence.
No additional payload fields, endpoint, provider write or account permission is introduced.

| Field class | Native observation and comparison |
| --- | --- |
| Text, enum and HTTPS fields | Bounded native strings; exact submitted value; omitted fields remain null |
| Additional image URLs | At most 20 HTTPS URLs without embedded credentials; original ordered array |
| Inventory | Exact nonnegative safe integer; strings, fractions and unsafe integers are refused |
| Sale start/end dates | Native string and exact submitted literal; no guessed time-zone or representation normalization |
| Price / sale price | Exact original-product numeric filter evidence; never parsed from formatted display text |
| Unknown legacy frozen fields | Verification is refused; accepted outcome/key is retained and never resubmitted |

Native normalization of an image URL, image order or date text can leave verification inconclusive/mismatched.
This conservative result requires read-only inspection; it does not authorize retrying the write. Inventory
can change after a write and is not a promise of ongoing stock. Product-group strings do not establish complete
variant inventory, valid commerce eligibility, serving, tax, sale activation or full store synchronization.

## Primary contract evidence

Meta reference pages returned HTTP 429 on 2026-10-04, so they were not used as new evidence. The independently
fetched, certificate-validated versioned public SDK supplies the selected read types and fixed catalog edges:

- [ProductItem, SDK 26.0.2](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/productitem.py),
  53,863 bytes, SHA-256 `05dd94ae995f2003f15bb3436effb4871ca6bb2c9eb5f669f173a6d005de6625`.
- [ProductCatalog, SDK 26.0.2](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/productcatalog.py),
  95,033 bytes, SHA-256 `6bed556f4ffee852db5f1888330a47ede9af3bc60f42e5265e0de208f07672fd`.

The offline extractor `tools/meta-catalog-product-fields.mjs` pins the selected schema/edge projection in
`tests/fixtures/meta-catalog-product-fields-sdk-v26.json`. It checks all accepted observable fields against
both read and write models and supports `--check`; it does not use network access or credentials. The fixture
is schema evidence, not provider acceptance or an assertion about undocumented normalization.

## Upgrade and qualification

`meta-catalog-product-fields-v2` retires cached partial proof. Standalone verification reuses the accepted
receipt and mutation key for a current read. Pending plans inspect the current verification version before
using a verified predecessor to prepare/execute/approve/run another step. A failed current proof blocks the
dependent continuation; it does not reset keys or replay the mutation. Current complete proofs retain their
existing cache lifetime and authority checks. Completed historical runs are preserved.

The three before-state regressions were 3/0/3/0 (955.591 ms). After implementation the same provider-discard
cases are 3/3/0/0 (5.805 seconds), each retaining exactly one synthetic accepted mutation and reporting
inconclusive evidence. The qualified catalog/cache/Google-value/X-identity regression is 72/72/0/0
(20.744 seconds). The real MCP SDK journey uses five calls, 21,805 structured response bytes, eleven synthetic
reads, one synthetic mutation, original receipt replay and revoked-access refusal; zero external provider
requests. Twenty-two authored catalog diagnostics have Arabic translations; native IDs, fields and values
remain exact. Full sanitized release evidence is recorded in the linked delivery record.

[Delivery and scope](../review/DELIVERY-2026-10-04-META-CATALOG-FIELD-PROOF.md).
