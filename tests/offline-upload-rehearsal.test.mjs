import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {sha256, stable} from '../dist/src/security.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {metaOfflineConversionPeople} from '../dist/src/meta-offline-conversions.js';
import {offlineUploadRehearsal} from '../dist/src/offline-upload-rehearsal.js';

// MSR-03 slice E: an offline-upload rehearsal is a local dry run inside amcp_write inspect. It applies the provider's
// time limits, builds the exact request and its documented no-execution form, and sends, reviews and saves nothing.
const gateway = 'google_ads_native_action',
  tenantId = 'offline-rehearsal',
  operator = {tenantId, userId: 'operator', role: 'operator'},
  owner = {tenantId, userId: 'owner', role: 'admin'},
  CUSTOMER = '1234567890',
  scopes = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager'];
const saudi = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
const payload = {conversion_action_id: '800', consent: {ad_user_data: 'GRANTED', ad_personalization: 'DENIED'}};
const now = Math.floor(Date.now() / 1000);
const events = (age = 3600) => ({
  schema: ['EMAIL'],
  rows: [
    {EMAIL: 'user.name+NYC@Example.com', event_time: now - age, value: 250, currency: 'SAR', transaction_id: 'order-7'},
    {gclid: 'Cj0KCQiA1234567890abcdEFGH', event_time: now - 7200, event_source: 'WEB'},
  ],
});
const hashed = createHash('sha256').update('user.name+nyc@example.com').digest('hex');

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 58).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    owner,
    {id: 'g', tenantId, gateway, accounts: [CUSTOMER], writeAccounts: [CUSTOMER], enabled: true, label: 'G', scopes},
    {accessToken: 'synthetic', developerToken: 'synthetic-dev'},
  );
  const calls = [];
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({origin: u.origin, path: u.pathname, method: init.method, body});
      if (u.pathname.endsWith('/googleAds:search')) {
        const q = body.query;
        if (/FROM customer\b/.test(q))
          return Response.json({
            results: [{customer: {resourceName: 'customers/' + CUSTOMER, id: CUSTOMER, manager: false}}],
          });
        if (/FROM conversion_action\b/.test(q))
          return Response.json({
            results: [
              {
                conversionAction: {
                  resourceName: 'customers/' + CUSTOMER + '/conversionActions/800',
                  id: '800',
                  name: 'Offline sales',
                  type: 'UPLOAD_CLICKS',
                  status: 'ENABLED',
                  ownerCustomer: 'customers/' + CUSTOMER,
                },
              },
            ],
          });
      }
      if (u.origin === 'https://datamanager.googleapis.com' && init.method === 'POST')
        return Response.json({requestId: 'ingest-1', fieldWarnings: []});
      if (u.pathname === '/v1/requestStatus:retrieve')
        return Response.json({
          requestStatusPerDestination: [
            {
              destination: calls.find(c => c.path === '/v1/events:ingest').body.destinations[0],
              requestStatus: 'SUCCESS',
              eventsIngestionStatus: {recordCount: '2'},
            },
          ],
        });
      throw Error('Unexpected ' + init.method + ' ' + u.href);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const write = (action, people, actor = operator, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action,
        gateway,
        arguments: {action: 'DATA_MANAGER_INGEST_EVENTS', account_id: CUSTOMER, payload},
        people,
        personal_data: saudi,
        ...extra,
      },
      actor,
    );
  const kept = () =>
    JSON.stringify([
      store.db.prepare("SELECT kind, data FROM documents WHERE kind <> 'service_timings'").all(),
      store.db.prepare('SELECT event FROM audit').all(),
      store.db.prepare('SELECT result FROM idempotency').all(),
    ]);
  return {store, service, calls, write, kept};
}

test('MSR-03 inspect rehearses an offline conversion upload locally: nothing is sent, reviewed or saved', async t => {
  const f = fixture(t),
    before = f.kept(),
    out = await f.write('inspect', events());
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 1500));
  const r = out.data.offline_upload_rehearsal;
  assert.equal(r.record_kind, 'offline_upload_rehearsal');
  assert.equal(r.mode, 'local_dry_run');
  assert.equal(r.outcome, 'rehearsal');
  assert.equal(r.transmitted, false);
  assert.equal(r.network_requests, 0);
  assert.equal(r.provider_mutations, 0);
  assert.equal(r.review_created, false);
  assert.equal(r.executable, false);
  assert.equal(r.provider, 'Google Data Manager events:ingest');
  assert.equal(r.counts.sent, 2);
  assert.deepEqual(r.time_window, {state: 'within_provider_limits'});
  assert.deepEqual(r.provider_rehearsal.flag, {validateOnly: true});
  assert.deepEqual(r.provider_rehearsal.differs_by, ['validateOnly']);
  assert.equal(r.provider_rehearsal.sent, false);
  assert.equal(out.data.executed, false);
  assert.equal(out.data.review_id, undefined);
  assert.deepEqual(f.calls, [], 'no provider request of any kind');
  assert.equal(f.kept(), before, 'no review, audit or idempotency record');
  const text = JSON.stringify(out);
  for (const v of ['user.name', 'example.com', hashed, 'order-7', 'Cj0KCQiA'])
    assert.equal(text.includes(v), false, 'the rehearsal holds no person or identifier: ' + v);
});

test('MSR-03 the rehearsal request differs from the executed request only by validateOnly', async t => {
  const f = fixture(t),
    inspected = await f.write('inspect', events()),
    r = inspected.data.offline_upload_rehearsal;
  assert.ok(
    (
      await f.service.call(
        'amcp_workspace',
        {action: 'enable_personal_data', connection_id: 'g', account_id: CUSTOMER, confirmed: true},
        owner,
      )
    ).success,
  );
  const prepared = await f.write('prepare', events());
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1500));
  const executed = await f.service.call(
    'amcp_write',
    {action: 'execute', review_id: prepared.data.review_id, confirmed: true, people: events()},
    owner,
  );
  assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 1500));
  const sent = f.calls.find(c => c.path === '/v1/events:ingest'),
    request = body => sha256(stable({method: 'POST', origin: sent.origin, path: sent.path, body}));
  assert.equal(sent.body.validateOnly, undefined, 'an execution never carries the rehearsal flag');
  assert.equal(request(sent.body), r.execution_request_hash, 'the dry run built the exact executed body');
  assert.equal(request({...sent.body, validateOnly: true}), r.provider_rehearsal.request_hash);
  assert.notEqual(r.provider_rehearsal.request_hash, r.execution_request_hash);
});

test('MSR-03 the dry run applies the provider time limits that the contract check skips', async t => {
  const f = fixture(t),
    out = await f.write('inspect', events(91 * 86400));
  assert.equal(out.success, true, JSON.stringify(out).slice(0, 1500));
  // The contract check still passes; only the rehearsal reports what Google would refuse.
  assert.equal(out.data.review_contract_supported, true);
  const window = out.data.offline_upload_rehearsal.time_window;
  assert.equal(window.state, 'refused');
  assert.equal(window.code, 'PERSONAL_DATA_INVALID');
  assert.equal(window.events, 1);
  assert.match(window.message, /older than 90 days/);
  assert.deepEqual(f.calls, []);
});

test('MSR-03 Meta conversions have no rehearsal route; uploads of other people get no rehearsal', async t => {
  const plan = {
      gateway: 'meta_native_action',
      action: 'meta_pixel_id_events_create',
      method: 'POST',
      path: metaPrefix + '123456/events',
      query: {},
      headers: {},
      body: {},
      personalData: {schema: ['EMAIL']},
    },
    people = {
      schema: ['EMAIL'],
      rows: [
        {
          EMAIL: 'a@example.com',
          event_name: 'Purchase',
          event_time: now - 60,
          action_source: 'email',
          value: 5,
          currency: 'SAR',
        },
      ],
    };
  const r = offlineUploadRehearsal(plan, metaOfflineConversionPeople, people);
  assert.equal(r.outcome, 'rehearsal');
  assert.equal(r.provider_rehearsal.available, false);
  assert.match(r.provider_rehearsal.note, /test_event_code/);
  assert.equal(r.execution_request_hash.length, 64);
  // Meta's 7-day window for offline events is applied locally too.
  const old = offlineUploadRehearsal(plan, metaOfflineConversionPeople, {
    ...people,
    rows: [{...people.rows[0], event_time: now - 8 * 86400}],
  });
  assert.equal(old.time_window.state, 'refused');
  assert.equal(
    offlineUploadRehearsal({...plan, action: 'meta_custom_audience_users_create'}, metaOfflineConversionPeople, people),
    undefined,
  );
  const f = fixture(t),
    customerMatch = await f.service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway,
        arguments: {
          action: 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS',
          account_id: CUSTOMER,
          payload: {user_list_id: '700', consent: payload.consent},
        },
        people: {schema: ['EMAIL'], rows: ['user@example.com']},
        personal_data: saudi,
      },
      operator,
    );
  assert.equal(customerMatch.success, true, JSON.stringify(customerMatch).slice(0, 1500));
  assert.equal(customerMatch.data.offline_upload_rehearsal, undefined);
  assert.deepEqual(f.calls, []);
});
