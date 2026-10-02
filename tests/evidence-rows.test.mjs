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
  const page = offset => ({...report, rows: rows.slice(offset, offset + 50), has_more: offset + 50 < count});
  let respond = args => page(args.offset);
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
  };
}

test('retained evidence rows render readable accessible tables with exact values, escaping and unknown metrics', () => {
  const f = fixture();
  f.mount();
  const html = f.node('#report-native-rows').innerHTML;
  assert.match(html, /<table/);
  assert.match(html, /<caption/);
  assert.match(html, /scope="col"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="region"/);
  assert.match(html, /9007199254740993\.123456789/);
  assert.match(html, /9007199254740993/);
  assert.match(html, /Home &lt;img src=x&gt; 0/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /Unknown/);
  assert.match(html, />0<\/td>/);
  assert.match(html, /USD/);
  assert.match(html, /dir="ltr"/);
  assert.equal(f.node('#evidence-rows-previous').disabled, true);
  assert.equal(f.node('#evidence-rows-next').disabled, false);
  assert.equal(f.calls.length, 0, 'initial retained page is reused without another read');
});
test('retained rows navigate all pages through bounded reporting reads, direct page choice and consistent source identity', async () => {
  const f = fixture();
  f.mount();
  await f.click('#evidence-rows-next');
  assert.deepEqual(f.calls[0], {tool: 'reporting', args: {action: 'get', id: 'evidence', offset: 50, limit: 50}});
  assert.match(f.node('#report-native-rows').innerHTML, /9007199254741043/);
  await f.select('3');
  assert.equal(f.calls[1].args.offset, 100);
  assert.equal(f.node('#evidence-rows-next').disabled, true);
  assert.match(f.node('#report-native-rows').innerHTML, /9007199254741093/);
  await f.click('#evidence-rows-previous');
  assert.equal(f.calls[2].args.offset, 50);
  assert.ok(f.node('#evidence-rows-status').focusCount > 0);
  for (const value of ['0', '4', '1.5', '1e2', 'garbage']) await f.select(value);
  assert.equal(f.calls.length, 3);
});
test('retained row paging stays bilingual while native identifiers, values and requests remain identical', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.mount();
    await f.click('#evidence-rows-next');
    requests.push(f.calls);
    if (locale === 'ar') {
      const html = f.node('#report-native-rows').innerHTML;
      assert.match(html, /[\u0600-\u06ff]/);
      assert.doesNotMatch(html, /Retained native rows|Entity ID|Previous page|Next page|Unknown/);
      assert.match(html, /Home &lt;img src=x&gt; 50/);
      assert.match(html, /9007199254740993\.123456789/);
    }
  }
  assert.deepEqual(requests[0], requests[1]);
});
test('empty evidence has an explicit zero-row state and busy pagination prevents duplicate reads', async () => {
  const empty = fixture('en', 0);
  empty.mount();
  assert.match(empty.node('#report-native-rows').innerHTML, /No mapped native rows/);
  assert.equal(empty.node('#evidence-rows-previous').disabled, true);
  assert.equal(empty.node('#evidence-rows-next').disabled, true);
  const f = fixture(),
    pending = deferred();
  f.mount();
  f.respond(() => pending.promise);
  const read = f.click('#evidence-rows-next');
  assert.equal(f.node('#report-native-rows').attributes.get('aria-busy'), 'true');
  await f.click('#evidence-rows-next');
  await f.select('3');
  assert.equal(f.calls.length, 1);
  pending.resolve(f.page(50));
  await read;
  assert.equal(f.node('#report-native-rows').attributes.get('aria-busy'), 'false');
});
test('departed evidence paging starts no reads and late responses or failures never repaint another view', async () => {
  for (const change of ['navigation', 'identity', 'selection', 'detached'])
    for (const fail of [false, true]) {
      const f = fixture(),
        pending = deferred();
      f.mount();
      f.respond(() => pending.promise);
      const next = f.node('#evidence-rows-next').events.get('click'),
        read = next();
      if (change === 'navigation') f.context.navigationGeneration++;
      if (change === 'identity') f.context.identityGeneration++;
      if (change === 'selection') f.context.selectionCurrent = false;
      if (change === 'detached') f.node('#report-native-rows').isConnected = false;
      f.node('#report-native-rows').innerHTML = 'Current destination';
      if (fail) pending.reject(Error('PRIVATE prior scope error'));
      else pending.resolve(f.page(50));
      await assert.doesNotReject(read);
      await next();
      assert.equal(f.node('#report-native-rows').innerHTML, 'Current destination');
      assert.equal(f.calls.length, 1);
    }
});
test('failed, changed or malformed retained pages clear stale rows and expose a scoped retry', async () => {
  for (const patch of [
    {id: 'foreign'},
    {source_hash: 'b'.repeat(64)},
    {account_id: '999'},
    {connection_id: 'other'},
    {gateway: 'other'},
    {row_count: 500},
    {has_more: false},
    {rows: []},
    {rows: [null]},
  ]) {
    const f = fixture();
    f.mount();
    f.respond(() => ({...f.page(50), ...patch}));
    await f.click('#evidence-rows-next');
    const html = f.node('#report-native-rows').innerHTML;
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /<table|9007199254740993/);
  }
  const f = fixture();
  f.mount();
  f.respond(() => {
    throw Error('PRIVATE revoked scope');
  });
  await f.click('#evidence-rows-next');
  assert.doesNotMatch(f.node('#report-native-rows').innerHTML, /PRIVATE|<table/);
  f.respond(args => f.page(args.offset));
  await f.click('#evidence-rows-retry');
  assert.equal(f.calls[1].args.offset, 50);
  assert.match(f.node('#report-native-rows').innerHTML, /<table/);
});

test('retained row search sends a bounded current-view query, resets paging and keeps full-report meaning bilingual', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.mount();
    const field = f.node('#evidence-row-query');
    field.value = 'Home <img> 100';
    field.events.get('input')();
    f.respond(args => ({
      ...f.report,
      rows: [f.page(100).rows[0]],
      has_more: false,
      row_query: args.row_query,
      matched_row_count: 1,
    }));
    await f.node('#evidence-row-search').events.get('submit')({preventDefault() {}});
    assert.equal(f.calls[0].args.row_query, 'Home <img> 100');
    assert.equal(f.calls[0].args.offset, 0);
    assert.match(f.node('#report-native-rows').innerHTML, /9007199254741093/);
    assert.equal(f.node('#evidence-rows-next').disabled, true);
    assert.match(f.node('#report-native-rows').innerHTML, locale === 'ar' ? /التقرير الكامل/ : /complete report/);
    f.respond(args => ({...f.page(args.offset), row_query: '', matched_row_count: 101}));
    await f.click('#evidence-row-clear');
    assert.equal(f.calls.at(-1).args.row_query, undefined);
    requests.push(f.calls);
  }
  assert.deepEqual(requests[0], requests[1]);
});

test('retained row columns can be focused without refetching or hiding every field, and reset remains local', async () => {
  const f = fixture();
  f.mount();
  const spend = f.node('#evidence-column-spend');
  spend.checked = false;
  await spend.events.get('change')();
  assert.doesNotMatch(f.node('#report-native-rows').innerHTML, /<th scope="col">Spend/);
  assert.match(f.node('#report-native-rows').innerHTML, /9007199254740993/);
  assert.equal(f.calls.length, 0);
  await f.click('#evidence-columns-reset');
  assert.match(f.node('#report-native-rows').innerHTML, /<th scope="col">Spend/);
  const keys = ['entity_id', 'entity_name', 'date', 'spend', 'impressions', 'clicks', 'conversions'];
  for (const key of keys) {
    const control = f.node('#evidence-column-' + key);
    control.checked = false;
    await control.events.get('change')();
  }
  assert.match(f.node('#report-native-rows').innerHTML, /<th scope="col">/);
  assert.equal(f.calls.length, 0);
});

test('retained row controls preserve open column choices, keyboard focus and drafts across page reads', async () => {
  const f = fixture();
  f.mount();
  const details = f.node('#evidence-columns');
  details.open = true;
  const spend = f.node('#evidence-column-spend');
  spend.checked = false;
  await spend.events.get('change')();
  assert.match(f.node('#report-native-rows').innerHTML, /<details id="evidence-columns" open>/);
  assert.ok(spend.focusCount > 0);
  const pending = deferred();
  f.respond(() => pending.promise);
  const read = f.click('#evidence-rows-next');
  const field = f.node('#evidence-row-query');
  field.value = 'draft during paging';
  field.events.get('input')();
  assert.equal(f.node('#evidence-row-clear').disabled, true);
  pending.resolve(f.page(50));
  await read;
  assert.equal(field.value, 'draft during paging');
  assert.equal(f.node('#evidence-row-clear').disabled, false);
  assert.equal(f.node('#evidence-row-apply').disabled, false);
  assert.equal(spend.disabled, false);
  assert.equal(spend.checked, false);
  assert.match(f.node('#report-native-rows').innerHTML, /<details id="evidence-columns" open>/);
  await f.click('#evidence-columns-reset');
  assert.equal(spend.checked, true);
  assert.ok(f.node('#evidence-columns-reset').focusCount > 0);
  assert.match(f.node('#report-native-rows').innerHTML, /<details id="evidence-columns" open>/);
});

test('typing enables clear without applying a search, and clearing an unapplied draft makes no read', async () => {
  const f = fixture();
  f.mount();
  const field = f.node('#evidence-row-query');
  assert.equal(f.node('#evidence-row-clear').disabled, true);
  field.value = 'unapplied';
  field.events.get('input')();
  assert.equal(f.node('#evidence-row-clear').disabled, false);
  await f.click('#evidence-row-clear');
  assert.equal(field.value, '');
  assert.equal(f.node('#evidence-row-clear').disabled, true);
  assert.ok(field.focusCount > 0);
  assert.equal(f.calls.length, 0);
});

test('failed rows disable stale column controls and focus a retry that restores the current selection', async () => {
  const f = fixture();
  f.mount();
  const spend = f.node('#evidence-column-spend');
  spend.checked = false;
  spend.events.get('change')();
  f.respond(() => {
    throw Error('PRIVATE');
  });
  await f.click('#evidence-rows-next');
  assert.equal(spend.disabled, true);
  assert.equal(f.node('#evidence-columns-reset').disabled, true);
  assert.equal(f.node('#evidence-row-apply').disabled, false);
  assert.equal(f.node('#evidence-rows-retry').disabled, false);
  assert.ok(f.node('#evidence-rows-retry').focusCount > 0);
  f.respond(args => f.page(args.offset));
  await f.click('#evidence-rows-retry');
  assert.equal(spend.disabled, false);
  assert.equal(spend.checked, false);
  assert.equal(f.node('#evidence-columns-reset').disabled, false);
});

test('unfiltered pages cannot silently reduce the original retained row count', async () => {
  const f = fixture();
  f.mount();
  f.node('#evidence-row-query').value = 'Home';
  f.node('#evidence-row-query').events.get('input')();
  f.respond(() => ({...f.page(0), row_query: 'Home', matched_row_count: 101}));
  await f.node('#evidence-row-search').events.get('submit')({preventDefault() {}});
  f.respond(() => ({...f.page(0), row_query: '', matched_row_count: 100}));
  await f.click('#evidence-row-clear');
  assert.match(f.node('#report-native-rows').innerHTML, /role="alert"/);
  assert.doesNotMatch(f.node('#report-native-rows').innerHTML, /<table/);
});

test('search results with the wrong query or counts are refused, and late search responses cannot repaint another selection', async () => {
  for (const patch of [
    {row_query: 'different'},
    {matched_row_count: 102},
    {matched_row_count: -1},
    {matched_row_count: 1, has_more: true},
  ]) {
    const f = fixture();
    f.mount();
    f.node('#evidence-row-query').value = 'specific';
    f.node('#evidence-row-query').events.get('input')();
    f.respond(() => ({...f.page(0), row_query: 'specific', matched_row_count: 101, ...patch}));
    await f.node('#evidence-row-search').events.get('submit')({preventDefault() {}});
    assert.match(f.node('#report-native-rows').innerHTML, /role="alert"/);
    assert.doesNotMatch(f.node('#report-native-rows').innerHTML, /<table/);
  }
  const f = fixture(),
    pending = deferred();
  f.mount();
  f.node('#evidence-row-query').value = 'Home';
  f.node('#evidence-row-query').events.get('input')();
  f.respond(() => pending.promise);
  const read = f.node('#evidence-row-search').events.get('submit')({preventDefault() {}});
  f.context.selectionCurrent = false;
  f.node('#report-native-rows').innerHTML = 'Current report';
  pending.resolve({...f.page(0), row_query: 'Home', matched_row_count: 101});
  await read;
  assert.equal(f.node('#report-native-rows').innerHTML, 'Current report');
});
