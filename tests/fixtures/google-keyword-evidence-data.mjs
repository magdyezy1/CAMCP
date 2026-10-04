import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {googleEvidenceInput, googleEvidenceRow, googleEvidenceCustomer} from './google-evidence-data.mjs';

export const googleKeywordInput = {
  ...googleEvidenceInput,
  preset: 'google_keyword',
  semantics: {...googleEvidenceInput.semantics, source_name: 'Synthetic Google keyword evidence'},
};
export function googleKeywordRow(id = '9007199254740993', match = 'EXACT', date = '2026-09-01', group = '2') {
  const row = googleEvidenceRow('ad_group', group);
  row.campaign.advertisingChannelType = 'SEARCH';
  row.adGroupCriterion = {
    resourceName: `customers/123/adGroupCriteria/${group}~${id}`,
    criterionId: id,
    type: 'KEYWORD',
    negative: false,
    keyword: {text: 'رمضان Home <img>', matchType: match},
  };
  row.keywordView = {resourceName: `customers/123/keywordViews/${group}~${id}`};
  row.segments = {date};
  row.private = 'PRIVATE-KEYWORD-NATIVE';
  return row;
}
export function googleKeywordRows() {
  const rows = [
    googleKeywordRow(),
    googleKeywordRow('9007199254740994', 'PHRASE'),
    googleKeywordRow('9007199254740995', 'BROAD'),
    googleKeywordRow('9007199254740993', 'EXACT', '2026-09-02'),
  ];
  rows[1].metrics = {costMicros: '0', clicks: '0', impressions: '0', conversions: 0, conversionsValue: 0};
  rows[2].metrics = {costMicros: '1000000', clicks: '3', impressions: '30'};
  rows[3].metrics = {costMicros: '2000000', clicks: '4', impressions: '40', conversions: 1, conversionsValue: 10};
  delete rows[3].adGroupCriterion.negative; // Selected ProtoJSON false may be omitted.
  return rows;
}
export function googleKeywordResponse(body, rows = googleKeywordRows()) {
  if (/ FROM customer(?: |$)/.test(body.query))
    return {results: [{customer: googleEvidenceCustomer(), private: 'PRIVATE-CUSTOMER'}], totalResultsCount: '1'};
  assert.match(body.query, / FROM keyword_view WHERE /);
  assert.ok(body.pageToken === undefined || body.pageToken === 'opaque-keyword-next');
  return {
    results: body.pageToken ? rows.slice(2) : rows.slice(0, 2),
    totalResultsCount: String(rows.length),
    ...(!body.pageToken && rows.length > 2 ? {nextPageToken: 'opaque-keyword-next'} : {}),
    private: 'PRIVATE-REPORT-PAGE',
  };
}
/** Owned read-only native Search fixture; no actual provider or write endpoint is callable. */
export function googleKeywordFixture(t, rows = googleKeywordRows()) {
  const owner = {tenantId: 'synthetic-google-keyword', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 163).toString('base64')),
    connection = {
      id: googleKeywordInput.connection_id,
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google keyword reader',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    credentials = {accessToken: 'synthetic-keyword-secret'},
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
        assert.equal(init.method, 'POST'); // Exact documented Search POST is a read.
        requests.push({method: init.method, path: url.pathname, body});
        return Response.json(edit(body, googleKeywordResponse(body, rows), requests.length));
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
    call: (input = googleKeywordInput) => service.call('amcp_reporting', input, actor),
    close: () => store.close(),
  };
}
