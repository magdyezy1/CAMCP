import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {normalizeAccount} from './scope.js';

/**
 * Organic/paid search overlap (PRV-07 D): Search Console queries (searchAnalytics.query, dimension query, dataState
 * final) and Google Ads search terms (search_term_view) for the same dates, joined locally on normalized query text.
 * Normalization differs from either provider's own matching, so every match is labelled approximate. The output is
 * evidence for the existing reviewed keyword and negative-keyword plans; it never changes an account by itself.
 */
const adsGateway = 'google_ads_native_action',
  gscGateway = 'google_search_console_native_action',
  dayMs = 86400000;
const invalid = (message: string): never => bad(message, 'SEARCH_OVERLAP_INVALID');
function day(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
/** Unicode NFKC, lower case, trimmed, inner whitespace collapsed. Approximate by design. */
export function normalizeSearchQuery(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}
export type OrganicRow = {query: string; clicks: number; impressions: number; position: number};
export type PaidRow = {
  search_term: string;
  impressions: string;
  clicks: string;
  cost_micros: string;
  conversions: number;
};
type Organic = {clicks: number; impressions: number; weighted: number; variants: Set<string>};
type Paid = {impressions: bigint; clicks: bigint; cost: bigint; conversions: number; variants: Set<string>};
const round = (value: number, places: number) => Number(value.toFixed(places));

/**
 * The deterministic overlap table of already-read rows: the same inputs, in any order, give the same output.
 * Rows sort by class (both, paid_only, organic_only), then paid cost, organic clicks and normalized text.
 */
export function searchOverlapTable(organic: OrganicRow[], paid: PaidRow[], maxRows = 200): JsonObject {
  const o = new Map<string, Organic>(),
    p = new Map<string, Paid>();
  for (const r of organic) {
    const key = normalizeSearchQuery(r.query);
    if (!key) continue;
    const v = o.get(key) ?? {clicks: 0, impressions: 0, weighted: 0, variants: new Set<string>()};
    v.clicks += r.clicks;
    v.impressions += r.impressions;
    v.weighted += r.position * r.impressions;
    v.variants.add(r.query);
    o.set(key, v);
  }
  for (const r of paid) {
    const key = normalizeSearchQuery(r.search_term);
    if (!key) continue;
    const v = p.get(key) ?? {impressions: 0n, clicks: 0n, cost: 0n, conversions: 0, variants: new Set<string>()};
    v.impressions += BigInt(r.impressions);
    v.clicks += BigInt(r.clicks);
    v.cost += BigInt(r.cost_micros);
    v.conversions += r.conversions;
    v.variants.add(r.search_term);
    p.set(key, v);
  }
  const classOrder = {both: 0, paid_only: 1, organic_only: 2} as const;
  const rows = [...new Set([...o.keys(), ...p.keys()])].map(key => {
    const a = o.get(key),
      b = p.get(key),
      overlap = (a && b ? 'both' : b ? 'paid_only' : 'organic_only') as keyof typeof classOrder,
      position = a && a.impressions > 0 ? round(a.weighted / a.impressions, 2) : null,
      conversions = b ? round(b.conversions, 6) : null;
    return {
      normalized_query: key,
      overlap,
      match: 'approximate_normalized_text',
      organic: a
        ? {
            clicks: a.clicks,
            impressions: a.impressions,
            average_position: position,
            source_variants: [...a.variants].sort(),
          }
        : null,
      paid: b
        ? {
            impressions: String(b.impressions),
            clicks: String(b.clicks),
            cost_micros: String(b.cost),
            conversions,
            source_variants: [...b.variants].sort(),
          }
        : null,
      // Review prompts only; nothing is applied. Strong organic rank with paid spend may make paid coverage optional;
      // a converting paid-only term may be an organic content gap.
      review_hint:
        overlap === 'both' && position !== null && position <= 3 && b!.cost > 0n
          ? 'organic_strong_with_paid_spend'
          : overlap === 'paid_only' && (conversions ?? 0) > 0
            ? 'paid_only_converting'
            : null,
    };
  });
  rows.sort(
    (x, y) =>
      classOrder[x.overlap] - classOrder[y.overlap] ||
      (BigInt(y.paid?.cost_micros ?? '0') > BigInt(x.paid?.cost_micros ?? '0')
        ? 1
        : BigInt(y.paid?.cost_micros ?? '0') < BigInt(x.paid?.cost_micros ?? '0')
          ? -1
          : 0) ||
      (y.organic?.clicks ?? 0) - (x.organic?.clicks ?? 0) ||
      (x.normalized_query < y.normalized_query ? -1 : x.normalized_query > y.normalized_query ? 1 : 0),
  );
  const count = (c: string) => rows.filter(r => r.overlap === c).length;
  return {
    summary: {
      queries: rows.length,
      both: count('both'),
      paid_only: count('paid_only'),
      organic_only: count('organic_only'),
      organic_strong_with_paid_spend: rows.filter(r => r.review_hint === 'organic_strong_with_paid_spend').length,
      paid_only_converting: rows.filter(r => r.review_hint === 'paid_only_converting').length,
    },
    rows: rows.slice(0, maxRows),
    rows_truncated: rows.length > maxRows,
  };
}

export async function searchOverlap(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== adsGateway)
    bad(
      'Search overlap reads a selected Google Ads customer (gateway google_ads_native_action) and a Search Console property.',
    );
  const account = normalizeAccount(adsGateway, input.account_id);
  if (typeof input.account_id !== 'string' || !/^\d{1,32}$/.test(account))
    bad('Choose the exact numeric Google Ads customer ID.');
  const config = input.requirements ?? {};
  validate(config, ['site_url', 'gsc_connection_id', 'date_from', 'date_to', 'row_limit', 'max_rows']);
  const site = config.site_url,
    from = day(config.date_from),
    to = day(config.date_to),
    rowLimit = config.row_limit ?? 5000,
    maxRows = config.max_rows ?? 200,
    today = day(new Date().toISOString().slice(0, 10))!;
  if (
    typeof site !== 'string' ||
    site.length > 2048 ||
    /[\x00-\x20\\]/.test(site) ||
    !(/^sc-domain:[^/?#]+$/.test(site) || /^https?:\/\/[^/?#]+\/$/.test(site))
  )
    bad('Choose the exact Search Console property: sc-domain:example.com or a URL prefix ending in /.');
  if (
    config.gsc_connection_id !== undefined &&
    (typeof config.gsc_connection_id !== 'string' || !config.gsc_connection_id)
  )
    bad('Choose the Search Console login (gsc_connection_id) that holds this property, or omit it.');
  if (from === null || to === null || to < from || to - from > 89 * dayMs || to >= today)
    bad('Choose closed dates (before today) covering at most 90 days.');
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25000)
    bad('Choose a row limit of 1–25,000 per source.');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000) bad('Choose 1–1,000 overlap rows to return.');
  const ads = store.resolveConnection(actor, adsGateway, account, input.connection_id),
    gsc = store.resolveConnection(actor, gscGateway, site, config.gsc_connection_id),
    logins = fingerprint([storedLogin(store, ads), storedLogin(store, gsc)]);
  const current = () => {
    store.assertActorActive(actor);
    const a = store.resolveConnection(actor, adsGateway, account, ads.id),
      g = store.resolveConnection(actor, gscGateway, site, gsc.id);
    if (fingerprint([storedLogin(store, a), storedLogin(store, g)]) !== logins)
      bad('A selected login changed. Read the search overlap again.', 'CONNECTION_AUTHORITY_CHANGED');
    // Search Console reads take no connection_id: they must resolve to this exact login for this property.
    if (store.resolveConnection(actor, gscGateway, site).id !== gsc.id)
      bad(
        'Another Search Console login is the default for this property. Choose that login or make this one the default.',
        'AMBIGUOUS_CONNECTION',
      );
  };
  current();
  const window = {date_from: config.date_from as string, date_to: config.date_to as string},
    adsQuery =
      'SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date BETWEEN ' +
      "'" +
      window.date_from +
      "' AND '" +
      window.date_to +
      "' AND metrics.impressions > 0 ORDER BY metrics.impressions DESC LIMIT " +
      rowLimit,
    gscRequest = {
      startDate: window.date_from,
      endDate: window.date_to,
      dimensions: ['query'],
      type: 'web',
      dataState: 'final',
      rowLimit,
      startRow: 0,
    },
    scope = {
      gateway: adsGateway,
      connection_id: ads.id,
      account_id: account,
      site_url: site,
      gsc_connection_id: gsc.id,
      ...window,
      row_limit: rowLimit,
    },
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: 4,
      rows: 50000,
      bytes: 16 * 1024 * 1024,
      elapsed_ms: 60000,
    }),
    requestedAt = Date.now();
  const read = async (gateway: string, request: JsonObject, label: string) => {
    current();
    const response = await call(gateway, request, actor);
    current();
    if (!response.success)
      bad(response.error?.message ?? label + ' read failed.', response.error?.code ?? 'SEARCH_OVERLAP_READ_FAILED');
    if (response.data?.truncated || !obj(response.data?.data))
      invalid(label + ' did not return a complete bounded response.');
    return response.data.data as JsonObject;
  };
  try {
    return await budget.run(async () => {
      const gscData = await read(
        gscGateway,
        {
          operation: 'gsc_analytics_ops',
          arguments: {action: 'QUERY_SEARCH_ANALYTICS', site_url: site, payload: gscRequest},
        },
        'Search Console',
      );
      if (gscData.rows !== undefined && !Array.isArray(gscData.rows))
        invalid('Search Console returned a malformed query table.');
      const organic: OrganicRow[] = ((gscData.rows ?? []) as unknown[]).map(r => {
        if (
          !obj(r) ||
          !Array.isArray(r.keys) ||
          r.keys.length !== 1 ||
          typeof r.keys[0] !== 'string' ||
          r.keys[0].length > 2048 ||
          ['clicks', 'impressions'].some(k => !Number.isSafeInteger(r[k]) || r[k] < 0) ||
          typeof r.position !== 'number' ||
          !Number.isFinite(r.position) ||
          r.position < 1
        )
          invalid('Search Console returned a malformed query row.');
        const row = r as JsonObject;
        return {query: row.keys[0], clicks: row.clicks, impressions: row.impressions, position: row.position};
      });
      if (organic.length > rowLimit) invalid('Search Console returned more rows than requested.');
      budget.rows('organic', organic.length);
      const adsData = await read(
        adsGateway,
        {
          action: 'google_ads_v23_google_ads_search',
          connection_id: ads.id,
          account_id: account,
          payload: {query: adsQuery},
          aggregate_pages: true,
          max_pages: 3,
        },
        'Google Ads',
      );
      if (adsData.results !== undefined && !Array.isArray(adsData.results))
        invalid('Google Ads returned a malformed search term table.');
      const prefix = 'customers/' + account + '/searchTermViews/';
      const paid: PaidRow[] = ((adsData.results ?? []) as unknown[]).map(r => {
        const v = obj(r) ? r.searchTermView : undefined,
          m = obj(r) ? r.metrics : undefined;
        if (
          !obj(r) ||
          Object.keys(r).some(k => !['searchTermView', 'metrics'].includes(k)) ||
          !obj(v) ||
          typeof v.searchTerm !== 'string' ||
          v.searchTerm.length > 2048 ||
          (v.resourceName !== undefined &&
            (typeof v.resourceName !== 'string' || !v.resourceName.startsWith(prefix))) ||
          !obj(m) ||
          [m.impressions, m.clicks, m.costMicros].some(
            x => x !== undefined && (typeof x !== 'string' || !/^\d{1,19}$/.test(x)),
          ) ||
          (m.conversions !== undefined &&
            (typeof m.conversions !== 'number' || !Number.isFinite(m.conversions) || m.conversions < 0))
        )
          invalid('Google Ads returned a malformed or foreign search term row.');
        const metrics = m as JsonObject;
        return {
          search_term: (v as JsonObject).searchTerm,
          impressions: metrics.impressions ?? '0',
          clicks: metrics.clicks ?? '0',
          cost_micros: metrics.costMicros ?? '0',
          conversions: metrics.conversions ?? 0,
        };
      });
      if (paid.length > rowLimit) invalid('Google Ads returned more rows than requested.');
      budget.rows('paid', paid.length);
      current();
      budget.check();
      const table = searchOverlapTable(organic, paid, maxRows),
        capturedAt = Date.now(),
        organicTop = organic.length >= rowLimit,
        paidTop = paid.length >= rowLimit;
      return {
        record_kind: 'search_overlap',
        scope,
        requested_at: requestedAt,
        captured_at: capturedAt,
        match: 'approximate_normalized_text',
        normalization: 'Unicode NFKC, lower case, trimmed, inner whitespace collapsed',
        sources: {
          organic: {
            provider: 'search_console',
            data_state: 'final',
            dates: 'Search Console reporting days (Pacific Time)',
            rows: organic.length,
            top_rows_only: organicTop,
          },
          paid: {
            provider: 'google_ads',
            resource: 'search_term_view',
            dates: 'Google Ads account time zone days',
            rows: paid.length,
            top_rows_only: paidTop,
          },
        },
        complete: !organicTop && !paidTop,
        ...table,
        source_references: [
          {provider: 'search_console', request: gscRequest, source_hash: fingerprint(organic)},
          {
            provider: 'google_ads',
            request: {resource: 'customers/' + account + '/googleAds:search', query: adsQuery},
            source_hash: fingerprint(paid),
          },
        ],
        source_hash: fingerprint({scope, organic, paid, requestedAt, capturedAt}),
        next_steps: [
          'Exact negative keywords: amcp_reporting search_exclusion_candidates and preview_search_exclusions (reviewed plan).',
          'New keywords: prepare them through amcp_write with native review.',
        ],
        provider_mutations: 0,
        retained_snapshot: false,
        meaning:
          'Search Console queries and Google Ads search terms for the same dates, joined on normalized text. Matching is approximate: the providers match queries differently, Search Console omits anonymized queries and both report top rows, and their days use different time zones. review_hint marks rows worth reviewing, never a change to make. Nothing was saved or changed.',
      };
    });
  } finally {
    budget.close();
  }
}
