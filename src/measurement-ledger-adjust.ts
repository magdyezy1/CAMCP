import type {JsonObject} from './types.js';
import {adjustReporting} from './adjust-reporting.js';
import {bad, obj} from './workspace-core.js';
import {
  guarded,
  invalid,
  layer,
  ledgerFence,
  text,
  trace,
  type Layer,
  type LedgerInput,
  type LedgerOut,
} from './measurement-ledger-core.js';

/**
 * The Adjust adapter of the measurement evidence ledger (MSR-03, owner direction P8). It reuses the qualified Adjust
 * Report Service reads (src/adjust-reporting.ts): their app grant, source-IP rate permit, token fence, response bounds
 * and audit record. Read-only; no event is sent.
 * - Configuration: LIST_EVENTS of the selected app (its event catalog).
 * - Provider-observed activity: GET_REPORT of the last seven complete UTC days by day, with the installs and events
 *   metrics. A report with warnings or missing totals is incomplete and stays unknown.
 * Adjust offers AMCP no event diagnostics, consent setting or attribution-window read.
 */
const gateway = 'adjust_native_action',
  windowDays = 7;
const utcDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const decimal = (v: unknown) =>
  v === null || (typeof v === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v));

export async function adjustLedger({
  store,
  transport,
  credentials,
  actor,
  input,
  ledger,
}: LedgerInput): Promise<LedgerOut> {
  const app = input.account_id;
  if (typeof app !== 'string' || !/^[a-z0-9]{1,128}$/.test(app)) bad('Choose the exact Adjust app token.');
  const connection = store.resolveConnection(actor, gateway, app, input.connection_id);
  // Adjust tokens carry no scopes; the fence checks the actor, the app grant and the stored token.
  const fence = ledgerFence(store, actor, gateway, app, connection, () => {});
  fence();
  const requestId = 'measurement-ledger:' + ledger.slice(0, 32),
    read = async (action: string, payload: JsonObject) =>
      (await adjustReporting(
        store,
        transport,
        credentials,
        'adjust_reporting',
        {action, label: connection.id, payload},
        actor,
        requestId,
      )) as JsonObject;
  const references: JsonObject[] = [],
    layers: Layer[] = [];
  layers.push(
    await guarded('configuration', fence, ledger, async () => {
      const out = await read('LIST_EVENTS', {appTokens: [app]}),
        rows = Array.isArray(out.data) ? (out.data as unknown[]) : invalid('Adjust returned no event catalog.');
      const events = rows.map(row => {
        const r = obj(row) ? row : invalid('An Adjust event is malformed.');
        if (r.name !== undefined && r.name !== null && !text(r.name)) invalid('An Adjust event name is malformed.');
        return {id: r.id as string, name: (r.name as string | null | undefined) ?? null};
      });
      references.push({resource: 'events', request: out.request as JsonObject, rows: events.length});
      events.sort((a, b) => a.id.localeCompare(b.id));
      return layer(
        'configuration',
        'observed',
        'event_catalog',
        {events: events.slice(0, 20), event_count: events.length},
        'The events defined for the app in Adjust.',
      );
    }),
  );
  fence();
  layers.push(
    await guarded('provider_observed_activity', fence, ledger, async () => {
      const start = utcDate(windowDays),
        end = utcDate(1),
        out = await read('GET_REPORT', {
          request: {
            dimensions: ['day'],
            metrics: ['installs', 'events'],
            date_period: start + ':' + end,
            app_token__in: [app],
          },
        }),
        source = obj(out.data) ? (out.data as JsonObject) : invalid('Adjust returned no report.');
      const days = (source.rows as JsonObject[]).map(row => {
        if (!decimal(row.installs) || !decimal(row.events)) invalid('An Adjust report day is malformed.');
        return {day: row.day as string, installs: row.installs ?? null, events: row.events ?? null};
      });
      references.push({resource: 'report', request: out.request as JsonObject, rows: days.length});
      days.sort((a, b) => a.day.localeCompare(b.day));
      const evidence = {
        start_date: start,
        end_date: end,
        time_zone: 'UTC',
        days_reported: days.length,
        totals: {
          installs: obj(source.totals) ? (source.totals.installs ?? null) : null,
          events: obj(source.totals) ? (source.totals.events ?? null) : null,
        },
        days,
        warnings: Array.isArray(source.warnings) ? source.warnings.length : 0,
      };
      if (out.complete !== true)
        return layer(
          'provider_observed_activity',
          'unknown',
          'report_incomplete',
          {start_date: start, end_date: end, warnings: evidence.warnings},
          'Adjust returned warnings or missing totals, so the report is incomplete.',
        );
      return days.length
        ? layer(
            'provider_observed_activity',
            'observed',
            'daily_activity_reported',
            evidence,
            'Installs and events Adjust attributed to the app per day over the last seven complete UTC days.',
          )
        : layer(
            'provider_observed_activity',
            'unknown',
            'no_recent_activity',
            evidence,
            'Adjust reported no activity for the app in the last seven days. Absence does not establish broken tracking.',
          );
    }),
  );
  fence();
  return {
    scope: {gateway, connection_id: connection.id, account_id: app},
    layers: [
      layers[0]!,
      layers[1]!,
      layer(
        'provider_diagnostics',
        'unavailable',
        'no_provider_source',
        null,
        'Adjust exposes no event diagnostics to AMCP.',
      ),
      trace(),
      layer('consent', 'unavailable', 'no_provider_source', null, 'Adjust exposes no consent setting to this read.'),
      layer(
        'attribution_settings',
        'unavailable',
        'no_provider_source',
        null,
        'Adjust attribution windows are set in the Adjust dashboard; AMCP has no read for them.',
      ),
    ],
    source_references: references,
  };
}
