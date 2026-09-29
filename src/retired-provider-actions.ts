import {MirrorError} from './errors.js';
import type {CompiledRequest} from './types.js';

const tagManagerReplacement =
  'Use the current Google tag management interface and supported list/get workflows; no equivalent API mutation has been established.';
const lifecycleReplacement =
  'In v25 new customer acquisition is a goal: a NEW_CUSTOMER_ACQUISITION goal (google_ads_v23_goal_mutate_goals) and its campaign settings (google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs). Both are reviewed writes: create the goal with google_ads_v23_goal_mutate_goals, then link each campaign with google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs.';
/** Official withdrawal overrides a historical catalog or Discovery mapping.
 * Keep these entries discoverable; never turn them into executable contracts. */
export const retiredProviderActions: {
  gateway: string;
  action: string;
  method: string;
  path: RegExp;
  source: string;
  updated: string;
  reason?: string;
  replacement?: string;
}[] = [
  {
    gateway: 'gtm_native_action',
    action: 'COMBINE_CONTAINERS',
    method: 'POST',
    path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:combine$/,
    source: 'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/combine',
    updated: '2026-08-25',
  },
  {
    gateway: 'gtm_native_action',
    action: 'MOVE_TAG_ID',
    method: 'POST',
    path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:move_tag_id$/,
    source:
      'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/move_tag_id',
    updated: '2026-08-25',
  },
  {
    gateway: 'gtm_native_action',
    action: 'LINK_DESTINATION',
    method: 'POST',
    path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations:link$/,
    source:
      'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/link',
    updated: '2026-06-04',
  },
  {
    gateway: 'gtm_native_action',
    action: 'GET_DESTINATION',
    method: 'GET',
    path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations\/[^/:]+$/,
    source:
      'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/get',
    updated: '2026-06-04',
  },
  // Google Ads API v25 has no lifecycle goal methods, schemas or GAQL rows (pinned v25 Discovery document, revision
  // 20260923, compared with the v23 one); its Goal and CampaignGoalConfig resources gained new customer acquisition.
  ...(['customer', 'campaign'] as const).map(kind => ({
    gateway: 'google_ads_native_action',
    action: 'google_ads_v23_' + kind + '_lifecycle_goal_configure_' + kind + '_lifecycle_goals',
    method: 'POST',
    path: new RegExp(
      '^/v\\d+/customers/[^/]+/' +
        kind +
        'LifecycleGoal:configure' +
        (kind === 'customer' ? 'Customer' : 'Campaign') +
        'LifecycleGoals$',
    ),
    source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
    updated: '2026-09-23',
    reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
    replacement: lifecycleReplacement,
  })),
  // LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current pages (li-lms-2026-05) for these
  // resources document only the versioned /rest routes, and the Content APIs replace adCreativesV2 (read 2026-09-29).
  // Other /v2 routes stay: geo is still documented under /v2, and me, people, endorsement, shares, ugcPosts and
  // adLiftTestBenchmark were not confirmed withdrawn (F-58).
  ...(
    [
      [
        'ad_campaigns_v2_post',
        'POST',
        '^/v2/adCampaignsV2$',
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      ],
      [
        'ad_campaigns_v2_campaign_id_post',
        'POST',
        '^/v2/adCampaignsV2/[^/]+$',
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      ],
      ['ad_creatives_v2_post', 'POST', '^/v2/adCreativesV2$', 'linkedin_rest_ad_accounts_ad_account_id_creatives_post'],
      ['dmp_segments_post', 'POST', '^/v2/dmpSegments$', 'linkedin_rest_dmp_segments_post'],
      [
        'dmp_segments_segment_id_companies_post',
        'POST',
        '^/v2/dmpSegments/[^/]+/companies$',
        'linkedin_rest_dmp_segments_segment_id_companies_post',
      ],
      [
        'dmp_segments_segment_id_users_post',
        'POST',
        '^/v2/dmpSegments/[^/]+/users$',
        'linkedin_rest_dmp_segments_segment_id_users_post',
      ],
      [
        'dmp_segments_segment_id_destinations_destination_id_get',
        'GET',
        '^/v2/dmpSegments/[^/]+/destinations/[^/]+$',
        'linkedin_rest_dmp_segments_segment_id_destinations_destination_id_get',
      ],
      [
        'dmp_segments_dmp_segment_id_list_uploads_list_id_delete',
        'DELETE',
        '^/v2/dmpSegments/[^/]+/listUploads/[^/]+$',
        'linkedin_rest_dmp_segments_dmp_segment_id_list_uploads_list_id_get (read); AMCP’s catalog has no versioned list upload deletion',
      ],
      [
        'organizational_entity_acls_get',
        'GET',
        '^/v2/organizationalEntityAcls$',
        'linkedin_rest_organization_acls_get',
      ],
      [
        'organizational_entity_acls_post',
        'POST',
        '^/v2/organizationalEntityAcls$',
        'linkedin_rest_organization_acls_organization_organization_urn_role_direct_content_poster_role_assignee_person_urn_put (not yet a reviewed write in AMCP)',
      ],
    ] as const
  ).map(([action, method, path, replacement]) => ({
    gateway: 'linkedin_native_action',
    action: 'linkedin_v2_' + action,
    method,
    path: new RegExp(path),
    source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations?view=li-lms-2026-05',
    updated: '2024-12-16',
    reason:
      'LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current documentation has only the versioned /rest route.',
    replacement: 'Use ' + replacement + '.',
  })),
];
/** The catalog actions whose Google Ads method v25 removed; tools/fetch-vendor-specs.mjs keeps the same list. */
export const retiredGoogleAdsActions = retiredProviderActions
  .filter(r => r.gateway === 'google_ads_native_action')
  .map(r => r.action);
export const retiredProviderAction = (p: CompiledRequest) =>
  retiredProviderActions.find(r => r.gateway === p.gateway && r.method === p.method && r.path.test(p.path));
/** Legacy names that do not correspond to an operation of the current provider version: captured aliases that never
 * did, and aliases whose operation a newer version removed. Match the alias, not its shared route. */
export const unsupportedProviderAliases = [
  {
    gateway: 'google_ads_native_action',
    action: 'UPDATE_CUSTOMIZER_ATTRIBUTE',
    version: 'v25',
    source:
      'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/customizer_attribute_service.proto (sha256 7eb3650bd6eee98d0ec2d60b785e2934cf91c8dc07ae75a42447bac779c1b2aa)',
    checked_at: '2026-09-28',
    reason:
      'The v25 CustomizerAttributeOperation oneof contains create and remove only. An update_mask field or broad service comment does not define an update operation.',
    replacement:
      'Create a new attribute with the correct name/type. Separately review replacement customizer associations and affected ads before considering removal of the old attribute. AMCP does not automatically migrate or delete it.',
  },
  ...(['CUSTOMER', 'CAMPAIGN'] as const).flatMap(kind => [
    {
      gateway: 'google_ads_native_action',
      action: 'CONFIGURE_' + kind + '_LIFECYCLE_GOAL',
      version: 'v25',
      source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
      checked_at: '2026-09-28',
      reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
      replacement: lifecycleReplacement,
    },
    {
      gateway: 'google_ads_native_action',
      action: 'LIST_' + kind + '_LIFECYCLE_GOALS',
      version: 'v25',
      source: 'https://googleads.googleapis.com/$discovery/rest?version=v25 (GoogleAdsRow has no lifecycle goal rows)',
      checked_at: '2026-09-28',
      reason: 'Google Ads API v25 no longer has lifecycle goals to read.',
      replacement:
        'Read goals and their campaign settings with RUN_GAQL_QUERY: FROM goal, and FROM campaign_goal_config.',
    },
  ]),
  {
    gateway: 'google_ads_native_action',
    action: 'SET_CAMPAIGN_BRAND_SAFETY',
    version: 'v25',
    source:
      'https://googleads.googleapis.com/$discovery/rest?version=v25 (Campaign has no videoBrandSafetySuitability)',
    checked_at: '2026-09-28',
    reason:
      'Google Ads API v25 removed the campaign-level video brand safety setting; only the account-level one remains.',
    replacement:
      "Set the account's videoBrandSafetySuitability with a reviewed customer change (google_ads_v23_customer_mutate_customer), or exclude content labels per campaign (SET_CAMPAIGN_CONTENT_LABEL_EXCLUSIONS).",
  },
];
export const unsupportedProviderAlias = (gateway: string, action: string) =>
  unsupportedProviderAliases.find(r => r.gateway === gateway && r.action === action);
export function assertProviderAliasAvailable(gateway: string, action: string): void {
  const unavailable = unsupportedProviderAlias(gateway, action);
  if (unavailable) throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED', unavailable.reason, unavailable);
}
export function assertProviderActionAvailable(p: CompiledRequest): void {
  assertProviderAliasAvailable(p.gateway, p.action);
  const retired = retiredProviderAction(p);
  if (retired)
    throw new MirrorError(
      'PROVIDER_ACTION_UNSUPPORTED',
      retired.reason ??
        'Google documents this method as no longer supported. A historical mapping cannot make it executable.',
      {
        action: retired.action,
        source: retired.source,
        documentation_updated: retired.updated,
        checked_at: retired.gateway === 'google_ads_native_action' ? '2026-09-28' : '2026-09-19',
        replacement: retired.replacement ?? tagManagerReplacement,
      },
    );
}
