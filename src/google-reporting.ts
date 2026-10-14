import {bad, fingerprint, obj, type ToolCall} from './workspace-core.js';
import {collectionCheckpoint} from './report-collection-budget.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {storedLogin} from './connection-authority.js';
import {googleReportAdNetworks} from './report-breakdowns.js';

const gateway = 'google_ads_native_action';
export const googleReportDevices = Object.freeze([
  'UNSPECIFIED',
  'UNKNOWN',
  'MOBILE',
  'TABLET',
  'DESKTOP',
  'CONNECTED_TV',
  'OTHER',
]);
/** Native v25 GeoTargetingType values; the resource suffix uses their numeric enum values. */
export const googleReportLocationTypes = Object.freeze({
  UNSPECIFIED: 0,
  UNKNOWN: 1,
  AREA_OF_INTEREST: 2,
  LOCATION_OF_PRESENCE: 3,
});
export const googleReportCountryId = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
export function googleGeographicResource(value: unknown) {
  const match =
    typeof value === 'string'
      ? /^customers\/([1-9][0-9]{0,18})\/geographicViews\/((?:0|[1-9][0-9]{0,18}))~([0-3])$/.exec(value)
      : null;
  return match && googleReportId(match[1]) && googleReportCountryId(match[2])
    ? {account_id: match[1], country_criterion_id: match[2], location_type_value: Number(match[3])}
    : undefined;
}
export const googleReportId = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const incomplete = (message: string): never => bad(message, 'REPORT_INCOMPLETE');
function resource(value: unknown, expected: string) {
  if (value !== expected)
    bad('Google returned a different or missing native resource identity.', 'REPORT_ACCOUNT_MISMATCH');
}
function customer(value: unknown, account: string, semantics: JsonObject) {
  if (!obj(value) || value.id !== account)
    bad('Google did not return the exact selected customer.', 'REPORT_ACCOUNT_MISMATCH');
  const c = value as JsonObject;
  resource(c.resourceName, 'customers/' + account);
  if (c.currencyCode !== semantics.currency)
    bad('Google returned a different or missing account currency.', 'REPORT_CURRENCY_MISMATCH');
  if (c.timeZone !== semantics.timezone)
    bad('Google returned a different or missing account timezone.', 'REPORT_TIMEZONE_MISMATCH');
}
function validateRows(preset: string, account: string, semantics: JsonObject, rows: JsonObject[]) {
  const seen = new Set<string>(),
    parents = new Map<string, string>(),
    keywords = new Map<string, string>();
  for (const row of rows) {
    if (!obj(row) || !obj(row.campaign) || !googleReportId(row.campaign.id) || !obj(row.metrics))
      bad('Google did not return the requested native campaign and metric row.', 'REPORT_SHAPE_CHANGED');
    customer(row.customer, account, semantics);
    resource(row.campaign.resourceName, `customers/${account}/campaigns/${row.campaign.id}`);
    let identity = row.campaign.resourceName;
    if (
      ![
        'google_campaign',
        'google_campaign_device',
        'google_campaign_hour',
        'google_campaign_country',
        'google_campaign_network',
        'google_pmax_search_terms',
      ].includes(preset)
    ) {
      if (!obj(row.adGroup) || !googleReportId(row.adGroup.id))
        bad('Google did not return the requested native ad group.', 'REPORT_SHAPE_CHANGED');
      resource(row.adGroup.resourceName, `customers/${account}/adGroups/${row.adGroup.id}`);
      const previous = parents.get(row.adGroup.id);
      if (previous !== undefined && previous !== row.campaign.id)
        bad('Google returned an ad group under different campaigns.', 'REPORT_ACCOUNT_MISMATCH');
      parents.set(row.adGroup.id, row.campaign.id);
      identity = row.adGroup.resourceName;
    }
    if (preset === 'google_ad') {
      if (!obj(row.adGroupAd) || !obj(row.adGroupAd.ad) || !googleReportId(row.adGroupAd.ad.id))
        bad('Google did not return an exact native ad ID.', 'REPORT_SHAPE_CHANGED');
      resource(row.adGroupAd.resourceName, `customers/${account}/adGroupAds/${row.adGroup.id}~${row.adGroupAd.ad.id}`);
      resource(row.adGroupAd.ad.resourceName, `customers/${account}/ads/${row.adGroupAd.ad.id}`);
      identity = row.adGroupAd.resourceName;
    }
    if (preset === 'google_keyword') {
      const criterion = row.adGroupCriterion,
        keyword = criterion?.keyword;
      if (
        row.campaign.advertisingChannelType !== 'SEARCH' ||
        !obj(criterion) ||
        !googleReportId(criterion.criterionId) ||
        criterion.type !== 'KEYWORD' ||
        (criterion.negative !== undefined && criterion.negative !== false) ||
        !obj(keyword) ||
        typeof keyword.text !== 'string' ||
        !keyword.text.trim() ||
        [...keyword.text].length > 80 ||
        keyword.text.trim().split(/\s+/u).length > 10 ||
        /[\x00-\x1f\x7f]/.test(keyword.text) ||
        !['EXACT', 'PHRASE', 'BROAD'].includes(keyword.matchType)
      )
        bad(
          'Google did not return a bounded positive Search keyword with its native match type.',
          'REPORT_SHAPE_CHANGED',
        );
      const suffix = `${row.adGroup.id}~${criterion.criterionId}`;
      resource(criterion.resourceName, `customers/${account}/adGroupCriteria/${suffix}`);
      resource(row.keywordView?.resourceName, `customers/${account}/keywordViews/${suffix}`);
      identity = row.keywordView.resourceName;
      const metadata = JSON.stringify([keyword.text, keyword.matchType]);
      if (keywords.has(identity) && keywords.get(identity) !== metadata)
        bad('Google returned changed immutable keyword text or match type during collection.', 'REPORT_SHAPE_CHANGED');
      keywords.set(identity, metadata);
    }
    let date = '',
      device = '',
      network = '',
      hour = -1,
      geographic = '';
    if (preset === 'google_campaign_country') {
      const view = row.geographicView;
      if (
        !obj(view) ||
        !googleReportCountryId(view.countryCriterionId) ||
        typeof view.locationType !== 'string' ||
        !Object.hasOwn(googleReportLocationTypes, view.locationType)
      )
        bad('Google did not return the requested native country and location type.', 'REPORT_SHAPE_CHANGED');
      resource(
        view.resourceName,
        `customers/${account}/geographicViews/${view.countryCriterionId}~${googleReportLocationTypes[view.locationType as keyof typeof googleReportLocationTypes]}`,
      );
      geographic = view.resourceName;
    }
    if (preset === 'google_search_terms') {
      const term = row.searchTermView?.searchTerm,
        name = row.searchTermView?.resourceName;
      if (typeof term !== 'string' || !term || term.length > 1000 || typeof name !== 'string' || name.length > 1000)
        bad('Google did not return a bounded native search term identity.', 'REPORT_SHAPE_CHANGED');
      const encoded = Buffer.from(term, 'utf8').toString('base64url'),
        expected = `customers/${account}/searchTermViews/${row.campaign.id}~${row.adGroup.id}~${encoded}`;
      // URL-base64 may carry its standard trailing padding; preserve the provider spelling in retained rows.
      if (name !== expected && name !== expected + '='.repeat((4 - (encoded.length % 4)) % 4))
        bad('Google returned a search term under a different native identity.', 'REPORT_ACCOUNT_MISMATCH');
      identity = name;
      if (row.segments !== undefined && (!obj(row.segments) || Object.keys(row.segments).length))
        bad('Google returned an unexpected search-term reporting dimension.', 'REPORT_SHAPE_CHANGED');
    } else if (preset === 'google_pmax_search_terms') {
      // RPT-07: a Performance Max campaign's search term over the window, with its exact campaign search term view.
      const term = row.campaignSearchTermView?.searchTerm,
        name = row.campaignSearchTermView?.resourceName;
      if (row.campaign.advertisingChannelType !== 'PERFORMANCE_MAX')
        bad('Google returned a search term outside a Performance Max campaign.', 'REPORT_SHAPE_CHANGED');
      if (typeof term !== 'string' || !term || term.length > 1000 || typeof name !== 'string' || name.length > 1000)
        bad('Google did not return a bounded native search term identity.', 'REPORT_SHAPE_CHANGED');
      const encoded = Buffer.from(term, 'utf8').toString('base64url'),
        expected = `customers/${account}/campaignSearchTermViews/${row.campaign.id}~${encoded}`;
      if (name !== expected && name !== expected + '='.repeat((4 - (encoded.length % 4)) % 4))
        bad('Google returned a search term under a different native identity.', 'REPORT_ACCOUNT_MISMATCH');
      identity = name;
      if (row.segments !== undefined && (!obj(row.segments) || Object.keys(row.segments).length))
        bad('Google returned an unexpected search-term reporting dimension.', 'REPORT_SHAPE_CHANGED');
    } else {
      if (preset === 'google_campaign_network') {
        if (
          !obj(row.segments) ||
          Object.keys(row.segments).length !== 2 ||
          typeof row.segments.adNetworkType !== 'string' ||
          !googleReportAdNetworks.includes(row.segments.adNetworkType)
        )
          bad('Google did not return the requested native ad network/day reporting grain.', 'REPORT_SHAPE_CHANGED');
        network = row.segments.adNetworkType;
      } else if (preset === 'google_campaign_device') {
        if (
          !obj(row.segments) ||
          Object.keys(row.segments).length !== 2 ||
          typeof row.segments.device !== 'string' ||
          !googleReportDevices.includes(row.segments.device)
        )
          bad('Google did not return the requested native device/day reporting grain.', 'REPORT_SHAPE_CHANGED');
        device = row.segments.device;
      } else if (preset === 'google_campaign_hour') {
        if (
          !obj(row.segments) ||
          Object.keys(row.segments).length !== 2 ||
          !Number.isInteger(row.segments.hour) ||
          row.segments.hour < 0 ||
          row.segments.hour > 23
        )
          bad('Google did not return the requested native hour/day reporting grain.', 'REPORT_SHAPE_CHANGED');
        hour = row.segments.hour;
      } else if (!obj(row.segments) || Object.keys(row.segments).length !== 1)
        bad('Google returned a different daily reporting grain.', 'REPORT_SHAPE_CHANGED');
      date = row.segments.date;
      if (
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        date < semantics.date_from ||
        date > semantics.date_to
      )
        bad('Google returned a date outside the requested daily window.', 'REPORT_DATE_MISMATCH');
    }
    // Search-term padding is not a second identity for the same native parent/term tuple.
    const key =
      preset === 'google_search_terms'
        ? JSON.stringify([row.campaign.id, row.adGroup.id, row.searchTermView.searchTerm])
        : preset === 'google_pmax_search_terms'
          ? JSON.stringify([row.campaign.id, row.campaignSearchTermView.searchTerm])
          : preset === 'google_campaign_device'
            ? JSON.stringify([identity, device, date])
            : preset === 'google_campaign_network'
              ? JSON.stringify([identity, network, date])
              : preset === 'google_campaign_hour'
                ? JSON.stringify([identity, hour, date])
                : preset === 'google_campaign_country'
                  ? JSON.stringify([identity, geographic, date])
                  : JSON.stringify([identity, date]);
    if (seen.has(key)) bad('Google returned duplicate rows for the requested native grain.', 'REPORT_DUPLICATE_ROWS');
    seen.add(key);
  }
}

/** Read-only bounded Search pages. Native completeness does not verify attribution or a point-in-time snapshot. */
export async function collectGoogleReport(
  store: Store,
  call: ToolCall,
  actor: Actor,
  args: JsonObject,
  semantics: JsonObject,
  preset: string,
) {
  const account = args.account_id,
    connection = store.resolveConnection(actor, gateway, account, args.connection_id),
    authorization = fingerprint({
      login: storedLogin(store, connection),
      scopes: [...connection.scopes].sort(),
    });
  const current = () => {
    store.assertActorActive(actor);
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Google login or permissions changed. Capture a new report.', 'CONNECTION_AUTHORITY_CHANGED');
    collectionCheckpoint();
  };
  const read = async (request: JsonObject) => {
    current();
    const result = await call(gateway, request, actor);
    current();
    if (result.success !== true)
      bad(result.error?.message ?? 'Google report read failed.', result.error?.code ?? 'REPORT_FAILED');
    const data = result.data?.data;
    if (
      result.data?.executed === false ||
      result.data?.dry_run ||
      !obj(data) ||
      [result.data, data].some(
        v =>
          v.error !== undefined ||
          v.errors !== undefined ||
          v.truncated === true ||
          ['next_page_token', 'next_cursor', 'has_more', 'hasMore', 'paging', 'pagination', 'summaryRow'].some(
            k => v[k] !== undefined,
          ),
      )
    )
      incomplete('Google returned partial or unknown report completion metadata.');
    const rows = data.results ?? (data.results === undefined ? [] : null),
      token = data.nextPageToken ?? '';
    if (
      !Array.isArray(rows) ||
      (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') ||
      token.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(token)
    )
      incomplete('Google returned malformed rows or continuation metadata.');
    // Proto3 omits default repeated fields and zero-valued int64 counts. Only an empty terminal result can use zero.
    const rawCount =
      data.totalResultsCount ?? (data.totalResultsCount === undefined && !rows.length && !token ? '0' : null);
    if (typeof rawCount !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(rawCount))
      incomplete('Google did not return an exact native result count.');
    const count = BigInt(rawCount);
    if (count > 10000n || rows.length > 10000)
      bad('Narrow the Google report to at most 10000 rows.', 'REPORT_COLLECTION_LIMIT');
    return {
      rows: rows as JsonObject[],
      total: Number(count),
      token: token as string,
      evidence: {source_request: request, source_hash: fingerprint(result.data), captured_at: Date.now()},
    };
  };
  const checks: JsonObject[] = [];
  const verifyAccount = async () => {
    const native = await read({
      action: args.action,
      account_id: account,
      connection_id: connection.id,
      dry_run: false,
      aggregate_pages: false,
      payload: {
        query:
          'SELECT customer.id, customer.resource_name, customer.currency_code, customer.time_zone FROM customer LIMIT 2',
        search_settings: {return_total_results_count: true},
      },
    });
    if (native.rows.length !== 1 || native.total !== 1 || native.token)
      bad('Google did not return one complete selected customer.', 'REPORT_ACCOUNT_MISMATCH');
    customer(native.rows[0]?.customer, account, semantics);
    checks.push(native.evidence);
  };
  await verifyAccount();
  const rows: JsonObject[] = [],
    pages: JsonObject[] = [],
    tokens = new Set<string>();
  let token = '',
    total: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const request = {
        ...args,
        aggregate_pages: false,
        payload: {...args.payload, ...(token ? {page_token: token} : {})},
      },
      native = await read(request);
    if (total !== undefined && total !== native.total)
      incomplete('Google result counts changed during collection. Capture again.');
    total = native.total;
    if (
      rows.length + native.rows.length > total ||
      (native.token && (!native.rows.length || rows.length + native.rows.length >= total))
    )
      incomplete('Google result counts and continuation disagree.');
    rows.push(...native.rows);
    pages.push({...native.evidence, page, row_count: native.rows.length, total_rows: total});
    if (!native.token) break;
    if (tokens.has(native.token)) incomplete('Google repeated a report continuation token.');
    tokens.add(native.token);
    token = native.token;
    if (page === 100) bad('Narrow the Google report to at most 100 pages.', 'REPORT_COLLECTION_LIMIT');
  }
  if (rows.length !== total) incomplete('Google did not return every declared report row.');
  validateRows(preset, account, semantics, rows);
  await verifyAccount();
  current();
  return {
    source: {success: true, data: {collection_kind: 'google_search_pages', data: {results: rows}, source_pages: pages}},
    sourcePages: pages,
    nativeAccountEvidence: {account_id: account, currency: semantics.currency, timezone: semantics.timezone, checks},
    assertCurrent: current,
  };
}
