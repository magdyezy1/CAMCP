import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {ScopeGuard} from './scope.js';
import {snapchatScope} from './provider-grants.js';
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
 * The Snapchat adapter of the measurement evidence ledger (MSR-03 slice D, owner direction P8). Read-only; no Conversions
 * API event, no /events/validate call and no write. Contracts read from Snap's Marketing API references on 2026-10-11:
 * - "Snap Pixel": GET /v1/adaccounts/{ad_account_id}/pixels ({request_status, pixels: [{sub_request_status, pixel: {id,
 *   name, ad_account_id, status, effective_status, created_at, updated_at, pixel_javascript}]}); the list is the
 *   configuration layer and the ownership evidence ScopeGuard already learns (pixels/{id}). The snippet is never kept.
 * - "Get Pixel Domain Stats": GET /v1/pixels/{pixel_id}/domains/stats, "the domains that have fired the pixel in the
 *   past 7 days" (timeseries_stats[].timeseries_stat {id, type PIXEL, start_time, end_time, domains: [{domain_name,
 *   total_events}]}). Per-domain hourly stats need a domain and are not read.
 * - "Signal Readiness API": GET /v1/pixels/{pixel_id}/event_quality_scores (event_quality_scores[].event_quality_score
 *   {action_source WEB|OFFLINE|MOBILE_APP, event_source API|SDK|MMP, event_type, recommendations: [{title, description,
 *   recommendation_code, priority P0|P1|P2, score GOOD|OKAY|BAD}]}). Snap intends it for internal monitoring and asks for
 *   review before any public display; AMCP shows it only to signed-in members of the workspace.
 */
const gateway = 'snapchat_native_action',
  origin = 'https://adsapi.snapchat.com';
const snapId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);
const snapTime = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
const plan = (account: string, action: string, path: string): CompiledRequest => ({
  gateway,
  accountId: account,
  action,
  origin,
  method: 'GET',
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'Measurement ledger read of one selected Snapchat ad account and its pixel',
  warnings: [],
});
const permitted = (c: Connection) => {
  if (!c.scopes.includes(snapchatScope))
    bad('Reading Snapchat pixels requires the snapchat-marketing-api permission.', 'INSUFFICIENT_SCOPE');
};
/** Snap's own envelope: SUCCESS overall and for every wrapped item, never a partial answer. */
function envelope(data: JsonObject, collection: string) {
  if (
    String(data.request_status).toUpperCase() !== 'SUCCESS' ||
    !Array.isArray(data[collection]) ||
    (data.paging !== undefined && (!obj(data.paging) || (data.paging as JsonObject).next_link !== undefined))
  )
    invalid('Snapchat returned a failed, partial or paged measurement response.');
  return (data[collection] as unknown[]).map(item => {
    if (!obj(item) || String(item.sub_request_status).toUpperCase() !== 'SUCCESS')
      invalid('Snapchat returned a failed or malformed item.');
    return item as JsonObject;
  });
}

async function pixels(context: ReadContext) {
  const read = plan(context.account, 'snapchat_pixel_list', '/v1/adaccounts/' + context.account + '/pixels'),
    data = await ledgerRead(context, read),
    seen = new Set<string>();
  const rows = envelope(data, 'pixels').map(item => {
    const p = item.pixel;
    if (
      !obj(p) ||
      !snapId(p.id) ||
      seen.has(p.id) ||
      (p.ad_account_id !== undefined && p.ad_account_id !== context.account) ||
      (p.name !== undefined && !text(p.name)) ||
      ['status', 'effective_status'].some(k => p[k] !== undefined && !/^[A-Z_]{1,32}$/.test(String(p[k]))) ||
      ['created_at', 'updated_at'].some(k => p[k] !== undefined && !snapTime(p[k]))
    )
      invalid('A Snapchat pixel is malformed, repeated or belongs to another ad account.');
    seen.add(p.id as string);
    return {
      id: p.id,
      name: p.name ?? null,
      status: p.status ?? null,
      effective_status: p.effective_status ?? null,
      created_at: p.created_at ?? null,
      updated_at: p.updated_at ?? null,
    };
  });
  if (rows.length > 100) invalid('The ad account lists more pixels than one ledger reads.');
  context.budget.rows('pixels', rows.length);
  // Ownership of each listed pixel (pixels/{id}) is learned from the validated list, as for any account pixel read.
  new ScopeGuard(context.registry, context.store).observe(read, context.connection, data);
  context.references.push(ledgerReference('pixels', read, [pageReference(0, rows.length, data)], rows.length));
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** The domains that fired the pixel in the past seven days, with their event totals. */
async function domains(context: ReadContext, pixel: string) {
  const read = plan(context.account, 'snapchat_pixel_domain_stats', '/v1/pixels/' + pixel + '/domains/stats'),
    data = await ledgerRead(context, read),
    items = envelope(data, 'timeseries_stats');
  if (items.length !== 1) invalid('Snapchat returned pixel domain statistics for more or fewer than one pixel.');
  const stat = items[0]!.timeseries_stat;
  if (
    !obj(stat) ||
    stat.id !== pixel ||
    stat.type !== 'PIXEL' ||
    (stat.start_time !== undefined && !snapTime(stat.start_time)) ||
    (stat.end_time !== undefined && !snapTime(stat.end_time)) ||
    !Array.isArray(stat.domains) ||
    stat.domains.length > 500
  )
    invalid('Snapchat pixel domain statistics are foreign, partial or malformed.');
  const seen = new Set<string>(),
    rows = (stat.domains as unknown[]).map(d => {
      if (
        !obj(d) ||
        !keysWithin(d, ['domain_name', 'total_events']) ||
        typeof d.domain_name !== 'string' ||
        !/^[A-Za-z0-9.-]{1,253}$/.test(d.domain_name) ||
        seen.has(d.domain_name.toLowerCase()) ||
        !count(d.total_events)
      )
        invalid('A Snapchat pixel domain is malformed or repeated.');
      seen.add((d.domain_name as string).toLowerCase());
      return {domain_name: d.domain_name as string, total_events: d.total_events as number};
    });
  context.budget.rows('domain_stats', rows.length);
  context.references.push(
    ledgerReference('pixel_domain_stats', read, [pageReference(0, rows.length, data)], rows.length),
  );
  rows.sort((a, b) => b.total_events - a.total_events || a.domain_name.localeCompare(b.domain_name));
  return {
    window_days: 7,
    start_time: stat.start_time ?? null,
    end_time: stat.end_time ?? null,
    domains: rows.slice(0, 20),
    domain_count: rows.length,
    total_events: rows.reduce((sum, d) => sum + d.total_events, 0),
  };
}

const actionSources = ['WEB', 'OFFLINE', 'MOBILE_APP'],
  eventSources = ['API', 'SDK', 'MMP'],
  priorities = ['P0', 'P1', 'P2'],
  scores = ['GOOD', 'OKAY', 'BAD'];
/** The Signal Readiness scores and recommendations of the pixel; free-text descriptions are not kept. */
async function readiness(context: ReadContext, pixel: string) {
  const read = plan(
      context.account,
      'snapchat_pixels_pixel_id_event_quality_scores_get',
      '/v1/pixels/' + pixel + '/event_quality_scores',
    ),
    data = await ledgerRead(context, read),
    items = envelope(data, 'event_quality_scores');
  if (items.length > 100) invalid('Snapchat returned more event quality scores than one ledger reads.');
  const rows = items.map(item => {
    const s = item.event_quality_score;
    if (
      !obj(s) ||
      !actionSources.includes(s.action_source) ||
      !eventSources.includes(s.event_source) ||
      typeof s.event_type !== 'string' ||
      !/^[A-Z0-9_]{1,64}$/.test(s.event_type) ||
      !Array.isArray(s.recommendations) ||
      s.recommendations.length > 50
    )
      invalid('A Snapchat event quality score is malformed or outside the pinned values.');
    return {
      action_source: s.action_source,
      event_source: s.event_source,
      event_type: s.event_type,
      recommendations: (s.recommendations as unknown[]).map(r => {
        if (
          !obj(r) ||
          typeof r.recommendation_code !== 'string' ||
          !/^[A-Z0-9_]{1,64}$/.test(r.recommendation_code) ||
          !priorities.includes(r.priority) ||
          !scores.includes(r.score) ||
          (r.title !== undefined && !text(r.title, 300))
        )
          invalid('A Snapchat recommendation is malformed or outside the pinned values.');
        return {
          recommendation_code: r.recommendation_code,
          priority: r.priority,
          score: r.score,
          title: r.title ?? null,
        };
      }),
    };
  });
  context.budget.rows('event_quality_scores', rows.length);
  context.references.push(
    ledgerReference('event_quality_scores', read, [pageReference(0, rows.length, data)], rows.length),
  );
  return rows.sort(
    (a, b) =>
      a.event_type.localeCompare(b.event_type) ||
      a.action_source.localeCompare(b.action_source) ||
      a.event_source.localeCompare(b.event_source),
  );
}

export async function snapchatLedger({
  store,
  registry,
  transport,
  credentials,
  actor,
  input,
  ledger,
}: LedgerInput): Promise<LedgerOut> {
  const account = input.account_id;
  if (!snapId(account)) bad('Choose the exact Snapchat ad account ID.');
  const requested = (input.requirements as JsonObject | undefined)?.pixel_id as string | undefined;
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  new ScopeGuard(registry, store).authorize(
    plan(account, 'snapchat_pixel_list', '/v1/adaccounts/' + account + '/pixels'),
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
    layers.push(
      await guarded('configuration', fence, ledger, () =>
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
                'The pixels the ad account lists, with their status.',
              )
            : layer(
                'configuration',
                'not_applicable',
                'no_pixels',
                {pixels: [], pixel_count: 0, selected_pixel: null},
                'The ad account lists no pixel.',
              );
        }),
      ),
    );
    fence();
    const pixel = selection?.pixel;
    if (!listed || !selection)
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
    else if (!pixel)
      layers.push(
        unselected('provider_observed_activity', selection.reason!),
        unselected('provider_diagnostics', selection.reason!),
      );
    else {
      layers.push(
        await guarded('provider_observed_activity', fence, ledger, () =>
          budget.run(async () => {
            const observed = await domains(context, pixel);
            return observed.total_events > 0
              ? layer(
                  'provider_observed_activity',
                  'observed',
                  'pixel_domains_reported',
                  observed,
                  'Snapchat reported the domains that fired the pixel in the past 7 days and their event totals.',
                )
              : layer(
                  'provider_observed_activity',
                  'unknown',
                  'no_recent_events',
                  observed,
                  'Snapchat reported no pixel event in the past 7 days. Absence does not establish a broken pixel.',
                );
          }),
        ),
      );
      fence();
      layers.push(
        await guarded('provider_diagnostics', fence, ledger, () =>
          budget.run(async () => {
            const rows = await readiness(context, pixel);
            return rows.length
              ? layer(
                  'provider_diagnostics',
                  'observed',
                  'signal_readiness',
                  {scores: rows.slice(0, 20), score_count: rows.length},
                  'Snapchat Signal Readiness recommendations by event type, with their priority and score.',
                )
              : layer(
                  'provider_diagnostics',
                  'unknown',
                  'no_quality_data',
                  {scores: [], score_count: 0},
                  'Snapchat reported no signal readiness score for this pixel.',
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
    layers: [layers[0]!, layers[1]!, layers[2]!, trace(), noConsentSource('Snapchat'), notPixelSetting()],
    source_references: references,
  };
}
