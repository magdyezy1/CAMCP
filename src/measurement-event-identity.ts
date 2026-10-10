import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'ga4_native_action',
  dimension = 'customEvent:amcp_test_id';
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const invalid = (message: string): never => bad(message, 'MEASUREMENT_IDENTITY_INVALID');
type IdentityRow = {event_name: string; test_id: string; stream_id: string; event_count: string};
function calendarDay(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
function metadataEvidence(data: JsonObject, property: string) {
  if (
    data.name !== 'properties/' + property + '/metadata' ||
    !Array.isArray(data.dimensions) ||
    data.dimensions.length > 2000 ||
    !Array.isArray(data.metrics) ||
    data.metrics.length > 2000
  )
    invalid('GA4 did not return bounded metadata for the exact selected property.');
  const dimensions = ['eventName', dimension, 'streamId'].map(name => {
    const matches = data.dimensions.filter((d: unknown) => obj(d) && d.apiName === name);
    if (matches.length !== 1 || (name === dimension && matches[0].customDefinition !== true))
      invalid(
        'The exact event-scoped amcp_test_id dimension is not uniquely registered in this GA4 property. Inspect custom definitions before reading test identity.',
      );
    return {api_name: name, custom_definition: name === dimension};
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

/** Selected synthetic identifier counts from native aggregate reporting, never a raw-event or deduplication proof. */
export async function measurementEventIdentity(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  if (input.gateway !== gateway || !numericId(input.account_id))
    bad('Choose an exact selected numeric GA4 property for test-identifier inspection.');
  const config = input.requirements ?? {};
  validate(config, ['event_name', 'test_id', 'date_from', 'date_to', 'stream_id', 'expected_count']);
  const {event_name: event, test_id: testId, date_from: from, date_to: to, stream_id: stream} = config,
    expected = config.expected_count ?? 1,
    first = calendarDay(from),
    last = calendarDay(to);
  if (typeof event !== 'string' || !/^\p{L}[\p{L}\p{N}_]{0,39}$/u.test(event))
    bad('Use one exact GA4 event name, up to 40 letters, digits or underscores, starting with a letter.');
  if (typeof testId !== 'string' || !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(testId))
    bad('Use a synthetic amcp-test- identifier with 8–64 letters, digits or hyphens after the prefix.');
  if (first === null || last === null || last < first || last - first > 6 * 86400000)
    bad('Choose valid explicit dates covering at most seven calendar days. Dates use the GA4 property timezone.');
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
  };
  current();
  const exactFilter = (fieldName: string, value: string) => ({
      filter: {fieldName, stringFilter: {matchType: 'EXACT', value, caseSensitive: true}},
    }),
    request = {
      dateRanges: [{startDate: from, endDate: to}],
      dimensions: [{name: 'eventName'}, {name: dimension}, {name: 'streamId'}],
      metrics: [{name: 'eventCount'}],
      dimensionFilter: {
        andGroup: {
          expressions: [
            exactFilter('eventName', event),
            exactFilter(dimension, testId),
            ...(stream ? [exactFilter('streamId', stream)] : []),
          ],
        },
      },
      limit: '1000',
      offset: '0',
      keepEmptyRows: false,
      returnPropertyQuota: true,
    },
    scope = {
      gateway,
      connection_id: connection.id,
      property_id: input.account_id,
      event_name: event,
      test_id: testId,
      identity_dimension: dimension,
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
        arguments: {property: input.account_id, connection_id: connection.id, fresh: true, ...argumentsValue},
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
      );
      reference('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}, before);
      const data = await read('ga4_run_report', {request, paginate_all: false, cache_ttl_seconds: 0}),
        timezone = reportTimezone(data);
      if (
        (data.kind !== undefined && data.kind !== 'analyticsData#runReport') ||
        !Array.isArray(data.dimensionHeaders) ||
        data.dimensionHeaders.length !== 3 ||
        data.dimensionHeaders.some(
          (h: unknown, i: number) => !obj(h) || h.name !== ['eventName', dimension, 'streamId'][i],
        ) ||
        !Array.isArray(data.metricHeaders) ||
        data.metricHeaders.length !== 1 ||
        data.metricHeaders[0]?.name !== 'eventCount' ||
        data.metricHeaders[0]?.type !== 'TYPE_INTEGER'
      )
        invalid('GA4 returned different test identity dimensions or metric semantics.');
      const raw = data.rows ?? [];
      if (
        !Array.isArray(raw) ||
        !Number.isSafeInteger(data.rowCount) ||
        data.rowCount < 0 ||
        data.rowCount > 1000 ||
        data.rowCount !== raw.length
      )
        invalid('GA4 test identity rows are incomplete or exceed the bounded inspection.');
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
      reference('ga4_run_report', request, {rows, timezone});
      const after = metadataEvidence(
        await read('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}),
        input.account_id,
      );
      if (fingerprint(before) !== fingerprint(after))
        invalid('GA4 test identity registration changed during inspection. Read it again.');
      reference('ga4_metadata_ops', {action: 'get_metadata', api_version: 'v1beta'}, after);
      current();
      budget.check();
      const observed = count > 0n,
        capturedAt = Date.now(),
        reportedCount = rows.length ? String(count) : null;
      return {
        record_kind: 'measurement_event_identity',
        state: observed ? 'observed' : 'not_observed',
        scope,
        requested_at: requestedAt,
        captured_at: capturedAt,
        period: {date_from: from, date_to: to, timezone, reference: 'GA4 property calendar dates'},
        observation: {
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
        },
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
