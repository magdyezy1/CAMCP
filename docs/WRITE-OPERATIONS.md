# Reviewed write operations

AMCP supports explicitly reviewed campaign-management mutations. The existing native gateways still provide reads and local dry runs. The additional `amcp_write` tool handles live execution when enabled. This extension is independently designed; it does not establish complete behavioral equivalence with AMCP.

## Enable access

1. In Railway variables, set `MIRROR_ALLOW_WRITES=true` and redeploy. Preserve `MIRROR_MASTER_KEY` and the persistent `/data` volume. Set the target port to the effective Railway `PORT` (**8080** in the current Railway service; local development defaults to 4317). `/healthz` reports the effective `live_writes` flag.
2. Sign in to Connections. Connect or reconnect each provider with the required app permissions. New Meta authorizations request `ads_management`; LinkedIn requests `rw_ads`; X requests write access. Existing provider tokens are not upgraded by changing an environment variable. Explicit `AMCP_<PROVIDER>_SCOPES` overrides take precedence, including an empty override.
3. Select the accounts available to the connection. New logins default to read plus reviewed write access when deployment write support is enabled. The selection screen offers an explicit read-only choice and per-account grant controls. Existing logins and manually revoked grants retain their access. Write grants are always a subset of selected accounts; deselection removes them.
4. On Connectors, create the default **read + write** operator token and confirm its access, or choose a read-only token. New OAuth clients that omit scope default to `mcp:read mcp:write`; the authorization page still requires administrator consent. Explicit `mcp:read` requests and existing reader registrations stay read-only. Refresh cannot increase scope.

For local stdio, `MIRROR_ALLOW_WRITES=true` defaults the role to operator; explicit `MIRROR_ROLE=reader` keeps read-only access. Provide the encryption key and provision the connection's `writeAccounts` subset using the administrator CLI. HTTP role selection always comes from the authenticated connector, never client-supplied tool arguments. An explicit deployment setting of `MIRROR_ALLOW_WRITES=false` disables all live writes.

Provider permissions, account roles, app review and API access remain necessary. Broad provider permissions do not override AMCP's account grants. Stop future submissions by revoking the connector, removing account write grants, or disabling write support. Revocation is checked again after asynchronous state reads and credential refresh. Requests already received by a provider cannot be recalled.

## Inspect, prepare, review, execute

For an unfamiliar non-media operation, call `amcp_write` with `action: inspect`, `gateway` and the native `arguments`. This checks local execution-contract support, reports its state-read paths and makes no credential or network access. It does not verify live permissions or create a review. Media imports use their media preparation flow.

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

Preparation performs provider reads and returns `executed:false`, the frozen native request, its before-state, `state_hash`, `state_reads`, expiry, `review_id` and `idempotency_key`. Inspect the account, resources and payload. No mutation is submitted during preparation. `dry_run:true` on the original gateway is an entirely local preview and does not produce a write review.

Prepare and execute reuse the stored read plans. Both snapshots are normalized before comparison: object keys and scalar arrays are sorted, while duplicate scalar members, scalar types and ordered object arrays are preserved. Delivery telemetry, server timestamps, request-status wrappers and stats/pacing telemetry are excluded after validating the raw response. Mutable status, budgets, schedules, targeting, bids and pacing configuration remain protected. Unknown configuration fields are retained. `STATE_CHANGED` includes `expected_state_hash`, `actual_state_hash` and JSON paths in `changed_fields`; the request `fingerprint` remains a separate hash of the frozen request. The guard never treats provider errors or partial reads as valid state.

Submit the same review only after confirming its intended change:

```json
{
  "action": "execute",
  "review_id": "COPY_FROM_PREPARE",
  "idempotency_key": "COPY_FROM_PREPARE",
  "confirmed": true
}
```

Budget, bid, spend or activation changes additionally require `spend_change_confirmed:true`. New serving entities must explicitly be paused or draft. Execute cannot replace the request, account or connection. Reviews expire after five minutes and belong to the same tenant and user that prepared them. Changed, incomplete, paginated or missing state prevents submission. Successful Meta and Snapchat creates register their returned resource IDs to the owning tenant, connection and selected account, immediately allowing child prepares. Other global resources require an account-scoped collection read or an administrator binding. Existing ownership expiry and revocation rules remain enforced.

## Supported execution contracts

| Provider | Reviewed routes |
| --- | --- |
| Google Ads | Homogeneous campaign, ad group, ad group ad, ad, asset, asset group and campaign budget mutate endpoints, plus campaign/ad-group criteria, shared exclusion lists, shared criteria and campaign/list links; 1–25 operations. Explicit field masks for updates. Partial failure and validate-only modes are excluded from execution. |
| Meta | Campaign, ad set, ad and creative collection creates; individual campaign/ad set/ad updates and deletes. Creative identity and link prerequisites are checked, including existing Instagram media using source_instagram_media_id plus instagram_user_id. |
| TikTok | Standard campaign, ad group and ad create/update/status endpoints. Smart+ and other specialty routes are excluded. |
| Snapchat | Campaign, ad squad, ad and creative creates; account collection replacements; single-entity JSON Patch updates (including creatives) and deletes. PUT replaces the full entity; supply the complete intended record. |
| LinkedIn | Account-scoped campaign groups, campaigns and creatives; entity POST updates require `restli_method: "PARTIAL_UPDATE"` and a native patch. |
| X | Account-scoped campaigns, line items and promoted tweets. |
| DV360 | Advertiser-scoped campaigns, insertion orders, line items and creatives. |
| GA4 | Audience export and report task creation; exact selected property and audience scope. |
| Tag Manager / Google tag | Container, workspace, tag, trigger, variable, Google tag config, template, folder, zone, client, transformation and environment CRUD; create/update/delete container versions and publish versions. |
| Search Console | Add/remove a selected site; submit/remove its sitemaps. |
| Apple Ads | Platform API v1 campaign create/update/delete; paused creation, native account header and exact target checks. |
| Reddit | Classic campaign/ad-group/ad creates and PATCH updates, plus saved Reddit targeting audiences. Ads use existing posts. New serving entities start PAUSED; adsread + adsedit are required. Created resources immediately gain account ownership. See [contracts and limits](REDDIT.md). |
| Microsoft Advertising | Search campaign, ad group, responsive search ad and keyword Add/Update/Delete; exact parent and target reads, native decimal amounts, string IDs and indexed partial failures. See [setup and limits](MICROSOFT-ADS.md). |

An action also needs an implemented target-state read. Unsupported contracts return a precise error before mutation egress. [Google Drive media imports](MEDIA-UPLOADS.md) integrate with normal upload actions and `platform_media_upload`; their reviews execute through `amcp_write` or `amcp_media`. Meta/Snapchat creative creation and native Google asset mutations are included. Arbitrary binary transports, batch/tunnel requests, unqualified delegated workflows and other catalog routes remain unavailable for live execution. Catalog presence describes an interface, not live execution qualification.

## Outcomes and recovery

The database claims the exact review immediately before submission. Concurrent execution of the same review cannot send duplicate mutations. Completed outcomes replay without vendor egress; idempotency survives process restart. Mutations are never automatically retried.

Provider response contracts must positively confirm success. Partial failures, missing operation results, target mismatches and malformed responses cannot be reported as successful writes. Native response details and supported request/created-ID headers are retained. A lost response leaves an uncertain durable claim: inspect the advertising platform before preparing any replacement. AMCP does not automatically undo mutations or guarantee a cross-system transaction. State may still change between the final read and the provider accepting a write; no universal provider conditional-write facility exists here.

Protect the SQLite volume and backups: they retain account information, review payloads, redacted outcomes and audit records. Keep the encryption key separately. Restoration of an older backup may lose recent submission claims; reconcile platform state before resuming writes after a restore.

## Verification boundary

Automated tests cover native campaign CRUD requests for all six primary platforms and DV360, response validation, expired/stale reviews, tenant/user binding, grants, paused creation, duplicate submissions, lost responses, credential revocation and restart persistence using synthetic provider responses. The container CI workflow exercises both runtime modes. New tests exercise all four measurement/Apple providers with synthetic state and responses, including every enabled Tag Manager action, required scopes, native fingerprints, optional target absence and cross-resource rejection. Live mutations were not executed against user advertising accounts during development. Production OAuth, app approvals and live endpoint qualification remain external acceptance work.

Account write grants apply to campaigns, ad sets, ads, creatives and media equally. `WRITE_ACCOUNT_FORBIDDEN` reports the chosen connection ID and the selected account, plus whether other connections for that account have write grants. Set `connection_id` explicitly when selecting a different login; AMCP never silently chooses a more privileged one. Workspace context and account listings expose the same grant status. New connections default to reviewed write access when enabled; existing reader grants are preserved.

## Google targeting and exclusion lists

Reviewed execution now supports five v23 native mutate endpoints: campaignCriteria, adGroupCriteria, sharedSets, sharedCriteria and campaignSharedSets. Discover their exact actions through the Google gateway. Each call remains homogeneous and uses the normal prepare/execute review, explicit confirmation and spend_change_confirmed. New positive ad-group criteria require PAUSED; exclusions do not need a fabricated status.

Qualified criteria include positive/negative ad-group keywords, negative campaign keywords, locations, languages, devices, schedules, demographic exclusions, topics, existing user lists/audiences and placement exclusions where the native criterion type supports them. Shared lists use NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS; list members must match the enabled parent list type. Criterion identity, parent and negative flag cannot be changed through an update mask: remove and recreate instead. Shared-set updates change name; shared criteria and campaign/list links support create/remove only.

Updates/removes read exact resource names and mutable configuration, including keyword bid micros. Creation reads the exact campaign/ad group/shared list and any referenced user-list/audience. Preparation and execution reuse those frozen GAQL reads. Composite criterion names must contain their native parent~criterion IDs; all customer-qualified references must belong to the selected customer. Budgets/bids retain native micros as decimal strings. Arbitrary new audiences, customer-match ingestion, all criterion variants and channel combinations are not qualified by this addition. [Google criteria](https://developers.google.com/google-ads/api/docs/targeting/criteria).
