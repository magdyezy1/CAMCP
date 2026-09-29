import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertWriteShape} from '../dist/src/write-shape.js';

/**
 * The owner's conditions of 2026-09-29 for Meta's shop opt-out. Meta's v26.0 changelog (read 2026-09-29): "Starting in
 * API v26.0, eligible ad creatives will automatically default to destination_spec.destination_type = WEBSITE_AND_SHOP
 * when the advertiser has a shop. Advertisers can opt out by explicitly setting destination_type to
 * WEBSITE_AND_SHOP_OPT_OUT." Meta's Business SDK types destination_type as a free string at 25.0.3 and 26.0.2, so the
 * value is known only from v26.0 on.
 */
const actor = {tenantId: 'meta-shop', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  gateway = 'meta_native_action';
const story = {page_id: '500', link_data: {link: 'https://example.test/', message: 'Hello'}};
const optOut = {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT'};
const plan = (path, body, action = 'meta_ad_account_id_adcreatives_create') => ({
  gateway,
  accountId: '123',
  action,
  method: 'POST',
  path,
  query: {},
  headers: {},
  body,
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'synthetic',
  warnings: [],
});
const creative = (extra, version = 'v26.0') =>
  plan('/' + version + '/act_123/adcreatives', {name: 'Creative', object_story_spec: story, ...extra});
const refused = (p, pattern = /./) =>
  assert.throws(
    () => assertWriteShape(p),
    e => e.code === 'WRITE_CONTRACT_UNAVAILABLE' && pattern.test(e.message),
    JSON.stringify(p.body),
  );

test('the creative contract accepts exactly the documented opt-out, and only from Graph API v26.0', () => {
  assertWriteShape(creative({destination_spec: optOut}));
  for (const spec of [
    {destination_type: 'WEBSITE_AND_SHOP'},
    {destination_type: 'website_and_shop_opt_out'},
    {destination_type: 'WEBSITE_AND_SHOP_OPT_OUT', website: {}},
    {},
    'WEBSITE_AND_SHOP_OPT_OUT',
    [optOut],
  ])
    refused(creative({destination_spec: spec}));
  refused(creative({destination_spec: optOut}, 'v25.0'), /v26\.0/);
});

test('a new ad or an ad update names an existing creative; an inline creative would skip the creative checks', () => {
  const ad = creativeSpec =>
    plan(
      '/v26.0/act_123/ads',
      {name: 'Ad', adset_id: '222', status: 'PAUSED', creative: creativeSpec},
      'meta_ad_account_id_ads_create',
    );
  assertWriteShape(ad({creative_id: '900'}));
  refused(ad({object_story_spec: story}), /creative_id/);
  refused(ad({object_story_spec: story, destination_spec: optOut}), /creative_id/);
  refused(ad({creative_id: '900', destination_spec: optOut}), /creative_id/);
  refused(ad(JSON.stringify({object_story_spec: story})), /creative_id/);
  refused(plan('/v26.0/333', {creative: {object_story_spec: story}}, 'meta_ad_id_update'), /creative_id/);
  assertWriteShape(plan('/v26.0/333', {creative: {creative_id: '901'}}, 'meta_ad_id_update'));
});

function fixture(readSpec) {
  const store = new Store(':memory:', Buffer.alloc(32, 72).toString('base64')),
    connection = {
      id: 'shop-login',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management', 'pages_show_list', 'pages_read_engagement'],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic-user-token'});
  const sent = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname;
      if (init?.method !== 'GET') {
        const raw = String(init.body);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = Object.fromEntries(
            [...new URLSearchParams(raw)].map(([k, v]) => {
              try {
                return [k, JSON.parse(v)];
              } catch {
                return [k, v];
              }
            }),
          );
        }
        sent.push(body);
        return Response.json({id: '900'});
      }
      if (path === '/v26.0/act_123') return Response.json({id: 'act_123', currency: 'USD', account_status: 1});
      if (path.endsWith('/promote_pages')) return Response.json({data: [{id: '500'}]});
      if (path === '/v26.0/900') {
        const last = sent.at(-1);
        return Response.json({
          id: '900',
          name: last.name,
          object_story_spec: last.object_story_spec,
          ...(readSpec === undefined ? {} : {destination_spec: readSpec}),
        });
      }
      throw Error('Unexpected synthetic route ' + path);
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const call = (action, extra) => service.call('amcp_write', {action, ...extra}, actor);
  const prepare = payload =>
    call('prepare', {
      gateway,
      connection_id: connection.id,
      arguments: {action: 'meta_creative_create', account_id: '123', payload},
    });
  const execute = r =>
    call('execute', {review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true});
  const verify = r => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {store, sent, prepare, execute, verify};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the review says the opt-out in plain words, and AMCP never adds it on its own', async () => {
  const f = fixture(optOut);
  try {
    const p = ok(await f.prepare({name: 'Creative', object_story_spec: story, destination_spec: optOut}));
    assert.match(p.data.creative_impact.effect, /people go to your website only, not your Meta shop/i);
    const plain = ok(await f.prepare({name: 'Plain', object_story_spec: story}));
    assert.match(plain.data.creative_impact.warning, /WEBSITE_AND_SHOP_OPT_OUT/);
    ok(await f.execute(plain));
    assert.equal(Object.hasOwn(f.sent[0], 'destination_spec'), false);
  } finally {
    f.store.close();
  }
});

test('the opt-out verifies when Meta reads it back, and is inconclusive, not passed or failed, when the read omits it', async () => {
  const f = fixture(optOut);
  try {
    const p = ok(await f.prepare({name: 'Creative', object_story_spec: story, destination_spec: optOut}));
    ok(await f.execute(p));
    assert.deepEqual(f.sent[0].destination_spec, optOut);
    const v = ok(await f.verify(p));
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    f.store.close();
  }
  const g = fixture(undefined);
  try {
    const p = ok(await g.prepare({name: 'Creative', object_story_spec: story, destination_spec: optOut}));
    ok(await g.execute(p));
    const v = ok(await g.verify(p));
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v).slice(0, 900));
    const check = v.data.checks[0];
    assert.deepEqual(check.unacknowledged_fields, ['/destination_spec']);
    assert.equal(check.changed_fields.length, 0);
  } finally {
    g.store.close();
  }
  const h = fixture({destination_type: 'WEBSITE_AND_SHOP'});
  try {
    const p = ok(await h.prepare({name: 'Creative', object_story_spec: story, destination_spec: optOut}));
    ok(await h.execute(p));
    const v = await h.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 900));
  } finally {
    h.store.close();
  }
});
