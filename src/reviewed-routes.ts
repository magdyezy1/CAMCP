import type {CompiledRequest} from './types.js';
import {familyOf} from './reviewed-families.js';

/** Route membership only. This never substitutes for assertWriteShape, scope,
 * prerequisites, spend policies, frozen review, provider receipts or read-back.
 * Both execution and the complete action ledger use this same declaration. */
export function reviewedWriteFamily(p: CompiledRequest): string | undefined {
  const route = p.path,
    method = p.method;
  if (p.readOnly || p.specialTransport) return;
  // Every reviewed family is registered (reviewed-families.ts) except the generic entity writes of each platform below.
  const family = familyOf(p);
  if (family) return family.name;
  if (p.gateway === 'google_ads_native_action')
    return method === 'POST' &&
      /^\/v\d+\/customers\/[^/]+\/(campaigns|adGroups|adGroupAds|campaignBudgets|ads|assetGroups|assets):mutate$/.test(
        route,
      )
      ? 'google_entities'
      : undefined;
  if (p.gateway === 'meta_native_action')
    return (method === 'POST' && /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives)$/.test(route)) ||
      (['POST', 'DELETE'].includes(method) && /^meta_(campaign_id|ad_set_id|ad_id)_(update|delete)$/.test(p.action))
      ? 'meta_entities'
      : undefined;
  if (p.gateway === 'snapchat_native_action')
    return (method === 'POST' &&
      /^\/v1\/(adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|lead_generation_forms|segments)|campaigns\/[^/]+\/adsquads|adsquads\/[^/]+\/ads)$/.test(
        route,
      )) ||
      (method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|segments)$/.test(route)) ||
      (method === 'PATCH' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/[^/]+$/.test(route)) ||
      (method === 'DELETE' && /^\/v1\/(campaigns|adsquads|ads)\/[^/]+$/.test(route))
      ? 'snapchat_entities'
      : undefined;
  if (p.gateway === 'tiktok_native_action')
    return method === 'POST' && /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.test(route)
      ? 'tiktok_entities'
      : undefined;
  if (p.gateway === 'x_ads_native_action') {
    return (method === 'POST' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|targeting_criteria)$/.test(route)) ||
      (['PUT', 'DELETE'].includes(method) && /^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(route)) ||
      (method === 'DELETE' && /^\/12\/accounts\/[^/]+\/(targeting_criteria|promoted_tweets)\/[^/]+$/.test(route))
      ? 'x_entities'
      : undefined;
  }
  if (p.gateway === 'linkedin_native_action')
    return (method === 'POST' && /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(route)) ||
      (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
        /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)\/[^/]+$/.test(route))
      ? 'linkedin_entities'
      : undefined;
  if (p.gateway === 'dv360_native_action')
    return (method === 'POST' &&
      /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)$/.test(route)) ||
      (['PATCH', 'DELETE'].includes(method) &&
        /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)\/[^/]+$/.test(route))
      ? 'dv360_entities'
      : undefined;
}
