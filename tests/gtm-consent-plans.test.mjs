import test from 'node:test';
import assert from 'node:assert/strict';
import {gtmConsentFixture as fixture, gateway, path, needed} from './fixtures/gtm-consent-data.mjs';

const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('consent preview adds only explicit literal types, preserves original source and returns bounded metadata', async t => {
  const f = fixture(t),
    original = JSON.stringify([...f.tags.values()]),
    p = ok(await f.call());
  assert.equal(p.record_kind, 'gtm_consent_preview');
  assert.equal(p.provider_mutations, 0);
  assert.equal(p.publishing, false);
  assert.equal(p.targets.length, 2);
  assert.deepEqual(
    p.targets.map(t => t.tag_id),
    ['001', '002'],
  );
  assert.deepEqual(p.targets[1].proposed_required_types, ['analytics_storage', 'ad_storage']);
  assert.equal(p.targets[0].before_setting, 'notSet');
  assert.equal(p.targets[1].before_setting, 'needed');
  assert.equal(p.targets[0].name, 'Original <tag> العربية 001');
  assert.match(p.preview_hash, /^[a-f0-9]{64}$/);
  assert.equal(p.source_references.length, 6);
  assert.equal(p.network_requests, 6);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-SYNTHETIC-SCRIPT|accessToken|authorization_signature|payload/);
  assert.equal(JSON.stringify([...f.tags.values()]), original);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('confirmed consent draft repeats current reads, retains complete tag bodies, exact native fingerprints and original IDs, and replays locally', async t => {
  const f = fixture(t),
    p = ok(await f.call()),
    created = ok(await f.create(p)),
    run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  assert.equal(run.state, 'draft');
  assert.equal(run.steps.length, 2);
  assert.equal(run.gtm_consent.workflow, 'gtm-consent-add-v1');
  assert.equal(created.approval_required, true);
  assert.equal(created.provider_mutations, 0);
  for (const [i, step] of run.steps.entries()) {
    const old = f.tags.get('00' + (i + 1)),
      args = step.arguments.arguments;
    assert.equal(step.arguments.operation, 'gtm_ops');
    assert.equal(args.action, 'UPDATE_TAG');
    assert.equal(args.path, old.path);
    assert.equal(args.fingerprint, old.fingerprint);
    assert.deepEqual(args.payload.parameter, old.parameter);
    assert.deepEqual(args.payload.firingTriggerId, old.firingTriggerId);
    assert.equal(args.payload.paused, true);
    assert.equal(args.payload.notes, old.notes);
    assert.equal(args.payload.fingerprint, undefined);
    assert.deepEqual(
      args.payload.consentSettings,
      needed(...(i ? ['analytics_storage', 'ad_storage'] : ['ad_storage'])),
    );
    assert.equal(run.gtm_consent.targets[i].payload, undefined);
  }
  const reads = f.requests.length;
  assert.equal(ok(await f.create(p)).id, created.id);
  assert.equal(f.requests.length, reads);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
});

test('unchanged tags are shown without draft steps and an entirely unchanged selection creates no preview', async t => {
  const f = fixture(t);
  f.tags.get('001').consentSettings = needed('ad_storage');
  const p = ok(await f.call());
  assert.deepEqual(
    p.targets.map(t => t.state),
    ['unchanged', 'change'],
  );
  const created = ok(await f.create(p));
  assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', created.id).steps.length, 1);
  f.tags.get('002').consentSettings = needed('analytics_storage', 'ad_storage');
  assert.equal((await f.call()).success, false);
});

test('consent drafts require exact confirmation, preview hash, identity/session and current read scope', async t => {
  const f = fixture(t),
    p = ok(await f.call());
  for (const [changes, actor] of [
    [{confirmed: false}, f.actor],
    [{preview_hash: 'a'.repeat(64)}, f.actor],
    [{}, f.store.authenticate(f.store.createKey({...f.actor, userId: 'other'}))],
    [{}, f.store.authenticate(f.store.createKey(f.actor))],
  ])
    assert.equal((await f.create(p, changes, actor)).success, false);
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {...f.connection, accounts: ['99'], writeAccounts: []},
    {accessToken: 'synthetic'},
  );
  assert.equal((await f.create(p)).success, false);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('changed tag parameters or workspace evidence after preview refuse draft creation before provider mutation', async t => {
  for (const change of ['tag', 'workspace']) {
    const f = fixture(t),
      p = ok(await f.call());
    if (change === 'tag') f.tags.get('001').parameter[0].value = 'Changed original';
    else f.workspace.fingerprint = 'workspace-changed';
    assert.equal((await f.create(p)).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    assert.ok(f.requests.every(r => r.method === 'GET'));
  }
});

test('consent reads refuse mid-collection credential revocation or original-tag changes without a retained preview', async t => {
  for (const change of ['revoke', 'tag']) {
    const f = fixture(t);
    f.hook((_path, n) => {
      if (n === 4) {
        if (change === 'revoke') f.store.revokeKey(f.key);
        else f.tags.get('001').fingerprint = 'changed';
      }
    });
    assert.equal((await f.call()).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'gtm_consent_preview').length, 0);
    assert.ok(f.requests.every(r => r.method === 'GET'));
  }
});

test('consent plan input refuses unknown/dynamic policies, duplicate or oversized choices and foreign tag identity', async t => {
  const f = fixture(t);
  for (const requirements of [
    {...f.requirements, required_types: []},
    {...f.requirements, required_types: ['{{variable}}']},
    {...f.requirements, required_types: ['ad_storage', 'ad_storage']},
    {...f.requirements, tag_ids: ['001', '001']},
    {...f.requirements, tag_ids: Array.from({length: 11}, (_, i) => String(i))},
    {...f.requirements, tag_ids: ['../001']},
    {...f.requirements, unknown: true},
  ])
    assert.equal((await f.call({requirements})).success, false);
  assert.equal(f.requests.length, 0);
  for (const bad of [
    null,
    {consentStatus: 'FUTURE'},
    {consentStatus: 'needed', consentType: {type: 'list', list: [{type: 'template', value: '{{variable}}'}]}},
  ]) {
    f.tags.get('001').consentSettings = bad;
    assert.equal((await f.call()).success, false);
  }
  delete f.tags.get('001').consentSettings;
  f.tags.get('001').accountId = '99';
  assert.equal((await f.call()).success, false);
});

test('native tag fingerprints, complete response and body size remain mandatory', async t => {
  for (const change of ['fingerprint', 'partial', 'large']) {
    const f = fixture(t);
    if (change === 'fingerprint') delete f.tags.get('001').fingerprint;
    else if (change === 'partial') f.tags.get('001').nextPageToken = 'partial';
    else f.tags.get('001').parameter[0].value = 'x'.repeat(65537);
    assert.equal((await f.call()).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'gtm_consent_preview').length, 0);
  }
});

test('a current consent draft prepares the existing frozen native tag contract; changed original tags stop unsent preparation', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t),
      p = ok(await f.call()),
      created = ok(await f.create(p));
    if (changed) f.tags.get('001').fingerprint = 'changed-after-draft';
    const out = await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor);
    if (changed) assert.equal(out.success, false);
    else {
      const data = ok(out),
        run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
      assert.ok(run.steps[0].review_id);
      const review = f.store.document(f.actor.tenantId, 'write_review', run.steps[0].review_id);
      assert.equal(review.plan.method, 'PUT');
      assert.equal(review.plan.path, '/tagmanager/v2/' + path + '/tags/001');
      assert.equal(review.plan.query.fingerprint, 'tag-original-001');
      assert.deepEqual(review.plan.body.consentSettings, needed('ad_storage'));
      assert.equal(data.provider_mutations ?? 0, 0);
    }
    assert.ok(f.requests.every(r => r.method === 'GET'));
  }
});

test('tampered guided tag arguments are refused before unsent native preparation', async t => {
  const f = fixture(t),
    p = ok(await f.call()),
    created = ok(await f.create(p)),
    run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  run.steps[0].arguments.arguments.payload.paused = false;
  f.store.putDocument(f.actor.tenantId, 'campaign_run', run.id, run);
  assert.equal(
    (await f.service.call('amcp_campaign', {action: 'prepare_next', id: created.id}, f.actor)).success,
    false,
  );
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('readers cannot retain consent previews and expired uncreated previews refuse without draft creation', async t => {
  const reader = fixture(t, 'reader');
  assert.equal((await reader.call()).success, false);
  assert.equal(reader.requests.length, 0);
  const f = fixture(t),
    p = ok(await f.call()),
    now = Date.now;
  try {
    Date.now = () => now() + 600001;
    assert.equal((await f.create(p)).success, false);
  } finally {
    Date.now = now;
  }
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('consent drafts preserve original literal parameter keys and refuse unknown or malformed native fields', async t => {
  const f = fixture(t);
  f.tags.get('002').consentSettings.consentType.key = 'original-list-key';
  f.tags.get('002').consentSettings.consentType.list[0].key = 'original-item-key';
  f.tags.get('002').tagManagerUrl = 'https://tagmanager.google.com/';
  const p = ok(await f.call()),
    created = ok(await f.create(p));
  const body = f.store.document(f.actor.tenantId, 'campaign_run', created.id).steps[1].arguments.arguments.payload;
  assert.equal(body.consentSettings.consentType.key, 'original-list-key');
  assert.equal(body.consentSettings.consentType.list[0].key, 'original-item-key');
  for (const key of ['path', 'accountId', 'containerId', 'workspaceId', 'tagId', 'tagManagerUrl', 'fingerprint'])
    assert.equal(Object.hasOwn(body, key), false);
  for (const change of ['future', 'malformed', 'inactive']) {
    const x = fixture(t);
    if (change === 'future') x.tags.get('001').futureNativeField = true;
    if (change === 'malformed') x.tags.get('001').paused = 'false';
    if (change === 'inactive')
      x.tags.get('001').consentSettings = {...needed('ad_storage'), consentStatus: 'notNeeded'};
    assert.equal((await x.call()).success, false);
    assert.equal(x.store.documents(x.actor.tenantId, 'gtm_consent_preview').length, 0);
  }
});

test('saving changed scope, requirements or rotated login refuses the original consent preview', async t => {
  const f = fixture(t),
    p = ok(await f.call()),
    n = f.requests.length;
  for (const changes of [
    {gateway: 'meta_native_action'},
    {account_id: '99'},
    {connection_id: 'other'},
    {requirements: f.requirements},
  ])
    assert.equal((await f.create(p, changes)).success, false);
  assert.equal(f.requests.length, n);
  f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'rotated-synthetic'});
  assert.equal((await f.create(p)).success, false);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('concurrent saves produce one original consent draft and a retry returns it without provider reads', async t => {
  const f = fixture(t),
    p = ok(await f.call());
  let entered, release;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const paused = new Promise(resolve => {
    release = resolve;
  });
  f.hook(async (_path, n) => {
    if (n === 7) {
      entered();
      await paused;
    }
  });
  const first = f.create(p);
  await started;
  const second = await f.create(p);
  assert.equal(second.success, false);
  assert.equal(second.error.code, 'CONSENT_PLAN_BUSY');
  release();
  const saved = ok(await first),
    n = f.requests.length;
  assert.equal(ok(await f.create(p)).id, saved.id);
  assert.equal(f.requests.length, n);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
});

test('independent consent steps survive their own accepted workspace changes and verify through native receipts', async t => {
  const f = fixture(t, 'operator', true),
    p = ok(await f.call()),
    saved = ok(await f.create(p));
  for (const tagId of ['001', '002']) {
    const prepared = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
    assert.equal(prepared.step_id, 'consent-' + (tagId === '001' ? 1 : 2));
    const execute = prepared.next_call.arguments;
    ok(await f.service.call('amcp_campaign', execute, f.actor));
    // Read-back remains the existing native contract; no separate guided policy can mark the step verified.
    ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  }
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.ok(
    run.steps.every(s => s.status === 'verified'),
    JSON.stringify(run.steps),
  );
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 2);
  assert.equal(
    f.requests.some(r => /versions|publish/.test(r.path)),
    false,
  );
  assert.equal(f.tags.get('001').parameter[0].value, 'PRIVATE-SYNTHETIC-SCRIPT');
  assert.equal(f.tags.get('002').paused, true);
});

test('uncertain original consent execution keeps its native review/key without rereading changed tags', async t => {
  const f = fixture(t),
    p = ok(await f.call()),
    saved = ok(await f.create(p));
  ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id),
    step = run.steps[0];
  step.status = 'executing';
  run.state = 'in_progress';
  f.store.putDocument(f.actor.tenantId, 'campaign_run', saved.id, run);
  f.tags.get('001').fingerprint = 'already-accepted-or-external-change';
  const n = f.requests.length;
  const recovery = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  assert.equal(recovery.next_call.arguments.review_id, step.review_id);
  assert.equal(recovery.next_call.arguments.idempotency_key, step.review_id);
  assert.equal(f.requests.length, n);
});

test('the per-tag literal union and active-preview cap refuse rather than truncate; expired previews are reclaimed', async t => {
  const f = fixture(t);
  f.tags.get('001').consentSettings = needed(...Array.from({length: 20}, (_, i) => 'type' + i));
  assert.equal((await f.call()).success, false);
  delete f.tags.get('001').consentSettings;
  for (let i = 0; i < 100; i++)
    f.store.putDocument(f.actor.tenantId, 'gtm_consent_preview', 'synthetic-' + i, {expires_at: Date.now() + 600000});
  const refused = await f.call();
  assert.equal(refused.error.code, 'CONSENT_PREVIEW_LIMIT');
  f.store.putDocument(f.actor.tenantId, 'gtm_consent_preview', 'synthetic-0', {expires_at: Date.now() - 1});
  ok(await f.call());
  assert.equal(f.store.documents(f.actor.tenantId, 'gtm_consent_preview').length, 100);
});

test('consent source and authority changes after native preparation refuse execution before any synthetic update', async t => {
  for (const changed of ['tag', 'key', 'read-scope']) {
    const f = fixture(t, 'operator', true),
      p = ok(await f.call()),
      saved = ok(await f.create(p)),
      prepared = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
    if (changed === 'tag') f.tags.get('001').parameter[0].value = 'External changed parameter';
    if (changed === 'key') f.store.revokeKey(f.key);
    if (changed === 'read-scope')
      f.store.putConnection({...f.actor, role: 'admin'}, {...f.connection, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.service.call('amcp_campaign', prepared.next_call.arguments, f.actor)).success, false);
    assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
  }
});

test('native consent reads bind credential rotation and failed exact-resource reads without partial previews', async t => {
  for (const changed of ['credentials', 'failed-read']) {
    const f = fixture(t);
    f.hook((_path, n) => {
      if (changed === 'failed-read' && n >= 3) throw Error('Synthetic unavailable resource');
      if (n !== 3) return;
      if (changed === 'credentials')
        f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'changed-synthetic'});
    });
    assert.equal((await f.call()).success, false, changed);
    assert.equal(f.store.documents(f.actor.tenantId, 'gtm_consent_preview').length, 0);
  }
});

test('a successful retry counts every native attempt while retaining only complete source observations', async t => {
  const f = fixture(t);
  f.hook((_path, n) => {
    if (n === 3) throw Error('Synthetic transient read failure');
  });
  const p = ok(await f.call());
  assert.equal(p.source_references.length, 6);
  assert.equal(p.network_requests, 7);
  assert.equal(f.requests.length, 7);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('direct campaign creation cannot detach the exact guided consent binding or reuse another session preview', async t => {
  const f = fixture(t),
    first = ok(await f.call()),
    saved = ok(await f.create(first)),
    original = f.store.document(f.actor.tenantId, 'campaign_run', saved.id),
    p = ok(await f.call());
  const steps = original.steps.map(s =>
      Object.fromEntries(
        ['id', 'kind', 'gateway', 'account_id', 'connection_id', 'depends_on', 'description', 'arguments'].map(k => [
          k,
          s[k],
        ]),
      ),
    ),
    input = {
      action: 'create',
      name: original.name,
      brief: original.brief,
      idempotency_key: 'gtm-consent-' + p.preview_id,
      consent_preview_id: p.preview_id,
      consent_preview_hash: p.preview_hash,
      confirmed: true,
      steps,
    };
  for (const change of ['arguments', 'brief', 'key', 'session']) {
    const x = structuredClone(input);
    if (change === 'arguments') x.steps[0].arguments.arguments.payload.paused = false;
    if (change === 'brief') x.brief = 'Different proposal';
    if (change === 'key') x.idempotency_key = 'another-key';
    const actor = change === 'session' ? f.store.authenticate(f.store.createKey(f.actor)) : f.actor;
    assert.equal((await f.service.call('amcp_campaign', x, actor)).success, false);
  }
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});
