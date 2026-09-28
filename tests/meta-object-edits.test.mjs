import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Renaming and deleting Meta ad creatives and custom audiences (Marketing API v25.0 "Ad Creative" and "Custom Audience"
 * references, checked 2026-09-27).
 */
const gateway = 'meta_native_action',
  registry = new Registry();
const actor = {tenantId: 'meta-object-edits', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const actions = {
  creativeRename: 'meta_creative_id_update',
  creativeRenameAlias: 'meta_creative_update',
  creativeDelete: 'meta_creative_id_delete',
  audienceRename: 'meta_custom_audience_id_update',
  audienceRenameAlias: 'meta_custom_audience_update',
  audienceDelete: 'meta_custom_audience_id_delete',
  audienceDeleteAlias: 'meta_custom_audience_delete',
};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 87).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const creatives = new Map([
    ['801', {account_id: '123', name: 'Spring carousel', status: 'ACTIVE'}],
    ['802', {account_id: '123', name: 'Old banner', status: 'DELETED'}],
  ]);
  const audiences = new Map([
    [
      '901',
      {
        account_id: '123',
        name: 'Site visitors',
        description: 'Last 30 days',
        subtype: 'WEBSITE',
        delivery_status: {code: 200},
      },
    ],
    ['902', {account_id: '999', name: 'Shared audience', subtype: 'CUSTOM', delivery_status: {code: 200}}],
  ]);
  const pick = (o, f) =>
    Object.fromEntries(
      f
        .split(',')
        .filter(k => o[k] !== undefined)
        .map(k => [k, o[k]]),
    );
  const missing = () =>
    Response.json(
      {
        error: {
          message: 'Unsupported get request. Object with ID does not exist',
          type: 'GraphMethodException',
          code: 100,
          error_subcode: 33,
        },
      },
      {status: 400},
    );
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init.method;
      calls.push({path, method});
      if (method === 'GET') {
        if (path === '/v26.0/act_123/adcreatives')
          return Response.json({
            data: [...creatives].map(([id, c]) => ({id, ...pick(c, u.searchParams.get('fields') ?? 'name')})),
            paging: {cursors: {before: 'b', after: 'a'}},
          });
        if (path === '/v26.0/act_123/customaudiences')
          return Response.json({
            data: [...audiences].map(([id, a]) => ({id, ...pick(a, u.searchParams.get('fields') ?? 'name')})),
            paging: {cursors: {before: 'b', after: 'a'}},
          });
        const m = /^\/v26\.0\/(\d+)$/.exec(path);
        if (m && creatives.has(m[1]))
          return Response.json({id: m[1], ...pick(creatives.get(m[1]), u.searchParams.get('fields'))});
        if (m && audiences.has(m[1]))
          return Response.json({id: m[1], ...pick(audiences.get(m[1]), u.searchParams.get('fields'))});
        return missing();
      }
      writes++;
      const m = /^\/v26\.0\/(\d+)$/.exec(path),
        id = m?.[1],
        body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      if (mode === 'fail')
        return Response.json(
          {error: {message: 'Failed to delete custom audience because associated lookalikes exist.', code: 2656}},
          {status: 400},
        );
      if (method === 'DELETE') {
        if (mode !== 'ignore') {
          if (creatives.has(id)) creatives.get(id).status = 'DELETED';
          else audiences.delete(id);
        }
        return Response.json({success: true});
      }
      const target = creatives.get(id) ?? audiences.get(id);
      if (mode !== 'ignore') Object.assign(target, body);
      return Response.json(mode === 'nosuccess' ? {} : {success: true});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const discover = async () => {
    const c = await service.call(
      gateway,
      {
        action: 'meta_ad_account_id_adcreatives_get',
        account_id: '123',
        params: {ad_account_id: 'act_123', fields: 'id,name,account_id'},
      },
      actor,
    );
    assert.equal(c.success, true, JSON.stringify(c).slice(0, 400));
    const a = await service.call(
      gateway,
      {
        action: 'meta_ad_account_id_customaudiences_get',
        account_id: '123',
        params: {fields: 'id,name,account_id,subtype'},
      },
      actor,
    );
    assert.equal(a.success, true, JSON.stringify(a).slice(0, 400));
  };
  const prepare = (action, params, payload) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', params, ...(payload === undefined ? {} : {payload})},
      },
      actor,
    );
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
  return {store, calls, creatives, audiences, discover, prepare, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('a creative and an audience are renamed and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    await f.discover();
    const c = ok(await f.prepare(actions.creativeRename, {creative_id: '801'}, {name: 'Spring carousel v2'}));
    assert.equal(c.data.creative_impact.scope, 'ad_creative');
    assert.equal(c.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    assert.equal((await f.execute(c)).data.replayed, true);
    const a = ok(
      await f.prepare(
        actions.audienceRenameAlias,
        {custom_audience_id: '901'},
        {name: 'Site visitors 30d', description: 'Visited in the last 30 days'},
      ),
    );
    ok(await f.execute(a));
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
    assert.equal(f.audiences.get('901').name, 'Site visitors 30d');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('deleting a creative verifies DELETED and deleting an audience verifies it gone; both count as deletions and the audience deletion names its effect', async () => {
  const f = fixture();
  try {
    await f.discover();
    const c = ok(await f.prepare(actions.creativeDelete, {creative_id: '801'}));
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const a = ok(await f.prepare(actions.audienceDeleteAlias, {custom_audience_id: '901'}));
    assert.match(a.data.creative_impact.effect, /ads that use it stop running/);
    assert.equal(a.data.creative_impact.irreversible, true);
    ok(await f.execute(a));
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
    assert.equal(f.audiences.has('901'), false);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    await g.discover();
    saveSpendPolicy(g.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}});
    assert.equal(
      (await g.prepare(actions.audienceDelete, {custom_audience_id: '901'})).error?.code,
      'POLICY_DELETION_FORBIDDEN',
    );
    ok(await g.prepare(actions.creativeRenameAlias, {creative_id: '801'}, {name: 'Allowed'}));
  } finally {
    g.store.close();
  }
});

test('malformed edits are refused before any request; undiscovered, foreign, deleted and unchanged objects are refused without writes', async () => {
  const cases = [
    ['status change', actions.creativeRename, {creative_id: '801'}, {name: 'X', status: 'PAUSED'}],
    ['long creative name', actions.creativeRename, {creative_id: '801'}, {name: 'x'.repeat(101)}],
    ['audience rule', actions.audienceRename, {custom_audience_id: '901'}, {rule: '{}'}],
    ['empty rename', actions.audienceRename, {custom_audience_id: '901'}, {}],
    ['delete with body', actions.creativeDelete, {creative_id: '801'}, {name: 'x'}],
  ];
  for (const [label, action, params, payload] of cases) {
    const f = fixture();
    try {
      await f.discover();
      const before = f.calls.length;
      const r = await f.prepare(action, params, payload);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, before, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal(
      (await f.prepare(actions.creativeRename, {creative_id: '801'}, {name: 'X'})).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
    );
    await f.discover();
    assert.equal(
      (await f.prepare(actions.audienceRename, {custom_audience_id: '902'}, {name: 'X'})).error?.code,
      'RESOURCE_SCOPE_REQUIRED',
    );
    assert.equal(
      (await f.prepare(actions.creativeRename, {creative_id: '802'}, {name: 'X'})).error?.code,
      'INVALID_META_OBJECT_EDIT',
    );
    assert.equal(
      (await f.prepare(actions.creativeRename, {creative_id: '801'}, {name: 'Spring carousel'})).error?.code,
      'INVALID_META_OBJECT_EDIT',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a refused deletion and a reply without success are failures never resubmitted; an ignored rename is not verified; the ledger lists the seven writes', async () => {
  for (const mode of ['fail', 'nosuccess']) {
    const f = fixture(mode);
    try {
      await f.discover();
      const p = ok(
        await f.prepare(
          mode === 'fail' ? actions.audienceDelete : actions.audienceRename,
          {custom_audience_id: '901'},
          mode === 'fail' ? undefined : {name: 'New'},
        ),
      );
      assert.equal((await f.execute(p)).success, false, mode);
      assert.equal((await f.execute(p)).success, false, mode);
      assert.equal(f.writes(), 1, mode);
    } finally {
      f.store.close();
    }
  }
  const ignored = fixture('ignore');
  try {
    await ignored.discover();
    const p = ok(await ignored.prepare(actions.creativeRename, {creative_id: '801'}, {name: 'New'}));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'meta_object_edits', action);
  }
});
