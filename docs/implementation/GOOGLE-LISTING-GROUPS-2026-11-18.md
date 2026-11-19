---
status: record
tier: engineering
---

# Google listing group trees: product trees in builds and one-service writes — 2026-11-18

Package `r25-m3-trees` of Round 2.5, milestone M3, on branch `claude/v2-r25-m3-trees`, cut at `e008273d`; its first pass and the
lead's fix rounds 2 and 3. It continues [the 2026-09-26 record](GOOGLE-LISTING-GROUPS-2026-09-26.md), whose contract stands except where this
page says it changed. No live provider call was made; all evidence is synthetic. Google's pages read: Create listing groups
(Standard Shopping), Listing Groups for Retail (Performance Max), Mutating overview (temporary IDs), and the pinned v25 Discovery
document (`.mirror/VENDOR/google-ads-v25.json`).

## What changed since the 2026-09-26 record

- **Asset groups per review (G4b).** One review edits the trees of up to ten asset groups (two reads each at prepare and at execute,
  within the five-minute window), still at most 500 operations in all. The state is `[group, tree]` for each group, sorted by ID; the
  impact keeps its keys for one group and adds `groups` for more; the uncertain-write lookup settles a review only when every group has
  the reviewed shape, or every group the shape it had before.
- **`listingSource` (G4a).** Left out, it is `SHOPPING` in the compiled request, which the review shows and the fingerprint covers; any
  other value is still refused.
- **One chain, never split (L2-06, G4c).** Operations that name each other with temporary names, `{assetGroupId}~-N` included, are never
  cut into parts. Over a route's limit (25 for other writes, 500 for a tree review, 1,000 for a build; AMCP's bounds, no raise of
  Google's 25 for independent operations, Q28) the refusal is `TEMP_ID_CHAIN_TOO_LONG`. A tree review over 500 is told to send a smaller
  edit: a build refuses the tree of an asset group or ad group that exists, and a plan cannot cut a tree into steps.
- **Trees in a build (L2-09, G5 route A).** A build creates a retail asset group with its tree, the filters named `-g~-n`, and a
  Standard Shopping ad group with its tree, the criteria named `-ag~-n`. The whole tree is checked without state by the same tree module
  and adapters, and read back with one read per tree. Whether Google accepts a temporary parent inside the name is unverified until a live
  check; one frozen value per form (`temporaryParentForms`, `src/google-temp-names.ts`; a test seam is the only way to change it at run
  time) refuses it and names the two-phase route.
- **Standard Shopping trees (G5 route B).** `src/google-shopping-tree.ts` holds the node adapter and the review of the ad group criteria
  of one `SHOPPING_PRODUCT_ADS` ad group, served by the family `google_listing_groups` as a second request shape (the route is the
  targeting family's in the action ledger, which requires every family to own a route). The shared tree module is `src/google-tree.ts`.
  A request that only removes nodes stays with the targeting family.
- **Details and remedies (L2-07).** Every per-node and per-tree refusal of these modules carries `field`, the `operation` where one is
  at fault, `allowed` where a closed list exists, and a `rule` from one of two closed sets (`treeRules` for the tree itself, `nodeRules`
  for one create, one operation, or a tree inside a build); a refusal about the whole request, or about what the review read of Google,
  has no rule. `INVALID_LISTING_GROUP`, `INVALID_SHOPPING_LISTING_GROUP` and `TEMP_ID_CHAIN_TOO_LONG` have remedies that name the next
  call (`src/google-remedies.ts`).

## Fix round 2 (the lead's review)

- **The tree read leaves removed criteria out (S2-1).** Google may keep a removed criterion as a row with status REMOVED (UNVERIFIED
  until LV-15: the status enum has the value, and that is the only evidence). If it does, a Standard Shopping tree read without a
  filter lists the old root beside the new one after a replacement; in the fixture that models it, the read-back was inconclusive, and
  every later edit of the ad group was refused with two roots. The query says `AND ad_group_criterion.status != 'REMOVED'`. The
  Performance Max filter has no status in the pinned v25 document, so its read needs none.
- **Trees Google refuses are refused at prepare (S3-1).** A dimension, or a level of one, is used once on a path from the root
  (`ancestor_dimension`); a product type or product category level above `LEVEL1` has the level before it on its path (`level_order`);
  the "Other" node of a level is not subdivided by the same hierarchy (`other_refined`); a negative Shopping unit the request creates
  takes no bid (`bid_on_excluded_unit`). Not checked: the depth of a tree (the limit is not given by the pinned document or the pages
  read), and a positive unit without a bid under Manual CPC (it needs `campaign.bidding_strategy_type`).
- **A node's status is read back (S3-3).** The shape of a Standard Shopping node ends with ` status=PAUSED` when it is PAUSED (for any
  status but ENABLED since round 3, N4); an omitted status reads as ENABLED, so no existing shape changed.
- **The duplicate guard (S4-2).** A tree replacement (remove plus create) is not under the M2 duplicate guard: it names existing node
  IDs, so a second copy is refused by them (`STATE_NOT_FOUND` at prepare, `STATE_CHANGED` at execute). A tree of creates only keeps the
  guard. This has been so for Performance Max since M2.
- **Budgets on one basis (S4-1).** J10, the retail Performance Max build with its 24-node tree: build 2 MCP calls and 7 provider
  requests; verify 1 call and 21 reads. J11, the Standard Shopping build with its 5-node tree: build 2 calls and 5 requests; verify
  1 call and 7 reads. Both pinned in `tests/google-build-trees.test.mjs`.

## Fix round 3 (the lead's re-review)

- **The bid refusals name the review's key (N1).** `bid_on_subdivision` and `bid_on_excluded_unit` name `.cpcBidMicros`, the key a
  one-service review's create has; a build still names `cpc_bid_micros`, because it spells every tree field in its own payload's
  snake_case.
- **A node Google lists never refuses (N3).** A bid or a negative flag that Google lists on a subdivision that exists (an inherited
  bid, say) is Google's own state: `bid_on_subdivision` and `negative_subdivision` refuse only what the request creates, as
  `bid_on_excluded_unit` has since round 2.
- **Any status but ENABLED shows (N4, N5).** The shape of a Standard Shopping node ends with ` status=` and its status for every status
  but ENABLED, so a node Google lists as UNKNOWN is not verified as the enabled node that was sent; an omitted status still reads as
  ENABLED, so no existing shape moved. The impact's verification sentence names "a PAUSED status".
- **No plan for a tree (N6).** The message of a tree review over 500 operations no longer offers a plan, which cannot cut a tree into
  steps; its Arabic is replaced in place, so the catalogue stays at 12,206.
- **Types (N8).** `RefusalDetails` (`src/google-tree.ts`) types the details of every helper that throws a refusal of the tree modules,
  so a rule that is in neither closed set does not compile.
- **Wording (N2, N7).** The two hierarchy shapes that the path rule accepts, and the REMOVED rows, are marked unverified (next
  section); the record says "every per-node and per-tree refusal", and what the fixture models is called the fixture's.

## Left unverified, for the live checks

- A temporary ad group or asset group inside a node name (`-ag~-n`, `-g~-n`): the lead's checks A1 and A2.
- The status Google stores for a unit sent PAUSED, and the `cpc_bid_micros` it returns for a unit sent without one (an inherited bid
  would make the shape read-back say changed).
- A replacement on a PAUSED ad group followed by a second edit, against the REMOVED rows Google may keep (S2-1; the live check LV-15).
- Two hierarchy shapes that the path rule accepts, though neither Google's pinned document nor its guides say whether the level before
  must be the immediate parent (N2): type level 1 > brand > type level 2, and the same below the "Other" level 1. Google would refuse
  them at execute, atomically; the lead's validate-only live check settles them.

## Tests

`tests/google-tree.test.ts`, `tests/google-temp-names.test.mjs`, `tests/google-build-trees.test.mjs`,
`tests/google-shopping-tree.test.mjs`, `tests/google-refusal-details.test.mjs`, `tests/google-enable-local.test.mjs`, the new cases of
`tests/google-listing-groups.test.ts` and `tests/google-write-reconciliation-trees.test.mjs`, and the fixtures
`tests/fixtures/google-pmax-retail-tree.mjs` and `tests/fixtures/google-shopping-build.mjs`.
