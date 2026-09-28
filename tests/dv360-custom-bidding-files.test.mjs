import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Registering uploaded custom bidding scripts and rules on Display & Video 360 API v4 (pinned Discovery document, checked
 * 2026-09-27).
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  C = 'DV360_CUSTOM_BIDDING_ALGORITHMS_';
const actions = {script: C + 'SCRIPTS_CREATE', rules: C + 'RULES_CREATE'};
const actor = {tenantId: 'dv360-custom-bidding-files', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const error = (status, code, message) => Response.json({error: {code: status, status: code, message}}, {status});
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 74).toString('base64')),
    calls = [];
  store.putConnection(
    owner,
    {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    {accessToken: 'synthetic'},
  );
  // 801 is a script algorithm of the advertiser, 802 a rules algorithm, 803 a partner's, 804 archived, 805 assigned to a line item.
  const algorithms = new Map([
    ['801', {customBiddingAlgorithmType: 'SCRIPT_BASED', entityStatus: 'ENTITY_STATUS_ACTIVE', advertiserId: '123'}],
    ['802', {customBiddingAlgorithmType: 'RULE_BASED', entityStatus: 'ENTITY_STATUS_ACTIVE', advertiserId: '123'}],
    ['803', {customBiddingAlgorithmType: 'SCRIPT_BASED', entityStatus: 'ENTITY_STATUS_ACTIVE', partnerId: '1'}],
    ['804', {customBiddingAlgorithmType: 'SCRIPT_BASED', entityStatus: 'ENTITY_STATUS_ARCHIVED', advertiserId: '123'}],
    [
      '805',
      {
        customBiddingAlgorithmType: 'SCRIPT_BASED',
        entityStatus: 'ENTITY_STATUS_ACTIVE',
        advertiserId: '123',
        assigned: true,
      },
    ],
  ]);
  const files = {
    '801': [
      {
        customBiddingScriptId: '71',
        customBiddingAlgorithmId: '801',
        script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/old-1'},
        state: 'ACCEPTED',
        active: true,
      },
    ],
    '802': [],
    '805': [],
  };
  let writes = 0,
    next = 900;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: u.search});
      if (u.searchParams.has('partnerId')) return error(400, 'INVALID_ARGUMENT', 'Unexpected partner access.');
      if (u.searchParams.get('advertiserId') !== '123')
        return error(403, 'PERMISSION_DENIED', 'Advertiser access required.');
      let m = /^\/v4\/customBiddingAlgorithms\/(\d+)$/.exec(path);
      if (method === 'GET' && m) {
        const g = algorithms.get(m[1]);
        if (!g) return error(404, 'NOT_FOUND', 'Not found.');
        const {assigned, ...rest} = g;
        return Response.json({
          name: 'customBiddingAlgorithms/' + m[1],
          customBiddingAlgorithmId: m[1],
          displayName: 'Model ' + m[1],
          ...rest,
        });
      }
      m = /^\/v4\/customBiddingAlgorithms\/(\d+)\/(scripts|rules)$/.exec(path);
      if (method === 'GET' && m) {
        const rows = (files[m[1]] ?? []).filter(f => (m[2] === 'scripts') === 'script' in f),
          size = Number(u.searchParams.get('pageSize')),
          start = Number(u.searchParams.get('pageToken') ?? 0);
        // Pages of one row: the page token must be followed.
        const page = rows.slice(start, start + 1),
          more = start + 1 < rows.length;
        return Response.json({
          ...(page.length ? {[m[2] === 'scripts' ? 'customBiddingScripts' : 'customBiddingRules']: page} : {}),
          ...(more ? {nextPageToken: String(start + 1)} : {}),
          size,
        });
      }
      writes++;
      if (method === 'POST' && m) {
        const g = algorithms.get(m[1]);
        if (g?.assigned) return error(400, 'FAILED_PRECONDITION', 'The algorithm is assigned to a line item.');
        const script = m[2] === 'scripts',
          row = {
            [script ? 'customBiddingScriptId' : 'customBiddingAlgorithmRulesId']: String(next++),
            customBiddingAlgorithmId: m[1],
            ...body,
            state: script ? 'PENDING' : 'ACCEPTED',
            active: false,
          };
        if (mode !== 'ignore') (files[m[1]] ??= []).push(row);
        return Response.json(mode === 'other' ? {...row, customBiddingAlgorithmId: '999'} : row);
      }
      throw new Error('Unexpected ' + method + ' ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, algorithm, body, params = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, params: {customBiddingAlgorithmId: algorithm, advertiserId: '123', ...params}, body},
      },
      actor,
    );
  const script = (algorithm, ref = 'new-2', extra = {}) =>
    prepare(actions.script, algorithm, {
      script: {resourceName: 'customBiddingAlgorithms/' + algorithm + '/scriptRef/' + ref},
      ...extra,
    });
  const rules = (algorithm, ref = 'rules-1') =>
    prepare(actions.rules, algorithm, {
      rules: {resourceName: 'customBiddingAlgorithms/' + algorithm + '/rulesRef/' + ref},
    });
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, files, prepare, script, rules, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test("an uploaded script and uploaded rules are registered for the advertiser's algorithms and verify; a replay sends nothing", async () => {
  const f = fixture();
  try {
    f.files['801'].push({
      customBiddingScriptId: '72',
      customBiddingAlgorithmId: '801',
      script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/old-2'},
      state: 'REJECTED',
      active: false,
    });
    const s = ok(await f.script('801'));
    assert.equal(s.data.creative_impact.scope, 'custom_bidding_script');
    assert.equal(s.data.creative_impact.may_affect_serving, false);
    assert.ok(
      f.calls.some(c => c.path.endsWith('/scripts') && c.query.includes('pageToken=1')),
      'the page token is followed',
    );
    ok(await f.execute(s));
    assert.equal(f.files['801'].length, 3);
    assert.equal(ok(await f.verify(s)).data.status, 'verified');
    assert.equal((await f.execute(s)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const r = ok(await f.rules('802'));
    assert.equal(r.data.creative_impact.scope, 'custom_bidding_rules');
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed registrations are refused before any request; foreign, mismatched, archived and repeated files after reading', async () => {
  const cases = [
    [
      'a reference of another algorithm',
      f => f.prepare(actions.script, '801', {script: {resourceName: 'customBiddingAlgorithms/802/scriptRef/x'}}),
    ],
    [
      'a rules reference for a script',
      f => f.prepare(actions.script, '801', {script: {resourceName: 'customBiddingAlgorithms/801/rulesRef/x'}}),
    ],
    ['output fields', f => f.script('801', 'new-2', {state: 'ACCEPTED'})],
    [
      'a script body for rules',
      f => f.prepare(actions.rules, '802', {script: {resourceName: 'customBiddingAlgorithms/802/scriptRef/x'}}),
    ],
    [
      'a malformed reference',
      f => f.prepare(actions.script, '801', {script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/../x y'}}),
    ],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.error?.code, 'INVALID_DV360_CUSTOM_BIDDING_FILE', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const x = fixture();
  try {
    const r = await x.prepare(
      actions.script,
      '801',
      {script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/x'}},
      {partnerId: '1'},
    );
    assert.ok(r.error, 'partner access is refused');
    assert.equal(x.calls.length, 0);
  } finally {
    x.store.close();
  }
  const f = fixture();
  try {
    assert.equal((await f.script('809')).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.script('803')).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal((await f.rules('801')).error?.code, 'INVALID_DV360_CUSTOM_BIDDING_FILE');
    assert.equal((await f.script('804')).error?.code, 'INVALID_DV360_CUSTOM_BIDDING_FILE');
    assert.equal((await f.script('801', 'old-1')).error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a refusal for an assigned algorithm is never resubmitted, a receipt for another algorithm or an ignored registration is not verified, and the ledger lists both writes', async () => {
  const e = fixture();
  try {
    const p = ok(await e.script('805'));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const o = fixture('other');
  try {
    const p = ok(await o.script('801'));
    assert.equal((await o.execute(p)).success, false);
    assert.equal(o.writes(), 1);
  } finally {
    o.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const p of [ok(await g.script('801')), ok(await g.rules('802'))]) {
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'dv360_custom_bidding_files', action);
  }
});
