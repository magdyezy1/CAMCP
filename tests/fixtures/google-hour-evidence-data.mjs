import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleEvidenceInput, googleEvidenceRow, googleEvidenceCustomer} from './google-evidence-data.mjs';

export const googleHourInput = {
  ...googleEvidenceInput,
  preset: 'google_campaign_hour',
  semantics: {...googleEvidenceInput.semantics, source_name: 'Synthetic Google hour evidence'},
};
export function googleHourRow(hour = 0, date = '2026-09-01', id = '9007199254740993') {
  const row = googleEvidenceRow('campaign', id);
  row.campaign.name = 'رمضان Home <img>';
  row.segments = {date, hour};
  row.private = 'PRIVATE-HOUR-NATIVE';
  return row;
}
export function googleHourRows() {
  return Array.from({length: 24}, (_, i) => {
    const row = googleHourRow(i);
    row.metrics = {
      costMicros: String(i * 1000000),
      clicks: String(i),
      impressions: String(i * 10),
      conversions: i / 10,
      conversionsValue: i,
    };
    return row;
  });
}
export function googleHourResponse(body, rows = googleHourRows()) {
  if (/ FROM customer(?: |$)/.test(body.query))
    return {results: [{customer: googleEvidenceCustomer(), private: 'PRIVATE-CUSTOMER'}], totalResultsCount: '1'};
  assert.match(body.query, / FROM campaign WHERE /);
  assert.ok(body.query.includes('segments.hour'));
  assert.ok(body.pageToken === undefined || body.pageToken === 'opaque-hour-next');
  return {
    results: body.pageToken ? rows.slice(4) : rows.slice(0, 4),
    totalResultsCount: String(rows.length),
    ...(!body.pageToken && rows.length > 4 ? {nextPageToken: 'opaque-hour-next'} : {}),
    private: 'PRIVATE-REPORT-PAGE',
  };
}
/** Fixed owned Search responses; no actual provider or write endpoint is callable. */
export function googleHourFixture(t, rows = googleHourRows()) {
  const owner = {tenantId: 'synthetic-google-hour', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 165).toString('base64')),
    connection = {
      id: googleHourInput.connection_id,
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google hour reader',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    credentials = {accessToken: 'synthetic-hour-secret'},
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
        return Response.json(edit(body, googleHourResponse(body, rows), requests.length));
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
    call: (input = googleHourInput) => service.call('amcp_reporting', input, actor),
    close: () => store.close(),
  };
}
