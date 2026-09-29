import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {SNAP, actor, fixture, gateway} from './snapchat-plan-fixture.js';

/**
 * F-70 and the owner's decision 7 (2026-09-29): an ownership observation lasts five minutes, so a read or a prepare
 * after it lapsed was refused with the read that renews it, costing the agent two more calls. When that read is the
 * account's own list narrowed to the one refused ID, AMCP now runs it and retries once. Ownership still comes only from
 * the account's list: an ID the account does not list stays unreadable, and no request ever names it.
 */
const wrapped = (kind: string, rows: JsonObject[]) =>
  Response.json({
    request_status: 'SUCCESS',
    paging: {},
    [kind]: rows.map(r => ({sub_request_status: 'SUCCESS', [kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1)]: r})),
  });
function account() {
  const f = fixture({
    routes: (method, path) => {
      if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives')
        return wrapped('creatives', [
          {id: 'creative-1', ad_account_id: 'acct1', name: 'One', type: 'WEB_VIEW'},
          {id: 'creative-2', ad_account_id: 'acct1', name: 'Two', type: 'WEB_VIEW'},
        ]);
      if (method === 'GET' && path === '/v1/creatives/creative-2')
        return wrapped('creatives', [{id: 'creative-2', ad_account_id: 'acct1', name: 'Two', type: 'WEB_VIEW'}]);
      if (method === 'GET' && path === '/v1/adaccounts/acct1/adsquads')
        return wrapped('adsquads', [{id: 'sq-1', campaign_id: 'camp-1', name: 'Squad', status: 'PAUSED'}]);
      return undefined;
    },
  });
  // An ad squad this account created earlier.
  f.squads.set('sq-1', {id: 'sq-1', campaign_id: 'camp-1', name: 'Squad', status: 'PAUSED'});
  // Observations this login made more than five minutes ago: they have lapsed.
  const connection = f.store.resolveConnection(actor, gateway, 'acct1', SNAP);
  for (const r of ['creatives/creative-2', 'adsquads/sq-1', 'creatives/creative-gone'])
    f.store.rememberResource(connection, 'acct1', r, -1);
  return f;
}
const read = (f: ReturnType<typeof fixture>, action: string, extra: JsonObject = {}) =>
  f.call(gateway, {action, connection_id: SNAP, account_id: 'acct1', ...extra});

test('a read whose ownership lapsed renews it from the account list and succeeds in one call', async () => {
  const f = account();
  try {
    const r = await read(f, 'snapchat_creative_get', {path_params: {creative_id: 'creative-2'}});
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.equal(r.data.data.creatives[0].creative.id, 'creative-2');
    assert.deepEqual(r.meta.ownership_refreshed, {
      tool: gateway,
      action: 'snapchat_creative_list',
      result_ids: ['creative-2'],
    });
    assert.deepEqual(f.requests, ['GET /v1/adaccounts/acct1/creatives', 'GET /v1/creatives/creative-2']);
  } finally {
    f.close();
  }
});

test('an ID the account no longer lists stays refused, and no request names it', async () => {
  const f = account();
  try {
    const r = await read(f, 'snapchat_creative_get', {path_params: {creative_id: 'creative-gone'}});
    assert.equal(r.error?.code, 'RESOURCE_SCOPE_REQUIRED', JSON.stringify(r).slice(0, 800));
    assert.equal(r.meta?.ownership_refreshed, undefined);
    assert.ok(!f.requests.some(q => q.includes('creative-gone')), f.requests.join());
    assert.equal(f.requests.filter(q => q.endsWith('/creatives')).length, 1, 'one narrowed list read, no retry loop');
  } finally {
    f.close();
  }
});

test('an ID never observed is refused as before, with the read to run and without any request', async () => {
  const f = account();
  try {
    const r = await read(f, 'snapchat_creative_get', {path_params: {creative_id: 'creative-1'}});
    assert.equal(r.error?.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.deepEqual(r.error.details.next_call.arguments.result_ids, ['creative-1']);
    assert.deepEqual(f.requests, []);
  } finally {
    f.close();
  }
});

test('a prepare whose parent ownership lapsed renews it and returns the review', async () => {
  const f = account();
  try {
    const r = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: SNAP,
      arguments: {
        action: 'snapchat_ad_create',
        account_id: 'acct1',
        path_params: {ad_squad_id: 'sq-1'},
        payload: {
          ads: [{ad_squad_id: 'sq-1', name: 'Ad', type: 'SNAP_AD', creative_id: 'creative-1', status: 'PAUSED'}],
        },
      },
    });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.ok(r.data.review_id);
    assert.equal(r.meta.ownership_refreshed.action, 'snapchat_adsquad_list');
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});
