// A synthetic Google Ads account for reconciling lost builds, asset links and listing-group edits (package
// r25-m2-reconcile). It keeps its resources in tables, answers the GAQL reads the reviews and the lookups make through a
// minimal evaluator (SELECT a list of fields, FROM one resource, WHERE clauses of IN, = and != joined by AND, LIMIT;
// fields of the resource a row names, such as campaign.status in an ad group query, are joined), and applies the three
// kinds of write. A write may be applied and its response lost, or lost without being applied. Every value is invented;
// nothing leaves the process, and the review lifecycle is the real one.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

export const gateway = 'google_ads_native_action',
  account = '123',
  at = (collection, id) => 'customers/' + account + '/' + collection + '/' + id;
const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snakeKeys = v =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [snake(k), snakeKeys(x)]))
      : v;
/** The table a collection of resource names belongs to. */
const tableOf = {
  campaignBudgets: 'campaign_budget',
  campaigns: 'campaign',
  adGroups: 'ad_group',
  assetGroups: 'asset_group',
  assets: 'asset',
  campaignCriteria: 'campaign_criterion',
  adGroupCriteria: 'ad_group_criterion',
  adGroupAds: 'ad_group_ad',
  assetGroupAssets: 'asset_group_asset',
  campaignAssets: 'campaign_asset',
  assetGroupListingGroupFilters: 'asset_group_listing_group_filter',
};
const operationTable = {
  campaign_budget_operation: ['campaignBudgets', 'campaign_budget'],
  campaign_operation: ['campaigns', 'campaign'],
  campaign_criterion_operation: ['campaignCriteria', 'campaign_criterion'],
  ad_group_operation: ['adGroups', 'ad_group'],
  ad_group_criterion_operation: ['adGroupCriteria', 'ad_group_criterion'],
  ad_group_ad_operation: ['adGroupAds', 'ad_group_ad'],
  asset_operation: ['assets', 'asset'],
  asset_group_operation: ['assetGroups', 'asset_group'],
  asset_group_asset_operation: ['assetGroupAssets', 'asset_group_asset'],
  asset_group_signal_operation: ['assetGroupSignals', 'asset_group_signal'],
};
const resultKey = {
  campaign_budget_operation: 'campaignBudgetResult',
  campaign_operation: 'campaignResult',
  campaign_criterion_operation: 'campaignCriterionResult',
  ad_group_operation: 'adGroupResult',
  ad_group_criterion_operation: 'adGroupCriterionResult',
  ad_group_ad_operation: 'adGroupAdResult',
  asset_operation: 'assetResult',
  asset_group_operation: 'assetGroupResult',
  asset_group_asset_operation: 'assetGroupAssetResult',
  asset_group_signal_operation: 'assetGroupSignalResult',
};

export function googleReconcileFixture({tenant = 'google-reconcile', role = 'operator'} = {}) {
  const actor = {tenantId: tenant, userId: 'operator', role},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const db = Object.fromEntries(Object.values(tableOf).map(t => [t, []]));
  const requests = [],
    queries = [],
    writes = [],
    state = {next: 500, applied: undefined, lose: false};
  const row = (table, fields) => {
    const r = {resource_name: fields.resource_name, ...fields};
    db[table].push(r);
    return r;
  };
  const get = (object, path) =>
    path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), object);
  /** The row's selected fields as Google writes them: camelCase, nested; a container the row has stays even when empty. */
  function project(object, paths) {
    const out = {};
    for (const path of paths) {
      const keys = path.split('.');
      let from = object,
        to = out;
      for (const [i, key] of keys.entries()) {
        const has = from && typeof from === 'object' && Object.hasOwn(from, key);
        if (!has) break;
        from = from[key];
        if (i === keys.length - 1) to[camel(key)] = from;
        else {
          to[camel(key)] ??= {};
          to = to[camel(key)];
        }
      }
    }
    return out;
  }
  function search(query) {
    const m = /^\s*SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: LIMIT (\d+))?\s*$/is.exec(query);
    if (!m) throw new Error('Unexpected synthetic GAQL: ' + query);
    const [, select, entity, where, limit] = m,
      fields = select.split(',').map(s => s.trim());
    if (entity === 'customer') return [{customer: {id: account, currencyCode: 'USD', timeZone: 'UTC'}}];
    const clauses = (where ?? '')
      .split(/\s+AND\s+/i)
      .filter(Boolean)
      .map(c => {
        const x = /^(\S+)\s+(IN|=|!=)\s+(.+)$/s.exec(c.trim());
        if (!x) throw new Error('Unexpected synthetic GAQL clause: ' + c);
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
      // A field of another resource the row names (ad_group.campaign -> campaign.status).
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
      const {resource_name: temp, ...fields} = create;
      let name;
      if (collection === 'assetGroupAssets') {
        const [group] = String(resolve(fields.asset_group)).split('/').slice(-1);
        name = at(collection, [group, String(fields.asset).split('/').at(-1), fields.field_type].join('~'));
      } else if (collection === 'assetGroupListingGroupFilters') {
        const group = String(fields.asset_group).split('/').at(-1);
        name = at(collection, group + '~' + state.next++);
      } else name = at(collection, String(state.next++));
      if (temp) real.set(temp, name);
      const resolved = resolve(fields);
      if (state.applied !== false) {
        const existing = db[table].findIndex(r => r.resource_name === name);
        if (existing >= 0) db[table].splice(existing, 1);
        row(table, {resource_name: name, status: 'ENABLED', ...resolved});
      }
      return name;
    };
    if (kind === 'googleAds')
      return {
        mutateOperationResponses: body.mutate_operations.map(op => {
          const key = Object.keys(op)[0],
            [collection, table] = operationTable[key];
          return {[resultKey[key]]: {resourceName: make(collection, table, op[key].create)}};
        }),
      };
    const collection = kind;
    return {
      results: body.operations.map(op => {
        const table = tableOf[collection];
        if (op.remove) {
          if (state.applied !== false) {
            const i = db[table].findIndex(r => r.resource_name === op.remove);
            if (i >= 0) db[table].splice(i, 1);
          }
          return {resourceName: op.remove};
        }
        // An update changes the fields it names on the object the resource name gives; Google answers with that resource name.
        if (op.update) {
          const {resource_name: target, ...fields} = op.update;
          if (state.applied !== false) Object.assign(db[table].find(r => r.resource_name === target) ?? {}, fields);
          return {resourceName: target};
        }
        return {resourceName: make(collection, table, op.create)};
      }),
    };
  }
  const fetcher = async (raw, init = {}) => {
    const path = new URL(String(raw)).pathname,
      method = init.method ?? 'GET',
      body = init.body ? snakeKeys(JSON.parse(String(init.body))) : {};
    requests.push(method + ' ' + path);
    if (path.endsWith('/googleAds:search')) {
      queries.push(String(body.query));
      return Response.json({results: search(String(body.query))});
    }
    if (/:mutate$/.test(path)) {
      writes.push({path, body});
      const answer = apply(path, body);
      if (state.lose) throw new TypeError('synthetic lost response');
      return Response.json(answer);
    }
    throw new Error('Unexpected synthetic Google request ' + method + ' ' + path);
  };
  const transport = new NativeTransport(fetcher),
    service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    call = (tool, input, who = actor) => service.call(tool, input, who),
    prepare = (action, payload) =>
      call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: 'g',
        arguments: {action, account_id: account, payload},
      }),
    execute = id =>
      call('amcp_write', {action: 'execute', review_id: id, confirmed: true, spend_change_confirmed: true}),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {
    store,
    actor,
    db,
    row,
    requests,
    queries,
    writes,
    state,
    service,
    call,
    prepare,
    execute,
    worker,
    claim: key => store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key),
    /** Prepares a write and executes it with the response lost; `applied` says whether Google made it. */
    async lose(action, payload, {applied} = {}) {
      const prepared = await prepare(action, payload);
      if (!prepared.success) throw new Error('prepare failed: ' + JSON.stringify(prepared).slice(0, 800));
      state.applied = applied;
      state.lose = true;
      const refused = await execute(prepared.data.review_id);
      state.lose = false;
      state.applied = undefined;
      return {id: prepared.data.review_id, refused, review: prepared};
    },
    close: () => store.close(),
  };
}
