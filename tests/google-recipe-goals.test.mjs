import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleConversionBrief, googleRecipeGoalsData} from './fixtures/google-recipe-goals-data.mjs';

function fixture(t, options = {}) {
  const data = googleRecipeGoalsData(options),
    store = new Store(':memory:', Buffer.alloc(32, 112).toString('base64')),
    identity = {tenantId: 'recipe-goals', userId: 'operator', role: options.role ?? 'operator'},
    key = store.createKey(identity),
    actor = store.authenticate(key),
    admin = {...actor, role: 'admin'},
    connection = {
      id: googleConversionBrief.connection_id,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic conversion account',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  t.after(() => store.close());
  let attempts = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      attempts++;
      if (options.beforeResponse) await options.beforeResponse({store, actor, admin, connection, key, attempts});
      if (options.transportResponse) {
        const response = options.transportResponse({url, init, attempts});
        if (response) return response;
      }
      if (options.retry && attempts === 2) return Response.json({error: 'Synthetic transient'}, {status: 503});
      return Response.json(data.response(url, init));
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: options.allowWrites !== false,
    requireBeforeState: true,
  });
  if (options.uncoordinated) transport.coordination = undefined;
  return {
    store,
    key,
    actor,
    admin,
    connection,
    service,
    data,
    attempts: () => attempts,
    call: (input = {}, as = actor) =>
      service.call(
        'amcp_campaign',
        {
          action: 'recipe_eligibility',
          recipe: 'google_search_target_cpa',
          business: googleConversionBrief,
          live: true,
          ...input,
        },
        as,
      ),
  };
}
const dependency = (out, id) => out.data.dependencies.find(row => row.id === id);
const proof = out => out.data.conversion_goal_inspection;

test('local conversion prerequisite inspection stays local and declares a separate primary-action gap', async t => {
  const f = fixture(t),
    out = await f.call({live: false});
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(dependency(out, 'primary_conversion_actions')?.status, 'unknown');
  assert.equal(proof(out), undefined);
  assert.equal(f.attempts(), 0);
});

test('both conversion recipes inspect complete paginated account goals and exact enabled primary matches without events or writes', async t => {
  for (const recipe of ['google_search_conversions', 'google_search_target_cpa']) {
    const f = fixture(t, {pageSize: 1}),
      business = {...googleConversionBrief};
    if (recipe === 'google_search_conversions') delete business.target_cpa;
    const out = await f.call({recipe, business});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(dependency(out, 'account_default_conversion_goals').status, 'ready');
    assert.equal(dependency(out, 'primary_conversion_actions').status, 'ready');
    assert.equal(dependency(out, 'conversion_event_delivery').status, 'unknown');
    assert.equal(dependency(out, 'provider_objective_acceptance').status, 'unknown');
    assert.equal(out.data.status, 'unknown', 'configuration cannot grant objective or event acceptance');
    const p = proof(out);
    assert.equal(p.complete, true);
    assert.equal(p.summary.goals, 2);
    assert.equal(p.summary.biddable_goals, 1);
    assert.equal(p.summary.actions, 4);
    assert.equal(p.summary.matching_primary_actions, 1);
    assert.equal(p.primary_actions[0].resource_name, 'customers/123/conversionActions/1');
    assert.equal(p.network_requests, 14);
    assert.equal(f.attempts(), 15, 'one currency read plus complete consistency reads');
    assert.equal(p.provider_mutations, 0);
    assert.match(p.state_hash, /^[a-f0-9]{64}$/);
    assert.equal(p.source_references.length, 6);
    assert.ok(
      p.source_references.every(
        s =>
          /^[a-f0-9]{64}$/.test(s.collection_hash) && s.pages.every(page => /^[a-f0-9]{64}$/.test(page.response_hash)),
      ),
    );
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  }
});

test('complete absence of biddable defaults is a concrete configuration blocker, including an omitted implicit false', async t => {
  const d = googleRecipeGoalsData(),
    row = d.goal('PURCHASE', false);
  delete row.biddable;
  const f = fixture(t, {goals: [row]}),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, true);
  assert.equal(dependency(out, 'account_default_conversion_goals').status, 'blocked');
  assert.equal(out.data.status, 'blocked');
  assert.ok(out.data.blockers.some(b => b.code === 'GOOGLE_BIDDABLE_GOALS_UNAVAILABLE'));
  const saved = await f.call({action: 'create_from_recipe'});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.data.state, 'draft', 'inspection does not forbid a paused local draft');
});

test('hidden, secondary and mismatched-category actions cannot prove a matching enabled primary action', async t => {
  const d = googleRecipeGoalsData(),
    f = fixture(t, {
      actions: [
        d.action('1', 'PURCHASE', false),
        d.action('2', 'PURCHASE', true, 'HIDDEN'),
        d.action('3', 'SUBMIT_LEAD_FORM', true),
      ],
    }),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(dependency(out, 'account_default_conversion_goals').status, 'ready');
  assert.equal(dependency(out, 'primary_conversion_actions').status, 'blocked');
  assert.ok(out.data.blockers.some(b => b.code === 'GOOGLE_PRIMARY_ACTIONS_UNAVAILABLE'));
});

test('an omitted optional primary flag stays unknown instead of borrowing the create-time default', async t => {
  const d = googleRecipeGoalsData(),
    row = d.action('1', 'PURCHASE', true);
  delete row.primaryForGoal;
  const f = fixture(t, {actions: [row]}),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(dependency(out, 'account_default_conversion_goals').status, 'ready');
  assert.equal(dependency(out, 'primary_conversion_actions').status, 'unknown');
  assert.equal(proof(out).summary.unknown_primary_flags, 1);
  assert.equal(out.data.status, 'unknown');
});

test('manager or shared/missing conversion customers remain unknown without reading another customer', async t => {
  for (const customer of [
    {manager: true},
    {conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/999'}},
    {conversionTrackingSetting: {}},
  ]) {
    const f = fixture(t, {customer}),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(proof(out)?.complete, false);
    assert.equal(dependency(out, 'account_default_conversion_goals').status, 'unknown');
    assert.equal(f.attempts(), 2);
    assert.ok(f.data.requests.every(r => r.resource === 'customer' && r.path.includes('/customers/123/')));
  }
});

test('changing native goals or primary flags across consistency reads yields no partial eligibility proof', async t => {
  for (const resource of ['customer_conversion_goal', 'conversion_action', 'customer']) {
    const f = fixture(t, {
        transform: args => {
          if (args.resource === resource && args.pass === 2 && args.page === 0) {
            const row = Object.values(args.envelope.results[0])[0];
            if (resource === 'customer_conversion_goal') row.biddable = false;
            else if (resource === 'conversion_action') row.primaryForGoal = false;
            else row.conversionTrackingSetting.googleAdsConversionCustomer = 'customers/999';
          }
        },
      }),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(dependency(out, 'account_default_conversion_goals').status, 'unknown');
    assert.equal(proof(out)?.complete, false);
    assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_CHANGED');
    assert.equal(proof(out)?.primary_actions, undefined);
  }
});

test('reader and read-only deployments can inspect goal configuration while write blockers stay in force', async t => {
  for (const options of [{role: 'reader'}, {allowWrites: false}]) {
    const f = fixture(t, options),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.status, 'blocked');
    assert.equal(dependency(out, 'account_default_conversion_goals').status, 'ready');
    assert.equal(dependency(out, 'primary_conversion_actions').status, 'ready');
    assert.equal(dependency(out, 'account_currency').status, 'ready');
    assert.equal(dependency(out, 'conversion_event_delivery').status, 'unknown');
    assert.ok(out.data.blockers.some(b => b.source === 'current_workspace_prerequisite'));
    assert.equal(f.attempts(), 8);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  }
});

test('native collection order can change without changing exact configuration or its primary matches', async t => {
  const f = fixture(t, {
      pageSize: 100,
      transform: ({resource, pass, envelope}) => {
        if (resource !== 'customer' && pass === 2) envelope.results.reverse();
      },
    }),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, true);
  assert.equal(dependency(out, 'primary_conversion_actions').status, 'ready');
});

test('unrecognized, duplicate, out-of-scope or malformed conversion state never yields partial ready rows', async t => {
  const d = googleRecipeGoalsData();
  for (const options of [
    {goals: [d.goal('PURCHASE', true), d.goal('PURCHASE', true)]},
    {goals: [{...d.goal('PURCHASE', true), resourceName: 'customers/999/customerConversionGoals/PURCHASE~WEBSITE'}]},
    {goals: [{...d.goal('PURCHASE', true), origin: 'UNKNOWN'}]},
    {goals: [{...d.goal('PURCHASE', true), biddable: null}]},
    {goals: [{...d.goal('PURCHASE', true), biddable: 'true'}]},
    {actions: [d.action('1', 'PURCHASE', true), d.action('1', 'PURCHASE', true)]},
    {actions: [{...d.action('1', 'PURCHASE', true), ownerCustomer: 'customers/999'}]},
    {actions: [{...d.action('1', 'PURCHASE', true), primaryForGoal: 'true'}]},
    {actions: [{...d.action('1', 'PURCHASE', true), status: 'UNKNOWN'}]},
    {
      transform: ({resource, envelope}) =>
        resource === 'customer_conversion_goal'
          ? {...envelope, partialFailureError: {message: 'synthetic-private-diagnostic'}}
          : envelope,
    },
    {
      transform: ({resource, envelope}) =>
        resource === 'conversion_action' ? {...envelope, results: [{conversionAction: []}]} : envelope,
    },
  ]) {
    const f = fixture(t, options),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(proof(out)?.complete, false);
    assert.equal(dependency(out, 'account_default_conversion_goals').status, 'unknown');
    assert.equal(dependency(out, 'primary_conversion_actions').status, 'unknown');
    assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_INVALID');
    assert.equal(proof(out)?.goals, undefined);
    assert.equal(proof(out)?.source_references, undefined);
    assert.doesNotMatch(JSON.stringify(proof(out)), /synthetic-private-diagnostic/);
  }
});

test('repeated, malformed, empty or count-incomplete pages cannot establish conversion readiness', async t => {
  for (const transform of [
    args => {
      if (args.resource === 'conversion_action') args.envelope.nextPageToken = 'repeated';
    },
    args => {
      if (args.resource === 'conversion_action') args.envelope.nextPageToken = {opaque: 'bad'};
    },
    args => {
      if (args.resource === 'conversion_action') args.envelope = {...args.envelope, results: [], nextPageToken: 'next'};
      return args.envelope;
    },
    args => {
      if (args.resource === 'conversion_action') args.envelope.totalResultsCount = '100';
    },
    args => {
      if (args.resource === 'conversion_action' && args.page === 1) args.envelope.totalResultsCount = '5';
    },
  ]) {
    const f = fixture(t, {transform}),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(proof(out)?.complete, false);
    assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_INVALID');
    assert.equal(dependency(out, 'primary_conversion_actions').status, 'unknown');
  }
});

test('compact displayed action rows preserve complete collection counts and state evidence', async t => {
  const d = googleRecipeGoalsData(),
    actions = Array.from({length: 25}, (_, i) => d.action(String(i + 1), 'PURCHASE', true)),
    f = fixture(t, {actions, pageSize: 100}),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, true);
  assert.equal(proof(out)?.summary.matching_primary_actions, 25);
  assert.equal(proof(out)?.primary_actions.length, 20);
  assert.equal(proof(out)?.display_omissions.primary_actions, 5);
  assert.equal(dependency(out, 'primary_conversion_actions').status, 'ready');
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('ten-page configuration ceiling refuses before requesting an eleventh page and discards partial proof', async t => {
  const d = googleRecipeGoalsData(),
    f = fixture(t, {
      actions: Array.from({length: 11}, (_, i) => d.action(String(i + 1), 'PURCHASE', true)),
      pageSize: 1,
      allowWrites: false,
    }),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, false);
  assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_INVALID');
  assert.equal(proof(out)?.network_requests, 13);
  assert.equal(f.attempts(), 13);
  assert.equal(f.data.requests.filter(r => r.resource === 'conversion_action').length, 10);
  assert.equal(proof(out)?.source_references, undefined);
  assert.equal(proof(out)?.primary_actions, undefined);
  assert.equal(dependency(out, 'primary_conversion_actions').status, 'unknown');
});

test('read-only goal inspection refuses a login without the existing adwords scope before native egress', async t => {
  const f = fixture(t, {role: 'reader', allowWrites: false});
  f.store.putConnection(
    f.admin,
    {...f.connection, scopes: []},
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const out = await f.call();
  assert.equal(out.success, false, JSON.stringify(out));
  assert.equal(out.error.code, 'INSUFFICIENT_SCOPE');
  assert.equal(f.attempts(), 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('collection row and byte limits leave no partial configuration proof', async t => {
  const d = googleRecipeGoalsData();
  for (const options of [
    {actions: Array.from({length: 1001}, (_, i) => d.action(String(i + 1), 'PURCHASE', true)), pageSize: 2000},
    {
      transform: ({resource, envelope}) =>
        resource === 'customer_conversion_goal' ? {...envelope, padding: 'x'.repeat(2 * 1024 * 1024)} : envelope,
    },
  ]) {
    const f = fixture(t, options),
      out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(proof(out)?.complete, false);
    assert.equal(dependency(out, 'primary_conversion_actions').status, 'unknown');
    if (options.transform) {
      assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_LIMIT');
      assert.equal(proof(out)?.error?.dimension, 'bytes');
    } else assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_INVALID');
  }
});

test('transient retry is charged to the whole inspection allowance', async t => {
  const f = fixture(t, {retry: true}),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, true);
  assert.equal(proof(out)?.network_requests, 9);
  assert.equal(proof(out)?.collection_usage.requests, 9);
  assert.equal(f.attempts(), 10);
});

test('all retries stop at the exact 64-request allowance without an extra provider request', async t => {
  const d = googleRecipeGoalsData(),
    goals = [
      'PURCHASE',
      'SIGNUP',
      'DOWNLOAD',
      'ADD_TO_CART',
      'BEGIN_CHECKOUT',
      'SUBSCRIBE_PAID',
      'PHONE_CALL_LEAD',
      'IMPORTED_LEAD',
      'SUBMIT_LEAD_FORM',
      'CONTACT',
    ].map(c => d.goal(c, true)),
    counts = new Map(),
    f = fixture(t, {
      goals,
      pageSize: 1,
      allowWrites: false,
      uncoordinated: true,
      transportResponse: ({init}) => {
        const count = (counts.get(init.body) ?? 0) + 1;
        counts.set(init.body, count);
        if (count % 3 !== 0) return Response.json({error: 'Synthetic retry pressure'}, {status: 503});
      },
    }),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, false);
  assert.equal(proof(out)?.error?.code, 'GOOGLE_GOAL_INSPECTION_LIMIT');
  assert.equal(proof(out)?.error?.dimension, 'requests');
  assert.equal(proof(out)?.network_requests, 64);
  assert.equal(f.attempts(), 64);
  assert.equal(proof(out)?.goals, undefined);
});

test('actor, login, account, scope and approved-profile changes refuse the response and stop the next read', async t => {
  for (const change of [
    ctx => ctx.store.revokeKey(ctx.key),
    ctx =>
      ctx.store.putConnection(
        ctx.admin,
        {...ctx.connection, accounts: ['999'], writeAccounts: []},
        {accessToken: 'synthetic', developerToken: 'synthetic'},
      ),
    ctx =>
      ctx.store.putConnection(ctx.admin, ctx.connection, {
        accessToken: 'synthetic-changed',
        developerToken: 'synthetic',
      }),
    ctx =>
      ctx.store.putConnection(
        ctx.admin,
        {...ctx.connection, scopes: []},
        {accessToken: 'synthetic', developerToken: 'synthetic'},
      ),
    ctx =>
      ctx.store.putDocument(ctx.actor.tenantId, 'client_profile', 'profile', {
        name: 'Changed',
        approved_by: 'admin',
        defaults: {},
      }),
  ]) {
    const f = fixture(t, {
      beforeResponse: ctx => {
        if (ctx.attempts === 2) change(ctx);
      },
    });
    f.store.putDocument(f.actor.tenantId, 'client_profile', 'profile', {
      name: 'Original',
      approved_by: 'admin',
      defaults: {},
    });
    const out = await f.call({profile_id: 'profile'});
    assert.equal(out.success, false, JSON.stringify(out));
    assert.equal(out.data?.conversion_goal_inspection, undefined);
    assert.equal(f.attempts(), 2);
  }
});

test('a failed provider diagnostic remains unknown without returning its raw body', async t => {
  const f = fixture(t, {
      transportResponse: ({init}) => {
        if (JSON.parse(init.body).query.includes('conversion_tracking_setting'))
          return Response.json({error: {code: 400, message: 'synthetic-private-diagnostic'}}, {status: 400});
      },
    }),
    out = await f.call();
  assert.equal(out.success, true, JSON.stringify(out));
  assert.equal(proof(out)?.complete, false);
  assert.equal(dependency(out, 'account_default_conversion_goals').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(proof(out)), /synthetic-private-diagnostic/);
  assert.equal(f.attempts(), 2);
});
