// RPT-05: report state presentation. A partial snapshot says which sources are missing, a queued run says how long it
// has waited and when no worker has started it, polling backs off and stops, and an open snapshot is URL-addressable.
// Each test names the defect it guards against. All data are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';

const arabic = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

function browserFixture({locale = 'en', role = 'owner', search = '', reply} = {}) {
  const root = {
      innerHTML: '',
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
    },
    timers = [],
    urls = [],
    clock = {now: Date.parse('2026-10-11T08:00:00Z')};
  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }
  const context = createContext({
    api: async (_url, options) => ({success: true, data: await reply(JSON.parse(options.body))}),
    Intl,
    Date: FakeDate,
    URLSearchParams,
    setTimeout: (fn, ms) => timers.push(ms),
    clearTimeout() {},
    pollTimer: null,
    deliveryTimer: null,
    session: {workspaceRole: role, authenticated: true},
    document: {querySelector: () => null, querySelectorAll: () => [], addEventListener() {}},
    location: {pathname: '/reporting-overview', search},
    history: {
      state: null,
      replaceState(_state, _title, url) {
        urls.push(url);
        context.location.search = url.slice(url.indexOf('?'));
      },
    },
    authBind() {},
    workspaceBind() {},
    toast() {},
    date: () => '',
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    $: selector => (selector === '#overview-results' ? root : null),
  });
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = arabic;
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  new Script(
    "overviewState.bootstrap={platforms:[{id:'meta',name:'Meta'},{id:'tiktok',name:'TikTok'},{id:'google',name:'Google Ads'}],metrics:{spend:{label:'Spend',format:'currency'},clicks:{label:'Clicks',format:'number'},cpc:{label:'CPC',format:'currency'}}}",
  ).runInContext(context);
  return {root, timers, urls, clock, context, run: code => new Script(code).runInContext(context)};
}

const meta = {platform: 'meta', account_id: '100', connection_id: 'login-meta'},
  tiktok = {platform: 'tiktok', account_id: '200', connection_id: 'login-tiktok'};
const partialSnapshot = () => ({
  id: 'snapshot-partial',
  state: 'partial',
  rows: [],
  row_count: 1,
  sources: [
    {
      source: meta,
      complete: true,
      row_count: 1,
      quality: {version: 1, pages_collected: true},
      currency: 'USD',
      timezone: 'UTC',
    },
    {
      source: tiktok,
      complete: false,
      row_count: 0,
      error: {code: 'REPORT_PERIODS_FAILED', message: 'Every period failed.'},
    },
  ],
  summary: [
    {
      platform: 'meta',
      account_id: '100',
      currency: 'USD',
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      objective_group: 'sales',
      campaign_count: 1,
      metrics: {spend: 10, clicks: 5, cpc: 2},
      decisions: {observe: 1},
    },
  ],
  exports: [],
  config: {
    name: 'Partial report',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    metrics: ['spend'],
    custom_metrics: [],
    sources: [meta, tiktok],
    source_contract_version: 'campaign-source-v4',
  },
  job: {state: 'complete'},
});
const queuedSnapshot = job => ({
  ...partialSnapshot(),
  id: 'snapshot-queued',
  state: 'queued',
  sources: [],
  summary: [],
  row_count: 0,
  job: {state: 'queued', attempts: 0, ...job},
});

test('RPT-05: a partial snapshot shows a status strip naming the failed source and jump links', async () => {
  // Before RPT-05 a partial snapshot showed only a muted "Partial ·" heading; summary cards did not name excluded
  // sources and a failed source read "Legacy snapshot: measurement-quality metadata was not recorded."
  const f = browserFixture({reply: () => partialSnapshot()});
  await f.run("loadOverviewReport('snapshot-partial')");
  const html = f.root.innerHTML;
  assert.match(html, /class="report-status-strip"/);
  assert.match(
    html,
    /1 of 2 sources failed: <a href="#report-source-1"><bdi>TikTok · 200<\/bdi><\/a> <code>REPORT_PERIODS_FAILED<\/code>\. Totals exclude them\./,
  );
  assert.match(html, /<details id="report-source-1" class="source-health attention"/);
  assert.match(html, /Excludes: TikTok · 200 \(source failed\)\./);
  assert.match(html, /No quality metadata — source failed\./);
  assert.ok(!html.includes('Legacy snapshot'), 'Legacy is reserved for snapshots without a source contract');
});

test('RPT-05: a limited-coverage source is named in the strip and on its summary card', async () => {
  const snapshot = partialSnapshot();
  snapshot.sources = [{...snapshot.sources[0], complete: false}];
  const f = browserFixture({reply: () => snapshot});
  await f.run("loadOverviewReport('snapshot-partial')");
  assert.match(f.root.innerHTML, /1 of 1 sources have limited coverage: <a href="#report-source-0"><bdi>Meta · 100/);
  assert.match(
    f.root.innerHTML,
    /<p class="report-card-footer">Limited coverage: these totals may be incomplete\.<\/p>/,
  );
  assert.ok(!f.root.innerHTML.includes('Excludes:'));
});

test('RPT-05: a complete snapshot has no status strip, and a snapshot without a source contract stays Legacy', async () => {
  const snapshot = {...partialSnapshot(), state: 'complete'};
  snapshot.sources = [{...snapshot.sources[0], quality: undefined}];
  snapshot.config = {...snapshot.config, source_contract_version: undefined};
  const f = browserFixture({reply: () => snapshot});
  await f.run("loadOverviewReport('snapshot-partial')");
  assert.ok(!f.root.innerHTML.includes('report-status-strip'));
  assert.match(f.root.innerHTML, /Legacy snapshot: measurement-quality metadata was not recorded\./);
});

test('RPT-05: the partial strip, card footer and failed-source label are Arabic in the Arabic interface', async () => {
  const f = browserFixture({locale: 'ar', reply: () => partialSnapshot()});
  await f.run("loadOverviewReport('snapshot-partial')");
  const html = f.root.innerHTML;
  assert.match(html, /فشل 1 من أصل 2 مصادر: <a href="#report-source-1"><bdi>TikTok · 200<\/bdi><\/a>/);
  assert.ok(html.includes(arabic['No quality metadata — source failed.']));
  assert.ok(html.includes('لا تشمل: TikTok · 200 (فشل المصدر).'));
});

test('RPT-05: a run queued past the stall threshold says AMCP has not started it and links owners to worker health', async () => {
  // Before RPT-05 a snapshot queued for over an hour showed only "QUEUED · 0 rows" and "Attempt 1".
  const f = browserFixture({reply: () => queuedSnapshot({queued_ms: 10 * 60000 + 1, worker_recent: true})});
  await f.run("loadOverviewReport('snapshot-queued')");
  assert.match(f.root.innerHTML, /Queued for 10 minutes/);
  assert.match(f.root.innerHTML, /AMCP has not started this run yet/);
  assert.match(f.root.innerHTML, /href="\/settings#owner-worker-health"/);
  const viewer = browserFixture({
    role: 'viewer',
    reply: () => queuedSnapshot({queued_ms: 11 * 60000, worker_recent: true}),
  });
  await viewer.run("loadOverviewReport('snapshot-queued')");
  assert.match(viewer.root.innerHTML, /AMCP has not started this run yet/);
  assert.ok(!viewer.root.innerHTML.includes('owner-worker-health'), 'only owners get the worker-health link');
});

test('RPT-05: a recent queue shows its elapsed time without a stall notice unless no worker has reported', async () => {
  const fresh = browserFixture({reply: () => queuedSnapshot({queued_ms: 90000, worker_recent: true})});
  await fresh.run("loadOverviewReport('snapshot-queued')");
  assert.match(fresh.root.innerHTML, /Queued for 1 minute</);
  assert.ok(!fresh.root.innerHTML.includes('report-stall'));
  const noWorker = browserFixture({reply: () => queuedSnapshot({queued_ms: 30000, worker_recent: false})});
  await noWorker.run("loadOverviewReport('snapshot-queued')");
  assert.match(noWorker.root.innerHTML, /Queued for less than a minute/);
  assert.match(noWorker.root.innerHTML, /AMCP has not started this run yet/);
  assert.match(noWorker.root.innerHTML, /No background worker has reported in the last few minutes/);
  const arabicStall = browserFixture({locale: 'ar', reply: () => queuedSnapshot({queued_ms: 75 * 60000})});
  await arabicStall.run("loadOverviewReport('snapshot-queued')");
  assert.ok(arabicStall.root.innerHTML.includes('في قائمة الانتظار منذ 1 س 15 د'));
  assert.ok(arabicStall.root.innerHTML.includes(arabic['AMCP has not started this run yet']));
});

test('RPT-05: polling backs off from 3 s to 15 s to 60 s and stops after 30 minutes with a Refresh button', async () => {
  // Before RPT-05 the page polled every 3 s for as long as the job stayed queued.
  const f = browserFixture({reply: () => queuedSnapshot({queued_ms: 0, worker_recent: true})});
  const load = async minutes => {
    f.clock.now = Date.parse('2026-10-11T08:00:00Z') + minutes * 60000;
    await f.run("loadOverviewReport('snapshot-queued')");
  };
  await load(0);
  await load(0.5);
  await load(2);
  await load(6);
  await load(29);
  assert.deepEqual(f.timers, [3000, 3000, 15000, 60000, 60000]);
  await load(31);
  assert.equal(f.timers.length, 5, 'no further automatic refresh');
  assert.match(f.root.innerHTML, /Automatic refresh stopped after 30 minutes/);
  assert.match(f.root.innerHTML, /id="report-refresh"/);
  // Refresh starts a new watch: polling resumes at 3 s.
  f.run('overviewState.watch=null');
  await load(31);
  assert.equal(f.timers.at(-1), 3000);
  assert.ok(!f.root.innerHTML.includes('id="report-refresh"'));
});

test('RPT-05: an opened snapshot is URL-addressable and keeps the saved report it came from', async () => {
  const f = browserFixture({reply: () => partialSnapshot()});
  f.run("overviewState.selection={kind:'view',id:'view-1',revision:2}");
  await f.run("loadOverviewReport('snapshot-partial')");
  assert.deepEqual(f.urls, ['/reporting-overview?view_id=view-1&report_id=snapshot-partial']);
  // Paging or polling the same snapshot does not rewrite the address again.
  await f.run("loadOverviewReport('snapshot-partial', 1)");
  assert.equal(f.urls.length, 1);
  const plain = browserFixture({reply: () => partialSnapshot(), search: '?report_id=other'});
  await plain.run("loadOverviewReport('snapshot-partial')");
  assert.deepEqual(plain.urls, ['/reporting-overview?report_id=snapshot-partial']);
});

test('RPT-05: counts use the singular form for one row', async () => {
  // Before RPT-05 the snapshot list read "1 rows".
  const f = browserFixture({reply: () => ({})});
  assert.match(f.run("renderOverviewHistory([{id:'a',config:{name:'A'},row_count:1}],false)"), /1 row ↗/);
  assert.match(f.run("renderOverviewHistory([{id:'a',config:{name:'A'},row_count:2}],false)"), /2 rows ↗/);
  assert.equal(f.run("uiPlural(1,'{count} campaign','{count} campaigns')"), '1 campaign');
  assert.equal(f.run("uiPlural(1500,'{count} campaign','{count} campaigns')"), '1,500 campaigns');
});

async function runOnce(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  return queued.id;
}

test('RPT-05: the snapshot reports queued time, start time and recent worker heartbeats for the stall signal', async t => {
  const f = overviewGranularityFixture();
  try {
    const id = await runOnce(f, granularConfig(granularSource('meta', 'ad')));
    const queued = await f.overview.handle({action: 'get', id}, f.actor);
    assert.equal(queued.job.state, 'queued');
    assert.equal(typeof queued.job.queued_at, 'number');
    assert.equal(queued.job.started_at, null);
    assert.ok(queued.job.queued_ms >= 0 && queued.job.queued_ms < 60000);
    assert.equal(queued.job.worker_recent, false, 'no worker has sent a heartbeat in this fixture');
    // A fake clock ten minutes later: the queued time grows while no worker starts the run.
    const realNow = Date.now,
      later = realNow() + 10 * 60000;
    t.mock.method(Date, 'now', () => later);
    const stalled = await f.overview.handle({action: 'get', id}, f.actor);
    assert.ok(stalled.job.queued_ms >= 10 * 60000, String(stalled.job.queued_ms));
    t.mock.restoreAll();
    // A worker heartbeat makes the worker recent; finishing the run removes the wait fields.
    f.worker.heartbeat();
    assert.equal((await f.overview.handle({action: 'get', id}, f.actor)).job.worker_recent, true);
    assert.equal(await f.worker.once(), true);
    const done = await f.overview.handle({action: 'get', id}, f.actor);
    assert.equal(done.job.state, 'complete');
    assert.equal(typeof done.started_at, 'number');
    assert.equal(done.job.queued_ms, undefined);
    assert.equal(done.job.worker_recent, undefined);
  } finally {
    f.close();
  }
});
