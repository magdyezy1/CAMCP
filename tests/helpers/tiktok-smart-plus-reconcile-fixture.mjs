// A synthetic TikTok advertiser for reconciling lost Upgraded Smart+ creates (R2.5 M4, package r25-m4-smartops), the Smart+ twin of
// tiktok-reconcile-fixture.mjs. Its Smart+ campaign and ad lists answer the creation filter the standard lists take
// (`creation_filter_start_time`, `creation_filter_end_time`, UTC, YYYY-MM-DD HH:MM:SS; the captured DESCRIBE_ACTION of
// tiktok_smart_plus_campaign_get and tiktok_smart_plus_ad_get lists both), and its Smart+ ad group list has none, as the captured
// tiktok_smart_plus_adgroup_get has none: a read that sends one is refused here (code 40002), so a lookup that relied on it fails.
// The lists filter by `campaign_ids`, `adgroup_ids` and `smart_plus_ad_ids`, follow `page` and `page_size`, and report `page_info`.
// A create may be applied and its answer lost (a thrown transport failure), or lost without being applied. Every value is invented;
// nothing leaves the process, and the review lifecycle is the real one.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {advertiserAnswer, advertiserWorld, answer} from './tiktok-advertiser-noise.mjs';

export const gateway = 'tiktok_native_action';
/** A time as TikTok writes it (UTC, no zone). */
export const stamp = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** The parent Smart+ campaign and ad group every child create is made under. */
export const parentCampaign = '80',
  parentAdgroup = '300';

/** One valid Smart+ create of each kind for advertiser `id`, all paused, under Smart+ campaign 80 and ad group 300. */
export const smartPlusBodies = id => ({
  campaign: {
    action: 'tiktok_smart_plus_campaign_create',
    payload: {
      advertiser_id: id,
      request_id: '810200300501',
      operation_status: 'DISABLE',
      objective_type: 'WEB_CONVERSIONS',
      sales_destination: 'WEBSITE',
      campaign_name: 'Synthetic Smart+ campaign',
      budget_optimize_on: true,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 50,
    },
  },
  adgroup: {
    action: 'tiktok_smart_plus_adgroup_create',
    payload: {
      advertiser_id: id,
      request_id: '810200300502',
      campaign_id: parentCampaign,
      operation_status: 'DISABLE',
      adgroup_name: 'Synthetic Smart+ ad group',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      bid_type: 'BID_TYPE_NO_BID',
      billing_event: 'CPC',
      targeting_optimization_mode: 'AUTOMATIC',
      targeting_spec: {location_ids: ['102358'], spc_audience_age: 'OVER_EIGHTEEN', languages: ['ar']},
      schedule_type: 'SCHEDULE_FROM_NOW',
      schedule_start_time: '2027-01-01 00:00:00',
    },
  },
  ad: {
    action: 'tiktok_smart_plus_ad_create',
    payload: {
      advertiser_id: id,
      adgroup_id: parentAdgroup,
      ad_name: 'Synthetic Smart+ ad',
      operation_status: 'DISABLE',
      creative_list: [
        {
          creative_info: {
            ad_format: 'SINGLE_VIDEO',
            tiktok_item_id: '9001',
            identity_type: 'TT_USER',
            identity_id: 'tt-1',
          },
        },
      ],
      landing_page_url_list: [{landing_page_url: 'https://shop.example.test/visit'}],
      ad_configuration: {
        call_to_action_id: '700',
        creative_auto_add_toggle: false,
        creative_auto_enhancement_strategy_list: [],
      },
    },
  },
});

const create = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/create\/$/,
  list = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/;
const idKey = {campaign: 'campaign_id', adgroup: 'adgroup_id', ad: 'smart_plus_ad_id'};

export function smartPlusReconcileFixture({tenant = 'tiktok-smart-plus-reconcile'} = {}) {
  const world = advertiserWorld({rotating: false}),
    actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 93).toString('base64')),
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
  const old = '2026-01-01 00:00:00',
    rows = {
      campaign: [
        {
          campaign_id: parentCampaign,
          campaign_name: 'Parent Smart+ campaign',
          objective_type: 'WEB_CONVERSIONS',
          sales_destination: 'WEBSITE',
          budget_optimize_on: true,
          budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
          budget: 500,
          operation_status: 'DISABLE',
          catalog_enabled: false,
          is_search_campaign: false,
          create_time: old,
        },
      ],
      adgroup: [
        {
          adgroup_id: parentAdgroup,
          campaign_id: parentCampaign,
          adgroup_name: 'Parent Smart+ ad group',
          promotion_type: 'WEBSITE',
          optimization_goal: 'CLICK',
          billing_event: 'CPC',
          bid_type: 'BID_TYPE_NO_BID',
          placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
          operation_status: 'DISABLE',
          create_time: old,
        },
      ],
      ad: [],
    };
  // Every request that reached the provider, as "METHOD /path"; the filtering of each list read; the provider writes.
  const requests = [],
    filters = [],
    sent = [],
    // `filterZoneMs` and `displayZoneMs`: the offsets from UTC of the zone the server applies the creation filter in and writes
    // `create_time` in (the standard fixture's; the zone of the Smart+ filters is unconfirmed, live check M4 LV-25). `pageSize`: the
    // page size the server really uses. `undated`: a created row carries no `create_time` (whether a Smart+ row carries one is LV-25).
    state = {
      next: 400,
      applied: undefined,
      lose: false,
      now: () => Date.now(),
      filterZoneMs: 0,
      displayZoneMs: 0,
      pageSize: undefined,
      undated: false,
    };
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace('/open_api', ''),
      method = init.method ?? 'GET',
      q = name => url.searchParams.get(name);
    requests.push(method + ' ' + path);
    if (method === 'POST') {
      const body = JSON.parse(init.body),
        kind = create.exec(path)?.[1];
      if (!kind) throw new Error('Unexpected synthetic TikTok write ' + path);
      sent.push({path, body});
      const id = String(state.next++),
        {advertiser_id: _a, request_id: _r, ...stored} = body,
        row = {
          ...stored,
          [idKey[kind]]: id,
          ...(kind === 'campaign' ? {catalog_enabled: false, is_search_campaign: false} : {}),
          ...(kind === 'adgroup'
            ? {
                targeting_spec: {brand_safety_type: 'STANDARD_INVENTORY', ...body.targeting_spec},
                placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
                placements: ['PLACEMENT_TIKTOK'],
              }
            : {}),
          ...(kind === 'ad'
            ? {
                campaign_id: rows.adgroup.find(g => g.adgroup_id === body.adgroup_id)?.campaign_id,
                creative_list: body.creative_list.map((c, i) => ({
                  ad_material_id: 'm' + i,
                  material_operation_status: 'ENABLE',
                  creative_info: c.creative_info,
                })),
                ad_configuration: {...body.ad_configuration, product_specific_type: 'UNSET'},
              }
            : {}),
          ...(state.undated ? {} : {create_time: stamp(state.now() + state.displayZoneMs)}),
          // The instant it was made (never shown): the filter compares it in the zone the server applies it in.
          _at: state.now(),
        };
      // The provider applied the create (unless a test says it did not) and the answer was lost.
      if (state.applied !== false) rows[kind].push(row);
      if (state.lose) throw new TypeError('synthetic lost response');
      return Response.json(answer({[idKey[kind]]: id}));
    }
    if (path === '/v1.3/advertiser/info/') return Response.json(answer({list: [advertiserAnswer(world, url)]}));
    if (path === '/v1.3/identity/info/')
      return Response.json(
        answer({
          identity_info: {
            identity_id: q('identity_id'),
            identity_type: q('identity_type'),
            display_name: 'Synthetic',
            available_status: 'AVAILABLE',
            can_pull_video: true,
            is_gpppa: false,
          },
        }),
      );
    if (path === '/v1.3/identity/video/info/')
      return Response.json(
        answer({
          video_details: JSON.parse(q('item_ids')).map(id => ({item_id: id, item_type: 'VIDEO', status: 'PUBLIC'})),
        }),
      );
    if (path === '/v1.3/creative/portfolio/get/')
      return Response.json(answer({portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]}));
    const kind = list.exec(path)?.[1];
    if (!kind) throw new Error('Unexpected synthetic TikTok request ' + method + ' ' + path);
    const filtering = JSON.parse(q('filtering') ?? '{}'),
      fields = q('fields') ? JSON.parse(q('fields')) : undefined;
    filters.push({kind, filtering, fields, page: Number(q('page') ?? 1)});
    // The Smart+ ad group list takes no creation filter (the captured tiktok_smart_plus_adgroup_get has none).
    if (kind === 'adgroup' && (filtering.creation_filter_start_time || filtering.creation_filter_end_time))
      return Response.json({code: 40002, message: 'Unsupported filter', request_id: 'synthetic-refusal', data: {}});
    const local = r =>
      stamp((r._at ?? Date.parse(String(r.create_time ?? r._created).replace(' ', 'T') + 'Z')) + state.filterZoneMs);
    const named = (ids, value) => !ids || ids.map(String).includes(String(value));
    const all = rows[kind]
      .filter(r => named(filtering.campaign_ids, r.campaign_id))
      .filter(r => named(filtering.adgroup_ids, r.adgroup_id))
      .filter(r => named(filtering.smart_plus_ad_ids, r.smart_plus_ad_id))
      .filter(r => !filtering.creation_filter_start_time || local(r) >= filtering.creation_filter_start_time)
      .filter(r => !filtering.creation_filter_end_time || local(r) <= filtering.creation_filter_end_time);
    const size = state.pageSize ?? Number(q('page_size') ?? 100),
      page = Number(q('page') ?? 1),
      shown = all
        .slice((page - 1) * size, page * size)
        .map(({_created, _at, ...r}) =>
          structuredClone(fields ? Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k))) : r),
        );
    return Response.json(
      answer({
        list: shown,
        page_info: {
          page,
          page_size: size,
          total_number: all.length,
          total_page: Math.max(1, Math.ceil(all.length / size)),
        },
      }),
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
      const body = smartPlusBodies(world.id)[kind];
      return call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: connection.id,
        arguments: {action: body.action, account_id: world.id, payload: edit(structuredClone(body.payload))},
      });
    },
    execute = (id, flags = {}) => call('amcp_write', {action: 'execute', review_id: id, confirmed: true, ...flags}),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (t, k, i) => overview.work(t, k, i),
    );
  return {
    store,
    actor,
    owner,
    connection,
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
    /** Prepares and executes a Smart+ create whose response is lost; `applied` says whether TikTok made the object. */
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
