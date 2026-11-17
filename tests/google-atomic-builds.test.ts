import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * The owner's item 5 and decision 1 (2026-09-29): a Google build is all or nothing. One reviewed googleAds:mutate
 * creates the budget, the paused campaign, its targeting, ad groups, keywords and ads; Google applies all of it or
 * none (pinned v25 contract: partialFailure false), and AMCP reads every created resource back.
 */
const google = 'google_ads_native_action',
  actor: Actor = {tenantId: 'atomic', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
// Google reads either JSON spelling; the compiled request uses camelCase.
const snakeKeys = (v: unknown): any =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
const resultKey: Record<string, string> = {
  campaign_budget_operation: 'campaignBudgetResult',
  campaign_operation: 'campaignResult',
  campaign_criterion_operation: 'campaignCriterionResult',
  ad_group_operation: 'adGroupResult',
  ad_group_criterion_operation: 'adGroupCriterionResult',
  ad_group_ad_operation: 'adGroupAdResult',
};
const collection: Record<string, string> = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  ad_group_operation: 'adGroups',
  ad_group_criterion_operation: 'adGroupCriteria',
  ad_group_ad_operation: 'adGroupAds',
};
function setup({reject = false, existing = 'PAUSED'} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 58).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const created = new Map<string, JsonObject>(),
    mutates: JsonObject[] = [],
    queries: string[] = [];
  let next = 100;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const body = snakeKeys(JSON.parse(String(init?.body))),
          path = new URL(String(url)).pathname;
        if (path.endsWith('googleAds:search')) {
          const q = String(body.query);
          queries.push(q);
          if (/ FROM customer /.test(q + ' '))
            return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
          const from = / FROM ([a-z_]+)/.exec(q)![1]!,
            names = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]!);
          // An existing campaign the build can add to.
          if (from === 'campaign' && names[0] === 'customers/123/campaigns/77')
            return Response.json({
              results: [
                {
                  campaign: {
                    resourceName: names[0],
                    status: existing,
                    campaignBudget: 'customers/123/campaignBudgets/7',
                  },
                },
              ],
            });
          return Response.json({
            results: names.filter(n => created.has(n)).map(n => ({[camel(from)]: created.get(n)})),
          });
        }
        assert.ok(path.endsWith('/googleAds:mutate'), path);
        mutates.push(body);
        if (reject)
          return Response.json(
            {error: {code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
            {status: 400},
          );
        // Google applies the whole request, resolving temporary names to the IDs it allocates.
        const names = new Map<string, string>(),
          real = (v: unknown): unknown =>
            typeof v === 'string' && names.has(v)
              ? names.get(v)
              : Array.isArray(v)
                ? v.map(real)
                : v && typeof v === 'object'
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
                  : v;
        return Response.json({
          mutateOperationResponses: body.mutate_operations.map((op: JsonObject) => {
            const key = Object.keys(op)[0]!,
              {resource_name: temp, ...record} = op[key].create,
              kind = collection[key]!,
              id = String(next++),
              parent = record.ad_group ?? record.campaign,
              name =
                'customers/123/' +
                kind +
                '/' +
                (/Criteria|Ads$/.test(kind) ? String(real(parent)).split('/').at(-1) + '~' + id : id);
            if (temp) names.set(temp, name);
            created.set(name, {resourceName: name, ...(real(record) as JsonObject)});
            return {[resultKey[key]!]: {resourceName: name}};
          }),
        });
      },
      undefined,
      undefined,
      undefined,
      10000,
    ),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool: string, input: JsonObject) => service.call(tool, input, actor) as Promise<JsonObject>;
  const prepare = (operations: JsonObject[], extra: JsonObject = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: '123',
        payload: {mutate_operations: operations, ...extra},
      },
    });
  const execute = (review: JsonObject, extra: JsonObject = {spend_change_confirmed: true}) =>
    call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true, ...extra});
  return {store, created, mutates, queries, call, prepare, execute};
}
const budget = {
  campaign_budget_operation: {
    create: {
      resource_name: 'customers/123/campaignBudgets/-1',
      name: 'Build budget',
      amount_micros: '40000000',
      delivery_method: 'STANDARD',
      explicitly_shared: false,
    },
  },
};
const campaign = (status = 'PAUSED') => ({
  campaign_operation: {
    create: {
      resource_name: 'customers/123/campaigns/-2',
      name: 'Build',
      status,
      advertising_channel_type: 'SEARCH',
      campaign_budget: 'customers/123/campaignBudgets/-1',
      manual_cpc: {},
      network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
      contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
  },
});
const adGroup = (campaignName = 'customers/123/campaigns/-2', status = 'ENABLED') => ({
  ad_group_operation: {
    create: {
      resource_name: 'customers/123/adGroups/-3',
      name: 'Brand',
      campaign: campaignName,
      status,
      type: 'SEARCH_STANDARD',
      cpc_bid_micros: '1500000',
    },
  },
});
const keyword = (text: string, extra: JsonObject = {status: 'ENABLED'}) => ({
  ad_group_criterion_operation: {
    create: {ad_group: 'customers/123/adGroups/-3', keyword: {text, match_type: 'EXACT'}, ...extra},
  },
});
const build = () => [
  budget,
  campaign(),
  {
    campaign_criterion_operation: {
      create: {
        campaign: 'customers/123/campaigns/-2',
        location: {geo_target_constant: 'geoTargetConstants/2682'},
      },
    },
  },
  {
    campaign_criterion_operation: {
      create: {campaign: 'customers/123/campaigns/-2', language: {language_constant: 'languageConstants/1000'}},
    },
  },
  adGroup(),
  keyword('acme'),
  keyword('acme widgets'),
  keyword('jobs', {negative: true}),
  {
    ad_group_ad_operation: {
      create: {
        ad_group: 'customers/123/adGroups/-3',
        status: 'ENABLED',
        ad: {
          responsive_search_ad: {
            headlines: [{text: 'Acme'}, {text: 'Acme widgets'}, {text: 'Buy Acme'}],
            descriptions: [{text: 'Widgets for all.'}, {text: 'Fast delivery.'}],
          },
          final_urls: ['https://example.test/'],
        },
      },
    },
  },
];

test('a whole Search build is one review, one request and one read-back of every resource', async () => {
  const x = setup();
  try {
    const review = await x.prepare(build());
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 1200));
    assert.equal(x.mutates.length, 0);
    const impact = JSON.stringify(review.data);
    assert.match(impact, /"all_or_nothing":true/);
    assert.match(impact, /"operations":9/);
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    const refused = await x.execute(review, {});
    assert.equal(refused.success, false, 'no spending acknowledgement');
    assert.equal(x.mutates.length, 0);
    const done = await x.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(x.mutates.length, 1, 'one request');
    assert.equal(x.mutates[0]!.mutate_operations.length, 9);
    assert.equal(x.created.size, 9);
    const replay = await x.execute(review);
    assert.equal(replay.data.replayed, true);
    assert.equal(x.mutates.length, 1, 'a replay sends nothing');
    const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
    assert.equal(verified.success, true, JSON.stringify(verified).slice(0, 1200));
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1500));
    assert.equal(verified.data.checks.length, 9);
    // The ad group was read back under the campaign Google created, not the temporary name.
    const campaignName = [...x.created.keys()].find(n => n.includes('/campaigns/'))!;
    assert.equal([...x.created.values()].find(r => r.name === 'Brand')!.campaign, campaignName);
    assert.ok(x.queries.some(q => q.includes("ad_group.resource_name IN ('customers/123/adGroups/")));
  } finally {
    x.store.close();
  }
});

test('a build Google refuses leaves nothing, and is never sent again', async () => {
  const x = setup({reject: true});
  try {
    const review = await x.prepare(build());
    const failed = await x.execute(review);
    assert.equal(failed.success, false);
    assert.equal(x.created.size, 0);
    const again = await x.execute(review);
    assert.equal(again.success, false);
    assert.equal(x.mutates.length, 1, 'never resubmitted');
  } finally {
    x.store.close();
  }
});

// Package r25-m3-targeting (R2.5 M3, G8, Q1, owner 2026-11-15) changed this test, 'children under a serving parent start paused; under the
// build's paused campaign they may start enabled': children of an existing campaign that serves may start enabled too, with the spend
// confirmation every build asks for, and a parent the build could not read still refuses.
test('children of an existing serving campaign may start enabled; an existing campaign that cannot be read refuses; a new campaign starts paused', async () => {
  const x = setup({existing: 'ENABLED'});
  try {
    // An ad group added to an existing serving campaign.
    const serving = await x.prepare([adGroup('customers/123/campaigns/77'), keyword('acme')]);
    assert.equal(serving.success, true, JSON.stringify(serving).slice(0, 800));
    assert.equal(serving.data.execute_requirements.spend_change_confirmed, true);
    assert.ok(x.queries.some(q => q.includes("campaign.resource_name IN ('customers/123/campaigns/77')")));
    // A campaign whose status was not read (a status Google does not name) refuses, naming the operation.
    const unread = setup({existing: 'UNSPECIFIED'});
    try {
      const refused = await unread.prepare([adGroup('customers/123/campaigns/77'), keyword('acme')]);
      assert.equal(refused.error?.code, 'PARENT_SERVING', JSON.stringify(refused).slice(0, 800));
      assert.equal(refused.error.details.operation, 0);
      assert.equal(refused.error.details.parent_unread, true);
    } finally {
      unread.store.close();
    }
    const paused = await x.prepare([adGroup('customers/123/campaigns/77', 'PAUSED'), keyword('acme')]);
    assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 800));
    // A new campaign itself must start paused.
    const live = await x.prepare([budget, campaign('ENABLED')]);
    assert.equal(live.error?.code, 'PAUSED_CREATION_REQUIRED', JSON.stringify(live).slice(0, 800));
    assert.match(live.error.message, /^mutate_operations\[1\]: /);
    assert.equal(x.mutates.length, 0);
  } finally {
    x.store.close();
  }
});

test('builds outside the contract are refused before any request, naming the operation', async () => {
  const x = setup();
  try {
    const cases: [JsonObject[], JsonObject, RegExp][] = [
      [build(), {partial_failure: true}, /partial_failure must be false/],
      [build(), {validate_only: true}, /validate_only/],
      [
        [{campaign_operation: {update: {resource_name: 'customers/123/campaigns/5', name: 'x'}}}],
        {},
        /must be \{create/,
      ],
      // CMP-07 made asset_group_operation part of the Performance Max build; another service stays outside the contract.
      [[{campaign_asset_operation: {create: {campaign: 'customers/123/campaigns/77'}}}], {}, /must be exactly one of/],
      [[adGroup()], {}, /no earlier operation of this build creates/],
      [
        [
          budget,
          {
            ...campaign(),
            campaign_operation: {
              create: {...campaign().campaign_operation.create, campaign_budget: 'customers/123/campaignBudgets/-9'},
            },
          },
        ],
        {},
        /no earlier operation/,
      ],
      [[budget, budget], {}, /-1 is used twice/],
      [
        [
          budget,
          {
            ...campaign(),
            campaign_operation: {
              create: {...campaign().campaign_operation.create, campaign_budget: 'customers/999/campaignBudgets/5'},
            },
          },
        ],
        {},
        /this customer/,
      ],
      [
        [
          {
            campaign_criterion_operation: {
              create: {
                resource_name: 'customers/123/campaignCriteria/-5',
                campaign: 'customers/123/campaigns/77',
                location: {geo_target_constant: 'geoTargetConstants/1'},
              },
            },
          },
        ],
        {},
        /only budgets, campaigns, ad groups, assets and asset groups/,
      ],
      [Array.from({length: 1001}, () => budget), {}, /1–1000 operations/],
    ];
    for (const [operations, extra, message] of cases) {
      const r = await x.prepare(operations, extra);
      assert.equal(r.success, false, String(message));
      assert.match(r.error.message, message, JSON.stringify(r.error).slice(0, 600));
      assert.ok(r.error.details.field || r.error.details.operation !== undefined, JSON.stringify(r.error));
    }
    assert.equal(x.queries.length, 0, 'no reads');
    assert.equal(x.mutates.length, 0);
  } finally {
    x.store.close();
  }
});

test('an owner policy that forbids activation refuses enabled children; a budget cap sees the new budget', async () => {
  for (const [policy, code] of [
    [{enforcement: 'block', allow_activation: false, allow_deletion: false}, /POLICY_ACTIVATION_FORBIDDEN/],
    [{enforcement: 'block', allow_activation: true, allow_deletion: false, max_budget_native: 30}, /BUDGET|CAP|LIMIT/],
  ] as const) {
    const x = setup();
    try {
      saveSpendPolicy(x.store, admin, {confirmed: true, gateway: google, account_id: '123', policy});
      const review = await x.prepare(build());
      // A policy refusal comes at prepare where the review can already tell, and at execute otherwise.
      const refused = review.success ? await x.execute(review) : review;
      assert.equal(refused.success, false, JSON.stringify(policy));
      assert.match(refused.error.code, code, JSON.stringify(refused.error).slice(0, 600));
      // The refusal says how to proceed: keep it paused, or ask the owner (the owner's decision 3).
      if (policy.allow_activation === false)
        assert.match(refused.error.message, /Keep status paused.*ask the workspace owner/);
      assert.equal(x.mutates.length, 0);
    } finally {
      x.store.close();
    }
  }
});

test('a budget finer than the account currency can be charged is refused at prepare (WRT-07)', async () => {
  // The synthetic customer spends USD: Google charges whole cents, so 40.005 USD (40005000 micros) used to be sent and
  // fail with NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT. The refusal shows the amount in currency and in micros.
  const x = setup();
  try {
    const fine = {
      campaign_budget_operation: {create: {...budget.campaign_budget_operation.create, amount_micros: '40005000'}},
    };
    const review = await x.prepare([fine, ...build().slice(1)]);
    assert.equal(review.success, false);
    assert.equal(review.error.code, 'BUDGET_PRECISION_INVALID', JSON.stringify(review.error));
    assert.equal(review.error.details.requested, '40.005 USD (40005000 micros)');
    assert.equal(review.error.details.minimum_unit, '0.01 USD');
    assert.equal(x.mutates.length, 0);
    assert.equal((await x.prepare(build())).success, true);
  } finally {
    x.store.close();
  }
});
