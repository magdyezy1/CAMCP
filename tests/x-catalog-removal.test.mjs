import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogRemovalFixture as fixture} from './fixtures/x-catalog-removal.mjs';

const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1300));
  return r.data;
};
const refused = (r, code) => {
  assert.equal(r.success, false);
  if (code) assert.equal(r.error.code, code);
};

test('explicit X removal preview binds only selected current individual products without provider changes', async t => {
  const f = fixture(t),
    p = ok(await f.preview());
  assert.equal(p.record_kind, 'x_catalog_removal_preview');
  assert.deepEqual(
    p.targets.map(t => [t.retailer_id, t.product_id]),
    [
      ['sku-1', '5000001'],
      ['sku-2', '5000002'],
    ],
  );
  assert.equal(p.scope.catalog_id, '9001');
  assert.equal(p.scope.connection_id, 'x');
  assert.equal(p.network_requests, 8);
  assert.equal(p.provider_mutations, 0);
  assert.equal(p.destructive_deletions, 0);
  assert.equal(p.targets[0].before.name, 'Product 1');
  assert.match(p.preview_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(p), /sku-3|sku-4|authorization_signature|save_token|synthetic-token/);
  assert.ok(f.calls.every(r => r.method === 'GET'));
  assert.equal(f.writes(), 0);
});

test('explicit X removal draft repeats selected evidence, retains exact per-key native steps and replays the original plan', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    saved = ok(await f.save(p));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.equal(run.state, 'draft');
  assert.equal(run.steps.length, 2);
  assert.equal(run.catalog_removal.preview_id, p.preview_id);
  assert.equal(run.catalog_removal.workflow, 'x-catalog-selected-removal-v1');
  assert.equal(saved.approval_required, true);
  assert.equal(saved.provider_mutations, 0);
  assert.equal(f.calls.length, 16);
  for (const [i, step] of run.steps.entries()) {
    assert.equal(step.gateway, 'x_ads_native_action');
    assert.equal(step.account_id, 'acct1');
    assert.equal(step.connection_id, 'x');
    assert.equal(step.arguments.action, 'x_product_catalogs_product_catalog_id_products_delete');
    assert.deepEqual(step.arguments.params, {product_catalog_id: '9001'});
    assert.deepEqual(step.arguments.payload, {product_keys: ['500000' + (i + 1)]});
    assert.deepEqual(step.depends_on, []);
  }
  const reads = f.calls.length;
  assert.equal(ok(await f.save(p)).id, run.id);
  assert.equal(f.calls.length, reads);
  const retained = f.store.document(f.actor.tenantId, 'x_catalog_removal_preview', p.preview_id);
  delete retained.plan_id;
  f.store.putDocument(f.actor.tenantId, 'x_catalog_removal_preview', p.preview_id, retained);
  assert.equal(ok(await f.save(p)).id, run.id, 'recover a saved plan after losing only its preview association');
  assert.equal(f.calls.length, reads);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.writes(), 0);
});

test('removal selection refuses empty, duplicate, foreign or unseen SKU IDs and grouped/unknown identities', async t => {
  for (const ids of [[], ['sku-1', 'sku-1'], ['outside-source'], [1]]) {
    const f = fixture(t);
    refused(await f.preview({retailer_ids: ids}));
    assert.equal(f.calls.length, 0);
  }
  for (const change of ['missing', 'grouped', 'unknown', 'numeric']) {
    const f = fixture(t);
    if (change === 'missing') f.items[9001].shift();
    if (change === 'grouped') f.items[9001][0].item_group_key = '7000001';
    if (change === 'unknown') delete f.items[9001][0].item_group_id;
    if (change === 'numeric') f.items[9001][0].product_key = 5000001;
    refused(await f.preview());
    assert.equal(f.store.documents(f.actor.tenantId, 'x_catalog_removal_preview').length, 0);
    assert.equal(f.writes(), 0);
  }
});

test('removal save requires the original confirmation, session, scope, selection and current credentials', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    reads = f.calls.length;
  for (const changes of [
    {confirmed: false},
    {preview_hash: 'a'.repeat(64)},
    {account_id: 'other'},
    {catalog_id: '9002'},
    {connection_id: 'other'},
    {products: f.input.products},
    {retailer_ids: ['sku-1']},
    {name: 'override'},
  ])
    refused(await f.save(p, changes));
  for (const actor of [
    {...f.actor, userId: 'other'},
    {...f.actor, role: 'admin'},
    f.store.authenticate(f.store.createKey(f.actor)),
  ])
    refused(await f.save(p, {}, actor));
  assert.equal(f.calls.length, reads);
  const connection = f.store.resolveConnection(f.actor, 'x_ads_native_action', 'acct1', 'x');
  f.store.putConnection({...f.actor, role: 'admin'}, connection, {accessToken: 'rotated-synthetic'});
  refused(await f.save(p));
  assert.equal(f.calls.length, reads);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('changed selected supported evidence after preview refuses saving and unsent native review', async t => {
  for (const phase of ['save', 'prepare', 'execute']) {
    const f = fixture(t),
      p = ok(await f.preview());
    let saved, prepared;
    if (phase !== 'save') saved = ok(await f.save(p));
    if (phase === 'execute') prepared = ok(await f.campaign({action: 'prepare_next', id: saved.id}));
    f.items[9001][0].title = 'Different current selected product';
    const result =
      phase === 'save'
        ? await f.save(p)
        : phase === 'prepare'
          ? await f.campaign({action: 'prepare_next', id: saved.id})
          : await f.campaign({...prepared.next_call.arguments, spend_change_confirmed: true});
    refused(result, 'CATALOG_REMOVAL_CHANGED');
    assert.equal(f.writes(), 0, phase);
  }
});

test('independent removal steps use native review, exact deletion receipts and read-back without touching unselected products', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    saved = ok(await f.save(p));
  for (let i = 0; i < 2; i++) {
    const prepared = ok(await f.campaign({action: 'prepare_next', id: saved.id}));
    assert.equal(prepared.step_id, 'remove-' + (i + 1));
    ok(await f.campaign({...prepared.next_call.arguments, spend_change_confirmed: true}));
    ok(await f.campaign({action: 'prepare_next', id: saved.id}));
  }
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.ok(
    run.steps.every(s => s.status === 'verified'),
    JSON.stringify(run.steps).slice(0, 1000),
  );
  assert.equal(f.writes(), 2);
  assert.deepEqual(
    f.items[9001].map(p => p.id),
    ['sku-3'],
  );
  assert.ok(f.calls.filter(r => r.method !== 'GET').every(r => r.method === 'DELETE'));
});

test('uncertain original deletion resumes its original review and key without imposing a new source read', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    saved = ok(await f.save(p));
  ok(await f.campaign({action: 'prepare_next', id: saved.id}));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id),
    step = run.steps[0];
  step.status = 'executing';
  run.state = 'in_progress';
  f.store.putDocument(f.actor.tenantId, 'campaign_run', run.id, run);
  f.items[9001].shift();
  const reads = f.calls.length,
    result = ok(await f.campaign({action: 'prepare_next', id: run.id}));
  assert.equal(result.next_call.arguments.review_id, step.review_id);
  assert.equal(result.next_call.arguments.idempotency_key, step.review_id);
  assert.equal(f.calls.length, reads);
});

test('expired previews, readers and saturated preview retention refuse locally without deleting saved plans', async t => {
  const f = fixture(t);
  refused(await f.preview({}, {...f.actor, role: 'reader'}), 'FORBIDDEN');
  assert.equal(f.calls.length, 0);
  const p = ok(await f.preview()),
    retained = f.store.document(f.actor.tenantId, 'x_catalog_removal_preview', p.preview_id);
  f.store.putDocument(f.actor.tenantId, 'x_catalog_removal_preview', p.preview_id, {
    ...retained,
    expires_at: Date.now() - 1,
  });
  refused(await f.save(p), 'CATALOG_REMOVAL_EXPIRED');
  for (let i = 0; i < 100; i++)
    f.store.putDocument(f.actor.tenantId, 'x_catalog_removal_preview', 'full-' + i, {expires_at: Date.now() + 600000});
  refused(await f.preview(), 'CATALOG_REMOVAL_LIMIT');
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
});

test('removal draft creation cannot bypass the guarded save with replayed preview data or changed native steps', async t => {
  const f = fixture(t),
    p = ok(await f.preview()),
    saved = ok(await f.save(p));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  refused(
    await f.campaign({
      action: 'create',
      name: run.name,
      brief: run.brief,
      steps: run.steps.map(({status, ...s}) => s),
      confirmed: true,
      catalog_removal_preview_id: p.preview_id,
      catalog_removal_preview_hash: p.preview_hash,
      catalog_removal_save_nonce: 'guessed-nonce',
      idempotency_key: 'different-creation-key',
    }),
    'CATALOG_REMOVAL_CHANGED',
  );
  run.steps[0].arguments.payload.product_keys = ['5000003'];
  f.store.putDocument(f.actor.tenantId, 'campaign_run', run.id, run);
  refused(await f.campaign({action: 'prepare_next', id: run.id}), 'PLAN_CHANGED');
  assert.equal(f.writes(), 0);
});

test('concurrent removal saves retain one original draft and a local retry does not collect evidence again', async t => {
  let entered, release;
  const started = new Promise(resolve => {
      entered = resolve;
    }),
    paused = new Promise(resolve => {
      release = resolve;
    });
  const f = fixture(t, {
    read: async ({f}) => {
      if (f.calls.length === 9) {
        entered();
        await paused;
      }
    },
  });
  const p = ok(await f.preview()),
    first = f.save(p);
  let timer;
  try {
    await Promise.race([
      started,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Save did not start its bounded read')), 2000);
      }),
    ]);
    refused(await f.save(p), 'CATALOG_REMOVAL_BUSY');
  } finally {
    clearTimeout(timer);
    release();
  }
  const saved = ok(await first),
    count = f.calls.length;
  assert.equal(ok(await f.save(p)).id, saved.id);
  assert.equal(f.calls.length, count);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
  assert.equal(f.writes(), 0);
});

test('revoked clients or changing provider observations cannot leave a retained removal preview', async t => {
  for (const mode of ['revoke', 'change']) {
    let key;
    const f = fixture(t, {
      read: ({f}) => {
        if (mode === 'revoke' && f.calls.length === 1) f.store.revokeKey(key);
        if (mode === 'change' && f.calls.length === 4) f.items[9001][0].title = 'Changed between repeated reads';
      },
    });
    key = f.store.createKey(f.actor);
    const actor = f.store.authenticate(key);
    refused(await f.preview({}, actor));
    assert.equal(f.store.documents(f.actor.tenantId, 'x_catalog_removal_preview').length, 0);
    assert.equal(f.writes(), 0);
  }
});
