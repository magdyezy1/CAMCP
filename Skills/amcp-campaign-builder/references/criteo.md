# Criteo Retail Media preferred targeting

AMCP qualifies nine targeting writes for **existing preferred line items** on
Retail Media API 2026-01. It does not yet create Criteo campaigns/line items or
connect Criteo through the website. An administrator must provision an encrypted
native connection with the chosen account, an explicit AMCP write grant and
recorded `RetailMedia_Campaign_Read` and `RetailMedia_Campaign_Manage` permissions.
Provider approval and retailer access remain independent requirements.

Use `criteo_native_action` with `operation: criteo_line_item_ops`. Discover the
exact actions. Start with `GET_LINE_ITEMS_BY_ACCOUNT_ID`, selected `account_id`,
`params: {limitToId: ["<line ID>"], limitToType: "Preferred", pageIndex: 0,
pageSize: 2}`. This establishes an observation for that connection/account.
Preparation and execution each freshly recheck that membership, its campaign's
account, retailer, detailed line configuration and complete target state.
Do not guess a global line ID or switch connections to evade a missing grant.

The three target kinds are audiences (`audienceIds`), stores (`storeIds`), and
add-to-basket (`productIds`, `categoryIds`). Read the relevant current target.
For `APPEND_*_BY_LINE_ITEM_ID` and `DELETE_*_BY_LINE_ITEM_ID`, supply
`params: {"line-item-id": "<line ID>"}` and native
`payload: {data: {attributes: {storeIds: ["<selected store ID>"]}}}` (substitute
the applicable target fields). Audience IDs must be returned by the selected
account/retailer audience search; AMCP checks their current definitions again.
Store/product/category eligibility is still enforced by Criteo for this retailer.
Do not invent retailer identifiers or infer that a foreign audience is available.

`PUT_*_BY_LINE_ITEM_ID` changes `scope` to `include` or `exclude`. Supply all
current arrays unchanged, including empty arrays. Use append/delete to change
membership; the current reference describes PUT as changing scope, so AMCP does
not assume it replaces members. `TARGET_MEMBERSHIP_UPDATE_REQUIRED` explains this
distinction. `TARGET_SCOPE_REQUIRED` requires a scope review before member edits.
Native action names are not perfectly singular/plural: use discovery rather than
generating names from this prose.

Run `amcp_write inspect`, then prepare, review the exact configuration and effects,
and execute once with its original review/key, `confirmed: true` and
`spend_change_confirmed: true`. Targeting changes can immediately affect delivery;
owner activation/deletion restrictions still apply. Removing the last target or
changing include/exclude may broaden or eliminate eligibility. These operations
do not set a new budget. Do not invent a paused status on a targeting object.

Use `amcp_campaign action=verify` with the original review. Verification compares
the complete resulting target set and scope. An HTTP 200 containing errors,
warnings or incomplete state cannot prove success. After a lost response or
partial result, never resubmit with a new key. Keep the original evidence, read
actual targets and prepare any necessary correction separately. Local idempotency
survives a process restart; Criteo idempotency is not assumed.

Bounds: 100 membership changes per review, or PUT preserving up to 100 current
members; 1000 retained target identifiers; at most 24 state requests, 4 MiB per
response and 8 MiB combined. Filtered discovery must return a complete exact
target; partial pages and arbitrary next URLs are refused. Large targeting sets
need a qualified larger-scope workflow. Local fixtures cover these contracts;
live retailer acceptance, serving and provider account approval are unverified.
