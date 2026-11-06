// All provider and Sheets responses are synthetic. No external account is used or mutated.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {googleEvidenceRow, googleEvidenceResponse} from './google-evidence-data.mjs';
import {
  snapchatEvidenceAccount,
  snapchatEvidenceCampaign,
  snapchatEvidenceEntity,
  snapchatEvidenceResponse,
} from './snapchat-evidence-data.mjs';

export const granularRange = {since: '2026-09-01', until: '2026-09-02'};
export function granularSource(platform, level = 'ad') {
  const ids = {google: 1, meta: 2, tiktok: 3, snapchat: 4, linkedin: 5, x: 6};
  return {
    platform,
    connection_id: 'aaaaaaaa-1111-4111-8111-' + String(ids[platform]).padStart(12, '0'),
    account_id: platform === 'snapchat' ? snapchatEvidenceAccount : platform === 'google' ? '123' : '100',
    level,
    objective: 'sales',
    ...(platform === 'snapchat' && level === 'adset' ? {campaign_id: snapchatEvidenceCampaign} : {}),
    report_options:
      platform === 'meta'
        ? {complete_window: true, result_action_type: 'purchase', attribution_windows: ['7d_click', '1d_view']}
        : platform === 'snapchat'
          ? {complete_window: true, swipe_up_attribution_window: '7_DAY', view_attribution_window: '1_DAY'}
          : {complete_window: true, attribution: 'unknown'},
  };
}
export function granularConfig(source = granularSource('meta'), grain = 'total') {
  return {
    name: 'Synthetic granular report',
    sources: [source],
    date_range: granularRange,
    grain,
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'reach', 'frequency', 'cpa'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  };
}
/** RPT-07: synthetic native parents of the detailed entities (TikTok, Snapchat ads, LinkedIn creatives). */
export const granularParents = {
  tiktok: {campaign: '9007199254740001', adgroup: '9007199254740002'},
  snapchat: {campaign: snapchatEvidenceCampaign, adsquad: '22222222-2222-4222-8222-000000000300'},
  linkedin: {group: '444', campaign: '555'},
};
const tiktokParent = (entity, id) =>
  entity === 'campaign'
    ? {advertiser_id: '100', campaign_id: id, campaign_name: 'Synthetic TikTok campaign'}
    : entity === 'adgroup'
      ? {
          advertiser_id: '100',
          adgroup_id: id,
          campaign_id: granularParents.tiktok.campaign,
          adgroup_name: 'Synthetic TikTok ad group',
        }
      : {
          advertiser_id: '100',
          ad_id: id,
          adgroup_id: granularParents.tiktok.adgroup,
          campaign_id: granularParents.tiktok.campaign,
        };
const snapchatParent = (kind, id) =>
  kind === 'ads'
    ? {id, ad_squad_id: granularParents.snapchat.adsquad, name: 'Synthetic ad'}
    : kind === 'adsquads'
      ? {id, campaign_id: granularParents.snapchat.campaign, name: 'Synthetic squad'}
      : {id, ad_account_id: snapchatEvidenceAccount, name: 'Synthetic parent'};
/**
 * `unpaced` removes the transport's sleeping between requests (its per-tenant burst is made unreachable), for a test that
 * sends over a thousand synthetic requests; everything else the transport does still happens.
 */
export function overviewGranularityFixture({unpaced = false} = {}) {
  const keyByte = 154,
    actor = {tenantId: 'local', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    requests = [],
    tabs = new Map([
      [
        7,
        {properties: {sheetId: 7, title: 'User original tab'}, developerMetadata: [], values: [['KEEP THIS ORIGINAL']]},
      ],
    ]);
  let hook = () => {},
    mutate = rows => rows,
    // RPT-07: replaces a parent read's response (platform, url, synthetic body) for refusal and drift cases.
    parentHook = (_platform, _url, body) => body,
    metadataId = 1;
  const parent = (platform, url, body) => {
    const out = parentHook(platform, url, body);
    return out instanceof Response ? out : Response.json(out);
  };
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET';
    requests.push({url, method, body: init?.body ? JSON.parse(String(init.body)) : null});
    const intercepted = await hook(url);
    if (intercepted instanceof Response) return intercepted;
    // RPT-07: Snapchat's documented by-ID reads are POST reads of the account's ads, ad squads and campaigns.
    const byIds = /^\/v1\/adaccounts\/([^/]+)\/get_(ads|adsquads|campaigns)_by_ids$/.exec(url.pathname);
    if (url.hostname === 'adsapi.snapchat.com' && method === 'POST' && byIds) {
      assert.equal(byIds[1], snapchatEvidenceAccount);
      const kind = byIds[2],
        singular = {ads: 'ad', adsquads: 'adsquad', campaigns: 'campaign'}[kind];
      return parent('snapchat', url, {
        request_status: 'SUCCESS',
        request_id: 'synthetic-parents',
        [kind]: JSON.parse(String(init.body)).entity_ids.map(({id}) => ({
          sub_request_status: 'SUCCESS',
          [singular]: snapchatParent(kind, id),
        })),
      });
    }
    if (url.hostname === 'sheets.googleapis.com') {
      if (method === 'GET')
        return Response.json({
          spreadsheetId: 'syntheticGranularSheet',
          properties: {title: 'Synthetic granular spreadsheet'},
          sheets: [...tabs.values()],
        });
      assert.equal(method, 'POST');
      const body = JSON.parse(String(init.body));
      assert.ok(url.pathname.endsWith('/syntheticGranularSheet:batchUpdate'));
      for (const r of body.requests) {
        if (r.addSheet)
          tabs.set(r.addSheet.properties.sheetId, {
            properties: r.addSheet.properties,
            developerMetadata: [],
            values: [],
          });
        if (r.createDeveloperMetadata) {
          const m = r.createDeveloperMetadata.developerMetadata;
          tabs.get(m.location.sheetId).developerMetadata.push({...m, metadataId: metadataId++});
        }
        if (r.updateDeveloperMetadata) {
          const id = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId;
          for (const tab of tabs.values())
            for (const m of tab.developerMetadata)
              if (m.metadataId === id) Object.assign(m, r.updateDeveloperMetadata.developerMetadata);
        }
        if (r.updateCells) {
          const tab = tabs.get(r.updateCells.range?.sheetId ?? r.updateCells.start?.sheetId);
          assert.notEqual(tab.properties.sheetId, 7);
          if (r.updateCells.rows)
            tab.values = r.updateCells.rows.map(row => row.values.map(cell => cell.userEnteredValue));
        }
      }
      return Response.json({spreadsheetId: 'syntheticGranularSheet', replies: body.requests.map(() => ({}))});
    }
    if (url.hostname === 'googleads.googleapis.com') {
      assert.equal(method, 'POST');
      assert.ok(url.pathname.endsWith('/googleAds:search'));
      const body = JSON.parse(String(init.body)),
        kind = /FROM (\w+)/.exec(body.query)[1],
        range = /segments.date BETWEEN '([^']+)' AND '([^']+)'/.exec(body.query);
      const rows = ['2026-09-01', '2026-09-02']
        .filter(day => !range || (day >= range[1] && day <= range[2]))
        .map(day => ({...googleEvidenceRow(kind), segments: {date: day}}));
      return Response.json(googleEvidenceResponse(body, mutate(rows, 'google')));
    }
    assert.equal(method, 'GET', 'Advertising fixtures refuse mutations');
    if (url.hostname === 'graph.facebook.com') {
      const metadataKind = /\/act_100\/(campaigns|adsets|ads)$/.exec(url.pathname)?.[1];
      if (metadataKind)
        return parent('meta', url, {
          data: [
            {
              id: {campaigns: '101', adsets: '201', ads: '9007199254740993'}[metadataKind],
              account_id: '100',
              status: 'ACTIVE',
              configured_status: 'ACTIVE',
              effective_status: 'ACTIVE',
            },
          ],
        });
      if (!url.pathname.endsWith('/insights'))
        return Response.json({
          id: 'act_100',
          account_id: '100',
          name: 'Synthetic Meta',
          currency: 'USD',
          timezone_name: 'UTC',
        });
      const range = JSON.parse(url.searchParams.get('time_range')),
        level = url.searchParams.get('level');
      const rows = ['2026-09-01', '2026-09-02']
        .filter(day => day >= range.since && day <= range.until)
        .map(day => ({
          account_id: '100',
          account_currency: 'USD',
          campaign_id: '101',
          campaign_name: '=UNTRUSTED()',
          ...(level !== 'campaign' ? {adset_id: '201', adset_name: 'Original group'} : {}),
          ...(level === 'ad' ? {ad_id: '9007199254740993', ad_name: '=UNTRUSTED AD()'} : {}),
          date_start: day,
          date_stop: day,
          spend: '0.100000001',
          impressions: '100',
          clicks: '10',
          reach: '80',
          frequency: '1.25',
          actions: [
            {action_type: 'purchase', value: '2'},
            {action_type: 'omni_purchase', value: '999'},
          ],
          action_values: [{action_type: 'purchase', value: '12.5'}],
        }));
      return Response.json({data: mutate(rows, 'meta')});
    }
    if (url.hostname === 'business-api.tiktok.com') {
      if (url.pathname.includes('/advertiser/info/'))
        return Response.json({
          code: 0,
          data: {list: [{advertiser_id: '100', currency: 'USD', timezone: 'UTC', name: 'Synthetic TikTok'}]},
        });
      const entity = /\/v1\.3\/(campaign|adgroup|ad)\/get\/$/.exec(url.pathname)?.[1];
      if (entity) {
        const filtering = JSON.parse(url.searchParams.get('filtering'));
        assert.equal(filtering.primary_status, 'STATUS_ALL');
        const list = filtering[entity + '_ids'].map(id => tiktokParent(entity, id));
        return parent('tiktok', url, {
          code: 0,
          message: 'OK',
          data: {
            list,
            page_info: {page: 1, page_size: 100, total_number: list.length, total_page: list.length ? 1 : 0},
          },
        });
      }
      assert.ok(url.pathname.includes('/report/integrated/get/'));
      const level = JSON.parse(url.searchParams.get('dimensions'))[0].replace(/_id$/, ''),
        since = url.searchParams.get('start_date'),
        until = url.searchParams.get('end_date');
      const rows = mutate(
        ['2026-09-01', '2026-09-02']
          .filter(day => day >= since && day <= until)
          .map(day => ({
            dimensions: {[level + '_id']: '9007199254740993', stat_time_day: day},
            metrics: {
              [level + '_name']: 'Original native entity',
              spend: '10.12',
              impressions: '100',
              clicks: '10',
              conversion: '2',
            },
          })),
        'tiktok',
      );
      return Response.json({
        code: 0,
        data: {
          list: rows,
          page_info: {
            page: Number(url.searchParams.get('page')),
            page_size: Number(url.searchParams.get('page_size')),
            total_number: rows.length,
            total_page: rows.length ? 1 : 0,
          },
        },
      });
    }
    if (url.hostname === 'api.linkedin.com') {
      if (url.pathname === '/rest/adAccounts/100')
        return Response.json({id: 100, name: 'Synthetic LinkedIn', currency: 'USD'});
      if (url.pathname === '/rest/adAccounts/100/creatives') {
        assert.equal(url.searchParams.get('q'), 'criteria');
        return parent('linkedin', url, {
          elements: [...url.searchParams.get('creatives').matchAll(/sponsoredCreative:(\d+)/g)].map(([, id]) => ({
            id: 'urn:li:sponsoredCreative:' + id,
            account: 'urn:li:sponsoredAccount:100',
            campaign: 'urn:li:sponsoredCampaign:' + granularParents.linkedin.campaign,
            name: 'Synthetic LinkedIn creative',
            intendedStatus: 'ACTIVE',
          })),
          metadata: {},
        });
      }
      if (url.pathname === '/rest/adAccounts/100/adCampaigns') {
        assert.equal(url.searchParams.get('q'), 'search');
        return parent('linkedin', url, {
          elements: [...url.searchParams.get('search').matchAll(/sponsoredCampaign:(\d+)/g)].map(([, id]) => ({
            id: Number(id),
            account: 'urn:li:sponsoredAccount:100',
            name: 'Synthetic LinkedIn campaign',
            objectiveType: 'WEBSITE_CONVERSION',
            campaignGroup: 'urn:li:sponsoredCampaignGroup:' + granularParents.linkedin.group,
          })),
          metadata: {},
        });
      }
      if (url.pathname === '/rest/adAccounts/100/adCampaignGroups') {
        assert.equal(url.searchParams.get('q'), 'search');
        return parent('linkedin', url, {
          elements: [...url.searchParams.get('search').matchAll(/sponsoredCampaignGroup:(\d+)/g)].map(([, id]) => ({
            id,
            account: 'urn:li:sponsoredAccount:100',
            name: 'Synthetic LinkedIn group',
            objectiveType: 'WEBSITE_CONVERSION',
          })),
          metadata: {},
        });
      }
      assert.equal(url.pathname, '/rest/adAnalytics');
      const match = /year:(\d+),month:(\d+),day:(\d+)/g,
        requested = [...url.searchParams.get('dateRange').matchAll(match)].map(
          m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
        );
      // The native source requests ALL at each position, with one exact period row rather than daily capture rows.
      assert.equal(url.searchParams.get('timeGranularity'), 'ALL');
      const days = ['2026-09-01', '2026-09-02'].filter(day => day >= requested[0] && day <= requested[1]).length,
        nativeDate = text => {
          const [year, month, day] = text.split('-').map(Number);
          return {year, month, day};
        },
        pivot = url.searchParams.get('pivot'),
        urn = {
          CAMPAIGN_GROUP: 'urn:li:sponsoredCampaignGroup:' + granularParents.linkedin.group,
          CAMPAIGN: 'urn:li:sponsoredCampaign:' + granularParents.linkedin.campaign,
          CREATIVE: 'urn:li:sponsoredCreative:9007199254740993',
        }[pivot],
        rows = days
          ? [
              {
                pivotValues: [urn],
                dateRange: {start: nativeDate(requested[0]), end: nativeDate(requested[1])},
                costInLocalCurrency: days === 2 ? '20.24' : '10.12',
                impressions: 100 * days,
                clicks: 10 * days,
                externalWebsiteConversions: 2 * days,
                conversionValueInLocalCurrency: days === 2 ? '25' : '12.5',
              },
            ]
          : [];
      return Response.json({elements: mutate(rows, 'linkedin')});
    }
    if (url.hostname === 'adsapi.snapchat.com') {
      const sem = {currency: 'USD', timezone: 'Asia/Riyadh', date_from: '2026-09-01', date_to: '2026-09-02'};
      const level = url.searchParams.get('breakdown');
      return parent(
        'snapchat',
        url,
        snapchatEvidenceResponse(
          url.href,
          level ? mutate([snapchatEvidenceEntity(level, undefined, sem)], 'snapchat') : undefined,
          sem,
        ),
      );
    }
    if (url.hostname === 'ads-api.x.com') {
      const campaigns = [{id: 'c1', name: 'Synthetic X campaign', entity_status: 'ACTIVE'}],
        lines = [
          {
            id: 'l1',
            campaign_id: 'c1',
            name: 'Synthetic X line item',
            objective: 'WEBSITE_CLICKS',
            entity_status: 'ACTIVE',
          },
        ],
        promoted = [
          // X documents no name for a promoted tweet (docs.x.com/x-ads-api/campaign-management, promoted_tweets).
          {
            id: 'p1',
            line_item_id: 'l1',
            tweet_id: '9007199254740993',
            entity_status: 'ACTIVE',
          },
        ],
        kind = url.pathname.split('/').at(-1);
      if (url.pathname === '/12/accounts/100')
        return Response.json({data: {id: '100', name: 'Synthetic X', currency: 'USD', timezone: 'UTC'}});
      if (['campaigns', 'line_items', 'promoted_tweets'].includes(kind))
        return Response.json({
          data: {campaigns, line_items: lines, promoted_tweets: promoted}[kind],
          next_cursor: null,
        });
      if (kind === 'active_entities')
        return Response.json({
          data: [
            {
              entity_id: {CAMPAIGN: 'c1', LINE_ITEM: 'l1', PROMOTED_TWEET: 'p1'}[url.searchParams.get('entity')],
              placements: ['ALL_ON_TWITTER'],
              activity_start_time: '2026-09-01T00:00:00Z',
              activity_end_time: '2026-09-03T00:00:00Z',
            },
          ],
        });
      assert.equal(url.pathname, '/12/stats/accounts/100');
      const query = Object.fromEntries(url.searchParams),
        hours = (Date.parse(query.end_time) - Date.parse(query.start_time)) / 3600000;
      assert(hours > 0 && hours <= 168 && Number.isInteger(hours));
      const ids = query.entity_ids.split(',');
      assert(ids.length > 0 && ids.length <= 20);
      return Response.json({
        time_series_length: hours,
        request: {
          params: {...query, account_id: '100', entity_ids: ids, metric_groups: query.metric_groups.split(',')},
        },
        data: ids.map(id => ({
          id,
          id_data: [
            {
              segment: null,
              metrics: {
                billed_charge_local_micro: Array(hours).fill('1000000'),
                impressions: Array(hours).fill('10'),
                clicks: Array(hours).fill('1'),
                url_clicks: Array(hours).fill('1'),
                engagements: Array(hours).fill('1'),
                video_total_views: Array(hours).fill('0'),
              },
            },
          ],
        })),
      });
    }
    throw Error('Synthetic granular fixture refuses egress: ' + url.hostname);
  };
  for (const [platform, gateway, scopes] of [
    ['google', 'google_ads_native_action', ['https://www.googleapis.com/auth/adwords']],
    ['meta', 'meta_native_action', ['ads_read']],
    ['tiktok', 'tiktok_native_action', ['advertiser.read', 'report.read']],
    ['linkedin', 'linkedin_native_action', ['r_ads', 'r_ads_reporting']],
    ['snapchat', 'snapchat_native_action', ['snapchat-marketing-api']],
    ['x', 'x_ads_native_action', []],
  ]) {
    const source = granularSource(platform);
    store.putConnection(
      actor,
      {
        id: source.connection_id,
        tenantId: actor.tenantId,
        gateway,
        accounts: [source.account_id],
        enabled: true,
        label: 'Synthetic ' + platform,
        scopes,
      },
      {
        accessToken: 'synthetic',
        developerToken: 'synthetic',
        ...(platform === 'x' ? {consumerKey: 'synthetic', consumerSecret: 'synthetic', tokenSecret: 'synthetic'} : {}),
      },
    );
    store.putDocument(actor.tenantId, 'website_assets', source.connection_id, {
      groups: [{kind: 'ad_accounts', assets: [{id: source.account_id, name: 'Synthetic ' + platform + ' account'}]}],
    });
  }
  store.putConnection(
    actor,
    {
      id: 'sheets-granular',
      tenantId: actor.tenantId,
      gateway: 'google_sheets_native_action',
      accounts: ['syntheticGranularSheet'],
      enabled: true,
      label: 'Synthetic Sheets login',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    },
    {accessToken: 'synthetic'},
  );
  const transport = unpaced
    ? new NativeTransport(fetcher, undefined, undefined, undefined, 1e9)
    : new NativeTransport(fetcher);
  const service = new MirrorService(new Registry(), store, transport, undefined, undefined, fetcher),
    overview = new ReportingOverview(service, fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  return {
    store,
    actor,
    keyByte,
    service,
    overview,
    worker,
    fetcher,
    requests,
    tabs,
    hook: value => {
      hook = value;
    },
    mutate: value => {
      mutate = value;
    },
    parents: value => {
      parentHook = value;
    },
    close: () => store.close(),
  };
}
