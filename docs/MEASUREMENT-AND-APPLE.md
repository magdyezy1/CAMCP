# GA4, Google tag, Search Console and Apple Ads

The Connections page includes all four providers. Each login has encrypted credentials and explicit resource grants. Connecting discovers resources; select resources and save before an MCP reader can use them. These integrations support reads, native previews and the reviewed mutations below when MIRROR_ALLOW_WRITES=true. Each resource also needs an administrator write grant and an operator connector.

## Google setup

Enable the relevant APIs in your Google Cloud project and register the following web OAuth redirects. Set dedicated client ID/secret variables, or leave both fields unset to reuse `AMCP_GOOGLE_CLIENT_ID` and `AMCP_GOOGLE_CLIENT_SECRET`. Each provider obtains its own offline authorization and rotating refresh credentials. Google Ads' developer token is not required for these products.

| Provider | Enable in Google Cloud | Callback | Dedicated variables | Grant boundary |
| --- | --- | --- | --- | --- |
| GA4 | Google Analytics Admin API and Data API | `https://amcp.shop/api/auth/ga4/callback` | `AMCP_GA4_CLIENT_ID`, `AMCP_GA4_CLIENT_SECRET` | Numeric property IDs |
| Google Tag Manager / Google tag | Tag Manager API | `https://amcp.shop/api/auth/gtm/callback` | `AMCP_GTM_CLIENT_ID`, `AMCP_GTM_CLIENT_SECRET` | Tag Manager account IDs |
| Search Console | Search Console API | `https://amcp.shop/api/auth/gsc/callback` | `AMCP_GSC_CLIENT_ID`, `AMCP_GSC_CLIENT_SECRET` | Exact URL-prefix or `sc-domain:` site identifiers |

Read-only deployments request `analytics.readonly`, `tagmanager.readonly`, and `webmasters.readonly`, using their full Google OAuth URLs. With writes enabled, Tag Manager additionally requests `tagmanager.edit.containers`, `tagmanager.delete.containers`, `tagmanager.edit.containerversions`, and `tagmanager.publish`; Search Console additionally requests `webmasters`. GA4 export/task creation uses the existing Analytics scope. Reconnect existing Tag Manager and Search Console logins to obtain the added permissions; environment changes cannot upgrade existing credentials. Provider-side access and consent-screen restrictions still apply.

GA4 lists accessible property summaries with bounded pagination and can synchronize data streams for selected properties. Tag Manager discovery requests `includeGoogleTags=true`, so Google tag accounts are included, then lists their containers. This connects to your tag configuration; it does not inject tracking code into the AMCP website. Search Console filters out unverified memberships and can list sitemaps for selected sites. Related inventory does not grant access to additional resources. See [GA4 discovery](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list), [Tag Manager accounts including Google tags](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts/list), and [Search Console sites](https://developers.google.com/webmaster-tools/v1/sites/list).

Examples are MCP tool arguments, with illustrative IDs to replace using selected resources:

```json
{"operation":"ga4_run_report","arguments":{"property":"123","request":{"dateRanges":[{"startDate":"2026-09-01","endDate":"2026-09-02"}],"metrics":[{"name":"sessions"}]}}}
```

Call `ga4_native_action` for that example. For `gtm_native_action`:

```json
{"operation":"gtm_ops","arguments":{"action":"LIST_CONTAINERS","account_id":"44"}}
```

For `google_search_console_native_action`:

```json
{"operation":"gsc_analytics_ops","arguments":{"action":"QUERY_SEARCH_ANALYTICS","site_url":"sc-domain:example.com","payload":{"startDate":"2026-09-01","endDate":"2026-09-02"}}}}
```

Use `amcp_tool_help` with the gateway and operation for additional native schemas. Not every captured delegated workflow is implemented; an unsupported workflow reports an error instead of fabricated success.

## Apple Ads setup

Apple Ads API authentication uses a server-side client-credentials grant, with no browser redirect. Upload your matching P-256 public key in Apple's API settings and put these values in your hosting secret store:

- `AMCP_APPLE_CLIENT_ID`
- `AMCP_APPLE_TEAM_ID`
- `AMCP_APPLE_KEY_ID`
- `AMCP_APPLE_PRIVATE_KEY`: private PEM, with real newlines or literal `\n` escapes.

AMCP signs short-lived ES256 client-secret JWTs and renews access tokens before expiry. Alternatively, use a pre-generated `AMCP_APPLE_CLIENT_SECRET` with the client ID; you must replace that JWT yourself before it expires. Do not send private keys through chat or commit them.

Click Connect, then select an Apple **ad account ID** from the returned ACL inventory. Platform API v1 uses `X-AP-Context: adAccountId=<id>;`. The v1 ad account ID is distinct from a legacy organization ID.

The independent v1 adapter supports query/get operations for campaigns, ad groups, ads, creatives, keywords, negative keywords and shared budgets; ad-account get; and App Store campaign/ad-group/ad/keyword/search-term reports. Campaign create/update/delete support local previews and reviewed live execution through amcp_write. New campaigns must explicitly use status PAUSED; activation or budget changes require spend_change_confirmed=true. These 23 routes are documented AMCP extensions, separate from the unenumerated source catalog. Legacy v5 routing and other Apple mutation routes remain unavailable. Source: [Apple's official Platform API SDK](https://github.com/apple/apple-ads-platform-api-node).

Planning reads (PRV-07) mirror seven further methods of the same pinned SDK revision
(`generated/apple-platform-v1-models.json`), each under the selected ad account's `X-AP-Context`:
`apple_ads_v1_apps_search` (GET `search/apps` with only `query`, `returnOwnedApps`, `limit` 1–1000 and `offset`),
`apple_ads_v1_app_get` (an app by adamId), and the POST queries `apple_ads_v1_app_eligibilities_query`,
`apple_ads_v1_product_pages_query`, `apple_ads_v1_impression_share_query`, `apple_ads_v1_search_term_popularity_query`
and `apple_ads_v1_keyword_suggestions_query` (an object payload of at most 64 KiB; the SDK pins no request model for
them, so Apple's own validation decides the fields). A returned resource of another ad account is refused. Change
history is not added: its records name the people who made changes, and the pinned SDK has no model to project them out.

Call `amcp_tool_help` with `{"gateway":"apple_ads_native_action"}` to enumerate these local routes; pass an action name as `operation` for its route description. Example arguments for `apple_ads_native_action`:

```json
{"action":"apple_ads_v1_campaigns_query","account_id":"77","payload":{"pagination":{"offset":0,"pageSize":100}},"aggregate_pages":true,"max_pages":25}
```

```json
{"action":"apple_ads_v1_reports_apps_campaigns","account_id":"77","payload":{"timeRange":{"start":"2026-09-01","end":"2026-09-02","granularity":"DAILY","timeZone":"ORTZ"}}}
```

Change dates to the provider-supported reporting window. Native metric/filter names and access restrictions apply. Pagination retains account scope and reports truncation when the configured page cap is reached; malformed or inconsistent responses fail explicitly.

## Enable reviewed live mutations

Set `MIRROR_ALLOW_WRITES=true`, reconnect Tag Manager and Search Console to approve the additional permissions, select the intended resources in Connections, and save their separate write grants. Use an operator connector (or an OAuth client authorized for `mcp:read mcp:write`). Apple API users also need the appropriate native account role. AMCP checks the stored provider scopes before preparing a mutation and again before execution. It does not silently broaden old grants.

All four providers use `amcp_write` prepare/execute as described in [write operations](WRITE-OPERATIONS.md). Delegated Google gateways retain their nested operation/arguments shape inside the review tool:

```json
{
  "action": "prepare",
  "gateway": "gtm_native_action",
  "arguments": {
    "operation": "gtm_ops",
    "arguments": {
      "action": "UPDATE_TAG",
      "account_id": "44",
      "path": "accounts/44/containers/55/workspaces/66/tags/7",
      "payload": {"name": "Reviewed tag name", "type": "html", "parameter": [{"type": "template", "key": "html", "value": "<!-- example -->"}]}
    }
  }
}
```

Replace the example IDs and supply the complete intended native update. Preparation reads the real target, freezes the request for five minutes and includes its native fingerprint when the endpoint supports it. Execution requires the exact review ID, idempotency key and `confirmed:true`. A native dry run does not authorize execution. Tag Manager publishing reviews both the requested version and the current live version; creating a version also snapshots workspace changes. New sitemaps and a first live container version can be absent, but their parent access must already be verified.

GA4 currently supports creation of audience exports and report tasks, not Analytics Admin configuration changes. Tag Manager supports 40 explicitly qualified configuration/version actions, including Google tag configurations and publishing; user permission management, cross-container moves/combinations, bulk, revert, sync and other specialized workflows remain outside these contracts. Search Console supports the four native site/sitemap mutations on selected sites. Apple supports the three v1 campaign mutations. Unsupported actions fail before mutation egress.

Vendor references: [GA4 audience exports](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties.audienceExports/create), [report tasks](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1alpha/properties.reportTasks/create), [Tag Manager publishing](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.versions/publish), [version creation](https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/create_version), [sitemap submission](https://developers.google.com/webmaster-tools/v1/sitemaps/submit), and [sitemap deletion](https://developers.google.com/webmaster-tools/v1/sitemaps/delete).

## What has been verified

Synthetic integration tests cover website connection, CSRF, empty initial grants, resource selection, Google refresh rotation, Apple JWT signatures and renewal, paginated inventory, representative authenticated MCP reads, native response checks, and cross-account rejection. No live credentials or advertising mutations are used. Complete production acceptance still requires your provider app approvals/credentials, deployment with persistent storage, and real read-only checks on selected resources.
