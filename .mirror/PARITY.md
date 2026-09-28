# Implementation and verification status

Production readiness: **not achieved**. Reviewed campaign-management writes are available when enabled; they remain disabled by default.

| Gateway | Catalog records | Declared HTTP routes | Additional vendor routes | Full platform verified |
|---|---:|---:|---:|---|
| adjust_native_action | 6 | 0 | 0 | No |
| amazon_native_action | 0 (denominator unknown) | 0 | 0 | No |
| amcp_native_action | 59 | 0 | 0 | No |
| amcp_platform_workspace | 3 | 0 | 0 | No |
| apple_ads_native_action | 0 (denominator unknown) | 0 | 41 | No |
| commerce_native_action | 2 | 0 | 0 | No |
| criteo_native_action | 9 | 0 | 107 | No |
| dv360_native_action | 173 | 0 | 173 | No |
| ga4_native_action | 10 | 0 | 18 | No |
| google_ads_native_action | 456 | 171 | 0 | No |
| google_business_native_action | 10 | 0 | 51 | No |
| google_search_console_native_action | 3 | 0 | 10 | No |
| gtm_native_action | 3 | 0 | 106 | No |
| linkedin_native_action | 287 | 287 | 0 | No |
| meta_native_action | 591 | 591 | 0 | No |
| reddit_native_action | 7 | 0 | 49 | No |
| snapchat_native_action | 412 | 412 | 0 | No |
| tiktok_native_action | 561 | 561 | 0 | No |
| x_ads_native_action | 186 | 186 | 0 | No |

Google has 285 independently specified legacy adapters. They preserve native responses; exact AMCP legacy behavior is unverified. One legacy update (UPDATE_CUSTOMIZER_ATTRIBUTE) has no supported vendor update operation and is rejected.

## Independent extensions

Microsoft Advertising: 28 actions, including 12 reviewed Search mutation routes. Live qualification remains incomplete; these actions are not part of the captured AMCP denominator.

Campaign guidance: 13 MCP resources and the amcp_build_campaign prompt. amcp_write inspect checks local execution contracts without network calls.

## Unfinished workflows

- amcp_native_action/connect_google_reporting
- amcp_native_action/cross_platform_transfer
- amcp_native_action/disconnect_google_reporting
- amcp_native_action/download_creative_asset
- amcp_native_action/fetch_meta_existing_posts
- amcp_native_action/generate_ad_content
- amcp_native_action/generate_creative_design
- amcp_native_action/get_creative_payload
- amcp_native_action/openai_ads_ops
- amcp_native_action/platform_media_upload
- amcp_native_action/suggest_targeting
- ga4_native_action/ga4_connection_ops
- ga4_native_action/ga4_sync_properties
- gtm_native_action/gtm_action_job_status
- gtm_native_action/gtm_audit_ops
- google_business_native_action/gmb_connection_ops
- google_business_native_action/gmb_qanda_ops
- google_search_console_native_action/gsc_connection_ops
- adjust_native_action/adjust_ad_spend
- adjust_native_action/adjust_app_automation
- adjust_native_action/adjust_campaign_api
- adjust_native_action/adjust_deeplinks
- adjust_native_action/adjust_list_assets
- adjust_native_action/adjust_reporting
- commerce_native_action/woocommerce_list_stores
- commerce_native_action/woocommerce_store_ops

## Limits

- Routing and local contract tests do not prove vendor behavior.
- This artifact contains no live account samples. Provider access, approvals, quotas and mutation qualification require current account-specific evidence.
- Special media transports, several provider workflows and exact legacy response parity remain incomplete.
- Writes are opt-in through amcp_write with operator role, account grants, expiring server-read reviews, explicit confirmation and durable idempotency. Campaign-management contracts have synthetic tests; no live mutation qualification is claimed.
- No claim of total API operation coverage: delegated operation schemas may contain further action enums, and Amazon/Apple catalog denominators are unknown.

Detailed mapping and known vendor route gaps: REPORTS/implementation-status.json.
