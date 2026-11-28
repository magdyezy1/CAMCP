---
status: record
tier: engineering
---

# Google product trees built from a source: copy, match a list — 2026-11-27

Package `r25-fr-listings` of Round 2.5, from the owner's friction report items A2 and A3 (White Friday 2026), on branch
`claude/v2-r25-fr-listings`, cut at `51915c44`. It continues [the 2026-11-18 record](GOOGLE-LISTING-GROUPS-2026-11-18.md), whose contract stands.
No live provider call was made; all evidence is synthetic.

## What the owner asked

"No copy, file upload or 'match this list'. Every entry must be typed into the call, and Shopping takes one ad group per review" (A2); "the
combined Google mutate only creates ... `validateOnly` was refused on the listing-group review" (A3).

## What changed

- **Two actions, hidden like the Data Manager's.** `AMCP_COPY_LISTING_GROUPS` makes the trees of up to 40 targets (ad groups, or asset groups)
  the tree of a source; `AMCP_MATCH_LISTING_GROUPS` makes each include exactly the item ids of a list and exclude the rest. Both are called with
  `amcp_write prepare` (`src/google-listing-group-routes.ts` declares them, `src/google-listing-group-build.ts` builds them; the service calls
  the build before the group split). LIST_ACTIONS, `tools/list` and the refusal of an unknown action are as pinned (`raw.hidden`).
- **A tree is one mutate; the set of trees goes in parts.** Each target that has something to change is one ordinary tree review of the family
  `google_listing_groups`, prepared as one write group (`WriteGroups.prepare`, parts given instead of sliced): one approval, parts in order,
  stop at the first that fails, resume by preparing again. What a target lacks is found by comparing nodes by their path of dimension values
  and their kind, never by ID, so a repeat is `no_change`, and a stopped group leaves only the missing trees.
- **10,000 operations for a built tree (Q28, owner 2026-11-27: "Yes, 10,000 for built trees").** `chainLimits.treeBuild`. A request passes the
  500 of a hand-sent review only with the mark the service puts on its plan (`CompiledRequest.treeBuild`: its operation count and their SHA-256),
  which the tree modules check again at execute; a caller cannot send it.
- **The answer is a digest.** A built part answers with `tree_change` (counts, five sample lines each way, SHA-256 of the tree and of its
  operations); the group with `build` (the source, or the list with its rows, repeats and two hashes; totals; a summary). The audit rows, the
  receipt and the impact of a built part hold counts and hashes, not the 3,000 operations.
- **A build is a write, with a review's authority.** The trees are read through the review's own access (`WriteReviewService.treeReader`): the
  login's grant to write the account, its adwords scope (checked before the first read), the read-only check of every read. A login that may
  only read the account, lacks the scope or is off is refused with nothing read.
- **The execute is offered.** The prepare of a built group carries `next_call` (`amcp_write execute` with the review ID and key; the
  acknowledgements are `add_after_user_approval`, never pre-filled), as a single review's prepare does. A group split from a long list keeps
  its answer as it was.
- **Spend, by the current rules, unchanged:** every part asks `spend_change_confirmed`, a serving ad group is an activation, a removal a
  deletion, a Standard Shopping bid meets the bid cap. A cap that every unit breaches is counted and its first five rows shown.
- **A3.** A build refuses a remove or an update as before and names the one-service action that takes it (`details.kind`, `details.route`).
  `validateOnly` is refused as before in both families, the build and every other Google review, with one sentence that names `provider_check`
  (`details.instead`), which prepare runs by default.
- **Speed (shared code).** `googleJson` converted the 700 KB body of a 3,000-operation tree again at every check; it now caches the key
  conversion, and the tree modules convert a plan's body once (`googleBody`). A prepare of 3,050 operations fell from 2.7 s to 1.4 s, an execute
  from 2.9 s to 0.8 s on the synthetic Google.

## The Opus review of 2026-11-28 (accept with fixes)

Each fix was red first with the reviewer's probe (`tests/google-listing-group-build.test.mjs`, `tests/write-approval.test.mjs`).

- **S2-1, a CSV with no item id header read a title as an id.** With no header `item_id`, `id`, `offer_id` or `sku` (also with a space, or
  without one), a CSV whose rows have more than one cell, a `;`, or a first line that is a title with a space in it (`Handle,Variant SKU`,
  `item_id;title`, `Product ID`) is refused, naming the accepted headers; `build.list.header` and `build.list.column` (1 is the first) say what
  was read. One id a line and nothing else still needs no header. An id of `*`, the name of the "Other" node, is refused (S4).
- **S3-1.** The ids are not checked against Merchant Center: said in the action description, the guide and the summary, and as
  `build.merchant_center_checked: false`.
- **S3-2, S3-5.** A unit's bid is part of what it is, so a new bid removes and makes the unit again. `tree_change.bid_changes` and the summary
  say how many units change and from which bids to which ("2 units' bids change from 300000 and 900000 to 600000"). The tests kill the mutants
  that leave the bid out of the comparison and that remove parents first.
- **S3-3.** The website approval of a built group shows `build` (and its summary, and the operations of every part) instead of the first
  part's request; the approval page prints the digest sentence.
- **S3-4.** A build action called as a native action (`google_ads_native_action`) is `WRITE_REVIEW_REQUIRED` naming `amcp_write prepare`; it
  was an INTERNAL_ERROR from the family that reads a request's operations.
- **S4.** The refusal of an edit in a build speaks of a product tree only for a listing group (an asset group filter), never for an ad group
  criterion, which may be a keyword.
- **Left as the review said:** the bid churn under bidding strategies other than Manual CPC, and the audit rows of a built group.

## Not built, and why

- A list file uploaded to AMCP (`source_id` through MediaSources): release 2. The list is `item_ids` or `csv` text in the call.
- Edits inside a build: L2-10 (the atomic edit build), part of M5, which the owner put on hold on 2026-11-23.
- Cutting one tree into valid prefixes: ten targets of 3,050 operations would be 70 parts (a group holds 40), and a half-built tree.

## UNVERIFIED: the live check for the test account

Google accepts, and how long it takes, one request of 3,050 operations: the default validate-only at prepare and the mutate at execute.
Where a prepare is too slow, `provider_check: false` skips the validate-only of each part. Item ids compared without case (the tree compares
them lowercase); an excluded "Other" on `productItemId` (Standard Shopping `negative: true`, Performance Max `UNIT_EXCLUDED`). The pinned v25
document states no operation limit; the guide's 10,000 is Google's.

## Tests

`tests/google-listing-group-build.test.mjs`: 3,047 ids onto an "All products" root; the same list against a 3,000-id tree (67 operations); a
3,047-unit tree copied to 10 ad groups; a group stopped at its fourth part and resumed; an uncertain part that fails closed and is superseded;
the duplicate warning; the mixed remove and add; the refusals of the gates; the Performance Max twin.

Journey J25 (`tests/journeys`): the owner's list of 3,047 item ids on a Standard Shopping ad group, four branches. The success branch is two
MCP calls (the prepare and the execute it offers), 15,579 response bytes, one mutate of 3,050 operations; the baseline records it.
