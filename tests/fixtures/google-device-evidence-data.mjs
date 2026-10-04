import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleEvidenceInput, googleEvidenceRow, googleEvidenceCustomer} from './google-evidence-data.mjs';

export const googleDeviceInput = {
  ...googleEvidenceInput,
  preset: 'google_campaign_device',
  semantics: {...googleEvidenceInput.semantics, source_name: 'Synthetic Google device evidence'},
};
export function googleDeviceRow(device = 'MOBILE', date = '2026-09-01', id = '9007199254740993') {
  const row = googleEvidenceRow('campaign', id);
  row.campaign.name = 'رمضان Home <img>';
  row.segments = {date, device};
  row.private = 'PRIVATE-DEVICE-NATIVE';
  return row;
}
export function googleDeviceRows() {
  const rows = ['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV', 'OTHER', 'UNKNOWN', 'UNSPECIFIED', 'MOBILE'].map(
    (device, i) => googleDeviceRow(device, i === 7 ? '2026-09-02' : '2026-09-01'),
  );
  for (const row of rows.slice(1))
    row.metrics = {costMicros: '0', clicks: '0', impressions: '0', conversions: 0, conversionsValue: 0};
  rows[2].metrics = {costMicros: '1000000', clicks: '3', impressions: '30'};
  rows[7].metrics = {costMicros: '2000000', clicks: '4', impressions: '40', conversions: 1, conversionsValue: 10};
  return rows;
}
export function googleDeviceResponse(body, rows = googleDeviceRows()) {
  if (/ FROM customer(?: |$)/.test(body.query))
    return {results: [{customer: googleEvidenceCustomer(), private: 'PRIVATE-CUSTOMER'}], totalResultsCount: '1'};
  assert.match(body.query, / FROM campaign WHERE /);
  assert.ok(body.query.includes('segments.device'));
  assert.ok(body.pageToken === undefined || body.pageToken === 'opaque-device-next');
  return {
    results: body.pageToken ? rows.slice(4) : rows.slice(0, 4),
    totalResultsCount: String(rows.length),
    ...(!body.pageToken && rows.length > 4 ? {nextPageToken: 'opaque-device-next'} : {}),
    private: 'PRIVATE-REPORT-PAGE',
  };
}
/** Fixed owned Search responses; no actual provider or write endpoint is callable. */
export function googleDeviceFixture(t, rows = googleDeviceRows()) {
  const owner = {tenantId: 'synthetic-google-device', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 165).toString('base64')),
    connection = {
      id: googleDeviceInput.connection_id,
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google device reader',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    credentials = {accessToken: 'synthetic-device-secret'},
    requests = [];
  store.putConnection(owner, connection, credentials);
  const key = store.createKey(owner),
    actor = store.authenticate(key);
  let edit = (_body, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (raw, init) => {
        const url = new URL(String(raw)),
          body = JSON.parse(String(init.body));
        assert.equal(url.origin, 'https://googleads.googleapis.com');
        assert.equal(url.pathname, '/v25/customers/123/googleAds:search');
        assert.equal(init.method, 'POST'); // Documented Search POST is a read.
        requests.push({method: init.method, path: url.pathname, body});
        return Response.json(edit(body, googleDeviceResponse(body, rows), requests.length));
      },
      async () => {},
    ),
    undefined,
    {allowWrites: false},
  );
  t?.after(() => store.close());
  return {
    owner,
    actor,
    store,
    key,
    connection,
    credentials,
    service,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (input = googleDeviceInput) => service.call('amcp_reporting', input, actor),
    close: () => store.close(),
  };
}
