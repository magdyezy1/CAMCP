// Package website-get (W5): what the report page asks `get` for. A load asks for a page of rows, and for the charts where the
// script that draws them is loaded: never for the provider's own rows (include.native) or the lineage, which load when a
// disclosure is opened (W2, W3). The answers are the real server's (run, worker, row assembly, `get`), and the page's scripts
// run in a VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {granular, catalog, esc} from './helpers/report-lazy-page.mjs';

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
};

/** The report builder's page with `reply` answering `api`, the requests it made, and the poll timers it set. */
function browser({reply, charts = false, bootstrap}) {
  const requests = [],
    timers = [],
    root = {
      innerHTML: '',
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
    },
    context = createContext({
      api: async (_url, options) => {
        const input = JSON.parse(options.body);
        requests.push(input);
        return {success: true, data: await reply(input)};
      },
      Intl,
      Date,
      URLSearchParams,
      esc,
      catalog,
      setTimeout: (fn, ms) => timers.push({fn, ms}),
      clearTimeout() {},
      pollTimer: null,
      deliveryTimer: null,
      session: {workspaceRole: 'owner', authenticated: true},
      document: {querySelector: () => null, querySelectorAll: () => [], addEventListener() {}},
      location: {pathname: '/reporting-overview', search: ''},
      history: {state: null, replaceState() {}},
      authBind() {},
      workspaceBind() {},
      toast() {},
      date: () => '',
      bootstrap,
      $: selector => (selector === '#overview-results' ? root : null),
    });
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    new Script(fs.readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  const workspace = fs.readFileSync('web/workspace.js', 'utf8');
  new Script(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  ).runInContext(context);
  const run = code => new Script(code).runInContext(context);
  run('overviewState.bootstrap = bootstrap');
  if (charts) run('var mountReportCharts = () => {}');
  return {
    root,
    requests,
    timers,
    run,
    /** The page's next poll fires, and runs to its end. */
    async poll() {
      const timer = timers.at(-1);
      timers.length = 0;
      timer.fn();
      await settle();
    },
  };
}

/** A real report's compact answers, with the job and the exports of each state laid over them. */
async function report(t) {
  const s = await granular(t, {grain: 'total'}),
    running = {state: 'running', attempts: 1, queued_ms: 0, started_at: 1, worker_recent: true},
    answer = (status, page) => ({...page, ...status});
  const exportRecord = (state, more = {}) => ({
    id: 'export-1',
    job_id: 'job-1',
    report_id: s.compact.id,
    state,
    outcome: state,
    destination_kind: 'sheets',
    destination_name: 'Client sheet',
    ...more,
  });
  return {
    ...s,
    id: s.compact.id,
    /**
     * The answer to a request, for a report whose job and exports are as given and that has `rowCount` rows (its three rows
     * stand for each page of them).
     */
    serve: ({job, exports = [], rowCount}) =>
      async function serve(input) {
        const page = await s.reply({...input, offset: 0}),
          offset = input.offset ?? 0;
        return answer(
          {
            state: job.state === 'complete' ? page.state : job.state,
            job: {...page.job, ...job},
            exports,
            ...(rowCount === undefined
              ? {}
              : {offset, row_count: rowCount, total: rowCount, has_more: offset + 100 < rowCount}),
          },
          page,
        );
      },
    running,
    exportRecord,
  };
}

test('a load asks for a page of rows and the charts, and never for the provider’s rows or the lineage', async t => {
  const r = await report(t),
    f = browser({reply: r.serve({job: {state: 'complete'}}), charts: true, bootstrap: r.bootstrap});
  await f.run(`loadOverviewReport('${r.id}')`);
  await f.run(`loadOverviewReport('${r.id}', 1)`);
  assert.deepEqual(f.requests, [
    {action: 'get', id: r.id, offset: 0, limit: 100, include: {charts: true}},
    {action: 'get', id: r.id, offset: 100, limit: 100, include: {charts: true}},
  ]);
  // Where the script that draws the charts is not loaded, there is no include at all.
  const bare = browser({reply: r.serve({job: {state: 'complete'}}), bootstrap: r.bootstrap});
  await bare.run(`loadOverviewReport('${r.id}')`);
  assert.deepEqual(bare.requests, [{action: 'get', id: r.id, offset: 0, limit: 100}]);
  assert.match(bare.root.innerHTML, /<table class="report-table report-rows-table"/);
});
