import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {normalizeAccount} from './scope.js';
import {providerById} from './provider-adapters.js';

/**
 * Organic/paid search overlap (PRV-07 D): Search Console queries (searchAnalytics.query, dimension query, dataState
 * final; optionally query × page for each query's top landing pages) and Google Ads search terms (search_term_view)
 * for the same dates, joined locally on normalized query text. Normalization differs from either provider's own
 * matching, so every match is labelled approximate. The output is evidence for the existing reviewed keyword and
 * negative-keyword plans: paid rows name their native search_term_view resources, the ids the reviewed exclusion
 * preview takes. It never changes an account by itself.
 */
// ARC-01 (reporting): the two gateways are the Google Ads and Search Console provider adapters' (src/provider-adapters.ts).
const adsGateway = providerById('google')!.gateway,
  gscGateway = providerById('gsc')!.gateway,
  dayMs = 86400000,
  // Search Console final data usually trails by two to three days.
  finalDataLagDays = 3,
  pagesPerQuery = 3,
  // preview_search_exclusions takes at most 20 ids.
  viewsPerQuery = 20;
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
/** Whether a Search Console page URL belongs to the property: its domain (and subdomains) or its URL prefix. */
export function searchConsolePageInProperty(site: string, page: unknown): boolean {
  if (typeof page !== 'string' || page.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (!site.startsWith('sc-domain:')) return page.startsWith(site);
  let domain: string;
  try {
    domain = new URL('https://' + site.slice('sc-domain:'.length) + '/').hostname;
  } catch {
    return false;
  }
  return url.hostname === domain || url.hostname.endsWith('.' + domain);
}
export type OrganicRow = {query: string; clicks: number; impressions: number; position: number};
/** A Search Console query × page row. Its metrics are aggregated by page, so they only rank pages within a query. */
export type OrganicPageRow = OrganicRow & {page: string};
export type PaidRow = {
  search_term: string;
  impressions: string;
  clicks: string;
  cost_micros: string;
  conversions: number;
  /** The native search_term_view (campaign~ad group~term), an id the reviewed exclusion preview accepts. */
  resource_name?: string;
};
type Organic = {clicks: number; impressions: number; weighted: number; variants: Set<string>};
type Paid = {
  impressions: bigint;
  clicks: bigint;
  cost: bigint;
  conversions: number;
  variants: Set<string>;
  views: Set<string>;
};
type Page = {clicks: number; impressions: number; weighted: number};
const round = (value: number, places: number) => Number(value.toFixed(places));
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Rows in one canonical order. Floating-point sums depend on their order, so every sum here is taken in this one. */
const canonical = <T>(rows: T[], key: (row: T) => unknown[]): T[] =>
  rows
    .map(row => [JSON.stringify(key(row)), row] as const)
    .sort(([a], [b]) => byText(a, b))
    .map(([, row]) => row);

/**
 * The deterministic overlap table of already-read rows: the same inputs, in any order, give the same output.
 * Rows sort by class (both, paid_only, organic_only), then paid cost, organic clicks and normalized text. With page
 * rows, each organic query lists its top landing pages by clicks; query totals still come from the query rows.
 */
export function searchOverlapTable(
  organic: OrganicRow[],
  paid: PaidRow[],
  maxRows = 200,
  pages?: OrganicPageRow[],
): JsonObject {
  const o = new Map<string, Organic>(),
    p = new Map<string, Paid>(),
    landing = new Map<string, Map<string, Page>>();
  for (const r of canonical(pages ?? [], r => [r.query, r.page, r.clicks, r.impressions, r.position])) {
    const key = normalizeSearchQuery(r.query);
    if (!key) continue;
    const list = landing.get(key) ?? new Map<string, Page>(),
      v = list.get(r.page) ?? {clicks: 0, impressions: 0, weighted: 0};
    v.clicks += r.clicks;
    v.impressions += r.impressions;
    v.weighted += r.position * r.impressions;
    list.set(r.page, v);
    landing.set(key, list);
  }
  const topPages = (key: string) =>
    [...(landing.get(key) ?? new Map<string, Page>())]
      .map(([page, v]) => ({
        page,
        clicks: v.clicks,
        impressions: v.impressions,
        average_position: v.impressions > 0 ? round(v.weighted / v.impressions, 2) : null,
      }))
      .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions || byText(x.page, y.page))
      .slice(0, pagesPerQuery);
  for (const r of canonical(organic, r => [r.query, r.clicks, r.impressions, r.position])) {
    const key = normalizeSearchQuery(r.query);
    if (!key) continue;
    const v = o.get(key) ?? {clicks: 0, impressions: 0, weighted: 0, variants: new Set<string>()};
    v.clicks += r.clicks;
    v.impressions += r.impressions;
    v.weighted += r.position * r.impressions;
    v.variants.add(r.query);
    o.set(key, v);
  }
  for (const r of canonical(paid, r => [
    r.search_term,
    r.resource_name ?? '',
    r.impressions,
    r.clicks,
    r.cost_micros,
    r.conversions,
  ])) {
    const key = normalizeSearchQuery(r.search_term);
    if (!key) continue;
    const v = p.get(key) ?? {
      impressions: 0n,
      clicks: 0n,
      cost: 0n,
      conversions: 0,
      variants: new Set<string>(),
      views: new Set<string>(),
    };
    v.impressions += BigInt(r.impressions);
    v.clicks += BigInt(r.clicks);
    v.cost += BigInt(r.cost_micros);
    v.conversions += r.conversions;
    v.variants.add(r.search_term);
    if (r.resource_name) v.views.add(r.resource_name);
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
            top_pages: pages ? topPages(key) : null,
          }
        : null,
      paid: b
        ? {
            impressions: String(b.impressions),
            clicks: String(b.clicks),
            cost_micros: String(b.cost),
            conversions,
            source_variants: [...b.variants].sort(),
            search_term_views: [...b.views].sort().slice(0, viewsPerQuery),
            search_term_view_count: b.views.size,
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
      byText(x.normalized_query, y.normalized_query),
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
  validate(config, ['site_url', 'gsc_connection_id', 'date_from', 'date_to', 'row_limit', 'max_rows', 'include_pages']);
  const site = config.site_url,
    from = day(config.date_from),
    to = day(config.date_to),
    rowLimit = config.row_limit ?? 5000,
    maxRows = config.max_rows ?? 200,
    includePages = config.include_pages ?? false,
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
  if (typeof includePages !== 'boolean') bad('include_pages must be true or false.');
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
      'SELECT search_term_view.resource_name, search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE segments.date BETWEEN ' +
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
    // Aggregated by page, so its metrics only rank the pages of one query; totals come from gscRequest.
    pageRequest = includePages ? {...gscRequest, dimensions: ['query', 'page']} : null,
    scope = {
      gateway: adsGateway,
      connection_id: ads.id,
      account_id: account,
      site_url: site,
      gsc_connection_id: gsc.id,
      ...window,
      row_limit: rowLimit,
      include_pages: includePages,
    },
    // One or two Search Console reads and up to three Google Ads pages, with room for two retries.
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: (includePages ? 2 : 1) + 3 + 2,
      rows: (includePages ? 3 : 2) * 25000,
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
  // Search Console rows of one request: `keys` holds exactly the requested dimensions, in order.
  const searchConsoleRows = async (request: JsonObject) => {
    const data = await read(
      gscGateway,
      {operation: 'gsc_analytics_ops', arguments: {action: 'QUERY_SEARCH_ANALYTICS', site_url: site, payload: request}},
      'Search Console',
    );
    if (data.rows !== undefined && !Array.isArray(data.rows))
      invalid('Search Console returned a malformed query table.');
    const width = (request.dimensions as string[]).length,
      rows = ((data.rows ?? []) as unknown[]).map(r => {
        if (
          !obj(r) ||
          !Array.isArray(r.keys) ||
          r.keys.length !== width ||
          typeof r.keys[0] !== 'string' ||
          r.keys[0].length > 2048 ||
          ['clicks', 'impressions'].some(k => !Number.isSafeInteger(r[k]) || r[k] < 0) ||
          typeof r.position !== 'number' ||
          !Number.isFinite(r.position) ||
          r.position < 1
        )
          invalid('Search Console returned a malformed query row.');
        const row = r as JsonObject;
        if (width === 2 && !searchConsolePageInProperty(site, row.keys[1]))
          invalid('Search Console returned a page outside the selected property.');
        return {
          query: row.keys[0] as string,
          clicks: row.clicks as number,
          impressions: row.impressions as number,
          position: row.position as number,
          ...(width === 2 ? {page: row.keys[1] as string} : {}),
        };
      });
    if (rows.length > rowLimit) invalid('Search Console returned more rows than requested.');
    return rows;
  };
  try {
    return await budget.run(async () => {
      const organic: OrganicRow[] = await searchConsoleRows(gscRequest);
      budget.rows('organic', organic.length);
      const pages = pageRequest ? ((await searchConsoleRows(pageRequest)) as OrganicPageRow[]) : undefined;
      if (pages) budget.rows('organic_pages', pages.length);
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
      // campaign~ad group~base64url term of the selected customer: the grain the reviewed exclusion path checks.
      const view = new RegExp(
        '^customers/' + account + '/searchTermViews/[1-9][0-9]{0,19}~[1-9][0-9]{0,19}~[A-Za-z0-9_-]+={0,2}$',
      );
      const paid: PaidRow[] = ((adsData.results ?? []) as unknown[]).map(r => {
        const v = obj(r) ? r.searchTermView : undefined,
          m = obj(r) ? r.metrics : undefined;
        if (
          !obj(r) ||
          Object.keys(r).some(k => !['searchTermView', 'metrics'].includes(k)) ||
          !obj(v) ||
          typeof v.searchTerm !== 'string' ||
          v.searchTerm.length > 2048 ||
          typeof v.resourceName !== 'string' ||
          // The base64url of a 2,048-character term is at most 8,192 characters.
          v.resourceName.length > 8400 ||
          !view.test(v.resourceName) ||
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
          resource_name: (v as JsonObject).resourceName,
        };
      });
      if (paid.length > rowLimit) invalid('Google Ads returned more rows than requested.');
      if (new Set(paid.map(r => r.resource_name)).size !== paid.length)
        invalid('Google Ads repeated a search term view.');
      budget.rows('paid', paid.length);
      current();
      budget.check();
      const table = searchOverlapTable(organic, paid, maxRows, pages),
        capturedAt = Date.now(),
        organicTop = organic.length >= rowLimit,
        pagesTop = !!pages && pages.length >= rowLimit,
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
            // Final data usually trails by two to three days, so the last days may have no organic rows yet.
            recent_days_may_be_missing: to! >= today - finalDataLagDays * dayMs,
          },
          organic_pages: pages
            ? {
                provider: 'search_console',
                dimensions: ['query', 'page'],
                aggregation: 'by_page',
                rows: pages.length,
                top_rows_only: pagesTop,
                pages_per_query: pagesPerQuery,
              }
            : null,
          paid: {
            provider: 'google_ads',
            resource: 'search_term_view',
            dates: 'Google Ads account time zone days',
            rows: paid.length,
            top_rows_only: paidTop,
          },
        },
        complete: !organicTop && !pagesTop && !paidTop,
        ...table,
        source_references: [
          {provider: 'search_console', request: gscRequest, source_hash: fingerprint(organic)},
          ...(pages ? [{provider: 'search_console', request: pageRequest, source_hash: fingerprint(pages)}] : []),
          {
            provider: 'google_ads',
            request: {resource: 'customers/' + account + '/googleAds:search', query: adsQuery},
            source_hash: fingerprint(paid),
          },
        ],
        source_hash: fingerprint({scope, organic, pages: pages ?? null, paid, requestedAt, capturedAt}),
        next_steps: [
          'Exact negative keywords: capture a guided Google search-term report for these dates (amcp_reporting capture_preset google_search_terms), then search_exclusion_candidates and preview_search_exclusions with search_term_views as ids (reviewed plan).',
          'New keywords: prepare them through amcp_write with native review.',
        ],
        provider_mutations: 0,
        retained_snapshot: false,
        meaning:
          'Search Console queries and Google Ads search terms for the same dates, joined on normalized text. Matching is approximate: the providers match queries differently, Search Console omits anonymized queries and both report top rows, and their days use different time zones. Search Console final data may still lack the most recent days. Top pages rank the landing pages of a query; their by-page metrics do not add up to the query totals. review_hint marks rows worth reviewing, never a change to make. Nothing was saved or changed.',
      };
    });
  } finally {
    budget.close();
  }
}
