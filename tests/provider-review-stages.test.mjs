import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {reviewSummary} from '../dist/src/review-summary.js';

// ARC-01 phase B, the review's summary and spending stages: what each shared stage decided for one provider by name is
// now that provider adapter's fact (src/provider-adapters.ts), and each stage asks the adapter of the request's
// gateway at the point where it named the provider. Every comparison below runs the stage against its branch as it was
// written, over every ledger route and the edges of the moved rule. Loading the catalog first evaluates the registry,
// as entry points do.
const registry = new Registry();
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const rows = actionContracts(registry).filter(r => r.method && r.path);
const pathOf = r =>
  r.path.startsWith('https://')
    ? new URL(r.path.replace(/\{[^}]+\}/g, '123')).pathname
    : r.path.split('?')[0].replace(/\{[^}]+\}/g, '123');
const plan = (gateway, method, path, action, extra = {}) => ({
  gateway,
  action,
  method,
  path,
  query: {},
  body: {},
  headers: {},
  readOnly: false,
  destructive: method === 'DELETE',
  requiresConfirmation: false,
  accountId: '123',
  evidence: '',
  warnings: [],
  ...extra,
});
/** Every ledger route under its own method and action, with each body of `bodies`. */
function ledgerPlans(bodies) {
  const out = [];
  for (const r of rows) {
    const action = r.operation ? r.operation + (r.action !== r.operation ? '/' + r.action : '') : r.action;
    for (const body of bodies) out.push(plan(r.gateway, r.method, pathOf(r), action, {body, origin: r.origin}));
  }
  return out;
}

/** review-summary.ts before the move: operationOf, transcribed as it was written (Google Ads' branch included). */
const googleKinds = {
  campaigns: 'campaign',
  adGroups: 'ad group',
  adGroupAds: 'ad group ad',
  campaignBudgets: 'campaign budget',
  ads: 'ad',
  assets: 'asset',
  assetGroups: 'asset group',
  campaignCriteria: 'campaign criterion',
  adGroupCriteria: 'ad group criterion',
  sharedSets: 'shared set',
  sharedCriteria: 'shared criterion',
  campaignSharedSets: 'campaign shared set',
};
const singular = {
  campaigns: 'campaign',
  adsquads: 'ad squad',
  ads: 'ad',
  creatives: 'creative',
  adsets: 'ad set',
  adcreatives: 'ad creative',
  segments: 'segment',
  line_items: 'line item',
  lineItems: 'line item',
  insertionOrders: 'insertion order',
  adGroups: 'ad group',
  adgroup: 'ad group',
  campaign: 'campaign',
  ad: 'ad',
};
function copiedOperationOf(plan) {
  const body = plan.body;
  if (plan.gateway === 'google_ads_native_action') {
    const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1] ?? '',
      operations = object(body) && Array.isArray(body.operations) ? body.operations : [];
    const ops = operations.map(op =>
      op?.create !== undefined ? 'create' : op?.remove !== undefined ? 'remove' : 'update',
    );
    const kinds = [...new Set(ops)];
    return {
      operation: kinds.length === 1 ? kinds[0] : 'change',
      entity: googleKinds[kind] ?? kind,
      count: ops.length || 1,
    };
  }
  const segments = plan.path.split('/').filter(Boolean),
    collection = [...segments].reverse().find(s => Object.hasOwn(singular, s.replace(/:.*/, ''))) ?? '',
    key = collection.replace(/:.*/, ''),
    rows = object(body) && Array.isArray(body[key]) ? body[key].length : Array.isArray(body) ? 1 : 1;
  const action = plan.action.toLowerCase();
  const operation =
    plan.method === 'DELETE' || /(?:^|_)delete(?:_|$)/.test(action) || plan.destructive
      ? 'delete'
      : /:publish$/.test(plan.path)
        ? 'publish'
        : /(?:^|_)(?:create|post)(?:_|$)/.test(action) && segments.at(-1) === key
          ? 'create'
          : 'update';
  return {operation, entity: singular[key] ?? (key || segments.at(-1) || 'resource'), count: rows};
}
const run = f => {
  try {
    return {result: f()};
  } catch (error) {
    return {refused: error.code ?? String(error)};
  }
};

test('the review summary names every operation as before: every ledger route, body and Google Ads service', () => {
  const bodies = [
    {},
    {operations: [{create: {name: 'a'}}]},
    {operations: [{remove: 'customers/1/campaigns/2'}]},
    {operations: [{update: {status: 'PAUSED'}, updateMask: 'status'}]},
    {operations: [{create: {}}, {remove: 'x'}, {update: {}}]},
    {operations: []},
    {operations: 'none'},
    {operations: [null, 1, {create: undefined, remove: 'x'}]},
    {campaigns: [{name: 'a'}, {name: 'b'}], adsquads: [{}]},
    [{op: 'replace', path: '/status', value: 'PAUSED'}],
    null,
  ];
  const plans = ledgerPlans(bodies);
  // Each service the Google Ads branch named, one it did not, a service named like an object member, and requests
  // that are no :mutate at all, of Google Ads and of a gateway that has no such fact.
  for (const kind of [...Object.keys(googleKinds), 'customerAssets', 'constructor', 'toString'])
    for (const body of bodies) {
      plans.push(plan('google_ads_native_action', 'POST', '/v25/customers/1/' + kind + ':mutate', 'x', {body}));
      plans.push(plan('meta_native_action', 'POST', '/v25/customers/1/' + kind + ':mutate', 'x', {body}));
    }
  for (const body of bodies) {
    plans.push(plan('google_ads_native_action', 'POST', '/v25/customers/1/googleAds:search', 'x', {body}));
    plans.push(plan('google_ads_native_action', 'DELETE', '/v25/customers/1/campaigns/2', 'x_delete', {body}));
    plans.push(plan(undefined, 'POST', '/v25/customers/1/campaigns:mutate', 'x', {body}));
  }
  const summarized = new Set();
  for (const p of plans) {
    const expected = run(() => copiedOperationOf(p)),
      got = run(() => {
        const {operation, entity, count} = reviewSummary(p, []);
        return {operation, entity, count};
      });
    assert.deepEqual(got, expected, JSON.stringify([p.gateway, p.method, p.path, p.action, p.body]));
    if (p.gateway === 'google_ads_native_action' && expected.result) summarized.add(expected.result.operation);
  }
  assert.ok(plans.length > 20000, String(plans.length));
  // Google Ads' operations were reached in every form the branch gave.
  assert.deepEqual([...summarized].sort(), ['change', 'create', 'remove', 'update']);
});

test('the review stage facts are frozen facts of their adapters, and the stages name no gateway', () => {
  assert.deepEqual(
    providerAdapters.filter(a => a.reviewOperations).map(a => a.gateway),
    ['google_ads_native_action'],
  );
  for (const a of providerAdapters) if (a.reviewOperations) assert.ok(Object.isFrozen(a.reviewOperations), a.id);
  // The regression this guards: a provider branch back in a shared review stage (the module named Google Ads).
  assert.doesNotMatch(fs.readFileSync('src/review-summary.ts', 'utf8'), /_native_action/);
});
