import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {snapchatAllocationData} from './fixtures/snapchat-allocation-data.mjs';
function fixture(t) {
  const data = snapchatAllocationData(),
    store = new Store(':memory:', Buffer.alloc(32, 122).toString('base64')),
    owner = {tenantId: 'snapchat-allocation', userId: 'owner', role: 'admin'},
    key = store.createKey(owner),
    actor = store.authenticate(key);
  t.after(() => store.close());
  const connection = {
      id: data.report.connection_id,
      tenantId: actor.tenantId,
      gateway: data.report.gateway,
      accounts: [data.report.account_id],
      writeAccounts: [data.report.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: ['snapchat-marketing-api'],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection(owner, connection, credentials);
  store.putDocument(actor.tenantId, 'decision_report', 'source', data.report);
  let edit = (u, d) => d,
    allowWrite = false,
    writes = 0;
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(url);
      requests.push({url: u, method: init.method, body: init.body});
      if (init.method !== 'GET') {
        writes++;
        assert.equal(allowWrite, true);
        assert.equal(init.method, 'PATCH');
        const body = JSON.parse(init.body),
          squad = data.squads.find(s => u.pathname.endsWith('/' + s.id));
        assert.ok(squad);
        assert.deepEqual(
          body.map(op => [op.op, op.path]),
          [['replace', '/daily_budget_micro']],
        );
        squad.daily_budget_micro = body[0].value;
        return Response.json(data.wrap('adsquads', [squad]));
      }
      return Response.json(await edit(u, data.response(url), requests.length));
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (args, who = actor) => service.call('amcp_reporting', args, who),
    preview = () =>
      call({action: 'preview_allocation_plan', id: 'source', conversion: 'equal_daily', options: data.options}),
    create = p =>
      call({
        action: 'create_allocation_plan',
        id: 'source',
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      });
  return {
    ...data,
    store,
    actor,
    owner,
    key,
    connection,
    credentials,
    service,
    requests,
    call,
    preview,
    create,
    edit: fn => (edit = fn),
    writes: () => writes,
    allowWrite: () => (allowWrite = true),
  };
}
const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
test('Snapchat allocation derives exact micros and saves one parent-bound unapproved draft', async t => {
  const f = fixture(t),
    c = good(await f.call({action: 'allocation_candidates', id: 'source'}));
  assert.equal(c.candidates.length, 2);
  assert.equal(f.requests.length, 0);
  good(await f.call({action: 'allocation', id: 'source', options: f.options}));
  const p = good(await f.preview());
  assert.equal(p.targets[0].daily_budget_micros, '62500000');
  assert.equal(p.targets[0].entity_id, f.squads[0].id);
  assert.equal(p.targets[0].campaign_id, f.parent.id);
  assert.ok(p.native_source_references.length >= 5);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  const created = good(await f.create(p));
  assert.equal(good(await f.create(p)).id, created.id);
  const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  assert.equal(run.state, 'draft');
  assert.equal(run.allocation.gateway, 'snapchat_native_action');
  assert.equal(run.steps[0].arguments.action, 'snapchat_adsquad_update');
  assert.deepEqual(run.steps[0].arguments.path_params, {campaign_id: f.parent.id, ad_squad_id: f.squads[0].id});
  assert.deepEqual(run.steps[0].arguments.payload, [{op: 'replace', path: '/daily_budget_micro', value: 62500000}]);
  assert.equal(f.writes(), 0);
});
test('Snapchat budget preview rejects foreign parents, lifetime and smart budgets, native identity and incomplete responses', async t => {
  for (const mutate of [
    f => (f.parent.ad_account_id = f.squads[0].id),
    f => (f.parent.pacing_level = 'CAMPAIGN'),
    f => (f.parent.buy_model = 'RESERVED'),
    f => (f.squads[0].campaign_id = f.squads[1].id),
    f => (f.squads[0].lifetime_budget_micro = 100000000),
    f => (f.squads[0].delivery_constraint = 'LIFETIME_BUDGET'),
    f => (f.squads[0].daily_budget_micro = [200000000]),
    f => (f.account.currency = 'EUR'),
    f => (f.account.timezone = 'Asia/Riyadh'),
    f =>
      f.edit((u, d) =>
        u.pathname.endsWith('/adsquads') ? {...d, paging: {next_link: 'https://foreign.invalid/?cursor=x'}} : d,
      ),
    f => f.edit((u, d) => (u.pathname.endsWith('/' + f.squads[0].id) ? {...d, request_status: 'ERROR'} : d)),
  ]) {
    const f = fixture(t);
    mutate(f);
    const r = await f.preview();
    assert.equal(r.success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
    assert.equal(f.writes(), 0);
  }
});
test('Snapchat current budget and report evidence remain bound through preview, draft creation and unsent review', async t => {
  const f = fixture(t),
    p = good(await f.preview());
  f.squads[0].daily_budget_micro = 300000000;
  assert.equal((await f.create(p)).error.code, 'ALLOCATION_BUDGET_CHANGED');
  f.squads[0].daily_budget_micro = 200000000;
  const created = good(await f.create(p));
  f.squads[0].campaign_id = f.squads[1].id;
  const r = await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor);
  assert.equal(r.success, false);
  assert.equal(f.writes(), 0);
});
test('Snapchat allocation read rechecks credentials, scopes and actor authority before saving or subsequent egress', async t => {
  for (const change of [
    f => f.store.putConnection(f.owner, f.connection, {accessToken: 'changed'}),
    f => f.store.putConnection(f.owner, {...f.connection, scopes: []}, f.credentials),
    f => f.store.revokeKey(f.key),
  ]) {
    const f = fixture(t);
    f.edit((u, d, n) => {
      if (n === 1) change(f);
      return d;
    });
    const r = await f.preview();
    assert.equal(r.success, false);
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
    assert.equal(f.writes(), 0);
  }
});
test('Snapchat daily allocation keeps rounding residuals, exact floors and the native minimum', async t => {
  const f = fixture(t);
  f.options.budget = '200.000001';
  const p = good(await f.preview());
  assert.equal(p.targets[1].rounding_residual, '0.000001');
  f.options.allocations[1].minimum = '75.000001';
  assert.equal((await f.preview()).error.code, 'ALLOCATION_PRECISION');
  f.options.budget = '10';
  f.options.allocations.forEach(r => {
    r.minimum = '0';
    r.maximum = '10';
  });
  assert.equal((await f.preview()).success, false);
  assert.equal(f.writes(), 0);
});
test('Snapchat allocation executes only through the original reviewed lifecycle and verified receipt', async t => {
  const f = fixture(t);
  f.squads.forEach(s => (s.daily_budget_micro = 20000000));
  const p = good(await f.preview()),
    created = good(await f.create(p)),
    review = good(await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor));
  assert.equal(f.writes(), 0);
  f.allowWrite();
  const missing = await f.service.call(
    'amcp_campaign',
    {
      action: 'execute_next',
      id: created.id,
      review_id: review.review.review_id,
      idempotency_key: review.review.review_id,
      confirmed: true,
    },
    f.actor,
  );
  assert.equal(good(missing).current.error.code, 'SPEND_CONFIRMATION_REQUIRED');
  assert.equal(missing.data.current.status, 'review_ready');
  assert.equal(f.writes(), 0);
  const executed = good(
    await f.service.call(
      'amcp_campaign',
      {
        action: 'execute_next',
        id: created.id,
        review_id: review.review.review_id,
        idempotency_key: review.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      },
      f.actor,
    ),
  );
  assert.equal(executed.current.status, 'verified');
  assert.equal(f.writes(), 1);
});
test('Snapchat plan refuses a daily delivery-mode change after its allocation check and before dispatch', async t => {
  const f = fixture(t),
    p = good(await f.preview()),
    created = good(await f.create(p)),
    review = good(await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor));
  let accounts = 0;
  f.edit((u, d) => {
    if (u.pathname === '/v1/adaccounts/' + f.account.id && ++accounts === 3)
      f.squads[0].delivery_constraint = 'LIFETIME_BUDGET';
    return d;
  });
  f.allowWrite();
  const r = await f.service.call(
    'amcp_campaign',
    {
      action: 'execute_next',
      id: created.id,
      review_id: review.review.review_id,
      idempotency_key: review.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    },
    f.actor,
  );
  assert.equal(f.squads[0].delivery_constraint, 'LIFETIME_BUDGET');
  assert.equal(f.writes(), 0);
  assert.notEqual(r.data?.current?.status, 'verified');
});
test('Snapchat allocation retains bounded ownership pages and refuses repeated or missing source evidence', async t => {
  const f = fixture(t);
  f.edit((u, d) => {
    if (!u.pathname.endsWith('/adsquads')) return d;
    if (u.searchParams.has('cursor')) return f.wrap('adsquads', [f.squads[1]]);
    const next = new URL(u);
    next.searchParams.set('cursor', 'second');
    return {...f.wrap('adsquads', [f.squads[0]]), paging: {next_link: next.href}};
  });
  const p = good(await f.preview());
  assert.equal(p.native_source_references.length, 9);
  assert.equal(f.requests.filter(r => r.url.searchParams.get('cursor') === 'second').length, 1);
  f.edit((u, d) => {
    if (!u.pathname.endsWith('/adsquads')) return d;
    const next = new URL(u);
    next.searchParams.set('cursor', 'repeat');
    return {...f.wrap('adsquads', [f.squads[0]]), paging: {next_link: next.href}};
  });
  assert.equal((await f.preview()).success, false);
  const source = f.store.document(f.actor.tenantId, 'decision_report', 'source');
  delete source.native_account_evidence;
  f.store.putDocument(f.actor.tenantId, 'decision_report', 'source', source);
  const before = f.requests.length;
  assert.equal((await f.preview()).success, false);
  assert.equal(f.requests.length, before);
});
