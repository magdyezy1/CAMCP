// MSR-01: consent drafts offer the documented Google consent types; any other literal (for example the typo
// analytic_storage) needs an explicit acknowledgement and stays labelled in the preview, brief and review step.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {gtmConsentFixture, gateway, path} from './fixtures/gtm-consent-data.mjs';
import {gtmDocumentedConsentTypes} from '../dist/src/gtm-consent-evidence.js';

const requirements = types => ({
  container_id: '55',
  workspace_id: '66',
  tag_ids: ['001', '002'],
  required_types: types,
});

test('MSR-01 a non-standard consent type is refused before any read unless the preview acknowledges it', async t => {
  const f = gtmConsentFixture(t);
  const refused = await f.call({requirements: requirements(['ad_storage', 'analytic_storage'])});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'CONSENT_CUSTOM_TYPES_UNACKNOWLEDGED');
  assert.deepEqual(refused.error.details.custom_types, ['analytic_storage']);
  const malformed = await f.call({
    requirements: {...requirements(['analytic_storage']), custom_types_acknowledged: 'yes'},
  });
  assert.equal(malformed.error.code, 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 0, 'refusals make no provider read');
  const p = await f.call({
    requirements: {...requirements(['ad_storage', 'analytic_storage']), custom_types_acknowledged: true},
  });
  assert.equal(p.success, true, JSON.stringify(p.error));
  assert.deepEqual(p.data.scope.custom_types, ['analytic_storage']);
  assert.equal(p.data.scope.custom_types_acknowledged, true);
  const created = await f.create(p.data);
  assert.equal(created.success, true, JSON.stringify(created.error));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', created.data.id);
  assert.match(run.brief, /Non-standard consent types acknowledged by the requester: analytic_storage\./);
  assert.deepEqual(
    run.steps.map(step => step.description),
    [
      'Tag 001: require additional consent ad_storage, analytic_storage. Non-standard types acknowledged: analytic_storage',
      'Tag 002: require additional consent analytics_storage, ad_storage, analytic_storage. Non-standard types acknowledged: analytic_storage',
    ],
  );
  assert.deepEqual(run.gtm_consent.scope.custom_types, ['analytic_storage']);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('MSR-01 documented types need no acknowledgement and keep the original preview shape', async t => {
  const f = gtmConsentFixture(t),
    p = await f.call({requirements: requirements([...gtmDocumentedConsentTypes])});
  assert.equal(p.success, true, JSON.stringify(p.error));
  assert.equal(p.data.scope.custom_types, undefined);
  assert.equal(p.data.scope.custom_types_acknowledged, undefined);
  const run = f.store.document(f.actor.tenantId, 'campaign_run', (await f.create(p.data)).data.id);
  assert.doesNotMatch(run.brief, /Non-standard/);
  assert.ok(run.steps.every(step => !/Non-standard/.test(step.description)));
});

function ui(t, locale = 'en') {
  const native = gtmConsentFixture(t),
    nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        textContent: '',
        hidden: false,
        isConnected: true,
        events: new Map(),
        addEventListener(k, fn) {
          this.events.set(k, fn);
        },
        focus() {},
        elements: {
          tag_ids: {selectedOptions: []},
          required_types: {value: ''},
          standard_types: Object.assign(
            gtmDocumentedConsentTypes.map(value => ({value, checked: false})),
            {item: () => null},
          ),
          custom_types_acknowledged: {value: 'true', checked: false},
        },
      });
    return nodes.get(key);
  };
  const context = createContext({
    Intl,
    URLSearchParams,
    Date,
    document: {addEventListener() {}},
    $: node,
    navigationGeneration: 1,
    identityGeneration: 1,
    evidence: {
      scope: 'workspace_configuration',
      workspace_path: path,
      tag_count: 2,
      rows: [...native.tags.values()].map(tag => ({
        tag_id: tag.tagId,
        path: tag.path,
        name: tag.name,
        setting: 'notSet',
      })),
    },
    scope: {gateway, connection_id: native.connection.id, account_id: '44', container_id: '55', workspace_id: '66'},
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    workspaceBind: (key, fn) => bindings.set(key, fn),
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      const out = await native.service.call('amcp_workspace', args, native.actor);
      if (!out.success) throw Error(out.error.message);
      return out.data;
    },
    recordDetails: () => '',
    campaignNativeValue: value => `<code dir="ltr">${String(value ?? '')}</code>`,
    badge: () => '',
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  // WEB-07: the Measurement page's own module, over the shared helper; it registers its page with the route registry.
  for (const file of ['routes.js', 'account-workflows.js', 'measurement.js']) run(readFileSync('web/' + file, 'utf8'));
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  run('mountGtmConsentDraft(evidence,scope,()=>true)');
  const form = node('#gtm-consent-form');
  form.elements.tag_ids.selectedOptions = [{value: '001'}, {value: '002'}];
  return {native, node, run, context, calls, form, submit: () => bindings.get('#gtm-consent-form')()};
}

for (const locale of ['en', 'ar'])
  test(locale + ' MSR-01 consent form offers documented types and requires an acknowledgement for a typo', async t => {
    const f = ui(t, locale),
      html = f.node('#gtm-consent-draft').innerHTML;
    for (const type of gtmDocumentedConsentTypes)
      assert.match(html, new RegExp(`name="standard_types" value="${type}"`));
    assert.match(html, /name="custom_types_acknowledged"/);
    if (locale === 'ar') assert.match(html, new RegExp(f.context.catalog['Documented Google consent types']));
    f.form.elements.standard_types[1].checked = true;
    f.form.elements.required_types.value = 'analytic_storage';
    await assert.rejects(f.submit(), /analytic_storage/);
    const warning = f.node('#gtm-consent-custom-warning');
    assert.equal(warning.hidden, false);
    assert.match(warning.textContent, /analytics_storage/, 'the likely intended documented type is suggested');
    assert.equal(f.calls.length, 0);
    f.form.elements.custom_types_acknowledged.checked = true;
    await f.submit();
    assert.equal(warning.hidden, true);
    assert.deepEqual(f.calls[0].requirements, {
      container_id: '55',
      workspace_id: '66',
      tag_ids: ['001', '002'],
      required_types: ['analytics_storage', 'analytic_storage'],
      custom_types_acknowledged: true,
    });
    const preview = f.node('#gtm-consent-preview').innerHTML;
    assert.match(preview, /<code dir="ltr">analytic_storage<\/code>/);
    assert.match(
      preview,
      new RegExp(locale === 'ar' ? f.context.catalog['Non-standard consent type'] : 'Non-standard consent type'),
    );
    assert.ok(f.native.requests.every(r => r.method === 'GET'));
  });

test('MSR-01 checked documented types alone submit without acknowledgement and the review step labels typos', async t => {
  const f = ui(t);
  f.form.elements.standard_types[0].checked = true;
  f.form.elements.standard_types[2].checked = true;
  await f.submit();
  assert.deepEqual(f.calls[0].requirements.required_types, ['ad_storage', 'ad_user_data']);
  assert.equal(f.calls[0].requirements.custom_types_acknowledged, undefined);
  const native = f.native,
    p = await native.call({requirements: {...requirements(['analytic_storage']), custom_types_acknowledged: true}}),
    created = await native.create(p.data),
    saved = native.store.document(native.actor.tenantId, 'campaign_run', created.data.id);
  f.context.savedRun = saved;
  const step = f.run('consentStepDescription(savedRun.steps[0],consentReviewContext(savedRun))');
  assert.ok(step, 'the labelled step still matches its original proposal');
  assert.match(step, /Non-standard consent type/);
  assert.match(step, /analytic_storage/);
  assert.match(f.run('consentProposalView(consentReviewContext(savedRun))'), /Non-standard consent type/);
  saved.steps[0].description = saved.steps[0].description.replace(
    '. Non-standard types acknowledged: analytic_storage',
    '',
  );
  assert.equal(f.run('consentStepDescription(savedRun.steps[0],consentReviewContext(savedRun))'), null);
});
