import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {ScopeGuard} from './scope.js';
import {providerGrant, missingScopes} from './provider-grants.js';
import {bad, obj} from './workspace-core.js';
import {
  guarded,
  invalid,
  keysWithin,
  layer,
  ledgerBudget,
  ledgerFence,
  ledgerRead,
  ledgerReference,
  pageReference,
  trace,
  type Layer,
  type LedgerInput,
  type LedgerOut,
  type ReadContext,
} from './measurement-ledger-core.js';

/**
 * The Search Console adapter of the measurement evidence ledger (MSR-03, owner direction P8). Read-only: two GETs and
 * one POST query the pinned Search Console API v1 document (.mirror/VENDOR/search-console-v1.json) marks read-only.
 * The wire values follow Google's public reference (sites, sitemaps and searchanalytics.query, re-read 2026-10-12),
 * which spells them in camelCase ("siteOwner", "sitemap", "byProperty"); the pinned discovery document lists the
 * proto names (SITE_OWNER...), which the API does not return. AMCP's qualified Search Console reads
 * (google-measurement-assets.ts, measurement-writes.ts, report-native.ts) use the same wire values.
 * - Configuration: sites.get (siteUrl and the login's permissionLevel; an unverified user has no data access).
 * - Provider-observed activity: searchAnalytics.query of the last seven complete days in Search Console's time zone
 *   (America/Los_Angeles), grouped by date, dataState final and aggregationType byProperty: clicks and impressions per
 *   day. Final data lags by a few days, so an absent day is not reported as zero.
 * - Provider diagnostics: sitemaps.list (errors, warnings, pending state and last download).
 * Search Console has no consent setting and attributes no conversions.
 */
const gateway = 'google_search_console_native_action',
  origin = 'https://searchconsole.googleapis.com',
  windowDays = 7,
  permissionLevels = ['siteOwner', 'siteFullUser', 'siteRestrictedUser', 'siteUnverifiedUser'],
  sitemapTypes = ['atomFeed', 'notSitemap', 'patternSitemap', 'rssFeed', 'sitemap', 'urlList'],
  contentTypes = ['androidApp', 'image', 'iosApp', 'mobile', 'news', 'pattern', 'video', 'web'];
const pinned = (values: string[], value: unknown) => typeof value === 'string' && values.includes(value);
const int64 = (v: unknown): v is string => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(v);
const googleTime = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(v) &&
  Number.isFinite(Date.parse(v));
function siteUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048 || /[\x00-\x20\\]/.test(v)) return false;
  if (/^sc-domain:[^/?#]+$/.test(v)) return true;
  if (!/^https?:\/\//.test(v)) return false;
  try {
    const url = new URL(v);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}
const plan = (site: string, action: string, method: string, suffix: string, body?: JsonObject): CompiledRequest => ({
  gateway,
  accountId: site,
  action,
  origin,
  method,
  path: '/webmasters/v3/sites/' + encodeURIComponent(site) + suffix,
  query: {},
  ...(body ? {body} : {}),
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'Measurement ledger read of one selected Search Console site',
  warnings: [],
});
const permitted = (c: Connection) => {
  if (missingScopes(providerGrant(gateway)!.read!, c.scopes).length)
    bad('Reading Search Console requires the webmasters.readonly permission.', 'INSUFFICIENT_SCOPE');
};
/** A calendar date in Search Console's time zone, days before today. */
function pacificDate(daysAgo: number) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(today + 'T00:00:00Z') - daysAgo * 86400000).toISOString().slice(0, 10);
}

async function site(context: ReadContext) {
  const read = plan(context.account, 'gsc_site_ops/GET_SITE', 'GET', ''),
    data = await ledgerRead(context, read);
  if (
    !keysWithin(data, ['siteUrl', 'permissionLevel']) ||
    data.siteUrl !== context.account ||
    !pinned(permissionLevels, data.permissionLevel)
  )
    invalid('Search Console returned another site or an unrecognized permission level.');
  context.references.push(ledgerReference('site', read, [pageReference(0, 1, data)], 1));
  return {site_url: data.siteUrl as string, permission_level: data.permissionLevel as string};
}

async function searchTotals(context: ReadContext) {
  const start = pacificDate(windowDays),
    end = pacificDate(1),
    body = {
      startDate: start,
      endDate: end,
      dimensions: ['date'],
      type: 'web',
      dataState: 'final',
      aggregationType: 'byProperty',
      rowLimit: 25,
    },
    read = plan(context.account, 'gsc_analytics_ops/QUERY_SEARCH_ANALYTICS', 'POST', '/searchAnalytics/query', body),
    data = await ledgerRead(context, read);
  if (
    !keysWithin(data, ['rows', 'responseAggregationType', 'metadata']) ||
    (data.rows !== undefined && !Array.isArray(data.rows)) ||
    (data.responseAggregationType !== undefined && data.responseAggregationType !== 'byProperty') ||
    (data.metadata !== undefined && !obj(data.metadata))
  )
    invalid('Search Console returned partial or differently aggregated search totals.');
  const seen = new Set<string>(),
    days = ((data.rows ?? []) as unknown[]).map(row => {
      const r = obj(row) ? row : invalid('A Search Console row is malformed.');
      const date = Array.isArray(r.keys) && r.keys.length === 1 ? r.keys[0] : undefined;
      if (
        !keysWithin(r, ['keys', 'clicks', 'impressions', 'ctr', 'position']) ||
        typeof date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        date < start ||
        date > end ||
        seen.has(date) ||
        !Number.isSafeInteger(r.clicks) ||
        r.clicks < 0 ||
        !Number.isSafeInteger(r.impressions) ||
        r.impressions < 0 ||
        r.clicks > r.impressions
      )
        invalid('A Search Console day is outside the requested window, repeated or malformed.');
      seen.add(date);
      return {date, clicks: r.clicks as number, impressions: r.impressions as number};
    });
  if (days.length > windowDays) invalid('Search Console returned more days than requested.');
  context.budget.rows('search_analytics', days.length);
  context.references.push(
    ledgerReference('search_analytics', read, [pageReference(0, days.length, data)], days.length),
  );
  days.sort((a, b) => a.date.localeCompare(b.date));
  return {
    start_date: start,
    end_date: end,
    time_zone: 'America/Los_Angeles',
    data_state: 'final',
    days_reported: days.length,
    clicks: days.reduce((n, d) => n + d.clicks, 0),
    impressions: days.reduce((n, d) => n + d.impressions, 0),
    days,
  };
}

const sitemapFields = [
  'path',
  'type',
  'isPending',
  'isSitemapsIndex',
  'lastSubmitted',
  'lastDownloaded',
  'errors',
  'warnings',
  'contents',
];
async function sitemaps(context: ReadContext) {
  const read = plan(context.account, 'gsc_site_ops/LIST_SITEMAPS', 'GET', '/sitemaps'),
    data = await ledgerRead(context, read);
  if (
    !keysWithin(data, ['sitemap']) ||
    (data.sitemap !== undefined && !Array.isArray(data.sitemap)) ||
    (data.sitemap ?? []).length > 1000
  )
    invalid('Search Console returned a partial or unrecognized sitemap list.');
  const seen = new Set<string>(),
    rows = ((data.sitemap ?? []) as unknown[]).map(item => {
      const s = obj(item) ? item : invalid('A Search Console sitemap is malformed.');
      if (
        !keysWithin(s, sitemapFields) ||
        typeof s.path !== 'string' ||
        !/^https?:\/\//.test(s.path) ||
        s.path.length > 2048 ||
        /[\x00-\x20\\]/.test(s.path) ||
        seen.has(s.path) ||
        (s.type !== undefined && !pinned(sitemapTypes, s.type)) ||
        ['isPending', 'isSitemapsIndex'].some(k => s[k] !== undefined && typeof s[k] !== 'boolean') ||
        ['lastSubmitted', 'lastDownloaded'].some(k => s[k] !== undefined && !googleTime(s[k])) ||
        ['errors', 'warnings'].some(k => s[k] !== undefined && !int64(s[k])) ||
        (s.contents !== undefined &&
          (!Array.isArray(s.contents) ||
            s.contents.some(
              (c: unknown) =>
                !obj(c) ||
                !keysWithin(c, ['type', 'submitted', 'indexed']) ||
                (c.type !== undefined && !pinned(contentTypes, c.type)) ||
                (c.submitted !== undefined && !int64(c.submitted)) ||
                (c.indexed !== undefined && !int64(c.indexed)),
            )))
      )
        invalid('A Search Console sitemap is malformed, repeated or outside the pinned values.');
      seen.add(s.path as string);
      return {
        path: s.path as string,
        type: s.type ?? null,
        is_pending: s.isPending ?? null,
        is_sitemaps_index: s.isSitemapsIndex ?? null,
        last_submitted: s.lastSubmitted ?? null,
        last_downloaded: s.lastDownloaded ?? null,
        errors: s.errors ?? null,
        warnings: s.warnings ?? null,
      };
    });
  context.budget.rows('sitemaps', rows.length);
  context.references.push(ledgerReference('sitemaps', read, [pageReference(0, rows.length, data)], rows.length));
  rows.sort(
    (a, b) =>
      Number(b.errors !== null && b.errors !== '0') - Number(a.errors !== null && a.errors !== '0') ||
      a.path.localeCompare(b.path),
  );
  return rows;
}

export async function searchConsoleLedger({
  store,
  registry,
  transport,
  credentials,
  actor,
  input,
  ledger,
}: LedgerInput): Promise<LedgerOut> {
  const account = input.account_id;
  if (!siteUrl(account)) bad('Choose the exact Search Console site URL or sc-domain property.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  new ScopeGuard(registry, store).authorize(plan(account, 'gsc_site_ops/GET_SITE', 'GET', ''), connection);
  const fence = ledgerFence(store, actor, gateway, account, connection, permitted);
  fence();
  const auth = (await credentials.get(connection)) as unknown as JsonObject;
  fence();
  const references: JsonObject[] = [],
    budget = ledgerBudget(ledger, gateway),
    context: ReadContext = {store, registry, transport, actor, connection, auth, account, fence, budget, references};
  let permission: string | undefined;
  const layers: Layer[] = [];
  try {
    layers.push(
      await guarded('configuration', fence, ledger, () =>
        budget.run(async () => {
          const observed = await site(context);
          permission = observed.permission_level;
          return layer(
            'configuration',
            'observed',
            'site_permission',
            observed,
            'The site as Search Console lists it for this login, with the login’s permission level.',
          );
        }),
      ),
    );
    fence();
    if (!permission || permission === 'siteUnverifiedUser') {
      const reason = permission ? 'site_unverified' : 'configuration_unknown',
        note = permission
          ? 'An unverified user has no access to the site’s data, so nothing else is read.'
          : 'Without the site, nothing else is read.';
      layers.push(
        layer('provider_observed_activity', 'unknown', reason, null, note),
        layer('provider_diagnostics', 'unknown', reason, null, note),
      );
    } else {
      layers.push(
        await guarded('provider_observed_activity', fence, ledger, () =>
          budget.run(async () => {
            const totals = await searchTotals(context);
            return totals.days_reported
              ? layer(
                  'provider_observed_activity',
                  'observed',
                  'search_totals_reported',
                  totals,
                  'Final daily web search clicks and impressions of the site over the last seven complete days.',
                )
              : layer(
                  'provider_observed_activity',
                  'unknown',
                  'no_search_activity',
                  totals,
                  'Search Console reported no final search data for the last seven days. Data can lag by several days.',
                );
          }),
        ),
      );
      fence();
      layers.push(
        await guarded('provider_diagnostics', fence, ledger, () =>
          budget.run(async () => {
            const rows = await sitemaps(context);
            return rows.length
              ? layer(
                  'provider_diagnostics',
                  'observed',
                  'sitemaps_listed',
                  {
                    sitemaps: rows.slice(0, 20),
                    sitemap_count: rows.length,
                    with_errors: rows.filter(r => r.errors !== null && r.errors !== '0').length,
                    with_warnings: rows.filter(r => r.warnings !== null && r.warnings !== '0').length,
                    pending: rows.filter(r => r.is_pending === true).length,
                  },
                  'Submitted sitemaps with their errors, warnings, pending state and last download.',
                )
              : layer(
                  'provider_diagnostics',
                  'not_applicable',
                  'no_sitemaps',
                  {sitemaps: [], sitemap_count: 0},
                  'No sitemap is submitted for this site.',
                );
          }),
        ),
      );
      fence();
    }
  } finally {
    budget.close();
  }
  return {
    scope: {gateway, connection_id: connection.id, account_id: account},
    layers: [
      layers[0]!,
      layers[1]!,
      layers[2]!,
      trace(),
      layer(
        'consent',
        'not_applicable',
        'no_consent_setting',
        null,
        'Search Console reports search results and has no consent setting.',
      ),
      layer(
        'attribution_settings',
        'not_applicable',
        'no_attribution',
        null,
        'Search Console reports clicks and impressions and attributes no conversions.',
      ),
    ],
    source_references: references,
  };
}
