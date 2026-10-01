import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {webcrypto} from 'node:crypto';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {promise, resolve, reject};
};
function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  let active = true,
    invalidations = 0;
  const node = id => {
    if (!nodes.has(id)) {
      const n = {
        innerHTML: '',
        isConnected: true,
        values: {},
        events: new Map(),
        addEventListener(e, f) {
          this.events.set(e, f);
        },
        focus() {},
        setAttribute() {},
      };
      n.elements = {
        namedItem: name => ({
          get checked() {
            return n.values[name] === 'on';
          },
          set checked(v) {
            if (v) n.values[name] = 'on';
            else delete n.values[name];
          },
        }),
      };
      nodes.set(id, n);
    }
    return nodes.get(id);
  };
  const c = createContext({
    document: {addEventListener() {}},
    TextDecoder,
    Uint8Array,
    crypto: webcrypto,
    $: node,
    FormData: class {
      constructor(f) {
        this.entries = Object.entries(f.values);
      }
      [Symbol.iterator]() {
        return this.entries[Symbol.iterator]();
      }
    },
    workspaceBind: (key, fn) => bindings.set(key, fn),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    recordDetails: v => JSON.stringify(v),
  });
  const run = s => new Script(s).runInContext(c);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/report-reference.js', 'utf8'));
  run(readFileSync('web/report-quality.js', 'utf8'));
  if (locale === 'ar') {
    c.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  const report = {
    id: 'current',
    gateway: 'google_ads_native_action',
    account_id: '100',
    grain: 'campaign × day',
    source: 'provider_read',
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      attribution: '7 day click',
      conversion_definition: 'primary conversions',
      complete: true,
    },
  };
  return {
    nodes,
    node,
    c,
    bindings,
    calls,
    invalidations: () => invalidations,
    mount: () =>
      c.mountReferenceImport(
        report,
        async r => calls.push(JSON.parse(JSON.stringify(r))),
        () => active,
        () => {
          invalidations++;
        },
      ),
    deactivate: () => {
      active = false;
    },
    result: r => c.renderReportReconciliation(r),
  };
}
function file(text) {
  const b = Buffer.from(text);
  return {size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)};
}
const settings = () => ({
  label: 'Native export',
  account_id: '100',
  currency: 'USD',
  timezone: 'UTC',
  date_from: '2026-09-01',
  date_to: '2026-09-02',
  attribution: '7 day click',
  conversion_definition: 'primary conversions',
  grain: 'campaign × day',
  number_format: 'decimal_dot',
  map_spend: '0',
  map_clicks: '1',
  unit_spend: '6',
});

test('CSV import requires an exact preview and explicit measurement declarations in both languages; only selected totals leave the browser', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.mount();
    assert.match(f.node('#reference-import').innerHTML, locale === 'ar' ? /CSV/ : /Import reference totals/);
    const load = f.node('#reference-csv-load');
    load.values = {file: file('Cost,Clicks,Private\n12340000,10,not-uploaded\n'), delimiter: ','};
    await f.bindings.get('#reference-csv-load')(load);
    const form = f.node('#reference-csv-compare');
    form.values = settings();
    await assert.rejects(f.bindings.get('#reference-csv-compare')(form));
    await f.bindings.get('#reference-csv-preview')();
    assert.match(f.node('#reference-csv-values').innerHTML, /12\.34/);
    await assert.rejects(f.bindings.get('#reference-csv-compare')(form));
    form.values.complete = 'on';
    form.values.same_entities_and_filters = 'on';
    await f.bindings.get('#reference-csv-compare')(form);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].totals.spend, '12.34');
    assert.equal(f.calls[0].context.account_id, '100');
    assert.equal(f.calls[0].context.same_entities_and_filters, true);
    assert.equal(f.calls[0].file.money_scales.spend, 6);
    assert.doesNotMatch(JSON.stringify(f.calls), /not-uploaded|Private|arrayBuffer/);
    form.values.unit_spend = '0';
    form.events.get('input')({target: {name: 'unit_spend'}});
    assert.equal(form.values.complete, undefined);
    assert.equal(form.values.same_entities_and_filters, undefined);
    await assert.rejects(f.bindings.get('#reference-csv-compare')(form));
    assert.equal(f.calls.length, 1);
  }
});

test('late file reads and failures cannot publish columns after selection or identity changes', async () => {
  for (const kind of ['edit', 'identity', 'failure']) {
    const f = fixture();
    f.mount();
    const load = f.node('#reference-csv-load'),
      pending = deferred();
    const bytes = Buffer.from('Cost\n1\n');
    load.values = {file: {size: bytes.length, arrayBuffer: () => pending.promise}, delimiter: ','};
    const work = f.bindings.get('#reference-csv-load')(load);
    if (kind === 'edit') load.events.get('change')({target: {name: 'file'}});
    else f.deactivate();
    if (kind === 'failure') pending.reject(Error('Old file read error'));
    else pending.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    await assert.doesNotReject(work);
    assert.equal(f.node('#reference-csv-fields').innerHTML, '');
    assert.equal(f.calls.length, 0);
  }
});

test('declared CSV comparison results say that declarations and file provenance are not independently verified', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    const html = f.result({
      comparison_kind: 'declared_reference',
      context_compatible: true,
      matched: true,
      differences: [],
    });
    assert.match(html, locale === 'ar' ? /الإعدادات المعلنة/ : /Declared reference settings/);
    assert.doesNotMatch(html, /Retained report settings align|>verified</);
  }
});
