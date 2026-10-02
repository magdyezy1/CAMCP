import test from 'node:test';
import assert from 'node:assert/strict';
const workspace = {path: 'accounts/44/containers/55/workspaces/66', fingerprint: 'workspace-version'};
const tag = (id, consentSettings, extra = {}) => ({
  path: workspace.path + '/tags/' + id,
  tagId: id,
  name: 'Home <img> العربية',
  type: 'html',
  ...(consentSettings === undefined ? {} : {consentSettings}),
  ...extra,
});
const needed = (...values) => ({
  consentStatus: 'needed',
  consentType: {type: 'list', list: values.map(value => ({type: 'template', value}))},
});

test('GTM consent evidence distinguishes default, explicit none and required literal types without certifying runtime consent', async () => {
  const {gtmConsentEvidence} = await import('../dist/src/gtm-consent-evidence.js');
  const tags = [
    tag('001'),
    tag('2', {consentStatus: 'notSet'}),
    tag('3', {consentStatus: 'notNeeded'}),
    tag('4', needed('ad_storage', 'custom_category'), {paused: true}),
  ];
  const original = JSON.stringify(tags),
    result = gtmConsentEvidence(workspace, tags);
  assert.equal(result.scope, 'workspace_configuration');
  assert.equal(result.workspace_path, workspace.path);
  assert.equal(result.workspace_fingerprint, 'workspace-version');
  assert.equal(result.tag_count, 4);
  assert.deepEqual(result.counts, {notSet: 2, notNeeded: 1, needed: 1, unknown: 0});
  assert.deepEqual(
    result.rows.map(r => r.setting),
    ['notSet', 'notSet', 'notNeeded', 'needed'],
  );
  assert.equal(result.rows[0].tag_id, '001');
  assert.equal(result.rows[0].setting_source, 'default_when_omitted');
  assert.equal(result.rows[0].paused, null);
  assert.equal(result.rows[3].paused, true);
  assert.deepEqual(result.rows[3].required_types, ['ad_storage', 'custom_category']);
  assert.deepEqual(result.rows[2].required_types, []);
  assert.ok(Object.values(result.checks).every(value => value === 'unverified'));
  assert.match(result.configuration_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(tags), original);
  tags[3].consentSettings = needed('analytics_storage');
  assert.notEqual(gtmConsentEvidence(workspace, tags).configuration_hash, result.configuration_hash);
});

test('GTM consent evidence keeps malformed, dynamic, empty and future settings unknown without echoing their raw payloads', async () => {
  const {gtmConsentEvidence} = await import('../dist/src/gtm-consent-evidence.js');
  const values = [
    null,
    [],
    'PRIVATE',
    {consentStatus: 'FUTURE_PRIVATE'},
    needed(),
    needed('{{PRIVATE variable}}'),
    needed('ad_storage', 'ad_storage'),
    {consentStatus: 'needed', consentType: {type: 'map', map: []}},
    needed('x'.repeat(101)),
    needed(...Array.from({length: 21}, (_, i) => 'custom_' + i)),
    {consentStatus: 'needed', consentType: {type: 'list', list: [{type: 'integer', value: '1'}]}},
    {consentStatus: 'needed', consentType: {type: 'list', list: [{type: 'template', value: 'ad_storage', map: []}]}},
  ];
  const result = gtmConsentEvidence(
    workspace,
    values.map((v, i) => tag(String(i + 1), v, {parameter: [{value: 'PRIVATE HTML'}], notes: 'PRIVATE notes'})),
  );
  assert.equal(result.counts.unknown, values.length);
  assert.ok(result.rows.every(row => row.setting === 'unknown' && row.required_types === null && row.reason));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('GTM consent projection is bounded and refuses foreign, duplicate or ambiguous tag identities', async () => {
  const {gtmConsentEvidence} = await import('../dist/src/gtm-consent-evidence.js');
  assert.equal(gtmConsentEvidence(workspace, []).tag_count, 0);
  assert.equal(
    gtmConsentEvidence(
      workspace,
      Array.from({length: 1000}, (_, i) => tag(String(i + 1))),
    ).rows.length,
    1000,
  );
  for (const tags of [
    Array.from({length: 1001}, (_, i) => tag(String(i + 1))),
    [tag('1'), tag('1')],
    [tag('1', undefined, {path: 'accounts/99/containers/55/workspaces/66/tags/1'})],
    [tag('1', undefined, {tagId: 1})],
    [tag('1', undefined, {tagId: '2'})],
  ]) {
    assert.throws(() => gtmConsentEvidence(workspace, tags), /bound|scope|identity|duplicate|limit/i);
  }
});
