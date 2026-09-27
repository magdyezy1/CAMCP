# Google Ads user list customer types — 2026-09-27

Base revision: `220e746` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: campaigns with a customer acquisition goal tell new customers from existing ones through
the advertiser's lists, marked with customer types such as purchasers or qualified leads.
AMCP can create rule-based lists, but `UserListCustomerTypeService.MutateUserListCustomerTypes`
was a blocked write (one row), so the lists could not be marked.

Contract source: the pinned Google Ads API v23 Discovery document (`MutateUserListCustomerTypes`,
`UserListCustomerTypeOperation`, `UserListCustomerType` with its category enum, and the
`UserListCustomerTypeError` values and their descriptions), and the `user_list_customer_type`
GAQL resource, read on 2026-09-27. Key facts:

- Operations attach (`create` with `userList` and `customerTypeCategory`) or remove (by the
  resource name `customers/{customer}/userListCustomerTypes/{user list ID}~{category}`); there is
  no update.
- `CONFLICTING_CUSTOMER_TYPES` lists seven conflicting pairs, and loyalty tiers conflict with
  each other. `USERLIST_NOT_ELIGIBLE`: only CRM-based, rule-based, data-model and GCN lists take
  types. `CONVERSION_TRACKING_NOT_ENABLED_OR_NOT_MCC_MANAGER_ACCOUNT`: conversion tracking must be
  enabled, and with cross-account tracking only the manager can change types.

## Change

New reviewed family `google_user_list_customer_types` (`src/google-user-list-customer-types.ts`):

| Part | Behaviour |
|---|---|
| Request | 1–100 create or remove operations of the selected customer, each list and category once, at most 50 lists; no partial failure or validation-only mode |
| State | The customer (conversion tracking status), each list (type, share status) and every customer type of those lists |
| Checks | Tracking enabled and managed by this account or as manager; CRM-based or rule-based lists to attach; revoked shares refused; existing types are `CONFIGURATION_EXISTS`; removals need an attached type; no conflicting types after the request |
| Safety | No spending confirmation: budgets and list members do not change; the impact says bids of customer acquisition campaigns can change |
| Receipt | One result per operation naming its customer type; anything else is a failure that is never resubmitted |
| Verification | The customer types of every list read again and compared with the types after the request |

Other code: `src/write-review.ts`, `src/write-verification.ts`, `src/write-impact.ts`,
`src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts` and
`src/provider-contracts.ts` (Google contract version 21). Guidance: "User list customer types" in
`Skills/amcp-campaign-builder/references/google-ads.md` and an executable inspect example.

## Tests

`tests/google-user-list-customer-types.test.mjs`, five tests:

1. Two attachments and a removal across two lists are sent once without spending confirmation and verify against every list; a replay sends nothing.
2. Twelve malformed requests fail before any request.
3. Logical lists, existing and missing types, conflicting pairs and loyalty tiers, unknown lists, revoked shares and accounts without their own conversion tracking are refused after reading, without writes; moving a list between loyalty tiers in one request is accepted.
4. A result naming another customer type is a failure that is never resubmitted; an ignored change is not verified.
5. The categories and conflicts match the pinned Discovery document, and the ledger lists the action in the family.

Red/green against a build of `220e746`: all five tests fail (no reviewed family: the action was a blocked write, and the module does not exist). Local log:
`.runtime/google-customer-types-20260927/red-check.log`.

## Verification

- Targeted: 153 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, media, scope
  and security suite, with FFmpeg configured: 1,799/1,799.
- Guidance coverage: 273 write-path refusals across 151 modules accounted for.
- Full qualification: see
  [GOOGLE-USER-LIST-CUSTOMER-TYPES-VERIFICATION-2026-09-27.json](GOOGLE-USER-LIST-CUSTOMER-TYPES-VERIFICATION-2026-09-27.json).

Remaining rows: 876 (one Google Ads row reviewed; Google Ads blocked writes 94 → 93). Live
acceptance is unverified; it needs the updated deployment and an account with conversion tracking
and a CRM-based or rule-based list.
