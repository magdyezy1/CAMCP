---
status: record
tier: engineering
---

# Snapchat product sets — 2026-09-27

Base revision: `09b5472` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: dynamic product ads name product sets of a catalog, but product sets could not be created,
changed or deleted. Six rows (creation and update on the catalog path with their aliases, update by
ID and deletion) were blocked writes.

Contract source: the Snapchat Marketing API Dynamic Product Ads guide ("Product Catalog" and "Product
Set"), read on 2026-09-27. Key facts:

- `POST /v1/catalogs/{catalog_id}/product_sets` creates sets from `{product_sets: [{name, filter}]}`;
  `PUT` on the same path, or on `/v1/product_sets` as in the guide's example, updates them from
  `{product_sets: [{id, name, filter}]}`; `DELETE /v1/product_sets/{id}` deletes one. Replies list
  each set with its `sub_request_status`.
- Limits: 50 sets per catalog and per batch, 10 filter rules chained by one logical operator, names
  of 3–255 characters, 10 values for list operators (1000 for `ID`), string values of 1–255
  characters. The guide lists the operators each product attribute supports and the enumeration
  values.
- Catalogs belong to an organization (at most 200); each has a read-only `default_product_set_id`
  with every product. Ad squads name sets in `product_properties.product_set_id` and
  `targeting.product_audiences[].product_set`, dynamic creatives in
  `dynamic_render_properties.product_set_id`.
- The guide says nothing about deleting a set that ads use, and its heading for deletion reads PUT
  while its example uses DELETE, as the captured operation does.

## Change

New reviewed family `snapchat_product_sets` (`src/snapchat-product-sets.ts`):

| Part | Behaviour |
|---|---|
| Request | Creation: 1–50 `{name, filter}`; update: 1–50 `{id, name, filter}` on the catalog path or 1–10 by ID alone; deletion: the set in the path only; no query or header overrides |
| Filter | One condition or `AND`/`OR` with 1–10 conditions, no nesting; each attribute takes only its documented operators and values; prices are strings with up to two decimals, currencies ISO 4217 codes |
| Scope | The selected ad account; the review reads its organization and, through markers bound to what it just read, the organization's catalogs, their sets and sets named by ID |
| State | Organization catalogs (up to 200), the sets of the catalogs involved, and for updates and deletions the account's ad squads and creatives (up to 5000 each) |
| Checks | The catalog and sets belong to the organization; names do not repeat in a catalog; default sets are not changed; a catalog keeps at most 50 sets besides its default; unchanged updates are refused; a set that an ad squad or dynamic creative uses is not deleted (`PRODUCT_SET_IN_USE`) |
| Safety | No spending confirmation; deletions count under owner deletion policies; an update of a set that an active ad squad uses is shown as affecting serving |
| Receipt | `request_status: SUCCESS` and SUCCESS with an ID for every set (the same IDs for updates); anything else is a failure never resubmitted |
| Verification | The catalog's sets listed again: each name and filter as sent, or the deleted set gone |

Other code: `src/scope.ts`, `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (Snapchat contract version 13). Guidance: "Snapchat product sets" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect example.

## Tests

`tests/snapchat-product-sets.test.mjs`, three tests:

1. Three sets (price and currency, enumeration and a twelve-ID list) are created after following the catalog cursor, and verify; a replay sends nothing; a set that an active ad squad uses is updated on the catalog path with its usage shown; another is updated by ID; an unused set is deleted and verifies gone; an owner deletion rule refuses deletions but not creations.
2. Sixteen malformed requests (empty list, short or repeated names, unknown attributes, comparisons on text, text operators on enumerations, unknown values, unquoted or three-decimal prices, two-letter currencies, eleven list values or rules, nested logic, incomplete updates, repeated sets, eleven sets by ID) are refused before any request; after reading, an unknown catalog, taken names, an unchanged update, a set of another catalog, default sets, sets used by an ad squad, an audience or a creative, a set of another organization, an unknown set and a full catalog are refused without writes.
3. An error reply is never resubmitted; ignored creations, updates and deletions are not verified; the ledger lists all six writes in the family.

Red/green against a build of `09b5472`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/snapchat-product-sets-20260927/red-check.log`.

## Verification

- Targeted: 189 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,951/1,951.
- Guidance coverage: 319 write-path refusals across 186 modules accounted for.
- Full qualification: see
  [SNAPCHAT-PRODUCT-SETS-VERIFICATION-2026-09-27.json](SNAPCHAT-PRODUCT-SETS-VERIFICATION-2026-09-27.json).

Remaining rows: 756 (six Snapchat rows reviewed; Snapchat blocked writes 79 → 73). Live acceptance
is unverified; it needs the updated deployment and a Snapchat organization with a catalog.
