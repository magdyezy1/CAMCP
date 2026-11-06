import test from 'node:test';
import assert from 'node:assert/strict';
import {AdPreviews, previewTool} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const actor = {tenantId: 'synthetic-preview-selection', userId: 'owner', role: 'admin'};
const login = 'aaaaaaaa-1111-4111-8111-000000000001',
  otherLogin = 'aaaaaaaa-1111-4111-8111-000000000002';
function storeFixture(t, gateway = 'meta_native_action') {
  const store = new Store(':memory:', Buffer.alloc(32, 127).toString('base64'));
  t.after(() => store.close());
  for (const id of [login, otherLogin])
    store.putConnection(
      actor,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: ['100', '200'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['ads_read', 'r_ads', 'r_ads_reporting'],
      },
      {accessToken: 'synthetic-' + id},
    );
  return store;
}
function metaFixture(t, rows) {
  const store = storeFixture(t),
    reads = [];
  const previews = new AdPreviews(async (_tool, input) => {
    reads.push(structuredClone(input));
    let body;
    if (input.action === 'meta_ad_list') {
      const pageSize = input.query?.limit ?? 100,
        offset = Number(input.query?.after ?? 0),
        page = rows.slice(offset, offset + pageSize);
      body = {
        data: page,
        ...(offset + page.length < rows.length
          ? {
              paging: {
                next: 'https://graph.facebook.com/v26.0/act_100/ads?after=' + (offset + page.length),
                cursors: {after: String(offset + page.length)},
              },
            }
          : {}),
      };
    } else if (input.action === 'meta_ad_id_get') body = rows.find(row => row.id === input.ad_id);
    else if (input.action === 'meta_ad_id_previews_get')
      body = {data: [{body: '<iframe src="https://www.facebook.com/ads/preview/' + input.ad_id + '"></iframe>'}]};
    else throw new Error('Unexpected synthetic preview action ' + input.action);
    return {success: true, data: {data: body}};
  }, store);
  const input = {platform: 'meta', account_id: '100', connection_id: login};
  return {previews, reads, input, run: (extra = {}, current = actor) => previews.handle({...input, ...extra}, current)};
}
const ad = (id, effective_status = 'ACTIVE', extra = {}) => ({
  id: String(id),
  name: 'Synthetic ' + id,
  account_id: '100',
  effective_status,
  campaign_id: '10',
  adset_id: '20',
  ...extra,
});

function snapFixture(t, {ads = [], creatives = [], creativePageSize = 1000, foreign = false} = {}) {
  const store = storeFixture(t, 'snapchat_native_action'),
    reads = [];
  const previews = new AdPreviews(async (_tool, input) => {
    reads.push(structuredClone(input));
    let data;
    if (input.action === 'snapchat_ad_list' || input.action === 'snapchat_creative_list') {
      const creative = input.action === 'snapchat_creative_list',
        kind = creative ? 'creatives' : 'ads',
        singular = creative ? 'creative' : 'ad',
        all = creative ? creatives : ads,
        offset = Number(input.query?.cursor ?? 0),
        size = creative ? creativePageSize : Number(input.query?.limit ?? 50),
        page = all.slice(offset, offset + size),
        selected = creative ? page.filter(row => input.result_ids.includes(row.id)) : page;
      data = {
        request_status: 'SUCCESS',
        [kind]: selected.map(row => ({
          sub_request_status: 'SUCCESS',
          [singular]: {...row, ...(foreign ? {ad_account_id: '200'} : {})},
        })),
        ...(offset + page.length < all.length
          ? {
              paging: {
                next_link:
                  'https://adsapi.snapchat.com/v1/adaccounts/100/' + kind + '?cursor=' + (offset + page.length),
              },
            }
          : {}),
      };
    } else if (input.action === 'snapchat_adsquad_get_by_ids')
      data = {
        request_status: 'SUCCESS',
        adsquads: input.payload.entity_ids.map(({id}) => ({
          adsquad: {id, campaign_id: id === 's1' ? 'c1' : 'c2', ad_account_id: '100'},
        })),
      };
    else if (input.action === 'snapchat_creatives_creative_id_creative_preview_get') {
      assert.ok(reads.some(r => r.action === 'snapchat_creative_list' && r.result_ids.includes(input.creative_id)));
      data = {
        creative_id: input.creative_id,
        expires_at: '2999-01-01T00:00:00Z',
        creative_preview_link:
          'https://adsapi.snapchat.com/media/creative_preview?creative_id=' +
          input.creative_id +
          '&expires_at=' +
          Date.parse('2999-01-01T00:00:00Z') +
          '&signature=synthetic',
      };
    } else throw Error('Unexpected synthetic Snap action ' + input.action);
    return {success: true, data: {data}};
  }, store);
  return {
    store,
    reads,
    run: (extra = {}) =>
      previews.handle({platform: 'snapchat', account_id: '100', connection_id: login, ...extra}, actor),
  };
}

test('Snapchat finds a named paused creative beyond 100 through the account ownership list', async t => {
  const f = snapFixture(t, {
    creatives: Array.from({length: 150}, (_, i) => ({id: 'cr' + (i + 1), name: 'Synthetic ' + (i + 1)})),
  });
  const out = await f.run({ad_ids: ['cr150']});
  assert.deepEqual(
    out.previews.map(row => row.ad_id),
    ['cr150'],
  );
  assert.ok(out.previews[0].links.length);
  assert.equal(f.reads[0].query.limit, 1000);
  assert.equal(f.reads[0].max_pages, 1);
  assert.equal(out.order, 'native');
  assert.equal(
    f.reads.some(row => row.action === 'snapchat_ad_list'),
    false,
  );
});

test('Snapchat lists active ads, proves creative ownership and keeps ads sharing a creative on separate pages', async t => {
  const f = snapFixture(t, {
    ads: [
      {id: 'a1', creative_id: 'cr1', status: 'ACTIVE'},
      {id: 'a2', creative_id: 'cr2', status: 'PAUSED'},
      {id: 'a3', creative_id: 'cr1', status: 'ACTIVE'},
      {id: 'a4', creative_id: 'cr3', status: 'ACTIVE', deleted: true},
      {id: 'a5', creative_id: 'cr2', status: 'ACTIVE'},
    ],
    creatives: [{id: 'cr1'}, {id: 'cr2'}, {id: 'cr3'}],
  });
  const first = await f.run({limit: 2});
  assert.deepEqual(
    first.previews.map(row => row.source_ad_id),
    ['a1', 'a3'],
  );
  assert.deepEqual(
    first.previews.map(row => row.ad_id),
    ['cr1', 'cr1'],
  );
  assert.equal(first.order, 'created_desc');
  const second = await f.run({limit: 2, cursor: first.next_cursor});
  assert.deepEqual(
    second.previews.map(row => row.source_ad_id),
    ['a5'],
  );
  assert.equal(second.has_more, false);
  assert.ok([...first.previews, ...second.previews].every(row => row.links.length === 1));
});

test('Snapchat resolves ad-squad campaign parents and applies both filters, including named creatives', async t => {
  const f = snapFixture(t, {
    ads: [
      {id: 'a1', creative_id: 'cr1', status: 'ACTIVE', ad_squad_id: 's1'},
      {id: 'a2', creative_id: 'cr2', status: 'ACTIVE', ad_squad_id: 's2'},
    ],
    creatives: [{id: 'cr1'}, {id: 'cr2'}],
  });
  const out = await f.run({campaign_ids: ['c1'], adset_ids: ['s1']});
  assert.deepEqual(
    out.previews.map(row => row.ad_id),
    ['cr1'],
  );
  const named = await f.run({ad_ids: ['cr1', 'cr2'], campaign_ids: ['c1']});
  assert.deepEqual(
    named.previews.map(row => row.ad_id),
    ['cr1'],
  );
  assert.deepEqual(named.not_found, ['cr2']);
});

test('Snapchat never previews foreign creatives and does not label a bounded scan as proof of absence', async t => {
  const foreign = snapFixture(t, {creatives: [{id: 'cr1'}], foreign: true});
  await assert.rejects(() => foreign.run({ad_ids: ['cr1']}), {code: 'ACCOUNT_SCOPE_MISMATCH'});
  assert.equal(
    foreign.reads.some(row => row.action.includes('creative_preview')),
    false,
  );
  const f = snapFixture(t, {creatives: Array.from({length: 12}, (_, i) => ({id: 'cr' + i})), creativePageSize: 1});
  const out = await f.run({ad_ids: ['cr11']});
  assert.equal(f.reads.length, 10);
  assert.equal(out.selection_incomplete, true);
  assert.match(out.not_found_reason, /ten-page/);
  assert.deepEqual(out.previews, []);
  const absent = snapFixture(t, {creatives: []});
  const missing = await absent.run({ad_ids: ['foreign']});
  assert.equal(missing.not_found_reason, 'Not in this account');
});

test('preview defaults and selection fields are declared in the public schema', () => {
  const p = previewTool.inputSchema.properties;
  assert.deepEqual(p.statuses.default, ['active']);
  assert.equal(p.limit.default, 5);
  assert.equal(p.cursor.maxLength, 4096);
  for (const field of ['campaign_ids', 'adset_ids']) assert.equal(p[field].maxItems, 50);
});

test('a named Meta ID beyond the first 100 uses its direct read and ignores status', async t => {
  const f = metaFixture(
    t,
    Array.from({length: 150}, (_, i) => ad(i + 1, 'PAUSED')),
  );
  const out = await f.run({ad_ids: ['150']});
  assert.deepEqual(
    out.previews.map(row => row.ad_id),
    ['150'],
  );
  assert.ok(f.reads.some(r => r.action === 'meta_ad_id_get' && r.ad_id === '150'));
  assert.equal(
    f.reads.some(r => r.action === 'meta_ad_list'),
    false,
  );
  assert.equal(out.has_more, false);
  assert.equal(out.next_cursor, null);
});

test('default active status excludes paused and archived rows, and campaign/adset filters intersect', async t => {
  const f = metaFixture(t, [
    ad(1),
    ad(2, 'PAUSED'),
    ad(3, 'ARCHIVED'),
    ad(4, 'ACTIVE', {campaign_id: '11'}),
    ad(5, 'ACTIVE', {adset_id: '21'}),
  ]);
  const out = await f.run({campaign_ids: ['10'], adset_ids: ['20']});
  assert.deepEqual(
    out.previews.map(row => row.ad_id),
    ['1'],
  );
  assert.equal(out.order, 'native');
});

test('paging preserves surplus eligible rows within a native page and returns every matching ad once', async t => {
  const f = metaFixture(t, [ad(1, 'PAUSED'), ad(2), ad(3), ad(4), ad(5, 'ARCHIVED'), ad(6), ad(7)]);
  const ids = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const out = await f.run({limit: 2, ...(cursor ? {cursor} : {})});
    ids.push(...out.previews.map(row => row.ad_id));
    assert.ok(out.previews.length <= 2);
    assert.equal(out.has_more, out.next_cursor !== null);
    if (!out.has_more) break;
    cursor = out.next_cursor;
    assert.ok(cursor.length <= 4096);
  }
  assert.deepEqual(ids, ['2', '3', '4', '6', '7']);
});

test('cursor misuse is refused before a provider read for every selection and identity boundary', async t => {
  const f = metaFixture(
    t,
    Array.from({length: 8}, (_, i) => ad(i + 1)),
  );
  const first = await f.run({limit: 2});
  assert.equal(first.has_more, true);
  for (const [extra, current] of [
    [{statuses: ['paused']}],
    [{campaign_ids: ['11']}],
    [{adset_ids: ['21']}],
    [{account_id: '200'}],
    [{connection_id: otherLogin}],
    [{limit: 3}],
    [{}, {...actor, userId: 'another-user'}],
    [{cursor: first.next_cursor.slice(0, -1) + (first.next_cursor.endsWith('A') ? 'B' : 'A')}],
  ]) {
    const before = f.reads.length;
    await assert.rejects(() => f.run({limit: 2, cursor: first.next_cursor, ...extra}, current), {
      code: 'INVALID_CURSOR',
      message: 'The preview cursor is invalid or expired; list the previews again without it.',
    });
    assert.equal(f.reads.length, before);
  }
  const before = f.reads.length;
  t.mock.timers.enable({apis: ['Date'], now: Date.now() + 300001});
  t.after(() => t.mock.timers.reset());
  await assert.rejects(() => f.run({limit: 2, cursor: first.next_cursor}), {code: 'INVALID_CURSOR'});
  assert.equal(f.reads.length, before);
});

function nativeMeta(t, owner = '100') {
  const store = storeFixture(t),
    reads = [];
  const transport = new NativeTransport(async (raw, init) => {
    const url = new URL(String(raw));
    reads.push({path: url.pathname, fields: url.searchParams.get('fields'), method: init?.method ?? 'GET'});
    if (url.pathname === '/v26.0/150')
      return Response.json({
        id: '150',
        account_id: owner,
        ...(url.searchParams.get('fields')?.includes('name')
          ? {name: 'Sensitive synthetic creative name', effective_status: 'PAUSED'}
          : {}),
      });
    if (url.pathname === '/v26.0/150/previews')
      return Response.json({data: [{body: '<iframe src="https://www.facebook.com/ads/preview/150"></iframe>'}]});
    throw new Error('No first-page list is permitted: ' + url.pathname);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  return {store, reads, service};
}

test('native Meta selection proves an unknown ID belongs to the account without a list or broader read', async t => {
  const f = nativeMeta(t);
  const out = await f.service.call(
    'amcp_ad_previews',
    {
      platform: 'meta',
      account_id: '100',
      connection_id: login,
      ad_ids: ['150'],
    },
    actor,
  );
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(
    out.data.previews.map(row => row.ad_id),
    ['150'],
  );
  assert.equal(f.reads[0].fields, 'id,account_id');
  assert.ok(f.reads.every(row => row.method === 'GET'));
  assert.equal(
    f.reads.some(row => row.path.includes('act_')),
    false,
  );
});

test('a foreign Meta identity is not cached, exposed or previewed', async t => {
  const f = nativeMeta(t, '200');
  const out = await f.service.call(
    'amcp_ad_previews',
    {
      platform: 'meta',
      account_id: '100',
      connection_id: login,
      ad_ids: ['150'],
    },
    actor,
  );
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(out.data.previews, []);
  assert.deepEqual(out.data.not_found, ['150']);
  assert.equal(out.data.not_found_reason, 'Not in this account');
  assert.equal(
    f.reads.some(row => row.fields?.includes('name') || row.path.endsWith('/previews')),
    false,
  );
  const connection = f.store.resolveConnection(actor, 'meta_native_action', '100', login);
  assert.equal(f.store.ownsResource(connection, '100', '150'), false);
  assert.doesNotMatch(JSON.stringify(out), /Sensitive synthetic creative name/);
});

test('a full Meta node read without ownership remains refused before egress', async t => {
  const f = nativeMeta(t);
  const out = await f.service.call(
    'meta_native_action',
    {
      action: 'meta_ad_id_get',
      account_id: '100',
      connection_id: login,
      ad_id: '150',
      query: {fields: 'id,name,account_id,effective_status'},
    },
    actor,
  );
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.reads.length, 0);
});

test('only the previews tool’s exact Meta identity read can establish ownership, and a foreign answer is withheld', async t => {
  for (const owner of ['100', '200']) {
    const f = nativeMeta(t, owner);
    // F-L3-03: a caller's own call of the same read is an ordinary node read, refused before any request.
    const direct = await f.service.call(
      'meta_native_action',
      {
        action: 'meta_ad_id_get',
        account_id: '100',
        connection_id: login,
        ad_id: '150',
        query: {fields: 'id,account_id'},
      },
      actor,
    );
    assert.equal(direct.success, false);
    assert.equal(direct.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(f.reads.length, 0);
    // The previews tool sends it for the person: its answer is checked before anything is returned or remembered.
    const out = await f.service.call(
      'amcp_ad_previews',
      {platform: 'meta', account_id: '100', connection_id: login, ad_ids: ['150']},
      actor,
    );
    assert.equal(out.success, true, JSON.stringify(out.error));
    const connection = f.store.resolveConnection(actor, 'meta_native_action', '100', login);
    assert.equal(f.store.ownsResource(connection, '100', '150'), owner === '100');
    assert.equal(f.reads[0].fields, 'id,account_id');
    // A foreign ad stops at that one read; its own ad goes on to the metadata and the preview.
    assert.equal(f.reads.length, owner === '100' ? 3 : 1);
    assert.deepEqual(out.data.not_found ?? [], owner === '100' ? [] : ['150']);
  }
});

test('an explicitly foreign row in an account list is withheld before any preview', async t => {
  const f = metaFixture(t, [ad(1, 'ACTIVE', {account_id: '200', name: 'Foreign synthetic name'})]);
  await assert.rejects(() => f.run(), {code: 'ACCOUNT_SCOPE_MISMATCH'});
  assert.equal(
    f.reads.some(read => read.action === 'meta_ad_id_previews_get'),
    false,
  );
});

test('a cursor-based provider cannot claim more rows without a usable continuation', async t => {
  const store = storeFixture(t);
  const previews = new AdPreviews(
    async () => ({
      success: true,
      data: {
        data: {
          data: [ad(1)],
          paging: {next: 'https://graph.facebook.com/next', cursors: {after: null}},
        },
      },
    }),
    store,
  );
  await assert.rejects(() => previews.handle({platform: 'meta', account_id: '100', connection_id: login}, actor), {
    code: 'REPORT_SHAPE_CHANGED',
  });
});

function platformFixture(t, platform, count = 150) {
  const store = storeFixture(t, platform + '_native_action'),
    reads = [];
  const ids = Array.from({length: count}, (_, i) => String(i + 1));
  const native = id => (platform === 'linkedin' ? 'urn:li:sponsoredCreative:' + id : id);
  const record = id =>
    platform === 'tiktok'
      ? {
          ad_id: id,
          ad_name: 'Synthetic ' + id,
          advertiser_id: '100',
          campaign_id: '10',
          adgroup_id: '20',
          operation_status: Number(id) % 3 === 0 ? 'DISABLE' : 'ENABLE',
        }
      : platform === 'linkedin'
        ? {
            id: native(id),
            name: 'Synthetic ' + id,
            account: 'urn:li:sponsoredAccount:100',
            campaign: 'urn:li:sponsoredCampaign:20',
            intendedStatus: Number(id) % 3 === 0 ? 'PAUSED' : 'ACTIVE',
          }
        : {
            id,
            name: 'Synthetic ' + id,
            campaign_id: '10',
            ad_group_id: '20',
            configured_status: Number(id) % 3 === 0 ? 'PAUSED' : 'ACTIVE',
            preview_url: 'https://www.reddit.com/preview/' + id,
            preview_expiry: '2999-01-01T00:00:00Z',
          };
  const values = value =>
    Array.isArray(value)
      ? value
      : typeof value === 'string' && value.startsWith('List(')
        ? value.slice(5, -1).split(',')
        : [];
  const previews = new AdPreviews(async (_tool, input) => {
    reads.push(structuredClone(input));
    const action = input.action ?? input.arguments?.action;
    if (action === 'tiktok_ad_preview')
      return {
        success: true,
        data: {data: {code: 0, data: {preview_link: 'https://ads.tiktok.com/preview/' + input.payload.ad_id}}},
      };
    if (action === 'linkedin_rest_ad_previews_get')
      return {
        success: true,
        data: {
          data: {
            elements: [
              {
                preview:
                  '<iframe src="https://www.linkedin.com/ads/preview/' +
                  input.query.creative.split(':').at(-1) +
                  '"></iframe>',
              },
            ],
          },
        },
      };
    if (action === 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get')
      return {
        success: true,
        data: {
          data: {
            elements: [
              {id: '20', account: 'urn:li:sponsoredAccount:100', campaignGroup: 'urn:li:sponsoredCampaignGroup:10'},
            ],
            metadata: {},
          },
        },
      };
    const query = input.query ?? input.arguments?.params ?? {},
      wanted =
        platform === 'tiktok' ? query.filtering?.ad_ids : platform === 'linkedin' ? values(query.creatives) : query.id,
      all = wanted?.length ? ids.filter(id => wanted.includes(native(id))) : ids,
      size = Number(query.page_size ?? query.pageSize ?? query['page.size'] ?? 100),
      offset =
        platform === 'tiktok'
          ? (Number(query.page ?? 1) - 1) * size
          : Number(query.pageToken ?? query['page.token'] ?? 0),
      rows = all.slice(offset, offset + size).map(record),
      more = offset + rows.length < all.length;
    let body;
    if (platform === 'tiktok')
      body = {
        code: 0,
        data: {
          list: rows,
          page_info: {
            page: Number(query.page ?? 1),
            page_size: size,
            total_number: all.length,
            total_page: Math.ceil(all.length / size),
          },
        },
      };
    else if (platform === 'linkedin')
      body = {elements: rows, metadata: more ? {nextPageToken: String(offset + size)} : {}};
    else
      body = {
        data: rows,
        pagination: {
          next_url: more
            ? 'https://ads-api.reddit.com/api/v3/ad_accounts/100/ads?page.size=' +
              size +
              '&page.token=' +
              (offset + size)
            : null,
        },
      };
    return {success: true, data: {data: body}};
  }, store);
  const run = extra => previews.handle({platform, account_id: '100', connection_id: login, ...extra}, actor);
  return {run, reads, native, store};
}

for (const platform of ['tiktok', 'linkedin', 'reddit']) {
  test(platform + ' previews a named paused ID beyond 100 through a filtered account read', async t => {
    const f = platformFixture(t, platform),
      input = {ad_ids: ['150']},
      out = await f.run(input);
    assert.deepEqual(
      out.previews.map(row => row.ad_id),
      [f.native('150')],
    );
    assert.deepEqual(input.ad_ids, ['150']);
    const inventory = f.reads.find(
      read =>
        (read.action ?? read.arguments?.action) !== 'tiktok_ad_preview' &&
        read.action !== 'linkedin_rest_ad_previews_get',
    );
    if (platform === 'tiktok') {
      assert.deepEqual(inventory.query.filtering.ad_ids, ['150']);
      assert.equal(inventory.query.filtering.primary_status, 'STATUS_ALL');
    } else if (platform === 'linkedin') assert.ok(inventory.query.creatives);
    else assert.deepEqual(inventory.arguments.params.id, ['150']);
  });
  test(platform + ' defaults to active records and continues its existing native paging', async t => {
    const f = platformFixture(t, platform),
      ids = [];
    let cursor;
    for (let i = 0; i < 3; i++) {
      const out = await f.run({limit: 2, ...(cursor ? {cursor} : {})});
      assert.equal(out.has_more, true);
      ids.push(...out.previews.map(row => row.ad_id));
      cursor = out.next_cursor;
    }
    assert.deepEqual(ids, ['1', '2', '4', '5', '7', '8'].map(f.native));
  });
  test(platform + ' applies named parent filters and reports an absent ID without a preview read', async t => {
    const f = platformFixture(t, platform);
    const out = await f.run({ad_ids: ['150', '999'], campaign_ids: ['10'], adset_ids: ['20']});
    assert.deepEqual(
      out.previews.map(row => row.ad_id),
      [f.native('150')],
    );
    assert.deepEqual(out.not_found, [f.native('999')]);
    const excluded = await f.run({ad_ids: ['150'], campaign_ids: ['11']});
    assert.deepEqual(excluded.previews, []);
    assert.ok(
      f.reads
        .filter(read => read.action === 'tiktok_ad_preview' || read.action === 'linkedin_rest_ad_previews_get')
        .every(read => !JSON.stringify(read).includes('999')),
    );
  });
  test(platform + ' limits a filtered scan to ten long pages and retains a continuation', async t => {
    // Ten pages of 100 hold no match of the filter; the 1,500 records beyond are for the continuation.
    const f = platformFixture(t, platform, 1500),
      out = await f.run({campaign_ids: ['11'], limit: 1});
    assert.deepEqual(out.previews, []);
    assert.equal(out.has_more, true);
    assert.equal(
      f.reads.filter(
        read =>
          (read.action ?? read.arguments?.action) ===
          {
            tiktok: 'tiktok_ad_list',
            linkedin: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
            reddit: 'LIST_ADS',
          }[platform],
      ).length,
      10,
    );
    const before = f.reads.length;
    await assert.rejects(() => f.run({campaign_ids: ['11'], limit: 1, cursor: out.next_cursor, statuses: ['all']}), {
      code: 'INVALID_CURSOR',
    });
    assert.equal(f.reads.length, before);
  });
}

test('a revoked permission or changed login invalidates an earlier preview cursor before a provider read', async t => {
  const f = platformFixture(t, 'tiktok'),
    first = await f.run({limit: 1}),
    before = f.reads.length;
  const connection = f.store.resolveConnection(actor, 'tiktok_native_action', '100', login);
  f.store.putConnection(actor, {...connection, scopes: ['r_ads']}, {accessToken: 'synthetic-' + login});
  await assert.rejects(() => f.run({limit: 1, cursor: first.next_cursor}), {code: 'INVALID_CURSOR'});
  assert.equal(f.reads.length, before);
  f.store.putConnection(actor, connection, {accessToken: 'changed-synthetic-login'});
  await assert.rejects(() => f.run({limit: 1, cursor: first.next_cursor}), {code: 'INVALID_CURSOR'});
  assert.equal(f.reads.length, before);
});

test('revocation during a provider read withholds the page and its continuation', async t => {
  const store = storeFixture(t);
  const previews = new AdPreviews(async () => {
    const connection = store.resolveConnection(actor, 'meta_native_action', '100', login);
    store.putConnection(actor, {...connection, enabled: false}, {accessToken: 'synthetic-' + login});
    return {success: true, data: {data: {data: [ad(1)]}}};
  }, store);
  await assert.rejects(() => previews.handle({platform: 'meta', account_id: '100', connection_id: login}, actor), {
    code: 'CONNECTION_REQUIRED',
  });
});

test('native Snapchat selection learns creative ownership only from its account list before previewing', async t => {
  const store = storeFixture(t, 'snapchat_native_action'),
    reads = [];
  const transport = new NativeTransport(async raw => {
    const url = new URL(String(raw));
    reads.push(url.pathname);
    if (url.pathname === '/v1/adaccounts/100/ads')
      return Response.json({
        request_status: 'SUCCESS',
        ads: [{ad: {id: 'a1', creative_id: 'cr1', name: 'Synthetic', status: 'ACTIVE'}}],
      });
    if (url.pathname === '/v1/adaccounts/100/creatives')
      return Response.json({request_status: 'SUCCESS', creatives: [{creative: {id: 'cr1', ad_account_id: '100'}}]});
    if (url.pathname === '/v1/creatives/cr1/creative_preview')
      return Response.json({
        request_status: 'SUCCESS',
        creative_id: 'cr1',
        expires_at: '2999-01-01T00:00:00Z',
        creative_preview_link:
          'https://adsapi.snapchat.com/media/creative_preview?creative_id=cr1&expires_at=' +
          Date.parse('2999-01-01T00:00:00Z') +
          '&signature=synthetic',
      });
    throw Error('Unexpected synthetic Snapchat request ' + url.pathname);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const out = await service.call(
    'amcp_ad_previews',
    {platform: 'snapchat', account_id: '100', connection_id: login},
    actor,
  );
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.previews[0].links.length, 1, JSON.stringify(out));
  assert.deepEqual(reads, [
    '/v1/adaccounts/100/ads',
    '/v1/adaccounts/100/creatives',
    '/v1/creatives/cr1/creative_preview',
  ]);
});

test('LinkedIn filters use campaign groups and native campaigns in the shared parent positions', async t => {
  const f = platformFixture(t, 'linkedin');
  const included = await f.run({campaign_ids: ['10'], adset_ids: ['20'], limit: 1});
  assert.deepEqual(
    included.previews.map(row => row.ad_id),
    ['urn:li:sponsoredCreative:1'],
  );
  const excluded = await f.run({campaign_ids: ['11'], adset_ids: ['20'], limit: 1});
  assert.deepEqual(excluded.previews, []);
  assert.equal(included.order, 'native');
});

test('LinkedIn never learns creative ownership from an explicitly foreign account in the finder', async t => {
  const store = storeFixture(t, 'linkedin_native_action');
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () =>
      Response.json({
        elements: [
          {
            id: 'urn:li:sponsoredCreative:150',
            account: 'urn:li:sponsoredAccount:200',
            name: 'Foreign synthetic creative',
          },
        ],
      }),
    ),
  );
  const out = await service.call(
    'linkedin_native_action',
    {
      action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
      account_id: '100',
      connection_id: login,
      restli_method: 'FINDER',
      query: {q: 'criteria', creatives: 'List(urn:li:sponsoredCreative:150)'},
    },
    actor,
  );
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'ACCOUNT_SCOPE_MISMATCH');
  const connection = store.resolveConnection(actor, 'linkedin_native_action', '100', login);
  assert.equal(store.ownsResource(connection, '100', 'creatives/150'), false);
  assert.doesNotMatch(JSON.stringify(out), /Foreign synthetic creative/);
});

// Audit mutation gaps M6 and M13: the previews tool's own checks stood behind the gateway's, and no test pinned them.
test('M6: a named Meta ad whose identity names another account is not previewed, and nothing broader is read', async t => {
  // The identity read answers account 200 for a request on account 100: stopped at that read, whatever the gateway does.
  const f = metaFixture(t, [ad(5, 'ACTIVE', {account_id: '200', name: 'Foreign synthetic name'})]);
  const out = await f.run({ad_ids: ['5']});
  assert.deepEqual(out.previews, []);
  assert.deepEqual(out.not_found, ['5']);
  assert.equal(out.not_found_reason, 'Not in this account');
  assert.deepEqual(
    f.reads.map(read => [read.action, read.query?.fields]),
    [['meta_ad_id_get', 'id,account_id']],
  );
  assert.doesNotMatch(JSON.stringify(out), /Foreign synthetic name/);
});

test('M6: a named Meta ad is dropped when its identity names another ad, or its metadata names another account', async t => {
  const store = storeFixture(t),
    reads = [];
  const call = answer => async (_tool, input) => {
    reads.push(input.action + ':' + (input.query?.fields ?? input.query?.ad_format));
    return {success: true, data: {data: answer(input)}};
  };
  // The identity names another ad than the one asked for.
  let previews = new AdPreviews(
    call(() => ({id: '6', account_id: '100'})),
    store,
  );
  let out = await previews.handle({platform: 'meta', account_id: '100', connection_id: login, ad_ids: ['5']}, actor);
  assert.deepEqual([out.previews, out.not_found], [[], ['5']]);
  assert.deepEqual(reads.splice(0), ['meta_ad_id_get:id,account_id']);
  // The identity is the account's, but the broader read then names another account: no preview is read.
  previews = new AdPreviews(
    call(input =>
      input.query.fields === 'id,account_id'
        ? {id: '5', account_id: '100'}
        : {id: '5', account_id: '200', name: 'Changed synthetic name', effective_status: 'ACTIVE'},
    ),
    store,
  );
  out = await previews.handle({platform: 'meta', account_id: '100', connection_id: login, ad_ids: ['5']}, actor);
  assert.deepEqual([out.previews, out.not_found], [[], ['5']]);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(read => !read.startsWith('meta_ad_id_previews_get')));
  assert.doesNotMatch(JSON.stringify(out), /Changed synthetic name/);
  reads.length = 0;
  // The identity is the account's, but the broader read then answers for another ad of the account.
  previews = new AdPreviews(
    call(input =>
      input.query.fields === 'id,account_id'
        ? {id: '5', account_id: '100'}
        : {id: '6', account_id: '100', name: 'Other synthetic ad', effective_status: 'ACTIVE'},
    ),
    store,
  );
  out = await previews.handle({platform: 'meta', account_id: '100', connection_id: login, ad_ids: ['5']}, actor);
  assert.deepEqual([out.previews, out.not_found], [[], ['5']]);
  assert.equal(reads.length, 2);
  assert.ok(reads.every(read => !read.startsWith('meta_ad_id_previews_get')));
  assert.doesNotMatch(JSON.stringify(out), /Other synthetic ad/);
});

test('M13: a Snapchat ad whose creative the account does not list gets no preview read', async t => {
  const f = snapFixture(t, {
    ads: [
      {id: 'a1', creative_id: 'crUnlisted', name: 'Synthetic ad', status: 'ACTIVE'},
      {id: 'a2', creative_id: 'cr2', name: 'Listed ad', status: 'ACTIVE'},
    ],
    creatives: [{id: 'cr2'}],
  });
  const out = await f.run();
  // Both ads are listed, the listed creative previews, the unlisted one says it is not the account's.
  assert.deepEqual(
    out.previews.map(row => [row.source_ad_id, row.ad_id, row.links.length, row.note]),
    [
      ['a1', 'crUnlisted', 0, 'Not in this account'],
      ['a2', 'cr2', 1, undefined],
    ],
  );
  assert.deepEqual(
    f.reads.filter(read => read.action.includes('creative_preview')).map(read => read.creative_id),
    ['cr2'],
  );
  assert.equal(out.selection_incomplete, undefined);
});

test('M13: a Snapchat creative the bounded ownership scan did not reach is not previewed and says the scan was bounded', async t => {
  const f = snapFixture(t, {
    ads: [{id: 'a1', creative_id: 'cr11', name: 'Synthetic ad', status: 'ACTIVE'}],
    creatives: Array.from({length: 12}, (_, i) => ({id: 'cr' + i})),
    creativePageSize: 1,
  });
  const out = await f.run();
  assert.equal(out.previews.length, 1);
  assert.deepEqual(out.previews[0].links, []);
  assert.match(out.previews[0].note, /ten-page/);
  assert.equal(out.selection_incomplete, true);
  assert.equal(
    f.reads.some(read => read.action.includes('creative_preview')),
    false,
  );
});

// Design note 2: a list page was as long as `limit` (at most 10) and a call read at most ten pages, so five active ads among
// hundreds of paused ones took ten sequential reads of five rows, and several calls. Each platform now asks its own list for
// a long page, whatever `limit` is (the offset logic resumes the surplus rows of a page).
const longPage = 100;

test('Meta finds five active ads behind 240 paused ones in three long reads, not ten short ones', async t => {
  const f = metaFixture(
    t,
    Array.from({length: 250}, (_, i) => ad(i + 1, i < 240 ? 'PAUSED' : 'ACTIVE')),
  );
  const out = await f.run({limit: 5});
  assert.deepEqual(
    out.previews.map(row => row.ad_id),
    ['241', '242', '243', '244', '245'],
  );
  assert.deepEqual(
    f.reads.filter(read => read.action === 'meta_ad_list').map(read => read.query.limit),
    [longPage, longPage, longPage],
  );
  // The rest of the last page is still there for the next call: the cursor resumes inside it.
  assert.equal(out.has_more, true);
  const more = await f.run({limit: 5, cursor: out.next_cursor});
  assert.deepEqual(
    more.previews.map(row => row.ad_id),
    ['246', '247', '248', '249', '250'],
  );
});

for (const [platform, listed, size] of [
  ['tiktok', read => read.action === 'tiktok_ad_list', read => read.query.page_size],
  [
    'linkedin',
    read => read.action === 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
    read => read.query.pageSize,
  ],
  ['reddit', read => read.arguments?.action === 'LIST_ADS', read => read.arguments.params['page.size']],
]) {
  test(
    platform + ' asks its list for a long page when one record is wanted, and a named read for exactly the named IDs',
    async t => {
      const f = platformFixture(t, platform);
      const out = await f.run({limit: 1});
      assert.deepEqual(
        out.previews.map(row => row.ad_id),
        [f.native('1')],
      );
      assert.deepEqual(f.reads.filter(listed).map(size), [longPage]);
      // The rest of that page is resumed by the cursor, not read again as a new page.
      const next = await f.run({limit: 1, cursor: out.next_cursor});
      assert.deepEqual(
        next.previews.map(row => row.ad_id),
        [f.native('2')],
      );
      // A named read asks for the named IDs only.
      f.reads.length = 0;
      await f.run({ad_ids: ['7', '9']});
      assert.deepEqual(f.reads.filter(listed).map(size), [2]);
    },
  );
}

test('Snapchat asks its ads list for a long page, and the long page keeps its parent lookups bounded', async t => {
  const f = snapFixture(t, {
    ads: Array.from({length: 120}, (_, i) => ({
      id: 'a' + i,
      creative_id: 'cr' + i,
      status: i < 110 ? 'PAUSED' : 'ACTIVE',
      ad_squad_id: 's1',
    })),
    creatives: Array.from({length: 120}, (_, i) => ({id: 'cr' + i})),
  });
  const out = await f.run({limit: 5, campaign_ids: ['c1']});
  assert.equal(out.previews.length, 5);
  assert.deepEqual(
    f.reads.filter(read => read.action === 'snapchat_ad_list').map(read => read.query.limit),
    [longPage, longPage],
  );
  // One ad squad lookup however many ads name it, never more squads than a page can hold.
  const squads = f.reads.filter(read => read.action === 'snapchat_adsquad_get_by_ids');
  assert.deepEqual(
    squads.map(read => read.payload.entity_ids.length),
    [1],
  );
});

// Design note 3: the proof that a Snapchat creative is the account's re-read the creative list from its first page on
// every call, although the gateway had observed the creatives it returned for five minutes (the same observation the
// preview read needs). A creative observed in that time is not proven again; one that was not is, and a named creative
// always is, for its name.
function nativeSnapchat(t) {
  const store = storeFixture(t, 'snapchat_native_action'),
    reads = [];
  const ads = ['cr1', 'cr2', 'cr3'].map((creative, i) => ({
    id: 'a' + (i + 1),
    creative_id: creative,
    status: 'ACTIVE',
  }));
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async raw => {
      const url = new URL(String(raw));
      reads.push(
        url.pathname +
          (url.searchParams.get('cursor')
            ? '?cursor=' + url.searchParams.get('cursor')
            : url.searchParams.get('limit')
              ? '?limit=' + url.searchParams.get('limit')
              : ''),
      );
      if (url.pathname === '/v1/adaccounts/100/ads')
        return Response.json({request_status: 'SUCCESS', ads: ads.map(row => ({ad: {...row, name: 'Ad ' + row.id}}))});
      if (url.pathname === '/v1/adaccounts/100/creatives') {
        // The account's creatives come two to a page, as the list pages them; the gateway keeps only the IDs asked for.
        const offset = Number(url.searchParams.get('cursor') ?? 0),
          page = ads.slice(offset, offset + 2);
        return Response.json({
          request_status: 'SUCCESS',
          creatives: page.map(row => ({
            creative: {id: row.creative_id, name: 'Creative ' + row.creative_id, ad_account_id: '100'},
          })),
          ...(offset + 2 < ads.length
            ? {
                paging: {
                  next_link:
                    'https://adsapi.snapchat.com/v1/adaccounts/100/creatives?cursor=' +
                    (offset + 2) +
                    '&limit=1000&sort=created_at-desc',
                },
              }
            : {}),
        });
      }
      const preview = /^\/v1\/creatives\/(\w+)\/creative_preview$/.exec(url.pathname);
      if (preview)
        return Response.json({
          request_status: 'SUCCESS',
          creative_id: preview[1],
          expires_at: '2999-01-01T00:00:00Z',
          creative_preview_link:
            'https://adsapi.snapchat.com/media/creative_preview?creative_id=' +
            preview[1] +
            '&expires_at=' +
            Date.parse('2999-01-01T00:00:00Z') +
            '&signature=synthetic',
        });
      throw Error('Unexpected synthetic Snapchat request ' + url.pathname);
    }),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = extra =>
    service.call('amcp_ad_previews', {platform: 'snapchat', account_id: '100', connection_id: login, ...extra}, actor);
  return {store, reads, call};
}
const listReads = reads => reads.filter(path => path.startsWith('/v1/adaccounts/100/creatives')).length;

test('a Snapchat creative seen in the account’s list in the last five minutes is not proven again, and one that was not is', async t => {
  const f = nativeSnapchat(t);
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  t.after(() => t.mock.timers.reset());
  const first = await f.call({limit: 2});
  assert.deepEqual(
    first.data.previews.map(row => row.ad_id),
    ['cr1', 'cr2'],
  );
  assert.equal(listReads(f.reads), 1);
  // The same selection a minute later: the ads and the previews are read, the creative list is not.
  t.mock.timers.tick(60000);
  f.reads.length = 0;
  const again = await f.call({limit: 2});
  assert.deepEqual(
    again.data.previews.map(row => row.ad_id),
    ['cr1', 'cr2'],
  );
  assert.equal(
    again.data.previews.every(row => row.links.length === 1),
    true,
  );
  assert.equal(listReads(f.reads), 0);
  assert.deepEqual(f.reads, [
    '/v1/adaccounts/100/ads?limit=100',
    '/v1/creatives/cr1/creative_preview',
    '/v1/creatives/cr2/creative_preview',
  ]);
  // A third creative is on the list's second page, which no read had shown: it is proven by walking to it.
  f.reads.length = 0;
  const wider = await f.call({limit: 3});
  assert.deepEqual(
    wider.data.previews.map(row => row.ad_id),
    ['cr1', 'cr2', 'cr3'],
  );
  assert.deepEqual(
    f.reads.filter(path => path.startsWith('/v1/adaccounts/100/creatives')),
    ['/v1/adaccounts/100/creatives?limit=1000', '/v1/adaccounts/100/creatives?cursor=2'],
  );
  // After five minutes the observation has lapsed, and the proof is read again.
  t.mock.timers.tick(5 * 60000 + 1);
  f.reads.length = 0;
  await f.call({limit: 3});
  assert.equal(listReads(f.reads), 2);
});

test('a named Snapchat creative is proven from the account list every time, for its name', async t => {
  const f = nativeSnapchat(t);
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  t.after(() => t.mock.timers.reset());
  for (let call = 0; call < 2; call++) {
    f.reads.length = 0;
    const out = await f.call({ad_ids: ['cr1']});
    assert.deepEqual(
      out.data.previews.map(row => [row.ad_id, row.name]),
      [['cr1', 'Creative cr1']],
    );
    assert.equal(listReads(f.reads), 1, 'call ' + call);
    t.mock.timers.tick(1000);
  }
});

test('a creative observed through one login is not taken as proven through another', async t => {
  const f = nativeSnapchat(t);
  await f.call({limit: 2});
  f.reads.length = 0;
  const other = await new MirrorService(
    new Registry(),
    f.store,
    new NativeTransport(async raw => {
      const url = new URL(String(raw));
      f.reads.push(url.pathname);
      if (url.pathname === '/v1/adaccounts/100/ads')
        return Response.json({
          request_status: 'SUCCESS',
          ads: [{ad: {id: 'a1', creative_id: 'cr1', name: 'Ad', status: 'ACTIVE'}}],
        });
      if (url.pathname === '/v1/adaccounts/100/creatives')
        return Response.json({request_status: 'SUCCESS', creatives: []});
      throw Error('Unexpected synthetic Snapchat request ' + url.pathname);
    }),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  ).call('amcp_ad_previews', {platform: 'snapchat', account_id: '100', connection_id: otherLogin}, actor);
  // The second login's own creative list does not show cr1: it is not previewed, and the list was read.
  assert.deepEqual(
    other.data.previews.map(row => [row.ad_id, row.links.length, row.note]),
    [['cr1', 0, 'Not in this account']],
  );
  assert.equal(listReads(f.reads), 1);
  assert.equal(
    f.reads.some(path => path.includes('creative_preview')),
    false,
  );
});
