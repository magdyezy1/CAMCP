---
status: record
tier: engineering
---

# Google Ads conversion value rules — 2026-09-26

Base revision: `f289b11` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes" in the
[2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Value rules let value-based bidding weight
conversions by audience, device or location; `conversionValueRules:mutate` and
`conversionValueRuleSets:mutate` were blocked writes.

Contract source: Google Ads API v23, read on 2026-09-26:

- [Conversion value rules](https://developers.google.com/google-ads/api/docs/conversions/conversion-value-rules):
  at most two conditions per rule; ADD above 0, MULTIPLY 0.5-10, SET only for allowlisted or
  store-visit sets; itinerary conditions allowlist-only; a rule belongs to one active set; a set
  has one or two dimensions (NO_CONDITION only alone with store categories), is attached to the
  customer or a campaign, and applies the first matching rule in list order; categories are
  immutable; removing a rule that an active set uses fails.
- [ConversionValueRule](https://developers.google.com/google-ads/api/reference/rpc/v23/ConversionValueRule),
  [ConversionValueRuleSet](https://developers.google.com/google-ads/api/reference/rpc/v23/ConversionValueRuleSet)
  and the value rule enums.
- The [conversion_value_rule](https://developers.google.com/google-ads/api/fields/v23/conversion_value_rule)
  and [conversion_value_rule_set](https://developers.google.com/google-ads/api/fields/v23/conversion_value_rule_set)
  GAQL fields, added to `tests/fixtures/google-configuration-fields-v23.json` with page-text
  hashes.

## Contract

`conversionValueRules` and `conversionValueRuleSets` are new routes of the reviewed
`google_configuration` family, with the rules in `src/google-value-rules.ts`.

| Stage | Behaviour |
|---|---|
| Validation | Before any request, wrong JSON types fail the pinned Discovery schema (`INVALID_VENDOR_BODY`) and the rest `INVALID_GOOGLE_VALUE_RULE`: ADD or MULTIPLY in range, at most two of audience (selected-customer lists and interests), device and location conditions, ENABLED or PAUSED; sets with ordered rules of the selected customer, one or two of AUDIENCE, DEVICE, GEO_LOCATION, and a customer or campaign attachment. SET, itineraries, store categories and NO_CONDITION are refused; a dimension update restates its rules |
| Reads | The targets of updates and removals; for sets, every included rule and an attached campaign. Before review and again before execution |
| Checks | Each included rule exists, is not removed and uses only conditions of the set's dimensions; an attached campaign is enabled or paused |
| Impact | Actions and conditions, or the rules in order, dimensions and attachment |
| Spending | Creating a rule changes nothing until a set includes it; editing or removing a rule and every set change need `spend_change_confirmed` |
| Receipt | Existing configuration rule: one resource name per operation in the selected customer |
| Verification | One GAQL read per target; rule conditions compared as sets, a set's rule and dimension order as sent |

Other code: `src/google-configuration-writes.ts` (both descriptors, the rule read for sets and
the dimension check), `src/review-state.ts`, `src/write-impact.ts`, `src/action-contracts.ts`,
`src/provider-contracts.ts` (Google contract version 18). Guidance: "Conversion value rules" in
`Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect example.

## Tests

`tests/google-value-rules.test.mjs`, five tests:

1. Both routes inspect as reviewed with no network.
2. 9 invalid rules (SET, zero ADD, MULTIPLY outside 0.5-10, three conditions, an itinerary, another customer's audience, a location without match type, REMOVED status) and 4 invalid sets (store categories, NO_CONDITION, three dimensions, a campaign set without campaign) are refused before any request; a dimension update without its rules is refused by the configuration check.
3. A new rule needs no confirmation and verifies although Google reorders its devices; editing a rule needs spending confirmation and verifies.
4. A campaign rule set reads its rules and campaign, keeps the rule order in its impact, needs spending confirmation and verifies; an audience rule in a device set, a removed rule and an update adding a location rule to a device set are refused; a missing rule is refused.
5. A set read back in another rule order is inconclusive; removing a set needs spending confirmation; a lost response is never resubmitted.

Changed test: `tests/google-configuration-writes.test.ts` gained the two routes in its lifecycle
table (create, verify, update, verify, remove, verify) and a seeded rule for the set case.

Red/green: all five fail against a build of `f289b11` (`WRITE_CONTRACT_UNAVAILABLE`) and pass
with this change. Local log: `.runtime/google-value-rules-20260926/red-check.log`.

## Verification

- Targeted: 1358/1358 across 106 related suites, including every Google suite.
- Guidance coverage: 252 write-path refusals across 131 modules accounted for.
- Full qualification: see
  [GOOGLE-VALUE-RULES-VERIFICATION-2026-09-26.json](GOOGLE-VALUE-RULES-VERIFICATION-2026-09-26.json).

Remaining rows: 929 (one action name per route). Live acceptance is unverified; it needs the
updated deployment and a test customer with value-based bidding.
