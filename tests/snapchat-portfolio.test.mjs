import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

const account = '10000000-0000-4000-8000-000000000000',
  campaign = '20000000-0000-4000-8000-000000000001',
  other = '20000000-0000-4000-8000-000000000002',
  squad = '30000000-0000-4000-8000-000000000001',
  ad = '40000000-0000-4000-8000-000000000001';
const wrap = (kind, rows, paging = {}) => ({
  request_status: 'SUCCESS',
  paging,
  [kind]: rows.map(r => ({sub_request_status: 'success', [kind.slice(0, -1)]: r})),
  private: 'PRIVATE-ENVELOPE',
});
const rowCampaign = (id = campaign) => ({
  id,
  name: 'Native campaign',
  ad_account_id: account,
  status: 'ACTIVE',
  daily_budget_micro: '9007199254740993',
  delivery_status: ['INVALID_NOT_ACTIVE'],
  private: 'PRIVATE-ROW',
});
const rowSquad = () => ({
  id: squad,
  name: 'Native squad',
  campaign_id: campaign,
  status: 'PAUSED',
  bid_micro: 1230000,
  daily_budget_micro: 50000000,
  targeting: {private: 'PRIVATE-TARGETING'},
});
const rowAd = () => ({
  id: ad,
  name: 'Native ad',
  ad_squad_id: squad,
  status: 'ACTIVE',
  review_status: 'PENDING',
  delivery_status: ['INVALID_NOT_ACTIVE'],
  creative_id: '50000000-0000-4000-8000-000000000001',
});
function fixture(t) {
  const actor = {tenantId: 'snap-portfolio', userId: 'reader', role: 'reader'},
    store = new Store(':memory:', Buffer.alloc(32, 101).toString('base64'));
  t.after(() => store.close());
  const connection = {
    id: 'dddddddd-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'snapchat_native_action',
    enabled: true,
    label: 'Synthetic Snapchat',
    accounts: [account],
    scopes: ['snapchat-marketing-api'],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const requests = [];
  let edit = (_url, data) => data;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(url);
        requests.push({url: u, method: init.method});
        let data;
        if (u.pathname === '/v1/adaccounts/' + account)
          data = wrap('adaccounts', [
            {id: account, currency: 'SAR', timezone: 'Asia/Riyadh', billing: 'PRIVATE-BILLING'},
          ]);
        else if (u.pathname === '/v1/adaccounts/' + account + '/campaigns')
          data = wrap(
            'campaigns',
            [rowCampaign(u.searchParams.has('cursor') ? other : campaign)],
            u.searchParams.has('cursor')
              ? {}
              : {
                  next_link:
                    'https://adsapi.snapchat.com' + u.pathname + '?cursor=c%2B%2F%3D%3D&limit=50&sort=created_at-desc',
                },
          );
        else if (u.pathname === '/v1/campaigns/' + campaign) data = wrap('campaigns', [rowCampaign()]);
        else if (u.pathname === '/v1/campaigns/' + campaign + '/adsquads') data = wrap('adsquads', [rowSquad()]);
        else if (u.pathname === '/v1/adsquads/' + squad) data = wrap('adsquads', [rowSquad()]);
        else if (u.pathname === '/v1/adsquads/' + squad + '/ads') data = wrap('ads', [rowAd()]);
        else throw Error('Unexpected native route ' + u.pathname);
        return Response.json(edit(u, data));
      },
      async () => {},
    ),
  );
  return {
    actor,
    store,
    connection,
    requests,
    edit: fn => {
      edit = fn;
    },
    call: (requirements = {entity: 'campaign'}, extra = {}) =>
      service.call(
        'amcp_workspace',
        {
          action: 'portfolio',
          gateway: 'snapchat_native_action',
          account_id: account,
          connection_id: connection.id,
          limit: 50,
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

test('Snapchat portfolio reads exact campaign inventory with bounded native pagination and integer micros', async t => {
  const f = fixture(t),
    first = ok(await f.call());
  assert.equal(first.rows[0].native_money.daily_budget_micro, '9007199254740993');
  assert.equal(first.rows[0].currency, 'SAR');
  assert.equal(first.rows[0].timezone, 'Asia/Riyadh');
  assert.deepEqual(first.rows[0].delivery_status, ['INVALID_NOT_ACTIVE']);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-|accessToken/);
  const second = ok(await f.call({entity: 'campaign'}, {cursor: first.next_cursor}));
  assert.equal(second.rows[0].id, other);
  assert.equal(second.has_more, false);
  assert.equal(f.requests.at(-1).url.searchParams.get('cursor'), 'c+/==');
  assert.ok(f.requests.every(r => r.method === 'GET' && r.url.origin === 'https://adsapi.snapchat.com'));
  assert.equal(f.requests.at(-1).url.searchParams.get('limit'), '50');
  assert.equal(first.record_kind, 'portfolio');
});

test('Snapchat portfolio requires its qualified parents, freshly verifies the hierarchy and withholds native targeting', async t => {
  const f = fixture(t);
  assert.equal((await f.call({entity: 'adsquad', campaign_id: campaign})).success, false);
  assert.equal(f.requests.length, 0);
  ok(await f.call());
  const s = ok(await f.call({entity: 'adsquad', campaign_id: campaign}));
  assert.equal(s.rows[0].native_money.bid_micro, '1230000');
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE-TARGETING|"targeting"/);
  const a = ok(await f.call({entity: 'ad', campaign_id: campaign, ad_squad_id: squad}));
  assert.equal(a.rows[0].review_status, 'PENDING');
  assert.equal(a.rows[0].status, 'ACTIVE');
  assert.equal(a.rows[0].campaign_id, campaign);
  assert.equal(a.rows[0].native.campaign_id, null, 'resolved parent scope must not invent a native field');
  assert.equal(a.rows[0].native.ad_account_id, null);
  f.edit((u, d) => {
    if (u.pathname === '/v1/adsquads/' + squad) d.adsquads[0].adsquad.campaign_id = other;
    return d;
  });
  assert.equal((await f.call({entity: 'ad', campaign_id: campaign, ad_squad_id: squad})).success, false);
});

test('Snapchat continuations reject tampering and changed page sizes before egress', async t => {
  const f = fixture(t),
    first = ok(await f.call()),
    count = f.requests.length;
  for (const args of [
    {cursor: first.next_cursor + 'x'},
    {cursor: first.next_cursor, limit: 51},
    {cursor: Buffer.from('{}').toString('base64url')},
  ])
    assert.equal((await f.call({entity: 'campaign'}, args)).success, false);
  assert.equal(f.requests.length, count);
});

test('Snapchat inventory rejects foreign scopes, failed rows, unknown envelopes, unsafe money and malformed paging', async t => {
  for (const edit of [
    d => ({...d, request_status: 'ERROR'}),
    d => ({...d, campaigns: [], paging: {next_link: 'https://evil.test/?cursor=x'}}),
    d => {
      d.campaigns[0].sub_request_status = 'ERROR';
      return d;
    },
    d => {
      d.campaigns[0].campaign.ad_account_id = other;
      return d;
    },
    d => {
      d.campaigns[0].campaign.daily_budget_micro = 9007199254740992;
      return d;
    },
    d => {
      d.campaigns[0].campaign.daily_budget_micro = '1.5';
      return d;
    },
    d => {
      d.campaigns.push(d.campaigns[0]);
      return d;
    },
    d => ({
      ...d,
      paging: {next_link: 'https://adsapi.snapchat.com/v1/adaccounts/' + account + '/campaigns?cursor=x&limit=100'},
    }),
    d => ({
      ...d,
      paging: {
        next_link: 'https://adsapi.snapchat.com/v1/adaccounts/' + account + '/campaigns?cursor=x&access_token=private',
      },
    }),
    () => ({}),
  ]) {
    const f = fixture(t);
    f.edit((u, d) => (u.pathname.endsWith('/campaigns') ? edit(d) : d));
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 2, 'the malformed response was reached after the account read');
  }
});

test('Snapchat adjacent overlap and repeated provider cursors cannot become a valid continuation', async t => {
  for (const mode of ['overlap', 'cursor']) {
    const f = fixture(t),
      first = ok(await f.call());
    f.edit((u, d) => {
      if (u.searchParams.has('cursor')) {
        if (mode === 'overlap') d.campaigns[0].campaign.id = campaign;
        else d.paging = {next_link: 'https://adsapi.snapchat.com' + u.pathname + '?cursor=c%2B%2F%3D%3D&limit=50'};
      }
      return d;
    });
    assert.equal((await f.call({entity: 'campaign'}, {cursor: first.next_cursor})).success, false);
  }
});

test('Snapchat authorization withdrawal or replacement during a read withholds the entire portfolio', async t => {
  for (const mode of ['disabled', 'replaced']) {
    const f = fixture(t);
    f.edit((u, d) => {
      if (u.pathname.endsWith('/campaigns'))
        f.store.putConnection(
          {...f.actor, role: 'admin'},
          {...f.connection, enabled: mode !== 'disabled'},
          {accessToken: mode === 'replaced' ? 'replacement' : 'synthetic'},
        );
      return d;
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.requests.length, 2);
  }
});

test('Snapchat page sizes and parent fields follow the qualified native contract before any request', async t => {
  const f = fixture(t);
  for (const [requirements, extra] of [
    [{entity: 'campaign'}, {limit: 1}],
    [{entity: 'campaign'}, {limit: 101}],
    [{entity: 'ad'}, {}],
    [{entity: 'campaign', campaign_id: campaign}, {}],
    [{entity: 'campaign'}, {account_id: 'not-an-id'}],
    [{entity: 'adset'}, {}],
  ])
    assert.equal((await f.call(requirements, extra)).success, false);
  assert.equal(f.requests.length, 0);
});
