import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';

const gateway = 'ga4_native_action';
const numericId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const invalid = (message: string): never => bad(message, 'MEASUREMENT_EVIDENCE_INVALID');
type EventRow = {event_name: string; minutes_ago: number; stream_id: string; event_count: string};

/** Aggregate native observations only. Never sends test events or claims consent, deduplication or attribution. */
export async function measurementEvents(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== gateway)
    bad('Recent event observations currently support a selected GA4 property.', 'MEASUREMENT_EVENTS_UNQUALIFIED');
  if (!numericId(input.account_id)) bad('Choose the exact numeric GA4 property ID.');
  const config = input.requirements ?? {};
  validate(config, ['event_names', 'minutes', 'stream_id']);
  const names = config.event_names,
    minutes = config.minutes ?? 30,
    stream = config.stream_id;
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length > 20 ||
    names.some(v => typeof v !== 'string' || !/^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(v)) ||
    new Set(names).size !== names.length
  )
    bad('Choose 1–20 distinct exact GA4 event names, up to 40 letters, digits or underscores, starting with a letter.');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) bad('Choose a recent window of 1–30 minutes.');
  if (stream !== undefined && !numericId(stream)) bad('Use an exact numeric stream ID or omit the stream filter.');
  const connection = store.resolveConnection(actor, gateway, input.account_id, input.connection_id),
    authorization = fingerprint(store.connectionCredentials(connection));
  const current = () => {
    const c = store.resolveConnection(actor, gateway, input.account_id, connection.id);
    if (
      !c.scopes.some(s =>
        ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/analytics'].includes(s),
      )
    )
      bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(store.connectionCredentials(c)) !== authorization)
      bad('This GA4 login changed. Read the observation again.', 'REAUTHORIZATION_REQUIRED');
  };
  current();
  const eventFilter = {filter: {fieldName: 'eventName', inListFilter: {values: names, caseSensitive: true}}},
    request: JsonObject = {
      dimensions: [{name: 'eventName'}, {name: 'minutesAgo'}, {name: 'streamId'}],
      metrics: [{name: 'eventCount'}],
      dimensionFilter: stream
        ? {
            andGroup: {
              expressions: [
                eventFilter,
                {
                  filter: {
                    fieldName: 'streamId',
                    stringFilter: {matchType: 'EXACT', value: stream, caseSensitive: true},
                  },
                },
              ],
            },
          }
        : eventFilter,
      minuteRanges: [{startMinutesAgo: minutes - 1, endMinutesAgo: 0}],
      limit: '1000',
      returnPropertyQuota: true,
    },
    scope = {
      gateway,
      connection_id: connection.id,
      property_id: input.account_id,
      stream_id: stream ?? null,
      event_names: names,
      minutes,
    },
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: 3,
      rows: 1000,
      bytes: 2 * 1024 * 1024,
      elapsed_ms: 30000,
    }),
    requestedAt = Date.now();
  try {
    return await budget.run(async () => {
      current();
      const response = await call(
        gateway,
        {
          operation: 'ga4_data_report',
          arguments: {action: 'realtime', property: input.account_id, connection_id: connection.id, request},
        },
        actor,
      );
      current();
      if (!response.success)
        bad(
          response.error?.message ?? 'GA4 event observation failed.',
          response.error?.code ?? 'MEASUREMENT_READ_FAILED',
        );
      const d = response.data?.data;
      if (
        response.data?.truncated ||
        !obj(d) ||
        d.error ||
        d.truncated ||
        d.nextPageToken !== undefined ||
        d.next_page_token !== undefined ||
        (d.kind !== undefined && d.kind !== 'analyticsData#runRealtimeReport')
      )
        invalid('GA4 did not return a complete realtime event response.');
      if (
        d.metadata !== undefined &&
        (!obj(d.metadata) ||
          d.metadata.subjectToThresholding ||
          d.metadata.dataLossFromOtherRow ||
          d.metadata.schemaRestrictionResponse?.activeMetricRestrictions?.length)
      )
        invalid('GA4 event evidence is restricted, thresholded or incomplete.');
      if (
        !Array.isArray(d.dimensionHeaders) ||
        d.dimensionHeaders.length !== 3 ||
        d.dimensionHeaders.some(
          (h: unknown, i: number) => !obj(h) || h.name !== ['eventName', 'minutesAgo', 'streamId'][i],
        ) ||
        !Array.isArray(d.metricHeaders) ||
        d.metricHeaders.length !== 1 ||
        d.metricHeaders[0]?.name !== 'eventCount' ||
        d.metricHeaders[0]?.type !== 'TYPE_INTEGER'
      )
        invalid('GA4 returned different event dimensions or metric semantics.');
      const raw = d.rows ?? [],
        rowCount = d.rowCount ?? 0;
      if (
        !Array.isArray(raw) ||
        raw.length > 1000 ||
        !Number.isSafeInteger(rowCount) ||
        rowCount < 0 ||
        rowCount !== raw.length
      )
        invalid(
          'GA4 returned a partial or oversized event table. Narrow the selected streams, events or minute window.',
        );
      budget.rows('realtime_events', raw.length);
      const seen = new Set<string>(),
        totals = new Map<string, bigint>(),
        rows: EventRow[] = raw.map((r: unknown): EventRow => {
          if (
            !obj(r) ||
            !Array.isArray(r.dimensionValues) ||
            r.dimensionValues.length !== 3 ||
            r.dimensionValues.some((v: unknown) => !obj(v) || typeof v.value !== 'string') ||
            !Array.isArray(r.metricValues) ||
            r.metricValues.length !== 1
          )
            invalid('GA4 returned a malformed event row.');
          const value = r as JsonObject,
            [event, minute, nativeStream] = value.dimensionValues.map((v: JsonObject) => v.value),
            count = value.metricValues[0]?.value;
          if (
            !names.includes(event) ||
            !/^[0-2]?[0-9]$/.test(minute) ||
            Number(minute) >= minutes ||
            !numericId(nativeStream) ||
            (stream && nativeStream !== stream) ||
            typeof count !== 'string' ||
            !/^(?:0|[1-9][0-9]{0,29})$/.test(count)
          )
            invalid('GA4 returned an event outside the selected scope or without an exact nonnegative count.');
          const key = JSON.stringify([event, Number(minute), nativeStream]);
          if (seen.has(key)) invalid('GA4 returned duplicate event/minute/stream rows.');
          seen.add(key);
          totals.set(event, (totals.get(event) ?? 0n) + BigInt(count));
          return {event_name: event, minutes_ago: Number(minute), stream_id: nativeStream, event_count: count};
        });
      rows.sort(
        (a, b) =>
          names.indexOf(a.event_name) - names.indexOf(b.event_name) ||
          a.minutes_ago - b.minutes_ago ||
          a.stream_id.localeCompare(b.stream_id),
      );
      const events = names.map((name: string) => ({
          event_name: name,
          reported_count: totals.has(name) ? String(totals.get(name)) : null,
          state: (totals.get(name) ?? 0n) > 0n ? 'observed' : 'not_observed',
        })),
        capturedAt = Date.now();
      current();
      budget.check();
      return {
        record_kind: 'measurement_events',
        state: events.some(e => e.state === 'observed') ? 'observed' : 'not_observed',
        scope,
        requested_at: requestedAt,
        captured_at: capturedAt,
        relative_window: {
          start_minutes_ago: minutes - 1,
          end_minutes_ago: 0,
          reference: 'provider request processing time',
        },
        rows,
        events,
        source_hash: fingerprint({scope, request, rows, requested_at: requestedAt, captured_at: capturedAt}),
        checks: {
          native_response: 'qualified',
          event_observation: events.some(e => e.state === 'observed') ? 'observed' : 'not_observed',
          deduplication: 'unverified',
          consent: 'unverified',
          attribution: 'unverified',
          test_event_identity: 'unverified',
        },
        provider_mutations: 0,
        retained_snapshot: false,
        meaning:
          'GA4 reported these aggregate event counts in the requested recent minute range. A missing event row remains null and does not establish a broken tag. Realtime processing can lag. Counts do not identify your test event or establish deduplication, consent, attribution, conversion configuration or overall tracking health. No test events were sent and no snapshot was saved.',
      };
    });
  } finally {
    budget.close();
  }
}
