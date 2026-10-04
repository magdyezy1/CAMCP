import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {createHash} from 'node:crypto';

export const calibrationNow = Date.UTC(2026, 9, 4, 12);
export const calibrationIds = ['9007199254740993', '9007199254740995'];
export function calibrationReport(days = 14) {
  const end = Date.UTC(2026, 9, 3),
    start = end - (days - 1) * 86400000;
  const rows = calibrationIds.flatMap((entity_id, index) =>
    Array.from({length: days}, (_, offset) => ({
      entity_id,
      entity_name: index ? 'Original العربية <second>' : 'Original <first>',
      date: new Date(start + offset * 86400000).toISOString().slice(0, 10),
      spend: index ? '20' : '10',
      conversions: index ? '4' : '2',
    })),
  );
  return {
    id: 'calibration-report',
    gateway: 'meta_native_action',
    account_id: '100',
    connection_id: '13200000-0000-4000-8000-000000000001',
    source: 'provider_read',
    preset: 'meta_campaign',
    grain: 'campaign × day',
    captured_at: calibrationNow,
    source_hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: rows[0].date,
      date_to: '2026-10-03',
      attribution: '7-day click; impression-time reporting',
      conversion_definition: 'Pixel purchase',
      complete: true,
    },
    mapping: {entity_id: '/campaign_id', date: '/date_start', spend: '/spend', conversions: '/actions/value'},
    rows,
    privateFixtureCanary: 'PRIVATE-CALIBRATION-ROW-BODY',
    source_request: {action: 'meta_ad_account_id_insights_get', privateFixtureCanary: 'PRIVATE-CALIBRATION-REQUEST'},
  };
}
export function allocationCalibrationFixture(t, value = calibrationReport()) {
  const store = new Store(':memory:', Buffer.alloc(32, 132).toString('base64')),
    owner = {tenantId: 'synthetic-allocation-calibration', userId: 'reader', role: 'reader'},
    key = store.createKey(owner),
    actor = store.authenticate(key);
  const connection = {
    id: value.connection_id,
    tenantId: actor.tenantId,
    gateway: value.gateway,
    accounts: [value.account_id],
    writeAccounts: [],
    enabled: true,
    label: 'Synthetic calibration',
    scopes: ['ads_read'],
  };
  store.putConnection({...owner, role: 'admin'}, connection, {accessToken: 'synthetic'});
  store.putDocument(actor.tenantId, 'decision_report', value.id, value);
  let nativeCalls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      nativeCalls++;
      throw Error('Calibration cannot contact any provider');
    }),
    undefined,
    {allowWrites: false},
  );
  t.after(() => store.close());
  const input = {
    action: 'calibrate_allocation',
    id: value.id,
    ids: calibrationIds,
    options: {training_days: 7, minimum_training_conversions: 10, maximum_age_days: 7, central_share_percent: 80},
  };
  return {
    store,
    actor,
    key,
    connection,
    service,
    input,
    nativeCalls: () => nativeCalls,
    call: input => service.call('amcp_reporting', input, actor),
  };
}
