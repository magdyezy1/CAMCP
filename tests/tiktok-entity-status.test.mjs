import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {familyOf} from '../dist/src/reviewed-families.js';

/**
 * WRT-02: standard TikTok campaign, ad group and ad status changes (API for Business v1.3 /status/update/). Before the
 * tiktok_entity_status family a DELETE was a generic entity write the catalog marks non-destructive, so an owner policy
 * with allow_deletion:false let it through and sent it (the review's probe: one synthetic write). Every fixture here is
 * synthetic; nothing contacts TikTok.
 */
const TIKTOK = '27272727-2727-4272-8272-272727272727',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-entity-status', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  key = Buffer.alloc(32, 77).toString('base64');
const idKey = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'ad_id'},
  secondary = {campaign: 'CAMPAIGN_STATUS_DELETE', adgroup: 'ADGROUP_STATUS_DELETE', ad: 'AD_STATUS_DELETE'};
function fixture({mode = '', reply = 'ids'} = {}) {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const rows = {
    campaign: new Map([
      ['100', {campaign_id: '100', campaign_name: 'Spring', operation_status: 'ENABLE'}],
      ['101', {campaign_id: '101', campaign_name: 'Summer', operation_status: 'DISABLE'}],
    ]),
    adgroup: new Map([
      ['200', {adgroup_id: '200', campaign_id: '100', adgroup_name: 'Group A', operation_status: 'ENABLE'}],
      ['201', {adgroup_id: '201', campaign_id: '100', adgroup_name: 'Group B', operation_status: 'DISABLE'}],
    ]),
    ad: new Map([
      ['300', {ad_id: '300', adgroup_id: '200', campaign_id: '100', ad_name: 'Ad A', operation_status: 'ENABLE'}],
      ['301', {ad_id: '301', adgroup_id: '201', campaign_id: '100', ad_name: 'Ad B', operation_status: 'DISABLE'}],
    ]),
  };
  const deleted = new Set(),
    requests = [],
    writes = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path + (url.search ? ' ' + decodeURIComponent(url.search) : ''));
    const get = /^\/v1\.3\/(campaign|adgroup|ad)\/get\/$/.exec(path),
      set = /^\/v1\.3\/(campaign|adgroup|ad)\/status\/update\/$/.exec(path);
    if (method === 'GET' && get) {
      const k = get[1],
        filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        all = filtering.primary_status === 'STATUS_ALL';
      const list = [...rows[k].values()]
        .filter(r =>
          ['campaign_ids', 'adgroup_ids', 'ad_ids'].every(
            f => !filtering[f] || filtering[f].includes(r[f.slice(0, -1)]),
          ),
        )
        .filter(r => !deleted.has(k + r[idKey[k]]) || (all && mode !== 'purged'))
        .map(r => (deleted.has(k + r[idKey[k]]) ? {...r, secondary_status: secondary[k]} : structuredClone(r)));
      const pages = mode === 'paged' && k !== 'campaign' && !filtering[k + '_ids'] ? 2 : 1;
      return ok({list, page_info: {page: 1, page_size: 1000, total_number: list.length, total_page: pages}});
    }
    if (method === 'POST' && set) {
      const k = set[1],
        b = JSON.parse(init.body),
        list = b[k + '_ids'];
      writes.push({kind: k, body: b});
      if (mode !== 'ignored')
        for (const id of list)
          if (b.operation_status === 'DELETE') deleted.add(k + id);
          else rows[k].set(id, {...rows[k].get(id), operation_status: b.operation_status});
      return ok(reply === 'ids' ? {[k + '_ids']: list, status: b.operation_status} : {});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  for (const id of ['100', '101', '200', '201', '300', '301'])
    store.rememberResource({id: TIKTOK, tenantId: actor.tenantId, gateway}, account, id);
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (kind, list, status, extra = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {
        action: 'tiktok_' + kind + '_status_update',
        account_id: account,
        payload: {[kind + '_ids']: list, operation_status: status, ...extra},
      },
    });
  const execute = (id, extra = {}) =>
    call('amcp_write', {
      action: 'execute',
      review_id: id,
      idempotency_key: id,
      confirmed: true,
      spend_change_confirmed: true,
      ...extra,
    });
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  const policy = p =>
    saveSpendPolicy(store, owner, {gateway, account_id: account, connection_id: TIKTOK, confirmed: true, policy: p});
  return {store, rows, deleted, requests, writes, prepare, execute, verify, policy};
}

test('with allow_deletion:false every TikTok status DELETE is refused before any write; ENABLE and DISABLE are not', async () => {
  const f = fixture();
  try {
    f.policy({allow_deletion: false, allow_activation: true});
    for (const [kind, id] of [
      ['campaign', '100'],
      ['adgroup', '200'],
      ['ad', '300'],
    ]) {
      const refused = await f.prepare(kind, [id], 'DELETE');
      assert.equal(refused.error?.code, 'POLICY_DELETION_FORBIDDEN', kind + ': ' + JSON.stringify(refused));
      assert.equal(refused.error?.details?.field ?? '/body/operation_status', '/body/operation_status');
    }
    for (const status of ['DISABLE', 'ENABLE']) {
      const p = await f.prepare('campaign', ['101'], status);
      assert.equal(p.success, true, status + ': ' + JSON.stringify(p));
    }
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a saved DELETE review is refused at execute once the owner forbids deletion, and nothing is sent', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('adgroup', ['201'], 'DELETE');
    assert.equal(p.success, true, JSON.stringify(p));
    f.policy({allow_deletion: false, allow_activation: true});
    const out = await f.execute(p.data.review_id);
    assert.equal(out.error?.code, 'POLICY_DELETION_FORBIDDEN', JSON.stringify(out));
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('ENABLE is activation under allow_activation:false; the family classifies DELETE as destructive and ENABLE as activation', async () => {
  const f = fixture();
  try {
    f.policy({allow_activation: false});
    assert.equal((await f.prepare('campaign', ['101'], 'ENABLE')).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal((await f.prepare('campaign', ['100'], 'DISABLE')).success, true);
    const plan = status => ({
      gateway,
      accountId: account,
      action: 'tiktok_campaign_status_update',
      method: 'POST',
      path: '/v1.3/campaign/status/update/',
      headers: {},
      query: {},
      body: {advertiser_id: account, campaign_ids: ['100'], operation_status: status},
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      evidence: 'synthetic',
      warnings: [],
    });
    assert.equal(familyOf(plan('DELETE'))?.name, 'tiktok_entity_status');
    assert.equal(applyExecutionRisk(plan('DELETE')).destructive, true);
    assert.equal(applyExecutionRisk(plan('DISABLE')).destructive, false);
    assert.equal(applyExecutionRisk(plan('ENABLE')).destructive, false);
    assert.equal(familyOf(plan('ENABLE')).activates(plan('ENABLE')), true);
    assert.equal(familyOf(plan('DISABLE')).activates(plan('DISABLE')), false);
  } finally {
    f.store.close();
  }
});

test('the action ledger assigns the three status routes to tiktok_entity_status, with its deletion hook', () => {
  const rows = actionContracts(new Registry()).filter(
    r => r.gateway === gateway && /^tiktok_(campaign|adgroup|ad)_status_update$/.test(r.action),
  );
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.status, 'reviewed_write_family', r.action);
    assert.equal(r.family, 'tiktok_entity_status', r.action);
    assert.equal(r.implementation, 'src/tiktok-entity-status.ts');
    assert.deepEqual(r.tests, ['tests/tiktok-entity-status.test.mjs']);
  }
});

test('the request is 1-20 unique numeric IDs and one status, without partial success, SKAN windows or ACO ads', async () => {
  const f = fixture();
  try {
    const refusal = async (kind, list, status, extra) => (await f.prepare(kind, list, status, extra)).error;
    assert.equal(
      (await refusal('adgroup', ['200'], 'DISABLE', {allow_partial_success: true}))?.code,
      'INVALID_TIKTOK_STATUS',
    );
    assert.equal((await f.prepare('adgroup', ['201'], 'DISABLE', {allow_partial_success: false})).success, true);
    assert.equal(
      (await refusal('campaign', ['100'], 'DISABLE', {postback_window_mode: 'POSTBACK_WINDOW_MODE1'}))?.details?.field,
      'postback_window_mode',
    );
    assert.equal((await refusal('ad', ['300'], 'DISABLE', {aco_ad_ids: ['9']}))?.details?.field, 'aco_ad_ids');
    assert.equal((await refusal('ad', ['300', '300'], 'DISABLE'))?.code, 'INVALID_TIKTOK_STATUS');
    assert.equal(
      (
        await refusal(
          'ad',
          Array.from({length: 21}, (_, i) => String(400 + i)),
          'DISABLE',
        )
      )?.code,
      'INVALID_TIKTOK_STATUS',
    );
    assert.equal((await refusal('ad', ['300'], 'ARCHIVE'))?.code, 'INVALID_TIKTOK_STATUS');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a campaign DELETE review lists the ad groups and ads it takes with it and which of them are enabled', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('campaign', ['100'], 'DELETE');
    assert.equal(p.success, true, JSON.stringify(p));
    const impact = p.data.creative_impact;
    assert.equal(impact.operation, 'delete');
    assert.equal(impact.enabled_children, 2);
    assert.deepEqual(
      impact.children.map(c => [c.kind, c.all, c.enabled.map(e => e.name)]),
      [
        ['adgroup', ['200', '201'], ['Group A']],
        ['ad', ['300', '301'], ['Ad A']],
      ],
    );
    assert.deepEqual(impact.changes, [
      {campaign_id: '100', name: 'Spring', before: 'ENABLE', after: 'DELETE', unchanged: false},
    ]);
    assert.ok(f.requests.some(r => r.startsWith('GET /v1.3/adgroup/get/') && r.includes('"campaign_ids":["100"]')));
    assert.ok(f.requests.some(r => r.startsWith('GET /v1.3/ad/get/') && r.includes('"campaign_ids":["100"]')));
    const out = await f.execute(p.data.review_id);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].body.campaign_ids, ['100']);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified));
    assert.ok(f.requests.some(r => r.startsWith('GET /v1.3/campaign/get/') && r.includes('STATUS_ALL')));
  } finally {
    f.store.close();
  }
});

test('children that do not fit one complete page fail the DELETE review closed', async () => {
  const f = fixture({mode: 'paged'});
  try {
    const p = await f.prepare('adgroup', ['200'], 'DELETE');
    assert.equal(p.error?.code, 'INCOMPLETE_STATE', JSON.stringify(p));
    assert.equal(f.writes.length, 0);
    // Without children to read, a pause is not affected.
    assert.equal((await f.prepare('adgroup', ['200'], 'DISABLE')).success, true);
  } finally {
    f.store.close();
  }
});

test('a deletion read back as no longer listed is verified; one still listed and not deleted is not', async () => {
  const purged = fixture({mode: 'purged', reply: 'empty'});
  try {
    const p = await purged.prepare('ad', ['301'], 'DELETE');
    assert.equal((await purged.execute(p.data.review_id)).success, true);
    const v = await purged.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.ok(purged.requests.some(r => r.startsWith('GET /v1.3/ad/get/') && r.includes('STATUS_NOT_DELETE')));
  } finally {
    purged.store.close();
  }
  const ignored = fixture({mode: 'ignored'});
  try {
    const p = await ignored.prepare('ad', ['301'], 'DELETE');
    assert.equal((await ignored.execute(p.data.review_id)).success, true);
    const v = await ignored.verify(p.data.review_id);
    assert.notEqual(v.data.status, 'verified', JSON.stringify(v));
  } finally {
    ignored.store.close();
  }
});

test('a pause is verified by the operation status read back', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('campaign', ['100'], 'DISABLE');
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});
