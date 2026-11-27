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
- **Spend, by the current rules, unchanged:** every part asks `spend_change_confirmed`, a serving ad group is an activation, a removal a
  deletion, a Standard Shopping bid meets the bid cap. A cap that every unit breaches is counted and its first five rows shown.
- **A3.** A build refuses a remove or an update as before and names the one-service action that takes it (`details.kind`, `details.route`).
  `validateOnly` is refused as before in both families, the build and every other Google review, with one sentence that names `provider_check`
  (`details.instead`), which prepare runs by default.
- **Speed (shared code).** `googleJson` converted the 700 KB body of a 3,000-operation tree again at every check; it now caches the key
  conversion, and the tree modules convert a plan's body once (`googleBody`). A prepare of 3,050 operations fell from 2.7 s to 1.4 s, an execute
  from 2.9 s to 0.8 s on the synthetic Google.

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
