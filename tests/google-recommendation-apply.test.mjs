import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Applying keyword and campaign budget recommendations, Google Ads API v23 (pinned Discovery document:
 * RecommendationService.ApplyRecommendation; checked 2026-09-27).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/';
const actions = {v23: 'google_ads_v23_recommendation_apply_recommendation', alias: 'APPLY_RECOMMENDATION'};
const actor = {tenantId: 'google-recommendation-apply', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const rec = id => C + 'recommendations/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const recommendations = new Map([
    [
      'k1',
      {
        type: 'KEYWORD',
        adGroup: C + 'adGroups/11',
        campaign: C + 'campaigns/1',
        keywordRecommendation: {
          keyword: {text: 'running shoes', matchType: 'PHRASE'},
          recommendedCpcBidMicros: '1200000',
        },
      },
    ],
    [
      'k2',
      {
        type: 'KEYWORD',
        adGroup: C + 'adGroups/11',
        campaign: C + 'campaigns/1',
        keywordRecommendation: {keyword: {text: 'Trail Shoes', matchType: 'BROAD'}},
      },
    ],
    [
      'b1',
      {
        type: 'CAMPAIGN_BUDGET',
        campaign: C + 'campaigns/1',
        campaignBudget: C + 'campaignBudgets/7',
        campaignBudgetRecommendation: {
          recommendedBudgetAmountMicros: '80000000',
          currentBudgetAmountMicros: '50000000',
        },
      },
    ],
    ['t1', {type: 'TARGET_CPA_OPT_IN', campaign: C + 'campaigns/1'}],
    [
      'd1',
      {
        type: 'KEYWORD',
        adGroup: C + 'adGroups/11',
        dismissed: true,
        keywordRecommendation: {keyword: {text: 'old', matchType: 'EXACT'}},
      },
    ],
  ]);
  const budgets = new Map([
    [C + 'campaignBudgets/7', {amountMicros: '50000000', status: 'ENABLED', explicitlyShared: false, period: 'DAILY'}],
  ]);
  const groups = new Map([
    [C + 'adGroups/11', {status: 'ENABLED', type: 'SEARCH_STANDARD'}],
    [C + 'adGroups/12', {status: 'REMOVED', type: 'SEARCH_STANDARD'}],
  ]);
  const criteria = [
    {
      resourceName: C + 'adGroupCriteria/11~1',
      adGroup: C + 'adGroups/11',
      keyword: {text: 'trail shoes', matchType: 'EXACT'},
      negative: false,
      status: 'ENABLED',
    },
  ];
  const inList = (q, field) => [...q.matchAll(new RegExp("'([^']+)'", 'g'))].map(m => m[1]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = decodeURIComponent(u.pathname),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, body});
      if (path === '/v25/customers/123/googleAds:search') {
        const q = body.query,
          names = inList(q);
        if (/FROM recommendation /.test(q))
          return Response.json({
            results: names
              .filter(n => recommendations.has(n.split('/').at(-1)))
              .map(n => ({recommendation: {resourceName: n, ...recommendations.get(n.split('/').at(-1))}})),
          });
        if (/FROM campaign_budget /.test(q))
          return Response.json({
            results: names
              .filter(n => budgets.has(n))
              .map(n => ({campaignBudget: {resourceName: n, ...budgets.get(n)}})),
          });
        if (/FROM ad_group WHERE/.test(q))
          return Response.json({
            results: names
              .filter(n => groups.has(n))
              .map(n => ({adGroup: {resourceName: n, ...groups.get(n)}, campaign: {status: 'ENABLED'}})),
          });
        if (/FROM ad_group_criterion /.test(q))
          return Response.json({
            results: criteria
              .filter(c => names.includes(c.adGroup) && c.status !== 'REMOVED')
              .map(c => ({adGroupCriterion: c})),
          });
        throw new Error('Unexpected query ' + q);
      }
      if (path === '/v25/customers/123/recommendations:apply') {
        writes++;
        const results = body.operations.map(op => {
          const id = op.resourceName.split('/').at(-1),
            r = recommendations.get(id);
          if (mode !== 'ignore') {
            if (r.type === 'KEYWORD') {
              const k = op.keyword ?? {};
              criteria.push({
                resourceName: C + 'adGroupCriteria/11~' + (criteria.length + 2),
                adGroup: k.adGroup ?? r.adGroup,
                keyword: {
                  text: r.keywordRecommendation.keyword.text,
                  matchType: k.matchType ?? r.keywordRecommendation.keyword.matchType,
                },
                negative: false,
                status: 'ENABLED',
              });
            } else
              budgets.get(r.campaignBudget).amountMicros =
                op.campaignBudget?.newBudgetAmountMicros ??
                r.campaignBudgetRecommendation.recommendedBudgetAmountMicros;
            recommendations.delete(id);
          }
          return {resourceName: mode === 'other' ? rec('zz') : op.resourceName};
        });
        return Response.json({results});
      }
      throw new Error('Unexpected ' + path);
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
  const apply = (operations, action = actions.v23) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations}}},
      actor,
    );
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
  return {store, calls, budgets, criteria, apply, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('keyword recommendations are applied after spending confirmation, as recommended and with another match type, and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.apply([
        {resourceName: rec('k1')},
        {resourceName: rec('k2'), keyword: {matchType: 'PHRASE', adGroup: C + 'adGroups/11', cpcBidMicros: '900000'}},
      ]),
    );
    assert.equal(p.data.creative_impact.scope, 'recommendation_apply');
    assert.deepEqual(
      p.data.creative_impact.changes.map(c => c.matchType),
      ['PHRASE', 'PHRASE'],
    );
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.writes(), 1);
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).data.replayed, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('a budget recommendation sets the recommended or a chosen amount and verifies; owner budget limits and activation rules apply', async () => {
  const f = fixture();
  try {
    const p = ok(await f.apply([{resourceName: rec('b1')}], actions.alias));
    assert.equal(p.data.creative_impact.changes[0].toMicros, '80000000');
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.budgets.get(C + 'campaignBudgets/7').amountMicros, '80000000');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {
      gateway,
      account_id: '123',
      confirmed: true,
      policy: {enforcement: 'block', max_budget_native: 60000000},
    });
    assert.equal((await g.apply([{resourceName: rec('b1')}])).error?.code, 'POLICY_BUDGET_LIMIT');
    const q = ok(await g.apply([{resourceName: rec('b1'), campaignBudget: {newBudgetAmountMicros: '55000000'}}]));
    ok(await g.execute(q, {spend_change_confirmed: true}));
    assert.equal(ok(await g.verify(q)).data.status, 'verified');
  } finally {
    g.store.close();
  }
  const h = fixture();
  try {
    saveSpendPolicy(h.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await h.apply([{resourceName: rec('k1')}])).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
    ok(await h.apply([{resourceName: rec('b1')}]));
  } finally {
    h.store.close();
  }
});

test('malformed operations are refused before any request; other types, mixed types, dismissed, unknown and duplicate keywords after reading', async () => {
  const cases = [
    ['other customer', [{resourceName: 'customers/999/recommendations/k1'}]],
    ['other parameters', [{resourceName: rec('t1'), targetCpaOptIn: {goal: 'SAME_CONVERSIONS'}}]],
    [
      'both parameters',
      [
        {
          resourceName: rec('k1'),
          keyword: {matchType: 'EXACT', adGroup: C + 'adGroups/11'},
          campaignBudget: {newBudgetAmountMicros: '1'},
        },
      ],
    ],
    ['match type', [{resourceName: rec('k1'), keyword: {matchType: 'BROAD_MODIFIED', adGroup: C + 'adGroups/11'}}]],
    ['no ad group', [{resourceName: rec('k1'), keyword: {matchType: 'EXACT'}}]],
    ['zero budget', [{resourceName: rec('b1'), campaignBudget: {newBudgetAmountMicros: '0'}}]],
    ['repeated', [{resourceName: rec('k1')}, {resourceName: rec('k1')}]],
  ];
  for (const [label, operations] of cases) {
    const f = fixture();
    try {
      const r = await f.apply(operations);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.match((await f.apply([{resourceName: rec('t1')}])).error?.message ?? '', /TARGET_CPA_OPT_IN recommendation/);
    assert.match(
      (await f.apply([{resourceName: rec('k1')}, {resourceName: rec('b1')}])).error?.message ?? '',
      /one type per review/,
    );
    assert.match((await f.apply([{resourceName: rec('d1')}])).error?.message ?? '', /dismissed/);
    assert.equal((await f.apply([{resourceName: rec('zz')}])).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (await f.apply([{resourceName: rec('k2'), keyword: {matchType: 'EXACT', adGroup: C + 'adGroups/11'}}])).error
        ?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.match(
      (await f.apply([{resourceName: rec('b1'), campaignBudget: {newBudgetAmountMicros: '50000000'}}])).error
        ?.message ?? '',
      /already has this amount/,
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a receipt naming another recommendation is never resubmitted, an ignored application is not verified, the models match and the ledger lists both writes', async () => {
  const f = fixture('other');
  try {
    const p = ok(await f.apply([{resourceName: rec('b1')}]));
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal((await f.execute(p, {spend_change_confirmed: true})).success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
  const g = fixture('ignore');
  try {
    for (const ops of [[{resourceName: rec('b1')}], [{resourceName: rec('k1')}]]) {
      const p = ok(await g.apply(ops));
      ok(await g.execute(p, {spend_change_confirmed: true}));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    doc = d.document ?? d,
    S = doc.schemas,
    find = re => S[Object.keys(S).find(k => re.test(k))];
  assert.deepEqual(Object.keys(find(/ApplyRecommendationOperation_KeywordParameters$/).properties).sort(), [
    'adGroup',
    'cpcBidMicros',
    'matchType',
  ]);
  assert.deepEqual(Object.keys(find(/ApplyRecommendationOperation_CampaignBudgetParameters$/).properties), [
    'newBudgetAmountMicros',
  ]);
  assert.match(
    find(/Services__ApplyRecommendationRequest$/).properties.operations.description,
    /all recommendations should be of the same type/,
  );
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'google_recommendation_apply', action);
  }
});
