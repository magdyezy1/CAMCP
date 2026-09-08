# Reddit adapter

All 49 action names exposed by the seven captured Reddit operation schemas resolve to the saved official v3 specification. Two independent AMCP actions, CREATE_SAVED_AUDIENCE and UPDATE_SAVED_AUDIENCE, extend reddit_account_ops at runtime without rewriting the captured catalog. Some names are aliases of the same vendor operation. Mappings are independently designed; exact WhatHead behavior and live Reddit execution are not verified. The specification is captured in `.mirror/VENDOR/reddit-v3.json` and regenerated through `tools/fetch-vendor-specs.mjs`. [Official API specification](https://ads-api.reddit.com/api/v3/openapi.json).

## Connection

Provision a Reddit connection with explicit ad account IDs, `userAgent`, and an access token from your own application. Include clientId/clientSecret/refreshToken/expiresAt for refresh. The adapter uses bearer authentication for Ads API requests and Basic client authentication for token refresh. A readable application identity belongs in userAgent. No application has been registered during this build. [Reddit authentication](https://ads-api.reddit.com/docs/v3/guides/quick-start/authenticate).

The gateway binds accounts such as `a2_...` or `t2_...`. A scoped campaign/ad-group/ad/profile/saved-audience/lead-form/funding-instrument collection can establish short-lived ownership for its returned entity IDs. Global object reads require that ownership or an administrator-provisioned resource binding. Business-level discovery and catalogs require explicit resource bindings; an ad account binding alone does not grant an entire business. LIST_MY_BUSINESSES can use params.ad_account_id to constrain discovery to the selected account. Public targeting and timezone catalogs are available through an explicitly bound connection.

## Requests

Use native `params` for documented path/query parameters. account_id aliases ad_account_id; pageSize/page_size/limit alias page.size; pageToken/page_token/after/cursor alias page.token. Conflicting aliases fail. Comma-separated vendor array filters are serialized according to the specification. Request bodies use the published envelope under payload, including its data property. JSON bodies and responses are validated without coercing values or inserting defaults.

```json
{
  "operation": "reddit_campaign_ops",
  "arguments": {
    "action": "LIST_CAMPAIGNS",
    "account_id": "a2_REPLACE",
    "pageSize": 50,
    "params": {"id": ["CAMPAIGN_1", "CAMPAIGN_2"]}
  }
}
```

GET_INSIGHTS maps to POST /api/v3/ad_accounts/{id}/reports, an independently classified read. Provide increasing UTC timestamps aligned to complete hours. A native MCP call returns a single page and the vendor pagination metadata; saved native report jobs follow pages up to the bounded limit. Next-page links cannot change the origin, path, account or original filters. [Reddit report endpoint](https://ads-api.reddit.com/docs/v3/api/get-a-report), [pagination contract](https://ads-api.reddit.com/docs/v3/api/reddit-advertising-api#pagination).

```json
{
  "operation": "reddit_reporting_ops",
  "arguments": {
    "action": "GET_INSIGHTS",
    "account_id": "a2_REPLACE",
    "payload": {
      "data": {
        "starts_at": "2026-08-01T00:00:00Z",
        "ends_at": "2026-08-02T00:00:00Z",
        "fields": ["IMPRESSIONS", "CLICKS", "SPEND"],
        "breakdowns": ["DATE"]
      }
    }
  }
}
```

Native writes produce local request previews by default; reviewed execution is available through amcp_write for the qualified contracts below. Creating a structured-post job would create vendor state and remains outside those contracts. Multi-stage media generation/upload, vendor UI confirmation, service-only conditional validation and live response parity are not claimed. Local tests cover request/response failures, ownership, report pagination/truncation, token rotation and zero-egress mutation denial.

## Reviewed campaign and saved-audience execution

Use amcp_write inspect/prepare with gateway reddit_native_action and the native operation/arguments envelope. Both adsread and adsedit, an operator identity, an account write grant and enabled deployment writes are required. Preserve Reddit's payload.data envelope. New campaigns, ad groups and ads must start configured_status: PAUSED. Execution also requires spend_change_confirmed; deletion is a reviewed PATCH with configured_status: DELETED, not an invented DELETE endpoint.

- reddit_campaign_ops: CREATE/UPDATE_CAMPAIGN, CREATE/UPDATE_AD_GROUP, CREATE/UPDATE_AD.
- reddit_account_ops: CREATE/UPDATE_SAVED_AUDIENCE (independent AMCP additions).
- Saved audiences are REDDIT_AUDIENCE targeting definitions; updates support name/targeting or status: DELETED. No customer lists are uploaded.
- Classic ad groups require an existing campaign and conversion_pixel_id; CBO campaigns also require conversion_pixel_id under the current provider contract. Ads require an existing ad_group_id and post_id. Reddit Max/dynamic creative templates remain outside this contract. [Campaign contract](https://ads-api.reddit.com/docs/v3/api/create-campaign), [ad-group contract](https://ads-api.reddit.com/docs/v3/api/create-ad-group).
- The guard reads the same exact parent/target at both steps. Successful create responses must identify the selected account and referenced parent; their IDs are immediately bound to that connection/account for follow-up prepares. Existing posts/profiles need account ownership evidence or an exact administrator binding.

```json
{
  "action": "prepare",
  "gateway": "reddit_native_action",
  "arguments": {
    "operation": "reddit_campaign_ops",
    "arguments": {
      "action": "CREATE_CAMPAIGN",
      "account_id": "a2_REPLACE",
      "payload": {"data": {"name": "Reviewed campaign", "configured_status": "PAUSED", "objective": "CLICKS"}}
    }
  }
}
```

Local chain tests cover campaign → saved targeting → ad group → existing-post ad, updates/deactivation, stale configuration, replay protection, mismatched receipts and revoked/missing grants. Reddit media/Drive import, post publication, customer-list ingestion and live production acceptance are still pending.
