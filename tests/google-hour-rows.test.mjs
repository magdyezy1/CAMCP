import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {promise, resolve, reject};
};
function fixture(locale = 'en', count = 101) {
  const nodes = new Map(),
    calls = [],
    rows = Array.from({length: count}, (_, i) => ({
      entity_id: String(9007199254740993n + BigInt(i)),
      entity_name: 'Home <img src=x> ' + i,
      date: '2026-09-01',
      spend: '9007199254740993.123456789',
      impressions: String(i),
      clicks: '0',
      conversions: null,
    }));
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        isConnected: true,
        events: new Map(),
        attributes: new Map(),
        focusCount: 0,
        addEventListener(type, fn) {
          this.events.set(type, fn);
        },
        setAttribute(k, v) {
          this.attributes.set(k, v);
        },
        focus() {
          this.focusCount++;
        },
        querySelector: selector => node(selector),
      });
    return nodes.get(key);
  };
  const report = {
    id: 'evidence',
    gateway: 'tiktok_native_action',
    account_id: '100',
    connection_id: 'login',
    source: 'provider_read',
    source_hash: 'a'.repeat(64),
    row_count: count,
    has_more: count > 50,
    rows: rows.slice(0, 50),
    semantics: {source_name: 'Home', currency: 'USD'},
    mapping: {
      entity_id: '/dimensions/campaign_id',
      entity_name: '/metrics/campaign_name',
      date: '/dimensions/stat_time_day',
      spend: '/metrics/spend',
      impressions: '/metrics/impressions',
      clicks: '/metrics/clicks',
      conversions: '/metrics/conversion',
    },
  };
  const page = (offset, limit = 50) => ({
    ...report,
    rows: rows.slice(offset, offset + limit),
    has_more: offset + limit < count,
  });
  let respond = args => page(args.offset, args.limit);
  const context = createContext({
    Intl,
    navigationGeneration: 1,
    identityGeneration: 1,
    selectionCurrent: true,
    document: {addEventListener() {}},
    $: node,
    report,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: plain(args)});
      return respond(args);
    },
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  run(readFileSync(process.env.AMCP_EVIDENCE_UI_SOURCE || 'web/evidence-workflows.js', 'utf8'));
  return {
    node,
    calls,
    context,
    report,
    page,
    rows,
    run,
    respond: fn => {
      respond = fn;
    },
    mount: () => run('mountEvidenceRows(report, () => selectionCurrent)'),
    click: key => node(key).events.get('click')(),
    select: value => {
      const select = node('#evidence-rows-page');
      select.value = value;
      return select.events.get('change')();
    },
    size: value => {
      const select = node('#evidence-rows-page-size');
      select.value = value;
      return select.events.get('change')();
    },
  };
}

test('hour tables preserve native midnight, literal names and source column choices in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale, 24);
    f.report.preset = 'google_campaign_hour';
    f.report.gateway = 'google_ads_native_action';
    f.report.mapping.native_hour = '/segments/hour';
    for (let i = 0; i < f.rows.length; i++) f.rows[i].native_hour = String(i);
    f.mount();
    const html = f.node('#report-native-rows').innerHTML;
    assert.ok(html.includes(locale === 'ar' ? f.context.catalog['Native hour'] : 'Native hour'));
    assert.ok(html.includes('dir="ltr">0</td>'));
    assert.ok(html.includes('dir="ltr">23</td>'));
    assert.ok(html.includes('Home &lt;img src=x&gt;'));
    assert.equal(f.calls.length, 0);
    assert.ok(html.indexOf('evidence-column-native_hour') >= 0);
  }
});
test('hour search changes only source-identical displayed rows and leaves native hour out when it is unmapped', async () => {
  const f = fixture('en', 24);
  f.report.preset = 'google_campaign_hour';
  f.report.gateway = 'google_ads_native_action';
  f.report.mapping.native_hour = '/segments/hour';
  for (let i = 0; i < f.rows.length; i++) f.rows[i].native_hour = String(i);
  f.mount();
  f.respond(args => {
    const matches = f.rows.filter(r => r.native_hour === args.row_query);
    return {
      ...f.report,
      rows: matches.slice(args.offset, args.offset + args.limit),
      has_more: false,
      row_query: args.row_query,
      matched_row_count: matches.length,
    };
  });
  f.node('#evidence-row-query').value = '21';
  f.node('#evidence-row-query').events.get('input')();
  await f.node('#evidence-row-search').events.get('submit')({preventDefault() {}});
  assert.deepEqual(f.calls.at(-1).args, {action: 'get', id: 'evidence', offset: 0, limit: 50, row_query: '21'});
  assert.equal(f.report.row_count, 24);
  assert.equal(f.report.source_hash, 'a'.repeat(64));
  const plain = fixture();
  plain.rows[0].native_hour = '21';
  plain.mount();
  assert.equal(plain.node('#report-native-rows').innerHTML.includes('evidence-column-native_hour'), false);
});
