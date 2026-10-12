// RPT-07: native parent identity on detailed Overview rows whose report response carries none. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportTable} from '../dist/src/google-sheets.js';
import {
  detailParents,
  detailParentLimit,
  detailParentsLimitedWarning,
  detailParentsUnavailableWarning,
} from '../dist/src/overview-parents.js';
import {
  overviewGranularityFixture,
  granularSource,
  granularConfig,
  granularParents,
} from './fixtures/overview-granularity-data.mjs';
import {snapchatEvidenceCampaign} from './fixtures/snapchat-evidence-data.mjs';

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
  'linkedin:ad': {campaign_id: granularParents.linkedin.campaign, campaign_name: 'Synthetic LinkedIn campaign'},
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
        row.lineage.some(entry => entry.stage === 'detail_parents'),
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
      ['REPORT_ACCOUNT_MISMATCH'],
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
      assert.ok(report.sources[0].warnings.includes(detailParentsUnavailableWarning), platform);
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
