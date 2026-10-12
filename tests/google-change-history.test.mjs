// PRV-07 A: Google Ads change history as a bounded, fixed-projection read. Windows over 30 days or older than
// Google's 30-day retention are refused before any request; user_email (personal data) is never requested.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const gateway = 'google_ads_native_action',
  actor = {tenantId: 'change-history', userId: 'reader', role: 'reader'},
  owner = {...actor, userId: 'owner', role: 'admin'};
const isoDay = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const from = isoDay(-6),
  to = isoDay(-1);
const event = (id, extra = {}) => ({
  changeEvent: {
    resourceName: 'customers/123/changeEvents/' + id,
    changeDateTime: from + ' 10:0' + (id % 10) + ':00.123456',
    changeResourceType: 'CAMPAIGN',
    changeResourceName: 'customers/123/campaigns/77',
    clientType: 'GOOGLE_ADS_WEB_CLIENT',
    resourceChangeOperation: 'UPDATE',
    changedFields: 'status,campaign_budget',
    campaign: 'customers/123/campaigns/77',
    ...extra,
  },
});
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64'));
  t.after(() => store.close());
  for (const [id, accounts] of [
    ['g', ['123']],
    ['other', ['456']],
  ])
    store.putConnection(
      owner,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts,
        enabled: true,
        label: 'Synthetic Google ' + id,
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic'},
    );
  const requests = [];
  let respond = () => ({
    results: [
      event(1),
      event(2, {
        changeResourceType: 'AD_GROUP_AD',
        changeResourceName: 'customers/123/adGroupAds/5~6',
        campaign: undefined,
        adGroup: 'customers/123/adGroups/5',
        resourceChangeOperation: 'CREATE',
        clientType: 'GOOGLE_ADS_API',
      }),
    ],
    fieldMask: 'x',
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const path = new URL(String(url)).pathname,
        body = JSON.parse(String(init.body));
      requests.push({path, body, method: init.method});
      return Response.json(respond(path, body));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(new Registry(), store, transport);
  const input = {
    action: 'change_history',
    gateway,
    account_id: '123',
    connection_id: 'g',
    requirements: {date_from: from, date_to: to, limit: 50},
  };
  return {
    store,
    requests,
    respond: fn => (respond = fn),
    read: (requirements = {}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {...input, ...extra, requirements: {...input.requirements, ...requirements}},
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r));
  if (code) assert.equal(r.error.code, code, JSON.stringify(r.error));
  return r.error;
};

test('change history reads one fixed change_event projection without user_email and returns a timeline', async t => {
  const f = fixture(t),
    out = ok(await f.read());
  assert.equal(out.record_kind, 'change_history');
  assert.equal(out.row_count, 2);
  assert.equal(out.complete, true);
  assert.equal(out.limit_reached, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v25/customers/123/googleAds:search');
  const query = f.requests[0].body.query;
  assert.match(query, /FROM change_event WHERE change_event\.change_date_time >= '[0-9-]+ 00:00:00'/);
  assert.match(query, /ORDER BY change_event\.change_date_time DESC LIMIT 50$/);
  assert.doesNotMatch(query, /user_email|old_resource|new_resource/);
  assert.deepEqual(out.personal_data, {user_email: 'not_requested'});
  assert.deepEqual(
    out.rows.map(r => [r.change_event, r.resource_type, r.operation, r.client_type]),
    [
      ['customers/123/changeEvents/2', 'AD_GROUP_AD', 'CREATE', 'GOOGLE_ADS_API'],
      ['customers/123/changeEvents/1', 'CAMPAIGN', 'UPDATE', 'GOOGLE_ADS_WEB_CLIENT'],
    ],
  );
  assert.deepEqual(out.rows[1].changed_fields, ['status', 'campaign_budget']);
  assert.equal(out.rows[0].campaign, null);
  assert.equal(out.rows[0].ad_group, 'customers/123/adGroups/5');
  assert.deepEqual(out.timeline.by_day, {[from]: 2});
  assert.deepEqual(out.timeline.by_resource_type, {AD_GROUP_AD: 1, CAMPAIGN: 1});
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.retained_snapshot, false);
  assert.equal(f.store.documents(actor.tenantId, 'change_history').length, 0);
});

test('windows over 30 days, older than retention, in the future or unbounded are refused before any request', async t => {
  const f = fixture(t);
  for (const requirements of [
    // 31 days: refused for the window alone.
    {date_from: isoDay(-30), date_to: isoDay(0)},
    {date_from: isoDay(-31), date_to: isoDay(-25)},
    // 30 days, but its first day starts more than 30 days ago (Google: START_DATE_TOO_OLD).
    {date_from: isoDay(-30), date_to: isoDay(-1)},
    {date_from: isoDay(-2), date_to: isoDay(3)},
    {date_from: to, date_to: from},
    {date_from: '2026-02-30', date_to: to},
    {date_from: undefined},
    {limit: 10001},
    {limit: 0},
    {resource_types: ['CAMPAIGN', 'CAMPAIGN']},
    {resource_types: ['NOT_A_TYPE']},
    {user_email: true},
  ])
    refused(await f.read(requirements), 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 0);
  // Exactly 30 days is the documented maximum.
  ok(await f.read({date_from: isoDay(-29), date_to: isoDay(0)}));
});

test('change history stays inside the selected customer: foreign accounts are refused before any request', async t => {
  const f = fixture(t);
  refused(await f.read({}, {account_id: '456', connection_id: 'g'}));
  refused(await f.read({}, {account_id: '999', connection_id: 'g'}));
  assert.equal(f.requests.length, 0);
});

test('foreign, unselected or personal fields in the response refuse the whole read', async t => {
  const f = fixture(t);
  for (const bad of [
    event(1, {resourceName: 'customers/456/changeEvents/1'}),
    event(1, {changeResourceName: 'customers/456/campaigns/9'}),
    event(1, {userEmail: 'person@example.test'}),
    event(1, {oldResource: {campaign: {status: 'PAUSED'}}}),
    event(1, {changeDateTime: isoDay(-20) + ' 10:00:00'}),
    event(1, {changeResourceType: 'SOMETHING_NEW'}),
    event(1, {changedFields: 'status;drop'}),
  ]) {
    f.respond(() => ({results: [bad]}));
    const error = refused(await f.read(), 'CHANGE_HISTORY_INVALID');
    assert.doesNotMatch(JSON.stringify(error), /person@example\.test/);
  }
  f.respond(() => ({results: [event(1), event(1)]}));
  refused(await f.read(), 'CHANGE_HISTORY_INVALID');
});

test('a resource-type filter is sent exactly and a full page is labelled limit_reached', async t => {
  const f = fixture(t);
  f.respond(() => ({results: [event(1), event(2)]}));
  const out = ok(await f.read({resource_types: ['CAMPAIGN'], limit: 2}));
  assert.match(f.requests[0].body.query, /change_event\.change_resource_type IN \('CAMPAIGN'\)/);
  assert.equal(out.limit_reached, true);
  assert.equal(out.complete, false);
  f.respond(() => ({results: [event(3, {changeResourceType: 'AD_GROUP'})]}));
  refused(await f.read({resource_types: ['CAMPAIGN']}), 'CHANGE_HISTORY_INVALID');
});
