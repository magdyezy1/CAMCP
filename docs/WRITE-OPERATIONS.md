# Reviewed write operations

AMCP supports explicitly reviewed campaign-management mutations. The existing native gateways still provide reads and local dry runs. The additional `amcp_write` tool handles live execution when enabled. This extension is independently designed; it does not establish complete behavioral equivalence with WhatHead.

## Enable access

1. In Railway variables, set `MIRROR_ALLOW_WRITES=true` and redeploy. Preserve `MIRROR_MASTER_KEY` and the persistent `/data` volume. Keep the target port and `PORT` at **4317**. `/healthz` reports the effective `live_writes` flag.
2. Sign in to Connections. Connect or reconnect each provider with the required app permissions. New Meta authorizations request `ads_management`; LinkedIn requests `rw_ads`; X requests write access. Existing provider tokens are not upgraded by changing an environment variable. Explicit `AMCP_<PROVIDER>_SCOPES` overrides take precedence, including an empty override.
3. Select the accounts available to the connection. Grant writes separately for the accounts you intend to manage. A write grant is always a subset of selected accounts; deselection removes it.
4. On Connectors, create an **operator** token and confirm its access. Configure the client using the displayed bearer-token configuration. Tokens default to **reader**. OAuth clients must explicitly request `mcp:write` during registration and authorization and receive administrator consent. Refresh cannot increase scope.

For local stdio, explicitly set `MIRROR_ROLE=operator` and `MIRROR_ALLOW_WRITES=true`, provide the encryption key, and provision the connection's `writeAccounts` subset using the administrator CLI. HTTP role selection always comes from the authenticated connector, never client-supplied tool arguments.

Provider permissions, account roles, app review and API access remain necessary. Broad provider permissions do not override AMCP's account grants. Stop future submissions by revoking the connector, removing account write grants, or disabling write support. Revocation is checked again after asynchronous state reads and credential refresh. Requests already received by a provider cannot be recalled.

## Prepare, review, execute

Call `amcp_write` with a normal native gateway request. This example uses a synthetic account ID; replace it with an explicitly granted account.

```json
{
  "action": "prepare",
  "gateway": "meta_native_action",
  "arguments": {
    "action": "meta_campaign_create",
    "account_id": "123",
    "payload": {
      "name": "Reviewed draft",
      "status": "PAUSED",
      "objective": "OUTCOME_TRAFFIC",
      "special_ad_categories": []
    }
  }
}
```

Preparation performs provider reads and returns `executed:false`, the frozen native request, its before-state, expiry, `review_id` and `idempotency_key`. Inspect the account, resources and payload. No mutation is submitted during preparation. `dry_run:true` on the original gateway is an entirely local preview and does not produce a write review.

Submit the same review only after confirming its intended change:

```json
{
  "action": "execute",
  "review_id": "COPY_FROM_PREPARE",
  "idempotency_key": "COPY_FROM_PREPARE",
  "confirmed": true
}
```

Budget, bid, spend or activation changes additionally require `spend_change_confirmed:true`. New serving entities must explicitly be paused or draft. Execute cannot replace the request, account or connection. Reviews expire after five minutes and belong to the same tenant and user that prepared them. Changed, incomplete, paginated or missing state prevents submission. Meta and Snapchat global entity reads require ownership observed from an account-scoped collection, or an explicit administrator resource binding.

## Supported execution contracts

| Provider | Reviewed routes |
| --- | --- |
| Google Ads | Homogeneous campaign, ad group, ad group ad, ad, asset group and campaign budget mutate endpoints; 1–25 operations. Explicit field masks for updates. Partial failure and validate-only modes are excluded from execution. |
| Meta | Campaign, ad set and ad collection creates; individual updates and deletes. |
| TikTok | Standard campaign, ad group and ad create/update/status endpoints. Smart+ and other specialty routes are excluded. |
| Snapchat | Campaign, ad squad and ad creates, account collection replacements, single-entity JSON Patch updates and deletes. PUT replaces the full entity; supply the complete intended record. |
| LinkedIn | Account-scoped campaign groups, campaigns and creatives; entity POST updates require `restli_method: "PARTIAL_UPDATE"` and a native patch. |
| X | Account-scoped campaigns, line items and promoted tweets. |
| DV360 | Advertiser-scoped campaigns, insertion orders, line items and creatives. |

An action also needs an implemented target-state read. Unsupported contracts return a precise error before mutation egress. Special media upload, arbitrary batch/tunnel requests, delegated writes and other catalog routes remain unavailable for live execution. Catalog presence describes an interface, not live execution qualification.

## Outcomes and recovery

The database claims the exact review immediately before submission. Concurrent execution of the same review cannot send duplicate mutations. Completed outcomes replay without vendor egress; idempotency survives process restart. Mutations are never automatically retried.

Provider response contracts must positively confirm success. Partial failures, missing operation results, target mismatches and malformed responses cannot be reported as successful writes. Native response details and supported request/created-ID headers are retained. A lost response leaves an uncertain durable claim: inspect the advertising platform before preparing any replacement. AMCP does not automatically undo mutations or guarantee a cross-system transaction. State may still change between the final read and the provider accepting a write; no universal provider conditional-write facility exists here.

Protect the SQLite volume and backups: they retain account information, review payloads, redacted outcomes and audit records. Keep the encryption key separately. Restoration of an older backup may lose recent submission claims; reconcile platform state before resuming writes after a restore.

## Verification boundary

Automated tests cover native campaign CRUD requests for all six primary platforms and DV360, response validation, expired/stale reviews, tenant/user binding, grants, paused creation, duplicate submissions, lost responses, credential revocation and restart persistence using synthetic provider responses. Container CI exercises both runtime modes. Live mutations were not executed against user advertising accounts during development. Production OAuth, app approvals and live endpoint qualification remain external acceptance work.
