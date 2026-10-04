import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as localeChecks from '../tools/check-locales.mjs';
import {catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';
import {accountWorkflowFixture, accountWorkflowCSV as csv} from './fixtures/account-workflows-ui.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const fixture = accountWorkflowFixture;

function depart(f, reason, form, result) {
  if (reason === 'edit') form.events.get('input')?.();
  else if (reason === 'detach') result.isConnected = false;
  else f.context[reason]++;
}

const observation = (name = 'purchase') => ({
  scope: {property_id: '123', stream_id: '900', minutes: 5},
  requested_at: 1,
  captured_at: 2,
  events: [
    {event_name: name, reported_count: '9007199254740995', state: 'observed'},
    {event_name: 'generate_lead', reported_count: null, state: 'not_observed'},
  ],
  rows: [{event_name: name, minutes_ago: 0, stream_id: '900', event_count: '9007199254740995'}],
  checks: {
    deduplication: 'unverified',
    consent: 'unverified',
    attribution: 'unverified',
    test_event_identity: 'unverified',
  },
  source_hash: 'evidence-hash',
});

async function comparisonFixture(locale = 'en') {
  const f = fixture(locale),
    products = structuredClone(catalogComparisonInput.products);
  products[1].name = 'Updated <img> shoe';
  const source =
    'retailer_id,name,price,currency,image_url\n' +
    products.map(p => [p.retailer_id, p.name, p.price, p.currency, p.image_url].join(',')).join('\n');
  f.node('catalog-import:file').files = [{size: source.length, text: async () => source}];
  f.node('catalog-import:allow_upsert').value = 'true';
  const preview = {
    source_hash: 'full-source-hash',
    meaning: catalogMeaning,
    items: products.map(p => ({retailer_id: p.retailer_id, price_minor_units: Math.round(Number(p.price) * 100)})),
  };
  f.respond(() => preview);
  await f.run('renderCommerce()');
  await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
  const evidence = {
    record_kind: 'catalog_comparison',
    complete: true,
    source_hash: preview.source_hash,
    scope: {gateway: 'meta_native_action', account_id: '001', connection_id: 'meta-login', catalog_id: '0001'},
    captured_at: 1,
    item_count: 4,
    summary: {new: 1, changed: 1, matching: 1, unknown: 1, blocked: 0, needs_review: 3},
    review_retailer_ids: ['001', '002', '004'],
    items: products.map((p, i) => ({
      retailer_id: p.retailer_id,
      product_id: i ? String(9007199254740993n + BigInt(i)) : null,
      state: ['new', 'changed', 'matching', 'unknown'][i],
      blocked: false,
      price_matches: i ? true : null,
      before: i
        ? {present: true, id: String(9007199254740993n + BigInt(i)), price: 'Native formatted ' + p.price}
        : {present: false},
      changes: i === 1 ? [{field: 'name', before: 'Previous <img>', after: p.name}] : [],
      unknown_fields: i === 3 ? ['image_url'] : [],
    })),
  };
  return {...f, products, evidence, preview};
}

test('catalog comparison handoffs select only current unambiguous scope and never start reads', async () => {
  for (const suffix of ['', '&account_id=999', '&catalog_id=0', '&catalog_comparison=1']) {
    const f = fixture('ar');
    f.context.location.search = '?catalog_comparison=1&connection_id=meta-login&account_id=001&catalog_id=555' + suffix;
    await f.run('renderCommerce()');
    assert.equal(f.node('catalog-import:target').value, suffix ? '' : '0');
    if (!suffix) assert.equal(f.node('catalog-import:catalog_id').value, '555');
    assert.equal(f.calls.length, 0);
    assert.match(f.node('#catalog-preview').innerHTML, /[\u0600-\u06ff]/);
  }
});

test('catalog comparison renders bilingual exact evidence and saves only eligible source products without submitting a change', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = await comparisonFixture(locale);
    f.respond(args => (args.action === 'catalog_compare' ? f.evidence : {id: 'filtered-plan'}));
    assert.equal(f.calls.length, 1, 'local preview does not automatically compare');
    await f.bindings.get('#compare-catalog-products')();
    const html = f.node('#catalog-comparison').innerHTML;
    assert.match(html, /9007199254740994/);
    assert.match(html, /Updated &lt;img&gt; shoe/);
    assert.doesNotMatch(html, /<img>/);
    assert.match(html, locale === 'ar' ? /حقول|الحقول/ : /Submitted fields match/);
    assert.match(html, /role="region".*tabindex="0"/);
    assert.match(html, /scope="row"/);
    assert.match(html, /scope="col"/);
    assert.match(html, /0 SAR/);
    assert.equal(f.node('#catalog-comparison-heading').focused, true);
    await f.bindings.get('#save-catalog-changes')();
    assert.deepEqual(f.calls[2].products, [f.products[0], f.products[1], f.products[3]]);
    assert.equal(f.calls[2].action, 'catalog_plan');
    assert.equal(f.calls[2].confirmed, undefined);
    assert.deepEqual(f.visits, ['/campaigns?id=filtered-plan']);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('catalog comparison rejects changed scope, source, partial rows, unsafe identity, counts and unknown price precision', async () => {
  for (const mutate of [
    e => (e.scope.account_id = '999'),
    e => (e.source_hash = 'old'),
    e => (e.complete = false),
    e => e.items.pop(),
    e => (e.items[1].product_id = 9007199254740992),
    e => (e.summary.changed = 3),
    e => (e.review_retailer_ids = ['003']),
    e => (e.items[2].price_matches = null),
    e => e.items[2].changes.push({field: 'price', before: 'bad', after_minor_units: 0, currency: 'SAR'}),
    e => (e.items[1].unknown_fields = ['unselected']),
    e => (e.items[0].changes = [{field: 'name', before: 'x', after: 'New shoe'}]),
  ]) {
    const f = await comparisonFixture();
    mutate(f.evidence);
    f.respond(() => f.evidence);
    await assert.rejects(f.bindings.get('#compare-catalog-products')(), /scope or evidence changed/);
    assert.equal(f.node('#catalog-comparison').innerHTML, '');
    assert.equal(f.bindings.has('#save-catalog-changes'), false);
  }
});

test('compact import previews use one accessible row per source product and exact source/native prices', async () => {
  const f = await comparisonFixture('ar'),
    html = f.node('#catalog-preview').innerHTML;
  assert.equal((html.match(/<tbody><tr>|<\/tr><tr>/g) ?? []).length, 4);
  assert.match(html, /1234/);
  assert.match(html, /12.34 SAR/);
  assert.match(html, /0 SAR/);
  assert.ok(html.indexOf('id="compare-catalog-products"') < html.indexOf('<table'));
  assert.match(html, /scope="row"/);
  assert.match(html, /scope="col"/);
});

test('matching imports offer no filtered draft while create-only conflicts retain only new rows', async () => {
  for (const blocked of [false, true]) {
    const f = await comparisonFixture();
    if (blocked) {
      f.node('catalog-import:allow_upsert').value = 'false';
      f.respond(() => f.preview);
      await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
      f.evidence.items.slice(1).forEach(i => (i.blocked = true));
      f.evidence.summary.blocked = 3;
      f.evidence.review_retailer_ids = ['001'];
      f.evidence.summary.needs_review = 1;
    } else {
      f.evidence.items.forEach((i, index) =>
        Object.assign(i, {
          state: 'matching',
          product_id: String(index + 1),
          price_matches: true,
          before: {present: true, id: String(index + 1), price: 'Native formatted'},
          changes: [],
          unknown_fields: [],
        }),
      );
      f.evidence.summary = {new: 0, changed: 0, matching: 4, unknown: 0, blocked: 0, needs_review: 0};
      f.evidence.review_retailer_ids = [];
    }
    f.respond(args => (args.action === 'catalog_compare' ? f.evidence : {id: 'new-only'}));
    await f.bindings.get('#compare-catalog-products')();
    if (blocked) {
      await f.bindings.get('#save-catalog-changes')();
      assert.deepEqual(f.calls.at(-1).products, [f.products[0]]);
    } else {
      assert.equal(f.bindings.has('#save-catalog-changes'), false);
      assert.match(f.node('#catalog-comparison').innerHTML, /No eligible product changes/);
    }
  }
});

test('late catalog comparisons and filtered plan saves cannot render, send or redirect after selection or identity changes', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach']) {
    for (const rejected of [false, true]) {
      const f = await comparisonFixture();
      let finish;
      f.respond(
        () =>
          new Promise((resolve, reject) => {
            finish = () => (rejected ? reject(Error('PRIVATE old error')) : resolve(f.evidence));
          }),
      );
      const pending = f.bindings.get('#compare-catalog-products')();
      depart(f, reason, f.node('#catalog-import'), f.node('#catalog-preview'));
      f.node('#catalog-comparison').innerHTML = 'Current selection';
      finish();
      await assert.doesNotReject(pending);
      assert.equal(f.node('#catalog-comparison').innerHTML, 'Current selection');
      assert.equal(f.bindings.has('#save-catalog-changes'), false);
    }
    const f = await comparisonFixture();
    f.respond(() => f.evidence);
    await f.bindings.get('#compare-catalog-products')();
    const save = f.bindings.get('#save-catalog-changes');
    depart(f, reason, f.node('#catalog-import'), f.node('#catalog-preview'));
    await save();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.visits, []);
  }
  const f = await comparisonFixture();
  f.respond(() => f.evidence);
  await f.bindings.get('#compare-catalog-products')();
  let finish;
  f.respond(
    () =>
      new Promise(resolve => {
        finish = () => resolve({id: 'old-plan'});
      }),
  );
  const pending = f.bindings.get('#save-catalog-changes')();
  f.context.identityGeneration++;
  finish();
  await pending;
  assert.deepEqual(f.visits, []);
});

const identityObservation = () => ({
  record_kind: 'measurement_event_identity',
  scope: {
    gateway: 'ga4_native_action',
    connection_id: 'ga4-login',
    property_id: '123',
    event_name: 'purchase',
    test_id: 'amcp-test-12345678-abcd',
    stream_id: '900',
    date_from: '2026-10-01',
    date_to: '2026-10-02',
  },
  period: {date_from: '2026-10-01', date_to: '2026-10-02', timezone: 'Asia/Riyadh'},
  observation: {reported_count: '9007199254740993', declared_expected_count: '1', comparison: 'above_declared'},
  rows: [
    {event_name: 'purchase', test_id: 'amcp-test-12345678-abcd', stream_id: '900', event_count: '9007199254740993'},
  ],
  requested_at: 1,
  captured_at: 2,
});
test('test identity handoffs prefill only the original selected scope with a valid bounded calendar period and never read automatically', async () => {
  const original = new URLSearchParams({
    event_identity: '1',
    connection_id: 'ga4-login',
    account_id: '123',
    event_name: 'purchase',
    test_id: 'amcp-test-12345678-abcd',
    date_from: '2026-10-01',
    date_to: '2026-10-02',
    stream_id: '900',
    expected_count: '2',
  });
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.location.search = '?' + original;
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-event-identity').elements.target.value, '0');
    for (const field of ['event_name', 'test_id', 'date_from', 'date_to', 'stream_id', 'expected_count'])
      assert.equal(f.node('#measurement-event-identity').elements[field].value, original.get(field));
    assert.deepEqual(f.calls, []);
  }
  for (const change of [
    p => p.set('connection_id', 'foreign-login'),
    p => p.set('account_id', '456'),
    p => p.append('test_id', 'amcp-test-other1234'),
    p => p.delete('expected_count'),
    p => p.set('test_id', 'person@example.test'),
    p => p.set('date_from', '2026-02-30'),
    p => p.set('date_to', '2026-10-08'),
    p => p.set('date_to', '2026-09-30'),
    p => p.set('stream_id', '0900'),
    p => p.set('expected_count', '1001'),
  ]) {
    const f = fixture(),
      p = new URLSearchParams(original);
    change(p);
    f.context.location.search = '?' + p;
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-event-identity').elements.target.value, '', String(p));
    assert.equal(f.node('#measurement-event-identity').elements.test_id.value, '');
    assert.deepEqual(f.calls, []);
  }
});
test('generating a synthetic test identifier makes no native call and invalidates any pending inspection', async () => {
  const f = fixture();
  let finish;
  f.respond(
    () =>
      new Promise(resolve => {
        finish = () => resolve(identityObservation());
      }),
  );
  await f.run('renderMeasurement()');
  const pending = f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity'));
  await f.bindings.get('#measurement-identity-generate')();
  assert.equal(
    f.node('#measurement-event-identity').elements.test_id.value,
    'amcp-test-12345678-1234-4123-8123-123456789abc',
  );
  assert.equal(f.node('#measurement-event-identity').elements.test_id.focused, true);
  assert.equal(f.calls.length, 1);
  finish();
  await pending;
  assert.equal(f.node('#measurement-event-identity-result').innerHTML, '');
});
test('test identity presentation keeps an absent count distinct from an explicit zero in both languages', async () => {
  for (const locale of ['en', 'ar'])
    for (const count of [null, '0']) {
      const f = fixture(locale),
        out = identityObservation();
      out.observation.reported_count = count;
      out.observation.comparison = count === null ? 'not_observed' : 'below_declared';
      out.rows = count === null ? [] : [{...out.rows[0], event_count: count}];
      f.respond(() => out);
      await f.run('renderMeasurement()');
      await f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity'));
      const html = f.node('#measurement-event-identity-result').innerHTML;
      assert.match(
        html,
        count === null ? (locale === 'ar' ? /لم يُرجع عدد/ : /No count returned/) : /<bdi dir="ltr">0<\/bdi>/,
      );
      assert.doesNotMatch(html, /9007199254740993/);
    }
});
test('test identity interface rejects foreign row scope, malformed counts and inconsistent totals before presenting evidence', async () => {
  for (const change of [
    out => {
      out.rows[0].test_id = 'amcp-test-foreign1234';
    },
    out => {
      out.rows[0].event_name = 'generate_lead';
    },
    out => {
      out.rows[0].stream_id = '901';
    },
    out => {
      out.rows[0].event_count = '01';
    },
    out => {
      out.rows.push({...out.rows[0]});
    },
    out => {
      out.observation.reported_count = '1';
    },
    out => {
      out.observation.comparison = 'matches_declared';
    },
    out => {
      out.period.timezone = '';
    },
    out => {
      out.scope.date_from = '2026-09-30';
    },
  ]) {
    const f = fixture(),
      out = identityObservation();
    change(out);
    f.respond(() => out);
    await f.run('renderMeasurement()');
    await assert.rejects(
      f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity')),
      /incomplete or belongs to a different selection/,
    );
    assert.equal(f.node('#measurement-event-identity-result').innerHTML, '');
  }
});
test('a newer test identity inspection wins when earlier current-scope requests finish out of order', async () => {
  const f = fixture(),
    pending = [];
  f.respond(() => new Promise(resolve => pending.push(resolve)));
  await f.run('renderMeasurement()');
  const run = () => f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity'));
  const first = run(),
    second = run(),
    newer = identityObservation();
  newer.observation.reported_count = newer.rows[0].event_count = '2';
  pending[1](newer);
  await second;
  const html = f.node('#measurement-event-identity-result').innerHTML;
  pending[0](identityObservation());
  await first;
  assert.equal(f.node('#measurement-event-identity-result').innerHTML, html);
  assert.doesNotMatch(html, /9007199254740993/);
});
test('specific GA4 test identity has bilingual readable evidence with identical read arguments and exact counts', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(() => identityObservation());
    await f.run('renderMeasurement()');
    assert.ok(f.bindings.has('#measurement-event-identity'), 'The selected test identity inspection is available.');
    await f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity'));
    const html = f.node('#measurement-event-identity-result').innerHTML;
    assert.match(html, /9007199254740993/);
    assert.match(html, /amcp-test-12345678-abcd/);
    assert.match(html, /Asia\/Riyadh/);
    assert.match(html, locale === 'ar' ? /لا يثبت/ : /does not establish deduplication/);
    assert.doesNotMatch(html, /tracking is healthy|deduplication verified/i);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
  assert.deepEqual(transcripts[0][0].requirements, {
    event_name: 'purchase',
    test_id: 'amcp-test-12345678-abcd',
    date_from: '2026-10-01',
    date_to: '2026-10-02',
    stream_id: '900',
    expected_count: 1,
  });
});
test('specific event identity discards late results and errors after edits, navigation, identity changes or detached output', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const failure of [false, true]) {
      const f = fixture();
      let finish;
      f.respond(
        () =>
          new Promise(
            (resolve, reject) =>
              (finish = () => (failure ? reject(Error('Old identity error')) : resolve(identityObservation()))),
          ),
      );
      await f.run('renderMeasurement()');
      const form = f.node('#measurement-event-identity'),
        result = f.node('#measurement-event-identity-result');
      assert.ok(f.bindings.has('#measurement-event-identity'));
      const pending = f.bindings.get('#measurement-event-identity')(form);
      depart(f, reason, form, result);
      finish();
      await pending;
      assert.equal(result.innerHTML, '');
    }
});

const conversionEvidence = (count = 101) => ({
  record_kind: 'conversion_rules',
  scope: {gateway: 'linkedin_native_action', account_id: '100', connection_id: 'linkedin-login'},
  complete: true,
  captured_at: 1,
  rule_count: count,
  rules: Array.from({length: count}, (_, i) => ({
    id: String(9007199254740993n + BigInt(i)),
    name: 'Purchase <img> ' + i,
    type: 'PURCHASE',
    enabled: i ? false : null,
    post_click_days: 30,
    post_view_days: i ? 7 : null,
    attribution_type: 'LAST_TOUCH_BY_CONVERSION',
    value_type: 'FIXED',
    value: {amount: '9007199254740993.123456789', currency: 'USD'},
  })),
});

test('conversion configuration renders bounded searchable bilingual rows with exact values and no tracking-health claim', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(() => conversionEvidence());
    await f.run('renderMeasurement()');
    const form = f.node('#measurement-conversions');
    await f.bindings.get('#measurement-conversions')(form);
    const result = f.node('#measurement-conversions-result').innerHTML,
      rows = f.node('#conversion-rule-rows').innerHTML;
    assert.match(rows, /9007199254740993\.123456789/);
    assert.match(rows, /Purchase &lt;img&gt; 0/);
    assert.doesNotMatch(rows, /<img>/);
    assert.match(rows, locale === 'ar' ? /غير معروف/ : /Unknown/);
    assert.match(result, locale === 'ar' ? /الإحالة التاريخية/ : /historical attribution/);
    await f.node('#conversion-rule-next').events.get('click')();
    assert.match(f.node('#conversion-rule-rows').innerHTML, /Purchase &lt;img&gt; 50/);
    f.node('#conversion-rule-search').value = '100';
    f.node('#conversion-rule-search').events.get('input')();
    assert.match(f.node('#conversion-rule-rows').innerHTML, /Purchase &lt;img&gt; 100/);
    assert.equal(f.node('#conversion-rule-next').disabled, true);
    assert.equal(f.calls.length, 1);
    requests.push(f.calls);
    const oldNext = f.node('#conversion-rule-next').events.get('click');
    form.events.get('input')();
    f.node('#conversion-rule-rows').innerHTML = 'Current selection';
    oldNext();
    assert.equal(f.node('#conversion-rule-rows').innerHTML, 'Current selection');
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], [
    {
      action: 'measurement_conversions',
      gateway: 'linkedin_native_action',
      account_id: '100',
      connection_id: 'linkedin-login',
    },
  ]);
});

test('conversion reads discard late responses and failures after edits, identity changes or departure', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const rejected of [false, true]) {
      const f = fixture();
      let finish;
      f.respond(
        () =>
          new Promise((resolve, reject) => {
            finish = rejected ? () => reject(Error('PRIVATE old error')) : () => resolve(conversionEvidence());
          }),
      );
      await f.run('renderMeasurement()');
      const form = f.node('#measurement-conversions'),
        result = f.node('#measurement-conversions-result'),
        pending = f.bindings.get('#measurement-conversions')(form);
      depart(f, reason, form, result);
      result.innerHTML = 'Current destination';
      finish();
      await assert.doesNotReject(pending);
      assert.equal(result.innerHTML, 'Current destination');
    }
});

test('conversion handoffs preselect only exact currently selected accounts and never start a read', async () => {
  for (const suffix of ['', '&account_id=999', '&conversion_rules=1']) {
    const f = fixture('ar');
    f.context.location.search = '?conversion_rules=1&connection_id=linkedin-login&account_id=100' + suffix;
    await f.run('renderMeasurement()');
    const form = f.node('#measurement-conversions');
    assert.equal(form.elements.target.value, suffix ? '' : '0');
    assert.equal(f.calls.length, 0);
    assert.match(f.node('#measurement-conversions-result').innerHTML, /[\u0600-\u06ff]/);
    assert.equal(
      f.node('measurement-audit:container_id').value,
      '001',
      'a conversion link does not overwrite GTM scope',
    );
  }
});

test('conversion view rejects inconsistent scope/counts and represents an explicit empty configuration', async () => {
  for (const patch of [{scope: {account_id: '999'}}, {rule_count: 102}, {complete: false}]) {
    const f = fixture();
    f.respond(() => ({...conversionEvidence(), ...patch}));
    await f.run('renderMeasurement()');
    await assert.rejects(
      f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions')),
      /changed|incomplete/i,
    );
    assert.equal(f.node('#measurement-conversions-result').innerHTML, '');
  }
  const f = fixture();
  f.respond(() => conversionEvidence(0));
  await f.run('renderMeasurement()');
  await f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions'));
  assert.match(f.node('#conversion-rule-rows').innerHTML, /No conversion rules were returned/);
});

test('conversion view refuses duplicated identities and imprecise or malformed projected settings', async () => {
  for (const change of [
    out => {
      out.rules[1].id = out.rules[0].id;
    },
    out => {
      out.rules[0].value.amount = 9007199254740992;
    },
    out => {
      out.rules[0].post_click_days = '30';
    },
    out => {
      out.rules[0].enabled = 'true';
    },
    out => {
      out.rules[0].name = {};
    },
    out => {
      out.captured_at = 'yesterday';
    },
  ]) {
    const f = fixture(),
      out = conversionEvidence();
    change(out);
    f.respond(() => out);
    await f.run('renderMeasurement()');
    await assert.rejects(
      f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions')),
      /changed|incomplete/i,
    );
    assert.equal(f.node('#measurement-conversions-result').innerHTML, '');
  }
});

test('GA4 observation controls preserve exact scope in both languages and present counts without claiming tracking health', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(() => observation('purchase<img>'));
    await f.run('renderMeasurement()');
    const form = f.node('#measurement-events');
    await f.bindings.get('#measurement-events')(form);
    const html = f.node('#measurement-events-result').innerHTML;
    assert.match(html, /9007199254740995/);
    assert.match(html, /purchase&lt;img&gt;/);
    assert.doesNotMatch(html, /<img>|tracking is healthy/i);
    if (locale === 'ar') {
      assert.match(f.node('content').innerHTML, /أحداث GA4 الحديثة/);
      assert.match(html, /لم يُرجع عدد/);
      assert.match(html, /الموافقة/);
    } else {
      assert.match(html, /No count returned/);
      assert.match(html, /deduplication, consent or attribution/);
    }
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
  assert.deepEqual(transcripts[0], [
    {
      action: 'measurement_events',
      gateway: 'ga4_native_action',
      account_id: '123',
      connection_id: 'ga4-login',
      requirements: {event_names: ['purchase', 'generate_lead'], minutes: 5, stream_id: '900'},
    },
  ]);
});

test('GA4 observations fence edits, departure, identity changes, detached controls and out-of-order responses', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const rejected of [false, true]) {
      const f = fixture();
      let finish;
      f.respond(
        () =>
          new Promise((resolve, reject) => {
            finish = rejected ? () => reject(Error('Old error')) : () => resolve(observation('Old event'));
          }),
      );
      await f.run('renderMeasurement()');
      const form = f.node('#measurement-events'),
        result = f.node('#measurement-events-result');
      const pending = f.bindings.get('#measurement-events')(form);
      depart(f, reason, form, result);
      finish();
      await pending;
      assert.equal(result.innerHTML, '', reason);
      if (reason !== 'edit') {
        await f.bindings.get('#measurement-events')(form);
        assert.equal(f.calls.length, 1, reason + ' must not start departed reads');
      }
    }
  const f = fixture(),
    releases = [];
  f.respond(() => new Promise(resolve => releases.push(resolve)));
  await f.run('renderMeasurement()');
  const form = f.node('#measurement-events'),
    result = f.node('#measurement-events-result');
  const first = f.bindings.get('#measurement-events')(form),
    second = f.bindings.get('#measurement-events')(form);
  releases[1](observation('Current event'));
  await second;
  releases[0](observation('Old event'));
  await first;
  assert.match(result.innerHTML, /Current event/);
  assert.doesNotMatch(result.innerHTML, /Old event/);
  f.respond(() => {
    throw Error('Current error');
  });
  await assert.rejects(f.bindings.get('#measurement-events')(form), /Current error/);
});

test('GA4 observation rejects missing property or event names before a read and allows an omitted stream', async () => {
  const f = fixture();
  f.respond(() => ({...observation(), events: [], rows: []}));
  await f.run('renderMeasurement()');
  const form = f.node('#measurement-events'),
    submit = () => f.bindings.get('#measurement-events')(form);
  form.elements.target.value = '';
  await assert.rejects(submit(), /GA4 property/);
  form.elements.target.value = '0';
  form.elements.event_names.value = ' , \n ';
  await assert.rejects(submit(), /event names/);
  assert.equal(f.calls.length, 0);
  form.elements.event_names.value = 'purchase\ngenerate_lead';
  form.elements.stream_id.value = '';
  await submit();
  assert.deepEqual(f.calls[0].requirements, {event_names: ['purchase', 'generate_lead'], minutes: 5});
  assert.match(f.node('#measurement-events-result').innerHTML, /No minute rows were returned/);
});
test('measurement results and errors cannot repaint a changed form, route, identity or detached view', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const rejected of [false, true]) {
      const f = fixture();
      let finish;
      f.respond(
        () =>
          new Promise((resolve, reject) => {
            finish = rejected
              ? () => reject(Error('Old account error'))
              : () => resolve({meaning: 'Old account evidence', configuration: {complete: true}});
          }),
      );
      await f.run('renderMeasurement()');
      const form = f.node('#measurement-audit'),
        result = f.node('#measurement-result'),
        pending = f.bindings.get('#measurement-audit')(form);
      depart(f, reason, form, result);
      finish();
      await pending;
      assert.equal(result.innerHTML, '', reason + ' stale evidence');
    }
});
test('a slow product file cannot submit after an account/form, identity, route or view change', async () => {
  for (const reason of ['identityGeneration', 'navigationGeneration', 'edit', 'detach']) {
    const f = fixture();
    let finish;
    f.node('catalog-import:file').files = [
      {
        size: csv.length,
        text: () =>
          new Promise(resolve => {
            finish = () => resolve(csv);
          }),
      },
    ];
    await f.run('renderCommerce()');
    const form = f.node('#catalog-import'),
      result = f.node('#catalog-preview'),
      pending = f.bindings.get('#catalog-import')(form);
    depart(f, reason, form, result);
    finish();
    await pending;
    assert.deepEqual(f.calls, [], reason);
  }
});
test('late product previews and errors cannot render or bind an obsolete plan', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const rejected of [false, true]) {
      const f = fixture();
      let finish;
      f.respond(
        () =>
          new Promise((resolve, reject) => {
            finish = rejected
              ? () => reject(Error('Old preview error'))
              : () => resolve({items: [], source_hash: 'old-hash', meaning: 'Old account preview'});
          }),
      );
      await f.run('renderCommerce()');
      const form = f.node('#catalog-import'),
        result = f.node('#catalog-preview'),
        pending = f.bindings.get('#catalog-import')(form);
      await new Promise(resolve => setImmediate(resolve));
      depart(f, reason, form, result);
      finish();
      await pending;
      assert.equal(result.innerHTML, '', reason);
      assert.equal(f.bindings.has('#create-catalog-plan'), false, reason);
    }
});
test('an obsolete product preview cannot save a plan, and a departed save cannot redirect the new view', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach']) {
    const f = fixture();
    await f.run('renderCommerce()');
    const form = f.node('#catalog-import'),
      result = f.node('#catalog-preview');
    await f.bindings.get('#catalog-import')(form);
    const save = f.bindings.get('#create-catalog-plan');
    depart(f, reason, form, result);
    await save();
    assert.equal(f.calls.length, 1, reason + ' stale save');
    assert.deepEqual(f.visits, []);
  }
  const f = fixture();
  await f.run('renderCommerce()');
  await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
  let finish;
  f.respond(
    () =>
      new Promise(resolve => {
        finish = () => resolve({id: 'old-plan'});
      }),
  );
  const saving = f.bindings.get('#create-catalog-plan')();
  f.context.identityGeneration++;
  finish();
  await saving;
  assert.deepEqual(f.visits, [], 'late saved plan cannot navigate a new identity');
});
test('Arabic measurement controls submit the original login, account and selected configuration scope', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderMeasurement()');
    if (locale === 'ar') assert.match(f.node('content').innerHTML, /أدلة القياس/);
    await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
    assert.match(f.node('#measurement-result').innerHTML, /Native evidence/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0], [
    {
      action: 'measurement_audit',
      connection_id: 'gtm-login',
      account_id: '001',
      requirements: {container_id: '001', workspace_id: '002'},
    },
  ]);
});

test('measurement audit mounts consent evidence inside the current scoped result in either language', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(() => ({
      meaning: 'Native evidence',
      configuration: {
        complete: true,
        findings: [],
        consent_evidence: {
          scope: 'workspace_configuration',
          workspace_path: 'accounts/001/containers/001/workspaces/002',
          configuration_hash: 'a'.repeat(64),
          tag_count: 1,
          counts: {notSet: 0, notNeeded: 0, needed: 1, unknown: 0},
          rows: [
            {
              path: 'native-path',
              tag_id: '007',
              name: 'Native consent tag',
              type: 'html',
              paused: false,
              setting: 'needed',
              required_types: ['ad_storage'],
              reason: null,
            },
          ],
          checks: {built_in_consent: 'unverified'},
        },
      },
    }));
    await f.run('renderMeasurement()');
    await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
    assert.match(f.node('#measurement-result').innerHTML, /id="gtm-consent-evidence"/);
    assert.match(f.node('#gtm-consent-rows').innerHTML, /Native consent tag/);
    assert.match(f.node('#gtm-consent-rows').innerHTML, /ad_storage/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('measurement audit handoff selects only a current exact login and scope and never starts an automatic read', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.location.search = '?connection_id=gtm-login&account_id=001&container_id=055&workspace_id=066';
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-audit').elements.target.value, '0');
    assert.equal(f.node('#measurement-audit').elements.container_id.value, '055');
    assert.equal(f.node('#measurement-audit').elements.workspace_id.value, '066');
    assert.equal(f.calls.length, 0);
    for (const search of [
      '?connection_id=missing&account_id=001&container_id=055',
      '?connection_id=gtm-login&account_id=999',
      '?connection_id=gtm-login&account_id=001&workspace_id=066',
      '?connection_id=gtm-login&account_id=001&container_id=..%2Fbad',
      '?connection_id=gtm-login&account_id=001&account_id=999',
    ]) {
      f.context.location.search = search;
      await f.run('renderMeasurement()');
      assert.equal(f.node('#measurement-audit').elements.target.value, '');
      assert.equal(f.node('#measurement-audit').elements.container_id.value, '');
      assert.equal(f.node('#measurement-audit').elements.workspace_id.value, '');
      assert.equal(f.calls.length, 0);
    }
  }
});
test('Arabic product import preserves CSV strings, native defaults and create-only semantics through preview and saved plan', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderCommerce()');
    const html = f.node('content').innerHTML;
    assert.match(html, /value="Product catalog import"/);
    if (locale === 'ar') assert.match(html, /استيراد منتجات الكتالوج/);
    await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
    f.respond(() => ({id: 'plan / 001'}));
    await f.bindings.get('#create-catalog-plan')();
    transcripts.push(f.calls);
    assert.deepEqual(f.visits, ['/campaigns?id=plan%20%2F%20001']);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  const {action, ...preview} = transcripts[0][0],
    {action: savedAction, ...saved} = transcripts[0][1];
  assert.equal(action, 'catalog_preview');
  assert.equal(savedAction, 'catalog_plan');
  assert.deepEqual(saved, preview);
  assert.equal(saved.allow_upsert, false);
  assert.equal(saved.catalog_id, '0001');
  assert.deepEqual(saved.products, [
    {retailer_id: '001', name: 'Home', price: '0012.34', currency: 'SAR', image_url: 'https://example.test/image.png'},
  ]);
});

test('column mapping loads locally and submits identical selected fields in English and Arabic through the reviewed plan', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      form = f.node('#catalog-import');
    const source =
      'SKU,Name,Regular price,Images,Private\n001,Home,0012.34,"https://example.test/a.png, https://example.test/b.png",SECRET-UNMAPPED\n';
    form.elements.file.files = [{size: source.length, text: async () => source}];
    form.elements.column_mode.value = 'mapped';
    await f.run('renderCommerce()');
    await f.bindings.get('#catalog-load-columns')();
    assert.equal(f.calls.length, 0);
    assert.match(f.node('#catalog-mapping').innerHTML, /SKU/);
    if (locale === 'ar') assert.match(f.node('content').innerHTML, /تعيين أعمدة CSV/);
    assert.equal(f.node('#catalog-map-price').value, '', 'price is never guessed from regular/sale columns');
    f.node('#catalog-map-retailer_id').value = 'SKU';
    f.node('#catalog-map-name').value = 'Name';
    f.node('#catalog-map-price').value = 'Regular price';
    f.node('#catalog-map-image_url').value = 'Images';
    form.elements.fixed_currency.value = 'SAR';
    form.elements.image_mode.value = 'first_list';
    await f.bindings.get('#catalog-import')(form);
    assert.doesNotMatch(JSON.stringify(f.calls), /SECRET-UNMAPPED|b.png/);
    assert.match(f.node('#catalog-preview').innerHTML, /0012.34/);
    f.respond(() => ({id: 'mapped-plan'}));
    await f.bindings.get('#create-catalog-plan')();
    assert.deepEqual(f.visits, ['/campaigns?id=mapped-plan']);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
  assert.deepEqual(transcripts[0][0].products, [
    {retailer_id: '001', name: 'Home', price: '0012.34', image_url: 'https://example.test/a.png', currency: 'SAR'},
  ]);
  assert.deepEqual(transcripts[0][1].products, transcripts[0][0].products);
});

test('column mapping requires the loaded file and fences changed forms, departure, errors and stale plans', async () => {
  for (const reason of ['navigationGeneration', 'identityGeneration', 'edit', 'detach'])
    for (const rejected of [false, true]) {
      const f = fixture(),
        form = f.node('#catalog-import'),
        result = f.node('#catalog-preview');
      form.elements.column_mode.value = 'mapped';
      let finish;
      form.elements.file.files = [
        {
          size: 100,
          text: () =>
            new Promise((resolve, reject) => {
              finish = rejected ? () => reject(Error('Old file error')) : () => resolve(csv);
            }),
        },
      ];
      await f.run('renderCommerce()');
      const loading = f.bindings.get('#catalog-load-columns')();
      depart(f, reason, form, result);
      finish();
      await loading;
      assert.equal(f.node('#catalog-mapping').innerHTML, '', reason);
      assert.equal(f.calls.length, 0);
    }
  const f = fixture(),
    form = f.node('#catalog-import');
  form.elements.column_mode.value = 'mapped';
  await f.run('renderCommerce()');
  await assert.rejects(f.bindings.get('#catalog-import')(form), /Load the selected CSV/);
  await f.bindings.get('#catalog-load-columns')();
  await f.bindings.get('#catalog-import')(form);
  const save = f.bindings.get('#create-catalog-plan');
  form.events.get('input')();
  await save();
  assert.equal(f.calls.length, 1, 'changed mapping cannot save old plan');
  form.elements.file.files = [{size: csv.length, text: async () => csv}];
  await assert.rejects(f.bindings.get('#catalog-import')(form), /Load the selected CSV/);
  assert.equal(f.calls.length, 1);
});

test('Arabic portfolio keeps native hierarchy, status, exact money and continuation tokens', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(args => ({
      account_id: args.account_id,
      rows: [
        {
          id: args.requirements.entity === 'campaign' ? 'c-001' : 'set-001',
          name: 'Home <img>',
          status: 'ACTIVE',
          effective_status: 'CAMPAIGN_PAUSED',
          native_money: {daily_budget: '9007199254740993'},
          currency: 'SAR',
          timezone: 'Africa/Cairo',
          native: {name: 'Home'},
        },
      ],
      has_more: true,
      next_cursor: 'original-cursor',
      captured_at: 1,
      meaning: 'Native inventory',
    }));
    await f.run('renderPortfolio()');
    await f.bindings.get('#portfolio-account')(f.node('#portfolio-account'));
    const html = f.node('#portfolio-view').innerHTML;
    assert.match(html, /9007199254740993/);
    assert.match(html, /CAMPAIGN_PAUSED/);
    assert.match(html, /Home &lt;img&gt;/);
    if (locale === 'ar') assert.match(html, /مجموعات الإعلانات/);
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    await f.bindings.get('[data-portfolio-child]')({dataset: {portfolioChild: '0'}});
    await f.bindings.get('#portfolio-next')();
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(
    transcripts[0].map(r => r.requirements),
    [
      {entity: 'campaign'},
      {entity: 'adset', campaign_id: 'c-001'},
      {entity: 'ad', campaign_id: 'c-001', adset_id: 'set-001'},
      {entity: 'ad', campaign_id: 'c-001', adset_id: 'set-001'},
    ],
  );
  assert.equal(transcripts[0][3].cursor, 'original-cursor');
});

test('newer measurement and product previews win; current errors remain visible to the caller', async () => {
  for (const workflow of ['measurement', 'commerce']) {
    const f = fixture(),
      form = f.node(workflow === 'measurement' ? '#measurement-audit' : '#catalog-import'),
      selector = workflow === 'measurement' ? '#measurement-audit' : '#catalog-import',
      result = f.node(workflow === 'measurement' ? '#measurement-result' : '#catalog-preview');
    await f.run(workflow === 'measurement' ? 'renderMeasurement()' : 'renderCommerce()');
    const releases = [];
    f.respond(() => new Promise(resolve => releases.push(resolve)));
    const first = f.bindings.get(selector)(form);
    await new Promise(resolve => setImmediate(resolve));
    const second = f.bindings.get(selector)(form);
    await new Promise(resolve => setImmediate(resolve));
    const response = meaning =>
      workflow === 'measurement'
        ? {meaning, configuration: {complete: true}}
        : {meaning, items: [], source_hash: 'hash-' + meaning};
    releases[1](response('Current'));
    await second;
    releases[0](response('Obsolete'));
    await first;
    assert.match(result.innerHTML, /Current/);
    assert.doesNotMatch(result.innerHTML, /Obsolete/);
    f.respond(() => {
      throw Error('Current account error');
    });
    await assert.rejects(f.bindings.get(selector)(form), /Current account error/);
  }
});

const measurementMeaning =
  'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.';
const auditLimitation =
  'Read-only configuration observations; no compiler, browser execution, consent or live tag-delivery qualification.';
const catalogMeaning =
  'Preview is based on supplied product data. Current provider items are read by each native review before execution. Partial or uncertain writes retain per-item receipts in the campaign journal.';
const triggerMessage = id =>
  'Trigger ' +
  id +
  ' is not in the workspace inventory; resolve whether it is provider-managed or missing before publishing.';

test('account explanations translate only selected authored copy, preserving native and legacy text', () => {
  const f = fixture('ar');
  assert.equal(f.run('typeof uiAccountExplanation'), 'function');
  for (const message of [measurementMeaning, auditLimitation, catalogMeaning]) {
    f.context.message = message;
    assert.match(f.run('uiAccountExplanation(message)'), /[\u0600-\u06ff]/);
  }
  for (const message of ['Home', 'Complete', 'Native inventory', 'Provider diagnostic <img>', '0012.34 SAR']) {
    f.context.message = message;
    assert.equal(f.run('uiAccountExplanation(message)'), message);
  }
  const en = fixture('en');
  en.context.message = measurementMeaning;
  assert.equal(en.run('uiAccountExplanation(message)'), measurementMeaning);
});

test('GTM finding translations require matching typed metadata and retain original diagnostics', () => {
  const f = fixture('ar');
  assert.equal(f.run('typeof uiGtmFindingMessage'), 'function');
  const examples = [
    {
      code: 'DUPLICATE_NAME',
      message: 'Another tag has this same name; choose IDs explicitly.',
      message_localization: {key: 'duplicate_name', kind: 'tag'},
    },
    {
      code: 'UNRESOLVED_OR_SYSTEM_TRIGGER',
      message: triggerMessage('native_001-ABC'),
      message_localization: {key: 'unresolved_trigger', trigger_id: 'native_001-ABC'},
    },
    {
      code: 'NO_LIVE_VERSION',
      message: 'No live version was returned (scoped 404).',
      message_localization: {key: 'missing_version', version: 'live'},
    },
    {
      code: 'NO_LATEST_VERSION',
      message: 'No latest version was returned (scoped 404).',
      message_localization: {key: 'missing_version', version: 'latest'},
    },
  ];
  for (const finding of examples) {
    f.context.finding = finding;
    const before = JSON.stringify(finding);
    const text = f.run('uiGtmFindingMessage(finding)');
    assert.match(text, /[\u0600-\u06ff]/);
    if (finding.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER') assert.ok(text.includes('native_001-ABC'));
    assert.equal(JSON.stringify(finding), before);
    const en = fixture('en');
    en.context.finding = finding;
    assert.equal(en.run('uiGtmFindingMessage(finding)'), finding.message);
  }
  for (const finding of [
    {...examples[0], message_localization: undefined},
    {...examples[0], code: 'PROVIDER_CODE'},
    {...examples[0], message: 'Original diagnostic Home'},
    {...examples[0], message_localization: {key: 'duplicate_name', kind: 'unknown'}},
    {...examples[1], message_localization: {key: 'unresolved_trigger', trigger_id: 123}},
    {
      ...examples[1],
      message: triggerMessage('<img>'),
      message_localization: {key: 'unresolved_trigger', trigger_id: '<img>'},
    },
    {...examples[2], message_localization: {key: 'missing_version', version: 'latest'}},
  ]) {
    f.context.finding = finding;
    assert.equal(f.run('uiGtmFindingMessage(finding)'), finding.message);
  }
});

test('measurement shows translated finding context and limits without changing raw evidence or either language request', async () => {
  const transcripts = [];
  const evidence = {
    meaning: measurementMeaning,
    configuration: {
      complete: true,
      publish_ready: null,
      limitations: [auditLimitation, 'Provider limit Home <img>'],
      findings: [
        {
          code: 'UNRESOLVED_OR_SYSTEM_TRIGGER',
          severity: 'unknown',
          path: 'accounts/001/containers/001/workspaces/002/tags/0007',
          message: triggerMessage('native_001-ABC'),
          message_localization: {key: 'unresolved_trigger', trigger_id: 'native_001-ABC'},
        },
        {
          code: 'UNRESOLVED_FOLDER',
          severity: 'error',
          path: 'exact-native-path',
          message: 'The parent folder is absent from the complete workspace inventory.',
        },
        {
          code: 'PROVIDER_CODE',
          severity: 'native-severity',
          path: 'Home <img>',
          message: 'Provider message Complete <img>',
        },
      ],
      versions: {live: {id: '00009'}},
    },
  };
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    const before = JSON.stringify(evidence);
    f.respond(() => evidence);
    await f.run('renderMeasurement()');
    await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
    const html = f.node('#measurement-result').innerHTML;
    assert.ok(html.includes('UNRESOLVED_OR_SYSTEM_TRIGGER'));
    assert.ok(html.includes('native_001-ABC'));
    assert.ok(html.includes('accounts/001/containers/001/workspaces/002/tags/0007'));
    assert.ok(html.includes('Provider message Complete &lt;img&gt;'));
    assert.ok(html.includes('Provider limit Home &lt;img&gt;'));
    assert.doesNotMatch(html, /<img>/);
    assert.equal(JSON.stringify(evidence), before);
    if (locale === 'ar') {
      assert.ok(html.includes(f.context.catalog[measurementMeaning]));
      assert.ok(html.includes(f.context.catalog[auditLimitation]));
      assert.ok(html.includes(f.context.catalog['Unresolved or system trigger']));
      assert.ok(html.includes(f.context.catalog['Unknown']));
      assert.ok(html.includes(triggerMessage('native_001-ABC')), 'original message remains in raw evidence');
    }
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});

test('portfolio and catalog pages use selected translated explanations and preserve exact native items', async () => {
  const f = fixture('ar');
  await f.run('renderPortfolio()');
  for (const provider of ['google', 'meta', 'linkedin', 'snapchat', 'tiktok', 'x']) {
    const file = 'src/' + provider + '-portfolio.ts';
    const meanings = [...localeChecks.inspectAccountExplanations(readFileSync(file, 'utf8'), file)];
    assert.equal(meanings.length, 1);
    const meaning = meanings[0];
    f.respond(args => ({account_id: args.account_id, rows: [], has_more: false, meaning, captured_at: 1}));
    await f.bindings.get('#portfolio-account')(f.node('#portfolio-account'));
    assert.ok(f.context.catalog[meaning], provider + ' explanation has a translation');
    assert.ok(f.node('#portfolio-view').innerHTML.includes(f.context.catalog[meaning]));
  }
  f.respond(() => ({items: [{name: 'Home', price: '0012.34'}], meaning: catalogMeaning, source_hash: 'native-hash'}));
  await f.run('renderCommerce()');
  await f.bindings.get('#catalog-import')(f.node('#catalog-import'));
  const html = f.node('#catalog-preview').innerHTML;
  assert.ok(html.includes(f.context.catalog[catalogMeaning]));
  assert.match(html, /0012.34/);
  assert.match(html, /Home/);
});

test('account locale extraction selects authored meanings, audit limits and static finding text, excluding native data and dynamic fragments', () => {
  assert.equal(typeof localeChecks.inspectAccountExplanations, 'function');
  const source = `const r={meaning:'Known meaning',limitations:['Known limit'],message:'Native message',name:'Home'};
    finding('warning','NATIVE_CODE',path,'Known finding');
    finding('unknown','NATIVE_CODE',path,'Trigger '+id+' is missing');`;
  assert.deepEqual([...localeChecks.inspectAccountExplanations(source, 'src/gtm-diagnostics.ts')].sort(), [
    'Known finding',
    'Known limit',
    'Known meaning',
  ]);
  assert.deepEqual([...localeChecks.inspectAccountExplanations(source, 'src/workspace.ts')], ['Known meaning']);
});
