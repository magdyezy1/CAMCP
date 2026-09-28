import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {CampaignRunner} from '../dist/src/campaign-runner.js';
import {MirrorError} from '../dist/src/errors.js';

function fixture(kind = 'media') {
  const actor = {tenantId: 'reconciliation', userId: 'operator', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 29).toString('base64')),
    calls = [];
  let ready = false,
    revoked = false;
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.bindActorCheck(actor, () => {
    if (revoked) throw new MirrorError('FORBIDDEN', 'Synthetic revocation');
  });
  const runner = new CampaignRunner(
    store,
    async (name, args) => {
      calls.push({name, args});
      if (name === 'amcp_media' && args.action === 'status')
        return {
          success: true,
          data: {
            media_id: 'customers/123/youTubeVideoUploads/456',
            ready,
            processing_status: ready ? 'succeeded' : 'processing',
          },
        };
      if (name === 'amcp_write' && args.action === 'prepare')
        return {
          success: true,
          data: {
            review_id: 'dependent-review',
            idempotency_key: 'dependent-review',
            expires_at: new Date(Date.now() + 60000).toISOString(),
          },
        };
      throw Error('Unexpected provider mutation: ' + JSON.stringify({name, args}));
    },
    async () => ({status: 'verified'}),
    async () => ({}),
  );
  const steps = [
    {
      id: 'upload',
      kind,
      gateway: 'google_ads_native_action',
      connection_id: 'login',
      account_id: '123',
      arguments: {platform: 'google_ads', drive_url: 'https://drive.google.com/file/d/abcdefghijklmno/view'},
    },
    {
      id: 'creative',
      kind: 'write',
      gateway: 'google_ads_native_action',
      connection_id: 'login',
      account_id: '123',
      depends_on: ['upload'],
      arguments: {payload: {media_id: {$ref: 'upload#/media_id'}}},
    },
  ];
  return {
    actor,
    store,
    runner,
    calls,
    steps,
    setReady: value => {
      ready = value;
    },
    revoke: () => {
      revoked = true;
    },
    async create() {
      const run = await runner.handle(
        {action: 'create', name: 'Retained original upload', brief: 'Synthetic recovery', steps},
        actor,
      );
      run.steps[0].status = 'uncertain';
      run.steps[0].review_id = 'original-review';
      run.steps[0].error = {code: 'WRITE_OUTCOME_UNCERTAIN'};
      run.state = 'attention';
      store.putDocument(actor.tenantId, 'campaign_run', run.id, run, run.revision);
      return run.id;
    },
  };
}

test('campaign reconciliation never resubmits an absent or uncertain original claim', async () => {
  const f = fixture();
  try {
    const id = await f.create();
    for (const claimed of [false, true]) {
      if (claimed) {
        f.store.claim(f.actor.tenantId, 'original-review', 'fingerprint');
        f.store.uncertain(f.actor.tenantId, 'original-review');
      }
      await assert.rejects(
        () => f.runner.handle({action: 'reconcile_step', id, step_id: 'upload'}, f.actor),
        e => e.code === 'RECOVERY_NOT_SAFE',
      );
      assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', id).steps[0].status, 'uncertain');
      assert.equal(f.calls.length, 0);
    }
  } finally {
    f.store.close();
  }
});

test('completed original media receipt requires readiness before dependent preparation and is never uploaded twice', async () => {
  const f = fixture();
  try {
    const id = await f.create();
    f.store.claim(f.actor.tenantId, 'original-review', 'fingerprint');
    f.store.complete(f.actor.tenantId, 'original-review', {
      media_id: 'customers/123/youTubeVideoUploads/456',
      review_id: 'original-review',
      executed: true,
      sha256: 'frozen-bytes',
    });
    let run = await f.runner.handle({action: 'reconcile_step', id, step_id: 'upload'}, f.actor);
    assert.equal(run.steps[0].status, 'processing');
    assert.equal(run.steps[1].status, 'pending');
    assert.equal(run.steps[0].result.sha256, 'frozen-bytes');
    assert.equal(run.steps[0].error, undefined);
    const waiting = await f.runner.handle({action: 'prepare_next', id}, f.actor);
    assert.equal(waiting.blocked_by, 'media_processing');
    assert.ok(f.calls.every(c => c.name === 'amcp_media' && c.args.action === 'status'));
    f.setReady(true);
    run = await f.runner.handle({action: 'reconcile_step', id, step_id: 'upload'}, f.actor);
    assert.equal(run.steps[0].status, 'verified');
    await f.runner.handle({action: 'prepare_next', id}, f.actor);
    const prepared = f.calls.filter(c => c.name === 'amcp_write');
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].args.action, 'prepare');
    assert.equal(prepared[0].args.arguments.payload.media_id, 'customers/123/youTubeVideoUploads/456');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM idempotency').get().n, 1);
  } finally {
    f.store.close();
  }
});

test('write reconciliation uses the completed original receipt and retains current authority checks', async () => {
  const f = fixture('write');
  try {
    const id = await f.create();
    f.store.claim(f.actor.tenantId, 'original-review', 'fingerprint');
    f.store.complete(f.actor.tenantId, 'original-review', {media_id: 'known-scoped-resource', executed: true});
    f.revoke();
    await assert.rejects(
      () => f.runner.handle({action: 'reconcile_step', id, step_id: 'upload'}, f.actor),
      e => e.code === 'FORBIDDEN',
    );
    assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', id).steps[0].status, 'uncertain');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
  const f2 = fixture('write');
  try {
    const id = await f2.create();
    f2.store.claim(f2.actor.tenantId, 'original-review', 'fingerprint');
    f2.store.complete(f2.actor.tenantId, 'original-review', {media_id: 'known-scoped-resource', executed: true});
    const run = await f2.runner.handle({action: 'reconcile_step', id, step_id: 'upload'}, f2.actor);
    assert.equal(run.steps[0].status, 'verified');
    assert.equal(run.steps[0].result.media_id, 'known-scoped-resource');
    assert.equal(f2.calls.length, 0);
  } finally {
    f2.store.close();
  }
});
