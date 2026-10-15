// CMP-07: a synthetic Google customer for the Performance Max build and recipe tests. It answers the customer read,
// reads of existing and created resources and the one all-or-nothing mutate, resolving temporary names as Google does;
// nothing reaches Google.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const google = 'google_ads_native_action',
  actor = {tenantId: 'pmax', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
export {actor as pmaxActor, admin as pmaxAdmin};
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snakeKeys = v =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
const resultKey = {
  campaign_budget_operation: 'campaignBudgetResult',
  campaign_operation: 'campaignResult',
  campaign_criterion_operation: 'campaignCriterionResult',
  asset_operation: 'assetResult',
  asset_group_operation: 'assetGroupResult',
  asset_group_asset_operation: 'assetGroupAssetResult',
  asset_group_signal_operation: 'assetGroupSignalResult',
};
const collection = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  asset_operation: 'assets',
  asset_group_operation: 'assetGroups',
  asset_group_asset_operation: 'assetGroupAssets',
  asset_group_signal_operation: 'assetGroupSignals',
};
/** Existing account assets: two images, a logo and a text asset that is not an image. */
export const existing = {
  'customers/123/assets/501': 'IMAGE',
  'customers/123/assets/502': 'IMAGE',
  'customers/123/assets/503': 'IMAGE',
  'customers/123/assets/504': 'TEXT',
};
export function pmaxCustomer() {
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
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const created = new Map(),
    mutates = [],
    queries = [];
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
          const from = / FROM ([a-z_]+)/.exec(q)[1],
            names = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
          if (from === 'asset' && !names.some(n => created.has(n)))
            return Response.json({
              results: names.filter(n => existing[n]).map(n => ({asset: {resourceName: n, type: existing[n]}})),
            });
          return Response.json({
            results: names
              .filter(n => created.has(n))
              .map(n => ({
                [camel(from)]: {
                  ...created.get(n),
                  ...(from === 'asset_group' ? {primaryStatus: 'PAUSED', adStrength: 'PENDING'} : {}),
                },
              })),
          });
        }
        assert.ok(path.endsWith('/googleAds:mutate'), path);
        mutates.push(body);
        const names = new Map(),
          real = v =>
            typeof v === 'string' && names.has(v)
              ? names.get(v)
              : Array.isArray(v)
                ? v.map(real)
                : v && typeof v === 'object'
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, real(x)]))
                  : v;
        return Response.json({
          mutateOperationResponses: body.mutate_operations.map(op => {
            const key = Object.keys(op)[0],
              {resource_name: temp, ...record} = op[key].create,
              kind = collection[key],
              id = String(next++),
              resolved = real(record),
              name =
                key === 'asset_group_asset_operation'
                  ? `customers/123/assetGroupAssets/${resolved.asset_group.split('/').at(-1)}~${resolved.asset.split('/').at(-1)}~${resolved.field_type}`
                  : key === 'asset_group_signal_operation'
                    ? `customers/123/assetGroupSignals/${resolved.asset_group.split('/').at(-1)}~${id}`
                    : key === 'campaign_criterion_operation'
                      ? `customers/123/campaignCriteria/${resolved.campaign.split('/').at(-1)}~${id}`
                      : `customers/123/${kind}/${id}`;
            if (temp) names.set(temp, name);
            created.set(name, {resourceName: name, ...resolved});
            return {[resultKey[key]]: {resourceName: name}};
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
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = operations =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: '123',
        payload: {mutate_operations: operations},
      },
    });
  const execute = review =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
  return {store, created, mutates, queries, call, prepare, execute};
}
