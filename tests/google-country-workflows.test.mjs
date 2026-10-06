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
              id: 'google_campaign_country',
              name: 'Google campaign country performance',
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

test('country capture retains bilingual settings, precise choices and explicit native submission', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.form.elements.preset.value = 'google_campaign_country';
    await f.mount();
    assert.equal(f.calls.length, 0);
    assert.equal(f.node('#capture-google-country-measurement').hidden, false);
    assert.equal(f.node('#capture-google-hour-measurement').hidden, true);
    assert.equal(f.form.elements.conversion_definition.value, 'metrics.conversions');
    assert.equal(
      f.run("evidencePresetLabel({id:'google_campaign_country'})"),
      locale === 'ar' ? f.catalog['Google campaign country performance'] : 'Google campaign country performance',
    );
    f.respond(input => {
      assert.equal(input.preset, 'google_campaign_country');
      assert.equal(input.account_id, '123');
      assert.equal(input.connection_id, 'original-login');
      assert.equal(input.semantics.timezone, 'UTC');
      return {id: 'original-country-report'};
    });
    await f.submit();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.opened, ['original-country-report']);
  }
});
test('country refusal remains translated with its original reference until the user edits the current settings', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.form.elements.preset.value = 'google_campaign_country';
    await f.mount();
    const reason = 'Google did not return the requested native country and location type.',
      error = Object.assign(Error(reason), {code: 'REPORT_SHAPE_CHANGED', requestId: 'original-country-reference'});
    f.respond(() => {
      throw error;
    });
    await f.submit();
    const html = f.node('#capture-feedback-message').textContent;
    assert.ok(html.includes(locale === 'ar' ? f.catalog[reason] : reason));
    assert.ok(html.includes(error.requestId));
    assert.equal(error.message, reason);
    assert.equal(f.node('#capture-feedback').hidden, false);
    assert.equal(f.toasts.length, 0);
    f.change('attribution');
    assert.equal(f.node('#capture-feedback').hidden, true);
    assert.equal(f.calls.length, 1);
  }
});
test('obsolete country failure cannot overwrite new settings or start a replacement provider read', async () => {
  const f = fixture('ar');
  f.form.elements.preset.value = 'google_campaign_country';
  await f.mount();
  const d = deferred();
  f.respond(() => d.promise);
  const pending = f.submit();
  f.form.elements.attribution.value = 'Changed original country scope';
  f.change('attribution');
  d.reject(
    Object.assign(Error('Google did not return the requested native country and location type.'), {
      code: 'REPORT_SHAPE_CHANGED',
      requestId: 'obsolete-country-reference',
    }),
  );
  await pending;
  assert.equal(f.form.elements.attribution.value, 'Changed original country scope');
  assert.equal(f.node('#capture-feedback').hidden, true);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.opened.length, 0);
});
