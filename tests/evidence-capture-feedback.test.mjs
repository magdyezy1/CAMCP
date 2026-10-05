import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
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

test('current failed capture keeps original wire settings and a persistent described alert without duplicate toast', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.mount();
    f.form.setAttribute('aria-describedby', 'original-form-note');
    f.button.setAttribute('aria-describedby', 'original-button-note');
    await f.submit();
    const region = f.node('#capture-feedback'),
      message = f.node('#capture-feedback-message').textContent;
    assert.equal(region.hidden, false);
    assert.ok(message.includes('synthetic-feedback-reference'));
    assert.ok(
      message.includes(
        locale === 'ar'
          ? f.catalog['Google did not return a bounded positive Search keyword with its native match type.']
          : 'Google did not return a bounded positive Search keyword with its native match type.',
      ),
    );
    assert.equal(f.form.getAttribute('aria-describedby'), 'original-form-note capture-feedback');
    assert.equal(f.button.getAttribute('aria-describedby'), 'original-button-note capture-feedback');
    assert.equal(f.button.id, 'capture-preset-submit');
    assert.equal(f.toasts.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].account_id, '123');
    assert.equal(f.calls[0].connection_id, 'original-login');
    assert.equal(f.calls[0].preset, 'google_keyword');
    assert.equal(f.calls[0].semantics.attribution, 'Declared original attribution');
    assert.equal(f.form.elements.complete.checked, true);
    assert.match(f.button.innerHTML, /role="alert" aria-atomic="true" hidden/);
  }
});

test('settings edits clear only the current capture error and preserve unrelated descriptions and completeness rules', async () => {
  for (const key of [
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
  ]) {
    const f = fixture();
    await f.mount();
    f.form.setAttribute('aria-describedby', 'original-note');
    await f.submit();
    f.change(key);
    assert.equal(f.node('#capture-feedback').hidden, true, key);
    assert.equal(f.node('#capture-feedback-message').textContent, '', key);
    assert.equal(f.form.getAttribute('aria-describedby'), 'original-note', key);
    assert.equal(f.button.getAttribute('aria-describedby'), null, key);
    assert.equal(f.form.elements.complete.checked, key === 'complete', key);
    assert.equal(f.calls.length, 1, key);
  }
});

test('a new explicit capture clears previous feedback before waiting and only an explicit successful retry opens evidence', async () => {
  const f = fixture();
  await f.mount();
  await f.submit();
  const pending = deferred();
  f.respond(() => pending.promise);
  const retry = f.submit();
  assert.equal(f.node('#capture-feedback').hidden, true);
  assert.equal(f.node('#capture-feedback-message').textContent, '');
  pending.resolve({id: 'complete-new-report'});
  await retry;
  assert.deepEqual(f.opened, ['complete-new-report']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.toasts.length, 1);
  assert.equal(f.node('#capture-feedback').hidden, true);
});

test('late failed or successful captures cannot paint errors or open reports after a setting, route, identity or form change', async () => {
  for (const outcome of ['success', 'failure'])
    for (const change of ['setting', 'route', 'identity', 'form', 'root']) {
      const f = fixture();
      await f.mount();
      const pending = deferred();
      f.respond(() => pending.promise);
      const reading = f.submit();
      if (change === 'setting') f.change('target');
      if (change === 'route') f.context.navigationGeneration++;
      if (change === 'identity') f.context.identityGeneration++;
      if (change === 'form') f.form.isConnected = false;
      if (change === 'root') f.node('#report-capture').isConnected = false;
      if (outcome === 'failure') pending.reject(Error('Late native <img> diagnostic'));
      else pending.resolve({id: 'departed-report'});
      await reading;
      assert.equal(f.node('#capture-feedback-message').textContent, '', outcome + ':' + change);
      assert.equal(f.toasts.length, 0, outcome + ':' + change);
      assert.equal(f.opened.length, 0, outcome + ':' + change);
    }
});

test('unknown native capture diagnostics remain literal text and preserve the original API error object', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.mount();
    const api = {
      success: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Native <img src=x onerror=alert(1)> SAR 9007199254.740993',
        details: {account_id: '00123'},
        next_action: 'Native retry detail',
      },
      meta: {requestId: 'native-reference-00123'},
    };
    f.context.api = api;
    const error = f.run('requestError(api)'),
      original = JSON.stringify(api);
    f.respond(() => {
      throw error;
    });
    await f.submit();
    assert.ok(f.node('#capture-feedback-message').textContent.startsWith(api.error.message));
    assert.ok(f.node('#capture-feedback-message').textContent.includes('native-reference-00123'));
    assert.equal(f.node('#capture-feedback-message').innerHTML, '');
    assert.equal(JSON.stringify(api), original);
    assert.equal(error.message, api.error.message);
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.details, api.error.details);
    assert.equal(f.toasts.length, 0);
  }
});

test('silent superseded capture errors never expose a blank alert or description', async () => {
  const f = fixture();
  await f.mount();
  f.respond(() => {
    throw f.run('supersededRequest()');
  });
  await f.submit();
  assert.equal(f.node('#capture-feedback').hidden, true);
  assert.equal(f.form.getAttribute('aria-describedby'), null);
  assert.equal(f.button.getAttribute('aria-describedby'), null);
  assert.equal(f.toasts.length, 0);
});

test('missing or unrecognized account/preset selection shows current feedback before any capture request', async () => {
  for (const locale of ['en', 'ar'])
    for (const change of ['target', 'preset']) {
      const f = fixture(locale);
      await f.mount();
      f.form.elements[change].value = change === 'target' ? '' : 'unrecognized-preset';
      await f.submit();
      assert.equal(f.calls.length, 0);
      assert.equal(f.node('#capture-feedback').hidden, false);
      const original = 'Choose the exact account for this provider.';
      assert.equal(f.node('#capture-feedback-message').textContent, locale === 'ar' ? f.catalog[original] : original);
      assert.equal(f.toasts.length, 0);
    }
});
