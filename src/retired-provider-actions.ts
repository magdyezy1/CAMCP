import {MirrorError} from './errors.js';
import type {CompiledRequest} from './types.js';

const tagManagerReplacement =
  'Use the current Google tag management interface and supported list/get workflows; no equivalent API mutation has been established.';
const lifecycleReplacement =
  'In v25 new customer acquisition is a goal: a NEW_CUSTOMER_ACQUISITION goal (google_ads_v23_goal_mutate_goals) and its campaign settings (google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs). AMCP has not reviewed those goal writes yet; until it does, set the goal in the Google Ads interface.';
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
];
/** The catalog actions whose Google Ads method v25 removed; tools/fetch-vendor-specs.mjs keeps the same list. */
export const retiredGoogleAdsActions = retiredProviderActions
  .filter(r => r.gateway === 'google_ads_native_action')
  .map(r => r.action);
export const retiredProviderAction = (p: CompiledRequest) =>
  retiredProviderActions.find(r => r.gateway === p.gateway && r.method === p.method && r.path.test(p.path));
/**
 * Routes a catalog captured from traffic whose request body no source AMCP has pinned or can reach documents
 * (Snapchat S4). Calls with a guessed body failed live (HTTP 400 E1001), so AMCP refuses them before any request
 * rather than forwarding a guess, and names the documented read that works. Not a withdrawal: once Snapchat's body is
 * pinned from its documentation, an entry here gives way to a reviewed contract.
 */
export const undocumentedProviderRoutes = (['campaign', 'adsquad', 'ad', 'creative', 'media'] as const).map(entity => {
  const plural = entity === 'media' ? 'media' : entity + 's';
  return {
    gateway: 'snapchat_native_action',
    method: 'POST',
    path: new RegExp('^/v1/adaccounts/[^/]+/get_' + plural + '_by_ids$'),
    checked_at: '2026-09-29',
    source:
      'No pinned Snapchat Marketing API document gives this body; developers.snap.com was unreachable from the build environment. Owner live tests 2026-09-25 and 2026-09-29: HTTP 400 E1001 "Request body can not be correctly processed".',
    reason:
      'Snapchat’s request body for get_' +
      plural +
      '_by_ids is not documented in any source AMCP has, and guessed bodies failed with HTTP 400 E1001, so AMCP does not send one. Despite the "_get" in its name it is a POST.',
    replacement:
      'Read them from the account list: snapchat_' +
      entity +
      '_list with result_ids: [the IDs] (and result_fields to keep it small) returns only those, and the IDs it returns are owned for five minutes.',
  };
});
export const undocumentedProviderRoute = (p: CompiledRequest) =>
  undocumentedProviderRoutes.find(r => r.gateway === p.gateway && r.method === p.method && r.path.test(p.path));
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
  const undocumented = undocumentedProviderRoute(p);
  if (undocumented)
    throw new MirrorError('PROVIDER_ACTION_UNSUPPORTED', undocumented.reason, {
      action: p.action,
      source: undocumented.source,
      checked_at: undocumented.checked_at,
      replacement: undocumented.replacement,
    });
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
