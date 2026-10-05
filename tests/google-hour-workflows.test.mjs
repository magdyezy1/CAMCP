import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {inspectReportingFailures, localeProblems} from '../tools/check-locales.mjs';
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
    toasts = [],
    opened = [];
  const node = id => {
    if (!nodes.has(id)) {
      const attributes = new Map();
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        hidden: true,
        value: '',
        checked: false,
        disabled: false,
        readOnly: false,
        isConnected: true,
        events: new Map(),
        attributes,
        getAttribute: key => attributes.get(key) ?? null,
        setAttribute: (key, value) => attributes.set(key, String(value)),
        removeAttribute: key => attributes.delete(key),
        insertAdjacentHTML(_where, text) {
          this.innerHTML += text;
        },
        addEventListener(type, callback) {
          this.events.set(type, callback);
        },
      });
    }
    return nodes.get(id);
  };
  const form = node('#capture-preset'),
    button = node('#capture-submit');
  form.querySelector = selector => {
    assert.equal(selector, 'button[type=submit]');
    return button;
  };
  form.elements = Object.fromEntries(
    [
      'preset',
      'target',
      'source_name',
      'date_from',
      'date_to',
      'currency',
      'timezone',
      'attribution',
      'conversion_definition',
      'complete',
      'campaign_id',
      'result_action_type',
      'attribution_windows',
      'swipe_up_attribution_window',
      'view_attribution_window',
    ].map(key => [key, node('field:' + key)]),
  );
  Object.assign(form.elements.preset, {value: 'google_keyword'});
  Object.assign(form.elements.target, {value: '0'});
  for (const [key, value] of Object.entries({
    source_name: 'Native evidence',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    currency: 'USD',
    timezone: 'UTC',
    attribution: 'Declared original attribution',
    conversion_definition: 'metrics.conversions',
  }))
    form.elements[key].value = value;
  form.elements.complete.checked = true;
  let respond = () => {
    throw Object.assign(Error('Google did not return a bounded positive Search keyword with its native match type.'), {
      code: 'REPORT_SHAPE_CHANGED',
      requestId: 'synthetic-feedback-reference',
      next_action:
        'Compare the native response with the recorded field mapping and API version before capturing again.',
    });
  };
  const context = createContext({
    document: {addEventListener() {}},
    Intl,
    Date,
    navigationGeneration: 1,
    identityGeneration: 1,
    $: node,
    platforms: [{id: 'google', connections: [{id: 'original-login', enabled: true, accounts: ['123']}]}],
    accountLabel: () => 'Original Google account',
    controls: () => '',
    workspaceBind: (selector, callback) => bindings.set(selector, callback),
    workspaceCall: async (_tool, input) => {
      if (input.action === 'capture_presets')
        return {
          presets: [
            {id: 'google_keyword', name: 'Google keyword performance', gateway: 'google_ads_native_action'},
            {
              id: 'google_campaign_device',
              name: 'Google campaign device performance',
              gateway: 'google_ads_native_action',
            },
            {
              id: 'google_campaign_hour',
              name: 'Google campaign hourly performance',
              gateway: 'google_ads_native_action',
            },
          ],
        };
      calls.push(JSON.parse(JSON.stringify(input)));
      return respond(input);
    },
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    toast: value => toasts.push(value),
    openReport: async id => opened.push(id),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  context.catalog = catalog;
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')")));
  const source = readFileSync('web/evidence-workflows.js', 'utf8');
  run(source.slice(source.indexOf('function evidencePresetLabel('), source.indexOf('\nfunction mountScenarioModel(')));
  return {
    node,
    form,
    button,
    context,
    calls,
    toasts,
    opened,
    catalog,
    run,
    mount: () => run('mountCaptureWizard(openReport)'),
    submit: () => bindings.get('#capture-preset')(form),
    respond: fn => {
      respond = fn;
    },
    change: key => form.events.get('input')({target: form.elements[key]}),
  };
}

test('hour capture exposes a translated choice and its own scope note without changing original settings or making early reads', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.form.elements.preset.value = 'google_campaign_hour';
    await f.mount();
    assert.equal(f.calls.length, 0);
    assert.equal(f.node('#capture-google-hour-measurement').hidden, false);
    assert.equal(f.node('#capture-google-device-measurement').hidden, true);
    assert.equal(f.node('#capture-google-keyword-measurement').hidden, true);
    assert.equal(f.form.elements.conversion_definition.value, 'metrics.conversions');
    assert.equal(f.form.elements.conversion_definition.readOnly, true);
    assert.equal(
      f.run("evidencePresetLabel({id:'google_campaign_hour'})"),
      locale === 'ar' ? f.catalog['Google campaign hourly performance'] : 'Google campaign hourly performance',
    );
    f.respond(input => {
      assert.equal(input.preset, 'google_campaign_hour');
      assert.equal(input.action, 'capture_preset');
      assert.equal(input.account_id, '123');
      assert.equal(input.connection_id, 'original-login');
      assert.equal(input.semantics.timezone, 'UTC');
      assert.equal(input.semantics.attribution, 'Declared original attribution');
      assert.equal(input.semantics.conversion_definition, 'metrics.conversions');
      assert.equal(input.semantics.complete, true);
      return {id: 'complete-hour-report'};
    });
    await f.submit();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.opened, ['complete-hour-report']);
    assert.equal(f.node('#capture-feedback').hidden, true);
  }
});
test('hour diagnostics translate wrapper text while keeping the original error and reference, and clear on an explicit settings edit', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.form.elements.preset.value = 'google_campaign_hour';
    await f.mount();
    const original = 'Google did not return the requested native hour/day reporting grain.';
    const error = Object.assign(Error(original), {code: 'REPORT_SHAPE_CHANGED', requestId: 'synthetic-hour-reference'});
    f.respond(() => {
      throw error;
    });
    await f.submit();
    assert.equal(error.message, original);
    assert.equal(f.node('#capture-feedback').hidden, false);
    const display = f.node('#capture-feedback-message').textContent;
    assert.ok(display.includes(locale === 'ar' ? f.catalog[original] : original));
    assert.ok(display.includes('synthetic-hour-reference'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.opened.length, 0);
    assert.equal(f.toasts.length, 0);
    f.change('date_from');
    assert.equal(f.node('#capture-feedback').hidden, true);
    assert.equal(f.node('#capture-feedback-message').textContent, '');
    assert.equal(f.calls.length, 1);
  }
});

test('hour mapping language ownership selects only exact authored calls and refuses missing Arabic without collecting native values', () => {
  const sample =
    "nativeHourMappingFailure('Owned hour refusal.');nativeDeviceMappingFailure('Owned device refusal.');bad('Other refusal.');incomplete('Other collection.');nativeHourMappingFailure(native.message ?? 'Native fallback.');nativeHourMappingFailure('Hour ' + native.hour);object.nativeHourMappingFailure('Native member.');";
  const messages = inspectReportingFailures(sample, 'src/decision-reporting.ts');
  assert.deepEqual([...messages], ['Owned hour refusal.', 'Owned device refusal.']);
  assert.deepEqual(localeProblems({}, messages), [
    'Missing Arabic message: Owned hour refusal.',
    'Missing Arabic message: Owned device refusal.',
  ]);
  assert.equal(inspectReportingFailures(sample, 'src/other-decision-reporting.ts').size, 0);
  const actual = inspectReportingFailures(
      readFileSync('src/decision-reporting.ts', 'utf8'),
      'src/decision-reporting.ts',
    ),
    catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  assert.equal(actual.size, 4);
  assert.deepEqual(localeProblems(catalog, actual), []);
  for (const hour of ['0', '23'])
    assert.ok(catalog['Native hour must retain an explicit integer from 0 through 23.'].includes(hour));
});
