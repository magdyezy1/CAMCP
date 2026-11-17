// R2.5 M3 (r25-m3-trees, L2-09, journey J10): a Performance Max retail asset group with its product tree in one build.
// The payload builders (`retailTree`, `retailPmaxBuild`) and a synthetic Google that answers the customer read, the reads of
// existing assets and campaigns, the read-back of every created resource, and the one all-or-nothing mutate, resolving the
// temporary names of both grammars (`-g` and `-g~-n`) as Google does. Every ID and name is synthetic; nothing reaches Google.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const google = 'google_ads_native_action',
  account = '123',
  actor = {tenantId: 'retail-tree', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
export const at = (collection, id) => 'customers/' + account + '/' + collection + '/' + id;
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
  asset_group_listing_group_filter_operation: 'assetGroupListingGroupFilterResult',
};
const collection = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  asset_operation: 'assets',
  asset_group_operation: 'assetGroups',
  asset_group_asset_operation: 'assetGroupAssets',
  asset_group_signal_operation: 'assetGroupSignals',
  asset_group_listing_group_filter_operation: 'assetGroupListingGroupFilters',
};
/** Existing account assets: two images, a logo and a text asset that is not an image. */
export const existingAssets = {
  [at('assets', '501')]: 'IMAGE',
  [at('assets', '502')]: 'IMAGE',
  [at('assets', '503')]: 'IMAGE',
  [at('assets', '504')]: 'TEXT',
};

/**
 * The 24 nodes of a retail tree, parents first: the root, by condition (new, used, refurbished, and "other" subdivided by
 * brand), under the brand "Acme" by product type, under "shoes" by item ID (eight items and "other"). `group` is the temporary
 * number of the asset group (`-20`) and `first` the first of 24 consecutive negative numbers the nodes take.
 */
export function retailTree({group = '-20', first = 300} = {}) {
  const nodes = [],
    name = n => at('assetGroupListingGroupFilters', group + '~-' + (first + n)),
    add = (type, parent, caseValue) => {
      nodes.push({number: nodes.length, name: name(nodes.length), type, parent: parent?.name, caseValue});
    };
  add('SUBDIVISION');
  const root = nodes[0];
  const condition = v => ({product_condition: v ? {condition: v} : {}}),
    brand = v => ({product_brand: v ? {value: v} : {}}),
    type1 = v => ({product_type: {level: 'LEVEL1', ...(v ? {value: v} : {})}}),
    item = v => ({product_item_id: v ? {value: v} : {}});
  for (const c of ['NEW', 'USED', 'REFURBISHED']) add('UNIT_INCLUDED', root, condition(c));
  add('SUBDIVISION', root, condition());
  const other = nodes.at(-1);
  add('SUBDIVISION', other, brand('Acme'));
  const acme = nodes.at(-1);
  for (const b of ['Beta', 'Gamma', 'Delta']) add('UNIT_INCLUDED', other, brand(b));
  add('UNIT_EXCLUDED', other, brand('Zeta'));
  add('UNIT_INCLUDED', other, brand());
  add('SUBDIVISION', acme, type1('shoes'));
  const shoes = nodes.at(-1);
  add('UNIT_INCLUDED', acme, type1('bags'));
  add('UNIT_INCLUDED', acme, type1('hats'));
  add('UNIT_INCLUDED', acme, type1());
  for (let i = 1; i <= 8; i++) add('UNIT_INCLUDED', shoes, item(String(1000 + i)));
  add('UNIT_INCLUDED', shoes, item());
  assert.equal(nodes.length, 24);
  return nodes;
}
/** The operations that create a tree of nodes in a build, in snake_case as the build takes them. */
export function retailTreeOperations(options = {}, nodes = retailTree(options)) {
  const group = options.group ?? '-20';
  return nodes.map(n => ({
    asset_group_listing_group_filter_operation: {
      create: {
        resource_name: n.name,
        asset_group: at('assetGroups', group),
        type: n.type,
        listing_source: 'SHOPPING',
        ...(n.parent ? {parent_listing_group_filter: n.parent, case_value: n.caseValue} : {}),
      },
    },
  }));
}
const text = (n, value) => ({
  asset_operation: {create: {resource_name: at('assets', '-' + n), text_asset: {text: value}}},
});
const link = (asset, field_type, group = '-20') => ({
  asset_group_asset_operation: {create: {asset_group: at('assetGroups', group), asset, field_type}},
});
/**
 * A retail Performance Max build: a budget, a paused PERFORMANCE_MAX campaign with a Merchant Center account, an asset group
 * with the minimum assets (text created here, images and a logo that exist), and the tree. `tree` replaces the tree's operations
 * (an empty list builds no tree), `campaign` and `group` add fields to those creates.
 */
export function retailPmaxBuild({tree = retailTreeOperations(), campaign = {}, group = {}} = {}) {
  const texts = [
    ['HEADLINE', 'Acme'],
    ['HEADLINE', 'Acme widgets'],
    ['HEADLINE', 'Buy Acme'],
    ['LONG_HEADLINE', 'Widgets for every workshop'],
    ['DESCRIPTION', 'Widgets for all.'],
    ['DESCRIPTION', 'Fast delivery.'],
    ['BUSINESS_NAME', 'Acme'],
  ];
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: at('campaignBudgets', '-1'),
          name: 'Retail budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: at('campaigns', '-2'),
          name: 'Retail PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: at('campaignBudgets', '-1'),
          maximize_conversion_value: {},
          shopping_setting: {merchant_id: '555'},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...campaign,
        },
      },
    },
    ...texts.map(([, t], i) => text(100 + i, t)),
    {
      asset_group_operation: {
        create: {
          resource_name: at('assetGroups', '-20'),
          name: 'All products',
          campaign: at('campaigns', '-2'),
          final_urls: ['https://example.test/'],
          status: 'PAUSED',
          ...group,
        },
      },
    },
    ...texts.map(([type], i) => link(at('assets', '-' + (100 + i)), type)),
    link(at('assets', '501'), 'MARKETING_IMAGE'),
    link(at('assets', '502'), 'SQUARE_MARKETING_IMAGE'),
    link(at('assets', '503'), 'LOGO'),
    ...tree,
  ];
}

/**
 * A synthetic Google customer for the build. `campaigns` holds existing campaigns by resource name (read for the parents of a
 * build), `tamper(created, name)` may change what a read-back returns, and `reject` makes Google refuse the build. It returns
 * the service, the records of what it was asked, and `prepare` / `execute` for a build.
 */
export function retailCustomer({campaigns = {}, tamper, reject = false} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway: google,
      accounts: [account],
      writeAccounts: [account],
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
  const rowsOf = (from, names) =>
    names
      .filter(n => created.has(n))
      .map(n => ({
        [camel(from)]: {
          ...created.get(n),
          ...(from === 'asset_group' ? {primaryStatus: 'PAUSED', adStrength: 'PENDING'} : {}),
          ...(tamper ? tamper(created.get(n), n) : {}),
        },
      }));
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
            return Response.json({results: [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}]});
          const from = / FROM ([a-z_]+)/.exec(q)[1],
            names = [...q.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
          // The whole tree of one asset group: every node created under it.
          if (from === 'asset_group_listing_group_filter')
            return Response.json({
              results: [...created.values()]
                .filter(
                  r =>
                    String(r.resource_name).includes('/assetGroupListingGroupFilters/') && r.asset_group === names[0],
                )
                .map(r => ({assetGroupListingGroupFilter: {...r, ...(tamper ? tamper(r, r.resource_name) : {})}})),
            });
          if (from === 'asset' && !names.some(n => created.has(n)))
            return Response.json({
              results: names
                .filter(n => existingAssets[n])
                .map(n => ({asset: {resourceName: n, type: existingAssets[n]}})),
            });
          if (from === 'campaign' && campaigns[names[0]])
            return Response.json({results: [{campaign: {resourceName: names[0], ...campaigns[names[0]]}}]});
          return Response.json({results: rowsOf(from, names)});
        }
        assert.ok(path.endsWith('/googleAds:mutate'), path);
        mutates.push(body);
        // Google refuses the whole request: nothing is created (partialFailure false).
        if (reject)
          return Response.json(
            {error: {code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
            {status: 400},
          );
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
              last = s => String(s).split('/').at(-1),
              name =
                key === 'asset_group_asset_operation'
                  ? `customers/${account}/assetGroupAssets/${last(resolved.asset_group)}~${last(resolved.asset)}~${resolved.field_type}`
                  : key === 'asset_group_signal_operation'
                    ? `customers/${account}/assetGroupSignals/${last(resolved.asset_group)}~${id}`
                    : key === 'campaign_criterion_operation'
                      ? `customers/${account}/campaignCriteria/${last(resolved.campaign)}~${id}`
                      : key === 'asset_group_listing_group_filter_operation'
                        ? `customers/${account}/assetGroupListingGroupFilters/${last(resolved.asset_group)}~${id}`
                        : `customers/${account}/${kind}/${id}`;
            if (temp) names.set(temp, name);
            created.set(name, {resource_name: name, ...resolved});
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
  const prepare = (operations, extra = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: account,
        payload: {mutate_operations: operations, ...extra},
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
