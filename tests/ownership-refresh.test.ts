import test from 'node:test';
import assert from 'node:assert/strict';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';
import {SNAP, actor, admin, fixture, gateway} from './snapchat-plan-fixture.js';

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
      if (method === 'GET' && /^\/v1\/creatives\/creative-[12]$/.test(path))
        return wrapped('creatives', [
          {id: path.split('/').at(-1), ad_account_id: 'acct1', name: 'Owned', type: 'WEB_VIEW'},
        ]);
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
    assert.equal((await read(f, 'snapchat_creative_list', {result_ids: ['creative-1']})).success, true);
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

/**
 * r25-field-snap, item 2 (the field report of 2026-11-19, #8). A prepare reads the ad squad, its campaign and the ad it
 * changes, and each read needs its own ownership observation, which lasts five minutes. When all of them had lapsed, AMCP
 * renewed the first and retried once, and the retry was refused for the next one (the campaign): every activation prepared
 * after a pause cost two or three more calls. Now it renews every lapsed resource of the call's chain, each from the
 * account's own list narrowed to its ID, and then retries once, to the letter of the owner's decision 7 of 2026-09-29.
 */
const chainRows: Record<string, JsonObject> = {
  campaigns: {
    id: 'camp-1',
    ad_account_id: 'acct1',
    name: 'Campaign',
    status: 'ACTIVE',
    buy_model: 'AUCTION',
    pacing_level: 'AD_SQUAD',
  },
  adsquads: {
    id: 'sq-1',
    campaign_id: 'camp-1',
    name: 'Squad',
    status: 'ACTIVE',
    type: 'SNAP_ADS',
    billing_event: 'IMPRESSION',
    optimization_goal: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITH_MAX_BID',
    bid_micro: 1000000,
    daily_budget_micro: 100000000,
    targeting: {geos: [{country_code: 'sa'}]},
  },
  ads: {
    id: 'ad-1',
    ad_squad_id: 'sq-1',
    creative_id: 'creative-1',
    name: 'Ad',
    status: 'PAUSED',
    type: 'REMOTE_WEBPAGE',
  },
  creatives: {id: 'creative-1', ad_account_id: 'acct1', name: 'Creative', type: 'WEB_VIEW'},
};
/**
 * The synthetic account of the chain tests: one campaign, ad squad, ad and creative. `lapsed` and `fresh` name the
 * observations this login made (resource keys such as adsquads/sq-1); every other resource was never observed. `unlisted`
 * names the ones the account's list no longer returns.
 */
function chain({
  lapsed = [],
  fresh = [],
  unlisted = [],
}: {lapsed?: string[]; fresh?: string[]; unlisted?: string[]} = {}) {
  const f = fixture({
    // Snapchat returns an ad squad's placement_v2 only when the read asks for it (item 1).
    readSquad: (s, url) =>
      url.searchParams.get('return_placement_v2') === 'true' ? {...s, placement_v2: {config: 'AUTOMATIC'}} : s,
    routes: (method, path) => {
      if (method !== 'GET') return undefined;
      const list = /^\/v1\/adaccounts\/acct1\/(campaigns|adsquads|ads|creatives)$/.exec(path);
      if (list)
        return wrapped(
          list[1]!,
          [chainRows[list[1]!]!].filter(r => !unlisted.includes(list[1] + '/' + r.id)),
        );
      const one = /^\/v1\/(ads|creatives)\/([\w-]+)$/.exec(path);
      return one && chainRows[one[1]!]!.id === one[2] ? wrapped(one[1]!, [chainRows[one[1]!]!]) : undefined;
    },
  });
  f.campaigns.set('camp-1', chainRows.campaigns!);
  f.squads.set('sq-1', chainRows.adsquads!);
  const connection = f.store.resolveConnection(actor, gateway, 'acct1', SNAP);
  for (const r of lapsed) f.store.rememberResource(connection, 'acct1', r, -1);
  for (const r of fresh) f.store.rememberResource(connection, 'acct1', r);
  return f;
}
const prepared = (f: ReturnType<typeof fixture>, action: string, extra: JsonObject) =>
  f.call('amcp_write', {
    action: 'prepare',
    gateway,
    connection_id: SNAP,
    arguments: {action, account_id: 'acct1', ...extra},
  });
const adRename = (f: ReturnType<typeof fixture>) =>
  prepared(f, 'snapchat_ad_patch', {
    path_params: {ad_squad_id: 'sq-1', ad_id: 'ad-1'},
    payload: [{op: 'replace', path: '/name', value: 'Renamed'}],
  });
const adCreate = (f: ReturnType<typeof fixture>) =>
  prepared(f, 'snapchat_ad_create', {
    path_params: {ad_squad_id: 'sq-1'},
    payload: {
      ads: [{ad_squad_id: 'sq-1', name: 'Ad', type: 'SNAP_AD', creative_id: 'creative-1', status: 'ACTIVE'}],
    },
  });
const squadRename = (f: ReturnType<typeof fixture>) =>
  prepared(f, 'snapchat_adsquad_patch', {
    path_params: {campaign_id: 'camp-1', ad_squad_id: 'sq-1'},
    payload: [{op: 'replace', path: '/name', value: 'Renamed'}],
  });
const requested = (f: ReturnType<typeof fixture>, request: string) => f.requests.filter(q => q === request).length;
const listing = (kind: string) => 'GET /v1/adaccounts/acct1/' + kind;
const renewal = (action: string, ...ids: string[]) => ({tool: gateway, action, result_ids: ids});
const allKinds = ['adsquads/sq-1', 'campaigns/camp-1', 'ads/ad-1', 'creatives/creative-1'];

test('an ad edit whose ad squad, campaign and ad all lapsed prepares in one call: one narrowed list read each, then one retry', async () => {
  const clean = chain({fresh: allKinds});
  const f = chain({lapsed: allKinds});
  try {
    const baseline = await adRename(clean);
    assert.equal(baseline.success, true, JSON.stringify(baseline).slice(0, 800));
    const r = await adRename(f);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.ok(r.data.review_id);
    // The first renewal keeps today's shape; ownership_refreshed_all lists every renewal, in the order it ran.
    assert.deepEqual(r.meta.ownership_refreshed, renewal('snapchat_adsquad_list', 'sq-1'));
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_adsquad_list', 'sq-1'),
      renewal('snapchat_campaign_list', 'camp-1'),
      renewal('snapchat_ad_list', 'ad-1'),
    ]);
    // Three narrowed list reads, and then exactly one attempt: the requests after them are those of an attempt that
    // needed no renewal at all.
    assert.deepEqual(f.requests.slice(0, 3), [listing('adsquads'), listing('campaigns'), listing('ads')]);
    assert.deepEqual(f.requests.slice(3), clean.requests);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
    clean.close();
  }
});

test('an ad squad edit whose campaign and ad squad lapsed prepares in one call as well', async () => {
  const f = chain({lapsed: ['campaigns/camp-1', 'adsquads/sq-1']});
  try {
    const r = await squadRename(f);
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
    assert.deepEqual(r.meta.ownership_refreshed, renewal('snapchat_campaign_list', 'camp-1'));
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_campaign_list', 'camp-1'),
      renewal('snapchat_adsquad_list', 'sq-1'),
    ]);
    assert.equal(requested(f, listing('campaigns')), 1);
    assert.equal(requested(f, listing('adsquads')), 1);
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test('an ACTIVE ad created under a serving ad squad, with its squad, campaign and creative lapsed, reaches PARENT_SERVING and not RESOURCE_SCOPE_REQUIRED (#8, #12)', async () => {
  const f = chain({lapsed: ['adsquads/sq-1', 'campaigns/camp-1', 'creatives/creative-1']});
  try {
    const r = await adCreate(f);
    // The paused-parent rule is the owner's and stays: a new ad starts paused under a serving ad squad and campaign.
    assertRefused(r, 'PARENT_SERVING', {writes: () => f.writes.length});
    assert.equal(r.error.details.parent_status, 'ACTIVE');
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_adsquad_list', 'sq-1'),
      renewal('snapchat_campaign_list', 'camp-1'),
      renewal('snapchat_creative_list', 'creative-1'),
    ]);
  } finally {
    f.close();
  }
});

test('a resource of the chain that the account no longer lists stays refused, and no request names it', async () => {
  const f = chain({lapsed: allKinds, unlisted: ['campaigns/camp-1']});
  try {
    const r = await adRename(f);
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(r.error.details.path, '/v1/campaigns/camp-1');
    assert.deepEqual(r.error.details.next_call.arguments.result_ids, ['camp-1']);
    // What was renewed is shown; what was not listed is not.
    assert.deepEqual(r.meta.ownership_refreshed, renewal('snapchat_adsquad_list', 'sq-1'));
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_adsquad_list', 'sq-1'),
      renewal('snapchat_ad_list', 'ad-1'),
    ]);
    assert.equal(requested(f, listing('campaigns')), 1, 'one narrowed read for it, not a loop');
    assert.ok(!f.requests.some(q => q.includes('camp-1')), f.requests.join());
  } finally {
    f.close();
  }
});

test('there is never a second retry: a chain that still ends in a refusal returns that refusal after one attempt', async () => {
  const f = chain({lapsed: allKinds, unlisted: ['ads/ad-1']});
  try {
    const r = await adRename(f);
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(r.error.details.path, '/v1/ads/ad-1');
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_adsquad_list', 'sq-1'),
      renewal('snapchat_campaign_list', 'camp-1'),
    ]);
    // Each list was read once, and the review's reads started once: a second retry would read the account again.
    for (const kind of ['adsquads', 'campaigns', 'ads']) assert.equal(requested(f, listing(kind)), 1, kind);
    assert.equal(requested(f, 'GET /v1/adaccounts/acct1'), 1);
    assert.equal(requested(f, 'GET /v1/campaigns/camp-1'), 1);
    assert.ok(!f.requests.some(q => q.includes('ad-1') && !q.endsWith('/ads')), 'no request names the unlisted ad');
  } finally {
    f.close();
  }
});

test('a resource of the chain this login never observed is not looked for, and the call is refused for it as before', async () => {
  // The campaign was never observed through this login (or re-provisioning cleared it): the ad squad and the ad renew,
  // the campaign list is not read, and the retry is refused for the campaign.
  const f = chain({lapsed: ['adsquads/sq-1', 'ads/ad-1']});
  try {
    const r = await adRename(f);
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(r.error.details.path, '/v1/campaigns/camp-1');
    assert.equal(requested(f, listing('campaigns')), 0);
    assert.deepEqual(r.meta.ownership_refreshed_all, [
      renewal('snapchat_adsquad_list', 'sq-1'),
      renewal('snapchat_ad_list', 'ad-1'),
    ]);
  } finally {
    f.close();
  }
  // A connection that was re-provisioned has no observations at all: nothing is renewed and no request is sent.
  const again = chain({lapsed: allKinds});
  try {
    again.store.putConnection(admin, again.store.resolveConnection(actor, gateway, 'acct1', SNAP), {
      accessToken: 'synthetic',
    });
    const r = await adRename(again);
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => again.writes.length});
    assert.equal(r.meta?.ownership_refreshed, undefined);
    assert.deepEqual(again.requests, []);
  } finally {
    again.close();
  }
});

test('another connection’s account is never read, and what only it observed is not renewed', async () => {
  // A second login of the same workspace, on another ad account, observed the campaign and let it lapse. The first login
  // never did, so the campaign is not renewed through it, and the second login's account list is never read.
  const f = chain({lapsed: ['adsquads/sq-1', 'ads/ad-1']});
  try {
    const other = {id: '22222222-2222-4222-8222-222222222222', tenantId: actor.tenantId, gateway, accounts: ['acct2']};
    f.store.putConnection(
      admin,
      {...other, writeAccounts: ['acct2'], enabled: true, label: 'Another login', scopes: ['snapchat-marketing-api']},
      {accessToken: 'synthetic-other'},
    );
    f.store.rememberResource(
      f.store.resolveConnection(actor, gateway, 'acct2', other.id),
      'acct2',
      'campaigns/camp-1',
      -1,
    );
    const r = await adRename(f);
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(r.error.details.path, '/v1/campaigns/camp-1');
    assert.equal(requested(f, listing('campaigns')), 0);
    assert.ok(!f.requests.some(q => q.includes('acct2')), f.requests.join());
  } finally {
    f.close();
  }
});

test('an execute whose ownership lapsed is never renewed or retried by AMCP', async () => {
  const f = chain({fresh: allKinds});
  try {
    const p = await adRename(f);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 800));
    const connection = f.store.resolveConnection(actor, gateway, 'acct1', SNAP);
    for (const r of allKinds) f.store.rememberResource(connection, 'acct1', r, -1);
    const before = f.requests.length;
    const e = await f.call('amcp_write', {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assertRefused(e, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    assert.equal(e.meta?.ownership_refreshed, undefined);
    assert.deepEqual(f.requests.slice(before), [], 'no list read, no retry');
  } finally {
    f.close();
  }
});

test('a list is read once per call: ads that lapsed and are all unlisted cost one read, not one each', async () => {
  const f = chain({lapsed: [...allKinds, 'ads/ad-2', 'ads/ad-3'], unlisted: ['ads/ad-1', 'ads/ad-2', 'ads/ad-3']});
  try {
    const rows = ['ad-1', 'ad-2', 'ad-3'].map(id => ({...chainRows.ads!, id, name: 'Renamed ' + id}));
    const r = await prepared(f, 'snapchat_ad_replace', {path_params: {ad_squad_id: 'sq-1'}, payload: {ads: rows}});
    assertRefused(r, 'RESOURCE_SCOPE_REQUIRED', {writes: () => f.writes.length});
    // The three ads share one read of the ad list, and the whole call reads at most one list of each kind.
    assert.equal(requested(f, listing('ads')), 1);
    const lists = f.requests.filter(q => /^GET \/v1\/adaccounts\/acct1\/[a-z]+$/.test(q));
    assert.ok(lists.length <= 4, lists.join());
    assert.equal(new Set(lists).size, lists.length, 'no list is read twice: ' + lists.join());
  } finally {
    f.close();
  }
});
