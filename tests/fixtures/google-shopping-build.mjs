// R2.5 M3 (r25-m3-trees, G5, journey J11): a Standard Shopping campaign with its product tree. The payload builders (`shoppingTree`,
// `shoppingBuild`, `treeEdit`) and a synthetic Google that answers the customer read, the reads of an ad group with its campaign
// and of its listing group tree, the read-back of every created resource, the one-service mutate of ad group criteria and the
// all-or-nothing build mutate, resolving the temporary names of both grammars (`-ag~-n` and `{agId}~-n`) as Google does.
// Every ID and name is synthetic; nothing reaches Google.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const google = 'google_ads_native_action',
  account = '123',
  actor = {tenantId: 'shopping-tree', userId: 'operator', role: 'operator'},
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
  ad_group_operation: 'adGroupResult',
  ad_group_ad_operation: 'adGroupAdResult',
  ad_group_criterion_operation: 'adGroupCriterionResult',
};
const collection = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  ad_group_operation: 'adGroups',
  ad_group_ad_operation: 'adGroupAds',
  ad_group_criterion_operation: 'adGroupCriteria',
};

const brand = v => ({product_brand: v ? {value: v} : {}}),
  condition = v => ({product_condition: v ? {condition: v} : {}});
/**
 * The five nodes of a Standard Shopping tree, parents first: the root, by brand "Acme" (a unit with a bid), "Beta" (a unit),
 * "Zeta" (an excluded unit) and "Other" (a unit). `adGroup` is the ad group the nodes are named after (`-3` for a new one,
 * an ID for one that exists) and `first` the first of the consecutive negative numbers the nodes take.
 */
export function shoppingTree({adGroup = '-3', first = 4} = {}) {
  const name = n => at('adGroupCriteria', adGroup + '~-' + (first + n)),
    nodes = [{number: 0, name: name(0), type: 'SUBDIVISION'}];
  const unit = (n, caseValue, extra = {}) =>
    nodes.push({number: n, name: name(n), type: 'UNIT', parent: name(0), caseValue, ...extra});
  unit(1, brand('Acme'), {bid: '1500000'});
  unit(2, brand('Beta'), {bid: '900000'});
  unit(3, brand('Zeta'), {negative: true});
  unit(4, brand(), {bid: '700000'});
  assert.equal(nodes.length, 5);
  return nodes;
}
/** The create of a node in snake_case, as a build takes it: named, with its listing group. */
export const nodeCreate = (n, adGroupRef) => ({
  resource_name: n.name,
  ad_group: adGroupRef,
  listing_group: {
    type: n.type,
    ...(n.parent ? {parent_ad_group_criterion: n.parent, case_value: n.caseValue} : {}),
  },
  ...(n.negative ? {negative: true} : {}),
  ...(n.bid ? {cpc_bid_micros: n.bid} : {}),
  ...(n.status ? {status: n.status} : {}),
});
/** The tree as the operations of a build. */
export const treeOperations = (options = {}, nodes = shoppingTree(options)) =>
  nodes.map(n => ({
    ad_group_criterion_operation: {create: nodeCreate(n, at('adGroups', options.adGroup ?? '-3'))},
  }));
/**
 * A Standard Shopping build: a budget, a paused SHOPPING campaign with a Merchant Center account, its location, an
 * ad group of type SHOPPING_PRODUCT_ADS, its shopping product ad and the tree. `tree` replaces the tree's operations (an empty
 * list builds none); `campaign` and `adGroup` add fields to those creates.
 */
export function shoppingBuild({tree = treeOperations(), campaign = {}, adGroup = {}} = {}) {
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: at('campaignBudgets', '-1'),
          name: 'Shopping budget',
          amount_micros: '30000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: at('campaigns', '-2'),
          name: 'Standard Shopping',
          status: 'PAUSED',
          advertising_channel_type: 'SHOPPING',
          campaign_budget: at('campaignBudgets', '-1'),
          manual_cpc: {},
          shopping_setting: {merchant_id: '555', campaign_priority: 0},
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...campaign,
        },
      },
    },
    {
      campaign_criterion_operation: {
        create: {campaign: at('campaigns', '-2'), location: {geo_target_constant: 'geoTargetConstants/2682'}},
      },
    },
    // No language criterion (package r25-m3-live, F3): Google refuses one on a SHOPPING campaign (the lead's live validate-only of 2026-11-20:
    // OPERATION_NOT_PERMITTED_FOR_CONTEXT, trigger SHOPPING, at campaign_criterion_operation.create.language), and AMCP refuses it at prepare.
    // This build carried one before, which is why its operation counts moved by one (J11: 10 operations, not 11).
    {
      ad_group_operation: {
        create: {
          resource_name: at('adGroups', '-3'),
          name: 'All products',
          campaign: at('campaigns', '-2'),
          status: 'ENABLED',
          type: 'SHOPPING_PRODUCT_ADS',
          cpc_bid_micros: '800000',
          ...adGroup,
        },
      },
    },
    {
      ad_group_ad_operation: {
        create: {ad_group: at('adGroups', '-3'), status: 'ENABLED', ad: {shopping_product_ad: {}}},
      },
    },
    ...tree,
  ];
}
/** A one-service edit of the tree of an ad group that exists, in the camelCase a caller writes: `removes` first, then the tree. */
export function treeEdit({adGroup = '55', removes = [], nodes = shoppingTree({adGroup, first: 1}), extra = {}} = {}) {
  return {
    operations: [
      ...removes.map(remove => ({remove})),
      ...nodes.map(n => ({
        create: {
          resourceName: n.name,
          adGroup: at('adGroups', adGroup),
          listingGroup: {
            type: n.type,
            ...(n.parent ? {parentAdGroupCriterion: n.parent, caseValue: camelCase(n.caseValue)} : {}),
          },
          ...(n.negative ? {negative: true} : {}),
          ...(n.bid ? {cpcBidMicros: n.bid} : {}),
          ...(n.status ? {status: n.status} : {}),
          ...extra,
        },
      })),
    ],
  };
}
const camelCase = v =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelCase(x)])) : v;

/**
 * A synthetic Google customer. `adGroups` and `campaigns` hold what exists, by resource name; `criteria` the listing group
 * nodes that exist (snake_case records); `tamper(record, name)` may change what a read-back returns and `reject` makes Google
 * refuse a build. It returns the service, the records of what it was asked, and `prepare` / `execute` for the one-service
 * review and for a build.
 *
 * Added by the M3 merge for its joins (tests/m3-merge-joins.test.mjs). `policy` is off by default, so no earlier test changes: it adds
 * fields to the deployment's execution policy (`{providerCheckByDefault: true}` is the production policy: the default validate-only).
 * A validate-only request is not an option: it is now always answered as Google answers one that passes (an empty answer), whatever
 * the policy, recorded in `validations` apart from the mutates, and it applies nothing. A test that sent `provider_check: true` to
 * this fixture before the merge had that request recorded and applied as a mutate, which was a fixture bug.
 */
export function shoppingCustomer({
  adGroups = {},
  campaigns = {},
  criteria = [],
  tamper,
  reject = false,
  policy = {},
} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64'));
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
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const created = new Map(),
    nodes = new Map(criteria.map(r => [r.resource_name, structuredClone(r)])),
    mutates = [],
    validations = [],
    queries = [],
    // What a test may switch: a tree read that has another page, a row of another ad group in it, a mutate that answers one result
    // short, a one-service mutate whose response is lost (`lose`), applied or not (`applied` false), and `keepRemoved`: a removed listing
    // group stays as a row with status REMOVED (the criterion's status has that value), which a read lists unless its query leaves REMOVED
    // out (R2.5 M3 round 2, S2-1); by default a removed node is gone, as it was. The live check LV-15 (the lead's run of 2026-11-20, package
    // r25-m3-live) found that Google leaves no such row, so this switch models a defence, not Google's answer: the tree read still leaves
    // REMOVED out.
    //
    // `asGoogleAnswers` (package r25-m3-live, the lead's live runs of 2026-11-20 on a Google test account) makes the customer answer as Google
    // did there, and is off by default so that no earlier test changes: a read lists every SUBDIVISION as PAUSED and every other listing group as
    // ENABLED, whatever status was sent; a budget created with explicitly_shared: false reads back under the name of the campaign that uses it;
    // a removed listing group leaves no row, and a node created in the same request with the same case value takes the removed node's
    // criterion ID (a new SUBDIVISION also keeps the cpc_bid_micros of the unit it replaced).
    mode = {
      page: false,
      foreign: false,
      short: false,
      lose: false,
      applied: true,
      keepRemoved: false,
      asGoogleAnswers: false,
    };
  let next = 100;
  const listingRows = (adGroup, q = '') => [
    ...[...nodes.values()]
      .filter(
        r => r.ad_group === adGroup && !(r.status === 'REMOVED' && /ad_group_criterion\.status != 'REMOVED'/.test(q)),
      )
      .map(r => ({
        adGroupCriterion: {
          ...r,
          ...(mode.asGoogleAnswers && r.status !== 'REMOVED'
            ? {status: r.listing_group?.type === 'SUBDIVISION' ? 'PAUSED' : 'ENABLED'}
            : {}),
          ...(tamper ? tamper(r, r.resource_name) : {}),
        },
      })),
    ...(mode.foreign
      ? [
          {
            adGroupCriterion: {
              resource_name: at('adGroupCriteria', '56~77'),
              ad_group: at('adGroups', '56'),
              type: 'LISTING_GROUP',
              listing_group: {type: 'UNIT'},
            },
          },
        ]
      : []),
  ];
  const rowsOf = (from, names) =>
    names
      .filter(n => created.has(n))
      .map(n => ({
        [camel(from)]: {
          ...created.get(n),
          ...(mode.asGoogleAnswers && from === 'campaign_budget' && created.get(n).explicitly_shared === false
            ? {name: [...created.values()].find(c => c.campaign_budget === n)?.name ?? created.get(n).name}
            : {}),
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
          if (from === 'ad_group_criterion' && / ad_group_criterion\.type = 'LISTING_GROUP'/.test(q))
            return Response.json({
              results: listingRows(names[0], q),
              ...(mode.page ? {nextPageToken: 'more'} : {}),
            });
          // A criterion read by its resource name (the targeting family's state read of a removal): the node as the fixture holds it.
          // Added by the M3 merge for the trees review's S4-7 test; the tree reads above are unchanged.
          if (from === 'ad_group_criterion' && names.some(n => nodes.has(n)))
            return Response.json({
              results: names.filter(n => nodes.has(n)).map(n => ({adGroupCriterion: nodes.get(n)})),
            });
          if (from === 'ad_group' && adGroups[names[0]]) {
            const g = adGroups[names[0]];
            return Response.json({
              results: [
                {
                  adGroup: {resourceName: names[0], status: g.status, type: g.type, campaign: g.campaign},
                  campaign: campaigns[g.campaign] ?? {},
                },
              ],
            });
          }
          if (from === 'campaign' && campaigns[names[0]])
            return Response.json({results: [{campaign: {resourceName: names[0], ...campaigns[names[0]]}}]});
          return Response.json({results: rowsOf(from, names)});
        }
        if (body.validate_only === true) {
          validations.push({path, body});
          return Response.json({});
        }
        mutates.push({path, body});
        if (path.endsWith('/adGroupCriteria:mutate')) {
          // Google applies the whole request: a node is removed only once its children are, and a temporary parent resolves.
          const temp = new Map(),
            removed = new Map(),
            results = [];
          for (const op of body.operations) {
            if (op.remove) {
              assert.ok(
                ![...nodes.values()].some(
                  n => n.status !== 'REMOVED' && n.listing_group?.parent_ad_group_criterion === op.remove,
                ),
                'children first',
              );
              // What a removed node held, by its case value, for `asGoogleAnswers` (a node of the same case value takes its ID).
              removed.set(
                JSON.stringify(nodes.get(op.remove)?.listing_group?.case_value ?? null),
                nodes.get(op.remove),
              );
              if (mode.applied) {
                if (mode.keepRemoved) nodes.set(op.remove, {...nodes.get(op.remove), status: 'REMOVED'});
                else nodes.delete(op.remove);
              }
              results.push({resourceName: op.remove});
              continue;
            }
            const c = op.create,
              group = String(c.ad_group).split('/').at(-1),
              reused = mode.asGoogleAnswers
                ? removed.get(JSON.stringify(c.listing_group?.case_value ?? null))
                : undefined,
              name = reused ? reused.resource_name : at('adGroupCriteria', group + '~' + next);
            if (!reused) next++;
            if (c.resource_name) temp.set(c.resource_name, name);
            const parent = c.listing_group?.parent_ad_group_criterion;
            // A new SUBDIVISION keeps the cpc_bid_micros of the node whose ID it took (live evidence of 2026-11-20); a unit keeps what it was sent.
            const bid =
              c.cpc_bid_micros ??
              (reused && c.listing_group?.type === 'SUBDIVISION' ? reused.cpc_bid_micros : undefined);
            if (mode.applied)
              nodes.set(name, {
                resource_name: name,
                ad_group: c.ad_group,
                criterion_id: name.split('~').at(-1),
                type: 'LISTING_GROUP',
                negative: c.negative === true,
                status: c.status ?? 'ENABLED',
                ...(bid ? {cpc_bid_micros: bid} : {}),
                listing_group: {
                  type: c.listing_group.type,
                  ...(parent ? {parent_ad_group_criterion: temp.get(parent) ?? parent} : {}),
                  ...(c.listing_group.case_value ? {case_value: c.listing_group.case_value} : {}),
                },
              });
            results.push({resourceName: name});
          }
          if (mode.lose) throw new TypeError('synthetic lost response');
          return Response.json({results: mode.short ? results.slice(1) : results});
        }
        assert.ok(path.endsWith('/googleAds:mutate'), path);
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
              id = String(next++),
              resolved = real(record),
              last = s => String(s).split('/').at(-1),
              name =
                key === 'ad_group_criterion_operation'
                  ? at('adGroupCriteria', last(resolved.ad_group) + '~' + id)
                  : key === 'ad_group_ad_operation'
                    ? at('adGroupAds', last(resolved.ad_group) + '~' + id)
                    : key === 'campaign_criterion_operation'
                      ? at('campaignCriteria', last(resolved.campaign) + '~' + id)
                      : at(collection[key], id);
            if (temp) names.set(temp, name);
            if (key === 'ad_group_criterion_operation') {
              const parent = resolved.listing_group?.parent_ad_group_criterion;
              nodes.set(name, {
                resource_name: name,
                ad_group: resolved.ad_group,
                criterion_id: id,
                type: 'LISTING_GROUP',
                negative: resolved.negative === true,
                status: resolved.status ?? 'ENABLED',
                ...(resolved.cpc_bid_micros ? {cpc_bid_micros: resolved.cpc_bid_micros} : {}),
                listing_group: {
                  type: resolved.listing_group.type,
                  ...(parent ? {parent_ad_group_criterion: parent} : {}),
                  ...(resolved.listing_group.case_value ? {case_value: resolved.listing_group.case_value} : {}),
                },
              });
            } else created.set(name, {resource_name: name, ...resolved});
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
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0, ...policy},
  );
  const call = (tool, input) => service.call(tool, input, actor);
  /** The one-service review of ad group criteria. */
  const prepareEdit = (payload, extra = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
        account_id: account,
        payload,
        ...extra,
      },
    });
  const prepare = operations =>
    call('amcp_write', {
      action: 'prepare',
      gateway: google,
      arguments: {
        action: 'google_ads_v23_google_ads_mutate',
        account_id: account,
        payload: {mutate_operations: operations},
      },
    });
  const execute = (review, extra = {}) =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.data.review_id,
      confirmed: true,
      spend_change_confirmed: true,
      ...extra,
    });
  const verify = review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  return {store, created, nodes, mutates, validations, queries, mode, call, prepare, prepareEdit, execute, verify};
}
/** An existing PAUSED Standard Shopping ad group `55` in a PAUSED Shopping campaign with a Merchant Center account. */
export const existingAdGroup = (overrides = {}) => ({
  adGroups: {
    [at('adGroups', '55')]: {status: 'PAUSED', type: 'SHOPPING_PRODUCT_ADS', campaign: at('campaigns', '40')},
  },
  campaigns: {
    [at('campaigns', '40')]: {
      status: 'PAUSED',
      advertisingChannelType: 'SHOPPING',
      shoppingSetting: {merchantId: '555'},
    },
  },
  ...overrides,
});
/** A node of an existing tree, as Google lists it. */
export const existingNode = (id, type, parent, caseValue, extra = {}) => ({
  resource_name: at('adGroupCriteria', '55~' + id),
  ad_group: at('adGroups', '55'),
  criterion_id: String(id),
  type: 'LISTING_GROUP',
  negative: false,
  status: 'ENABLED',
  listing_group: {
    type,
    ...(parent ? {parent_ad_group_criterion: at('adGroupCriteria', '55~' + parent), case_value: caseValue} : {}),
  },
  ...extra,
});
