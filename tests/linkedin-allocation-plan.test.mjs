import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedinAllocationFixture, linkedinAllocationIds} from './fixtures/linkedin-allocation-data.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};
test('LinkedIn allocation preserves exact campaign URNs and produces decimal native daily budgets from verified UTC reports', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  const p = ok(await f.preview());
  assert.equal(p.gateway, 'linkedin_native_action');
  assert.equal(p.currency, 'USD');
  assert.equal(p.timezone, 'UTC');
  assert.deepEqual(
    p.targets.map(t => t.entity_id),
    linkedinAllocationIds.map(id => 'urn:li:sponsoredCampaign:' + id),
  );
  assert.deepEqual(
    p.targets.map(t => t.daily_budget),
    ['90', '30'],
  );
  assert.equal(p.targets[0].current_daily_budget, '11.25');
  assert.equal(p.targets[0].name, 'Original campaign العربية ' + linkedinAllocationIds[0]);
  assert.equal(p.native_source_references.length, 8);
  assert.doesNotMatch(JSON.stringify(p), /accessToken|authorization_signature/);
  const saved = ok(await f.create(p)),
    run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.equal(run.state, 'draft');
  assert.equal(run.steps.length, 2);
  for (const [i, s] of run.steps.entries()) {
    assert.equal(s.gateway, 'linkedin_native_action');
    assert.equal(s.arguments.path_params.campaign_id, linkedinAllocationIds[i]);
    assert.equal(s.arguments.restli_method, 'PARTIAL_UPDATE');
    assert.deepEqual(s.arguments.payload, {
      patch: {$set: {dailyBudget: {amount: i ? '30' : '90', currencyCode: 'USD'}}},
    });
  }
  assert.ok(f.requests.every(r => r.method === 'GET'));
  const n = f.requests.length;
  assert.equal(ok(await f.create(p)).id, saved.id);
  assert.equal(f.requests.length, n);
});

test('LinkedIn allocation rejects edited report provenance, semantics and campaign identities before budget reads', async t => {
  for (const mode of ['collection', 'currency', 'checks', 'mapping', 'dates', 'query', 'urn']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    const r = f.report();
    if (mode === 'collection') r.source_collection = 'imported';
    if (mode === 'currency') r.native_account_evidence.currency = 'SAR';
    if (mode === 'checks') r.native_account_evidence.checks.pop();
    if (mode === 'mapping') r.mapping.conversions = '/clicks';
    if (mode === 'dates') r.source_request.query.dateRange = '(start:(year:2000,month:1,day:1))';
    if (mode === 'query') r.source_request.query.accounts = 'List(urn:li:sponsoredAccount:99)';
    if (mode === 'urn') r.rows[0].entity_id = '9007199254740993';
    f.store.putDocument(f.actor.tenantId, 'decision_report', r.id, r);
    const before = f.requests.length;
    assert.equal((await f.preview()).success, false, mode);
    assert.equal(f.requests.length, before, mode);
  }
});

test('LinkedIn exact decimal conversion shows residuals and refuses rounding below an explicit floor', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  const p = ok(await f.preview({options: {...f.options, budget: '240.000001'}}));
  assert.equal(p.targets[0].daily_budget, '90');
  assert.equal(p.targets[1].daily_budget, '30');
  assert.equal(p.targets[1].rounding_residual, '0.000001');
  const out = await f.preview({
    options: {
      ...f.options,
      budget: '240.000001',
      allocations: f.options.allocations.map((r, i) => ({
        ...r,
        minimum: i ? '60.000001' : '180',
        maximum: i ? '60.000001' : '180',
      })),
    },
  });
  assert.equal(out.error.code, 'ALLOCATION_PRECISION');
});

test('LinkedIn drafts reject other sessions, expired previews and altered retained model rows', async t => {
  for (const mode of ['session', 'expired', 'rows']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    const p = ok(await f.preview());
    let actor = f.actor;
    if (mode === 'session') actor = f.store.authenticate(f.store.createKey(f.actor));
    if (mode === 'expired') {
      const original = f.store.document(actor.tenantId, 'allocation_preview', p.preview_id);
      f.store.putDocument(actor.tenantId, 'allocation_preview', p.preview_id, {
        ...original,
        expires_at: Date.now() - 1,
      });
    }
    if (mode === 'rows') {
      const r = f.report();
      r.rows[0].conversions = '40';
      f.store.putDocument(actor.tenantId, 'decision_report', r.id, r);
    }
    const before = f.requests.length;
    assert.equal((await f.create(p, {}, actor)).success, false, mode);
    assert.equal(f.requests.length, before);
    assert.equal(f.store.documents(actor.tenantId, 'campaign_run').length, 0);
  }
});

test('LinkedIn source-bound drafts retain one original creation under concurrent calls and reject detached direct bodies', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  const p = ok(await f.preview());
  let release, entered;
  const waiting = new Promise(resolve => {
    entered = resolve;
  });
  let once = true;
  f.hook(() => {
    if (!once) return;
    once = false;
    return new Promise(resolve => {
      release = resolve;
      entered();
    });
  });
  const pending = f.create(p);
  await waiting;
  assert.equal((await f.create(p)).error.code, 'ALLOCATION_PLAN_BUSY');
  release();
  const saved = ok(await pending);
  f.hook(undefined);
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id),
    next = ok(await f.preview());
  const input = {
    action: 'create',
    name: run.name,
    brief: run.brief,
    idempotency_key: 'allocation-' + next.preview_id,
    allocation_preview_id: next.preview_id,
    allocation_preview_hash: next.preview_hash,
    confirmed: true,
    steps: run.steps.map(s =>
      Object.fromEntries(
        [
          'id',
          'kind',
          'gateway',
          'connection_id',
          'account_id',
          'expected_currency',
          'arguments',
          'depends_on',
          'description',
        ].map(k => [k, s[k]]),
      ),
    ),
  };
  input.steps[0].arguments.payload.patch.$set.status = 'ACTIVE';
  assert.equal((await f.service.call('amcp_campaign', input, f.actor)).success, false);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});

test('LinkedIn changed native campaign/group settings and revoked grants refuse unsent preparation or execution', async t => {
  for (const mode of ['before-review', 'campaign', 'group', 'scope', 'key', 'cancel']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    const p = ok(await f.preview()),
      saved = ok(await f.create(p));
    if (mode === 'before-review') {
      f.campaigns.get(linkedinAllocationIds[0]).dailyBudget.amount = '12';
      assert.equal(
        (await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor)).success,
        false,
      );
      continue;
    }
    const prepared = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
    if (mode === 'campaign') f.campaigns.get(linkedinAllocationIds[0]).versionTag = '2';
    if (mode === 'group') f.group.budgetOptimization = {budgetOptimizationStrategy: 'DYNAMIC'};
    if (mode === 'scope')
      f.store.putConnection(
        f.owner,
        {...f.connection, scopes: ['r_ads', 'r_ads_reporting']},
        {accessToken: 'synthetic'},
      );
    if (mode === 'key') f.store.revokeKey(f.key);
    if (mode === 'cancel')
      f.hook(() => {
        const r = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
        f.store.putDocument(f.actor.tenantId, 'campaign_run', saved.id, {
          ...r,
          state: 'cancelled',
          revision: r.revision + 1,
        });
      });
    f.allowUpdates();
    const out = await f.service.call(
      'amcp_campaign',
      {...prepared.next_call.arguments, spend_change_confirmed: true},
      f.actor,
    );
    assert.notEqual(out.data?.current?.status, 'verified', mode);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0, mode);
  }
});

test('LinkedIn uncertain original execution retains its native review and key without rerunning changed source reads', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  const p = ok(await f.preview()),
    saved = ok(await f.create(p));
  ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id),
    step = run.steps[0];
  step.status = 'executing';
  run.state = 'in_progress';
  f.store.putDocument(f.actor.tenantId, 'campaign_run', saved.id, run);
  f.campaigns.get(linkedinAllocationIds[0]).versionTag = 'changed';
  const before = f.requests.length,
    recovery = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  assert.equal(recovery.next_call.arguments.review_id, step.review_id);
  assert.equal(recovery.next_call.arguments.idempotency_key, step.review_id);
  assert.equal(f.requests.length, before);
});

test('LinkedIn allocation caps selected campaigns before egress and counts current previews without loading them', async t => {
  const f = linkedinAllocationFixture(t);
  const original = f.analytics.elements.filter(r => r.pivotValues[0].endsWith(linkedinAllocationIds[0]));
  const ids = Array.from({length: 21}, (_, i) => String(1000 + i));
  f.analytics.elements = ids.flatMap(id =>
    original.map(r => ({...r, pivotValues: ['urn:li:sponsoredCampaign:' + id]})),
  );
  ok(await f.captureReport());
  const before = f.requests.length;
  assert.equal(
    (
      await f.preview({
        options: {
          ...f.options,
          budget: '420',
          allocations: ids.map(id => ({entity_id: 'urn:li:sponsoredCampaign:' + id, minimum: '10', maximum: '30'})),
        },
      })
    ).success,
    false,
  );
  assert.equal(f.requests.length, before);
  const g = linkedinAllocationFixture(t);
  ok(await g.captureReport());
  for (let i = 0; i < 100; i++)
    g.store.putDocument(g.actor.tenantId, 'allocation_preview', 'synthetic-' + i, {expires_at: Date.now() + 600000});
  const documents = g.store.documents.bind(g.store);
  g.store.documents = () => {
    throw Error('Preview cap must count rather than load private documents');
  };
  assert.equal((await g.preview()).error.code, 'ALLOCATION_PREVIEW_LIMIT');
  g.store.putDocument(g.actor.tenantId, 'allocation_preview', 'synthetic-0', {expires_at: Date.now() - 1});
  ok(await g.preview());
  g.store.documents = documents;
  assert.equal(documents(g.actor.tenantId, 'allocation_preview').length, 100);
});

test('LinkedIn malformed or oversized exact-resource evidence refuses without partial previews', async t => {
  for (const mode of ['oversized', 'ambiguous', 'unsafe-id']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    f.hook(u =>
      u.pathname.endsWith('/adCampaigns/' + linkedinAllocationIds[0])
        ? Response.json(
            mode === 'oversized'
              ? {...f.campaigns.get(linkedinAllocationIds[0]), extra: 'x'.repeat(65537)}
              : mode === 'ambiguous'
                ? {elements: []}
                : {...f.campaigns.get(linkedinAllocationIds[0]), id: Number(linkedinAllocationIds[0])},
          )
        : undefined,
    );
    assert.equal((await f.preview()).success, false, mode);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
  }
});

test('LinkedIn draft previews require a current writer, account write grant and advertising/reporting scopes before egress', async t => {
  for (const mode of ['viewer', 'write-grant', 'reporting', 'advertising', 'disabled']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    let actor = f.actor;
    if (mode === 'viewer')
      actor = f.store.authenticate(f.store.createKey({...f.owner, userId: 'viewer', role: 'reader'}));
    else
      f.store.putConnection(
        f.owner,
        {
          ...f.connection,
          ...(mode === 'write-grant'
            ? {writeAccounts: []}
            : mode === 'disabled'
              ? {enabled: false}
              : {scopes: mode === 'reporting' ? ['rw_ads'] : ['r_ads', 'r_ads_reporting']}),
        },
        {accessToken: 'synthetic'},
      );
    const before = f.requests.length;
    assert.equal((await f.preview({}, actor)).success, false, mode);
    assert.equal(f.requests.length, before);
  }
});

test('LinkedIn native read retries keep the same exact scope and original eight resource references', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  let failed = false;
  f.hook(u => {
    if (!failed && u.pathname === '/rest/adAccounts/100') {
      failed = true;
      return Response.json({message: 'Synthetic transient unavailable'}, {status: 503});
    }
  });
  const p = ok(await f.preview());
  assert.equal(p.native_source_references.length, 8);
  assert.equal(f.requests.length, 12);
  assert.ok(
    p.native_source_references.every(
      r => r.source_request.api_version === '202609' && r.source_request.connection_id === f.connection.id,
    ),
  );
  assert.ok(f.requests.every(r => r.method === 'GET' && r.headers.get('LinkedIn-Version') === '202609'));
});
test('LinkedIn allocation refuses shared, lifetime, accelerated, unknown or foreign daily-budget evidence without saving a draft', async t => {
  for (const mode of [
    'dynamic',
    'group-daily',
    'total',
    'pacing',
    'identity',
    'currency',
    'future',
    'partial',
    'money',
  ]) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    const c = f.campaigns.get(linkedinAllocationIds[0]);
    if (mode === 'dynamic') f.group.budgetOptimization = {budgetOptimizationStrategy: 'DYNAMIC', bidStrategy: 'MANUAL'};
    if (mode === 'group-daily') f.group.dailyBudget = {amount: '50', currencyCode: 'USD'};
    if (mode === 'total') c.totalBudget = {amount: '1000', currencyCode: 'USD'};
    if (mode === 'pacing') c.pacingStrategy = 'ACCELERATED';
    if (mode === 'identity') c.account = 'urn:li:sponsoredAccount:99';
    if (mode === 'currency') c.dailyBudget.currencyCode = 'SAR';
    if (mode === 'future') c.budgetOptimization = {futureStrategy: true};
    if (mode === 'partial') c.paging = {next: 'unknown'};
    if (mode === 'money') c.dailyBudget.amount = '11.1234567';
    assert.equal((await f.preview()).success, false, mode);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  }
});
test('changed LinkedIn budget or group configuration refuses saved-source draft creation', async t => {
  for (const mode of ['campaign', 'group']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    const p = ok(await f.preview());
    if (mode === 'campaign') f.campaigns.get(linkedinAllocationIds[0]).dailyBudget.amount = '12.50';
    else f.group.totalBudget.amount = '9000';
    assert.equal((await f.create(p)).success, false, mode);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    assert.ok(f.requests.every(r => r.method === 'GET'));
  }
});
test('LinkedIn budget proposals refuse mid-read authority rotation and inconsistent native versions', async t => {
  for (const mode of ['credentials', 'scope', 'budget']) {
    const f = linkedinAllocationFixture(t);
    ok(await f.captureReport());
    f.hook((_u, n) => {
      if (n !== 8) return;
      if (mode === 'credentials') f.store.putConnection(f.owner, f.connection, {accessToken: 'rotated-synthetic'});
      if (mode === 'scope')
        f.store.putConnection(f.owner, {...f.connection, scopes: ['r_ads_reporting']}, {accessToken: 'synthetic'});
      if (mode === 'budget') f.campaigns.get(linkedinAllocationIds[0]).versionTag = '2';
    });
    assert.equal((await f.preview()).success, false, mode);
    assert.equal(f.store.documents(f.actor.tenantId, 'allocation_preview').length, 0);
  }
});
test('LinkedIn budget execution uses the existing spending acknowledgement and independent native read-back', async t => {
  const f = linkedinAllocationFixture(t);
  ok(await f.captureReport());
  const p = ok(await f.preview()),
    saved = ok(await f.create(p));
  f.allowUpdates();
  const prepared = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  const refused = await f.service.call('amcp_campaign', prepared.next_call.arguments, f.actor);
  assert.equal(ok(refused).current.error.code, 'SPEND_CONFIRMATION_REQUIRED');
  assert.equal(refused.data.current.status, 'review_ready');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  ok(await f.service.call('amcp_campaign', {...prepared.next_call.arguments, spend_change_confirmed: true}, f.actor));
  const second = ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  ok(await f.service.call('amcp_campaign', {...second.next_call.arguments, spend_change_confirmed: true}, f.actor));
  ok(await f.service.call('amcp_campaign', {action: 'prepare_next', id: saved.id}, f.actor));
  const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
  assert.ok(
    run.steps.every(s => s.status === 'verified'),
    JSON.stringify(run.steps),
  );
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  assert.equal(f.campaigns.get(linkedinAllocationIds[0]).status, 'PAUSED');
  assert.equal(f.campaigns.get(linkedinAllocationIds[1]).status, 'ACTIVE');
  assert.equal(f.group.totalBudget.amount, '10000');
});
