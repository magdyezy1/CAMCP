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

Prepare and execute reuse the stored read plans. Raw responses are checked for provider errors, completeness and exact resource identity before projecting configuration. Google snapshots retain only `results`, excluding `queryResourceConsumption`, field masks and other envelope metadata. TikTok retains `data.list`; X/Reddit retain `data`; Microsoft retains the contract's named entity result; Apple retains `result`; Snapchat retains the requested resource records. A nonempty pagination continuation still blocks execution before projection. Flat resource responses retain unknown configuration fields; Search Console sitemap crawl/processing observations are excluded while submission identity and `lastSubmitted` remain protected. Media account reviews use the same projection.

Object keys and explicitly qualified scalar sets are normalized; unknown/ordered arrays, duplicate members and scalar types remain meaningful. Google GAQL resource rows are sorted by their validated identities, without sorting arrays inside a resource indiscriminately. Delivery telemetry, server timestamps and stats/pacing telemetry are excluded; mutable status, budgets, schedules, targeting, bids, pacing, native fingerprints and unknown resource configuration remain protected. `STATE_CHANGED` includes `expected_state_hash`, `actual_state_hash` and JSON paths in `changed_fields`; the request `fingerprint` remains a separate hash of the frozen request. Still-valid older, unsubmitted review envelopes are reprojected using their frozen read plans. Their normalized state hash may differ from the pre-upgrade value, but request fingerprints, expiry, confirmations, grants and original idempotency claims are unchanged. Completed writes replay their original receipt; uncertain claims are never reset.

See the [state-projection repair and platform coverage report](implementation/STATE-PROJECTION-2026-09-18.md) for reproductions, compatibility details and verification limits.

Submit the same review only after confirming its intended change:

```json
{
  "action": "execute",
  "review_id": "COPY_FROM_PREPARE",
  "idempotency_key": "COPY_FROM_PREPARE",
  "confirmed": true
}
```

Budget, bid, spend or activation changes additionally require `spend_change_confirmed:true`. New serving entities must explicitly be paused or draft.

`prepare` returns `execute_requirements` — `{confirmed, idempotency_key, spend_change_confirmed, creative_edit_confirmed, reasons[]}` — decided by the same rules execute applies, so a client asks the user once instead of discovering a missing flag from a refused execute, and `expires_in_seconds`. Execute still re-checks everything. The spending acknowledgement is decided structurally as well as by field names (`src/spend-effects.ts`):

- An edit of an existing campaign, campaign group, insertion order, ad set, ad group, ad squad or line item in the generic Google Ads, Meta, TikTok, LinkedIn, X, DV360 and Snapchat families needs `spend_change_confirmed` unless every field it changes is the name, an identifier, or a status that pauses, archives or removes. Bid targets (`targetCpaMicros`, `targetRoas`, LinkedIn `unitCost`), pacing (DV360 `pacing`), schedules, targeting and optimization goals therefore need it; the refusal lists the fields. Ads, creatives and assets are content: their activation is still checked, and creative edits keep their own impact disclosure.
- A status given as a number (ProtoJSON enum numbers such as Google Ads `status: 2`, which is ENABLED) cannot be shown to leave an entity paused: it needs `spend_change_confirmed`, counts as activation under `allow_activation:false`, and reviewed Google Ads mutations refuse numeric enum values outright (`INVALID_VENDOR_BODY`).
- `amcp_campaign` never pre-fills `spend_change_confirmed` in its suggested `next_call`. When the step needs it, the response carries `execute_requirements` and `next_call.add_after_user_approval`; add those flags only after the user approves the reviewed change.
- `amcp_campaign` responses are compact and at most 12 KB whatever the number of steps: the plan header, one row per step with its resource IDs, verification status and error code, the step the call acted on (`current`, with its receipt and verification) and `next_call`. `prepare_next` shows the review's request, state hash, a summary of each state read and the spend policy, not the raw before-state. `get` with `step_id` returns one step whole and `get` with `detail: "full"` the whole stored plan; nothing stored changed.
- A Google Ads mutation or Snapchat entity batch of more than 25 records (at most 1,000) is prepared as one review with `group: true` and `parts` of 25. Each part is an ordinary review with its own state reads, state hash, idempotency key, spending check and read-back; the group is approved and executed once (`execute_requirements` is the union of the parts'). Execution checks that every part is still inside its review window, then sends the parts in order and stops at the first that does not succeed: `WRITE_OUTCOME_UNCERTAIN` when that part was sent, `WRITE_PARTIAL_OR_FAILED` when earlier parts were applied and it was refused, and the error lists the parts not sent. A stopped group is never run again; a completed one replays its receipt. `amcp_campaign verify` with the group's `review_id` reads every part back. Operations that link through temporary IDs are not split.
- `idempotency_key` is optional at execute (in `amcp_write`, `amcp_media` and `amcp_campaign execute_next`): it is the review id, and a key that differs from it is still refused.
- An expired review (`REVIEW_EXPIRED`) was refused before anything was submitted. The error carries `details.next_call`, which prepares the same request again. Ownership bindings from account-scoped reads also last five minutes, so the re-preparation may first need that read again (`RESOURCE_SCOPE_REQUIRED`). In a campaign plan the step returns to `pending` and `prepare_next` prepares it again.
- Execute-time confirmation refusals (`SPEND_CONFIRMATION_REQUIRED`, `CREATIVE_EDIT_CONFIRMATION_REQUIRED`, `CONFIRMATION_REQUIRED`) keep the review valid: call execute again with the named flag after the user approves; do not prepare again.
- In enhanced mode, `native_request` is a read-only extension: `amcp_write` refuses it (`WRITE_CONTRACT_UNAVAILABLE`), because it lets a caller choose the action and the path independently. Execute cannot replace the request, account or connection. Reviews expire after five minutes and belong to the same tenant and user that prepared them. Changed, incomplete, paginated or missing state prevents submission. Successful Meta and Snapchat creates register their returned resource IDs to the owning tenant, connection and selected account, immediately allowing child prepares. Other global resources require an account-scoped collection read or an administrator binding. Existing ownership expiry and revocation rules remain enforced.

An owner spending policy separates creates from updates, because `max_budget_increase_percent` and the unambiguous-baseline rule only mean something against a prior budget. A create is recognised from an explicit REST.li `CREATE`, a `create` operation inside the payload, or a collection-scoped action name. A REST.li POST addressed to one resource — `…_{id}_post` or `…_{urn}_post`, which is how LinkedIn expresses `PARTIAL_UPDATE` — changes an existing budget and stays under the percentage and baseline rules. `max_budget_native` and `max_daily_increase_native` apply to both. Reddit campaign and ad group `goal_value` is a budget in microcurrency (pinned Reddit Ads API v3); an update that omits `goal_type` is compared with the reviewed entity's current goal of the same type.

A policy can be attached to one (gateway, account) pair or set once for the workspace with `scope: "workspace"`. The account-specific policy wins where one exists; otherwise the workspace default applies, so an account nobody configured individually is still protected. Each account keeps its own daily allowance under a shared default. `prepare` reports which applied as `spend_policy.scope`, and reports `configured:false` with `unprotected:true` when nothing protects the account. `amcp_workspace health` lists those accounts under `unprotected_accounts`.

`allow_activation:false` is enforced against the payload structure using a per-gateway declaration of the field and values each provider uses to start delivery — Meta `status:ACTIVE`, Google Ads `status:ENABLED`, TikTok `operation_status:ENABLE`, X `entity_status:ACTIVE`, DV360 `entityStatus:ENTITY_STATUS_ACTIVE`, Reddit `configured_status:ACTIVE`, Microsoft `Status:Active`. JSON Patch operations are resolved by their `path` and `value` in either key order. Measurement gateways declare no serving-activation surface and are not constrained by it. A gateway with no declaration is refused outright while activation is forbidden, so adding a provider without declaring its vocabulary fails closed.

The daily window is the UTC calendar day, and the cap counts requested positive budget increases rather than billed spend. A reservation taken for a write that then fails is deliberately not released: a transport failure may still have reached the provider, and releasing it would let repeated failures walk past the cap.

## Supported execution contracts

| Provider | Reviewed routes |
| --- | --- |
| Google Ads | Homogeneous campaign, ad group, ad group ad, ad, asset, asset group and campaign budget mutate endpoints, plus campaign/ad-group criteria, shared exclusion lists, shared criteria and campaign/list links; 1–25 operations. Explicit field masks for updates. Partial failure and validate-only modes are excluded from execution. |
| Meta | Campaign, ad set, ad and creative collection creates; individual campaign/ad set/ad updates and deletes. Creative identity and link prerequisites are checked, including existing Instagram media using source_instagram_media_id plus instagram_user_id. |
| TikTok | Standard campaign, ad group and ad create/update/status endpoints. Smart+ and other specialty routes are excluded. |
| Snapchat | Campaign, ad squad, ad and creative creates; account collection replacements; single-entity JSON Patch updates (including creatives) and deletes. PUT replaces the full entity; supply the complete intended record. |
| LinkedIn | Account-scoped campaign groups, campaigns and creatives; entity POST updates require `restli_method: "PARTIAL_UPDATE"` and a native patch. Organization-authored non-feed single-media DSC creation uses the separate exact-binding contract described in the [operator guide](../Skills/amcp-campaign-builder/references/linkedin-x.md). |
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

`contract_evidence` distinguishes captured catalog metadata, official schemas and live qualification. Inspect/prepare do not infer provider permission from provenance. Its provider contract is 1.3–6.6 KB. With `evidence: "ref"`, inspect and prepare return a reference in its place: the contract's versions, review date, write status and version end, and `full_contract`, the `amcp_tool_help` call whose `data.amcp_contract` (its `result_field`) is the whole contract. The form changes nothing else in the review. `amcp_campaign` prepares its steps with references. Exact read-back retries up to three times on propagation gaps or disagreement; `VERIFICATION_INCONCLUSIVE` retains hashes and changed-field diagnostics and suggests read-only continuation of the original review only while another read can change the answer. When every read of two rounds returns the same differing state, the result is `VERIFICATION_MISMATCH` with a per-field `diff` and the observed `actual_hash`, and no read is suggested; in a campaign plan the user may accept it with `reconcile_step` and `accept_observed: true`. Never use a new mutation key to resolve it. Snapchat creative PUT also requires explicit preservation of existing configuration, including nested defaults; use PATCH for a partial edit instead of accepting accidental resets.

Provider response contracts must positively confirm success. Partial failures, missing operation results, target mismatches and malformed responses cannot be reported as successful writes. Native response details and supported request/created-ID headers are retained. A lost response leaves an uncertain durable claim: inspect the advertising platform before preparing any replacement. AMCP does not automatically undo mutations or guarantee a cross-system transaction. State may still change between the final read and the provider accepting a write; no universal provider conditional-write facility exists here.

Protect the SQLite volume and backups: they retain account information, review payloads, redacted outcomes and audit records. Keep the encryption key separately. Restoration of an older backup may lose recent submission claims; reconcile platform state before resuming writes after a restore.

## Verification boundary

Automated tests cover native campaign CRUD requests for all six primary platforms and DV360, response validation, expired/stale reviews, tenant/user binding, grants, paused creation, duplicate submissions, lost responses, credential revocation and restart persistence using synthetic provider responses. The container CI workflow exercises both runtime modes. New tests exercise all four measurement/Apple providers with synthetic state and responses, including every enabled Tag Manager action, required scopes, native fingerprints, optional target absence and cross-resource rejection. Live mutations were not executed against user advertising accounts during development. Production OAuth, app approvals and live endpoint qualification remain external acceptance work.

Account write grants apply to campaigns, ad sets, ads, creatives and media equally. `WRITE_ACCOUNT_FORBIDDEN` reports the chosen connection ID and the selected account, plus whether other connections for that account have write grants. Set `connection_id` explicitly when selecting a different login; AMCP never silently chooses a more privileged one. Workspace context and account listings expose the same grant status. New connections default to reviewed write access when enabled; existing reader grants are preserved.

## Google targeting and exclusion lists

Reviewed execution now supports five Google Ads native mutate endpoints: campaignCriteria, adGroupCriteria, sharedSets, sharedCriteria and campaignSharedSets. Discover their exact actions through the Google gateway. Each call remains homogeneous and uses the normal prepare/execute review, explicit confirmation and spend_change_confirmed. New positive ad-group criteria require PAUSED; exclusions do not need a fabricated status.

Qualified criteria include positive/negative ad-group keywords, negative campaign keywords, locations, languages, devices, schedules, demographic exclusions, topics, existing user lists/audiences and placement exclusions where the native criterion type supports them. Shared lists use NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS; list members must match the enabled parent list type. Criterion identity, parent and negative flag cannot be changed through an update mask: remove and recreate instead. Shared-set updates change name; shared criteria and campaign/list links support create/remove only.

Updates/removes read exact resource names and mutable configuration, including keyword bid micros. Creation reads the exact campaign/ad group/shared list and any referenced user-list/audience. Preparation and execution reuse those frozen GAQL reads. Composite criterion names must contain their native parent~criterion IDs; all customer-qualified references must belong to the selected customer. Budgets/bids retain native micros as decimal strings. Arbitrary new audiences, customer-match ingestion, all criterion variants and channel combinations are not qualified by this addition. [Google criteria](https://developers.google.com/google-ads/api/docs/targeting/criteria).

## Catalog product field proof

A native Meta single-product review observes every accepted product field, including explicit group key,
labels, exact inventory, ordered extra images and literal sale dates. Missing/malformed/different values
prevent verified success. Prices retain exact original-receipt native filter proof. Provider date/image
normalization is not guessed. Product-group identity does not prove full variant inventory or eligibility.
Earlier partial proof is retired with meta-catalog-product-fields-v2; verification and pending continuation
use original accepted receipts and keys for read-only inspection, never mutation resubmission.
[Contract and upgrade](implementation/META-CATALOG-PRODUCT-FIELDS-2026-10-04.md).
