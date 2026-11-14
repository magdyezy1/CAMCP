// RPT-07: native parent identity on detailed Overview rows whose report response carries none. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {reportTable} from '../dist/src/google-sheets.js';
import {
  detailParents,
  detailParentLimit,
  detailParentsLimitedWarning,
  detailParentsUnavailableWarning,
  optionalReadRefused,
} from '../dist/src/overview-parents.js';
import {MirrorError} from '../dist/src/errors.js';
import {linkedinMetadataUnavailableWarning} from '../dist/src/linkedin-report-source.js';
import {linkedInCreativeMetadata} from '../dist/src/linkedin-detail-parents.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {
  overviewGranularityFixture,
  granularSource,
  granularConfig,
  granularParents,
  granularRange,
} from './fixtures/overview-granularity-data.mjs';
import {snapchatEvidenceAccount, snapchatEvidenceCampaign} from './fixtures/snapchat-evidence-data.mjs';

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  return f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor);
}
const expected = {
  'tiktok:adset': {campaign_id: granularParents.tiktok.campaign, campaign_name: 'Synthetic TikTok campaign'},
  'tiktok:ad': {
    campaign_id: granularParents.tiktok.campaign,
    campaign_name: 'Synthetic TikTok campaign',
    adset_id: granularParents.tiktok.adgroup,
    adset_name: 'Synthetic TikTok ad group',
  },
  'snapchat:ad': {
    campaign_id: snapchatEvidenceCampaign,
    campaign_name: 'Synthetic parent',
    adset_id: granularParents.snapchat.adsquad,
    adset_name: 'Synthetic squad',
  },
  'linkedin:ad': {
    campaign_id: granularParents.linkedin.group,
    campaign_name: 'Synthetic LinkedIn group',
    adset_id: granularParents.linkedin.campaign,
    adset_name: 'Synthetic LinkedIn campaign',
  },
};

test('RPT-07: TikTok ad group and ad, Snapchat ad and LinkedIn creative rows carry their exact native parents, also in the Sheets parent columns', async () => {
  for (const [key, parents] of Object.entries(expected)) {
    const [platform, level] = key.split(':'),
      f = overviewGranularityFixture();
    try {
      const report = await run(f, granularConfig(granularSource(platform, level)));
      assert.equal(report.state, 'complete', key + ' ' + JSON.stringify(report.sources));
      const row = report.rows[0];
      assert.deepEqual(row.parent_ids, parents, key);
      assert.equal(row.campaign_id, parents.campaign_id);
      assert.equal(row.campaign_name, parents.campaign_name);
      assert.equal(report.sources[0].detail_contract, 'overview-detail-v3');
      assert.ok(
        row.lineage.some(entry => entry.stage === (platform === 'linkedin' ? 'creative_metadata' : 'detail_parents')),
        key + ': the parent reads stay in the source lineage',
      );
      const table = reportTable(report),
        headers = table[0];
      assert.equal(table[1][headers.indexOf('Campaign ID')], parents.campaign_id);
      assert.equal(table[1][headers.indexOf('Campaign')], parents.campaign_name);
      assert.equal(table[1][headers.indexOf('Ad set / ad group ID')], parents.adset_id ?? '');
      assert.equal(table[1][headers.indexOf('Ad set / ad group')], parents.adset_name ?? '');
      // Every parent read names only the reported entities of the source account.
      const reads = f.requests.filter(r =>
        /\/v1\.3\/(?:campaign|adgroup|ad)\/get\/$|get_(?:ads|adsquads|campaigns)_by_ids$|\/creatives$|\/adCampaigns$/.test(
          r.url.pathname,
        ),
      );
      assert.ok(reads.length >= 2, key);
      if (platform === 'tiktok') {
        const first = JSON.parse(reads[0].url.searchParams.get('filtering'));
        assert.deepEqual(first[(level === 'ad' ? 'ad' : 'adgroup') + '_ids'], ['9007199254740993']);
        assert.equal(first.primary_status, 'STATUS_ALL');
      }
      if (platform === 'snapchat') {
        assert.deepEqual(reads[0].body, {entity_ids: [{id: row.entity_id}]});
        assert.ok(reads.every(r => r.method === 'POST'));
      }
      if (platform === 'linkedin')
        assert.match(reads[0].url.searchParams.get('creatives'), /urn:li:sponsoredCreative:9007199254740993/);
    } finally {
      f.close();
    }
  }
});

test('RPT-07: a daily detailed report reads each entity’s parents once per source and keeps them on every day', async () => {
  const f = overviewGranularityFixture();
  try {
    const report = await run(f, granularConfig(granularSource('tiktok', 'ad'), 'daily'));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 2);
    for (const row of report.rows) assert.deepEqual(row.parent_ids, expected['tiktok:ad']);
    for (const path of ['/v1.3/ad/get/', '/v1.3/adgroup/get/', '/v1.3/campaign/get/'])
      assert.equal(f.requests.filter(r => r.url.pathname.endsWith(path)).length, 1, path);
    assert.ok(report.rows[1].lineage.some(entry => entry.stage === 'detail_parents' && entry.cached === true));
  } finally {
    f.close();
  }
});

test('RPT-07: drifting, foreign, repeated or parentless parent records refuse the source instead of guessing', async () => {
  const cases = [
    // An ad whose ad group belongs to another campaign: the hierarchy changed between reads.
    [
      'tiktok',
      'ad',
      (url, body) =>
        url.pathname.endsWith('/v1.3/adgroup/get/')
          ? {...body, data: {...body.data, list: body.data.list.map(g => ({...g, campaign_id: '9007199254740009'}))}}
          : body,
      ['REPORT_ACCOUNT_MISMATCH'],
    ],
    [
      'tiktok',
      'adset',
      (url, body) =>
        url.pathname.endsWith('/v1.3/adgroup/get/')
          ? {...body, data: {...body.data, list: body.data.list.map(g => ({...g, advertiser_id: '999'}))}}
          : body,
      ['REPORT_ACCOUNT_MISMATCH'],
    ],
    [
      'tiktok',
      'ad',
      (url, body) =>
        url.pathname.endsWith('/v1.3/ad/get/')
          ? {...body, data: {...body.data, list: body.data.list.map(({adgroup_id, ...ad}) => ad)}}
          : body,
      ['REPORT_SHAPE_CHANGED'],
    ],
    [
      'linkedin',
      'ad',
      (url, body) =>
        url.pathname.endsWith('/creatives')
          ? {...body, elements: body.elements.map(c => ({...c, account: 'urn:li:sponsoredAccount:999'}))}
          : body,
      // V2-PRV-01 refuses explicit foreign ownership at observation, before the report's parent join.
      ['ACCOUNT_SCOPE_MISMATCH'],
    ],
    [
      'linkedin',
      'ad',
      (url, body) =>
        url.pathname.endsWith('/creatives') ? {...body, elements: [...body.elements, ...body.elements]} : body,
      ['REPORT_SHAPE_CHANGED'],
    ],
    [
      'snapchat',
      'ad',
      (url, body) =>
        url.pathname.endsWith('get_campaigns_by_ids')
          ? {...body, campaigns: body.campaigns.map(c => ({...c, campaign: {...c.campaign, ad_account_id: 'other'}}))}
          : body,
      ['REPORT_ACCOUNT_MISMATCH', 'ACCOUNT_SCOPE_MISMATCH'],
    ],
  ];
  for (const [platform, level, hook, codes] of cases) {
    const f = overviewGranularityFixture();
    try {
      f.parents((kind, url, body) => (kind === platform ? hook(url, body) : body));
      const report = await run(f, granularConfig(granularSource(platform, level)));
      assert.equal(report.state, 'failed', platform + ' ' + JSON.stringify(report.sources));
      assert.equal(report.rows.length, 0);
      assert.ok(codes.includes(report.sources[0].error.code), JSON.stringify(report.sources[0].error));
    } finally {
      f.close();
    }
  }
});

test('RPT-07: the LinkedIn creative read refuses a creative of another account itself, whatever refuses it earlier', async () => {
  // The preview observer refuses a foreign creative before the report's parent join (the LinkedIn case above), so the
  // join's own ownership check is exercised here, on the read.
  const own = {
    id: 'urn:li:sponsoredCreative:40',
    account: 'urn:li:sponsoredAccount:100',
    campaign: 'urn:li:sponsoredCampaign:30',
    name: 'Synthetic creative',
  };
  const read = element => linkedInCreativeMetadata('100', [own.id], async () => ({elements: [element]}));
  for (const account of [
    'urn:li:sponsoredAccount:999',
    'urn:li:sponsoredAccount:1000',
    'urn:li:sponsoredAccount:10',
    100,
    '',
    null,
    undefined,
  ])
    await assert.rejects(read({...own, account}), error =>
      assertRefused(error, 'REPORT_ACCOUNT_MISMATCH', {status: 502}),
    );
  const [creative] = await read(own);
  assert.deepEqual([creative.id, creative.campaign, creative.name], [own.id, own.campaign, own.name]);
});

test('RPT-07: a parent read the provider refuses keeps the rows with unknown parents and says so', async () => {
  const refusals = [
    ['linkedin', 'ad', url => (url.pathname.endsWith('/creatives') ? new Response('{}', {status: 403}) : undefined)],
    [
      'tiktok',
      'ad',
      url => (url.pathname.endsWith('/v1.3/ad/get/') ? {code: 40001, message: 'No permission'} : undefined),
    ],
    [
      'snapchat',
      'ad',
      url =>
        url.pathname.endsWith('get_ads_by_ids') ? {request_status: 'ERROR', request_id: 'x', ads: []} : undefined,
    ],
  ];
  for (const [platform, level, refuse] of refusals) {
    const f = overviewGranularityFixture();
    try {
      f.parents((kind, url, body) => (kind === platform ? (refuse(url) ?? body) : body));
      const report = await run(f, granularConfig(granularSource(platform, level)));
      assert.equal(report.state, 'complete', platform + ' ' + JSON.stringify(report.sources));
      const row = report.rows[0];
      assert.equal(row.campaign_id, null);
      assert.deepEqual(row.parent_ids, {});
      assert.ok(
        report.sources[0].warnings.includes(
          platform === 'linkedin' ? linkedinMetadataUnavailableWarning : detailParentsUnavailableWarning,
        ),
        platform,
      );
    } finally {
      f.close();
    }
  }
  // A Snapchat ad the by-ID read does not find keeps unknown parents without borrowing another record.
  const f = overviewGranularityFixture();
  try {
    f.parents((kind, url, body) =>
      kind === 'snapchat' && url.pathname.endsWith('get_ads_by_ids')
        ? {...body, ads: body.ads.map(a => ({sub_request_status: 'ERROR', ad: a.ad}))}
        : body,
    );
    const report = await run(f, granularConfig(granularSource('snapchat', 'ad')));
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.deepEqual(report.rows[0].parent_ids, {});
    assert.equal(report.rows[0].campaign_id, null);
  } finally {
    f.close();
  }
});

test('RPT-07: parents are read for at most the bounded number of entities per source; the rest stay unknown with a warning', async () => {
  const plans = [],
    actor = {tenantId: 'local', userId: 'fixture', role: 'admin'},
    source = {platform: 'tiktok', account_id: '100', connection_id: 'c1', level: 'adset'};
  const service = {
    store: {
      assertActorActive() {},
      resolveConnection: () => ({id: 'c1', scopes: ['advertiser.read'], accounts: ['100']}),
      connectionCredentials: () => ({accessToken: 'synthetic'}),
    },
    async runPlan(plan) {
      plans.push(plan);
      const entity = /\/v1\.3\/(campaign|adgroup)\/get\/$/.exec(plan.path)[1],
        ids = plan.query.filtering[entity + '_ids'];
      return {
        success: true,
        data: {
          code: 0,
          data: {
            list: ids.map(id =>
              entity === 'campaign'
                ? {advertiser_id: '100', campaign_id: id, campaign_name: 'Synthetic'}
                : {advertiser_id: '100', adgroup_id: id, campaign_id: '7'},
            ),
            page_info: {page: 1, page_size: 100, total_number: ids.length, total_page: 1},
          },
        },
      };
    },
  };
  const cache = {parents: {}, lineage: []},
    ids = Array.from({length: detailParentLimit + 1}, (_, i) => String(1000 + i));
  const first = await detailParents(service, source, 'adset', ids, actor, cache);
  assert.equal(Object.keys(first.parents).length, detailParentLimit);
  assert.equal(first.parents[ids.at(-1)], undefined, 'The entity beyond the bound is never given a parent');
  assert.deepEqual(first.parents[ids[0]], {campaign_id: '7', campaign_name: 'Synthetic'});
  assert.deepEqual(first.warnings, [detailParentsLimitedWarning]);
  assert.equal(plans.filter(p => p.path === '/v1.3/adgroup/get/').length, detailParentLimit / 100);
  assert.equal(plans.filter(p => p.path === '/v1.3/campaign/get/').length, 1);
  // A later period reads nothing again for known entities and still never guesses the unread one.
  const before = plans.length,
    second = await detailParents(service, source, 'adset', [ids[0], ids.at(-1)], actor, cache);
  assert.equal(plans.length, before);
  assert.deepEqual(Object.keys(second.parents), [ids[0]]);
  assert.ok(second.lineage.length && second.lineage.every(entry => entry.cached === true));
  assert.deepEqual(second.warnings, [detailParentsLimitedWarning]);
  // Levels whose report rows carry their own parents read nothing.
  const none = await detailParents(service, {...source, platform: 'meta'}, 'ad', ids, actor);
  assert.deepEqual(none, {parents: {}, lineage: [], warnings: []});
});

test('RPT-07: Snapchat ad-squad detail offers the campaigns of the newest readable retained campaign-level snapshot of the same login and account', async () => {
  const f = overviewGranularityFixture();
  try {
    const login = granularSource('snapchat').connection_id,
      account = snapchatEvidenceAccount,
      campaign = i => '33333333-3333-4333-8333-' + String(i).padStart(12, '0'),
      source = {platform: 'snapchat', connection_id: login, account_id: account, level: 'campaign'};
    const snapchatAccount = async () =>
      (await f.overview.handle({action: 'bootstrap'}, f.actor)).platforms
        .find(p => p.id === 'snapchat')
        .accounts.find(a => a.account_id === account && a.connection_id === login);
    // No retained campaign-level snapshot yet: nothing is offered and the UUID stays typed.
    assert.equal((await snapchatAccount()).parent_campaigns, null);
    const row = (id, name, extra = {}) => ({
      platform: 'snapchat',
      connection_id: login,
      account_id: account,
      campaign_id: id,
      campaign_name: name,
      ...extra,
    });
    const put = (id, state, completed_at, sources, rows) =>
      f.store.putDocument(f.actor.tenantId, 'overview_report', id, {
        state,
        ...(completed_at === undefined ? {} : {completed_at}),
        config: {name: 'Retained ' + id, sources, date_range: granularRange, grain: 'total'},
        rows,
      });
    put('older', 'complete', 1000, [source], [row(campaign(1), 'Older campaign')]);
    put(
      'newer',
      'partial',
      2000,
      [source],
      [
        row(campaign(2), 'Spring <launch>'),
        row(campaign(2), 'Spring <launch>'),
        row(campaign(3), null),
        // Only exact campaign-level rows become choices: no malformed IDs, detailed rows or other accounts.
        row('not-a-uuid', 'Malformed'),
        row(campaign(4), 'Ad squad row', {entity_level: 'adset'}),
        row(campaign(5), 'Other account', {account_id: '11111111-1111-4111-8111-000000000999'}),
      ],
    );
    // Newer, but unreadable (a login the actor has no access to), unfinished or without a completion time.
    put(
      'foreign',
      'complete',
      3000,
      [source, {...source, connection_id: 'not-a-login-of-this-workspace'}],
      [row(campaign(6), 'Foreign')],
    );
    put('queued', 'queued', 4000, [source], [row(campaign(7), 'Queued')]);
    put('untimed', 'complete', undefined, [source], [row(campaign(8), 'Untimed')]);
    assert.deepEqual((await snapchatAccount()).parent_campaigns, {
      snapshot_id: 'newer',
      completed_at: 2000,
      campaigns: [
        {id: campaign(2), name: 'Spring <launch>'},
        {id: campaign(3), name: null},
      ],
    });
    // Other platforms' accounts carry no parent choices, and nothing was read from a provider.
    const bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor);
    assert.ok(
      bootstrap.platforms
        .filter(p => p.id !== 'snapchat')
        .every(p => p.accounts.every(a => !Object.hasOwn(a, 'parent_campaigns'))),
    );
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

test('RPT-07: the optional campaign reference preserves dated native IDs and escaped names in English and Arabic', () => {
  const html = (locale, account) => {
    const ctx = createContext({
      document: {addEventListener() {}},
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      reportDay: day => 'DAY(' + day + ')',
    });
    new Script(readFileSync('web/localization.js', 'utf8')).runInContext(ctx);
    if (locale === 'ar') {
      ctx.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
      new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(ctx);
    }
    const source = readFileSync('web/reporting-overview.js', 'utf8'),
      start = source.indexOf('function reportParentChoices(');
    new Script(source.slice(start, source.indexOf('\n}\n', start) + 3)).runInContext(ctx);
    ctx.account = account;
    return new Script('String(reportParentChoices(account))').runInContext(ctx);
  };
  const account = {
    connection_id: 'c',
    account_id: 'a',
    parent_campaigns: {
      snapshot_id: 's',
      completed_at: Date.parse('2026-09-03T10:00:00Z'),
      campaigns: [
        {id: '33333333-3333-4333-8333-000000000002', name: 'Spring <launch>'},
        {id: '33333333-3333-4333-8333-000000000003', name: null},
      ],
    },
  };
  const en = html('en', account);
  assert.match(en, /<code dir="ltr">33333333-3333-4333-8333-000000000002<\/code>/);
  assert.match(en, /<bdi dir="auto" data-native>Spring &lt;launch&gt;<\/bdi>/);
  assert.match(en, /<bdi dir="auto" data-native>33333333-3333-4333-8333-000000000003<\/bdi>/);
  assert.match(en, /Campaign IDs from the report of DAY\(2026-09-03\)/);
  assert.match(html('ar', account), /معرّفات الحملات من تقرير DAY\(2026-09-03\)/);
  assert.doesNotMatch(en, /<input|<select|required|data-report-parent/);
  const plain = html('en', {connection_id: 'c', account_id: 'a', parent_campaigns: null});
  assert.equal(plain, '');
});

test('RPT-07: only a provider refusal skips an optional metadata read; AMCP access refusals and malformed answers fail the source', () => {
  // Regression: the LinkedIn, Apple and Reddit metadata reads judged a refusal by HTTP status alone, so an AMCP scope or
  // account refusal (HTTP 403) kept collecting with unknown names or parents instead of failing the source.
  for (const [code, status] of [
    ['PLATFORM_ERROR', 403],
    ['PROVIDER_PERMISSION_MISSING', 400],
    ['INSUFFICIENT_SCOPE', 403],
    ['NOT_FOUND', 404],
    ['INCOMPLETE_REPORT', 400],
  ])
    assert.equal(optionalReadRefused(new MirrorError(code, 'Synthetic', {}, status)), true, code);
  for (const error of [
    new MirrorError('CONNECTION_REQUIRED', 'Synthetic', {}, 403),
    new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Synthetic', {}, 403),
    new MirrorError('ACCOUNT_REQUIRED', 'Synthetic', {}, 403),
    new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Synthetic', {}, 403),
    new MirrorError('CONNECTION_AUTHORITY_CHANGED', 'Synthetic'),
    new MirrorError('MEMBERSHIP_REVOKED', 'Synthetic', {}, 403),
    // P2B-08: a client access set narrowed during the read (SEC-08) is AMCP's refusal of the account, not the provider's.
    new MirrorError('ACCOUNT_SCOPE_RESTRICTED', 'Synthetic', {}, 403),
    new MirrorError('REPORT_SHAPE_CHANGED', 'Synthetic', {}, 400),
    new MirrorError('REPORT_ACCOUNT_MISMATCH', 'Synthetic', {}, 403),
    new MirrorError('PLATFORM_RATE_LIMIT', 'Synthetic', {}, 429, true),
    new MirrorError('PLATFORM_ERROR', 'Synthetic', {}, 403, true),
    new MirrorError('PLATFORM_ERROR', 'Synthetic', {}, 500),
    new Error('Synthetic'),
  ])
    assert.equal(optionalReadRefused(error), false, error.code ?? error.message);
});
