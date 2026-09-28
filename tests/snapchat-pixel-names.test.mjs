import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Renaming Snapchat pixels at ad account and organization level ("Snap Pixel", checked 2026-09-27).
 */
const gateway = 'snapchat_native_action',
  registry = new Registry(),
  account = 'acct1',
  org = 'org-1';
const actions = {
  account: 'snapchat_adaccounts_ad_account_id_pixels_update',
  alias: 'snapchat_pixel_update',
  organization: 'snapchat_organizations_organization_id_pixels_update',
};
const actor = {tenantId: 'snap-pixel-names', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 68).toString('base64')),
    calls = [];
  let writes = 0,
    n = 0;
  store.putConnection(
    owner,
    {
      id: '44444444-4444-4444-8444-44444444444b',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Snap',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const accountPixels = new Map([['px-1', {name: 'Site pixel', status: 'ACTIVE'}]]),
    orgPixels = new Map([
      ['px-1', {name: 'Site pixel', status: 'ACTIVE'}],
      ['px-org', {name: 'Shared pixel', status: 'ACTIVE'}],
    ]);
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const u = new URL(String(raw)),
        path = u.pathname,
        method = init.method ?? 'GET';
      calls.push(method + ' ' + path);
      const ok = body => Response.json({request_status: 'SUCCESS', request_id: 'r' + ++n, ...body});
      if (method === 'GET') {
        if (path === '/v1/adaccounts/acct1')
          return ok({
            adaccounts: [
              {sub_request_status: 'SUCCESS', adaccount: {id: account, name: 'Synthetic', organization_id: org}},
            ],
          });
        if (path === '/v1/adaccounts/acct1/pixels')
          return ok({
            pixels: [...accountPixels].map(([id, x]) => ({
              sub_request_status: 'SUCCESS',
              pixel: {id, ad_account_id: account, ...x},
            })),
          });
        if (path === '/v1/organizations/org-1/pixels')
          return ok({
            pixels: [...orgPixels].map(([id, x]) => ({
              sub_request_status: 'SUCCESS',
              pixel: {id, organization_id: org, ...x},
            })),
          });
        throw new Error('Unexpected ' + method + ' ' + path);
      }
      writes++;
      const body = JSON.parse(String(init.body)),
        target =
          path === '/v1/adaccounts/acct1/pixels'
            ? accountPixels
            : path === '/v1/organizations/org-1/pixels'
              ? orgPixels
              : undefined;
      if (!target || method !== 'PUT') throw new Error('Unexpected ' + method + ' ' + path);
      if (mode === 'error')
        return Response.json({
          request_status: 'ERROR',
          request_id: 'r' + ++n,
          pixels: body.pixels.map(() => ({sub_request_status: 'ERROR'})),
        });
      return ok({
        pixels: body.pixels.map(x => {
          if (mode !== 'ignore') {
            target.get(x.id).name = x.name;
            if (target === accountPixels && orgPixels.has(x.id)) orgPixels.get(x.id).name = x.name;
          }
          return {sub_request_status: 'SUCCESS', pixel: {id: x.id, ...target.get(x.id), organization_id: org}};
        }),
      });
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
  const rename = (action, list, params) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          ad_account_id: account,
          params: params ?? (action === actions.organization ? {organization_id: org} : {ad_account_id: account}),
          payload: {pixels: list},
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, accountPixels, orgPixels, rename, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const px = (id, name, extra = {}) => ({id, name, ad_account_id: account, ...extra});
const opx = (id, name, extra = {}) => ({id, name, organization_id: org, ...extra});

test('a pixel of the account and one of its organization are renamed and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const a = ok(await f.rename(actions.account, [px('px-1', 'Checkout pixel')]));
    assert.equal(a.data.creative_impact.scope, 'pixel');
    assert.deepEqual(a.data.creative_impact.renaming, [{id: 'px-1', before: 'Site pixel', after: 'Checkout pixel'}]);
    ok(await f.execute(a));
    assert.equal(ok(await f.verify(a)).data.status, 'verified');
    assert.equal((await f.execute(a)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const o = ok(await f.rename(actions.organization, [opx('px-org', 'Organization pixel')]));
    assert.equal(o.data.creative_impact.level, 'organization');
    ok(await f.execute(o));
    assert.equal(f.orgPixels.get('px-org').name, 'Organization pixel');
    assert.equal(ok(await f.verify(o)).data.status, 'verified');
    const b = ok(await f.rename(actions.alias, [px('px-1', 'Checkout pixel 2')]));
    ok(await f.execute(b));
    assert.equal(ok(await f.verify(b)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('malformed renames are refused before any request; unknown pixels, another organization and unchanged names after reading', async () => {
  const cases = [
    ['empty list', actions.account, []],
    ['another field', actions.account, [px('px-1', 'Name', {status: 'PAUSED'})]],
    ['missing owner', actions.account, [{id: 'px-1', name: 'Name'}]],
    ['another account', actions.account, [px('px-1', 'Name', {ad_account_id: 'acct2'})]],
    ['organization id at account level', actions.account, [opx('px-1', 'Name')]],
    ['blank name', actions.account, [px('px-1', ' ')]],
    ['long name', actions.account, [px('px-1', 'x'.repeat(376))]],
    ['the same pixel twice', actions.account, [px('px-1', 'A'), px('px-1', 'B')]],
    ['another organization in the body', actions.organization, [opx('px-org', 'Name', {organization_id: 'org-2'})]],
  ];
  for (const [label, action, list] of cases) {
    const f = fixture();
    try {
      const r = await f.rename(action, list);
      assert.equal(r.error?.code, 'INVALID_SNAPCHAT_PIXEL_NAME', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.rename(actions.account, [px('px-org', 'Name')])).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (
        await f.rename(actions.organization, [{id: 'px-org', name: 'Name', organization_id: 'org-2'}], {
          organization_id: 'org-2',
        })
      ).error?.code,
      'ACCOUNT_SCOPE_MISMATCH',
    );
    assert.equal(
      (await f.rename(actions.account, [px('px-1', 'Site pixel')])).error?.code,
      'INVALID_SNAPCHAT_PIXEL_NAME',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an error reply is never resubmitted, an ignored rename is not verified, and the ledger lists all three writes', async () => {
  const e = fixture('error');
  try {
    const p = ok(await e.rename(actions.account, [px('px-1', 'New')]));
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const p of [
      ok(await g.rename(actions.account, [px('px-1', 'New')])),
      ok(await g.rename(actions.organization, [opx('px-org', 'New')])),
    ]) {
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
    assert.equal(rows[0].family, 'snapchat_pixel_names', action);
  }
});
