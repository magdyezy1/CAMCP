import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';

/**
 * Meta account brand safety (Marketing API references for account controls, audience controls and publisher block lists,
 * checked 2026-09-26): Advantage+ account controls and empty publisher block list creation.
 */
const gateway = 'meta_native_action',
  registry = new Registry();
const actor = {tenantId: 'meta-brand-safety', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64')),
    c = {
      id: 'm',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    };
  store.putConnection(owner, c, {accessToken: 'synthetic'});
  let controls = {
      audience_controls: {age_min: 18, geo_locations: {countries: ['US']}},
      placement_controls: {placement_exclusions: ['facebook_rhc']},
    },
    lists = [{id: '601', name: 'Existing list'}],
    writes = 0,
    reads = 0,
    mode = '';
  const calls = [];
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init.method;
      calls.push({path: u.pathname, method});
      if (method === 'GET') {
        reads++;
        if (u.pathname === '/v26.0/act_123/account_controls') {
          // Meta reorders lists and moves the status while it applies controls.
          const shown = controls
            ? {
                ...structuredClone(controls),
                status: reads % 2 ? 'APPLICATION_IN_PROGRESS' : 'ACTIVE',
                campaigns_with_error: [],
              }
            : undefined;
          if (shown?.audience_controls?.geo_locations?.countries)
            shown.audience_controls.geo_locations.countries.reverse();
          return Response.json({
            data: shown ? [shown] : [],
            paging: {cursors: {before: 'b' + reads, after: 'a' + reads}},
          });
        }
        if (u.pathname === '/v26.0/act_123/publisher_block_lists')
          return Response.json({
            data: structuredClone(lists),
            ...(mode === 'many_lists'
              ? {paging: {next: 'https://graph.facebook.com/v26.0/act_123/publisher_block_lists?after=x'}}
              : {}),
          });
        throw new Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
      if (u.pathname === '/v26.0/act_123/account_controls') {
        if (mode === 'refused')
          return Response.json({
            id: '555',
            success: false,
            error_code: '2641',
            error_message: 'Your ad includes or excludes locations that are currently restricted',
          });
        controls = {
          audience_controls: JSON.parse(body.audience_controls),
          ...(body.placement_controls ? {placement_controls: JSON.parse(body.placement_controls)} : {}),
        };
        return Response.json({id: '555', success: true});
      }
      if (u.pathname === '/v26.0/act_123/publisher_block_lists') {
        const id = String(602 + lists.length);
        lists.push({id, name: body.name});
        return Response.json({id});
      }
      throw new Error('Unexpected write ' + u.pathname);
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
  const prepare = (action, payload) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: '123', payload}}, actor);
  const setControls = payload => prepare('meta_ad_account_id_account_controls_create', payload),
    createList = payload => prepare('meta_ad_account_id_publisher_block_lists_create', payload);
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
  return {
    store,
    calls,
    setControls,
    createList,
    execute,
    verify,
    controls: () => controls,
    set: v => {
      controls = v;
    },
    writes: () => writes,
    mode: m => {
      mode = m;
    },
  };
}
const strict = () => ({
  audience_controls: {
    age_min: 21,
    geo_locations: {countries: ['US', 'CA']},
    excluded_geo_locations: {zips: [{key: 'US:94304'}]},
    exclusions: {interests: [{id: '6003139266461', name: 'Gambling'}]},
  },
  placement_controls: {placement_exclusions: ['audience_network_rewarded_video', 'facebook_marketplace']},
});

test('account controls need spending confirmation and verify exactly, whatever order and status Meta returns', async () => {
  const f = fixture();
  try {
    const p = await f.setControls(strict());
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'account_controls');
    assert.equal(impact.may_affect_serving, true);
    assert.deepEqual(impact.after.audience_controls.geo_locations.countries, ['CA', 'US']);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    const e = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(e.success, true, JSON.stringify(e).slice(0, 700));
    assert.equal(f.writes(), 1);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 700));
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('controls left out are removed, and the review shows what is removed before verifying the smaller set', async () => {
  const f = fixture();
  try {
    const p = await f.setControls({audience_controls: {age_min: 25}});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.deepEqual(p.data.creative_impact.before.placement_controls.placement_exclusions, ['facebook_rhc']);
    assert.deepEqual(p.data.creative_impact.after.placement_controls.placement_exclusions, []);
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.deepEqual(f.controls(), {audience_controls: {age_min: 25}});
  } finally {
    f.store.close();
  }
});

test('invalid controls fail locally, and controls that already match are refused after reading', async () => {
  for (const [label, payload] of [
    ['age above 25', {audience_controls: {age_min: 26}}],
    [
      'unknown placement',
      {audience_controls: {age_min: 18}, placement_controls: {placement_exclusions: ['instagram_reels']}},
    ],
    ['unknown audience control', {audience_controls: {age_max: 40}}],
    ['lower-case country', {audience_controls: {geo_locations: {countries: ['us']}}}],
    ['city included', {audience_controls: {geo_locations: {cities: [{key: '2421836'}]}}}],
    ['repeated region', {audience_controls: {excluded_geo_locations: {regions: [{key: '3847'}, {key: '3847'}]}}}],
    ['malformed market', {audience_controls: {excluded_geo_locations: {geo_markets: [{key: '807'}]}}}],
    ['unknown exclusion', {audience_controls: {exclusions: {behaviors: [{id: '6002714895372'}]}}}],
    ['no audience controls', {placement_controls: {placement_exclusions: ['facebook_rhc']}}],
  ]) {
    const f = fixture();
    try {
      const r = await f.setControls(payload);
      assert.equal(r.error?.code, 'INVALID_META_BRAND_SAFETY', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const same = await f.setControls({
      audience_controls: {age_min: 18, geo_locations: {countries: ['US']}},
      placement_controls: {placement_exclusions: ['facebook_rhc']},
    });
    assert.equal(same.error?.code, 'INVALID_META_BRAND_SAFETY');
    assert.match(same.error.message, /already match/);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('an empty publisher block list is created without confirmation and verified; duplicate and malformed names are refused', async () => {
  const f = fixture();
  try {
    const p = await f.createList({name: 'Q4 brand safety'});
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).data.status, 'verified');
    const dup = await f.createList({name: 'existing LIST'});
    assert.equal(dup.error?.code, 'CONFIGURATION_EXISTS');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  for (const payload of [{name: ' '}, {name: 'x'.repeat(256)}, {name: 'Ok', publisher_urls: ['example.com']}, {}]) {
    const g = fixture();
    try {
      const r = await g.createList(payload);
      assert.equal(r.error?.code, 'INVALID_META_BRAND_SAFETY', JSON.stringify(r).slice(0, 300));
      assert.equal(g.calls.length, 0);
    } finally {
      g.store.close();
    }
  }
});

test('owner policies: account controls count as serving; a new block list passes', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, allow_activation: false},
    });
    assert.equal((await f.setControls(strict())).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal((await f.createList({name: 'Allowed'})).success, true);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a refused controls receipt stays a failure, a long list of block lists is incomplete, and later changes stop execution', async () => {
  {
    const f = fixture();
    try {
      const p = await f.setControls(strict());
      f.mode('refused');
      assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, false);
      assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
      assert.equal(f.writes(), 1);
      assert.equal((await f.verify(p)).error?.code, 'WRITE_PARTIAL_OR_FAILED');
    } finally {
      f.store.close();
    }
  }
  {
    const f = fixture();
    try {
      f.mode('many_lists');
      const r = await f.createList({name: 'New'});
      assert.equal(r.error?.code, 'INCOMPLETE_STATE', JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = await f.setControls(strict());
    assert.equal(p.success, true);
    f.set({audience_controls: {age_min: 20}, placement_controls: {placement_exclusions: []}});
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).error?.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
