// The report builder's page in a VM for the tests of what it loads when a disclosure is opened (package website-get): its own
// scripts, a real v4 snapshot through the real server (run, worker, row assembly, `get` with its filters and cursor), and
// small stand-ins for the elements it binds, which keep what the page does to them. `api` answers through `reply`, and the
// page's requests are recorded as it sent them.
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {overviewGranularityFixture, granularConfig, granularSource} from '../fixtures/overview-granularity-data.mjs';
import {reportSource} from '../../dist/src/report-sources.js';

export const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
export const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character],
  );
export const wire = value => JSON.parse(JSON.stringify(value));
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
};

/** An element the page binds: it keeps the attributes, markup, listeners and focus the page gives it. */
export class Stand {
  constructor(attributes = {}) {
    Object.assign(this, {innerHTML: '', attributes: {...attributes}, listeners: {}, isConnected: true, focused: false});
    this.dataset = {};
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  focus() {
    this.focused = true;
  }
}
/** A lazy `<details>`: its summary, its body, and the Retry button the body shows after a failure. */
export class DetailsStand extends Stand {
  constructor(dataset) {
    super();
    Object.assign(this.dataset, dataset);
    this.open = false;
    this.summary = new Stand();
    this.body = new Stand();
    this.body.querySelector = selector =>
      selector === '[data-report-details-retry]' && this.body.innerHTML.includes('data-report-details-retry')
        ? (this.retry ??= new Stand())
        : null;
  }
  querySelector(selector) {
    return selector === 'summary' ? this.summary : selector === '[data-report-details-body]' ? this.body : null;
  }
  /** What opening or closing it does: the browser sets `open`, then fires `toggle`; the load it starts runs to its end. */
  async toggle(open) {
    this.open = open;
    await this.listeners.toggle?.();
    await settle();
  }
  /** What pressing Retry does. */
  async retryNow() {
    await this.body.querySelector('[data-report-details-retry]').listeners.click();
    await settle();
  }
}

/** The page's scripts in a VM, in one language, with `api` answered by `reply(input)`. */
export function page(locale, bootstrap, reply) {
  const requests = [],
    elements = [],
    context = createContext({
      Intl,
      Date,
      URLSearchParams,
      structuredClone,
      esc,
      catalog,
      bootstrap,
      $: () => null,
      CSS: {escape: String},
      location: {pathname: '/reporting-overview', search: ''},
      document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => elements},
      api: async (_url, options) => {
        const input = JSON.parse(options.body);
        requests.push(input);
        return {success: true, data: await reply(input)};
      },
    });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run("var date = value => (value ? uiDate(value) : uiText('Not synced'));");
  const workspace = fs.readFileSync('web/workspace.js', 'utf8');
  run(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  );
  for (const file of ['report-library', 'report-source-settings', 'report-quality', 'reporting-overview'])
    run(fs.readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});overviewState.bootstrap=bootstrap;`,
  );
  const raw = (expression, values = {}) => {
    Object.assign(context, values);
    return run('(' + expression + ')');
  };
  const view = {
    requests,
    context,
    raw,
    table: report => String(raw('renderReportTable(report, report.config.metrics, bootstrap)', {report, bootstrap})),
    /** The source cards of a report, as the page draws them under its summary. */
    cards: report =>
      String(
        raw(
          'report.sources.map((s, i) => renderReportSourceHealth(s, bootstrap.platforms, i, report.config.date_range, report)).join("")',
          {report, bootstrap},
        ),
      ),
    /**
     * Draws the table and the source cards, then binds them as the page does: one stand-in for each lazy `<details>` the
     * markup names, in the order of the markup.
     */
    bind(report) {
      const rows = view.table(report),
        cards = view.cards(report),
        details = [...rows.matchAll(/<details data-report-details="([^"]*)"/g)].map(
          match => new DetailsStand({reportDetails: match[1].replaceAll('&amp;', '&')}),
        ),
        lineage = [...cards.matchAll(/<details data-report-lineage="([^"]*)"/g)].map(
          match => new DetailsStand({reportLineage: match[1]}),
        );
      elements.splice(0, elements.length, ...details, ...lineage);
      raw('bindReportDetails(report)', {report});
      raw('bindReportLineage(report)', {report});
      return {rows, cards, details, lineage};
    },
  };
  return view;
}

/**
 * A real v4 snapshot of Meta (three levels) and, when asked, TikTok, at one grain, and what a real server answers to the
 * page's requests: the compact answer it loads, the full answer (include.native and include.lineage) to compare with, and
 * the bootstrap. `reply` is the real `ReportingOverview.handle`.
 */
export async function granular(t, {grain = 'daily', platforms = ['meta']} = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const source = platform => {
      const {level, objective, report_options, ...rest} = granularSource(platform, 'ad');
      return {
        ...rest,
        levels: ['campaign', 'adset', 'ad'],
        statuses: ['all'],
        delivered_only: false,
        report_options:
          platform === 'meta' ? {...reportSource('meta').overview.defaults, complete_window: true} : report_options,
      };
    },
    queued = await f.overview.handle(
      {
        action: 'run',
        config: {
          ...granularConfig(source(platforms[0]), grain),
          sources: platforms.map(source),
          contract_version: 'overview-config-v4',
        },
        confirmed: true,
      },
      f.actor,
    );
  await f.worker.once();
  const reply = input => f.overview.handle(input, f.actor).then(wire);
  return {
    reply,
    compact: await reply({action: 'get', id: queued.id, offset: 0, limit: 100}),
    full: await reply({action: 'get', id: queued.id, offset: 0, limit: 500, include: {native: true, lineage: true}}),
    bootstrap: await reply({action: 'bootstrap'}),
  };
}
