import {keywordPlanObserved} from './google-keyword-plan-writes.js';
import {MirrorError} from './errors.js';
import {microsoftContracts} from './microsoft-native.js';
import {gtmSafeConfiguration} from './gtm-workflow-writes.js';
import {assetSetCanonical} from './google-asset-set-writes.js';
import {googleSegmentResource, googleSegmentCanonical} from './google-custom-segments.js';
import {googleUserListCanonical} from './google-user-lists.js';
import {googleValueRuleCanonical} from './google-value-rules.js';
import {snapSegmentState} from './snapchat-segments.js';
import {tiktokImageInfoPath, tiktokImageState} from './tiktok-identities.js';
import {tiktokAudienceGetPath, tiktokAudienceState} from './tiktok-lookalikes.js';
import {
  tiktokPixelListPath,
  tiktokConversionListPath,
  tiktokConversionGetPath,
  tiktokPixelState,
  tiktokConversionListState,
} from './tiktok-custom-conversions.js';
import {tiktokConversionEligibility} from './tiktok-adgroup-conversions.js';
import {tiktokPortfolioGetPath, tiktokCtaPortfolioState} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdState} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdgroupCampaignState} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokInstantFormState} from './tiktok-instant-forms.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {familyOfRead} from './reviewed-families.js';
import {normalizeReviewState} from './review-state-core.js';

// The pure projection helpers live in the leaf src/review-state-core.ts, which family modules import (ARC-04 stage B).
export {normalizeReviewState, reviewStateHash, changedStateFields} from './review-state-core.js';

/** Allowlist configuration-bearing response containers, not response metadata.
 * Only call after raw success, completeness and exact-target validation. Preserve
 * the native container shape for spending/ownership checks and field diagnostics.
 * Flat resource responses have no separate envelope: keep unknown configuration.
 * This is idempotent so saved, unsubmitted reviews can use the same projection. */
/**
 * A Snapchat ad account as a review keeps it (Snapchat S9): what a write under it depends on, not its billing centre,
 * funding sources, cells or invoicing arrangements. The state hash covers these fields, so a change of currency or
 * status still invalidates a review.
 */
export const snapAccountFields = ['id', 'name', 'status', 'currency', 'timezone', 'organization_id', 'type'];
function snapAccountState(account: unknown): unknown {
  if (!account || typeof account !== 'object' || Array.isArray(account)) return account;
  return Object.fromEntries(
    snapAccountFields.filter(k => Object.hasOwn(account, k)).map(k => [k, (account as JsonObject)[k]]),
  );
}
export function normalizeSnapshot(read: CompiledRequest, data: unknown): unknown {
  if (!data || Array.isArray(data) || typeof data !== 'object') return normalizeReviewState(data);
  const d = data as JsonObject;
  const family = familyOfRead(read);
  if (!family) return normalizeReviewState(gatewayStateValue(read, d));
  return normalizeReviewState(
    family.snapshotState ? family.snapshotState(read, d, () => gatewayStateValue(read, d)) : d,
  );
}
/** The state a review keeps from a read no family projects: the gateway's configuration fields, before normalization. */
function gatewayStateValue(read: CompiledRequest, d: JsonObject): unknown {
  if (read.gateway === 'gtm_native_action') return gtmSafeConfiguration(d);
  if (read.gateway === 'tiktok_native_action' && read.path === tiktokPixelListPath && Array.isArray(d.data?.pixels))
    return {data: tiktokPixelState(d)};
  if (read.gateway === 'tiktok_native_action') {
    const state =
      tiktokSmartPlusAdState(read, d) ??
      tiktokSmartPlusAdgroupCampaignState(read, d) ??
      tiktokInstantFormState(read, d);
    if (state) return state;
  }
  if (
    read.gateway === 'tiktok_native_action' &&
    read.path === tiktokPortfolioGetPath &&
    d.data &&
    typeof d.data === 'object' &&
    !Array.isArray(d.data)
  )
    return {data: tiktokCtaPortfolioState(read, d.data)};
  if (
    read.gateway === 'tiktok_native_action' &&
    read.path === tiktokConversionGetPath &&
    d.data &&
    typeof d.data === 'object' &&
    !Array.isArray(d.data)
  )
    return {data: tiktokConversionEligibility(d.data)};
  if (read.gateway === 'tiktok_native_action' && Array.isArray(d.data?.list))
    return {
      data:
        read.path === tiktokImageInfoPath
          ? tiktokImageState(d)
          : read.path === tiktokAudienceGetPath
            ? tiktokAudienceState(d)
            : read.path === tiktokConversionListPath
              ? tiktokConversionListState(d)
              : {list: d.data.list},
    };
  if (['x_ads_native_action', 'reddit_native_action'].includes(read.gateway) && Object.hasOwn(d, 'data'))
    return {data: d.data};
  if (read.gateway === 'apple_ads_native_action' && Object.hasOwn(d, 'result')) {
    // SDK output-only processing/approval observations are not advertiser edits.
    const observational = new Set([
      'systemStatus',
      'systemStatusReasons',
      'systemStatusLimitingReasons',
      'displayStatus',
      'eligibility',
    ]);
    const result = Object.fromEntries(Object.entries(d.result ?? {}).filter(([key]) => !observational.has(key)));
    if (Array.isArray(result.adAccountIds))
      result.adAccountIds = [...result.adAccountIds].sort((a, b) => String(a).localeCompare(String(b), 'en'));
    return {result};
  }
  if (read.gateway === 'microsoft_ads_native_action') {
    const field = microsoftContracts.get(read.action)?.result;
    if (field && Object.hasOwn(d, field)) return {[field]: d[field]};
  }
  if (read.gateway === 'snapchat_native_action') {
    const kind = read.path.split('/').at(-2)!,
      singular = kind === 'adsquads' ? 'adsquad' : kind === 'media' ? 'media' : kind.slice(0, -1);
    if (Array.isArray(d[kind]))
      return {
        [kind]: d[kind].map((row: JsonObject) =>
          Object.hasOwn(row, singular)
            ? {
                [singular]:
                  kind === 'segments'
                    ? snapSegmentState(row[singular])
                    : kind === 'adaccounts'
                      ? snapAccountState(row[singular])
                      : row[singular],
              }
            : row,
        ),
      };
  }
  if (
    read.gateway === 'google_search_console_native_action' &&
    read.path.includes('/sitemaps/') &&
    d.amcp_absent !== true
  ) {
    // Crawl/processing observations are not a sitemap submission change. Keep
    // lastSubmitted, type, path, index identity and unknown configuration fields.
    const processing = new Set(['lastDownloaded', 'isPending', 'warnings', 'errors', 'contents']);
    return Object.fromEntries(Object.entries(d).filter(([key]) => !processing.has(key)));
  }
  if (read.gateway !== 'google_ads_native_action') return d;
  const query = String((read.body as JsonObject)?.query ?? ''),
    resource = /\bFROM\s+([a-z_]+)/i.exec(query)?.[1];
  const rows = d.results ?? (read.googleState?.allowMissing ? [] : undefined);
  if (!Array.isArray(rows)) return d;
  // Even customer reads without resource_name must exclude query cost, field
  // masks, summary metrics and future envelope metadata. Never ignore a nonempty
  // nextPageToken here instead of rejecting the incomplete raw response first.
  if (!resource || !query.includes(resource + '.resource_name')) return {results: rows};
  const key = resource.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()),
    seen = new Set<string>();
  const items = rows.map((row: JsonObject) => {
    const value = row[resource] ?? row[key],
      id = value?.resourceName ?? value?.resource_name;
    if (typeof id !== 'string' || !id || seen.has(id))
      throw new MirrorError(
        'STATE_RESOURCE_INVALID',
        'The state response contains missing or duplicate resource identities.',
        {},
        502,
      );
    seen.add(id);
    return {id, row};
  });
  const expected = [...new Set([...query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]!))];
  if (
    expected.length &&
    (read.googleState?.allowMissing
      ? items.some(item => !expected.includes(item.id))
      : expected.length !== seen.size || expected.some(id => !seen.has(id)))
  )
    throw new MirrorError(
      'STATE_RESOURCE_MISMATCH',
      'The state response does not cover exactly the requested resources.',
      {},
      409,
    );
  items.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const state = {
    results: items.map(item =>
      resource.startsWith('keyword_plan')
        ? {...item.row, [key]: keywordPlanObserved(resource, item.row[key])}
        : googleSegmentResource(resource)
          ? {
              ...item.row,
              [item.row[resource] ? resource : key]: googleSegmentCanonical(
                resource,
                item.row[resource] ?? item.row[key],
                true,
              ),
            }
          : resource === 'user_list'
            ? {
                ...item.row,
                [item.row[resource] ? resource : key]: googleUserListCanonical(item.row[resource] ?? item.row[key]),
              }
            : resource === 'conversion_value_rule'
              ? {
                  ...item.row,
                  [item.row[resource] ? resource : key]: googleValueRuleCanonical(
                    resource,
                    item.row[resource] ?? item.row[key],
                  ),
                }
              : item.row,
    ),
  };
  return [
    'asset',
    'asset_set',
    'asset_set_asset',
    'campaign_asset_set',
    'ad_group_asset_set',
    'customer_asset_set',
  ].includes(resource)
    ? assetSetCanonical(state)
    : state;
}
