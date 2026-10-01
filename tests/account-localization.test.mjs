import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const csv = 'retailer_id,name,price,currency,image_url\r\n001,Home,0012.34,SAR,https://example.test/image.png\r\n';
function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    visits = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        value: '',
        isConnected: true,
        events: new Map(),
        elements: {},
        dataset: {},
        files: [],
        addEventListener(event, fn) {
          this.events.set(event, fn);
        },
        setAttribute() {},
        focus() {},
      });
    return nodes.get(key);
  };
  for (const [name, fields] of Object.entries({
    'measurement-audit': ['target', 'container_id', 'workspace_id'],
    'measurement-events': ['target', 'event_names', 'minutes', 'stream_id'],
    'catalog-import': ['target', 'catalog_id', 'name', 'allow_upsert', 'file'],
    'portfolio-account': ['target'],
  })) {
    for (const field of fields) node('#' + name).elements[field] = node(name + ':' + field);
    node('#' + name).elements.target.value = '0';
  }
  node('measurement-audit:container_id').value = '001';
  node('measurement-audit:workspace_id').value = '002';
  node('measurement-events:event_names').value = 'purchase, generate_lead';
  node('measurement-events:minutes').value = '5';
  node('measurement-events:stream_id').value = '900';
  node('catalog-import:catalog_id').value = '0001';
  node('catalog-import:name').value = 'Home';
  node('catalog-import:allow_upsert').value = 'false';
  node('catalog-import:file').files = [{size: csv.length, text: async () => csv}];
  let handler = args =>
    args.action === 'measurement_audit'
      ? {meaning: 'Native evidence', configuration: {complete: true, findings: [], versions: {native: '001'}}}
      : {
          items: [{id: '001', name: 'Home', price: '0012.34'}],
          source_hash: 'original-hash',
          meaning: 'Original preview',
        };
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    content: node('content'),
    $: node,
    platforms: ['gtm', 'meta', 'google', 'ga4'].map(id => ({
      id,
      gateway: id + '_native_action',
      connections: [{id: id + '-login', enabled: true, accounts: [id === 'ga4' ? '123' : '001']}],
    })),
    accountLabel: p => p.id,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: async (_tool, args) => {
      calls.push(plain(args));
      return handler(args);
    },
    navigate: async path => visits.push(path),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    controls: (label, type, value, name) =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
    date: String,
    pretty: v => String(v ?? '').replaceAll('_', ' '),
    badge: String,
    blank: String,
    recordDetails: value => JSON.stringify(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    reviewTable: JSON.stringify,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync(process.env.AMCP_ACCOUNT_UI_SOURCE ?? 'web/account-workflows.js', 'utf8'));
  return {
    context,
    run,
    node,
    bindings,
    calls,
    visits,
    respond: fn => {
      handler = fn;
    },
  };
}
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
test('Arabic product import preserves CSV strings, native defaults and create-only semantics through preview and saved plan', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderCommerce()');
    const html = f.node('content').innerHTML;
    assert.match(html, /value="Product catalog import"/);
    if (locale === 'ar') assert.match(html, /استيراد منتجات Meta/);
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
