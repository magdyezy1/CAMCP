import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * F-80: Google Ads v25 replaced lifecycle goal configuration with goals (GoalService) and campaign goal configs
 * (CampaignGoalConfigService), which AMCP did not review, so new customer acquisition could only be set in the Google
 * Ads interface. Shapes from the pinned v25 contract; rules from Google's GoalError and CampaignGoalConfigError.
 */
const google = 'google_ads_native_action',
  actor: Actor = {tenantId: 'goals', userId: 'operator', role: 'operator'},
  admin: Actor = {...actor, role: 'admin'};
const snakeKeys = (v: unknown): any =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
const typeOf: Record<string, string> = {
  new_customer_acquisition_goal_settings: 'NEW_CUSTOMER_ACQUISITION',
  retention_goal_settings: 'CUSTOMER_RETENTION',
  loyalty_retention_goal_settings: 'LOYALTY_RETENTION',
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 59).toString('base64'));
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
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const goals = new Map<string, JsonObject>(),
    configs = new Map<string, JsonObject>(),
    writes: JsonObject[] = [],
    queries: string[] = [];
  let next = 40;
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
          const from = / FROM ([a-z_]+)/.exec(q)![1]!,
            names = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]!);
          if (from === 'goal')
            return Response.json({
              results: [...goals.values()]
                .filter(g => !names.length || names.includes(g.resource_name))
                .map(g => ({goal: g})),
            });
          if (from === 'campaign')
            return Response.json({
              results: names
                .filter(n => n === 'customers/123/campaigns/77')
                .map(n => ({campaign: {resourceName: n, status: 'PAUSED', advertisingChannelType: 'SEARCH'}})),
            });
          if (from === 'campaign_goal_config')
            return Response.json({
              results: [...configs.values()]
                .filter(c => names.includes(c.resource_name) || names.includes(c.campaign))
                .map(c => ({campaignGoalConfig: c})),
            });
          return Response.json({results: []});
        }
        writes.push({path, body});
        const results = body.operations.map((op: JsonObject) => {
          if (path.endsWith('/Goals:mutate')) {
            if (op.create) {
              const block = Object.keys(op.create)[0]!,
                resource_name = 'customers/123/goals/' + next++;
              goals.set(resource_name, {resource_name, goal_type: typeOf[block], ...op.create});
              return {resourceName: resource_name};
            }
            const g = goals.get(op.update.resource_name)!;
            for (const [k, v] of Object.entries(op.update) as [string, JsonObject][])
              if (k !== 'resource_name')
                g[k] = {...(g[k] ?? {}), value_settings: {...(g[k]?.value_settings ?? {}), ...v.value_settings}};
            return {resourceName: op.update.resource_name};
          }
          if (op.remove) {
            configs.delete(op.remove);
            return {resourceName: op.remove};
          }
          if (op.create) {
            const goal = goals.get(op.create.goal)!,
              resource_name =
                'customers/123/campaignGoalConfigs/' +
                op.create.campaign.split('/').at(-1) +
                '~' +
                op.create.goal.split('/').at(-1);
            configs.set(resource_name, {resource_name, goal_type: goal.goal_type, ...op.create});
            return {resourceName: resource_name};
          }
          const c = configs.get(op.update.resource_name)!;
          for (const [k, v] of Object.entries(op.update) as [string, JsonObject][])
            if (k !== 'resource_name') c[k] = {...(c[k] ?? {}), ...v};
          return {resourceName: op.update.resource_name};
        });
        return Response.json({results});
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
  const prepare = (action: string, operations: JsonObject[], extra: JsonObject = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {action, account_id: '123', payload: {operations, ...extra}},
    });
  const run = async (action: string, operations: JsonObject[]) => {
    const review = await prepare(action, operations);
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    const done = await call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    const verified = await call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
    assert.equal(verified.data?.status, 'verified', JSON.stringify(verified).slice(0, 1200));
    return {review, done, verified};
  };
  return {store, goals, configs, writes, queries, call, prepare, run};
}
const goals = 'google_ads_v23_goal_mutate_goals',
  links = 'google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs';
const acquisition = (value_settings: JsonObject = {value_multiplier: 1.5, high_lifetime_value_multiplier: 3}) => ({
  create: {new_customer_acquisition_goal_settings: {value_settings}},
});

test('a new customer acquisition goal is created and read back; a second one of the type is refused', async () => {
  const x = setup();
  try {
    const unconfirmed = await x.prepare(goals, [acquisition()]);
    assert.equal(unconfirmed.data.execute_requirements.spend_change_confirmed, true);
    const refused = await x.call('amcp_write', {
      action: 'execute',
      review_id: unconfirmed.data.review_id,
      confirmed: true,
    });
    assert.equal(refused.success, false, 'bidding values change: the spending acknowledgement is required');
    assert.equal(x.writes.length, 0);
    const {verified} = await x.run(goals, [acquisition()]);
    assert.equal(verified.data.checks.length, 1);
    const [name] = [...x.goals.keys()];
    const again = await x.prepare(goals, [acquisition()]);
    assert.equal(again.error?.code, 'GOOGLE_GOAL_EXISTS', JSON.stringify(again).slice(0, 600));
    assert.equal(again.error.details.existing, name);
    // Updating it changes exactly the masked values.
    await x.run(goals, [
      {
        update: {resource_name: name, new_customer_acquisition_goal_settings: {value_settings: {value_multiplier: 2}}},
        update_mask: 'new_customer_acquisition_goal_settings.value_settings.value_multiplier',
      },
    ]);
    assert.equal(x.goals.get(name!)!.new_customer_acquisition_goal_settings.value_settings.value_multiplier, 2);
    // The documented relation holds for the values the goal will have: 3 is not above 4.
    const low = await x.prepare(goals, [
      {
        update: {resource_name: name, new_customer_acquisition_goal_settings: {value_settings: {value_multiplier: 4}}},
        update_mask: 'new_customer_acquisition_goal_settings.value_settings.value_multiplier',
      },
    ]);
    assert.equal(low.error?.code, 'INVALID_GOOGLE_LIFECYCLE_GOAL', JSON.stringify(low).slice(0, 600));
    assert.match(low.error.message, /high_lifetime_value_multiplier must be greater than value_multiplier/);
    assert.equal(x.writes.length, 2);
  } finally {
    x.store.close();
  }
});

test('a campaign is linked to the goal, its settings updated and the link removed, each read back', async () => {
  const x = setup();
  try {
    await x.run(goals, [acquisition()]);
    const [goal] = [...x.goals.keys()];
    await x.run(links, [
      {
        create: {
          campaign: 'customers/123/campaigns/77',
          goal,
          campaign_new_customer_acquisition_settings: {
            target_option: 'TARGET_ALL',
            value_settings_override: {value_multiplier: 1.2},
          },
        },
      },
    ]);
    const [config] = [...x.configs.keys()];
    assert.equal(config, 'customers/123/campaignGoalConfigs/77~40');
    const twice = await x.prepare(links, [
      {create: {campaign: 'customers/123/campaigns/77', goal, campaign_new_customer_acquisition_settings: {}}},
    ]);
    assert.equal(twice.error?.code, 'GOOGLE_GOAL_CONFIG_EXISTS', JSON.stringify(twice).slice(0, 600));
    await x.run(links, [
      {
        update: {resource_name: config, campaign_new_customer_acquisition_settings: {target_option: 'TARGET_SPECIFIC'}},
        update_mask: 'campaign_new_customer_acquisition_settings.target_option',
      },
    ]);
    // Removal is a deletion under an owner policy.
    saveSpendPolicy(x.store, admin, {
      confirmed: true,
      gateway: google,
      account_id: '123',
      policy: {allow_activation: true, allow_deletion: false},
    });
    const forbidden = await x.prepare(links, [{remove: config}]);
    const refusal = forbidden.success
      ? await x.call('amcp_write', {
          action: 'execute',
          review_id: forbidden.data.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        })
      : forbidden;
    assert.equal(refusal.error?.code, 'POLICY_DELETION_FORBIDDEN', JSON.stringify(refusal).slice(0, 600));
    assert.equal(x.configs.size, 1);
    saveSpendPolicy(x.store, admin, {
      confirmed: true,
      gateway: google,
      account_id: '123',
      policy: {allow_activation: true, allow_deletion: true},
    });
    const {verified} = await x.run(links, [{remove: config}]);
    assert.equal(verified.data.checks[0].status ?? verified.data.status, 'verified');
    assert.equal(x.configs.size, 0);
  } finally {
    x.store.close();
  }
});

test('shapes Google documents as errors are refused before any request; state mismatches after reading', async () => {
  const x = setup();
  try {
    const before: [string, JsonObject[], JsonObject, RegExp][] = [
      [
        goals,
        [acquisition({high_lifetime_value_multiplier: 2, value_multiplier: 3})],
        {},
        /must be greater than value_multiplier/,
      ],
      [goals, [acquisition({high_lifetime_value_multiplier: 2})], {}, /needs value_multiplier/],
      [goals, [acquisition({additional_high_lifetime_value: 5})], {}, /needs additional_value/],
      [goals, [acquisition({value_multiplier: 'high'})], {}, /must be a number/],
      [
        goals,
        [{create: {new_customer_acquisition_goal_settings: {}, retention_goal_settings: {}}}],
        {},
        /exactly one of/,
      ],
      [
        goals,
        [{create: {resource_name: 'customers/123/goals/-1', retention_goal_settings: {}}}],
        {},
        /Google names a new resource/,
      ],
      [goals, [{remove: 'customers/123/goals/1'}], {}, /goals are not removed/],
      [
        goals,
        [
          {
            update: {
              resource_name: 'customers/123/goals/1',
              retention_goal_settings: {value_settings: {value_multiplier: 2}},
            },
            update_mask: 'retention_goal_settings.value_settings.additional_value',
          },
        ],
        {},
        /update_mask must list exactly the fields sent/,
      ],
      [goals, [acquisition()], {partial_failure: true}, /partial_failure must be false/],
      [goals, [acquisition()], {validate_only: true}, /validate_only is not accepted/],
      [
        links,
        [
          {
            create: {
              campaign: 'customers/123/campaigns/77',
              goal: 'customers/123/goals/1',
              campaign_new_customer_acquisition_settings: {
                target_option: 'TARGET_SPECIFIC',
                value_settings_override: {value_multiplier: 2},
              },
            },
          },
        ],
        {},
        /TARGET_SPECIFIC\) takes no override values/,
      ],
      [
        links,
        [
          {
            update: {
              resource_name: 'customers/123/campaignGoalConfigs/77~1',
              campaign: 'customers/123/campaigns/78',
              campaign_retention_settings: {},
            },
            update_mask: 'campaign_retention_settings.target_option',
          },
        ],
        {},
        /campaign is immutable/,
      ],
      [
        links,
        [
          {
            create: {
              campaign: 'customers/999/campaigns/77',
              goal: 'customers/123/goals/1',
              campaign_retention_settings: {},
            },
          },
        ],
        {},
        /this customer’s campaigns/,
      ],
    ];
    for (const [action, operations, extra, message] of before) {
      const r = await x.prepare(action, operations, extra);
      assert.equal(r.success, false, String(message));
      assert.match(r.error.message, message, JSON.stringify(r.error).slice(0, 600));
      assert.ok(r.error.details.field, JSON.stringify(r.error));
    }
    assert.equal(x.queries.length, 0, 'no reads');
    // After reading: the goal's type decides the settings block, and the campaign must exist.
    await x.run(goals, [acquisition()]);
    const [goal] = [...x.goals.keys()];
    const wrongType = await x.prepare(links, [
      {
        create: {
          campaign: 'customers/123/campaigns/77',
          goal,
          campaign_retention_settings: {target_option: 'TARGET_ALL'},
        },
      },
    ]);
    assert.equal(wrongType.error?.code, 'GOOGLE_GOAL_TYPE_MISMATCH', JSON.stringify(wrongType).slice(0, 600));
    const noCampaign = await x.prepare(links, [
      {create: {campaign: 'customers/123/campaigns/78', goal, campaign_new_customer_acquisition_settings: {}}},
    ]);
    assert.equal(noCampaign.error?.code, 'GOOGLE_GOAL_CAMPAIGN_NOT_FOUND', JSON.stringify(noCampaign).slice(0, 600));
    const noGoal = await x.prepare(links, [
      {
        create: {
          campaign: 'customers/123/campaigns/77',
          goal: 'customers/123/goals/9',
          campaign_new_customer_acquisition_settings: {},
        },
      },
    ]);
    assert.equal(noGoal.error?.code, 'GOOGLE_GOAL_NOT_FOUND');
    assert.equal(x.writes.length, 1);
  } finally {
    x.store.close();
  }
});
