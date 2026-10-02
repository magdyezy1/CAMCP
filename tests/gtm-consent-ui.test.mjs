import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
function fixture(locale = 'en') {
  const nodes = new Map(),
    node = key => {
      if (!nodes.has(key))
        nodes.set(key, {
          innerHTML: '',
          textContent: '',
          value: '',
          disabled: false,
          isConnected: true,
          events: new Map(),
          addEventListener(k, f) {
            this.events.set(k, f);
          },
          setAttribute() {},
          focus() {},
        });
      return nodes.get(key);
    };
  const evidence = {
    scope: 'workspace_configuration',
    workspace_path: 'accounts/1/containers/2/workspaces/3',
    configuration_hash: 'a'.repeat(64),
    tag_count: 51,
    rows: Array.from({length: 51}, (_, i) => ({
      path: 'accounts/1/containers/2/workspaces/3/tags/' + i,
      tag_id: '000' + i,
      name: i === 50 ? 'Arabic العربية <img>' : 'Home ' + i,
      type: 'html',
      paused: null,
      setting: i === 50 ? 'needed' : 'notSet',
      required_types: i === 50 ? ['analytics_storage'] : [],
      reason: null,
    })),
    counts: {notSet: 50, notNeeded: 0, needed: 1, unknown: 0},
    checks: {built_in_consent: 'unverified'},
  };
  const context = createContext({
    Intl,
    document: {addEventListener() {}},
    $: node,
    navigationGeneration: 1,
    identityGeneration: 1,
    currentSelection: true,
    evidence,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  run(readFileSync('web/account-workflows.js', 'utf8'));
  return {
    node,
    context,
    run,
    mount: () => run('mountGtmConsentEvidence(evidence,()=>currentSelection)'),
    event: (id, kind = 'click') => node(id).events.get(kind)(),
  };
}

test('GTM consent table pages all tags, filters settings and searches exact native names/types without extra reads', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.mount();
    assert.match(f.node('#gtm-consent-rows').innerHTML, /Home 49/);
    assert.doesNotMatch(f.node('#gtm-consent-rows').innerHTML, /00050/);
    f.event('#gtm-consent-next');
    const html = f.node('#gtm-consent-rows').innerHTML;
    assert.match(html, /00050/);
    assert.match(html, /العربية &lt;img&gt;/);
    assert.doesNotMatch(html, /<img>/);
    assert.match(html, /analytics_storage/);
    assert.equal(f.node('#gtm-consent-next').disabled, true);
    f.node('#gtm-consent-filter').value = 'notSet';
    f.event('#gtm-consent-filter', 'change');
    assert.match(f.node('#gtm-consent-rows').innerHTML, /Home 49/);
    assert.doesNotMatch(f.node('#gtm-consent-rows').innerHTML, /00050/);
    f.node('#gtm-consent-filter').value = 'all';
    f.event('#gtm-consent-filter', 'change');
    f.node('#gtm-consent-search').value = 'analytics_storage';
    f.event('#gtm-consent-search', 'input');
    assert.match(f.node('#gtm-consent-rows').innerHTML, /00050/);
    assert.doesNotMatch(f.node('#gtm-consent-rows').innerHTML, /Home 0/);
    const root = f.node('#gtm-consent-evidence').innerHTML;
    if (locale === 'ar') {
      assert.match(root, /[\u0600-\u06ff]/);
      assert.doesNotMatch(root, /Workspace consent settings|Additional consent/);
    } else
      assert.match(
        root,
        /Built-in checks, default and updated consent states, runtime timing and event delivery remain unverified/,
      );
  }
});

test('GTM consent controls stop repainting after an edited audit, navigation, identity change or detached root', () => {
  for (const change of ['selection', 'navigation', 'identity', 'detached']) {
    const f = fixture();
    f.mount();
    if (change === 'selection') f.context.currentSelection = false;
    if (change === 'navigation') f.context.navigationGeneration++;
    if (change === 'identity') f.context.identityGeneration++;
    if (change === 'detached') f.node('#gtm-consent-evidence').isConnected = false;
    f.node('#gtm-consent-rows').innerHTML = 'Current audit';
    f.event('#gtm-consent-next');
    f.node('#gtm-consent-filter').value = 'needed';
    f.event('#gtm-consent-filter', 'change');
    f.node('#gtm-consent-search').value = 'other';
    f.event('#gtm-consent-search', 'input');
    assert.equal(f.node('#gtm-consent-rows').innerHTML, 'Current audit');
  }
});

test('GTM consent distinguishes unknown requirements from an empty inventory and does not render unbounded payloads', () => {
  const f = fixture();
  f.context.evidence.rows = [
    {
      path: 'native',
      tag_id: '001',
      name: 'Tag',
      type: 'html',
      paused: false,
      setting: 'unknown',
      required_types: null,
      reason: 'unresolved_types',
    },
  ];
  f.context.evidence.tag_count = 1;
  f.context.evidence.counts = {notSet: 0, notNeeded: 0, needed: 0, unknown: 1};
  f.mount();
  assert.match(f.node('#gtm-consent-rows').innerHTML, /Unknown/);
  assert.match(f.node('#gtm-consent-rows').innerHTML, /could not be interpreted/);
  f.context.evidence.rows = [];
  f.context.evidence.tag_count = 0;
  f.mount();
  assert.match(f.node('#gtm-consent-rows').innerHTML, /No tags in this workspace inventory/);
  f.context.evidence.rows = Array(1001).fill({tag_id: '1'});
  f.context.evidence.tag_count = 1001;
  f.mount();
  assert.match(f.node('#gtm-consent-evidence').innerHTML, /could not be displayed/);
});
