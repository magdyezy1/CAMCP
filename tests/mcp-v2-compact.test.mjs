// V2-MCP-06, decision 4: under the v2 contract profile an MCP list read of a native gateway is compact by default (`compact:false`
// opts out), and `result_fields` and `max_items` work on every paging gateway, Google Ads included. Before, a Google Ads row,
// which holds its resources side by side (`campaign` and `metrics`), was taken for a wrapper because `campaign` is the name of a
// container in other gateways, so `result_fields` kept the wrong fields; and a list under another name (DV360's `lineItems`)
// was taken for a record, so `result_fields` dropped every row. v2 finds the rows by the shape of the response. Legacy keeps the
// old behaviour exactly, and so does everything a workflow reads for the person.
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectResponse} from '../dist/src/projection.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {withContractProfile} from '../dist/src/contract-profile.js';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {v2Changes} from '../dist/src/mcp-profile-help.js';
import {v2ReadOnlyGateways} from '../dist/src/tool-annotations.js';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';
import {googleDeviceFixture, googleDeviceInput, googleDeviceRows} from './fixtures/google-device-evidence-data.mjs';

const structural = {shape: 'structural'};
const project = (data, controls, gateway, shape = true) =>
  projectResponse(data, {...controls, ...(shape ? structural : {})}, gateway);

// Each paging gateway's own list shape, with a row that has a null, an empty string and an empty object to compact.
const shapes = {
  google_ads_native_action: {
    list: {
      results: Array.from({length: 5}, (_, i) => ({
        campaign: {id: String(100 + i), name: 'Campaign ' + i, status: 'PAUSED', labels: null},
        metrics: {clicks: String(i), impressions: String(i * 10)},
        segments: {},
      })),
      nextPageToken: 'next',
      fieldMask: 'campaign.id',
    },
    fields: ['campaign.id', 'metrics.clicks'],
    row: i => ({campaign: {id: String(100 + i)}, metrics: {clicks: String(i)}}),
    rows: out => out.results,
  },
  meta_native_action: {
    list: {
      data: Array.from({length: 5}, (_, i) => ({
        id: String(200 + i),
        name: 'Campaign ' + i,
        creative: {id: 'c' + i, title: ''},
        note: null,
      })),
      paging: {cursors: {after: 'a'}, next: 'https://graph.example/next'},
    },
    fields: ['id', 'creative.id'],
    row: i => ({id: String(200 + i), creative: {id: 'c' + i}}),
    rows: out => out.data,
  },
  tiktok_native_action: {
    list: {
      code: 0,
      message: 'OK',
      data: {
        list: Array.from({length: 5}, (_, i) => ({campaign_id: String(300 + i), campaign_name: 'C' + i, note: null})),
        page_info: {page: 1, page_size: 5, total_page: 3},
      },
    },
    fields: ['campaign_id'],
    row: i => ({campaign_id: String(300 + i)}),
    rows: out => out.data.list,
  },
  linkedin_native_action: {
    list: {
      elements: Array.from({length: 5}, (_, i) => ({id: 400 + i, name: 'C' + i, type: 'SPONSORED', extra: ''})),
      paging: {start: 0, count: 5, total: 12},
    },
    fields: ['id', 'name'],
    row: i => ({id: 400 + i, name: 'C' + i}),
    rows: out => out.elements,
  },
  x_ads_native_action: {
    list: {data: Array.from({length: 5}, (_, i) => ({id: 'x' + i, name: 'C' + i, note: null})), next_cursor: 'cursor'},
    fields: ['id'],
    row: i => ({id: 'x' + i}),
    rows: out => out.data,
  },
  dv360_native_action: {
    list: {
      lineItems: Array.from({length: 5}, (_, i) => ({
        lineItemId: String(500 + i),
        displayName: 'L' + i,
        entityStatus: 'ACTIVE',
        note: null,
      })),
      nextPageToken: 'token',
    },
    fields: ['lineItemId'],
    row: i => ({lineItemId: String(500 + i)}),
    rows: out => out.lineItems,
  },
  snapchat_native_action: {
    list: {
      request_status: 'SUCCESS',
      campaigns: Array.from({length: 5}, (_, i) => ({
        sub_request_status: 'SUCCESS',
        campaign: {id: 's' + i, name: 'C' + i, note: null},
      })),
      paging: {next_link: 'https://snap.example/next'},
    },
    fields: ['id'],
    row: i => ({sub_request_status: 'SUCCESS', campaign: {id: 's' + i}}),
    rows: out => out.campaigns,
  },
};

for (const [gateway, shape] of Object.entries(shapes))
  test(`${gateway}: result_fields, max_items and compact work on its list under the structural shape`, () => {
    const {data, truncated} = project(shape.list, {fields: shape.fields, maxItems: 3}, gateway);
    assert.equal(truncated, true);
    assert.deepEqual(shape.rows(data), [0, 1, 2].map(shape.row));
    // The paging and status around the rows are kept, as metadata is.
    const keep = Object.keys(shape.list).filter(key =>
      /next|paging|page|code|message|request_status|fieldMask/.test(key),
    );
    for (const key of keep.filter(key => key !== 'fieldMask')) assert.deepEqual(data[key], shape.list[key], key);
    // Without a field list, compact (for lists) leaves out what is null, empty or an empty object, in rows only.
    const compact = project(shape.list, {compact: 'lists'}, gateway).data;
    for (const row of shape.rows(compact)) assert.ok(!JSON.stringify(row).match(/null|""|\{\}/), JSON.stringify(row));
    assert.equal(shape.rows(compact).length, 5, 'compact drops no row');
    // compact:false keeps them; max_items alone cuts the rows and says so.
    const kept = project(shape.list, {compact: false, maxItems: 2}, gateway);
    assert.equal(shape.rows(kept.data).length, 2);
    assert.equal(kept.truncated, true);
  });

test('the shapes that were broken: before, a Google Ads row kept the wrong fields and a DV360 list lost every row', () => {
  const google = shapes.google_ads_native_action,
    dv = shapes.dv360_native_action;
  // Without the shape (legacy), `campaign` makes the row a wrapper and the fields are looked for inside it: only the metadata
  // key that happens to match (`status`) survives of the campaign, and the metrics are not projected.
  const old = projectResponse(google.list, {fields: google.fields}, 'google_ads_native_action').data.results[0];
  assert.deepEqual(old.campaign, {status: 'PAUSED'});
  assert.equal(old.metrics.impressions, '0');
  // A list under a name the base set does not know is a record to the old rule, and a field list drops its rows.
  const lost = projectResponse(dv.list, {fields: dv.fields}, 'dv360_native_action').data;
  assert.equal(lost.lineItems, undefined);
  assert.equal(lost.nextPageToken, 'token');
});

test('a single record is projected as a record under the structural shape, even one that has lists of its own', () => {
  const record = {id: '1', name: 'Campaign', status: 'ACTIVE', labels: [{id: 'l1', name: 'one'}], note: null};
  assert.deepEqual(project(record, {fields: ['name']}).data.name, 'Campaign');
  assert.equal(project(record, {fields: ['name']}).data.labels, undefined);
  // compact for lists leaves a record whole, a plain compact:true compacts it.
  assert.equal(project(record, {compact: 'lists'}).data.note, null);
  assert.equal(project(record, {compact: true}).data.note, undefined);
  // The identity of a Meta record with a creative of its own does not make the record an envelope.
  const ad = {id: 'a1', name: 'Ad', creative: {id: 'c1', name: 'Creative'}};
  assert.deepEqual(project(ad, {fields: ['id']}).data.id, 'a1');
});

test('the shape changes nothing without the flag: the controls of legacy are what they were', () => {
  for (const [gateway, shape] of Object.entries(shapes)) {
    const withFlag = project(shape.list, {maxItems: 3}, gateway).data,
      without = projectResponse(shape.list, {maxItems: 3}, gateway).data;
    assert.deepEqual(without, withFlag, gateway + ' with only max_items there is nothing to find by shape');
  }
  // compact:true is a boolean as it was, and applies to every response.
  assert.equal(projectResponse({id: 1, note: null}, {compact: true}).data.note, undefined);
});

// ---- the service: what a v2 call is given, and what a legacy call is given ----

const rows = n =>
  Array.from({length: n}, (_, i) => ({
    campaign: {id: String(1000 + i), name: 'Campaign ' + i, status: 'PAUSED', note: null},
    metrics: {clicks: String(i), impressions: String(i * 10), costMicros: '0'},
  }));
const provider = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname.includes('googleads'))
    return Response.json({results: rows(12), nextPageToken: 'tok2', fieldMask: 'campaign.id'});
  return Response.json({});
};
const search = extra => ({
  action: 'google_ads_v23_google_ads_search',
  account_id: '1001',
  dry_run: false,
  payload: {query: 'SELECT campaign.id, campaign.name FROM campaign', pageSize: 12},
  ...extra,
});
const world = () => {
  const store = new Store(':memory:', Buffer.alloc(32, 9).toString('base64')),
    actor = {tenantId: 't', userId: 'u', role: 'admin'};
  store.putConnection(
    actor,
    {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 't',
      gateway: 'google_ads_native_action',
      accounts: ['1001'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(new Registry(), store, new NativeTransport(provider), undefined, {
    allowWrites: false,
  });
  return {store, actor, service, close: () => store.close()};
};

test('a Google Ads search under v2: compact by default, result_fields and max_items work, compact:false opts out; legacy is as it was', async () => {
  const w = world();
  try {
    // As the MCP layer makes a client's call: in the client's profile, naming the arguments of the call as its own.
    const ask = (profile, extra) => {
        const args = search(extra);
        return withContractProfile(profile, () => w.service.call('google_ads_native_action', args, w.actor), args);
      },
      results = out => out.data.data.results;
    const legacy = await ask('legacy', {}),
      v2 = await ask('v2', {});
    assert.equal(legacy.success, true, JSON.stringify(legacy.error));
    // Legacy keeps the null a row carries; v2 leaves it out of the rows of a list, and nothing else of them.
    assert.equal(results(legacy)[0].campaign.note, null);
    assert.equal('note' in results(v2)[0].campaign, false);
    assert.deepEqual(results(v2)[0], {
      campaign: {id: '1000', name: 'Campaign 0', status: 'PAUSED'},
      metrics: {clicks: '0', impressions: '0', costMicros: '0'},
    });
    assert.equal(results(v2).length, 12);
    assert.equal(v2.data.data.nextPageToken, 'tok2');
    // compact:false is the opt-out: the answer is the legacy answer.
    assert.deepEqual((await ask('v2', {compact: false})).data, legacy.data);
    // result_fields and max_items on the rows of a Google Ads read, which legacy garbles.
    const picked = await ask('v2', {result_fields: ['campaign.id', 'metrics.clicks'], max_items: 3});
    assert.deepEqual(
      results(picked),
      [0, 1, 2].map(i => ({campaign: {id: String(1000 + i)}, metrics: {clicks: String(i)}})),
    );
    assert.equal(picked.data.truncated, true);
    assert.equal(picked.data.response_truncated, true);
    assert.equal(picked.data.data.nextPageToken, 'tok2');
    const old = await ask('legacy', {result_fields: ['campaign.id', 'metrics.clicks']});
    assert.deepEqual(results(old)[0].campaign, {status: 'PAUSED'}, 'legacy keeps the old selection');
    // No profile at all, as the website and the workers call it, is legacy.
    assert.deepEqual((await w.service.call('google_ads_native_action', search({}), w.actor)).data, legacy.data);
    // A call that is not the client's own, though made inside its profile (what a workflow makes while serving it), is as it was.
    const made = await withContractProfile('v2', () => w.service.call('google_ads_native_action', search({}), w.actor));
    assert.deepEqual(made.data, legacy.data);
    const other = search({});
    assert.deepEqual(
      (await withContractProfile('v2', () => w.service.call('google_ads_native_action', search({}), w.actor), other))
        .data,
      legacy.data,
      'the arguments of another call are not the arguments of the client call',
    );
  } finally {
    w.close();
  }
});

test('the reads a workflow makes while serving a v2 client are not compacted: a report is collected from what the provider gave', async t => {
  // A Google device capture reads the account in pages through the service; one campaign has an empty name, a value that
  // compact leaves out of a row. Compacted, the report would hold a different name than the provider gave.
  const names = async profile => {
    const rows = googleDeviceRows();
    rows[0].campaign.name = '';
    const f = googleDeviceFixture(t, rows),
      input = {...googleDeviceInput},
      out = await withContractProfile(profile, () => f.call(input), input);
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.equal(out.data.row_count, 8);
    return out.data.rows.map(row => row.entity_name);
  };
  const legacy = await names('legacy');
  assert.equal(legacy[0], '');
  assert.deepEqual(await names('v2'), legacy);
});

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: an opted-in client's Google Ads read is compact and its result_fields work; a legacy client's is as it was`, async t => {
    const s = await oauthStack(t, {fetcher: provider}),
      older = await s.connect('Legacy client'),
      newer = await s.connect('Opted-in client');
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'v2'), true);
    s.store.putConnection(
      {tenantId: 'local', userId: 'u', role: 'admin'},
      {
        id: '00000000-0000-4000-8000-000000000002',
        tenantId: 'local',
        gateway: 'google_ads_native_action',
        accounts: ['1001'],
        writeAccounts: [],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const call = async (access, extra) =>
      (await (await s.client(era, access)).callTool({name: 'google_ads_native_action', arguments: search(extra)}))
        .structuredContent;
    const legacy = await call(older.access, {}),
      v2 = await call(newer.access, {}),
      picked = await call(newer.access, {result_fields: ['campaign.id'], max_items: 2});
    assert.equal(legacy.data.data.results[0].campaign.note, null);
    assert.equal('note' in v2.data.data.results[0].campaign, false);
    assert.deepEqual(
      picked.data.data.results,
      [0, 1].map(i => ({campaign: {id: String(1000 + i)}})),
    );
    assert.equal(picked.data.response_truncated, true);
  });

test('a gateway that takes no response controls refuses them under v2 as under legacy', async () => {
  const w = world();
  try {
    for (const profile of ['legacy', 'v2']) {
      const args = {action: 'GetCampaignsByAccountId', account_id: '1', result_fields: ['Id']};
      const out = await withContractProfile(
        profile,
        () => w.service.call('microsoft_ads_native_action', args, w.actor),
        args,
      );
      assert.equal(out.success, false, profile);
      assert.equal(out.error.code, 'INVALID_ARGUMENT', profile);
    }
  } finally {
    w.close();
  }
});

test('the v2 help topic announces compact projection and names the seven gateways it applies to', () => {
  const entry = v2Changes.find(change => change.id === 'compact_projection');
  assert.ok(entry, 'compact_projection is announced in the mcp_profile topic');
  assert.equal(v2ReadOnlyGateways.length, 7);
  for (const gateway of v2ReadOnlyGateways)
    assert.ok(entry.text.includes(gateway.replace(/_native_action$/, '')), gateway);
  for (const word of ['compact:false', 'compact:true', 'result_fields', 'max_items', 'campaign.id', 'DV360 lineItems'])
    assert.ok(entry.text.includes(word), word);
});
