import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleEvidenceInput, googleEvidenceRow, googleEvidenceCustomer} from './google-evidence-data.mjs';

const types = {UNSPECIFIED: 0, UNKNOWN: 1, AREA_OF_INTEREST: 2, LOCATION_OF_PRESENCE: 3};
export const googleCountryInput = {
  ...googleEvidenceInput,
  preset: 'google_campaign_country',
  semantics: {...googleEvidenceInput.semantics, source_name: 'Synthetic Google country evidence'},
};
export function googleCountryRow(
  country = '2222',
  location = 'LOCATION_OF_PRESENCE',
  date = '2026-09-01',
  campaign = '9007199254740993',
) {
  const row = googleEvidenceRow('campaign', campaign);
  row.campaign.name = 'Country العربية <img>';
  row.segments = {date};
  row.geographicView = {
    resourceName: `customers/123/geographicViews/${country}~${types[location]}`,
    countryCriterionId: country,
    locationType: location,
    private: 'PRIVATE-GEOGRAPHIC-FIELD',
  };
  row.private = 'PRIVATE-COUNTRY-ROW';
  return row;
}
export const googleCountryRows = () =>
  ['2026-09-01', '2026-09-02'].flatMap(date =>
    Object.keys(types).map((type, i) =>
      googleCountryRow(i === 0 ? '0' : i === 1 ? '9007199254740993' : '2222', type, date),
    ),
  );
export function googleCountryResponse(body, rows = googleCountryRows()) {
  if (/ FROM customer(?: |$)/.test(body.query))
    return {results: [{customer: googleEvidenceCustomer(), private: 'PRIVATE-CUSTOMER'}], totalResultsCount: '1'};
  assert.match(body.query, / FROM geographic_view WHERE /);
  assert.ok(body.query.includes('geographic_view.country_criterion_id'));
  assert.ok(body.query.includes('geographic_view.location_type'));
  assert.ok(body.pageToken === undefined || body.pageToken === 'opaque-country-next');
  return {
    results: body.pageToken ? rows.slice(4) : rows.slice(0, 4),
    totalResultsCount: String(rows.length),
    ...(!body.pageToken && rows.length > 4 ? {nextPageToken: 'opaque-country-next'} : {}),
    private: 'PRIVATE-REPORT-PAGE',
  };
}
/** Only exact owned read-only Search responses are available to this synthetic transport. */
export function googleCountryFixture(t, rows = googleCountryRows()) {
  const owner = {tenantId: 'synthetic-google-country', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 186).toString('base64')),
    connection = {
      id: googleCountryInput.connection_id,
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google country reader',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    credentials = {accessToken: 'synthetic-country-secret'},
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
        assert.equal(init.method, 'POST');
        requests.push({method: init.method, path: url.pathname, body});
        return Response.json(edit(body, googleCountryResponse(body, rows), requests.length));
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
    call: (input = googleCountryInput) => service.call('amcp_reporting', input, actor),
    close: () => store.close(),
  };
}
