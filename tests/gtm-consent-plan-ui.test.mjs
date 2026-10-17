import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {gtmConsentFixture, gateway, path} from './fixtures/gtm-consent-data.mjs';
import {inspectAccountExplanations} from '../tools/check-locales.mjs';

test('consent localization selects authored refusals while excluding native fallbacks, technical codes and other workflows', () => {
  const source = `bad('Choose a new preview.', 'CONSENT_PREVIEW_CHANGED');
    bad(result.error?.message ?? 'Native fallback', result.error?.code);
    invalid('The tag changed.'); const args = {action:'UPDATE_TAG',path:'accounts/44'};`;
  assert.deepEqual(
    [...inspectAccountExplanations(source, 'src/gtm-consent-plans.ts')],
    ['Choose a new preview.', 'The tag changed.'],
  );
  assert.deepEqual([...inspectAccountExplanations(source, 'src/other-workflow.ts')], []);
});
function fixture(t, locale = 'en') {
  const native = gtmConsentFixture(t),
    nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        isConnected: true,
        events: new Map(),
        addEventListener(k, fn) {
          this.events.set(k, fn);
        },
        focus() {
          this.focused = true;
        },
        elements: {tag_ids: {selectedOptions: []}, required_types: {value: ''}},
      });
    return nodes.get(key);
  };
  const scope = {
    gateway,
    connection_id: native.connection.id,
    account_id: '44',
    container_id: '55',
    workspace_id: '66',
  };
  const evidence = {
    scope: 'workspace_configuration',
    workspace_path: path,
    tag_count: 3,
    rows: [...native.tags.values()].map(tag => ({
      tag_id: tag.tagId,
      path: tag.path,
      name: tag.name,
      setting: tag.tagId === '002' ? 'needed' : 'notSet',
    })),
  };
  evidence.rows.push({tag_id: '003', path: path + '/tags/003', name: 'Unknown <tag>', setting: 'unknown'});
  let provider = async (_tool, args) => {
    const out = await native.service.call('amcp_workspace', args, native.actor);
    if (!out.success) throw Error(out.error.message);
    return out.data;
  };
  const context = createContext({
    Intl,
    URLSearchParams,
    Date,
    document: {addEventListener() {}},
    $: node,
    navigationGeneration: 1,
    identityGeneration: 1,
    selectedScopeCurrent: true,
    evidence,
    scope,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    workspaceBind: (key, fn) => bindings.set(key, fn),
    workspaceCall: async (tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return provider(tool, args);
    },
    recordDetails: (value, title) =>
      `<details><summary>${title}</summary><pre>${JSON.stringify(value)}</pre></details>`,
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
  return {
    native,
    node,
    run,
    context,
    calls,
    evidence,
    scope,
    bindings,
    provider: fn => {
      provider = fn;
    },
    mount: () => run('mountGtmConsentDraft(evidence,scope,()=>selectedScopeCurrent)'),
    choose: (ids = ['001', '002'], types = 'ad_storage') => {
      node('#gtm-consent-form').elements.tag_ids.selectedOptions = ids.map(value => ({value}));
      node('#gtm-consent-form').elements.required_types.value = types;
    },
    submit: () => bindings.get('#gtm-consent-form')(),
    save: () => bindings.get('#gtm-consent-save')(),
    edit: () => node('#gtm-consent-form').events.get('input')(),
  };
}
test('English and Arabic website consent review preserves native choices and saves only an unapproved original draft', async t => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(t, locale);
    f.mount();
    const html = f.node('#gtm-consent-draft').innerHTML;
    assert.doesNotMatch(html, /<img>|<tag>| selected[ >]/);
    assert.match(html, /value="003" disabled/);
    assert.match(html, /Original &lt;tag&gt; العربية 001/);
    if (locale === 'ar') assert.doesNotMatch(html, /Draft additional consent requirements|Preview consent additions/);
    f.choose(
      ['001', '002'],
      locale === 'ar' ? 'ad_storage، personalization_storage' : 'ad_storage, personalization_storage',
    );
    await f.submit();
    const preview = f.node('#gtm-consent-preview').innerHTML;
    assert.match(preview, /analytics_storage, ad_storage, personalization_storage/);
    assert.doesNotMatch(preview, /PRIVATE-SYNTHETIC-SCRIPT/);
    assert.equal(f.node('#gtm-consent-preview-title').focused, true);
    assert.deepEqual(f.calls[0].requirements, {
      container_id: '55',
      workspace_id: '66',
      tag_ids: ['001', '002'],
      required_types: ['ad_storage', 'personalization_storage'],
    });
    await f.save();
    const run = f.native.store.documents(f.native.actor.tenantId, 'campaign_run')[0];
    assert.equal(run.state, 'draft');
    assert.match(f.node('#gtm-consent-preview').innerHTML, new RegExp('/campaigns\\?id=' + run.id));
    assert.equal(f.calls[1].action, 'create_consent_plan');
    assert.equal(f.calls[1].confirmed, true);
    assert.equal(f.native.requests.length, 12);
    assert.ok(f.native.requests.every(r => r.method === 'GET'));
    f.context.savedRun = run;
    const journal = f.run('campaignJournal(savedRun)');
    assert.match(journal, /analytics_storage, ad_storage, personalization_storage/);
    assert.match(journal, /Original &lt;tag&gt; العربية 001/);
    assert.match(journal, /Original plan brief|ملخص الخطة الأصلي/);
    if (locale === 'ar') assert.doesNotMatch(journal, /<h2[^>]*><bdi[^>]*>Tag consent draft|Saved consent additions/);
    run.steps[0].arguments.arguments.payload.consentSettings.consentType.list.push({type: 'template', value: 'other'});
    assert.equal(f.run('consentStepDescription(savedRun.steps[0],consentReviewContext(savedRun))'), null);
  }
});
test('consent form refuses malformed scope, unknown tags and invalid literal choices without provider reads', async t => {
  const f = fixture(t);
  f.scope.workspace_id = 'different';
  f.mount();
  assert.equal(f.bindings.size, 0);
  assert.match(f.node('#gtm-consent-draft').innerHTML, /Choose an exact container and workspace/);
  f.scope.workspace_id = '66';
  f.mount();
  for (const [ids, types] of [
    [[], 'ad_storage'],
    [['003'], 'ad_storage'],
    [['001'], '{{variable}}'],
    [['001'], 'ad_storage, ad_storage'],
    [['001'], ''],
  ]) {
    f.choose(ids, types);
    await assert.rejects(f.submit());
  }
  assert.equal(f.calls.length, 0);
});
test('consent preview and save responses/errors stop after form changes, scope edits, navigation, identity or detachment', async t => {
  for (const action of ['preview', 'save'])
    for (const mode of ['resolve', 'reject'])
      for (const change of ['form', 'scope', 'navigation', 'identity', 'detached']) {
        const f = fixture(t);
        f.mount();
        f.choose();
        if (action === 'save') await f.submit();
        let release;
        const deferred = new Promise((resolve, reject) => {
          release = mode === 'resolve' ? resolve : reject;
        });
        f.provider(() => deferred);
        const pending = action === 'save' ? f.save() : f.submit();
        if (change === 'form') f.edit();
        if (change === 'scope') f.context.selectedScopeCurrent = false;
        if (change === 'navigation') f.context.navigationGeneration++;
        if (change === 'identity') f.context.identityGeneration++;
        if (change === 'detached') f.node('#gtm-consent-draft').isConnected = false;
        const before = f.node('#gtm-consent-preview').innerHTML;
        release(mode === 'resolve' ? {record_kind: 'obsolete'} : Error('Obsolete failure'));
        await pending;
        assert.equal(f.node('#gtm-consent-preview').innerHTML, before, action + '/' + mode + '/' + change);
      }
});
test('a superseded consent preview cannot replace a current one; mismatched native scope cannot become saveable', async t => {
  const f = fixture(t);
  f.mount();
  f.choose();
  let release;
  const deferred = new Promise(resolve => {
    release = resolve;
  });
  f.provider(() => deferred);
  const old = f.submit();
  f.provider(async (_tool, args) => {
    const out = await f.native.service.call('amcp_workspace', args, f.native.actor);
    return out.data;
  });
  await f.submit();
  const current = f.node('#gtm-consent-preview').innerHTML;
  release({record_kind: 'old'});
  await old;
  assert.equal(f.node('#gtm-consent-preview').innerHTML, current);
  f.provider(async (_tool, args) => {
    const out = await f.native.service.call('amcp_workspace', args, f.native.actor);
    out.data.scope.account_id = '99';
    return out.data;
  });
  await assert.rejects(f.submit(), /does not match/);
  assert.equal(f.node('#gtm-consent-preview').innerHTML, '');
});
