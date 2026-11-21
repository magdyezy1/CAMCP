import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {activationSteps} from '../dist/src/campaign-activation.js';
import {metaPrefix} from '../dist/src/meta-version.js';

// r25-field2-access, B2 (the owner's field report of 2026-11-21, issue 2): the Meta conversion activation gate read the pixel node,
// which ScopeGuard refused (nothing remembered the pixel), so in production the gate blocked every launch with "AMCP could not read the
// Meta pixel". Its only test stubbed the call layer, so the guard never ran. The gate now reads the ad account's pixel list
// (fields id and is_unavailable, bounded pages) and decides from the listed row. These tests run it through the real service: its
// runner, its guard, its transport (a synthetic Graph API), with no stubbed call.
// Synthetic IDs: ad account 123, campaign 42, pixels 456 and 457.

const registry = new Registry(),
  actor = {tenantId: 'meta-activation-pixel', userId: 'operator', role: 'operator'},
  admin = {...actor, userId: 'admin', role: 'admin'},
  login = 'cccccccc-7777-4777-8777-000000000001',
  listPath = metaPrefix + 'act_123/adspixels';

function fixture(t, list) {
  const store = new Store(':memory:', Buffer.alloc(32, 65).toString('base64')),
    requests = [];
  t.after(() => store.close());
  store.putConnection(
    admin,
    {
      id: login,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input)),
          request = {method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams)};
        requests.push(request);
        if (url.pathname === metaPrefix + 'act_123')
          return Response.json({
            id: 'act_123',
            account_id: '123',
            name: 'Synthetic account',
            account_status: 1,
            currency: 'USD',
            timezone_name: 'UTC',
          });
        if (url.pathname === listPath) return list(request);
        throw Error('Unexpected synthetic Meta route ' + url.pathname);
      },
      async () => {},
    ),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  // The activation plan of a completed conversion launch that optimizes on pixel 456, as the runner drafts it.
  const activation = async (pixel = '456') => {
    const steps = activationSteps('meta', new Map([['campaign', {data: {id: '42'}}]]), {
        connection_id: login,
        account_id: '123',
      }),
      created = await service.call(
        'amcp_campaign',
        {action: 'create', name: 'Meta activation', brief: 'Synthetic.', steps},
        actor,
      );
    assert.equal(created.success, true, JSON.stringify(created.error));
    const saved = store.document(actor.tenantId, 'campaign_run', created.data.id);
    store.putDocument(
      actor.tenantId,
      'campaign_run',
      created.data.id,
      {...saved, activation_of: {id: 'launch', platform: 'meta', meta_pixel_id: pixel}},
      saved.revision,
    );
    return created.data.id;
  };
  const preflight = async id => {
    requests.length = 0;
    const out = await service.call('amcp_campaign', {action: 'preflight', id, detail: 'full'}, actor);
    assert.equal(out.success, true, JSON.stringify(out.error));
    return out.data;
  };
  return {store, service, requests, activation, preflight, listReads: () => requests.filter(r => r.path === listPath)};
}
const rows = (...pixels) => ({data: pixels});

test('a pixel the account lists passes the gate: one list read, no node read', async t => {
  const f = fixture(t, () => Response.json(rows({id: '456', is_unavailable: false}, {id: '457'}))),
    result = await f.preflight(await f.activation());
  assert.equal(result.preflight.status, 'ready', JSON.stringify(result.preflight));
  assert.deepEqual(result.preflight.activation_gates, [
    {gate: 'meta_pixel', step: 'activate_campaign', status: 'gate_passed'},
  ]);
  assert.deepEqual(
    f.listReads().map(r => r.query),
    [{fields: 'id,is_unavailable', limit: '100'}],
  );
  assert.ok(!f.requests.some(r => r.path === metaPrefix + '456'), 'the node is never read');
  assert.ok(
    f.requests.every(r => r.method === 'GET'),
    'the gate reads and writes nothing',
  );
});

test('a pixel Meta marks unavailable blocks the gate, and says so', async t => {
  const f = fixture(t, () => Response.json(rows({id: '456', is_unavailable: true}))),
    result = await f.preflight(await f.activation());
  assert.equal(result.preflight.status, 'blocked');
  const gate = result.missing_requirements.find(m => m.gate === 'meta_pixel');
  assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED');
  assert.equal(gate.error.details.is_unavailable, true);
  assert.equal(gate.error.details.pixel_id, '456');
  assert.equal(gate.error.details.read_error, undefined, 'a pixel Meta lists was read');
});

test('a pixel the account does not list blocks the gate, with its own reason and no read error', async t => {
  const f = fixture(t, () => Response.json(rows({id: '457', is_unavailable: false}))),
    result = await f.preflight(await f.activation());
  assert.equal(result.preflight.status, 'blocked');
  const gate = result.missing_requirements.find(m => m.gate === 'meta_pixel');
  assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED');
  assert.equal(gate.error.details.pixel_id, '456');
  assert.equal(gate.error.details.reason, 'not_listed');
  assert.equal(gate.error.details.read_error, undefined);
  assert.match(gate.error.message, /does not list the Meta pixel/);
});

test('a list Meta refuses, or answers in no recognized shape, blocks the gate: readiness is shown, never assumed', async t => {
  for (const [name, list] of [
    ['a refusal', () => Response.json({error: {code: 100, message: 'Unsupported get request.'}}, {status: 400})],
    ['no data list', () => Response.json({unexpected: true})],
    ['a rate limit', () => Response.json({error: {code: 17, message: 'User request limit reached'}}, {status: 400})],
  ]) {
    const f = fixture(t, list),
      result = await f.preflight(await f.activation());
    assert.equal(result.preflight.status, 'blocked', name);
    const gate = result.missing_requirements.find(m => m.gate === 'meta_pixel');
    assert.equal(gate.error.code, 'ACTIVATION_GATE_BLOCKED', name);
    assert.match(gate.error.message, /could not read the Meta pixel/, name);
    assert.equal(typeof gate.error.details.read_error, 'string', name + ': ' + JSON.stringify(gate.error.details));
    assert.equal(gate.error.details.is_unavailable, undefined, name);
  }
});

test('a pixel on the second page of the list is found, and a list too long to read is not mistaken for a pixel that is missing', async t => {
  const paged = fixture(t, request =>
    request.query.after
      ? Response.json(rows({id: '456', is_unavailable: false}))
      : Response.json({
          ...rows({id: '700'}),
          paging: {cursors: {before: 'a', after: 'second'}, next: 'https://graph.facebook.com/next'},
        }),
  );
  const found = await paged.preflight(await paged.activation());
  assert.equal(found.preflight.status, 'ready', JSON.stringify(found.preflight));
  assert.equal(paged.listReads().length, 2);
  // A list that never ends: bounded pages, and a pixel not among them is not shown to be missing.
  let page = 0;
  const endless = fixture(t, () =>
    Response.json({
      ...rows({id: String(900 + page)}),
      paging: {cursors: {before: 'a', after: 'cursor-' + ++page}, next: 'https://graph.facebook.com/next'},
    }),
  );
  const unread = await endless.preflight(await endless.activation());
  assert.equal(unread.preflight.status, 'blocked');
  const gate = unread.missing_requirements.find(m => m.gate === 'meta_pixel');
  assert.equal(gate.error.details.reason, 'list_incomplete');
  assert.match(gate.error.message, /could not read the Meta pixel/);
  assert.ok(endless.listReads().length <= 25, 'the pages are bounded: ' + endless.listReads().length);
});

test('the gate’s list read is audited under the campaign call’s request ID, so one ID follows the whole preflight', async t => {
  // Lead review S4-2: the closure gave the list read a request ID of its own, so its request_started and request_completed rows
  // shared nothing with the call that asked for them.
  const f = fixture(t, () => Response.json(rows({id: '456', is_unavailable: false}))),
    id = await f.activation(),
    out = await f.service.call('amcp_campaign', {action: 'preflight', id, detail: 'full'}, actor);
  assert.equal(out.success, true, JSON.stringify(out.error));
  const events = f.store
    .audit(actor.tenantId)
    .filter(row => row.request_id === out.meta.requestId)
    .map(row => JSON.parse(row.event));
  assert.deepEqual(
    events.filter(e => String(e.request?.path).endsWith('/act_123/adspixels')).map(e => [e.event, e.request.method]),
    [
      ['request_started', 'GET'],
      ['request_completed', 'GET'],
    ],
  );
});

test('a launch without a pixel (a traffic launch) has no pixel gate and reads no list', async t => {
  const f = fixture(t, () => Response.json(rows())),
    steps = activationSteps('meta', new Map([['campaign', {data: {id: '42'}}]]), {
      connection_id: login,
      account_id: '123',
    }),
    created = await f.service.call(
      'amcp_campaign',
      {action: 'create', name: 'Meta activation', brief: 'Synthetic.', steps},
      actor,
    ),
    saved = f.store.document(actor.tenantId, 'campaign_run', created.data.id);
  f.store.putDocument(
    actor.tenantId,
    'campaign_run',
    created.data.id,
    {...saved, activation_of: {id: 'launch', platform: 'meta'}},
    saved.revision,
  );
  const result = await f.preflight(created.data.id);
  assert.equal(result.preflight.status, 'ready');
  assert.deepEqual(result.preflight.activation_gates, []);
  assert.equal(f.listReads().length, 0);
});
