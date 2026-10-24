---
status: record
tier: engineering
---

# Meta value rule sets — 2026-09-26

Base revision: `40fd508` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: value rules let advertisers bid more or less for audiences, placements and locations they
value differently, and consolidate campaigns. AMCP could read an account's rule sets but could
not create, edit or delete them.

Contract source: Meta Marketing API [Value Rules](https://developers.facebook.com/documentation/ads-commerce/marketing-api/bidding/value-rules)
guide (updated 13 June 2026), read in the rendered documentation on 2026-09-26. AMCP stays on
Graph v25.0. Key facts: up to 10 rules per set and 6 sets per account; increases of 1–1000% and
decreases of 1–90%; up to 4 criteria per rule, with documented types and values; the first
matching rule applies. Updates send the complete set, with IDs for existing rules and criteria.
Deletion posts to `/{id}/delete_rule_set`. DMA location rules stopped applying on 22 June 2026.

## Change

New reviewed family `meta_value_rules` (`src/meta-value-rules.ts`) for
`meta_ad_account_id_value_rule_set_create`, `meta_value_rule_set_id_update` and
`meta_value_rule_set_id_delete_rule_set_create`.

| Part | Behaviour |
|---|---|
| Request | The documented set, rule and criterion fields only. Rule names are distinct; adjustments are whole numbers in range; criteria types differ within a rule; values match their documented lists; value types are paired one to one; ages and location keys are well formed; `LOCATION_DMA` is refused; rule and criterion IDs and `status: ACTIVE` appear only in updates |
| State | The selected account's complete rule set list with rules and criteria, as a stable projection without paging cursors |
| Checks | Create: fewer than six sets and a distinct name. Update and delete: the set is in the account's list; rule and criterion IDs belong to it; a criterion keeps its type; the name stays distinct; an update must change something |
| Ownership | Listing the account's sets records their IDs, so updates and deletion of `/{id}` pass the scope guard only for listed sets |
| Safety | Creating an unattached set needs no confirmation. Updates and deletion change the bids of ad sets that use the set: they need `spend_change_confirmed` and count as serving under owner policy, and deletion counts as a removal |
| Receipt | Create returns a numeric `id`; update and delete return `success: true`; anything else is a failure that is never resubmitted |
| Verification | The list is read again: the created or updated set must match by name, rule order, adjustments and criteria (values compared without case), and a deleted set must be gone |

Other code: `src/scope.ts` (ownership from the account list), `src/write-review.ts`,
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`, `src/preflight.ts`,
`src/spend-policy.ts`, `src/execution-risk.ts`, `src/reviewed-routes.ts`, `src/types.ts`,
`src/action-contracts.ts` and `src/provider-contracts.ts` (Meta contract version 11). Guidance:
"Value rule sets" in `Skills/amcp-campaign-builder/references/meta.md` and an executable inspect
example.

## Tests

`tests/meta-value-rules.test.mjs`, six tests:

1. Creating a set of three rules needs no spending confirmation, writes once, verifies and replays.
2. After listing the account's sets, a complete update keeps rule and criterion IDs, needs confirmation and verifies; the deletion also needs confirmation and verifies.
3. A duplicate name (other case), an unlisted set, a foreign rule ID, a foreign criterion ID, a retyped criterion, a no-op update and a seventh set are refused before any write.
4. Thirteen malformed requests fail with `INVALID_META_VALUE_RULE` without network requests.
5. Owner policies: deletion is refused when deletions are forbidden; an update is refused when activation is forbidden; creation passes.
6. A paged list is refused, an update receipt without `success` stays a failure and is not resubmitted, and a set added after review stops execution with `STATE_CHANGED`.

Red/green: all six fail against a build of `40fd508` (no reviewed family) and pass with this
change. Local log: `.runtime/meta-value-rules-20260926/red-check.log`.

## Verification

- Targeted: 129 related suites (including every Meta suite), 1,564/1,564.
- Guidance coverage: 258 write-path refusals across 138 modules accounted for.
- Full qualification: see
  [META-VALUE-RULES-VERIFICATION-2026-09-26.json](META-VALUE-RULES-VERIFICATION-2026-09-26.json).

Remaining rows: 910 (three Meta rows reviewed; Meta blocked writes 131 → 128). Attaching a set to
an ad set stays part of the ad set contract. Live acceptance is unverified; it needs the updated
deployment and a Meta ad account.
