import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const account = '100',
  campaign = '9007199254740993',
  group = '9007199254740995',
  ad = '9007199254740997';
const rowCampaign = (id = campaign) => ({
  advertiser_id: account,
  campaign_id: id,
  campaign_name: 'Campaign',
  operation_status: 'ENABLE',
  secondary_status: 'CAMPAIGN_STATUS_BUDGET_EXCEED',
  budget_mode: 'BUDGET_MODE_DAY',
  budget: 100.25,
  private: 'PRIVATE-CAMPAIGN',
});
const rowGroup = () => ({
  advertiser_id: account,
  campaign_id: campaign,
  adgroup_id: group,
  adgroup_name: 'Group',
  operation_status: 'DISABLE',
  secondary_status: 'ADGROUP_STATUS_DISABLE',
  budget_mode: 'BUDGET_MODE_DAY',
  budget: '30.50',
  scheduled_budget: 35,
  bid_price: 0.25,
  targeting: 'PRIVATE-TARGETING',
});
const rowAd = () => ({
  advertiser_id: account,
  campaign_id: campaign,
  adgroup_id: group,
  ad_id: ad,
  ad_name: 'Ad',
  operation_status: 'ENABLE',
  secondary_status: 'AD_STATUS_REVIEW',
  ad_text: 'PRIVATE-COPY',
  landing_page_url: 'https://example.com/private',
});
const page = (list, page = 1, page_size = 2, total_number = list.length) => ({
  code: 0,
  message: 'OK',
  data: {list, page_info: {page, page_size, total_number, total_page: Math.ceil(total_number / page_size)}},
  private: 'PRIVATE-ENVELOPE',
});
function fixture(t) {
  const actor = {tenantId: 'tiktok-portfolio', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 103).toString('base64'));
  t.after(() => store.close());
  const connection = {
      id: 'ffffffff-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      enabled: true,
      label: 'Synthetic TikTok',
      accounts: [account],
      scopes: [],
    },
    credentials = {accessToken: 'synthetic'};
  store.putConnection({...actor, role: 'admin'}, connection, credentials);
  let edit = (_u, d) => d;
  const requests = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(url);
        requests.push({url: u, method: init.method});
        const n = Number(u.searchParams.get('page') ?? 1),
          size = Number(u.searchParams.get('page_size') ?? 2);
        let d;
        if (u.pathname.endsWith('/advertiser/info/'))
          d = {
            code: 0,
            message: 'OK',
            data: {list: [{advertiser_id: account, currency: 'USD', timezone: 'Etc/GMT', private: 'PRIVATE-BILLING'}]},
          };
        else if (u.pathname.endsWith('/campaign/get/'))
          d = page(
            n === 1 ? [rowCampaign(), rowCampaign('9007199254740994')] : [rowCampaign('9007199254740996')],
            n,
            size,
            3,
          );
        else if (u.pathname.endsWith('/adgroup/get/')) d = page([rowGroup()], n, size);
        else if (u.pathname.endsWith('/ad/get/')) d = page([rowAd()], n, size);
        else throw Error('Unexpected route ' + u.pathname);
        return Response.json(edit(u, d));
      },
      async () => {},
    ),
  );
  return {
    actor,
    store,
    connection,
    credentials,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (requirements = {entity: 'campaign'}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {
          action: 'portfolio',
          gateway: 'tiktok_native_action',
          connection_id: connection.id,
          account_id: account,
          limit: 2,
          requirements,
          ...extra,
        },
        actor,
      ),
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('TikTok portfolio reads scoped campaign pages with explicit native fields, current account metadata and separate statuses', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  assert.equal(first.rows[0].id, campaign);
  assert.equal(first.rows[0].currency, 'USD');
  assert.equal(first.rows[0].timezone, 'Etc/GMT');
  assert.equal(first.rows[0].status, 'ENABLE');
  assert.equal(first.rows[0].secondary_status, 'CAMPAIGN_STATUS_BUDGET_EXCEED');
  assert.equal(first.rows[0].native_money.budget, 100.25);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|accessToken/);
  const second = ok(await f.call({entity: 'campaign'}, {cursor: first.next_cursor}));
  assert.equal(second.rows[0].id, '9007199254740996');
  assert.equal(second.has_more, false);
  assert.equal(f.requests.length, 4);
  for (const request of f.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.url.origin, 'https://business-api.tiktok.com');
  }
  const native = f.requests.at(-1).url;
  assert.equal(native.searchParams.get('advertiser_id'), account);
  assert.equal(native.searchParams.get('page'), '2');
  assert.equal(JSON.parse(native.searchParams.get('filtering')).primary_status, 'STATUS_NOT_DELETE');
  assert.ok(JSON.parse(native.searchParams.get('fields')).includes('secondary_status'));
});

test('TikTok account-scoped child reads verify every parent without retaining targeting or ad text', async t => {
  const f = fixture(t),
    groups = ok(await f.call({entity: 'adgroup', campaign_id: campaign}));
  assert.equal(groups.rows[0].native_money.budget, '30.50');
  assert.equal(groups.rows[0].native_money.scheduled_budget, 35);
  const ads = ok(await f.call({entity: 'ad', campaign_id: campaign, adgroup_id: group}));
  assert.equal(ads.rows[0].id, ad);
  assert.doesNotMatch(JSON.stringify([groups, ads]), /PRIVATE|landing_page/);
  assert.deepEqual(JSON.parse(f.requests.at(-1).url.searchParams.get('filtering')), {
    primary_status: 'STATUS_NOT_DELETE',
    campaign_ids: [campaign],
    adgroup_ids: [group],
  });
});

test('TikTok cursors reject tampering, changed page size, actor, authorization and expiry before network', async t => {
  const f = fixture(t),
    first = ok(await f.call()),
    decoded = JSON.parse(Buffer.from(first.next_cursor, 'base64url'));
  for (const extra of [
    {cursor: Buffer.from(JSON.stringify({...decoded, page: 3})).toString('base64url')},
    {cursor: first.next_cursor + '='},
    {cursor: first.next_cursor, limit: 3},
  ])
    assert.equal((await f.call({entity: 'campaign'}, extra)).success, false);
  f.actor.userId = 'other';
  assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  f.actor.userId = 'reader';
  const now = Date.now;
  try {
    Date.now = () => now() + 300001;
    assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  } finally {
    Date.now = now;
  }
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'replacement'});
  assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  assert.equal(f.requests.length, 2);
});

test('TikTok portfolio refuses wrong account or hierarchy, unsafe money, unknown wrappers and inconsistent paging', async t => {
  const edits = [
    d => (d.data.list[0].advertiser_id = '200'),
    d => (d.data.list[0].campaign_id = 9007199254740992),
    d => (d.data.list[0].budget = 9007199254740992),
    d => (d.data.list[0].budget = '1e3'),
    d => (d.data.page_info.page = 2),
    d => (d.data.page_info.page_size = 3),
    d => (d.data.page_info.total_number = 5),
    d => (d.data.list = [d.data.list[0], d.data.list[0]]),
    d => (d.code = 40001),
    d => delete d.data.page_info,
    d => (d.data.next_cursor = 'unexpected'),
  ];
  for (const edit of edits) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaign/get/')) edit(d);
      return d;
    });
    assert.equal((await f.call()).success, false, edit.toString());
    assert.equal(f.requests.length, 2);
  }
  for (const [requirements, field] of [
    [{entity: 'adgroup', campaign_id: campaign}, 'campaign_id'],
    [{entity: 'ad', campaign_id: campaign, adgroup_id: group}, 'adgroup_id'],
  ]) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (!u.pathname.endsWith('/advertiser/info/')) d.data.list[0][field] = '2';
      return d;
    });
    assert.equal((await f.call(requirements)).success, false);
    assert.equal(f.requests.length, 2);
  }
});

test('TikTok pagination refuses adjacent duplicate rows and changing totals', async t => {
  for (const reason of ['overlap', 'count']) {
    const f = fixture(t),
      first = ok(await f.call());
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaign/get/')) {
        if (reason === 'overlap') d.data.list[0] = rowCampaign();
        else d.data.page_info.total_number = 4;
      }
      return d;
    });
    assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
    assert.equal(f.requests.length, 4);
  }
});

test('TikTok inventory respects current login and account before and after every native read', async t => {
  for (const reason of ['credentials', 'account']) {
    const f = fixture(t);
    f.edit((_u, d) => {
      f.store.putConnection(
        {...f.actor, role: 'admin'},
        {...f.connection, ...(reason === 'account' ? {accounts: []} : {})},
        reason === 'credentials' ? {accessToken: 'replacement'} : f.credentials,
      );
      return d;
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 1);
  }
});

test('TikTok inventory accepts a verified empty page and refuses malformed inputs without egress', async t => {
  const f = fixture(t);
  for (const requirements of [
    {entity: 'adgroup'},
    {entity: 'campaign', campaign_id: campaign},
    {entity: 'smart_plus'},
    {entity: 'ad', campaign_id: campaign, adgroup_id: 'bad'},
  ])
    assert.equal((await f.call(requirements)).success, false);
  assert.equal(f.requests.length, 0);
  f.edit((u, d) => (u.pathname.endsWith('/campaign/get/') ? page([], 1, 2, 0) : d));
  const empty = ok(await f.call());
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.next_cursor, null);
});
