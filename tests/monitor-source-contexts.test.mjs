// closing-fixes item 3. The Monitoring inbox makes a rule from a retained snapshot: it lists the snapshot's complete
// measurement contexts and asks which one the rule is for. A v4 report of several levels has a summary for each level
// (and a context may have one per objective group), so the same account, currency, time zone, result definition and
// attribution was offered once per summary. A rule watches only the top level its source requested (src/report-monitors.ts,
// F-L5-06), so the page offers each context once, from that level's summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const escape = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The Monitoring inbox's own script with the page around it faked: the report it is asked for, and what it then calls. */
function inbox(report) {
  const bindings = new Map(),
    calls = [],
    nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        isConnected: true,
        elements: {},
        setAttribute() {},
        querySelector: () => null,
      });
    return nodes.get(selector);
  };
  const c = createContext({
    document: {addEventListener() {}},
    URLSearchParams,
    location: {search: ''},
    history: {replaceState() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'operator'},
    content: {innerHTML: ''},
    $: node,
    esc: escape,
    pretty: String,
    badge: String,
    blank: String,
    date: String,
    header: (title, description) => `<h1>${title}</h1><p>${description}</p>`,
    controls: (label, type, value, name) =>
      `<label>${label}<input type="${type}" name="${name}" value="${value}"></label>`,
    errorMessage: e => e.message,
    toast() {},
    renderWorkspacePage: async () => {},
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: structuredClone(args)});
      return args.action === 'incidents'
        ? {incidents: [], next_cursor: null}
        : args.action === 'monitors'
          ? {monitors: [], next_cursor: null}
          : {};
    },
    overviewCall: async args => {
      assert.equal(args.action, 'get');
      return report;
    },
  });
  // routes.js: the page's headings read the route registry (package web-shell, V2-WEB-03), which the real page loads first.
  for (const file of ['localization.js', 'routes.js', 'work-pages.js', 'operations-center.js'])
    new Script(readFileSync('web/' + file, 'utf8')).runInContext(c);
  return {
    c,
    calls,
    /** Opens the inbox, asks for the snapshot's contexts, and returns the rule form's markup. */
    async choose() {
      await new Script('renderMonitors()').runInContext(c);
      await bindings.get('#monitor-source-form')({elements: {report_id: {value: report.id}}});
      return node('#monitor-rule').innerHTML;
    },
    /** Saves a rule on the option at `index`, as the form would, and returns the rule the page sent. */
    async save(index) {
      const field = value => ({value}),
        form = {
          elements: {
            context: field(String(index)),
            confirmed: {checked: true},
            name: field('Spend ceiling'),
            metric: field('spend'),
            comparison: field('above'),
            threshold: field('200'),
            max_age_hours: field('24'),
          },
        };
      await bindings.get('#save-monitor')(form);
      return calls.find(call => call.args.action === 'save_monitor').args.monitor;
    },
  };
}
const options = markup => [...markup.matchAll(/<option value="(\d+)">([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);

const summary = (level, more = {}) => ({
  platform: 'meta',
  account_id: '100',
  currency: 'USD',
  timezone: 'UTC',
  result_definition: 'purchase',
  attribution: 'unknown',
  // The campaign level of a v4 report may carry no entity_level at all.
  ...(level === 'campaign' ? {} : {entity_level: level}),
  objective_group: 'sales',
  date_from: '2026-08-01',
  date_to: '2026-08-07',
  complete: true,
  metrics: {spend: '294'},
  ...more,
});
const source = (levels, more = {}) => ({
  platform: 'meta',
  connection_id: 'login',
  account_id: '100',
  levels,
  ...more,
});
const v4 = (levels, summaries, sources = [source(levels)]) => ({
  id: 'snapshot-1',
  config: {contract_version: 'overview-config-v4', sources},
  summary: summaries,
});

test('a v4 report of three levels offers its one context once, and the rule it makes is for that context', async () => {
  const f = inbox(v4(['campaign', 'adset', 'ad'], [summary('campaign'), summary('adset'), summary('ad')]));
  const markup = await f.choose();
  assert.deepEqual(options(markup), [['0', 'meta · 100 · USD · UTC · purchase · unknown']]);
  assert.deepEqual(await f.save(0), {
    platform: 'meta',
    connection_id: 'login',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    result_definition: 'purchase',
    attribution: 'unknown',
    name: 'Spend ceiling',
    metric: 'spend',
    comparison: 'above',
    threshold: '200',
    max_age_hours: 24,
  });
});

test('the top level the source requested stands for the context, whatever order the levels were listed in or came back in', async () => {
  // The rule watches the top of campaign, ad set, ad among the levels requested: here the campaign level is incomplete
  // while the lower levels are whole, and the rule has no answer to give from them, so no context is offered.
  const short = inbox(
    v4(['ad', 'campaign'], [summary('ad'), summary('campaign', {complete: false}), summary('adset')]),
  );
  await assert.rejects(
    short.choose(),
    /This snapshot has no complete, unambiguous measurement context\. Open its source evidence first\./,
  );
  // The same report with the campaign level whole offers the context once, listed in any order.
  const whole = inbox(v4(['ad', 'campaign'], [summary('ad'), summary('campaign'), summary('adset')]));
  assert.equal(options(await whole.choose()).length, 1);
  // Two levels that do not include the campaign: the top of them is the ad set, and the ad level does not answer for it.
  const lower = inbox(v4(['ad', 'adset'], [summary('ad'), summary('adset', {complete: false})]));
  await assert.rejects(lower.choose(), /no complete, unambiguous measurement context/);
});

test('contexts that differ are each offered once: another account, currency or attribution', async () => {
  const sources = [source(['campaign', 'ad']), source(['campaign', 'ad'], {connection_id: 'other', account_id: '200'})],
    report = v4(
      ['campaign', 'ad'],
      [
        summary('campaign'),
        summary('ad'),
        summary('campaign', {account_id: '200'}),
        summary('ad', {account_id: '200'}),
        summary('campaign', {currency: 'EUR', attribution: '7d_click'}),
      ],
      sources,
    );
  // The third campaign summary describes account 100 in another currency: a different context of the same source.
  const f = inbox(report);
  assert.deepEqual(
    options(await f.choose()).map(([, text]) => text),
    [
      'meta · 100 · USD · UTC · purchase · unknown',
      'meta · 200 · USD · UTC · purchase · unknown',
      'meta · 100 · EUR · UTC · purchase · 7d_click',
    ],
  );
  assert.equal((await f.save(1)).connection_id, 'other');
});

test('a context with several objective groups is one context, and a v3 report keeps offering what it offered', async () => {
  const groups = inbox(
    v4(
      ['campaign'],
      [
        summary('campaign'),
        summary('campaign', {objective_group: 'leads'}),
        summary('campaign', {date_from: '2026-08-08'}),
      ],
    ),
  );
  assert.equal(options(await groups.choose()).length, 1);
  // A v3 report has no levels and no entity_level: its complete summaries are its contexts, as before.
  const legacy = inbox({
    id: 'snapshot-1',
    config: {sources: [{platform: 'meta', connection_id: 'login', account_id: '100', level: 'campaign'}]},
    summary: [
      summary('campaign'),
      summary('campaign', {currency: 'EUR'}),
      summary('campaign', {complete: false, currency: 'GBP'}),
    ],
  });
  assert.deepEqual(
    options(await legacy.choose()).map(([, text]) => text),
    ['meta · 100 · USD · UTC · purchase · unknown', 'meta · 100 · EUR · UTC · purchase · unknown'],
  );
});
