// MSR-03: the measurement evidence ledger as the rendered browser qualification runs it. A synthetic Snapchat ad account
// (one pixel with domain stats and signal readiness) and a synthetic TikTok advertiser (two pixels: one whose statistics
// come back with fields AMCP does not interpret, one whose answer names another pixel) answer read-only routes; every
// other request and every mutation is refused. No external account is used or mutated. The TikTok statistics read is
// sent only under a pinned SDK specification, so the fixture installs the synthetic pin while it runs (the state after
// the owner pins the real file) and removes it on close.
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {setTiktokEventStatsPinForTest} from '../../dist/src/measurement-ledger-tiktok.js';
import {syntheticTiktokEventStatsPin} from './tiktok-event-stats-pin-data.mjs';

export const ledgerSnapAccount = '8f1c4a52-0b6e-4d1f-9a27-3c5d7e9f1a20',
  ledgerSnapPixel = '2b7c9d14-5e3f-4a81-b6c2-9d0e1f2a3b4c',
  ledgerTiktokAccount = '7000000000000000001',
  ledgerTiktokPixels = ['7100000000000000001', '7100000000000000002'];
const tiktokPixel = id => ({
  pixel_id: id,
  pixel_name: 'Store pixel ' + id.slice(-1),
  pixel_code: 'CABCDEF' + id.slice(-4),
  asset_ownership: {ownership_status: true, asset_relation_status: 'OWNER_BC'},
});
/** TikTok's statistics `data` has no documented fields; this synthetic shape is only something to show literally. */
export const ledgerTiktokStats = {
  stats: [
    {
      pixel_id: ledgerTiktokPixels[0],
      events: [
        {name: 'CompletePayment', count: 3},
        {name: 'ViewContent', count: 41},
      ],
    },
  ],
};

export function measurementLedgerFixture() {
  const keyByte = 193,
    actor = {tenantId: 'synthetic-measurement-ledger', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    requests = [];
  let writes = 0;
  const refuse = () => {
    writes++;
    throw Error('The measurement ledger fixture refuses mutations and other routes');
  };
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    if (method !== 'GET') return refuse();
    requests.push({method, origin: url.origin, path: url.pathname});
    if (url.origin === 'https://adsapi.snapchat.com') {
      if (url.pathname === '/v1/adaccounts/' + ledgerSnapAccount + '/pixels')
        return Response.json({
          request_status: 'SUCCESS',
          request_id: 'r0',
          pixels: [
            {
              sub_request_status: 'SUCCESS',
              pixel: {
                id: ledgerSnapPixel,
                name: 'Store pixel',
                ad_account_id: ledgerSnapAccount,
                status: 'ACTIVE',
                effective_status: 'ACTIVE',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
              },
            },
          ],
        });
      if (url.pathname === '/v1/pixels/' + ledgerSnapPixel + '/domains/stats')
        return Response.json({
          request_status: 'SUCCESS',
          request_id: 'r1',
          timeseries_stats: [
            {
              sub_request_status: 'SUCCESS',
              timeseries_stat: {
                id: ledgerSnapPixel,
                type: 'PIXEL',
                start_time: '2026-10-05T00:00:00.000-07:00',
                end_time: '2026-10-12T00:00:00.000-07:00',
                domains: [
                  {domain_name: 'shop.example.test', total_events: 120},
                  {domain_name: 'blog.example.test', total_events: 7},
                ],
              },
            },
          ],
        });
      if (url.pathname === '/v1/pixels/' + ledgerSnapPixel + '/event_quality_scores')
        return Response.json({
          request_status: 'SUCCESS',
          request_id: 'r2',
          event_quality_scores: [
            {
              sub_request_status: 'SUCCESS',
              event_quality_score: {
                action_source: 'WEB',
                event_source: 'API',
                event_type: 'PURCHASE',
                recommendations: [{recommendation_code: 'PII_COVERAGE_CAPI', priority: 'P0', score: 'BAD'}],
              },
            },
          ],
        });
      return refuse();
    }
    if (
      url.origin === 'https://business-api.tiktok.com' &&
      url.searchParams.get('advertiser_id') === ledgerTiktokAccount
    ) {
      if (url.pathname === '/open_api/v1.3/pixel/list/')
        return Response.json({
          code: 0,
          message: 'OK',
          request_id: 'synthetic-list',
          data: {
            pixels: ledgerTiktokPixels.map(tiktokPixel),
            page_info: {page: 1, page_size: 20, total_number: ledgerTiktokPixels.length, total_page: 1},
          },
        });
      if (url.pathname === '/open_api/v1.3/pixel/event/stats/') {
        const [pixel] = JSON.parse(url.searchParams.get('pixel_ids'));
        // The second pixel's answer names the first: statistics of another pixel are refused, never shown.
        return Response.json({
          code: 0,
          message: 'OK',
          request_id: 'synthetic-stats',
          data: pixel === ledgerTiktokPixels[0] ? ledgerTiktokStats : {pixel_id: ledgerTiktokPixels[0], total: 9},
        });
      }
    }
    return refuse();
  };
  for (const [id, gateway, account, scopes] of [
    ['bbbbbbbb-5555-4555-8555-000000000001', 'snapchat_native_action', ledgerSnapAccount, ['snapchat-marketing-api']],
    ['bbbbbbbb-5555-4555-8555-000000000002', 'tiktok_native_action', ledgerTiktokAccount, []],
  ])
    store.putConnection(
      actor,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes,
      },
      {accessToken: 'synthetic-measurement-ledger'},
    );
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher), undefined, {
    allowWrites: false,
  });
  setTiktokEventStatsPinForTest(syntheticTiktokEventStatsPin);
  return {
    keyByte,
    actor,
    store,
    service,
    requests,
    writes: () => writes,
    close: () => {
      setTiktokEventStatsPinForTest(undefined);
      store.close();
    },
  };
}
