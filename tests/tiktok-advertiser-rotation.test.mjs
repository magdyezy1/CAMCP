import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {familyFixture} from './helpers/family-conformance.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  advertiserWorld,
  advertiserAnswer,
  fullAdvertiserRow,
  identityFields,
  answer,
  assertNoAdvertiserDetail,
} from './helpers/tiktok-advertiser-noise.mjs';
import cta from './family-descriptors/tiktok-cta-portfolios.mjs';
import identities from './family-descriptors/tiktok-identities.mjs';
import lookalikes from './family-descriptors/tiktok-lookalikes.mjs';
import ruleAudiences from './family-descriptors/tiktok-rule-audiences.mjs';
import savedAudiences from './family-descriptors/tiktok-saved-audiences.mjs';
import smartPlusAdgroups from './family-descriptors/tiktok-smart-plus-adgroups.mjs';
import smartPlusCampaigns from './family-descriptors/tiktok-smart-plus-campaigns.mjs';

/**
 * T1, Round 2.5 (package r25-m0-t1), through the whole review lifecycle: nine TikTok creates read the advertiser row,
 * hash it at prepare and again at execute, and failed with STATE_CHANGED whenever TikTok's signed licence link rotated
 * or the balance moved (the White Friday report). Each flow is driven through the real MirrorService and
 * NativeTransport against a synthetic TikTok whose advertiser row rotates on every read
 * (tests/helpers/tiktok-advertiser-noise.mjs). The protection is proven as well: a changed currency, status or name
 * still stops the write.
 */
const gateway = 'tiktok_native_action',
  key = Buffer.alloc(32, 58).toString('base64');
const spec = a => JSON.stringify([...a].sort());

/** A TikTok that answers the advertiser read of a descriptor's flow from `world`, and everything else as it does. */
const viaWorld = (d, world) => ({
  ...d,
  provider(request) {
    if (request.method === 'GET' && request.path.endsWith('/v1.3/advertiser/info/'))
      return {json: answer({list: [advertiserAnswer(world, request.url)]})};
    return d.provider(request);
  },
});
const descriptorFlow = (name, d) => ({
  name,
  // The descriptors name their own advertiser.
  account: d.account,
  make(world) {
    const f = familyFixture(viaWorld(d, world));
    return {...f, tenant: 'conformance-' + d.family, world};
  },
});

/** The three standard creates (no reviewed family of their own): a campaign, an ad group and an ad, all paused. */
const standardBodies = id => ({
  campaign: {
    action: 'tiktok_campaign_create',
    payload: {
      advertiser_id: id,
      campaign_name: 'Synthetic campaign',
      objective_type: 'TRAFFIC',
      budget_mode: 'BUDGET_MODE_INFINITE',
      operation_status: 'DISABLE',
    },
  },
  adgroup: {
    action: 'tiktok_adgroup_create',
    payload: {
      advertiser_id: id,
      campaign_id: '300',
      adgroup_name: 'Synthetic ad group',
      promotion_type: 'WEBSITE',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      location_ids: ['6252001'],
      budget_mode: 'BUDGET_MODE_DAY',
      budget: 50,
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: '2027-01-01 00:00:00',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      bid_type: 'BID_TYPE_NO_BID',
      operation_status: 'DISABLE',
    },
  },
  ad: {
    action: 'tiktok_ad_create',
    payload: {
      advertiser_id: id,
      adgroup_id: '200',
      creatives: [
        {
          ad_name: 'Synthetic ad',
          ad_format: 'SINGLE_IMAGE',
          image_ids: ['img-1'],
          ad_text: 'Synthetic',
          call_to_action: 'LEARN_MORE',
          landing_page_url: 'https://example.test/',
          identity_type: 'CUSTOMIZED_USER',
          identity_id: '7777',
          operation_status: 'DISABLE',
        },
      ],
    },
  },
});
function standardFlow(kind) {
  return {
    name: 'a standard ' + kind + ' create',
    make(world) {
      const actor = {tenantId: 'advertiser-rotation-' + kind, userId: 'operator', role: 'operator'},
        owner = {...actor, userId: 'owner', role: 'admin'},
        store = new Store(':memory:', key),
        connection = {
          id: 'login',
          tenantId: actor.tenantId,
          gateway,
          accounts: [world.id],
          writeAccounts: [world.id],
          enabled: true,
          label: 'Synthetic TikTok',
          scopes: [],
        },
        sent = [],
        requests = [],
        page = {page: 1, page_size: 100, total_number: 1, total_page: 1};
      store.putConnection(owner, connection, {accessToken: 'synthetic'});
      // The campaign and ad group an agent's earlier reads showed AMCP in this account.
      for (const id of ['300', '200']) store.rememberResource(connection, world.id, id);
      const transport = new NativeTransport(async (raw, init = {}) => {
        const url = new URL(String(raw)),
          path = url.pathname.replace('/open_api', ''),
          method = init.method ?? 'GET';
        requests.push(method + ' ' + path);
        if (method === 'POST') {
          sent.push({path, body: JSON.parse(init.body)});
          return Response.json(answer({campaign_id: '301', adgroup_id: '201', ad_ids: ['101']}));
        }
        if (path === '/v1.3/advertiser/info/') return Response.json(answer({list: [advertiserAnswer(world, url)]}));
        if (path === '/v1.3/campaign/get/')
          return Response.json(
            answer({
              list: [{campaign_id: '300', advertiser_id: world.id, operation_status: 'DISABLE'}],
              page_info: page,
            }),
          );
        if (path === '/v1.3/adgroup/get/')
          return Response.json(
            answer({
              list: [{adgroup_id: '200', campaign_id: '300', advertiser_id: world.id, operation_status: 'DISABLE'}],
              page_info: page,
            }),
          );
        throw new Error('Unexpected TikTok request ' + method + ' ' + path);
      });
      const service = new MirrorService(new Registry(), store, transport, undefined, {
        allowWrites: true,
        requireBeforeState: true,
        maxBudgetChange: 0,
      });
      const call = (tool, input) => service.call(tool, input, actor),
        body = standardBodies(world.id)[kind];
      return {
        store,
        tenant: actor.tenantId,
        world,
        sent,
        requests,
        prepare: () =>
          call('amcp_write', {
            action: 'prepare',
            gateway,
            connection_id: connection.id,
            arguments: {action: body.action, account_id: world.id, payload: body.payload},
          }),
        execute: review =>
          call('amcp_write', {
            action: 'execute',
            review_id: review.review_id,
            idempotency_key: review.idempotency_key ?? review.review_id,
            confirmed: true,
            spend_change_confirmed: true,
          }),
        close: () => store.close(),
      };
    },
  };
}

// The nine write flows that read the advertiser row. (The tenth consumer, the amcp_media upload, is in
// tests/tiktok-advertiser-media.test.mjs.)
const flows = [
  standardFlow('campaign'),
  standardFlow('adgroup'),
  standardFlow('ad'),
  descriptorFlow('a custom identity create', identities),
  descriptorFlow('a CTA portfolio create', cta),
  descriptorFlow('a lookalike audience create', lookalikes),
  descriptorFlow('a saved audience create', savedAudiences),
  descriptorFlow('a Smart+ campaign create', smartPlusCampaigns),
  descriptorFlow('a Smart+ ad group create', smartPlusAdgroups),
];
/** Runs `body` with a fresh flow over an advertiser world, closing it afterwards. */
async function withFlow(flow, changes, body) {
  const world = advertiserWorld({...(flow.account ? {id: flow.account} : {}), ...changes}),
    f = flow.make(world);
  try {
    return await body(f, world);
  } finally {
    f.close();
  }
}
const prepared = async (f, what) => {
  const p = await f.prepare();
  assert.equal(p.success, true, what + ' prepares: ' + JSON.stringify(p.error ?? p).slice(0, 700));
  assert.equal(f.sent.length, 0, 'prepare sends nothing');
  return p.data;
};
const executed = async (f, review, what) => {
  const done = await f.execute(review);
  assert.equal(done.success, true, what + ' executes: ' + JSON.stringify(done.error ?? done).slice(0, 700));
  assert.equal(f.sent.length, 1, what + ' sends exactly one write');
  return done;
};

for (const flow of flows) {
  test(flow.name + ' prepares and executes with a quiet advertiser (control)', async () => {
    await withFlow(flow, {rotating: false, honourFields: false}, async (f, world) => {
      const review = await prepared(f, flow.name);
      await executed(f, review, flow.name);
      assert.ok(world.reads >= 2, 'the advertiser is read at prepare and again at execute');
    });
  });

  for (const honourFields of [true, false])
    test(
      flow.name +
        ' executes while the licence ticket rotates and the balance falls (TikTok ' +
        (honourFields ? 'narrows its answer to fields' : 'ignores fields') +
        ')',
      async () => {
        await withFlow(flow, {honourFields}, async (f, world) => {
          const review = await prepared(f, flow.name);
          // The review is prepared and approved on one read of the row and sent on another.
          assert.ok(world.reads >= 1);
          await executed(f, review, flow.name);
          assert.ok(world.reads >= 2, 'the advertiser is read again at execute');
          // What a review shows the model of the advertiser never holds the licence link, balance or contact record.
          assertNoAdvertiserDetail(review, flow.name + ' before_state');
        });
      },
    );

  test(flow.name + ' asks TikTok for the identity fields of the advertiser only', async () => {
    await withFlow(flow, {}, async (f, world) => {
      await prepared(f, flow.name);
      assert.ok(world.seen.length >= 1, 'the advertiser is read');
      for (const url of world.seen) {
        assert.equal(url.searchParams.get('advertiser_ids'), JSON.stringify([world.id]));
        assert.equal(
          spec(JSON.parse(url.searchParams.get('fields') ?? 'null') ?? []),
          spec(identityFields),
          url.search,
        );
      }
    });
  });

  // The protection: what decides the write is still compared. With a quiet advertiser this holds before and after the
  // change (the control); while the ticket rotates, the refusal names the changed field alone, not the noise with it.
  for (const rotating of [false, true])
    for (const [field, changed] of [
      ['currency', 'EUR'],
      ['status', 'STATUS_LIMIT'],
      ['name', 'Renamed Advertiser'],
    ])
      test(
        flow.name +
          ' stops when the advertiser ' +
          field +
          ' changes between prepare and execute' +
          (rotating ? ' while the licence ticket rotates' : ' (control)'),
        async () => {
          await withFlow(flow, {rotating}, async (f, world) => {
            const review = await prepared(f, flow.name);
            world[field] = changed;
            const refused = await f.execute(review);
            assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
            assert.deepEqual(refused.error.details.changed_fields, ['$[0]["data"]["list"][0]["' + field + '"]']);
          });
        },
      );

  /**
   * A review prepared before this change saved the whole row and the read that fetched it (no `fields`). It must still
   * execute while the ticket rotates, and a real change must still stop it.
   */
  const asSavedBefore = (f, world, review, whole) => {
    const saved = f.store.document(f.tenant, 'write_review', review.review_id),
      i = saved.reads.findIndex(r => r.path.endsWith('/v1.3/advertiser/info/'));
    assert.ok(i >= 0, 'the review reads the advertiser');
    if (whole) saved.reads[i] = {...saved.reads[i], query: {advertiser_ids: [world.id]}};
    saved.state[i] = {data: {list: [fullAdvertiserRow(world, world.reads)]}};
    f.store.putDocument(f.tenant, 'write_review', review.review_id, saved);
  };
  for (const whole of [true, false])
    test(
      flow.name +
        ' prepared before this change, with its whole row' +
        (whole ? ' and its whole read' : '') +
        ', still executes',
      async () => {
        await withFlow(flow, {}, async (f, world) => {
          const review = await prepared(f, flow.name);
          asSavedBefore(f, world, review, whole);
          await executed(f, review, flow.name);
        });
      },
    );
  test(flow.name + ' prepared before this change still stops when the advertiser currency changes', async () => {
    await withFlow(flow, {}, async (f, world) => {
      const review = await prepared(f, flow.name);
      asSavedBefore(f, world, review, true);
      world.currency = 'EUR';
      const refused = await f.execute(review);
      assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
      assert.deepEqual(refused.error.details.changed_fields, ['$[0]["data"]["list"][0]["currency"]']);
    });
  });
}

/**
 * A rule audience over all ad groups reads the advertiser too, though its reader keeps no more than that the advertiser
 * exists (its state is a constant). It is no hashing flow of the list above, but it asks for the identity fields only.
 */
test('a rule audience create without event sources asks TikTok for the identity fields of the advertiser only', async () => {
  const rule = {
    retention_days: 30,
    filter_set: {operator: 'OR', filters: [{field: 'EVENT', operator: 'EQ', value: 'CLICK'}]},
  };
  const allAdGroups = {
    ...ruleAudiences,
    request: {
      ...ruleAudiences.request,
      payload: {
        custom_audience_name: 'Clicked any ad',
        audience_type: 'ENGAGEMENT',
        rule_spec: {inclusion_rule_set: {operator: 'OR', rules: [rule]}},
      },
    },
  };
  await withFlow(descriptorFlow('a rule audience create', allAdGroups), {}, async (f, world) => {
    await executed(f, await prepared(f, 'a rule audience create'), 'a rule audience create');
    assert.ok(world.seen.length >= 2, 'the advertiser is read at prepare and again at execute');
    for (const url of world.seen) {
      assert.equal(url.searchParams.get('advertiser_ids'), JSON.stringify(['123']));
      assert.equal(spec(JSON.parse(url.searchParams.get('fields') ?? 'null') ?? []), spec(identityFields), url.search);
    }
  });
});

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
function generator(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: a standard campaign create passes under any rotation of the noise and stops on a real change (60 cases)', async () => {
  const next = generator(20261115),
    campaign = flows[0],
    changes = {
      role: 'ROLE_CHILD_ADVERTISER',
      timezone: 'Asia/Dubai',
      country: 'AE',
      currency: 'EUR',
      status: 'STATUS_LIMIT',
      name: 'Renamed Advertiser',
    };
  const noiseKinds = [
    k => ({license_url: 'https://ads.tiktok.com/pssresource/internal/download?ticket=' + Math.floor(next() * 1e9)}),
    () => ({license_url: undefined}),
    () => ({balance: next() * 1000}),
    () => ({balance: String(Math.floor(next() * 1000))}),
    () => ({create_time: Math.floor(next() * 1e9)}),
    () => ({email: 'c' + Math.floor(next() * 1e6) + '@example.test', phone_number: '+1' + Math.floor(next() * 1e9)}),
    () => ({['future_' + Math.floor(next() * 4)]: next(), registered_company_type: 'T' + Math.floor(next() * 9)}),
  ];
  for (let i = 0; i < 60; i++) {
    const kinds = noiseKinds.filter(() => next() < 0.5),
      real = next() < 0.4 ? undefined : Object.keys(changes)[Math.floor(next() * Object.keys(changes).length)],
      shape = JSON.stringify({case: i, real, kinds: kinds.length});
    await withFlow(
      campaign,
      {
        honourFields: next() < 0.5,
        rotating: next() < 0.8,
        extra: k => Object.assign({}, ...kinds.map(noise => noise(k))),
      },
      async (f, world) => {
        const review = await prepared(f, shape);
        if (real) {
          world[real] = changes[real];
          const refused = await f.execute(review);
          assertRefused(refused, 'STATE_CHANGED', {writes: () => f.sent.length});
          assert.deepEqual(refused.error.details.changed_fields, ['$[0]["data"]["list"][0]["' + real + '"]'], shape);
        } else await executed(f, review, shape);
      },
    );
  }
});
