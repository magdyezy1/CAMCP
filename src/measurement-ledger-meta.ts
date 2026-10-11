import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {metaPrefix} from './meta-version.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {bad, obj} from './workspace-core.js';
import {
  count,
  guarded,
  invalid,
  keysWithin,
  layer,
  ledgerBudget,
  ledgerFence,
  ledgerRead,
  ledgerReference,
  noConsentSource,
  notPixelSetting,
  pageReference,
  percentage,
  selectPixel,
  text,
  trace,
  unselected,
  type Layer,
  type LedgerInput,
  type LedgerOut,
  type ReadContext,
} from './measurement-ledger-core.js';

/**
 * The Meta adapter of the measurement evidence ledger (MSR-03 slice C, owner direction P8). Read-only; no test event,
 * no Conversions API call and no write. Contracts read from Meta's primary references on 2026-10-11:
 * - "Ad Account Adspixels" (GET /act_{ad_account_id}/adspixels: a list of AdsPixel nodes with paging) and "Ads Pixel"
 *   (fields id, name, owner_business, creation_time, last_fired_time "Time at which the pixel was last fired",
 *   is_unavailable). The list is the configuration layer and the ownership evidence (meta-dataset-scope.ts).
 * - "Ads Pixel Stats" (GET /{ads_pixel_id}/stats, aggregation=event, start_time, end_time; data "up to seven days from
 *   the request time"; results of {aggregation, data, start_time} per hour, where data is the "Field value and number
 *   of times the pixel fired with the value"). The value/count names of each entry are not spelled out in the
 *   reference; any other entry shape is refused, so the layer stays unknown until a native read under ACC-06 confirms it.
 * - "Dataset Quality API" (GET /dataset_quality?dataset_id=...&fields=web{...}: per web event, event_match_quality
 *   {composite_score out of 10, match_key_feedback}, event_coverage, dedupe_key_feedback, data_freshness and acr).
 *   Only numeric aggregates and native codes are requested; Meta's descriptions and diagnostics texts are not. EMQ covers
 *   web events only, and the API needs basic or full Marketing API access (ACC-05).
 */
const gateway = 'meta_native_action',
  maxPages = 5,
  pixelFields = ['id', 'name', 'owner_business', 'creation_time', 'last_fired_time', 'is_unavailable'],
  qualityFields =
    'web{event_name,event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}}},event_coverage{percentage,goal_percentage},dedupe_key_feedback{dedupe_key,browser_events_with_dedupe_key{percentage},server_events_with_dedupe_key{percentage},overall_browser_coverage_from_dedupe_key{percentage}},data_freshness{upload_frequency},acr{percentage}}',
  statsHours = 24;
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const metaTime = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')));
const nativeCode = (v: unknown, max = 64): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(v) && v.length <= max;
const plan = (account: string, path: string, query: JsonObject): CompiledRequest => ({
  gateway,
  accountId: account,
  action: 'AMCP_MEASUREMENT_LEDGER',
  method: 'GET',
  path,
  query,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'Measurement ledger read of one selected Meta ad account and its pixel',
  warnings: [],
});
const permitted = (c: Connection) => {
  if (!c.scopes.some(s => s === 'ads_read' || s === 'ads_management'))
    bad('Reading Meta pixels requires ads_read or ads_management.', 'INSUFFICIENT_SCOPE');
};
const percent = (v: unknown) => {
  if (v === undefined) return null;
  if (!obj(v) || !keysWithin(v, ['percentage', 'description']) || !percentage(v.percentage))
    invalid('A Meta dataset quality percentage is malformed or out of range.');
  return (v as JsonObject).percentage as number;
};

/** Every pixel the ad account lists, from complete pages; ownership of each is learned for this connection. */
async function pixels(context: ReadContext) {
  const base = plan(context.account, metaPrefix + 'act_' + context.account + '/adspixels', {
      fields: pixelFields.join(','),
      limit: 100,
    }),
    rows: JsonObject[] = [],
    seen = new Set<string>(),
    pages: JsonObject[] = [],
    cursors = new Set<string>();
  let after: string | undefined,
    last: CompiledRequest = base;
  for (let page = 0; ; page++) {
    if (page >= maxPages) invalid('The ad account lists more pixels than one ledger reads.');
    last = {...base, query: {...base.query, ...(after ? {after} : {})}};
    const data = await ledgerRead(context, last);
    if (!keysWithin(data, ['data', 'paging', 'summary']) || !Array.isArray(data.data))
      invalid('Meta returned a partial or unrecognized pixel list.');
    for (const row of data.data as unknown[]) {
      const r = obj(row) ? row : invalid('A Meta pixel row is malformed.');
      if (
        !keysWithin(r, pixelFields) ||
        !numeric(r.id) ||
        seen.has(r.id) ||
        (r.name !== undefined && !text(r.name)) ||
        (r.owner_business !== undefined &&
          (!obj(r.owner_business) || !keysWithin(r.owner_business, ['id', 'name']) || !numeric(r.owner_business.id))) ||
        (r.creation_time !== undefined && !metaTime(r.creation_time)) ||
        (r.last_fired_time !== undefined && !metaTime(r.last_fired_time)) ||
        (r.is_unavailable !== undefined && typeof r.is_unavailable !== 'boolean')
      )
        invalid('A Meta pixel row is malformed, repeated or outside the requested fields.');
      seen.add(r.id as string);
      rows.push({
        id: r.id,
        name: r.name ?? null,
        owner_business: obj(r.owner_business) ? r.owner_business.id : null,
        creation_time: r.creation_time ?? null,
        last_fired_time: r.last_fired_time ?? null,
        is_unavailable: r.is_unavailable ?? null,
      });
    }
    context.budget.rows('adspixels:' + page, (data.data as unknown[]).length);
    pages.push(pageReference(page, (data.data as unknown[]).length, data));
    // Ownership is learned from each validated page of the account's own list (ScopeGuard.observe).
    new ScopeGuard(context.registry, context.store).observe(last, context.connection, data);
    const paging = data.paging,
      next =
        obj(paging) && paging.next !== undefined && obj(paging.cursors)
          ? (paging.cursors as JsonObject).after
          : undefined;
    if (paging !== undefined && !obj(paging)) invalid('Meta pixel pagination is malformed.');
    if (next === undefined) break;
    if (typeof next !== 'string' || !next || next.length > 1024 || cursors.has(next) || !(data.data as []).length)
      invalid('Meta pixel pagination is malformed, repeated or incomplete.');
    cursors.add(next);
    after = next;
  }
  context.references.push(ledgerReference('adspixels', base, pages, rows.length));
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Hourly event counts of one pixel over the last 24 hours, summed per event name. */
async function stats(context: ReadContext, pixel: string) {
  const end = Math.floor(Date.now() / 3600000) * 3600,
    start = end - statsHours * 3600,
    base = plan(context.account, metaPrefix + pixel + '/stats', {
      aggregation: 'event',
      start_time: String(start),
      end_time: String(end),
    }),
    totals = new Map<string, bigint>(),
    buckets = new Set<string>(),
    pages: JsonObject[] = [],
    cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) invalid('Meta returned more pixel statistics than one ledger reads.');
    const data = await ledgerRead(context, {...base, query: {...base.query, ...(after ? {after} : {})}});
    if (!keysWithin(data, ['data', 'paging']) || !Array.isArray(data.data))
      invalid('Meta returned partial or unrecognized pixel statistics.');
    for (const result of data.data as unknown[]) {
      const r = obj(result) ? result : invalid('A Meta pixel statistics result is malformed.');
      const at = metaTime(r.start_time) ? Date.parse(r.start_time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
      if (
        !keysWithin(r, ['aggregation', 'data', 'start_time']) ||
        r.aggregation !== 'event' ||
        !Number.isFinite(at) ||
        at < (start - 3600) * 1000 ||
        at > end * 1000 ||
        buckets.has(String(at)) ||
        !Array.isArray(r.data) ||
        r.data.length > 500
      )
        invalid('A Meta pixel statistics hour is outside the requested window, repeated or malformed.');
      buckets.add(String(at));
      const names = new Set<string>();
      for (const entry of r.data as unknown[]) {
        const e = obj(entry) ? entry : invalid('A Meta pixel statistics entry is malformed.');
        const value = count(e.count)
          ? BigInt(e.count)
          : typeof e.count === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(e.count)
            ? BigInt(e.count)
            : undefined;
        if (!keysWithin(e, ['value', 'count']) || !text(e.value, 100) || value === undefined || names.has(e.value))
          invalid('A Meta pixel statistics entry is malformed or repeated.');
        names.add(e.value as string);
        totals.set(e.value as string, (totals.get(e.value as string) ?? 0n) + value!);
      }
    }
    context.budget.rows('stats:' + page, (data.data as unknown[]).length);
    pages.push(pageReference(page, (data.data as unknown[]).length, data));
    const paging = data.paging,
      next =
        obj(paging) && paging.next !== undefined && obj(paging.cursors)
          ? (paging.cursors as JsonObject).after
          : undefined;
    if (next === undefined) break;
    if (typeof next !== 'string' || !next || next.length > 1024 || cursors.has(next) || !(data.data as []).length)
      invalid('Meta pixel statistics pagination is malformed, repeated or incomplete.');
    cursors.add(next);
    after = next;
  }
  context.references.push(ledgerReference('ads_pixel_stats', base, pages, buckets.size));
  const events = [...totals]
    .filter(([, n]) => n > 0n)
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
    .map(([event_name, n]) => ({event_name, count: n.toString()}));
  return {
    window_hours: statsHours,
    hours_reported: buckets.size,
    events: events.slice(0, 20),
    event_count: events.length,
  };
}

/** The dataset quality aggregates of the selected dataset's web events. */
async function quality(context: ReadContext, pixel: string) {
  const base = plan(context.account, metaPrefix + 'dataset_quality', {dataset_id: pixel, fields: qualityFields}),
    data = await ledgerRead(context, base);
  if (
    !keysWithin(data, ['web']) ||
    (data.web !== undefined && !Array.isArray(data.web)) ||
    (data.web ?? []).length > 200
  )
    invalid('Meta returned partial or unrecognized dataset quality.');
  const seen = new Set<string>(),
    events = ((data.web ?? []) as unknown[]).map(item => {
      const e = obj(item) ? item : invalid('A Meta dataset quality event is malformed.');
      if (
        !keysWithin(e, [
          'event_name',
          'event_match_quality',
          'event_coverage',
          'dedupe_key_feedback',
          'data_freshness',
          'acr',
        ]) ||
        !text(e.event_name, 100) ||
        seen.has(e.event_name)
      )
        invalid('A Meta dataset quality event is malformed or repeated.');
      seen.add(e.event_name as string);
      const emq = e.event_match_quality,
        coverage = e.event_coverage,
        freshness = e.data_freshness;
      if (
        (emq !== undefined &&
          (!obj(emq) ||
            !keysWithin(emq, ['composite_score', 'match_key_feedback']) ||
            (emq.composite_score !== undefined &&
              (typeof emq.composite_score !== 'number' ||
                !Number.isFinite(emq.composite_score) ||
                emq.composite_score < 0 ||
                emq.composite_score > 10)) ||
            (emq.match_key_feedback !== undefined &&
              (!Array.isArray(emq.match_key_feedback) || emq.match_key_feedback.length > 50)))) ||
        (coverage !== undefined &&
          (!obj(coverage) || !keysWithin(coverage, ['percentage', 'goal_percentage', 'description']))) ||
        (e.dedupe_key_feedback !== undefined &&
          (!Array.isArray(e.dedupe_key_feedback) || e.dedupe_key_feedback.length > 20)) ||
        (freshness !== undefined &&
          (!obj(freshness) ||
            !keysWithin(freshness, ['upload_frequency', 'description']) ||
            (freshness.upload_frequency !== undefined && !nativeCode(freshness.upload_frequency, 32))))
      )
        invalid('A Meta dataset quality metric is malformed or out of range.');
      const keys = new Set<string>(),
        matchKeys = ((obj(emq) ? emq.match_key_feedback : undefined) ?? []).map((k: unknown) => {
          if (
            !obj(k) ||
            !keysWithin(k, ['identifier', 'coverage']) ||
            !nativeCode(k.identifier) ||
            keys.has(k.identifier)
          )
            invalid('A Meta match key is malformed or repeated.');
          keys.add((k as JsonObject).identifier);
          return {identifier: (k as JsonObject).identifier, coverage_percentage: percent((k as JsonObject).coverage)};
        }),
        dedupe = new Set<string>(),
        dedupeKeys = ((e.dedupe_key_feedback ?? []) as unknown[]).map(k => {
          if (
            !obj(k) ||
            !keysWithin(k, [
              'dedupe_key',
              'browser_events_with_dedupe_key',
              'server_events_with_dedupe_key',
              'overall_browser_coverage_from_dedupe_key',
            ]) ||
            !nativeCode(k.dedupe_key) ||
            dedupe.has(k.dedupe_key)
          )
            invalid('A Meta deduplication key is malformed or repeated.');
          dedupe.add(k.dedupe_key as string);
          return {
            dedupe_key: k.dedupe_key,
            browser_percentage: percent(k.browser_events_with_dedupe_key),
            server_percentage: percent(k.server_events_with_dedupe_key),
            overall_browser_coverage_percentage: percent(k.overall_browser_coverage_from_dedupe_key),
          };
        });
      return {
        event_name: e.event_name,
        composite_score: obj(emq) ? (emq.composite_score ?? null) : null,
        match_keys: matchKeys.slice(0, 20),
        event_coverage_percentage: obj(coverage) ? percent({percentage: coverage.percentage}) : null,
        event_coverage_goal_percentage:
          obj(coverage) && coverage.goal_percentage !== undefined
            ? percent({percentage: coverage.goal_percentage})
            : null,
        dedupe_keys: dedupeKeys,
        upload_frequency: obj(freshness) ? (freshness.upload_frequency ?? null) : null,
        acr_percentage: percent(e.acr),
      };
    });
  context.budget.rows('dataset_quality', events.length);
  context.references.push(
    ledgerReference('dataset_quality', base, [pageReference(0, events.length, data)], events.length),
  );
  return events.sort((a, b) => String(a.event_name).localeCompare(String(b.event_name)));
}

export async function metaLedger({
  store,
  registry,
  transport,
  credentials,
  actor,
  input,
  ledger,
}: LedgerInput): Promise<LedgerOut> {
  const account = normalizeAccount(gateway, input.account_id);
  if (typeof input.account_id !== 'string' || !numeric(account)) bad('Choose the exact numeric Meta ad account ID.');
  const requested = (input.requirements as JsonObject | undefined)?.pixel_id as string | undefined;
  if (requested !== undefined && !numeric(requested)) bad('Choose the exact numeric Meta pixel or dataset ID.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  new ScopeGuard(registry, store).authorize(
    plan(account, metaPrefix + 'act_' + account + '/adspixels', {}),
    connection,
  );
  const fence = ledgerFence(store, actor, gateway, account, connection, permitted);
  fence();
  const auth = (await credentials.get(connection)) as unknown as JsonObject;
  fence();
  const references: JsonObject[] = [],
    budget = ledgerBudget(ledger, gateway),
    context: ReadContext = {store, registry, transport, actor, connection, auth, account, fence, budget, references};
  let listed: JsonObject[] | undefined, selection: ReturnType<typeof selectPixel> | undefined;
  const layers: Layer[] = [];
  try {
    const configuration = await guarded('configuration', fence, ledger, () =>
      budget.run(async () => {
        listed = await pixels(context);
        selection = selectPixel(
          listed.map(p => p.id as string),
          requested,
        );
        return listed.length
          ? layer(
              'configuration',
              'observed',
              'pixels_listed',
              {pixels: listed.slice(0, 20), pixel_count: listed.length, selected_pixel: selection.pixel ?? null},
              'The pixels (datasets) the ad account lists, with their last fire time as Meta reports it.',
            )
          : layer(
              'configuration',
              'not_applicable',
              'no_pixels',
              {pixels: [], pixel_count: 0, selected_pixel: null},
              'The ad account lists no pixel.',
            );
      }),
    );
    fence();
    layers.push(configuration);
    const pixel = selection?.pixel;
    if (!listed || !selection) {
      layers.push(
        layer(
          'provider_observed_activity',
          'unknown',
          'configuration_unknown',
          null,
          'Without the pixel list, no pixel is read.',
        ),
        layer(
          'provider_diagnostics',
          'unknown',
          'configuration_unknown',
          null,
          'Without the pixel list, no pixel is read.',
        ),
      );
    } else if (!pixel) {
      layers.push(
        unselected('provider_observed_activity', selection.reason!),
        unselected('provider_diagnostics', selection.reason!),
      );
    } else {
      const row = listed.find(p => p.id === pixel)!;
      layers.push(
        await guarded('provider_observed_activity', fence, ledger, () =>
          budget.run(async () => {
            const observed = {...(await stats(context, pixel)), last_fired_time: row.last_fired_time};
            return observed.event_count
              ? layer(
                  'provider_observed_activity',
                  'observed',
                  'pixel_events_reported',
                  observed,
                  'Meta reported pixel events by event name in the last 24 hours.',
                )
              : layer(
                  'provider_observed_activity',
                  'unknown',
                  'no_recent_events',
                  observed,
                  'Meta reported no pixel event in the last 24 hours. Absence does not establish a broken pixel.',
                );
          }),
        ),
      );
      fence();
      layers.push(
        await guarded('provider_diagnostics', fence, ledger, () =>
          budget.run(async () => {
            const events = await quality(context, pixel);
            return events.length
              ? layer(
                  'provider_diagnostics',
                  'observed',
                  'dataset_quality',
                  {events: events.slice(0, 20), event_count: events.length},
                  'Meta dataset quality of web events: match quality, Conversions API coverage, deduplication keys and freshness.',
                )
              : layer(
                  'provider_diagnostics',
                  'unknown',
                  'no_quality_data',
                  {events: [], event_count: 0},
                  'Meta reported no dataset quality for web events of this dataset.',
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
    scope: {gateway, connection_id: connection.id, account_id: account, pixel_id: selection?.pixel ?? null},
    layers: [layers[0]!, layers[1]!, layers[2]!, trace(), noConsentSource('Meta'), notPixelSetting()],
    source_references: references,
  };
}
