// A synthetic TikTok advertiser for reconciling lost creates (package r25-m2-reconcile): its campaign, ad group and ad
// lists answer the documented creation filter (`creation_filter_start_time`, `creation_filter_end_time`, both UTC in the
// format YYYY-MM-DD HH:MM:SS) and the parent filters (`campaign_ids`, `adgroup_ids`, the object IDs), narrow their rows to
// `fields`, and report `page_info`. A create may be applied and its response lost (a thrown transport failure), or lost
// without being applied. Every value is invented; nothing leaves the process, and the review lifecycle is the real one.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {advertiserAnswer, advertiserWorld, answer} from './tiktok-advertiser-noise.mjs';
import {standardBodies} from './tiktok-standard-creates.mjs';

export const gateway = 'tiktok_native_action';
/** A time as TikTok writes it (UTC, no zone). */
export const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const idKey = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'ad_id'};
const nameKey = {campaign: 'campaign_name', adgroup: 'adgroup_name', ad: 'ad_name'};

export function tiktokReconcileFixture({tenant = 'tiktok-reconcile'} = {}) {
  const world = advertiserWorld({rotating: false}),
    actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
    connection = {
      id: 'login',
      tenantId: tenant,
      gateway,
      accounts: [world.id],
      writeAccounts: [world.id],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    };
  store.putConnection(owner, connection, {accessToken: 'synthetic'});
  for (const id of ['300', '200']) store.rememberResource(connection, world.id, id);
  const old = '2026-01-01 00:00:00',
    rows = {
      campaign: [
        {
          campaign_id: '300',
          advertiser_id: world.id,
          campaign_name: 'Parent campaign',
          operation_status: 'DISABLE',
          create_time: old,
        },
      ],
      adgroup: [
        {
          adgroup_id: '200',
          campaign_id: '300',
          advertiser_id: world.id,
          adgroup_name: 'Parent ad group',
          operation_status: 'DISABLE',
          create_time: old,
        },
      ],
      ad: [],
    };
  // Every request that reached the provider, as "METHOD /path", and the filtering of each list read.
  const requests = [],
    filters = [],
    sent = [],
    state = {next: 400, applied: undefined, lose: false, throttle: undefined, now: () => Date.now()};
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace('/open_api', ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'POST') {
      const body = JSON.parse(init.body),
        kind = /^\/v1\.3\/(campaign|adgroup|ad)\/create\/$/.exec(path)?.[1];
      if (!kind) throw new Error('Unexpected synthetic TikTok write ' + path);
      sent.push({path, body});
      // TikTok's rate limiter answers in the body of an HTTP 200 and creates nothing (a code of its throttle set).
      if (state.throttle)
        return Response.json({
          code: state.throttle,
          message: 'Too many requests',
          data: {},
          request_id: 'synthetic-throttle',
        });
      const id = String(state.next++),
        creative = body.creatives?.[0] ?? {},
        row = {
          [idKey[kind]]: id,
          advertiser_id: world.id,
          [nameKey[kind]]: kind === 'ad' ? creative.ad_name : body[nameKey[kind]],
          ...(kind === 'adgroup' ? {campaign_id: body.campaign_id} : {}),
          ...(kind === 'ad' ? {adgroup_id: body.adgroup_id} : {}),
          operation_status: 'DISABLE',
          create_time: stamp(state.now()),
        };
      // The provider applied the create (unless a test says it did not) and the answer was lost.
      if (state.applied !== false) rows[kind].push(row);
      if (state.lose) throw new TypeError('synthetic lost response');
      return Response.json(answer(kind === 'ad' ? {ad_ids: [id]} : {[idKey[kind]]: id}));
    }
    if (path === '/v1.3/advertiser/info/') return Response.json(answer({list: [advertiserAnswer(world, url)]}));
    const kind = /^\/v1\.3\/(campaign|adgroup|ad)\/get\/$/.exec(path)?.[1];
    if (!kind) throw new Error('Unexpected synthetic TikTok request ' + method + ' ' + path);
    const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
      fields = url.searchParams.get('fields') ? JSON.parse(url.searchParams.get('fields')) : undefined;
    filters.push({kind, filtering, fields});
    const list = rows[kind]
      .filter(r => !filtering[kind + '_ids'] || filtering[kind + '_ids'].includes(r[idKey[kind]]))
      .filter(r => !filtering.campaign_ids || filtering.campaign_ids.includes(r.campaign_id) || kind === 'campaign')
      .filter(r => !filtering.adgroup_ids || filtering.adgroup_ids.includes(r.adgroup_id))
      // The window is applied to TikTok's own record of the creation time (`_created` when the row's answer shows none).
      .filter(
        r =>
          !filtering.creation_filter_start_time ||
          (r.create_time ?? r._created) >= filtering.creation_filter_start_time,
      )
      .filter(
        r => !filtering.creation_filter_end_time || (r.create_time ?? r._created) <= filtering.creation_filter_end_time,
      )
      .map(({_created, ...r}) =>
        fields ? Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))) : r,
      );
    return Response.json(
      answer({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}}),
    );
  };
  const transport = new NativeTransport(fetcher),
    service = new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    call = (tool, input, who = actor) => service.call(tool, input, who),
    prepare = (kind, edit = payload => payload) => {
      const body = standardBodies(world.id)[kind];
      return call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: connection.id,
        arguments: {action: body.action, account_id: world.id, payload: edit(structuredClone(body.payload))},
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
    world,
    rows,
    requests,
    filters,
    sent,
    state,
    service,
    call,
    prepare,
    execute,
    worker,
    claim: key => store.db.prepare('SELECT state FROM idempotency WHERE tenant_id=? AND key=?').get(tenant, key),
    /** Prepares and executes a create whose response is lost; `applied` says whether TikTok made the object. */
    async lose(kind, {applied, edit} = {}) {
      const prepared = await prepare(kind, edit);
      if (!prepared.success) throw new Error('prepare failed: ' + JSON.stringify(prepared).slice(0, 500));
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
