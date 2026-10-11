// MSR-01: GTM audit correctness. Synthetic in-memory store and a GET-only stub; no provider egress.
// Guards: one grouped finding per unresolved trigger ID (not one per referencing tag), `complete` keeping its meaning
// when only the finding list is truncated, and published-version consent evidence from the live version already read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {gtmConsentDiff, gtmConsentEvidence} from '../dist/src/gtm-consent-evidence.js';

const actor = {tenantId: 'msr-01-gtm', userId: 'owner', role: 'admin'},
  gateway = 'gtm_native_action',
  a = 'accounts/44',
  c = a + '/containers/55',
  w = c + '/workspaces/66',
  prefix = '/tagmanager/v2/';
const row = (path, fields = {}) => ({
  path,
  accountId: '44',
  ...(path.includes('/containers/') ? {containerId: path.split('/')[3]} : {}),
  ...(path.includes('/workspaces/') ? {workspaceId: path.split('/')[5]} : {}),
  ...fields,
});
const needed = (...types) => ({
  consentStatus: 'needed',
  consentType: {type: 'list', list: types.map(value => ({type: 'template', value}))},
});
const tag = (id, extra = {}) =>
  row(w + '/tags/' + id, {tagId: id, name: 'Tag ' + id, type: 'html', firingTriggerId: ['3'], parameter: [], ...extra});

function fixture(t, {tags, liveTags = tags, live = true}) {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64')),
    connection = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      gateway,
      accounts: ['44'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic GTM login',
      scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    },
    calls = [];
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  t.after(() => store.close());
  const trigger = row(w + '/triggers/3', {triggerId: '3', name: 'Custom', type: 'pageview'});
  const resources = new Map([
    [a, row(a, {name: 'Account'})],
    [c, row(c, {name: 'Container'})],
    [w, row(w, {name: 'Workspace', fingerprint: 'workspace-1'})],
    [w + '/status', {workspaceChange: [], mergeConflict: []}],
    [c + '/version_headers:latest', row(c + '/versions/9', {containerVersionId: '9'})],
    [c + '/versions/9', row(c + '/versions/9', {containerVersionId: '9', tag: tags, trigger: [trigger]})],
    ...(live
      ? [[c + '/versions:live', row(c + '/versions/8', {containerVersionId: '8', tag: liveTags, trigger: [trigger]})]]
      : []),
  ]);
  const lists = new Map([
    [c + '/version_headers', ['containerVersionHeader', [row(c + '/versions/9', {containerVersionId: '9'})]]],
    [w + '/tags', ['tag', tags]],
    [w + '/triggers', ['trigger', [trigger]]],
    [w + '/variables', ['variable', []]],
    [w + '/folders', ['folder', []]],
    [w + '/templates', ['template', []]],
    [w + '/clients', ['client', []]],
    [w + '/transformations', ['transformation', []]],
    [w + '/zones', ['zone', []]],
    [w + '/gtag_config', ['gtagConfig', []]],
    [w + '/built_in_variables', ['builtInVariable', []]],
  ]);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, 'tagmanager.googleapis.com');
        assert.equal(init.method, 'GET', 'the audit attempted a mutation');
        const path = url.pathname.slice(prefix.length);
        calls.push(path);
        const list = lists.get(path);
        if (list) return Response.json(list[1].length ? {[list[0]]: structuredClone(list[1])} : {});
        const found = resources.get(path);
        return found ? Response.json(structuredClone(found)) : Response.json({error: {code: 404}}, {status: 404});
      },
      async () => {},
      30000,
      16 * 1024 * 1024,
      10000,
      1,
    ),
    undefined,
    {allowWrites: false, requireBeforeState: true, maxBudgetChange: 0},
  );
  return {
    calls,
    audit: async () => {
      const out = await service.call(
        gateway,
        {
          operation: 'gtm_audit_ops',
          arguments: {connection_id: connection.id, account_id: '44', container_id: '55', workspace_id: '66'},
        },
        actor,
      );
      assert.equal(out.success, true, JSON.stringify(out.error));
      return out.data;
    },
  };
}
const codes = out => out.findings.map(f => f.code);

test('MSR-01 tags sharing one unlisted trigger produce one grouped unknown finding with counts and sample paths', async t => {
  const f = fixture(t, {tags: ['1', '2', '3'].map(id => tag(id, {firingTriggerId: ['2147479553']}))}),
    out = await f.audit(),
    grouped = out.findings.filter(x => x.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER');
  // Before MSR-01 this was three findings, one per referencing tag.
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].severity, 'unknown');
  assert.equal(grouped[0].grouping, 'trigger_id');
  assert.equal(grouped[0].trigger_id, '2147479553');
  assert.equal(grouped[0].entity_count, 3);
  assert.equal(grouped[0].tag_count, 3);
  assert.deepEqual(grouped[0].sample_paths, [w + '/tags/1', w + '/tags/2', w + '/tags/3']);
  assert.equal(grouped[0].sample_paths_truncated, false);
  assert.equal(grouped[0].path, w + '/tags/1');
  assert.deepEqual(grouped[0].message_localization, {key: 'unresolved_trigger', trigger_id: '2147479553'});
  assert.equal(out.complete, true);
  assert.equal(out.finding_list, 'complete');
  assert.equal(out.provider_mutations, 0);
});

test('MSR-01 a thousand tags on a system trigger plus a duplicate name stay complete and keep the real finding', async t => {
  const tags = Array.from({length: 1000}, (_, i) =>
      tag(String(i + 1), {firingTriggerId: ['2147479553'], name: i < 2 ? 'Same name' : 'Tag ' + (i + 1)}),
    ),
    f = fixture(t, {tags}),
    out = await f.audit();
  // Before MSR-01: finding_count 1001, findings_truncated true, complete false and the duplicate name dropped.
  assert.equal(out.finding_count, 2);
  assert.equal(out.complete, true);
  assert.equal(out.findings_truncated, false);
  assert.equal(out.finding_list, 'complete');
  assert.equal(out.configuration_findings, 'attention');
  assert.deepEqual(codes(out).sort(), ['DUPLICATE_NAME', 'UNRESOLVED_OR_SYSTEM_TRIGGER']);
  const grouped = out.findings.find(x => x.code === 'UNRESOLVED_OR_SYSTEM_TRIGGER');
  assert.equal(grouped.entity_count, 1000);
  assert.equal(grouped.sample_paths.length, 20);
  assert.equal(grouped.sample_paths_truncated, true);
});

test('MSR-01 a truncated finding list keeps complete:true when every read succeeded and lists errors first', async t => {
  const tags = Array.from({length: 1000}, (_, i) =>
      tag(String(i + 1), {firingTriggerId: ['2147479553'], name: 'Same name', parentFolderId: '99'}),
    ),
    f = fixture(t, {tags}),
    out = await f.audit();
  // 1000 unresolved folders (error), 999 duplicate names (warning) and one grouped trigger (unknown).
  assert.equal(out.finding_count, 2000);
  assert.equal(out.findings.length, 1000);
  assert.equal(out.findings_truncated, true);
  assert.equal(out.finding_list, 'truncated');
  // Before MSR-01 truncation set complete:false and configuration_findings:'incomplete'.
  assert.equal(out.complete, true);
  assert.equal(out.configuration_findings, 'attention');
  assert.ok(out.findings.every(x => x.severity === 'error'));
});

test('MSR-01 published-version consent and a draft/live diff come from the live version already read', async t => {
  const draft = [
      tag('1', {consentSettings: needed('ad_storage', 'analytics_storage')}),
      tag('2', {consentSettings: needed('ad_storage')}),
      tag('3'),
      tag('4', {consentSettings: {consentStatus: 'FUTURE'}}),
    ],
    live = [
      tag('1', {consentSettings: needed('analytics_storage', 'ad_storage')}),
      tag('2', {consentSettings: {consentStatus: 'notNeeded'}}),
      tag('4', {consentSettings: needed('ad_storage')}),
      tag('5', {consentSettings: needed('ad_user_data')}),
    ],
    same = fixture(t, {tags: draft, liveTags: draft}),
    differs = fixture(t, {tags: draft, liveTags: live}),
    baseline = await same.audit(),
    out = await differs.audit();
  assert.equal(out.network_requests, baseline.network_requests, 'the comparison adds no request');
  assert.deepEqual(differs.calls, same.calls);
  assert.ok(!differs.calls.some(path => path.includes('/tags/')));
  assert.equal(out.consent_evidence.scope, 'workspace_configuration');
  assert.equal(out.live_consent_evidence.scope, 'published_version_configuration');
  assert.equal(out.live_consent_evidence.version_id, '8');
  assert.equal(out.live_consent_evidence.version_path, c + '/versions/8');
  assert.deepEqual(out.live_consent_evidence.counts, {notSet: 0, notNeeded: 1, needed: 3, unknown: 0});
  const states = Object.fromEntries(out.consent_diff.rows.map(r => [r.tag_id, r.state]));
  assert.deepEqual(states, {1: 'same', 2: 'differs', 3: 'draft_only', 4: 'unknown', 5: 'live_only'});
  assert.deepEqual(out.consent_diff.counts, {same: 1, differs: 1, draft_only: 1, live_only: 1, unknown: 1});
  assert.equal(out.consent_diff.live_version_id, '8');
  assert.equal(out.consent_diff.network_requests, 0);
  assert.deepEqual(out.consent_diff.rows[1].live, {setting: 'notNeeded', required_types: []});
  assert.ok(baseline.consent_diff.rows.every(r => r.state === 'same' || r.state === 'unknown'));
  assert.equal(out.provider_mutations, 0);
});

test('MSR-01 live consent stays unavailable when bounded out and is refused for foreign tag identities', async t => {
  const tags = [tag('1')];
  const oversized = fixture(t, {
      tags,
      liveTags: Array.from({length: 1001}, (_, i) => tag(String(i + 1))),
    }),
    out = await oversized.audit();
  assert.equal(out.complete, true);
  assert.equal(out.live_consent_evidence.status, 'unavailable');
  assert.equal(out.consent_diff, undefined);
  const unpublished = await fixture(t, {tags, live: false}).audit();
  assert.equal(unpublished.live_consent_evidence, undefined);
  assert.ok(unpublished.findings.some(x => x.code === 'NO_LIVE_VERSION'));
  const foreign = fixture(t, {tags, liveTags: [tag('1', {path: 'accounts/99/containers/55/workspaces/66/tags/1'})]});
  await assert.rejects(foreign.audit(), /foreign|identity|STATE_TARGET_MISMATCH/i);
});

test('MSR-01 version consent evidence accepts version, workspace or absent tag paths but never another container', () => {
  const version = {path: c + '/versions/8', containerVersionId: '8', fingerprint: 'v8'};
  const evidence = gtmConsentEvidence(
    version,
    [
      {tagId: '1', accountId: '44', containerId: '55', consentSettings: needed('ad_storage')},
      {tagId: '2', path: c + '/versions/8/tags/2'},
      {tagId: '3', path: w + '/tags/3'},
    ],
    'version',
  );
  assert.equal(evidence.version_fingerprint, 'v8');
  assert.deepEqual(
    evidence.rows.map(r => r.path),
    [null, c + '/versions/8/tags/2', w + '/tags/3'],
  );
  for (const bad of [
    [{tagId: '1', containerId: '56'}],
    [{tagId: '1', accountId: '45'}],
    [{tagId: '1', path: c + '/versions/8/tags/2'}],
    [{tagId: '1', path: 'accounts/44/containers/56/versions/8/tags/1'}],
    [{tagId: '1'}, {tagId: '1'}],
  ])
    assert.throws(() => gtmConsentEvidence(version, bad, 'version'), /identity/);
  assert.throws(() => gtmConsentEvidence({...version, containerVersionId: '9'}, [], 'version'), /bound/);
  assert.throws(() => gtmConsentEvidence({path: w, containerVersionId: '8'}, [], 'version'), /bound/);
  const diff = gtmConsentDiff(
    gtmConsentEvidence({path: w}, [tag('1', {consentSettings: needed('ad_storage')})]),
    evidence,
  );
  assert.deepEqual(
    diff.rows.map(r => r.state),
    ['same', 'live_only', 'live_only'],
  );
});
