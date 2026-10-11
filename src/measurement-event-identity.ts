import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import {assertGa4TestProperty} from './measurement-test-properties.js';

const gateway = 'ga4_native_action',
  dimension = 'customEvent:amcp_test_id',
  // MSR-04: GA4's Realtime API filters only user-scoped custom dimensions, so the realtime mode reads this one, and
  // only on a property the workspace owner marked as a test property (owner direction P4).
  userDimension = 'customUser:amcp_test_id';
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const invalid = (message: string): never => bad(message, 'MEASUREMENT_IDENTITY_INVALID');
type IdentityRow = {event_name: string; test_id: string; stream_id: string; event_count: string};
type Mode = 'core_report' | 'realtime_user_scope';
function calendarDay(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
function metadataEvidence(data: JsonObject, property: string, identity = dimension) {
  if (
    data.name !== 'properties/' + property + '/metadata' ||
    !Array.isArray(data.dimensions) ||
    data.dimensions.length > 2000 ||
    !Array.isArray(data.metrics) ||
    data.metrics.length > 2000
  )
    invalid('GA4 did not return bounded metadata for the exact selected property.');
  const dimensions = ['eventName', identity, 'streamId'].map(name => {
    const matches = data.dimensions.filter((d: unknown) => obj(d) && d.apiName === name);
    if (matches.length !== 1 || (name === identity && matches[0].customDefinition !== true))
      invalid(
        identity === dimension
          ? 'The exact event-scoped amcp_test_id dimension is not uniquely registered in this GA4 property. Inspect custom definitions before reading test identity.'
          : 'The exact user-scoped amcp_test_id dimension is not uniquely registered in this GA4 test property. Register it in GA4 before reading realtime test identity.',
      );
    return {api_name: name, custom_definition: name === identity};
  });
  const metrics = data.metrics.filter((m: unknown) => obj(m) && m.apiName === 'eventCount');
  if (metrics.length !== 1 || metrics[0].type !== 'TYPE_INTEGER')
    invalid('GA4 did not establish exact integer event-count metadata.');
  return {name: data.name, dimensions, metric: {api_name: 'eventCount', type: 'TYPE_INTEGER'}};
}
function reportTimezone(data: JsonObject) {
  const m = data.metadata;
  if (
    !obj(m) ||
    typeof m.timeZone !== 'string' ||
    !m.timeZone ||
    ['subjectToThresholding', 'dataLossFromOtherRow'].some(
      key => m[key] !== undefined && (typeof m[key] !== 'boolean' || m[key]),
    ) ||
    ['samplingMetadatas', 'dataTruncationReasons'].some(
      key => m[key] !== undefined && (!Array.isArray(m[key]) || m[key].length),
    ) ||
    (m.emptyReason !== undefined && m.emptyReason !== '') ||
    (m.schemaRestrictionResponse !== undefined &&
      (!obj(m.schemaRestrictionResponse) ||
        (m.schemaRestrictionResponse.activeMetricRestrictions !== undefined &&
          (!Array.isArray(m.schemaRestrictionResponse.activeMetricRestrictions) ||
            m.schemaRestrictionResponse.activeMetricRestrictions.length))))
  )
    invalid('GA4 test identity evidence is sampled, restricted, truncated or has unknown report quality.');
  try {
    new Intl.DateTimeFormat('en', {timeZone: m.timeZone}).format(0);
  } catch {
    invalid('GA4 did not return a recognized property timezone.');
  }
  return m.timeZone as string;
}
/** A realtime response carries no timezone; it must still be unthresholded, unrestricted and complete. */
function realtimeQuality(data: JsonObject) {
  const m = data.metadata;
  if (
    m !== undefined &&
    (!obj(m) ||
      ['subjectToThresholding', 'dataLossFromOtherRow'].some(
        key => m[key] !== undefined && (typeof m[key] !== 'boolean' || m[key]),
      ) ||
      (m.schemaRestrictionResponse !== undefined &&
        (!obj(m.schemaRestrictionResponse) ||
          (m.schemaRestrictionResponse.activeMetricRestrictions !== undefined &&
            (!Array.isArray(m.schemaRestrictionResponse.activeMetricRestrictions) ||
              m.schemaRestrictionResponse.activeMetricRestrictions.length)))))
  )
    invalid('GA4 realtime test identity evidence is thresholded, restricted or has unknown report quality.');
}

/** Selected synthetic identifier counts from native aggregate reporting, never a raw-event or deduplication proof. */
export async function measurementEventIdentity(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== gateway || !numericId(input.account_id))
    bad('Choose an exact selected numeric GA4 property for test-identifier inspection.');
  const config = input.requirements ?? {};
  validate(config, ['mode', 'event_name', 'test_id', 'date_from', 'date_to', 'minutes', 'stream_id', 'expected_count']);
  const {event_name: event, test_id: testId, date_from: from, date_to: to, stream_id: stream} = config,
    mode: Mode = config.mode ?? 'core_report',
    realtime = mode === 'realtime_user_scope',
    expected = config.expected_count ?? 1,
    minutes = config.minutes ?? 30,
    first = calendarDay(from),
    last = calendarDay(to);
  if (mode !== 'core_report' && mode !== 'realtime_user_scope')
    bad('Choose mode core_report (property calendar dates) or realtime_user_scope (the last 1–30 minutes).');
  if (typeof event !== 'string' || !/^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(event))
    bad('Use one exact GA4 event name, up to 40 letters, digits or underscores, starting with a letter.');
  if (typeof testId !== 'string' || !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(testId))
    bad('Use a synthetic amcp-test- identifier with 8–64 letters, digits or hyphens after the prefix.');
  if (realtime) {
    if (from !== undefined || to !== undefined)
      bad('The realtime mode reads the last 1–30 minutes. Omit date_from and date_to.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) bad('Choose a recent window of 1–30 minutes.');
  } else {
    if (config.minutes !== undefined) bad('Choose minutes only with mode realtime_user_scope.');
    if (first === null || last === null || last < first || last - first > 6 * 86400000)
      bad('Choose valid explicit dates covering at most seven calendar days. Dates use the GA4 property timezone.');
  }
  if (stream !== undefined && !numericId(stream)) bad('Use an exact numeric stream ID or omit it.');
  if (!Number.isInteger(expected) || expected < 1 || expected > 1000)
    bad('Declare an expected test count between 1 and 1000. This declaration is not provider evidence.');
  const connection = store.resolveConnection(actor, gateway, input.account_id, input.connection_id),
    authorization = fingerprint(storedLogin(store, connection));
  const current = () => {
    const c = store.resolveConnection(actor, gateway, input.account_id, connection.id);
    if (
      !c.scopes.some(s =>
        ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/analytics'].includes(s),
      )
    )
      bad('This login requires Google Analytics read permission.', 'INSUFFICIENT_SCOPE');
    if (fingerprint(storedLogin(store, c)) !== authorization)
      bad('This GA4 login changed. Read the observation again.', 'CONNECTION_AUTHORITY_CHANGED');
    // Unmarking a test property takes effect at once, including for this inspection.
    if (realtime) return assertGa4TestProperty(store, actor.tenantId, input.account_id);
    return undefined;
  };
  const marking = current();
  const identity = realtime ? userDimension : dimension,
    exactFilter = (fieldName: string, value: string) => ({
      filter: {fieldName, stringFilter: {matchType: 'EXACT', value, caseSensitive: true}},
    }),
    dimensionFilter = {
      andGroup: {
        expressions: [
          exactFilter('eventName', event),
          exactFilter(identity, testId),
          ...(stream ? [exactFilter('streamId', stream)] : []),
        ],
      },
    },
    request: JsonObject = realtime
      ? {
          dimensions: [{name: 'eventName'}, {name: identity}, {name: 'streamId'}],
          metrics: [{name: 'eventCount'}],
          dimensionFilter,
          minuteRanges: [{startMinutesAgo: minutes - 1, endMinutesAgo: 0}],
          limit: '1000',
          returnPropertyQuota: true,
        }
      : {
          dateRanges: [{startDate: from, endDate: to}],
          dimensions: [{name: 'eventName'}, {name: identity}, {name: 'streamId'}],
          metrics: [{name: 'eventCount'}],
          dimensionFilter,
          limit: '1000',
          offset: '0',
          keepEmptyRows: false,
          returnPropertyQuota: true,
        },
    scope = realtime
      ? {
          gateway,
          connection_id: connection.id,
          property_id: input.account_id,
          mode,
          event_name: event,
          test_id: testId,
          identity_dimension: identity,
          stream_id: stream ?? null,
          minutes,
        }
      : {
          gateway,
          connection_id: connection.id,
          property_id: input.account_id,
          event_name: event,
          test_id: testId,
          identity_dimension: identity,
          stream_id: stream ?? null,
          date_from: from,
          date_to: to,
        },
    budget = new ReportCollectionBudget(undefined, fingerprint(scope), () => {}, {
      requests: 3,
      rows: 1000,
      bytes: 2 * 1024 * 1024,
      elapsed_ms: 30000,
    }),
    requestedAt = Date.now(),
    references: JsonObject[] = [];
  const read = async (operation: string, argumentsValue: JsonObject) => {
    current();
    const response = await call(
      gateway,
      {
        operation,
        // The realtime report takes the same arguments as measurement_events; it is never cached.
        arguments: {
          property: input.account_id,
          connection_id: connection.id,
          ...(operation === 'ga4_data_report' ? {} : {fresh: true}),
          ...argumentsValue,
        },
      },
      actor,
    );
    current();
    if (!response.success)
      bad(
        response.error?.message ?? 'GA4 test identity read failed.',
        response.error?.code ?? 'MEASUREMENT_READ_FAILED',
      );
    const data = response.data?.data;
    if (
      response.data?.truncated ||
      !obj(data) ||
      data.error ||
      data.truncated ||
      data.nextPageToken !== undefined ||
      data.next_page_token !== undefined
    )
      invalid('GA4 did not return a complete test identity response.');
    return data as JsonObject;
  };
  const reference = (operation: string, nativeRequest: JsonObject, selected: JsonObject) => {
    references.push({
      operation,
      property_id: input.account_id,
      request: nativeRequest,
      observed_at: Date.now(),
      source_hash: fingerprint(selected),
    });
  };
  try {
    return await budget.run(async () => {
      const before = metadataEvidence(
        await read('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}),
        input.account_id,
        identity,
      );
      reference('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}, before);
      const [operation, data] = realtime
          ? ['ga4_data_report', await read('ga4_data_report', {action: 'realtime', request})]
          : ['ga4_run_report', await read('ga4_run_report', {request, paginate_all: false, cache_ttl_seconds: 0})],
        timezone = realtime ? null : reportTimezone(data);
      if (realtime) realtimeQuality(data);
      if (
        (data.kind !== undefined &&
          data.kind !== (realtime ? 'analyticsData#runRealtimeReport' : 'analyticsData#runReport')) ||
        !Array.isArray(data.dimensionHeaders) ||
        data.dimensionHeaders.length !== 3 ||
        data.dimensionHeaders.some(
          (h: unknown, i: number) => !obj(h) || h.name !== ['eventName', identity, 'streamId'][i],
        ) ||
        !Array.isArray(data.metricHeaders) ||
        data.metricHeaders.length !== 1 ||
        data.metricHeaders[0]?.name !== 'eventCount' ||
        data.metricHeaders[0]?.type !== 'TYPE_INTEGER'
      )
        invalid('GA4 returned different test identity dimensions or metric semantics.');
      const raw = data.rows ?? [],
        // A realtime response may omit rowCount when it returns no rows.
        rowCount = realtime ? (data.rowCount ?? 0) : data.rowCount;
      if (
        !Array.isArray(raw) ||
        !Number.isSafeInteger(rowCount) ||
        rowCount < 0 ||
        rowCount > 1000 ||
        rowCount !== raw.length
      )
        invalid('GA4 test identity rows are incomplete or exceed the bounded inspection.');
      if (realtime) budget.rows('realtime_identity', raw.length);
      const seen = new Set<string>();
      let count = 0n;
      const rows: IdentityRow[] = raw.map((r: unknown): IdentityRow => {
        if (
          !obj(r) ||
          !Array.isArray(r.dimensionValues) ||
          r.dimensionValues.length !== 3 ||
          r.dimensionValues.some((v: unknown) => !obj(v) || typeof v.value !== 'string') ||
          !Array.isArray(r.metricValues) ||
          r.metricValues.length !== 1
        )
          invalid('GA4 returned a malformed test identity row.');
        const v = r as JsonObject,
          [nativeEvent, nativeId, nativeStream] = v.dimensionValues.map((x: JsonObject) => x.value),
          nativeCount = v.metricValues[0]?.value;
        if (
          nativeEvent !== event ||
          nativeId !== testId ||
          !numericId(nativeStream) ||
          (stream !== undefined && nativeStream !== stream) ||
          typeof nativeCount !== 'string' ||
          !/^(?:0|[1-9][0-9]{0,29})$/.test(nativeCount) ||
          seen.has(nativeStream)
        )
          invalid('GA4 returned duplicate, foreign or inexact test identity rows.');
        seen.add(nativeStream);
        count += BigInt(nativeCount);
        return {event_name: nativeEvent, test_id: nativeId, stream_id: nativeStream, event_count: nativeCount};
      });
      rows.sort((a, b) => a.stream_id.localeCompare(b.stream_id));
      reference(operation, request, {rows, timezone});
      const after = metadataEvidence(
        await read('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}),
        input.account_id,
        identity,
      );
      if (fingerprint(before) !== fingerprint(after))
        invalid('GA4 test identity registration changed during inspection. Read it again.');
      reference('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}, after);
      current();
      budget.check();
      const observed = count > 0n,
        capturedAt = Date.now(),
        reportedCount = rows.length ? String(count) : null,
        observation = {
          reported_count: reportedCount,
          declared_expected_count: String(expected),
          comparison:
            reportedCount === null
              ? 'not_observed'
              : count === BigInt(expected)
                ? 'matches_declared'
                : count > BigInt(expected)
                  ? 'above_declared'
                  : 'below_declared',
        };
      if (realtime)
        return {
          record_kind: 'measurement_event_identity',
          mode,
          state: observed ? 'observed' : 'not_observed',
          scope,
          requested_at: requestedAt,
          captured_at: capturedAt,
          relative_window: {
            start_minutes_ago: minutes - 1,
            end_minutes_ago: 0,
            reference: 'provider request processing time',
          },
          latency: 'realtime',
          test_property: {marked_at: marking?.marked_at ?? null, marked_by: marking?.marked_by ?? null},
          observation,
          rows,
          source_references: references,
          source_hash: fingerprint({scope, request, rows, before, after, requestedAt, capturedAt}),
          checks: {
            native_response: 'qualified',
            registered_dimension: 'observed_before_and_after',
            test_property: 'marked_by_owner',
            identity_scope: 'user',
            test_event_identity: observed ? 'user_scope_matched' : 'not_observed',
            event_level_proof: 'not_established',
            deduplication: 'unverified',
            consent: 'unverified',
            attribution: 'unverified',
          },
          provider_mutations: 0,
          retained_snapshot: false,
          cleanup:
            'The user-scoped amcp_test_id value persists on the synthetic test user in GA4 until that user expires under the property data retention. Use a fresh identifier and a dedicated test browser or device for each test.',
          meaning:
            'GA4 realtime reported aggregate counts of this event name from users whose user-scoped amcp_test_id equals this synthetic identifier, in the last minutes relative to GA4 processing time. It is a fast, user-level signal, not event-level proof: other events from the same test user also carry the identifier. Expected count is your declaration. Missing or zero counts can reflect realtime processing delay, filters or missing delivery. This is not a raw event trace, consent or attribution verification. No event was sent and no snapshot was saved.',
        };
      return {
        record_kind: 'measurement_event_identity',
        mode,
        state: observed ? 'observed' : 'not_observed',
        scope,
        requested_at: requestedAt,
        captured_at: capturedAt,
        period: {date_from: from, date_to: to, timezone, reference: 'GA4 property calendar dates'},
        observation,
        rows,
        source_references: references,
        source_hash: fingerprint({scope, request, rows, timezone, before, after, requestedAt, capturedAt}),
        checks: {
          native_response: 'qualified',
          registered_dimension: 'observed_before_and_after',
          test_event_identity: observed ? 'matched_in_report' : 'not_observed',
          deduplication: 'unverified',
          consent: 'unverified',
          attribution: 'unverified',
        },
        provider_mutations: 0,
        retained_snapshot: false,
        meaning:
          'GA4 reported aggregate counts matching this exact synthetic test identifier and event name in the selected property calendar dates. Expected count is your declaration. Multiple matching counts are a reason to investigate, not proof of a deduplication failure. Missing or zero counts can reflect processing delay, filters or missing delivery. This is not a raw event trace, consent or attribution verification. No event was sent and no snapshot was saved.',
      };
    });
  } finally {
    budget.close();
  }
}
