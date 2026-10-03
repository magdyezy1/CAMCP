/** State validation stage: what a snapshot read must show before a write is prepared or executed. */
import {tiktokImageInfoPath} from './tiktok-identities.js';
import {tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {validateTiktokConversionState} from './tiktok-custom-conversions.js';
import {validateTiktokSavedAudienceState} from './tiktok-saved-audiences.js';
import {validateTiktokSmartPlusState} from './tiktok-smart-plus-status.js';
import {validateTiktokCtaPortfolioState} from './tiktok-cta-portfolios.js';
import {validateTiktokSmartPlusAdState} from './tiktok-smart-plus-ads.js';
import {validateTiktokSmartPlusAdgroupCampaignState} from './tiktok-smart-plus-adgroup-updates.js';
import {validateTiktokInstantFormState} from './tiktok-instant-forms.js';
import {type TransportResult} from './transport.js';
import {normalizeAccount} from './scope.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {nextPage} from './pagination.js';
import {validateRedditState} from './reddit-writes.js';
import {microsoftGateway, validateMicrosoftResponse} from './microsoft-native.js';
import {measurementWriteGateways, validateMeasurementState} from './measurement-writes.js';
import {familyOfRead} from './reviewed-families.js';
import {object, fail} from './write-common.js';
import {writeOutcome} from './write-outcome.js';

export function validateState(read: CompiledRequest, result: TransportResult): void {
  const family = familyOfRead(read);
  if (family?.validateState)
    family.validateState(read, result, identity => validateGatewayState(read, result, identity));
  else validateGatewayState(read, result);
}

/**
 * The checks a state read gets from its gateway: a successful, complete provider response that shows exactly the read's
 * target. `identity`, when given, replaces the gateway's target check for a family whose reads return another shape.
 */
function validateGatewayState(
  read: CompiledRequest,
  result: TransportResult,
  identity?: (read: CompiledRequest, result: TransportResult) => void,
): void {
  if (read.gateway === microsoftGateway) validateMicrosoftResponse(read, result, true);
  if (result.status === 404 && measurementWriteGateways.has(read.gateway)) {
    validateMeasurementState(read, result);
    return;
  }
  if (read.gateway === 'gtm_native_action' && read.path.endsWith('/status') && result.status === 200) {
    validateMeasurementState(read, result);
    return;
  }
  const data = object(result.data),
    id = normalizeAccount(read.gateway, read.accountId!);
  // Search Console's sitemap `errors` is a documented content-error count, not
  // a failed API envelope. Real error objects and malformed counts still fail.
  const sitemap = read.gateway === 'google_search_console_native_action' && read.path.includes('/sitemaps/');
  const sitemapCount =
    sitemap &&
    ((typeof data.errors === 'number' && Number.isSafeInteger(data.errors) && data.errors >= 0) ||
      (typeof data.errors === 'string' && /^\d+$/.test(data.errors)));
  if (sitemap && Object.hasOwn(data, 'errors') && !sitemapCount)
    fail('STATE_READ_FAILED', 'Search Console sitemap content-error counts must be nonnegative integers.');
  // ProtoJSON omits an empty repeated `results` field. Only a server-derived
  // optional association query can interpret that as absence, after raw errors
  // and continuation fields have still been checked.
  const optionalGoogle = read.gateway === 'google_ads_native_action' && read.googleState?.allowMissing === true;
  const emptyGoogle =
    optionalGoogle &&
    result.status === 200 &&
    result.data !== null &&
    typeof result.data === 'object' &&
    !Array.isArray(result.data) &&
    data.results === undefined &&
    (Object.keys(data).length === 0 ||
      typeof data.fieldMask === 'string' ||
      typeof data.queryResourceConsumption === 'string');
  // A failed GA4 export is a readable job resource, not a failed HTTP read.
  // Preserve its native errorMessage for verification while still rejecting
  // API error envelopes, malformed errors and incomplete responses normally.
  const ga4Job =
    read.gateway === 'ga4_native_action' &&
    /^\/v1(?:alpha|beta)\/properties\/\d+\/(?:audienceExports|reportTasks)\/[^/]+$/.test(read.path);
  let jobData = data;
  const withoutJobError = (value: JsonObject) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'errorMessage'));
  if (ga4Job && data.state === 'FAILED' && typeof data.errorMessage === 'string') jobData = withoutJobError(jobData);
  if (ga4Job && data.reportMetadata?.state === 'FAILED' && typeof data.reportMetadata.errorMessage === 'string')
    jobData = {...jobData, reportMetadata: withoutJobError(data.reportMetadata)};
  const statusResult = sitemapCount
    ? {...result, data: {...data, errors: 0}}
    : emptyGoogle
      ? {...result, data: {...data, results: []}}
      : jobData !== data
        ? {...result, data: jobData}
        : result;
  if (read.gateway !== microsoftGateway && writeOutcome(statusResult).success !== true)
    fail('STATE_READ_FAILED', 'Failed or partial provider responses cannot verify before-state.');
  // Published Instant Forms cannot be read by ID; every page is read through follow-up reads
  // (src/tiktok-instant-forms.ts), so their page information is expected rather than incomplete.
  if (validateTiktokInstantFormState(read, data)) return;
  // Reuse provider pagination contracts (including Reddit pagination.next_url)
  // before envelope projection; discarding cursors is never proof of completeness.
  if (nextPage(read, data)) fail('INCOMPLETE_STATE', 'State read was paginated; narrow the mutation.');
  const inspect = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(inspect);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const r = object(v);
    if (
      r.has_more === true ||
      r.hasMore === true ||
      r.nextPageToken ||
      r.next_page_token ||
      (r.next_cursor && r.next_cursor !== '0') ||
      r.next_link ||
      r.paging?.next ||
      r.page_info?.total_page > 1 ||
      (Array.isArray(r.links) && r.links.some((l: JsonObject) => l.rel === 'next'))
    )
      fail('INCOMPLETE_STATE', 'State read was paginated; narrow the mutation.');
    Object.values(r).forEach(inspect);
  };
  inspect(data);
  if (read.gateway === microsoftGateway) return;
  if (measurementWriteGateways.has(read.gateway)) {
    validateMeasurementState(read, result);
    return;
  }
  if (identity) {
    identity(read, result);
    return;
  }
  if (read.gateway === 'reddit_native_action') {
    validateRedditState(read, result);
    return;
  }
  const sameIds = (actual: unknown[], expected: unknown[]) => {
    const clean = (ids: unknown[]) => ids.map(x => String(x)).sort();
    if (actual.length !== expected.length || stable(clean(actual)) !== stable(clean(expected)))
      fail('STATE_TARGET_MISMATCH', 'State read did not return every exact requested target.');
  };
  if (read.gateway === 'google_ads_native_action') {
    if (emptyGoogle) data.results = [];
    if (!Array.isArray(data.results) || (!data.results.length && !optionalGoogle))
      fail('STATE_NOT_FOUND', 'Google state query returned no target rows.');
    const q = String(object(read.body).query),
      type = q.match(/ FROM ([a-z_]+)/)?.[1];
    if (type === 'customer') {
      sameIds(
        data.results.map((r: JsonObject) => r.customer?.id),
        [id],
      );
      return;
    }
    if (!type) fail('STATE_READ_FAILED', 'Unrecognized Google state query.');
    const expected = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]),
      camel = type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      actual = data.results.map(
        (r: JsonObject) => (r[camel] ?? r[type])?.resourceName ?? (r[camel] ?? r[type])?.resource_name,
      );
    if (optionalGoogle) {
      if (
        read.googleState!.resource !== type ||
        stable(read.googleState!.names) !== stable(expected) ||
        new Set(actual).size !== actual.length ||
        actual.some((name: unknown) => typeof name !== 'string' || !expected.includes(name))
      )
        fail(
          'STATE_TARGET_MISMATCH',
          'Optional state must contain only unique, exactly requested association identities.',
        );
    } else sameIds(actual, expected);
    return;
  }
  if (read.gateway === 'tiktok_native_action') {
    if (read.path === '/v1.3/identity/info/') {
      const info = data.data?.identity_info;
      if (data.code !== 0 || !info || typeof info !== 'object' || Array.isArray(info))
        fail('STATE_READ_FAILED', 'TikTok identity info must confirm success and contain identity_info.');
      sameIds([info.identity_id], [read.query.identity_id]);
      return;
    }
    if (
      validateTiktokConversionState(read, data, sameIds) ||
      validateTiktokSavedAudienceState(read, data, sameIds) ||
      validateTiktokSmartPlusAdState(read, data, sameIds) ||
      validateTiktokSmartPlusAdgroupCampaignState(read, data) ||
      validateTiktokSmartPlusState(read, data, sameIds) ||
      validateTiktokCtaPortfolioState(read, data, sameIds)
    )
      return;
    if (data.code !== 0 || !Array.isArray(data.data?.list))
      fail('STATE_READ_FAILED', 'TikTok state must confirm success and contain its native list.');
    if (read.path === tiktokImageInfoPath) {
      sameIds(
        data.data.list.map((r: JsonObject) => r.image_id),
        read.query.image_ids,
      );
      return;
    }
    if (read.path === tiktokAudienceGetPath) {
      sameIds(
        data.data.list.map((r: JsonObject) => r?.audience_details?.audience_id),
        read.query.custom_audience_ids,
      );
      return;
    }
    const kind = read.path.split('/')[2]!,
      key = kind === 'advertiser' ? 'advertiser_id' : kind + '_id';
    sameIds(
      data.data.list.map((r: JsonObject) => r[key]),
      kind === 'advertiser' ? [id] : read.query.filtering[kind + '_ids'],
    );
    return;
  }
  const target = decodeURIComponent(read.path.split('/').at(-1)!).replace(/^act_/, '').split(':').at(-1);
  if (read.gateway === 'meta_native_action') {
    sameIds([String(data.id).replace(/^act_/, '')], [target]);
    if (String(read.query.fields).split(',').includes('status') && !Object.hasOwn(data, 'status'))
      fail('STATE_READ_FAILED', 'Meta did not return the requested target status.');
    return;
  }
  if (read.gateway === 'snapchat_native_action') {
    const kind = read.path.split('/').at(-2)!,
      rows = data[kind];
    if (!Array.isArray(rows) || rows.length !== 1)
      fail('STATE_READ_FAILED', 'Snapchat must return one exact target record.');
    const singular = kind === 'adsquads' ? 'adsquad' : kind === 'media' ? 'media' : kind.slice(0, -1);
    sameIds(
      rows.map((r: JsonObject) => (r[singular] ?? r).id),
      [target],
    );
    if (kind === 'creatives' && (rows[0][singular] ?? rows[0]).ad_account_id !== id)
      fail('ACCOUNT_SCOPE_MISMATCH', 'The creative must explicitly belong to the selected Snapchat ad account.');
    return;
  }
  if (read.gateway === 'x_ads_native_action') {
    sameIds([data.data?.id], [target]);
    return;
  }
  if (read.gateway === 'linkedin_native_action') {
    const exact = decodeURIComponent(read.path.split('/').at(-1)!);
    if (exact.startsWith('urn:li:') && data.id !== exact)
      fail('STATE_TARGET_MISMATCH', 'LinkedIn returned a different resource URN.');
    sameIds(
      [
        String(data.id ?? '')
          .split(':')
          .at(-1),
      ],
      [target],
    );
    return;
  }
  if (read.gateway === 'dv360_native_action') {
    const key: Record<string, string> = {
      advertisers: 'advertiserId',
      campaigns: 'campaignId',
      insertionOrders: 'insertionOrderId',
      lineItems: 'lineItemId',
      creatives: 'creativeId',
      adAssets: 'adAssetId',
    };
    sameIds([data[key[read.path.split('/').at(-2)!]!]], [target]);
    return;
  }
  fail('STATE_READ_FAILED', 'No response contract exists for this state read.');
}
