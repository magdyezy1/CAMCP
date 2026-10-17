// RPT-07 (B27): the Microsoft Advertising portfolio adapter. Synthetic Microsoft v13 JSON responses through the real
// gateway, transport and response validation; nothing leaves the process and nothing is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {microsoftScope} from '../dist/src/microsoft-native.js';
import {microsoftAdTypes, microsoftCampaignTypes} from '../dist/src/microsoft-portfolio.js';

const gateway = 'microsoft_ads_native_action';
const actor = {tenantId: 'microsoft-portfolio', userId: 'reader', role: 'admin'};
const campaign = (id, extra = {}) => ({
  Id: id,
  Name: 'Campaign ' + id,
  Status: 'Active',
  CampaignType: 'Search',
  BudgetType: 'DailyBudgetStandard',
  DailyBudget: 25.5,
  TimeZone: 'EasternTimeUSCanada',
  ...extra,
});
const adGroup = (id, extra = {}) => ({
  Id: id,
  Name: 'Ad group ' + id,
  Status: 'Paused',
  AdGroupType: 'SearchStandard',
  Network: 'OwnedAndOperatedAndSyndicatedSearch',
  CpcBid: {Amount: 0.75},
  ...extra,
});
const ad = (id, extra = {}) => ({
  Id: id,
  Type: 'ResponsiveSearch',
  Status: 'Active',
  EditorialStatus: 'Active',
  ...extra,
});
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 47).toString('base64')),
    connection = {
      id: 'ms',
      tenantId: actor.tenantId,
      label: 'Synthetic Microsoft',
      gateway,
      accounts: ['123'],
      accountCustomers: {123: '456'},
      scopes: [microsoftScope],
      enabled: true,
    };
  store.putConnection(actor, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const requests = [];
  let collections = {
      campaigns: () => [campaign('9007199254740993'), campaign('11'), campaign('12', {CampaignType: 'PerformanceMax'})],
      adGroups: () => [adGroup('21'), adGroup('22')],
      ads: () => [ad('31'), ad('32', {Type: 'ExpandedText', TitlePart1: 'Spring <sale>'})],
    },
    edit = body => body;
  const transport = new NativeTransport(
    async (raw, init) => {
      const url = new URL(String(raw)),
        body = JSON.parse(String(init.body));
      assert.equal(init.method, 'POST');
      requests.push({path: url.pathname, body});
      const route = url.pathname;
      let out;
      if (route === '/CustomerManagement/v13/Account/Query')
        out = {Account: {Id: '123', Name: 'Synthetic', CurrencyCode: 'USD', TimeZone: 'EasternTimeUSCanada'}};
      else if (route === '/CampaignManagement/v13/Campaigns/QueryByAccountId')
        out = {Campaigns: collections.campaigns()};
      else if (route === '/CampaignManagement/v13/Campaigns/QueryByIds')
        out = {Campaigns: body.CampaignIds.map(id => collections.campaigns().find(c => c.Id === id) ?? null)};
      else if (route === '/CampaignManagement/v13/AdGroups/QueryByCampaignId') out = {AdGroups: collections.adGroups()};
      else if (route === '/CampaignManagement/v13/AdGroups/QueryByIds')
        out = {AdGroups: body.AdGroupIds.map(id => collections.adGroups().find(g => g.Id === id) ?? null)};
      else if (route === '/CampaignManagement/v13/Ads/QueryByAdGroupId') out = {Ads: collections.ads()};
      else throw Error('Unexpected Microsoft route ' + route);
      return Response.json(edit(out, route, body));
    },
    async () => {},
  );
  const service = new MirrorService(new Registry(), store, transport);
  const call = (args = {}) =>
    service.call(
      'amcp_workspace',
      {action: 'portfolio', gateway, account_id: '123', connection_id: 'ms', limit: 2, ...args},
      actor,
    );
  t?.after(() => store.close());
  return {
    store,
    requests,
    call,
    service,
    set: value => {
      collections = {...collections, ...value};
    },
    edit: fn => {
      edit = fn;
    },
  };
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r.error ?? r));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false, JSON.stringify(r.data ?? r));
  assert.equal(r.error.code, code, JSON.stringify(r.error));
};

test('campaigns of every documented type are read once, served in ascending native ID order, with exact decimal money', async t => {
  const f = fixture(t),
    first = ok(await f.call({requirements: {entity: 'campaign'}}));
  const read = f.requests.find(r => r.path === '/CampaignManagement/v13/Campaigns/QueryByAccountId');
  // GetCampaignsByAccountId returns only Search campaigns unless the types are named.
  assert.equal(read.body.CampaignType, microsoftCampaignTypes.join(','));
  assert.equal(read.body.AccountId, '123');
  assert.deepEqual(
    first.rows.map(r => r.id),
    ['11', '12'],
  );
  assert.equal(first.collection_size, 3);
  assert.equal(first.has_more, true);
  assert.equal(first.rows[0].native_money.DailyBudget, '25.5');
  assert.equal(first.rows[0].currency, 'USD');
  assert.equal(first.rows[1].native.CampaignType, 'PerformanceMax');
  const second = ok(await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor}));
  assert.deepEqual(
    second.rows.map(r => r.id),
    ['9007199254740993'],
    'exact int64 IDs, numerically ordered',
  );
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  assert.equal(second.page_number, 2);
  // Read-only: only the account and campaign query routes were used.
  assert.ok(f.requests.every(r => /\/(Account\/Query|Campaigns\/QueryByAccountId)$/.test(r.path)));
});

test('ad groups and ads require their parents read first, confirm the current hierarchy and keep the native ad types', async t => {
  const f = fixture(t);
  refused(await f.call({requirements: {entity: 'ad_group', campaign_id: '11'}}), 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.requests.length, 0, 'nothing is read before the parent was observed');
  ok(await f.call({requirements: {entity: 'campaign'}}));
  const groups = ok(await f.call({requirements: {entity: 'ad_group', campaign_id: '11'}}));
  assert.deepEqual(
    groups.rows.map(r => [r.id, r.campaign_id, r.native_money.CpcBid]),
    [
      ['21', '11', '0.75'],
      ['22', '11', '0.75'],
    ],
  );
  const parent = f.requests.find(r => r.path.endsWith('/Campaigns/QueryByIds'));
  assert.deepEqual(parent.body.CampaignIds, ['11']);
  // An ad group must be observed before its ads, and its parent campaign is confirmed again.
  refused(
    await f.call({requirements: {entity: 'ad', campaign_id: '11', ad_group_id: '99'}}),
    'RESOURCE_SCOPE_REQUIRED',
  );
  const ads = ok(await f.call({requirements: {entity: 'ad', campaign_id: '11', ad_group_id: '21'}}));
  const read = f.requests.find(r => r.path.endsWith('/Ads/QueryByAdGroupId'));
  assert.deepEqual(read.body.AdTypes, [...microsoftAdTypes]);
  assert.deepEqual(
    ads.rows.map(r => [r.id, r.name, r.ad_group_id]),
    [
      ['31', '31', '21'],
      ['32', 'Spring <sale>', '21'],
    ],
  );
});

test('a parent that no longer belongs to the account or campaign refuses the child read', async t => {
  const f = fixture(t);
  ok(await f.call({requirements: {entity: 'campaign'}}));
  ok(await f.call({requirements: {entity: 'ad_group', campaign_id: '11'}}));
  // The campaign confirmation read returns nothing for the parent: it moved or was removed.
  f.edit((body, route) => (route.endsWith('/Campaigns/QueryByIds') ? {Campaigns: [null]} : body));
  refused(await f.call({requirements: {entity: 'ad_group', campaign_id: '11'}}), 'STATE_TARGET_MISMATCH');
  f.edit((body, route) => (route.endsWith('/AdGroups/QueryByIds') ? {AdGroups: [adGroup('29')]} : body));
  refused(await f.call({requirements: {entity: 'ad', campaign_id: '11', ad_group_id: '21'}}), 'STATE_TARGET_MISMATCH');
});

test('a collection above the bound is refused, never truncated; malformed, repeated and undocumented rows are refused', async t => {
  const f = fixture(t);
  f.set({campaigns: () => Array.from({length: 1001}, (_, i) => campaign(String(100 + i)))});
  refused(await f.call({requirements: {entity: 'campaign'}}), 'PORTFOLIO_COLLECTION_LIMIT');
  for (const rows of [
    [campaign('11'), campaign('11')],
    [campaign('11', {CampaignType: 'Video'})],
    [campaign('11', {DailyBudget: -1})],
  ]) {
    f.set({campaigns: () => rows});
    refused(await f.call({requirements: {entity: 'campaign'}}), 'PORTFOLIO_INVALID_RESPONSE');
  }
});

test('cursors bind the actor, login, hierarchy, page size and collection content; a changed collection restarts', async t => {
  const f = fixture(t),
    first = ok(await f.call({requirements: {entity: 'campaign'}}));
  for (const args of [
    {limit: 3},
    {requirements: {entity: 'campaign'}, account_id: '123', connection_id: 'ms', limit: 1},
    {requirements: {entity: 'ad_group', campaign_id: '11'}},
  ])
    refused(await f.call({requirements: {entity: 'campaign'}, ...args, cursor: first.next_cursor}), 'INVALID_CURSOR');
  const forged = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
  forged.offset = 4;
  refused(
    await f.call({
      requirements: {entity: 'campaign'},
      cursor: Buffer.from(JSON.stringify(forged)).toString('base64url'),
    }),
    'INVALID_CURSOR',
  );
  const other = {...actor, userId: 'someone-else'};
  const foreign = await f.service.call(
    'amcp_workspace',
    {
      action: 'portfolio',
      gateway,
      account_id: '123',
      connection_id: 'ms',
      limit: 2,
      requirements: {entity: 'campaign'},
      cursor: first.next_cursor,
    },
    other,
  );
  assert.equal(foreign.success, false);
  // A campaign added between pages changes the collection: the next page is refused, not merged.
  f.set({campaigns: () => [campaign('9007199254740993'), campaign('11'), campaign('12'), campaign('13')]});
  refused(await f.call({requirements: {entity: 'campaign'}, cursor: first.next_cursor}), 'PORTFOLIO_CHANGED');
});

test('two complete Microsoft reads reconcile: matching collections, then an added and a changed campaign', async t => {
  const f = fixture(t),
    input = {
      action: 'portfolio_reconcile',
      gateway,
      account_id: '123',
      connection_id: 'ms',
      requirements: {entity: 'campaign'},
      limit: 2,
      max_entities: 10,
      max_pages: 5,
    };
  const same = ok(await f.service.call('amcp_workspace', input, actor));
  assert.equal(same.status, 'same_supported_fields');
  assert.equal(same.rows.length, 3);
  assert.equal(same.observations[0].content_sha256, same.observations[1].content_sha256);
  assert.equal(same.coverage.absence_authorizes_delete, false);
  let scan = 0;
  f.set({
    campaigns: () => {
      scan++;
      // Each observation reads two pages; the second observation sees a renamed and an added campaign.
      return scan <= 2
        ? [campaign('11'), campaign('12'), campaign('13')]
        : [campaign('11', {Name: 'Renamed'}), campaign('12'), campaign('13'), campaign('14')];
    },
  });
  const changed = ok(await f.service.call('amcp_workspace', input, actor));
  assert.equal(changed.status, 'changes_observed');
  assert.deepEqual(
    changed.changes.observed_added.map(r => r.id),
    ['14'],
  );
  assert.deepEqual(
    changed.changes.supported_fields_changed.map(r => [r.id, r.after.name]),
    [['11', 'Renamed']],
  );
  assert.equal(changed.provider_mutations, 0);
});

test('the Portfolio page lists Microsoft accounts and names its money in both languages', () => {
  // WEB-07: the Live portfolio page is its own module.
  const source = readFileSync('web/portfolio.js', 'utf8');
  assert.match(source, /accountChoices\(\['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x', 'microsoft'\]\)/);
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const text of [
    'Browse current Google Ads, Meta, LinkedIn, Snapchat, TikTok, X and Microsoft Advertising inventory. Inventory is read-only; provider changes require a separate review.',
    'Microsoft native decimal account-currency amounts · unconverted',
    'The Microsoft inventory changed since the first page. Restart from the first page.',
  ]) {
    assert.ok(source.includes(text) || text.startsWith('The Microsoft'), text);
    assert.match(catalog[text], /[؀-ۿ]/u, text);
  }
  // The hierarchy follows Google's ad_group naming, so drill-down and URL state work unchanged.
  const ctx = createContext({uiText: s => s, pretty: s => s});
  new Script(
    source.slice(
      source.indexOf('function portfolioEntityLabel('),
      source.indexOf('function portfolioReconciliationView('),
    ),
  ).runInContext(ctx);
  assert.equal(new Script("portfolioEntityLabel('ad_group')").runInContext(ctx), 'Ad Group');
});
