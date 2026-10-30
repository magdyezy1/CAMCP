---
status: record
tier: engineering
---

# Google Ads rule-based remarketing lists — 2026-09-26

Base revision: `1d971f2` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Google's developer documentation was
reachable again on 2026-09-26 evening. Audience signals and targeting could already reference
existing user lists, but remarketing lists could not be created: `userLists:mutate` was a
blocked write under six action names.

Contract source: Google Ads API v23, read on 2026-09-26:

- [Visitors to your website](https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/website-visitors):
  rule-based lists on the built-in `url__` and `ref_url__` parameters and custom tag
  parameters, with an optional prepopulation request.
- [UserList](https://developers.google.com/google-ads/api/reference/rpc/v23/UserList):
  `membership_life_span` is ignored for rule-based lists; only open lists collect users and can
  be targeted; `read_only` lists (shared or external) cannot be edited.
- [RuleBasedUserListInfo](https://developers.google.com/google-ads/api/reference/rpc/v23/RuleBasedUserListInfo),
  FlexibleRuleUserListInfo, FlexibleRuleOperandInfo, UserListRuleInfo and the rule item
  messages and operator enums: inclusive operands joined by AND or OR, exclusive operands
  subtracted; OR of ANDs is the only rule type flexible lists support; a date rule's `value`
  overrides `offset_in_days`; prepopulation moves from REQUESTED to FINISHED or FAILED.
- [user_list GAQL fields](https://developers.google.com/google-ads/api/fields/v23/user_list):
  the operands are selectable as whole repeated messages. The 32 fields were added to
  `tests/fixtures/google-configuration-fields-v23.json` with the page-text hash.

## Contract

`userLists` is a new route of the reviewed `google_configuration` family, with the list rules in
`src/google-user-lists.ts`.

| Stage | Behaviour |
|---|---|
| Validation | Before any request, wrong JSON types fail the pinned Discovery schema (`INVALID_VENDOR_BODY`) and the rest `INVALID_GOOGLE_USER_LIST`: creation needs a name, `OPEN` status and a flexible rule with an explicit operator, 1-10 inclusive and up to 10 exclusive operands, each with a 1-540 day lookback window and 1-10 groups of 1-10 items. Customer Match, lookalike, logical and basic lists, `membershipLifeSpan`, other rule types, a date rule with both value and offset, and removal are refused |
| Reads | Creation reads the customer; an update reads the list, before review and again before execution |
| Checks | Updates edit only rule-based lists the account can edit (not read-only) |
| Impact | Each list's rules, lookback windows and prepopulation; nothing is targeted until a criterion or signal uses the list |
| Spending | None for creation or renaming; closing a list stops targeting and needs `spend_change_confirmed` |
| Receipt | Existing configuration rule: one resource name per operation in the selected customer |
| Verification | One GAQL read per list; operands, groups and items compared as sets, 64-bit numbers as strings, the `OR_OF_ANDS` default filled and any prepopulation outcome counted as the request |

Not qualified: Customer Match (customer data), lookalike, logical and basic lists, rule
changes after creation, and list removal (a removed list stops the campaigns that target it).

Other code: `src/google-configuration-writes.ts` (the `userLists` descriptor, serving only
for a closing update), `src/review-state.ts`, `src/write-impact.ts`, `src/action-contracts.ts`,
`src/provider-contracts.ts` (Google contract version 17). Guidance: "Rule-based remarketing
lists" in `Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect
example.

## Tests

`tests/google-user-lists.test.mjs`, five tests:

1. The route inspects as reviewed under `google_ads_v23_user_list_mutate_user_lists` and `CREATE_USER_LIST`, with no network.
2. 15 invalid requests, including Customer Match and lookalike lists, `membershipLifeSpan`, removal, a closed list, a missing or too long lookback window, `AND_OF_ORS`, a date rule with value and offset, a quote in a URL rule and a text number, are refused before any request.
3. A list with two OR-joined rules, a number rule, an exclusion and prepopulation is created once and verifies although Google returns strings for 64-bit numbers, fills the rule type, reverses the operands and finishes prepopulation; replay makes no second request.
4. Renaming needs no confirmation and verifies; closing needs spending confirmation; read-only and Customer Match lists are refused.
5. A changed lookback window on read-back is inconclusive; a lost response is never resubmitted.

Changed test: `tests/google-configuration-writes.test.ts` runs every configuration route
through a create, verify, update and removal lifecycle. It gained the `userLists` case and skips
its removal step, which this contract refuses.

Red/green: all five fail against a build of `1d971f2` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/google-rule-user-lists-20260926/red-check.log`.

## Verification

- Targeted: 1348/1348 across 104 related suites, including every Google suite.
- Guidance coverage: 250 write-path refusals across 129 modules accounted for.
- Full qualification: see
  [GOOGLE-RULE-USER-LISTS-VERIFICATION-2026-09-26.json](GOOGLE-RULE-USER-LISTS-VERIFICATION-2026-09-26.json).

Remaining rows: 931 (six action names share the route). Live acceptance is unverified; it needs
the updated deployment and a test customer with the Google tag installed.
