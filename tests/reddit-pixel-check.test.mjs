import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {redditPixelStaleDays} from '../dist/src/reddit-writes.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * PRV-06 D: the conversion pixel of a Reddit ad group. Reddit requires one for every ad group and CBO campaign from
 * 2026-07-13, and the review used to check only the ID's format: a mistyped, foreign or dead pixel reached Reddit.
 * The review now reads the account's pixel list first (a pixel it does not name is refused before anything is sent),
 * then the listed pixel's last-fired report, which the impact shows with a warning for a pixel that never fired or is
 * stale. A synthetic Reddit Ads API answers; nothing leaves the process.
 */
const gateway = 'reddit_native_action',
  actor = {tenantId: 'reddit-pixel', userId: 'u', role: 'operator'},
  admin = {...actor, role: 'admin'},
  registry = new Registry(),
  day = 86400000;
const group = {
  name: 'Group',
  configured_status: 'PAUSED',
  campaign_id: '100',
  conversion_pixel_id: 't2_pixel1',
  bid_strategy: 'MANUAL_BIDDING',
  bid_type: 'CPC',
  bid_value: 1000000,
};
function fixture({pixels, fired, paginate = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 75).toString('base64')),
    c = {
      id: 'r',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['a2_111'],
      writeAccounts: ['a2_111'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['adsread', 'adsedit'],
      userAgent: 'server:amcp-tests:0.1.0 (local mock)',
    };
  store.putConnection(admin, c, {accessToken: 'synthetic'});
  store.rememberResource(c, 'a2_111', 'campaigns/100');
  const state = {
      pixels: pixels ?? [{id: 't2_pixel1', name: 'Store pixel', business_id: 'b1'}],
      fired: fired ?? {page_visit: new Date(Date.now() - day).toISOString(), purchase: null, lead: null},
      groups: new Map(),
      readback: undefined,
    },
    calls = [];
  let writes = 0;
  const reply = (data, extra = {}) => Response.json({data, request_id: String(calls.length), ...extra});
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init?.method ?? 'GET';
      calls.push(method + ' ' + path);
      if (method === 'GET') {
        if (path === '/api/v3/ad_accounts/a2_111') return reply({id: 'a2_111', name: 'Account'});
        if (path === '/api/v3/campaigns/100')
          return reply({id: '100', ad_account_id: 'a2_111', name: 'Campaign', configured_status: 'PAUSED'});
        if (path === '/api/v3/ad_accounts/a2_111/pixels') {
          assert.equal(u.searchParams.get('page.size'), '1000');
          return reply(structuredClone(state.pixels), {
            pagination: {next_url: paginate ? 'https://ads-api.reddit.com' + path + '?page.token=x' : null},
          });
        }
        const pixel = /^\/api\/v3\/pixels\/([^/]+)\/last_fired_at$/.exec(path)?.[1];
        if (pixel) return reply(structuredClone(state.fired));
        const g = /^\/api\/v3\/ad_groups\/([^/]+)$/.exec(path)?.[1];
        if (g && state.groups.has(g)) return reply({...state.groups.get(g), ...state.readback});
      }
      if (method === 'POST' && path === '/api/v3/ad_accounts/a2_111/ad_groups') {
        writes++;
        const d = {...JSON.parse(String(init.body)).data, id: '200', ad_account_id: 'a2_111'};
        state.groups.set('200', d);
        return Response.json({data: d}, {status: 201});
      }
      throw new Error('Unexpected Reddit request ' + method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (data = group) =>
    call('amcp_write', {
      action: 'prepare',
      gateway,
      arguments: {
        operation: 'reddit_campaign_ops',
        arguments: {action: 'CREATE_AD_GROUP', account_id: 'a2_111', payload: {data}},
      },
    });
  const execute = p =>
    call('amcp_write', {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    });
  return {store, state, calls, prepare, execute, call, writes: () => writes, close: () => store.close()};
}

test('a fresh account pixel passes: the list is read before the activity, and the impact names the pixel and its last firing', async t => {
  const f = fixture();
  t.after(f.close);
  const p = await f.prepare();
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  const list = f.calls.indexOf('GET /api/v3/ad_accounts/a2_111/pixels'),
    activity = f.calls.indexOf('GET /api/v3/pixels/t2_pixel1/last_fired_at');
  assert.ok(list >= 0 && activity > list, 'the activity read follows the account list: ' + f.calls.join(', '));
  const impact = p.data.creative_impact;
  assert.equal(impact.conversion_pixel.id, 't2_pixel1');
  assert.equal(impact.conversion_pixel.name, 'Store pixel');
  assert.equal(impact.conversion_pixel.listed_for_account, true);
  assert.equal(impact.conversion_pixel.last_fired_at, f.state.fired.page_visit);
  assert.equal(impact.conversion_pixel.freshness, 'recent');
  assert.equal(impact.warning, undefined);
  // The pixel firing again between review and execute is not a state change; the write is sent once.
  f.state.fired.purchase = new Date().toISOString();
  const e = await f.execute(p);
  assert.equal(e.success, true, JSON.stringify(e).slice(0, 800));
  assert.equal(f.writes(), 1);
  // A pixel that stopped firing long ago by execute is: the review showed a recent pixel.
  const g = fixture();
  t.after(g.close);
  const q = await g.prepare();
  g.state.fired = {page_visit: new Date(Date.now() - 60 * day).toISOString()};
  const refused = await g.execute(q);
  assertRefused(refused, 'STATE_CHANGED', {writes: g.writes()});
  assert.ok(
    refused.error.details.changed_fields.some(p => /freshness/.test(p)),
    JSON.stringify(refused.error),
  );
});

test('a pixel the account does not list is refused before its activity is read and before anything is sent (regression)', async t => {
  for (const pixels of [[], [{id: 't2_other', name: 'Another account’s pixel'}]]) {
    const f = fixture({pixels});
    t.after(f.close);
    const p = await f.prepare();
    assertRefused(p, 'REDDIT_PIXEL_NOT_IN_ACCOUNT', {writes: f.writes()});
    assert.equal(p.error.details.conversion_pixel_id, 't2_pixel1');
    assert.equal(p.error.details.field, 'conversion_pixel_id');
    assert.deepEqual(
      p.error.details.account_pixel_ids,
      pixels.map(x => x.id),
    );
    assert.ok(!f.calls.some(call => call.includes('/last_fired_at')), 'a pixel outside the account is never read');
  }
});

test('a pixel that never fired, or not within the stale window, is reviewable with a warning', async t => {
  for (const [fired, freshness, warning] of [
    [{page_visit: null, purchase: null}, 'never_fired', /no event from this pixel yet/],
    [
      {purchase: new Date(Date.now() - (redditPixelStaleDays + 3) * day).toISOString()},
      'stale',
      /not fired in the last 7 days/,
    ],
    [{custom_events: [{name: 'Signup', last_fired_at: new Date(Date.now() - day).toISOString()}]}, 'recent', undefined],
  ]) {
    const f = fixture({fired});
    t.after(f.close);
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
    assert.equal(p.data.creative_impact.conversion_pixel.freshness, freshness);
    if (warning) assert.match(p.data.creative_impact.warning, warning);
    else assert.equal(p.data.creative_impact.warning, undefined);
  }
});

test('a pixel removed from the account after review is refused at execute; nothing is sent', async t => {
  const f = fixture();
  t.after(f.close);
  const p = await f.prepare();
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  f.state.pixels = [{id: 't2_other', name: 'Other'}];
  assertRefused(await f.execute(p), 'REDDIT_PIXEL_NOT_IN_ACCOUNT', {writes: f.writes()});
  assert.equal(f.writes(), 0);
});

test('a paginated pixel list or a malformed last-fired report is not a complete review state', async t => {
  const paged = fixture({paginate: true});
  t.after(paged.close);
  assertRefused(await paged.prepare(), ['INCOMPLETE_STATE', 'UNSAFE_PAGINATION_LINK'], {writes: paged.writes()});
  const malformed = fixture({fired: {purchase: 'yesterday'}});
  t.after(malformed.close);
  assertRefused(await malformed.prepare(), 'STATE_READ_FAILED', {writes: malformed.writes()});
});

test('read-back compares conversion_pixel_id: an ad group Reddit shows with another pixel is not verified', async t => {
  for (const readback of [undefined, {conversion_pixel_id: 't2_other'}]) {
    const f = fixture();
    t.after(f.close);
    const p = await f.prepare();
    assert.equal((await f.execute(p)).success, true);
    f.state.readback = readback;
    const out = await f.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id});
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    if (!readback) {
      assert.equal(out.data.status, 'verified', JSON.stringify(out.data).slice(0, 800));
      assert.ok(out.data.checks[0].checked_fields.includes('conversion_pixel_id'));
    } else {
      assert.notEqual(out.data.status, 'verified', JSON.stringify(out.data).slice(0, 800));
      assert.ok(
        out.data.checks[0].changed_fields.some(p => /conversion_pixel_id/.test(p)),
        JSON.stringify(out.data.checks),
      );
    }
  }
});

test('a CBO campaign and an ad group update that changes the pixel are checked against the account list too (regression)', async t => {
  // A CBO campaign requires a pixel like an ad group; its impact names the campaign kind.
  const f = fixture();
  t.after(f.close);
  const campaign = await f.call('amcp_write', {
    action: 'prepare',
    gateway,
    arguments: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'CREATE_CAMPAIGN',
        account_id: 'a2_111',
        payload: {
          data: {
            name: 'CBO',
            configured_status: 'PAUSED',
            objective: 'CONVERSIONS',
            is_campaign_budget_optimization: true,
            conversion_pixel_id: 't2_pixel1',
          },
        },
      },
    },
  });
  assert.equal(campaign.success, true, JSON.stringify(campaign).slice(0, 800));
  assert.ok(f.calls.includes('GET /api/v3/ad_accounts/a2_111/pixels'), f.calls.join(', '));
  assert.equal(campaign.data.creative_impact.conversion_pixel.listed_for_account, true);
  assert.match(campaign.data.creative_impact.effect, /^The CBO campaign /);
  // Moving an existing ad group to a pixel of another account is refused before anything is sent.
  const g = fixture({pixels: [{id: 't2_pixel1', name: 'Store pixel'}]});
  t.after(g.close);
  g.store.rememberResource({id: 'r', tenantId: actor.tenantId, gateway}, 'a2_111', 'ad_groups/200');
  g.state.groups.set('200', {...group, id: '200', ad_account_id: 'a2_111'});
  const moved = await g.call('amcp_write', {
    action: 'prepare',
    gateway,
    arguments: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'UPDATE_AD_GROUP',
        account_id: 'a2_111',
        payload: {data: {conversion_pixel_id: 't2_foreign'}},
        params: {ad_group_id: '200'},
      },
    },
  });
  assertRefused(moved, 'REDDIT_PIXEL_NOT_IN_ACCOUNT', {writes: g.writes()});
  assert.deepEqual(moved.error.details.account_pixel_ids, ['t2_pixel1']);
});

test('an ad group update that does not name a pixel reads no pixel', async t => {
  const f = fixture();
  t.after(f.close);
  f.store.rememberResource({id: 'r', tenantId: actor.tenantId, gateway}, 'a2_111', 'ad_groups/200');
  f.state.groups.set('200', {...group, id: '200', ad_account_id: 'a2_111'});
  const p = await f.call('amcp_write', {
    action: 'prepare',
    gateway,
    arguments: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'UPDATE_AD_GROUP',
        account_id: 'a2_111',
        payload: {data: {name: 'Renamed'}},
        params: {ad_group_id: '200'},
      },
    },
  });
  assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
  assert.ok(!f.calls.some(call => call.includes('pixel')), f.calls.join(', '));
  assert.equal(p.data.creative_impact, undefined);
});
