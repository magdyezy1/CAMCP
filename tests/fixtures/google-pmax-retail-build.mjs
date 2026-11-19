// R2.5 M3, package r25-m3-pmax: a synthetic Google Ads customer for a Performance Max retail asset group built under an
// EXISTING campaign (G1), with tall portrait images (G2) and the link review's image and minimum precheck (G3). The M3
// merge's journey J10 reuses it: it exports the J10 build without its listing group tree, the existing retail campaign row,
// the existing image assets with their pixel sizes, a fake Google responder (a `fetch`) and a whole review world around it.
// Every ID, name and value is invented (customer 123, names that start DNU); nothing leaves the process.
//
// The responder answers the GAQL reads of the review lifecycle through a small evaluator: `SELECT fields FROM one resource
// [WHERE field IN (...) | = | != joined by AND] [LIMIT n]`, answering only the fields the query selects (a field of another
// resource the row names, such as campaign.status in an asset group query or asset.image_asset in an asset group asset
// query, is joined). A query that does not select a field therefore does not get it, as with Google. It applies the one
// all-or-nothing `googleAds:mutate` of a build, resolving temporary names as Google does, and a one-service
// `assetGroupAssets:mutate` of a link review.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export const gateway = 'google_ads_native_action',
  account = '123',
  actor = {tenantId: 'pmax-retail', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
export const at = (collection, id) => 'customers/' + account + '/' + collection + '/' + id;

const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snakeKeys = v =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
      : v;

// ----- the existing customer -----

/** The existing campaign a retail asset group is added to: Performance Max, PAUSED, a synthetic Merchant Center account. */
export const campaignRow = (overrides = {}) =>
  Object.fromEntries(
    Object.entries({
      resource_name: at('campaigns', '900'),
      name: 'DNU PMax retail',
      status: 'PAUSED',
      advertising_channel_type: 'PERFORMANCE_MAX',
      campaign_budget: at('campaignBudgets', '7'),
      brand_guidelines_enabled: false,
      shopping_setting: {merchant_id: '5550100'},
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
export const existingCampaign = Object.freeze(campaignRow());

const image = (id, width, height, name) => ({
  resource_name: at('assets', String(id)),
  type: 'IMAGE',
  source: 'ADVERTISER',
  name,
  // Google writes an int64 as a string in JSON: "1200", not 1200.
  image_asset: {full_size: {width_pixels: String(width), height_pixels: String(height)}},
});
/** Image asset IDs by what they are for: pixel sizes as the account's assets hold them. */
export const ids = {
  landscape: [9101, 9102, 9103, 9104, 9105], // 1200 x 628, 1.91:1
  square: [9201, 9202, 9203, 9204, 9205], // 1200 x 1200
  portrait: [9301, 9302, 9303, 9304], // 960 x 1200, 4:5
  tall: [9401], // 1080 x 1920, 9:16
  logo: [9501], // 1200 x 1200
  landscapeLogo: [9601, 9602], // 1200 x 300, 4:1
  wide: [9701], // 1920 x 1080, 16:9: not 1.91:1
  cta: [9801],
  text: [9901], // a TEXT asset, no image
  copy: Array.from({length: 30}, (_, i) => 3001 + i), // thirty text assets a link review can use for headlines, descriptions
};
/** The account's existing assets that a build links: images with their pixel sizes, a call to action, a text asset. */
export const existingAssets = Object.freeze([
  ...ids.landscape.map(id => image(id, 1200, 628, 'DNU landscape ' + id)),
  ...ids.square.map(id => image(id, 1200, 1200, 'DNU square ' + id)),
  ...ids.portrait.map(id => image(id, 960, 1200, 'DNU portrait ' + id)),
  ...ids.tall.map(id => image(id, 1080, 1920, 'DNU tall ' + id)),
  ...ids.logo.map(id => image(id, 1200, 1200, 'DNU logo ' + id)),
  ...ids.landscapeLogo.map(id => image(id, 1200, 300, 'DNU landscape logo ' + id)),
  ...ids.wide.map(id => image(id, 1920, 1080, 'DNU wide ' + id)),
  {
    resource_name: at('assets', '9801'),
    type: 'CALL_TO_ACTION',
    source: 'ADVERTISER',
    name: 'DNU call to action',
    call_to_action_asset: {call_to_action: 'SHOP_NOW'},
  },
  {
    resource_name: at('assets', '9901'),
    type: 'TEXT',
    source: 'ADVERTISER',
    name: 'DNU text',
    text_asset: {text: 'DNU text'},
  },
  ...ids.copy.map(id => ({
    resource_name: at('assets', String(id)),
    type: 'TEXT',
    source: 'ADVERTISER',
    name: 'DNU copy ' + id,
    text_asset: {text: 'DNU copy ' + id},
  })),
]);
export const assetName = id => at('assets', String(id));
/**
 * The links of an asset group that meets every minimum (brand guidelines off): [field type, asset ID]. Three headlines, a long
 * headline, two descriptions, a business name, a landscape and a square image, a logo.
 */
export const minimumLinks = [
  ['HEADLINE', 3001],
  ['HEADLINE', 3002],
  ['HEADLINE', 3003],
  ['LONG_HEADLINE', 3004],
  ['DESCRIPTION', 3005],
  ['DESCRIPTION', 3006],
  ['BUSINESS_NAME', 3007],
  ['MARKETING_IMAGE', 9101],
  ['SQUARE_MARKETING_IMAGE', 9201],
  ['LOGO', 9501],
];

// ----- the J10 build, without its tree -----

const group = at('assetGroups', '-1');
const textOp = (n, value) => ({
  asset_operation: {create: {resource_name: at('assets', '-' + n), text_asset: {text: value}}},
});
const linkOp = (asset, field_type, assetGroup = group) => ({
  asset_group_asset_operation: {create: {asset_group: assetGroup, asset, field_type}},
});
/** The 23 text assets of J10: [field type, text]. Twelve headlines, five long headlines, five descriptions, a business name. */
export const j10Texts = [
  ...Array.from({length: 12}, (_, i) => ['HEADLINE', 'DNU headline ' + (i + 1)]),
  ...Array.from({length: 5}, (_, i) => ['LONG_HEADLINE', 'DNU long headline for the shop, number ' + (i + 1)]),
  ...Array.from({length: 5}, (_, i) => ['DESCRIPTION', 'DNU description ' + (i + 1) + '.']),
  ['BUSINESS_NAME', 'DNU Shop'],
];
/** The 19 image and call-to-action links of J10 to existing assets, tall portrait among them: [field type, asset ID]. */
export const j10ExistingLinks = [
  ...ids.landscape.map(id => ['MARKETING_IMAGE', id]),
  ...ids.square.map(id => ['SQUARE_MARKETING_IMAGE', id]),
  ...ids.portrait.map(id => ['PORTRAIT_MARKETING_IMAGE', id]),
  ...ids.tall.map(id => ['TALL_PORTRAIT_MARKETING_IMAGE', id]),
  ...ids.logo.map(id => ['LOGO', id]),
  ...ids.landscapeLogo.map(id => ['LANDSCAPE_LOGO', id]),
  ...ids.cta.map(id => ['CALL_TO_ACTION_SELECTION', id]),
];
/**
 * The mutate_operations of J10 without the tree: one PAUSED asset group under an existing campaign, 23 text assets, and 42
 * links (23 to the new text assets, 19 to existing assets). 66 operations.
 */
export function j10Build({campaign = existingCampaign.resource_name, status = 'PAUSED', name = 'DNU group'} = {}) {
  return [
    {
      asset_group_operation: {
        create: {
          resource_name: group,
          campaign,
          name,
          final_urls: ['https://example.com/'],
          status,
        },
      },
    },
    ...j10Texts.map(([, value], i) => textOp(101 + i, value)),
    ...j10Texts.map(([type], i) => linkOp(at('assets', '-' + (101 + i)), type)),
    ...j10ExistingLinks.map(([type, id]) => linkOp(assetName(id), type)),
  ];
}
/** The build without the links of these field types (and without the text assets only they used). */
export function withoutFieldTypes(operations, types) {
  const kept = operations.filter(
      op => !op.asset_group_asset_operation || !types.includes(op.asset_group_asset_operation.create.field_type),
    ),
    used = new Set(
      kept.filter(op => op.asset_group_asset_operation).map(op => op.asset_group_asset_operation.create.asset),
    );
  return kept.filter(op => !op.asset_operation || used.has(op.asset_operation.create.resource_name));
}
/** The asset group alone: what a retail campaign allows without any asset. */
export const groupOnly = (operations = j10Build()) => operations.slice(0, 1);
export const linkOperation = linkOp;
export const textOperation = textOp;

// ----- the responder -----

const tableOf = {
  campaignBudgets: 'campaign_budget',
  campaigns: 'campaign',
  assets: 'asset',
  assetGroups: 'asset_group',
  assetGroupAssets: 'asset_group_asset',
  assetGroupSignals: 'asset_group_signal',
};
const operationTable = {
  asset_operation: ['assets', 'asset', 'assetResult'],
  asset_group_operation: ['assetGroups', 'asset_group', 'assetGroupResult'],
  asset_group_asset_operation: ['assetGroupAssets', 'asset_group_asset', 'assetGroupAssetResult'],
  asset_group_signal_operation: ['assetGroupSignals', 'asset_group_signal', 'assetGroupSignalResult'],
};
const get = (object, path) => path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), object);
/** The row's selected fields as Google writes them: camelCase and nested; what the row does not have is left out. */
function project(object, paths) {
  const out = {};
  for (const path of paths) {
    const keys = path.split('.');
    let from = object,
      to = out;
    for (const [i, key] of keys.entries()) {
      if (!(from && typeof from === 'object' && Object.hasOwn(from, key))) break;
      from = from[key];
      if (i === keys.length - 1) to[camel(key)] = from;
      else to = to[camel(key)] ??= {};
    }
  }
  return out;
}

/**
 * An empty customer's tables, and the fake Google over them. `log` collects what was asked: every request, the GAQL of
 * every search and the body of every mutate. `state.mutate` may make the next mutate answer a status (a refusal), and
 * `state.page` makes the searches that match it answer a `nextPageToken`.
 */
export function googleResponder() {
  const db = Object.fromEntries(Object.values(tableOf).map(t => [t, []])),
    log = {requests: [], queries: [], mutates: []},
    state = {next: 500, mutate: undefined, page: undefined};
  const row = (table, fields) => {
    const r = {resource_name: fields.resource_name, ...structuredClone(fields)};
    db[table].push(r);
    return r;
  };
  function search(query) {
    const m = /^\s*SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: LIMIT (\d+))?\s*$/is.exec(query);
    assert.ok(m, 'Unexpected synthetic GAQL: ' + query);
    const [, select, entity, where, limit] = m,
      fields = select.split(',').map(s => s.trim());
    if (entity === 'customer') return [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}];
    assert.ok(db[entity], 'Unexpected synthetic GAQL resource: ' + entity);
    const clauses = (where ?? '')
      .split(/\s+AND\s+/i)
      .filter(Boolean)
      .map(c => {
        const x = /^(\S+)\s+(IN|=|!=)\s+(.+)$/s.exec(c.trim());
        assert.ok(x, 'Unexpected synthetic GAQL clause: ' + c);
        return {field: x[1], op: x[2], values: [...x[3].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(v => v[1])};
      });
    const own = f => (f.startsWith(entity + '.') ? f.slice(entity.length + 1) : undefined);
    const rows = db[entity].filter(r =>
      clauses.every(({field, op, values}) => {
        const v = get(r, own(field) ?? field);
        return op === 'IN' ? values.includes(v) : op === '=' ? v === values[0] : v !== values[0];
      }),
    );
    return rows.slice(0, limit ? Number(limit) : 10000).map(r => {
      const out = {[camel(entity)]: project(r, fields.filter(f => own(f) !== undefined).map(own))};
      // A field of another resource the row names (asset_group.campaign -> campaign.status, asset_group_asset.asset -> asset.type).
      for (const other of new Set(fields.map(f => f.split('.')[0]).filter(t => t !== entity))) {
        const target = db[other]?.find(x => x.resource_name === r[other]);
        if (target)
          out[camel(other)] = project(
            target,
            fields.filter(f => f.startsWith(other + '.')).map(f => f.slice(other.length + 1)),
          );
      }
      return out;
    });
  }
  /** Applies a build or a one-service mutate; Google resolves each temporary name to the ID it allocates. */
  function apply(path, body) {
    const kind = /\/([A-Za-z]+):mutate$/.exec(path)[1],
      real = new Map();
    const resolve = v =>
      typeof v === 'string' && real.has(v)
        ? real.get(v)
        : Array.isArray(v)
          ? v.map(resolve)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]))
            : v;
    const make = (collection, table, create) => {
      const {resource_name: temp, ...fields} = create,
        resolved = resolve(fields),
        tail = s => String(s).split('/').at(-1);
      const name =
        collection === 'assetGroupAssets'
          ? at(collection, [tail(resolved.asset_group), tail(resolved.asset), resolved.field_type].join('~'))
          : collection === 'assetGroupSignals'
            ? at(collection, tail(resolved.asset_group) + '~' + state.next++)
            : at(collection, String(state.next++));
      if (temp) real.set(temp, name);
      const existing = db[table].findIndex(r => r.resource_name === name);
      if (existing >= 0) db[table].splice(existing, 1);
      row(table, {
        resource_name: name,
        status: 'ENABLED',
        ...(table === 'asset' ? {type: 'TEXT', source: 'ADVERTISER'} : {}),
        ...(table === 'asset_group_asset' ? {source: 'ADVERTISER'} : {}),
        ...(table === 'asset_group' ? {primary_status: 'PAUSED', ad_strength: 'PENDING'} : {}),
        ...resolved,
      });
      return name;
    };
    if (kind === 'googleAds')
      return {
        mutateOperationResponses: body.mutate_operations.map(op => {
          const key = Object.keys(op)[0],
            [collection, table, result] = operationTable[key];
          return {[result]: {resourceName: make(collection, table, op[key].create)}};
        }),
      };
    const table = tableOf[kind];
    return {
      results: body.operations.map(op => {
        if (op.remove) {
          const i = db[table].findIndex(r => r.resource_name === op.remove);
          if (i >= 0) db[table][i].status = 'REMOVED';
          return {resourceName: op.remove};
        }
        if (op.update) {
          const {resource_name: target, ...fields} = op.update;
          Object.assign(db[table].find(r => r.resource_name === target) ?? {}, fields);
          return {resourceName: target};
        }
        return {resourceName: make(kind, table, op.create)};
      }),
    };
  }
  const fetcher = async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname,
      method = init.method ?? 'GET',
      body = init.body ? snakeKeys(JSON.parse(String(init.body))) : {};
    log.requests.push({method, path});
    if (path.endsWith('/googleAds:search')) {
      const query = String(body.query);
      log.queries.push(query);
      const results = search(query);
      return Response.json({
        fieldMask: query.split(' FROM')[0].slice(7),
        ...(results.length ? {results} : {}),
        ...(state.page?.test(query) ? {nextPageToken: 'unread-page'} : {}),
      });
    }
    assert.ok(/:mutate$/.test(path), 'Unexpected synthetic Google request ' + method + ' ' + path);
    log.mutates.push(body);
    if (state.mutate)
      return Response.json(
        {error: {code: state.mutate, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
        {status: state.mutate},
      );
    return Response.json(apply(path, body));
  };
  return {db, log, state, row, fetcher};
}

// ----- a whole review world -----

/**
 * A MirrorService over `googleResponder` with an existing customer: the campaign (`campaign`, or none), the existing assets,
 * and the groups the test adds with `addGroup`. `calls` counts the MCP calls the test made, `log` every provider request.
 */
export function pmaxRetailWorld({campaign = campaignRow(), assets = existingAssets, tenantId = actor.tenantId} = {}) {
  const who = {...actor, tenantId},
    owner = {...who, role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const google = googleResponder();
  if (campaign) google.row('campaign', campaign);
  for (const asset of assets) google.row('asset', asset);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(google.fetcher, undefined, undefined, undefined, 10000),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  let calls = 0;
  const call = (tool, input) => {
    calls++;
    return service.call(tool, input, who);
  };
  const buildAction = 'google_ads_v23_google_ads_mutate',
    linkAction = 'google_ads_v23_asset_group_asset_mutate_asset_group_assets';
  const prepare = (action, payload) =>
    call('amcp_write', {action: 'prepare', gateway, arguments: {action, account_id: account, payload}});
  return {
    store,
    owner,
    google,
    db: google.db,
    log: google.log,
    state: google.state,
    service,
    call,
    calls: () => calls,
    buildAction,
    linkAction,
    prepare,
    /** One reviewed build: `mutate_operations`, and anything else the payload carries. */
    prepareBuild: (operations, extra = {}) => prepare(buildAction, {mutate_operations: operations, ...extra}),
    /** One reviewed one-service asset group link batch. */
    prepareLinks: (operations, extra = {}) => prepare(linkAction, {operations, ...extra}),
    execute: (review, extra = {spend_change_confirmed: true}) =>
      call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true, ...extra}),
    verify: review => call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}),
    /**
     * An existing asset group of the campaign, with the advertiser links it already has: [field type, asset ID]. `finalUrls` are its
     * final URLs (one, as a group made in the editor has; `null` for a retail group made without any, which Google answers by
     * leaving the field out, as it leaves out every empty list).
     */
    addGroup({
      id = '102',
      campaign: parent = at('campaigns', '900'),
      status = 'PAUSED',
      links = [],
      automatic = [],
      finalUrls = ['https://example.com/'],
    } = {}) {
      const name = at('assetGroups', id);
      google.row('asset_group', {
        resource_name: name,
        name: 'DNU group ' + id,
        status,
        campaign: parent,
        ...(finalUrls ? {final_urls: finalUrls} : {}),
      });
      for (const [source, list] of [
        ['ADVERTISER', links],
        ['AUTOMATICALLY_CREATED', automatic],
      ])
        for (const [fieldType, assetId, linkStatus = 'ENABLED'] of list)
          google.row('asset_group_asset', {
            resource_name: at('assetGroupAssets', id + '~' + assetId + '~' + fieldType),
            asset_group: name,
            asset: at('assets', String(assetId)),
            field_type: fieldType,
            status: linkStatus,
            source,
          });
      return name;
    },
    close: () => store.close(),
  };
}
