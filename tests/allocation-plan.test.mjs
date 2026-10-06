import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {allocationReport} from './fixtures/allocation-data.mjs';

function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64'));
  const identity = {tenantId: 'allocation-draft', userId: 'operator', role: 'operator'},
    key = store.createKey(identity),
    actor = store.authenticate(key);
  const connection = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['123'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Synthetic',
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const report = {
    ...allocationReport(),
    gateway: connection.gateway,
    preset: 'google_campaign',
    connection_id: connection.id,
    account_id: '123',
  };
  store.putDocument(actor.tenantId, 'decision_report', 'source', report);
  const customer = {id: '123', currencyCode: 'USD', timeZone: 'UTC'};
  let rows = ['10', '20'].map(id => ({
    customer,
    campaign: {
      id,
      resourceName: 'customers/123/campaigns/' + id,
      name: 'Campaign ' + id,
      status: 'ENABLED',
      campaignBudget: 'customers/123/campaignBudgets/1' + id,
    },
    campaignBudget: {
      resourceName: 'customers/123/campaignBudgets/1' + id,
      amountMicros: '200000000',
      explicitlyShared: false,
      referenceCount: '1',
      period: 'DAILY',
      status: 'ENABLED',
    },
  }));
  let requests = 0,
    writes = 0,
    allowMutation = false,
    readHook;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      requests++;
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/googleAds:search')) {
        await readHook?.();
        const q = body.query;
        if (q.includes(' FROM campaign_budget'))
          return Response.json({
            results: rows
              .filter(r => q.includes(r.campaignBudget.resourceName))
              .map(r => ({campaignBudget: r.campaignBudget})),
          });
        if (q.includes(' FROM customer')) return Response.json({results: [{customer}]});
        const match = q.match(/campaign.id IN \(([^)]+)\)/);
        return Response.json({results: match ? rows.filter(r => match[1].split(',').includes(r.campaign.id)) : rows});
      }
      writes++;
      if (allowMutation && String(url).endsWith('/campaignBudgets:mutate')) {
        const results = body.operations.map(op => {
          const row = rows.find(r => r.campaignBudget.resourceName === op.update.resourceName);
          assert.ok(row);
          assert.equal(op.updateMask, 'amountMicros');
          row.campaignBudget.amountMicros = op.update.amountMicros;
          return {resourceName: row.campaignBudget.resourceName};
        });
        return Response.json({results});
      }
      throw Error('Unexpected provider mutation');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const options = {
    budget: '200',
    efficiency_low: 0.8,
    efficiency_high: 1.2,
    maximum_age_days: 7,
    minimum_conversions: 5,
    allocations: [
      {entity_id: '10', minimum: '25', maximum: '125'},
      {entity_id: '20', minimum: '50', maximum: '175'},
    ],
  };
  const call = async (tool, input) => service.call(tool, input, actor);
  const preview = () =>
    call('amcp_reporting', {action: 'preview_allocation_plan', id: 'source', options, conversion: 'equal_daily'});
  const create = p =>
    call('amcp_reporting', {
      action: 'create_allocation_plan',
      id: 'source',
      preview_id: p.preview_id,
      preview_hash: p.preview_hash,
      confirmed: true,
    });
  return {
    store,
    actor,
    key,
    connection,
    report,
    service,
    options,
    call,
    preview,
    create,
    rows: () => rows,
    setRows: v => {
      rows = v;
    },
    hook: f => {
      readHook = f;
    },
    counts: () => ({requests, writes}),
    allowSyntheticWrites: () => {
      allowMutation = true;
    },
  };
}
const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('Google allocation retains two unchanged selected-budget observations and refuses an in-flight change', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview());
    assert.equal(p.native_source_references.length, 2);
    assert.equal(p.native_source_references[0].source_hash, p.native_source_references[1].source_hash);
    assert.equal(f.counts().requests, 2);
  } finally {
    f.store.close();
  }
  for (const change of [
    rows => {
      rows[0].campaignBudget.amountMicros = '200000001';
    },
    rows => {
      rows[0].campaign.status = 'PAUSED';
    },
    rows => {
      rows[0].campaign.campaignBudget = rows[0].campaignBudget.resourceName = 'customers/123/campaignBudgets/999';
    },
  ]) {
    const f = fixture();
    try {
      f.hook(() => {
        if (f.counts().requests === 2) change(f.rows());
      });
      const failed = await f.preview();
      assert.equal(failed.success, false);
      assert.equal(failed.error.code, 'ALLOCATION_BUDGET_CHANGED');
      assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
      assert.equal(f.counts().writes, 0);
    } finally {
      f.store.close();
    }
  }
});

test('an allocation preview names native daily units and creates one unapproved source-bound draft', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview());
    assert.equal(p.period_days, 2);
    assert.equal(p.targets[0].daily_budget_micros, '62500000');
    assert.equal(p.targets[0].period_budget, '125');
    assert.equal(p.targets[0].rounding_residual, '0');
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    const created = good(await f.create(p)),
      replay = good(await f.create(p));
    assert.equal(replay.id, created.id);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
    const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
    assert.equal(run.state, 'draft');
    assert.equal(typeof run.approval, 'string');
    assert.equal(run.allocation.report_id, 'source');
    assert.equal(run.allocation.preview_id, p.preview_id);
    assert.equal(run.steps[0].arguments.payload.operations[0].update.amount_micros, '62500000');
    assert.equal(run.steps[0].expected_currency, 'USD');
    assert.equal(created.next_call.arguments.action, 'get');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('allocation preview rejects shared, lifetime, missing, foreign and conflicting currency budgets', async () => {
  for (const change of [
    rows => (rows[0].campaignBudget.explicitlyShared = true),
    rows => (rows[0].campaignBudget.referenceCount = '2'),
    rows => (rows[0].campaignBudget.period = 'CUSTOM_PERIOD'),
    rows => rows.pop(),
    rows => (rows[0].customer.currencyCode = 'EUR'),
    rows => (rows[0].campaignBudget.resourceName = 'customers/999/campaignBudgets/110'),
    rows => (rows[0].campaign.status = 'REMOVED'),
  ]) {
    const f = fixture();
    try {
      change(f.rows());
      const r = await f.preview();
      assert.equal(r.success, false);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
      assert.equal(f.counts().writes, 0);
    } finally {
      f.store.close();
    }
  }
});

test('draft confirmation binds source revision, current native budgets, creator and preview expiry', async () => {
  for (const change of [
    f => {
      const r = f.store.document(f.actor.tenantId, 'decision_report', 'source');
      f.store.putDocument(f.actor.tenantId, 'decision_report', 'source', {...r, source_hash: 'changed'});
    },
    f => (f.rows()[0].campaignBudget.amountMicros = '300000000'),
    f => f.store.revokeKey(f.key),
  ]) {
    const f = fixture();
    try {
      const p = good(await f.preview());
      change(f);
      const r = await f.create(p);
      assert.equal(r.success, false);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    const p = good(await f.preview());
    assert.equal(
      (
        await f.call('amcp_reporting', {
          action: 'create_allocation_plan',
          id: 'source',
          preview_id: p.preview_id,
          preview_hash: p.preview_hash,
          confirmed: false,
        })
      ).success,
      false,
    );
    assert.equal((await f.create({...p, preview_hash: 'altered'})).success, false);
    const saved = f.store.document(f.actor.tenantId, 'allocation_preview', p.preview_id);
    f.store.putDocument(f.actor.tenantId, 'allocation_preview', p.preview_id, {...saved, expires_at: Date.now() - 1});
    assert.equal((await f.create(p)).success, false);
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('a lost draft response reuses the original plan and proposal budgets are guarded before preparation', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview()),
      created = good(await f.create(p));
    const saved = f.store.document(f.actor.tenantId, 'allocation_preview', p.preview_id);
    delete saved.plan_id;
    f.store.putDocument(f.actor.tenantId, 'allocation_preview', p.preview_id, saved);
    assert.equal(good(await f.create(p)).id, created.id);
    f.rows()[0].campaign.campaignBudget = 'customers/123/campaignBudgets/999';
    const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id: created.id});
    assert.equal(prepared.success, false);
    assert.equal(prepared.error.code, 'ALLOCATION_BUDGET_CHANGED');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('native review remains separate and a changed budget association stops the unsubmitted execution', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview()),
      created = good(await f.create(p));
    const review = good(await f.call('amcp_campaign', {action: 'prepare_next', id: created.id}));
    assert.equal(typeof review.review.review_id, 'string');
    assert.equal(f.counts().writes, 0);
    f.rows()[0].campaignBudget.explicitlyShared = true;
    const executed = await f.call('amcp_campaign', {
      action: 'execute_next',
      id: created.id,
      review_id: review.review.review_id,
      idempotency_key: review.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(executed.success, false);
    assert.equal(executed.error.code, 'ALLOCATION_BUDGET_CHANGED');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('allocation draft requests preserve explicit conversion, decimal residuals and representable floors', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.call('amcp_reporting', {action: 'preview_allocation_plan', id: 'source', options: f.options})).success,
      false,
    );
    f.options.budget = '200.000001';
    const p = good(await f.preview());
    assert.equal(p.targets[1].daily_budget_micros, '37500000');
    assert.equal(p.targets[1].rounding_residual, '0.000001');
    f.options.allocations[1].minimum = '75.000001';
    assert.equal((await f.preview()).error.code, 'ALLOCATION_PRECISION');
    const report = f.store.document(f.actor.tenantId, 'decision_report', 'source');
    f.store.putDocument(f.actor.tenantId, 'decision_report', 'source', {...report, preset: 'meta_campaign'});
    assert.equal((await f.preview()).error.code, 'ALLOCATION_PLAN_UNQUALIFIED');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('preview access and creator identity are rechecked after provider reads and before local creation', async () => {
  const f = fixture();
  try {
    const denied = await f.service.call(
      'amcp_reporting',
      {action: 'preview_allocation_plan', id: 'source', options: f.options, conversion: 'equal_daily'},
      {...f.actor, role: 'reader'},
    );
    assert.equal(denied.success, false);
    assert.equal(f.counts().requests, 0);
    const p = good(await f.preview());
    const wrong = await f.service.call(
      'amcp_reporting',
      {
        action: 'create_allocation_plan',
        id: 'source',
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
      },
      {...f.actor, userId: 'someone-else'},
    );
    assert.equal(wrong.success, false);
    f.hook(() => f.store.revokeKey(f.key));
    assert.equal((await f.preview()).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 1);
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('concurrent draft creation is bounded and cancellation during an ownership read stays cancelled', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview());
    let release, entered;
    const waiting = new Promise(resolve => {
      entered = resolve;
    });
    f.hook(
      () =>
        new Promise(resolve => {
          release = resolve;
          entered();
        }),
    );
    const pending = f.create(p);
    await waiting;
    assert.equal((await f.create(p)).error.code, 'ALLOCATION_PLAN_BUSY');
    f.hook(() => {});
    release();
    const created = good(await pending);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
    f.hook(() => {
      const r = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
      f.store.putDocument(f.actor.tenantId, 'campaign_run', created.id, {...r, state: 'cancelled'});
    });
    assert.equal(
      (await f.call('amcp_campaign', {action: 'prepare_next', id: created.id})).error.code,
      'REVISION_CONFLICT',
    );
    assert.equal(f.store.document(f.actor.tenantId, 'campaign_run', created.id).state, 'cancelled');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('campaign creation keys reuse the original draft, reject changed bodies and retain allocation binding atomically', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview()),
      original = f.service.call.bind(f.service);
    f.service.call = async (tool, input, actor) => {
      const response = await original(tool, input, actor);
      if (tool === 'amcp_campaign' && input.action === 'create' && response.success) {
        assert.equal(
          f.store.document(actor.tenantId, 'campaign_run', response.data.id).allocation.preview_id,
          p.preview_id,
        );
      }
      return response;
    };
    const created = good(await f.create(p));
    f.service.call = original;
    const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
    const args = {
      action: 'create',
      name: 'Manual budget draft',
      brief: 'Synthetic',
      idempotency_key: 'stable-creation-key',
      steps: run.steps.map(({status, ...step}) => step),
    };
    const first = good(await f.call('amcp_campaign', args));
    assert.equal(good(await f.call('amcp_campaign', args)).id, first.id);
    assert.equal((await f.call('amcp_campaign', {...args, name: 'Changed'})).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(f.counts().writes, 0);
  } finally {
    f.store.close();
  }
});

test('separately approved allocation steps execute and verify once through the existing native engine', async () => {
  const f = fixture();
  try {
    const p = good(await f.preview()),
      created = good(await f.create(p));
    f.allowSyntheticWrites();
    for (let i = 0; i < 2; i++) {
      const prepared = good(await f.call('amcp_campaign', {action: 'prepare_next', id: created.id}));
      const result = good(
        await f.call('amcp_campaign', {
          action: 'execute_next',
          id: created.id,
          review_id: prepared.review.review_id,
          idempotency_key: prepared.review.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        }),
      );
      assert.equal(result.current.status, 'verified', JSON.stringify(result));
    }
    const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
    assert.equal(run.state, 'complete');
    assert.equal(f.counts().writes, 2);
    const replay = good(
      await f.call('amcp_campaign', {
        action: 'execute_next',
        id: created.id,
        review_id: run.steps[1].review_id,
        confirmed: true,
      }),
    );
    assert.equal(replay.state, 'complete');
    assert.equal(f.counts().writes, 2);
    assert.deepEqual(
      f.rows().map(r => r.campaignBudget.amountMicros),
      ['62500000', '37500000'],
    );
  } finally {
    f.store.close();
  }
});
