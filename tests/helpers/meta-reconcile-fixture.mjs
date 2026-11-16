// A synthetic Meta ad account (123), its business (900) and the business's catalog (555) for reconciling lost creates (package
// r25-m2-reconcile). Its Graph lists answer what the documented ones do for these tests: `limit` and the `after` cursor with
// `paging.next` while rows remain, `fields` narrowing each row (so a lookup that forgets to ask for a creation time gets none),
// and `filtering` by name where Meta documents it (campaigns). A create may be applied and its response lost (a thrown
// transport failure), or lost without being applied. Every value is invented; nothing leaves the process, and the review
// lifecycle is the real one.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

export const gateway = 'meta_native_action';
export const account = '123';
export const business = '900';
export const catalog = '555';
/** A time as Meta writes `created_time` on an ad object. */
export const metaTime = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, '+0000');

const actions = {
  set: ['meta_product_catalog_id_product_sets_create', {product_catalog_id: catalog}, {name: 'Synthetic set'}],
  feed: [
    'meta_product_catalog_id_product_feeds_create',
    {product_catalog_id: catalog},
    {
      name: 'Synthetic feed',
      schedule: {url: 'https://feeds.example.com/products.csv', interval: 'DAILY', hour: 5, minute: 0},
      deletion_enabled: false,
    },
  ],
  catalog: ['meta_business_id_owned_product_catalogs_create', {business_id: business}, {name: 'Synthetic catalog'}],
  audience: [
    'meta_ad_account_id_customaudiences_create',
    undefined,
    {name: 'Synthetic audience', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY'},
  ],
  creative: [
    'meta_ad_account_id_adcreatives_create',
    undefined,
    {
      name: 'Synthetic creative',
      object_story_spec: {
        page_id: '8001',
        link_data: {link: 'https://example.com/', message: 'Synthetic', call_to_action: {type: 'LEARN_MORE'}},
      },
    },
  ],
  campaign: [
    'meta_campaign_create',
    undefined,
    {name: 'Synthetic campaign', status: 'PAUSED', is_adset_budget_sharing_enabled: false},
  ],
};
export const creates = actions;

export function metaReconcileFixture({tenant = 'meta-reconcile'} = {}) {
  const actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
    connection = {
      id: 'login',
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management', 'catalog_management'],
    };
  // No resource is remembered as the account's: the catalog, its sets and feeds are reached only through the families' own
  // tagged reads, as in the product catalog tests, so a lookup's list that is not tagged is refused.
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  // What each edge holds. A row is the object as Meta stores it; a list narrows it to the fields it was asked for.
  const old = '2026-01-01T08:00:00+0000',
    rows = {
      set: [
        {id: '7001', name: 'Shoes', filter: '{}', product_catalog: {id: catalog}},
        {id: '7002', name: 'Bags', filter: '{}', product_catalog: {id: catalog}},
      ],
      feed: [{id: '6001', name: 'Existing feed', schedule: {}, deletion_enabled: false}],
      catalog: [{id: catalog, name: 'Existing catalog', vertical: 'commerce', business: {id: business}}],
      audience: [{id: '4001', account_id: account, name: 'Existing audience', time_created: Date.parse(old) / 1000}],
      creative: [{id: '3001', name: 'Existing creative', status: 'ACTIVE'}],
      campaign: [{id: '2001', name: 'Existing campaign', created_time: old}],
    };
  // Every request that reached the provider, as "METHOD /path"; the writes that were sent, in order.
  const requests = [],
    sent = [],
    state = {next: 9000, applied: undefined, lose: false, now: () => Date.now(), limit: undefined};
  const narrow = (row, fields) =>
    fields ? Object.fromEntries(Object.entries(row).filter(([k]) => fields.includes(k))) : row;
  const page = (url, list) => {
    const asked = Number(url.searchParams.get('limit') ?? 25),
      limit = state.limit ?? asked,
      offset = Number(url.searchParams.get('after') ?? 0),
      fields = url.searchParams
        .get('fields')
        ?.split(',')
        .map(f => f.replace(/\{.*$/, ''));
    return Response.json({
      data: list.slice(offset, offset + limit).map(r => narrow(r, fields)),
      ...(offset + limit < list.length
        ? {
            paging: {
              cursors: {before: String(offset), after: String(offset + limit)},
              next: 'https://graph.facebook.com' + url.pathname + '?after=' + (offset + limit),
            },
          }
        : {}),
    });
  };
  const gone = () =>
    Response.json({error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, {status: 400});
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname,
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET') {
      if (path === '/v26.0/act_' + account)
        return Response.json({
          id: 'act_' + account,
          account_id: account,
          account_status: 1,
          currency: 'USD',
          business: {id: business},
          tos_accepted: {custom_audience_tos: 1},
        });
      if (path === '/v26.0/act_' + account + '/promote_pages') return Response.json({data: [{id: '8001'}]});
      if (path === '/v26.0/act_' + account + '/customaudiences') return page(url, rows.audience);
      if (path === '/v26.0/act_' + account + '/adcreatives') return page(url, rows.creative);
      if (path === '/v26.0/act_' + account + '/campaigns') {
        const filtering = JSON.parse(url.searchParams.get('filtering') ?? '[]'),
          name = filtering.find(f => f.field === 'name')?.value;
        return page(
          url,
          rows.campaign.filter(r => name === undefined || r.name === name),
        );
      }
      if (path === '/v26.0/' + business + '/owned_product_catalogs') return page(url, rows.catalog);
      if (path === '/v26.0/' + catalog + '/product_sets') return page(url, rows.set);
      if (path === '/v26.0/' + catalog + '/product_feeds') return page(url, rows.feed);
      if (path === '/v26.0/' + catalog + '/products') return Response.json({data: [{id: '1'}]});
      const node = /^\/v26\.0\/(\d+)$/.exec(path)?.[1],
        found = rows.catalog.find(c => c.id === node);
      return found ? Response.json(found) : gone();
    }
    const raw2 = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    const create = {
      ['/v26.0/' + catalog + '/product_sets']: [
        'set',
        {name: raw2.name, filter: raw2.filter ?? '{}', product_catalog: {id: catalog}},
      ],
      ['/v26.0/' + catalog + '/product_feeds']: ['feed', {name: raw2.name, deletion_enabled: false}],
      ['/v26.0/' + business + '/owned_product_catalogs']: [
        'catalog',
        {name: raw2.name, vertical: 'commerce', business: {id: business}},
      ],
      ['/v26.0/act_' + account + '/customaudiences']: [
        'audience',
        {account_id: account, name: raw2.name, time_created: Math.floor(state.now() / 1000)},
      ],
      ['/v26.0/act_' + account + '/adcreatives']: ['creative', {name: raw2.name, status: 'ACTIVE'}],
      ['/v26.0/act_' + account + '/campaigns']: ['campaign', {name: raw2.name, created_time: metaTime(state.now())}],
    }[path];
    if (!create) throw new Error('Unexpected synthetic Meta write ' + method + ' ' + path);
    sent.push({path, body: raw2});
    const id = String(state.next++);
    // The provider applied the create (unless a test says it did not) and the answer was lost.
    if (state.applied !== false) rows[create[0]].push({id, ...create[1]});
    if (state.lose) throw new TypeError('synthetic lost response');
    return Response.json({id});
  };
  const transport = new NativeTransport(fetcher),
    service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    call = (tool, input, who = actor) => service.call(tool, input, who),
    prepare = (kind, edit = payload => payload) => {
      const [action, params, payload] = actions[kind];
      return call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: connection.id,
        arguments: {
          action,
          account_id: account,
          ...(params ? {params} : {}),
          payload: edit(structuredClone(payload)),
        },
      });
    },
    execute = id => call('amcp_write', {action: 'execute', review_id: id, confirmed: true}),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {
    store,
    actor,
    rows,
    requests,
    sent,
    state,
    service,
    call,
    prepare,
    execute,
    worker,
    claim: key => store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key),
    /** Prepares and executes a create whose response is lost; `applied` says whether Meta made the object. */
    async lose(kind, {applied, edit} = {}) {
      const prepared = await prepare(kind, edit);
      if (!prepared.success) throw new Error('prepare failed: ' + JSON.stringify(prepared).slice(0, 700));
      state.applied = applied;
      state.lose = true;
      const refused = await execute(prepared.data.review_id);
      state.lose = false;
      state.applied = undefined;
      return {id: prepared.data.review_id, refused};
    },
    close: () => store.close(),
  };
}
