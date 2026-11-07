// Retry on a snapshot opened by its link (?report_id=) found an empty builder form, showed "Choose at least one account" and
// ran nothing: the page loads the snapshot's results but not its setup. Retry now refills the builder from the snapshot first,
// through the path History uses (openOverviewHistory), and then submits once. The page's own retryReportRun and
// openOverviewHistory run here; only the network and the drawing of the form are stood in for.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

const esc = value => String(value ?? '');
const snapshot = {
  id: 'snapshot-1',
  state: 'partial',
  config: {
    contract_version: 'overview-config-v4',
    name: 'Weekly',
    sources: [{platform: 'meta', connection_id: 'login', account_id: '100', levels: ['campaign', 'ad']}],
    source_defaults: {},
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    metrics: ['spend'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  },
};
/** The report page's scripts, a builder form that is empty or filled, and a record of what the page did to it. */
function page({filled = false} = {}) {
  const log = [],
    state = {accounts: filled},
    submit = {getAttribute: () => null},
    form = {
      querySelector: selector => (selector === 'button[type="submit"]' ? submit : null),
      requestSubmit: (...args) => log.push(['submit', state.accounts, args.length]),
    },
    context = createContext({
      esc,
      clearTimeout() {},
      setTimeout() {},
      pollTimer: null,
      deliveryTimer: null,
      Intl,
      Date,
      URLSearchParams,
      structuredClone,
      document: {
        addEventListener() {},
        querySelector: selector => (selector === '[data-report-account]:checked' && state.accounts ? {} : null),
        querySelectorAll: () => [],
      },
      $: selector => (selector === '#overview-config' ? form : null),
      location: {pathname: '/reporting-overview', search: '?report_id=' + snapshot.id},
    });
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  context.snapshot = snapshot;
  context.log = log;
  context.state = state;
  // The network and the drawing of the form are the only things replaced: the snapshot is loaded as the page loads it, and
  // drawing the form from overviewState.config checks the accounts of its sources.
  new Script(
    `overviewMayLeave = async () => { log.push(['may leave']); return true; };
     loadOverviewReport = async id => { log.push(['load', id]); overviewState.report = {id, config: snapshot.config, destination_id: null}; };
     renderReportingOverview = async () => {
       log.push(['draw', overviewState.config.sources.map(source => source.account_id), overviewState.config.contract_version]);
       state.accounts = overviewState.config.sources.length > 0;
     };
     $ = selector => selector === '#overview-results' ? { scrollIntoView() {} } : null;
     overviewState.report = {id: snapshot.id, config: snapshot.config};
     overviewState.config = overviewDefault();`,
  ).runInContext(context);
  // $ above answers the results area for History; the form is looked up through the page's own helper, restored for Retry.
  context.formLookup = selector =>
    selector === '#overview-config' ? form : selector === '#overview-results' ? {scrollIntoView() {}} : null;
  new Script('$ = formLookup;').runInContext(context);
  return {context, log, state};
}

test('Retry on a snapshot opened by its link refills the builder from the snapshot the way History does, then submits once', async () => {
  const {context, log} = page();
  await new Script('retryReportRun()').runInContext(context);
  assert.deepEqual(JSON.parse(JSON.stringify(log)), [
    ['may leave'],
    ['load', snapshot.id],
    ['draw', ['100'], 'overview-config-v4'],
    ['submit', true, 1],
  ]);
});

test('two clicks refill and submit once', async () => {
  const {context, log} = page();
  await Promise.all([
    new Script('retryReportRun()').runInContext(context),
    new Script('retryReportRun()').runInContext(context),
  ]);
  assert.equal(log.filter(entry => entry[0] === 'submit').length, 1);
  assert.equal(log.filter(entry => entry[0] === 'draw').length, 1);
});

test('a builder that already holds accounts is submitted as it is, and with no snapshot open there is nothing to refill', async () => {
  const filled = page({filled: true});
  await new Script('retryReportRun()').runInContext(filled.context);
  assert.deepEqual(JSON.parse(JSON.stringify(filled.log)), [['submit', true, 1]]);
  const none = page();
  new Script('overviewState.report = null').runInContext(none.context);
  await new Script('retryReportRun()').runInContext(none.context);
  assert.deepEqual(JSON.parse(JSON.stringify(none.log)), [['submit', false, 1]]);
});
