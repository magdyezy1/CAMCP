import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {measurementEventReport, measurementEventFixtureConnection} from './measurement-events-data.mjs';
import {
  measurementIdentityInput,
  measurementIdentityMetadata,
  measurementIdentityReport,
  measurementIdentityRow,
} from './measurement-identity-data.mjs';
export const measurementRefusals = {
  events: {code: 'MEASUREMENT_EVIDENCE_INVALID', message: 'GA4 returned duplicate event/minute/stream rows.'},
  identity: {
    code: 'MEASUREMENT_IDENTITY_INVALID',
    message:
      'The exact event-scoped amcp_test_id dimension is not uniquely registered in this GA4 property. Inspect custom definitions before reading test identity.',
  },
};
/** Fixed native report reads only. Each explicit recovery follows an original refused read. */
export function measurementReadRefusalFixture(kind, {recovery = true} = {}) {
  assert.ok(Object.hasOwn(measurementRefusals, kind));
  const owner = {tenantId: 'measurement-refusal-' + kind, userId: 'fixture-owner', role: 'admin'},
    keyByte = 167,
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    requests = [],
    connectionId = measurementEventFixtureConnection;
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: owner.tenantId,
      gateway: 'ga4_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic GA4 reader',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    {accessToken: 'synthetic-measurement-refusal-secret'},
  );
  const key = store.createKey({...owner, userId: 'fixture-reader', role: 'viewer'}),
    actor = store.authenticate(key),
    input =
      kind === 'identity'
        ? structuredClone(measurementIdentityInput)
        : {
            action: 'measurement_events',
            gateway: 'ga4_native_action',
            account_id: '123',
            connection_id: connectionId,
            requirements: {event_names: ['purchase', 'generate_lead'], minutes: 5, stream_id: '900'},
          };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw)),
        body = init.body ? JSON.parse(String(init.body)) : null;
      assert.equal(url.origin, 'https://analyticsdata.googleapis.com');
      if (kind === 'events') {
        assert.equal(init.method, 'POST', 'The bounded realtime report POST reads aggregate evidence');
        assert.equal(url.pathname, '/v1beta/properties/123:runRealtimeReport');
        assert.equal(body.metrics[0].name, 'eventCount');
        assert.equal(body.limit, '1000');
        requests.push({method: init.method, path: url.pathname, body});
        const out = measurementEventReport();
        if (!recovery || requests.length % 2 === 1) {
          out.rows.push(structuredClone(out.rows[0]));
          out.rowCount = out.rows.length;
        }
        return Response.json(out);
      }
      const phase = recovery ? (requests.length % 4) + 1 : 1;
      assert.equal(init.method, phase === 3 ? 'POST' : 'GET');
      assert.equal(url.pathname, phase === 3 ? '/v1beta/properties/123:runReport' : '/v1beta/properties/123/metadata');
      requests.push({method: init.method, path: url.pathname, body});
      if (phase === 3) {
        assert.equal(body.limit, '1000');
        assert.equal(
          body.dimensionFilter.andGroup.expressions[1].filter.stringFilter.value,
          input.requirements.test_id,
        );
        assert.equal(body.dimensionFilter.andGroup.expressions[1].filter.stringFilter.caseSensitive, true);
        return Response.json(measurementIdentityReport([measurementIdentityRow('9007199254740993')]));
      }
      const out = measurementIdentityMetadata();
      if (phase === 1) out.dimensions.pop();
      return Response.json(out);
    }),
    undefined,
    {allowWrites: false},
  );
  return {
    owner,
    actor,
    store,
    service,
    key,
    keyByte,
    input,
    requests,
    kind,
    ...measurementRefusals[kind],
    close: () => store.close(),
  };
}
