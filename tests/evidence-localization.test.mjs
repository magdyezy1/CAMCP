import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const plain = x => JSON.parse(JSON.stringify(x));
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
    calls = [],
    opened = [],
    toasts = [],
    blobs = [],
    downloads = [];
  const rows = [
    {entity_id: '001', name: 'Home <img>', observed_spend: '00100.00', observed_conversions: '20'},
    {entity_id: '002', name: 'Home', observed_spend: '100', observed_conversions: '10'},
  ];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        isConnected: true,
        elements: {},
        events: new Map(),
        open: true,
        addEventListener(e, fn) {
          this.events.set(e, fn);
        },
        insertAdjacentHTML(_at, html) {
          this.innerHTML += html;
        },
        querySelector: node,
        querySelectorAll: () =>
          rows.map(row => ({
            dataset: {allocationCampaign: row.entity_id},
            querySelector: s => ({value: s === '[data-floor]' ? '0001.25' : '0100.00'}),
          })),
        focus() {},
        setAttribute() {},
      });
    return nodes.get(id);
  };
  const fields = {
    preset: 'meta_campaign',
    target: '1',
    source_name: 'Home',
    date_from: '2026-09-01',
    date_to: '2026-09-07',
    currency: 'USD',
    timezone: 'Asia/Riyadh',
    attribution: 'Native attribution',
    conversion_definition: 'Native purchase',
    result_action_type: 'offsite_conversion.fb_pixel_purchase',
    attribution_windows: '7d_click,1d_view',
    complete: '',
    budgets: '0012.34\n20.00',
    efficiency_low: '0.8',
    efficiency_high: '1.2',
    budget: '0200.00',
    minimum_conversions: '5',
    maximum_age_days: '7',
  };
  for (const selector of ['#capture-preset', '#scenario-model', '#allocation-model'])
    for (const [k, value] of Object.entries(fields))
      node(selector).elements[k] = {
        value,
        checked: k === 'complete',
        events: new Map(),
        addEventListener(e, fn) {
          this.events.set(e, fn);
        },
      };
  const presets = [
    {id: 'google_campaign', name: 'Google campaign performance', gateway: 'google_ads_native_action'},
    {id: 'meta_campaign', name: 'Meta campaign performance', gateway: 'meta_native_action'},
    {id: 'linkedin_campaign', name: 'LinkedIn campaign performance', gateway: 'linkedin_native_action'},
  ];
  const report = {
    id: 'source-001',
    preset: 'meta_campaign',
    account_id: '001',
    semantics: {currency: 'USD', timezone: 'Asia/Riyadh', date_from: '2026-09-01', date_to: '2026-09-07'},
  };
  let respond = () => ({}),
    confirm = async () => true;
  const context = createContext({
    Intl,
    Date,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'owner'},
    document: {
      addEventListener() {},
      createElement: () => ({
        click() {
          downloads.push(this.download);
        },
      }),
    },
    content: node('content'),
    $: node,
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.options = options;
        blobs.push(this);
      }
    },
    URL: {createObjectURL: () => 'blob:synthetic', revokeObjectURL() {}},
    URLSearchParams,
    setTimeout() {},
    window: {print() {}},
    location: {search: '?report_id=snapshot-001'},
    platforms: ['google', 'meta', 'linkedin'].map(id => ({
      id,
      connections: [{id: id + '-login', enabled: true, accounts: ['001']}],
    })),
    accountLabel: (_p, c, a) => c.id + ' ' + a,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    pretty: v =>
      String(v ?? '')
        .replaceAll('_', ' ')
        .replace(/\b\w/g, c => c.toUpperCase()),
    date: String,
    controls: (label, type, value, name) =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
    blank: String,
    badge: String,
    recordDetails: (v, title) => `<h4>${title}</h4>${JSON.stringify(v)}`,
    toast: x => toasts.push(x),
    openReport: async id => opened.push(id),
    bindReportPresentation: async () => {},
    workspaceBind: (s, fn) => bindings.set(s, fn),
    confirmAction: o => confirm(o),
    report,
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: plain(args)});
      return args.action === 'capture_presets' ? {presets} : respond(args);
    },
    overviewCall: async args => {
      calls.push({tool: 'overview', args: plain(args)});
      return respond(args);
    },
    workPageLoader: (_selector, _title, _fetch, render, bind) => {
      const out = {candidates: rows, currency: 'USD'};
      node('#allocation-candidates').innerHTML = render(out);
      bind(out);
      return {load: async () => {}};
    },
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/report-quality.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  run(readFileSync(process.env.AMCP_EVIDENCE_UI_SOURCE || 'web/evidence-workflows.js', 'utf8'));
  run(readFileSync(process.env.AMCP_ALLOCATION_UI_SOURCE || 'web/report-allocation.js', 'utf8'));
  const allocate = () => {
    run('mountAllocationModel(report)');
    for (const row of rows)
      bindings.get('#allocation-candidates [data-allocation-add]')({dataset: {allocationAdd: row.entity_id}});
  };
  return {
    run,
    node,
    bindings,
    calls,
    opened,
    toasts,
    blobs,
    downloads,
    context,
    report,
    allocate,
    respond: fn => {
      respond = fn;
    },
    confirm: fn => {
      confirm = fn;
    },
  };
}
const scenario = () => ({
  evidence_status: 'complete',
  observed: {cpa: '0012.34'},
  currency: 'USD',
  scenarios: [{budget: '0012.34', modeled_conversions_low: 1.25, modeled_conversions_high: 2.5}],
  limitations: ['Native explanation'],
});
test('guided LinkedIn capture explains fixed UTC and native conversions in Arabic while retaining exact requests', async () => {
  const f = fixture('ar');
  await f.run('mountCaptureWizard(openReport)');
  const form = f.node('#capture-preset');
  form.elements.preset.value = 'linkedin_campaign';
  form.elements.preset.events.get('change')();
  assert.match(form.elements.target.innerHTML, /linkedin-login 001/);
  assert.equal(form.elements.timezone.value, 'UTC');
  assert.equal(form.elements.timezone.readOnly, true);
  assert.equal(form.elements.conversion_definition.value, 'externalWebsiteConversions');
  assert.equal(form.elements.conversion_definition.readOnly, true);
  assert.equal(f.node('#capture-linkedin-measurement').hidden, false);
  assert.doesNotMatch(f.node('#report-capture').innerHTML, /LinkedIn campaign performance|LinkedIn uses UTC/);
  form.elements.target.value = '2';
  form.elements.attribution.value = 'unknown';
  f.respond(() => ({id: 'li-evidence'}));
  await f.bindings.get('#capture-preset')(form);
  const request = f.calls.at(-1).args;
  assert.equal(request.account_id, '001');
  assert.equal(request.connection_id, 'linkedin-login');
  assert.equal(request.semantics.timezone, 'UTC');
  assert.equal(request.semantics.conversion_definition, 'externalWebsiteConversions');
  assert.equal(request.semantics.attribution, 'unknown');
  assert.equal(request.result_action_type, undefined);
  assert.deepEqual(f.opened, ['li-evidence']);
  form.elements.preset.value = 'google_campaign';
  form.elements.preset.events.get('change')();
  assert.equal(form.elements.timezone.value, 'Asia/Riyadh');
  assert.equal(form.elements.timezone.readOnly, false);
  assert.equal(form.elements.conversion_definition.value, 'Native purchase');
  assert.equal(form.elements.conversion_definition.readOnly, false);
});
const allocation = () => ({
  total_budget: '0200.00',
  currency: 'USD',
  period: {days: 7},
  modeled_conversions_low: 20,
  modeled_conversions_high: 30,
  allocations: [
    {
      entity_id: '001',
      name: 'Home <img>',
      observed_spend: '00100.00',
      minimum: '0001.25',
      maximum: '0100.00',
      proposed_budget: '0100.00',
      binding_constraints: ['cap'],
      modeled_conversions_low: 20,
      modeled_conversions_high: 30,
    },
  ],
  limitations: ['Native model evidence'],
  model_fingerprint: 'exact-model',
});
const pack = () => ({
  title: 'Home <img>',
  client_name: 'Home',
  state: 'partial',
  grain: 'weekly',
  row_count: 2,
  created_at: '2026-10-01',
  date_range: {since: '2026-09-01', until: '2026-09-07'},
  summary: [
    {
      platform: 'meta',
      account_id: '001',
      objective_group: 'sales',
      timezone: 'Asia/Riyadh',
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      currency: 'USD',
      attribution: 'Native attribution',
      result_definition: 'Native purchase',
      complete: false,
      metrics: {spend: 12.34, impressions: 100, clicks: 2, conversions: null, cpa: null, ctr: 2},
    },
  ],
  sources: [
    {
      platform: 'meta',
      account_id: '001',
      complete: false,
      row_count: 2,
      attribution: 'Native attribution',
      result_definition: 'Native purchase',
      query_fingerprint: 'native-hash',
    },
  ],
  limitations: ['Native explanation'],
  snapshot_id: 'snapshot-001',
  source_hash: 'source-hash',
  csv_path: '/native.csv',
  evidence_path: '/native.json',
});

test('evidence capture cannot reopen old settings after edits, navigation or identity changes', async () => {
  for (const change of ['input', 'change', 'identityGeneration', 'navigationGeneration', 'detach'])
    for (const reject of [false, true]) {
      const f = fixture();
      await f.run('mountCaptureWizard(openReport)');
      const form = f.node('#capture-preset'),
        gate = deferred();
      f.respond(() => gate.promise);
      const pending = f.bindings.get('#capture-preset')(form);
      if (['input', 'change'].includes(change)) form.events.get(change)?.({target: form.elements.currency});
      else if (change === 'detach') f.node('#report-capture').isConnected = false;
      else f.context[change]++;
      if (reject) gate.reject(Error('Old capture failed'));
      else gate.resolve({id: 'old'});
      await pending;
      assert.deepEqual(f.opened, [], change);
      assert.deepEqual(f.toasts, []);
    }
});
test('scenario results and errors belong to the newest unchanged form', async () => {
  for (const change of ['input', 'identityGeneration', 'navigationGeneration', 'detach'])
    for (const reject of [false, true]) {
      const f = fixture();
      f.run('mountScenarioModel(report)');
      const form = f.node('#scenario-model'),
        gate = deferred();
      f.respond(() => gate.promise);
      const pending = f.bindings.get('#scenario-model')(form);
      if (change === 'input') form.events.get('input')?.({target: form.elements.budgets});
      else if (change === 'detach') f.node('#scenario-result').isConnected = false;
      else f.context[change]++;
      if (reject) gate.reject(Error('Old scenario failed'));
      else gate.resolve(scenario());
      await pending;
      assert.equal(f.node('#scenario-result').innerHTML, '');
    }
  const f = fixture();
  f.run('mountScenarioModel(report)');
  const form = f.node('#scenario-model'),
    gates = [deferred(), deferred()];
  let i = 0;
  f.respond(() => gates[i++].promise);
  const first = f.bindings.get('#scenario-model')(form),
    second = f.bindings.get('#scenario-model')(form);
  gates[1].resolve(scenario());
  await second;
  const latest = f.node('#scenario-result').innerHTML;
  gates[0].resolve({...scenario(), currency: 'SAR'});
  await first;
  assert.equal(f.node('#scenario-result').innerHTML, latest);
});
test('Arabic detailed capture and scenarios retain account, attribution and exact budget inputs', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('mountCaptureWizard(openReport)');
    const form = f.node('#capture-preset');
    if (locale === 'ar') assert.match(f.node('#report-capture').innerHTML, /جمع أدلة تفصيلية من المنصة/);
    f.respond(() => ({id: 'retained'}));
    await f.bindings.get('#capture-preset')(form);
    const call = f.calls.at(-1).args;
    assert.equal(call.account_id, '001');
    assert.equal(call.connection_id, 'meta-login');
    assert.equal(call.result_action_type, 'offsite_conversion.fb_pixel_purchase');
    assert.deepEqual(call.attribution_windows, ['7d_click', '1d_view']);
    assert.equal(call.semantics.complete, true);
    f.run('mountScenarioModel(report)');
    f.respond(() => scenario());
    await f.bindings.get('#scenario-model')(f.node('#scenario-model'));
    assert.deepEqual(f.calls.at(-1).args.options.budgets, ['0012.34', '20.00']);
    assert.match(f.node('#scenario-result').innerHTML, /0012.34/);
    assert.match(f.node('#scenario-result').innerHTML, /Native explanation/);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
});
test('measurement edits revoke a capture completeness declaration but its own checkbox remains usable', async () => {
  const f = fixture();
  await f.run('mountCaptureWizard(openReport)');
  const form = f.node('#capture-preset');
  form.elements.complete.checked = true;
  form.events.get('change')?.({target: form.elements.complete});
  assert.equal(form.elements.complete.checked, true);
  form.events.get('input')?.({target: form.elements.date_from});
  assert.equal(form.elements.complete.checked, false);
});
test('Arabic allocation preserves exact selected bounds and native preview/create identities', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.report.preset = 'google_campaign';
    f.allocate();
    f.respond(() => allocation());
    await f.bindings.get('#allocation-model')();
    if (locale === 'ar') assert.match(f.node('#allocation-result').innerHTML, /التوزيع المقترح للفترة/);
    assert.equal(f.calls.at(-1).args.options.budget, '0200.00');
    assert.deepEqual(f.calls.at(-1).args.options.allocations, [
      {entity_id: '001', minimum: '0001.25', maximum: '0100.00'},
      {entity_id: '002', minimum: '0001.25', maximum: '0100.00'},
    ]);
    f.node('#allocation-conversion').value = 'equal_daily';
    f.respond(() => ({
      preview_id: 'preview-001',
      preview_hash: 'exact-hash',
      model_fingerprint: 'exact-model',
      account_id: '001',
      currency: 'USD',
      timezone: 'Asia/Riyadh',
      period_days: 7,
      meaning: 'Native preview meaning',
      targets: [
        {
          name: 'Home <img>',
          campaign_id: '001',
          budget_resource: 'customers/001/campaignBudgets/002',
          current_daily_budget: '0012.34',
          period_budget: '0100.00',
          daily_budget: '14.285714',
          daily_budget_micros: '14285714',
          rounding_residual: '0.000002',
        },
      ],
    }));
    await f.bindings.get('#allocation-preview-plan')();
    assert.match(f.node('#allocation-plan-result').innerHTML, /14285714/);
    f.respond(() => ({id: 'draft/001'}));
    await f.bindings.get('#allocation-create-plan')();
    assert.deepEqual(f.calls.at(-1).args, {
      action: 'create_allocation_plan',
      id: 'source-001',
      preview_id: 'preview-001',
      preview_hash: 'exact-hash',
      confirmed: true,
    });
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
});
test('allocation stale errors, detached callbacks and obsolete downloads cannot act on a newer form', async () => {
  const f = fixture();
  f.allocate();
  const gate = deferred();
  f.respond(() => gate.promise);
  const pending = f.bindings.get('#allocation-model')();
  f.node('#allocation-model').events.get('input')();
  gate.reject(Error('Old allocation failed'));
  await pending;
  f.respond(() => allocation());
  await f.bindings.get('#allocation-model')();
  const download = f.bindings.get('#allocation-download');
  f.node('#allocation-model').events.get('input')();
  download();
  assert.deepEqual(f.downloads, []);
  f.context.identityGeneration++;
  const count = f.calls.length;
  await f.bindings.get('#allocation-model')();
  assert.equal(f.calls.length, count);
});
test('Arabic report packs and saved HTML retain source evidence and declare the matching text direction', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.respond(() => pack());
    await f.run('renderReportPack()');
    const html = f.node('content').innerHTML;
    if (locale === 'ar') assert.match(html, /ملخصات الحسابات والقياس/);
    assert.match(html, /Home &lt;img&gt;/);
    assert.match(html, /Native attribution/);
    assert.match(html, /native-hash/);
    assert.doesNotMatch(html, /Unknown USD/);
    f.bindings.get('#download-pack')();
    assert.deepEqual(f.downloads, ['AMCP-report-pack.html']);
    const saved = f.blobs[0].parts.join('');
    assert.match(saved, new RegExp('lang="' + locale + '"'));
    assert.match(saved, new RegExp('dir="' + (locale === 'ar' ? 'rtl' : 'ltr') + '"'));
    assert.match(saved, /source-hash/);
    f.context.identityGeneration++;
    f.bindings.get('#download-pack')();
    assert.equal(f.downloads.length, 1);
  }
});

test('capture preset discovery cannot paint or report errors after an identity change', async () => {
  for (const reject of [false, true]) {
    const f = fixture(),
      gate = deferred();
    f.context.workspaceCall = () => gate.promise;
    const pending = f.run('mountCaptureWizard(openReport)');
    f.context.identityGeneration++;
    if (reject) gate.reject(Error('Old presets failed'));
    else
      gate.resolve({
        presets: [{id: 'meta_campaign', name: 'Meta campaign performance', gateway: 'meta_native_action'}],
      });
    await pending;
    assert.equal(f.node('#report-capture').innerHTML, '');
    assert.equal(f.bindings.has('#capture-preset'), false);
  }
});

test('only the latest capture opens and current model errors remain visible without obsolete resubmission', async () => {
  const f = fixture();
  await f.run('mountCaptureWizard(openReport)');
  const form = f.node('#capture-preset'),
    gates = [deferred(), deferred()];
  let index = 0;
  f.respond(() => gates[index++].promise);
  const first = f.bindings.get('#capture-preset')(form),
    second = f.bindings.get('#capture-preset')(form);
  gates[1].resolve({id: 'newest'});
  await second;
  gates[0].resolve({id: 'old'});
  await first;
  assert.deepEqual(f.opened, ['newest']);
  f.respond(async () => {
    throw Error('Current model failure');
  });
  await assert.rejects(f.bindings.get('#capture-preset')(form), /Current model failure/);
  f.run('mountScenarioModel(report)');
  await assert.rejects(f.bindings.get('#scenario-model')(f.node('#scenario-model')), /Current model failure/);
  f.allocate();
  await assert.rejects(f.bindings.get('#allocation-model')(), /Current model failure/);
  f.context.identityGeneration++;
  const count = f.calls.length;
  await f.bindings.get('#capture-preset')(form);
  await f.bindings.get('#scenario-model')(f.node('#scenario-model'));
  assert.equal(f.calls.length, count);
});

test('Arabic analysis explanations render through real scenario, allocation and report-pack controllers without altering evidence', async () => {
  const f = fixture('ar');
  f.run('mountScenarioModel(report)');
  const modeled = {
    ...scenario(),
    limitations: ['Illustrative sensitivity model, not a forecast or a statistical confidence interval.', 'Home'],
  };
  const before = JSON.stringify(modeled);
  f.respond(() => modeled);
  await f.bindings.get('#scenario-model')(f.node('#scenario-model'));
  assert.match(f.node('#scenario-result').innerHTML, /نموذج حساسية توضيحي/);
  assert.match(f.node('#scenario-result').innerHTML, /Illustrative sensitivity model/);
  assert.match(f.node('#scenario-result').innerHTML, /<li>Home<\/li>/);
  assert.equal(JSON.stringify(modeled), before);
  f.allocate();
  f.respond(() => ({
    ...allocation(),
    limitations: [
      'Illustrative constrained sensitivity model, not a forecast or statistical confidence interval.',
      'Home',
    ],
  }));
  await f.bindings.get('#allocation-model')();
  assert.match(f.node('#allocation-result').innerHTML, /نموذج حساسية مقيّد توضيحي/);
  const saved = {
      ...pack(),
      limitations: ['Account currencies, timezones, attribution and conversion definitions remain separate.', 'Home'],
    },
    raw = JSON.stringify(saved);
  f.respond(() => saved);
  await f.run('renderReportPack()');
  assert.match(f.node('content').innerHTML, /تظل عملات الحسابات/);
  assert.match(f.node('content').innerHTML, /<li>Home<\/li>/);
  assert.equal(JSON.stringify(saved), raw);
});
