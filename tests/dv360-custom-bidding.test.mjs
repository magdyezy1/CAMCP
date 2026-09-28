import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Advertiser-owned custom bidding algorithms on Display & Video 360 API v4 (pinned Discovery document, checked
 * 2026-09-27): creation and patches of the name and status.
 */
const gateway = 'dv360_native_action',
  registry = new Registry(),
  C = 'DV360_CUSTOM_BIDDING_ALGORITHMS_';
const actor = {tenantId: 'dv360-custom-bidding', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const error = (status, code, message) => Response.json({error: {code: status, status: code, message}}, {status});
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64')),
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
  // 801 belongs to the advertiser, 802 to the partner and is shared with it, 803 is assigned to a line item.
  const algorithms = new Map([
    [
      '801',
      {
        displayName: 'Conversions model',
        customBiddingAlgorithmType: 'SCRIPT_BASED',
        entityStatus: 'ENTITY_STATUS_ACTIVE',
        advertiserId: '123',
      },
    ],
    [
      '802',
      {
        displayName: 'Partner model',
        customBiddingAlgorithmType: 'RULE_BASED',
        entityStatus: 'ENTITY_STATUS_ACTIVE',
        partnerId: '1',
      },
    ],
    [
      '803',
      {
        displayName: 'In use',
        customBiddingAlgorithmType: 'SCRIPT_BASED',
        entityStatus: 'ENTITY_STATUS_ACTIVE',
        advertiserId: '123',
        assigned: true,
      },
    ],
  ]);
  let writes = 0,
    next = 900;
  const shown = (id, g) => {
    const {assigned, ...rest} = g;
    return {name: 'customBiddingAlgorithms/' + id, customBiddingAlgorithmId: id, ...rest};
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method,
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, method, query: u.search});
      if (u.searchParams.has('partnerId')) return error(400, 'INVALID_ARGUMENT', 'Unexpected partner access.');
      if (method === 'GET') {
        if (path === '/v4/advertisers/123')
          return Response.json({
            name: 'advertisers/123',
            advertiserId: '123',
            partnerId: '1',
            displayName: 'Advertiser',
            entityStatus: 'ENTITY_STATUS_ACTIVE',
          });
        if (u.searchParams.get('advertiserId') !== '123')
          return error(403, 'PERMISSION_DENIED', 'Advertiser access required.');
        const m = /^\/v4\/customBiddingAlgorithms\/(\d+)$/.exec(path);
        if (m && algorithms.has(m[1])) return Response.json(shown(m[1], algorithms.get(m[1])));
        return error(404, 'NOT_FOUND', 'Not found.');
      }
      writes++;
      if (path === '/v4/customBiddingAlgorithms' && method === 'POST') {
        const id = String(next++),
          g = {entityStatus: 'ENTITY_STATUS_ACTIVE', ...body};
        if (mode !== 'ignore') algorithms.set(id, g);
        return Response.json(shown(id, mode === 'other' ? {...g, advertiserId: '999'} : g));
      }
      const m = /^\/v4\/customBiddingAlgorithms\/(\d+)$/.exec(path),
        g = m && algorithms.get(m[1]);
      if (g && method === 'PATCH') {
        if (g.assigned) return error(400, 'FAILED_PRECONDITION', 'The algorithm is assigned to a line item.');
        const changed = {...g};
        for (const f of u.searchParams.get('updateMask').split(',')) changed[f] = body[f];
        if (mode !== 'ignore') algorithms.set(m[1], changed);
        return Response.json(shown(m[1], changed));
      }
      throw new Error('Unexpected write ' + method + ' ' + path);
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
  const prepare = (action, params, body) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, params, ...(body === undefined ? {} : {body})}},
      actor,
    );
  const create = b => prepare(C + 'CREATE', {}, {advertiserId: '123', ...b});
  const patch = (id, mask, b) =>
    prepare(C + 'PATCH', {customBiddingAlgorithmId: id, updateMask: mask}, {advertiserId: '123', ...b});
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, algorithms, service, create, patch, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('an algorithm is created without spending confirmation and verifies; it is renamed and archived, each verified; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.create({displayName: 'Store visits model', customBiddingAlgorithmType: 'SCRIPT_BASED'}));
    assert.equal(p.data.creative_impact.scope, 'custom_bidding_algorithm');
    assert.match(p.data.creative_impact.effect, /bids only after a script or rules/);
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const r = ok(await f.patch('801', 'displayName', {displayName: 'Conversions model v2'}));
    ok(await f.execute(r));
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
    const a = ok(await f.patch('801', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ARCHIVED'}));
    ok(await f.execute(a));
    assert.equal(f.algorithms.get('801').entityStatus, 'ENTITY_STATUS_ARCHIVED');
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('malformed algorithms and patches are refused before any request', async () => {
  const cases = [
    [
      'other advertiser',
      f => f.create({advertiserId: '999', displayName: 'X', customBiddingAlgorithmType: 'SCRIPT_BASED'}),
    ],
    ['partner owner', f => f.create({partnerId: '1', displayName: 'X', customBiddingAlgorithmType: 'SCRIPT_BASED'})],
    ['unknown type', f => f.create({displayName: 'X', customBiddingAlgorithmType: 'MODEL_BASED'})],
    ['long name', f => f.create({displayName: 'é'.repeat(121), customBiddingAlgorithmType: 'SCRIPT_BASED'})],
    ['surrounding spaces', f => f.create({displayName: ' X ', customBiddingAlgorithmType: 'SCRIPT_BASED'})],
    [
      'draft status',
      f =>
        f.create({displayName: 'X', customBiddingAlgorithmType: 'SCRIPT_BASED', entityStatus: 'ENTITY_STATUS_DRAFT'}),
    ],
    [
      'third party',
      f =>
        f.create({
          displayName: 'X',
          customBiddingAlgorithmType: 'SCRIPT_BASED',
          thirdPartyOptimizationPartner: 'SCIBIDS',
        }),
    ],
    ['type change', f => f.patch('801', 'customBiddingAlgorithmType', {customBiddingAlgorithmType: 'RULE_BASED'})],
    ['mask without field', f => f.patch('801', 'displayName,entityStatus', {displayName: 'Y'})],
    [
      'field without mask',
      f => f.patch('801', 'displayName', {displayName: 'Y', entityStatus: 'ENTITY_STATUS_ARCHIVED'}),
    ],
    ['patch of another advertiser', f => f.patch('801', 'displayName', {advertiserId: '999', displayName: 'Y'})],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
});

test('partner-owned, unknown and unchanged algorithms are refused after reading; DV360 refuses an assigned algorithm, which is never resubmitted', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.patch('802', 'displayName', {displayName: 'Mine now'})).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal((await f.patch('809', 'displayName', {displayName: 'Unknown'})).error?.code, 'STATE_NOT_FOUND');
    assert.match(
      (await f.patch('801', 'displayName', {displayName: 'Conversions model'})).error?.message ?? '',
      /already has these values/,
    );
    assert.equal(f.writes(), 0);
    const p = ok(await f.patch('803', 'entityStatus', {entityStatus: 'ENTITY_STATUS_ARCHIVED'}));
    assert.equal((await f.execute(p)).success, false);
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (
        await g.create({
          displayName: 'X',
          customBiddingAlgorithmType: 'SCRIPT_BASED',
          entityStatus: 'ENTITY_STATUS_ACTIVE',
        })
      ).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(
      await g.create({
        displayName: 'X',
        customBiddingAlgorithmType: 'SCRIPT_BASED',
        entityStatus: 'ENTITY_STATUS_ARCHIVED',
      }),
    );
  } finally {
    g.store.close();
  }
});

test('a receipt for another advertiser is a failure, an ignored patch is not verified, reads name the advertiser, the models match and the ledger lists both writes', async () => {
  const f = fixture('other');
  try {
    const p = ok(await f.create({displayName: 'X', customBiddingAlgorithmType: 'RULE_BASED'}));
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture('ignore');
  try {
    const p = ok(await g.patch('801', 'displayName', {displayName: 'Ignored'}));
    ok(await g.execute(p));
    assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    ok(
      await g.service.call(
        gateway,
        {action: C + 'GET', params: {advertiserId: '123', customBiddingAlgorithmId: '801'}},
        actor,
      ),
    );
    assert.equal(
      (
        await g.service.call(
          gateway,
          {action: C + 'GET', params: {partnerId: '1', customBiddingAlgorithmId: '801'}},
          actor,
        )
      ).success,
      false,
    );
  } finally {
    g.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/dv360-v4.json', 'utf8')),
    doc = d.document ?? d,
    S = doc.schemas.CustomBiddingAlgorithm.properties;
  assert.deepEqual(S.customBiddingAlgorithmType.enum, [
    'CUSTOM_BIDDING_ALGORITHM_TYPE_UNSPECIFIED',
    'SCRIPT_BASED',
    'RULE_BASED',
  ]);
  assert.match(S.displayName.description, /240 bytes/);
  assert.match(S.entityStatus.description, /ENTITY_STATUS_ACTIVE.*ENTITY_STATUS_ARCHIVED/s);
  assert.match(
    doc.resources.customBiddingAlgorithms.methods.patch.description,
    /assigned to a line item will return an error/,
  );
  for (const action of [C + 'CREATE', C + 'PATCH']) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'dv360_custom_bidding', action);
  }
});
