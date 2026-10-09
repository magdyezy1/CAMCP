import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleBudgetFixture, budgetName} from './fixtures/google-budget-writes.mjs';

/**
 * WRT-06: provider validation is a gated, non-mutating effect. It used to run in a read-only deployment and without the
 * account's write grant, and a Meta validate_only inside a reviewed write was receipted as an applied change. Validation
 * now needs live writes or the deployment owner's opt-in (owner decision D18) plus the write grant, is audited before it
 * is sent, and reviewed writes refuse Meta's validation options. prepare can also ask the provider to validate
 * (provider_check); a rejected review cannot be executed.
 */
const registry = new Registry(),
  owner = {tenantId: 'provider-validation', userId: 'owner', role: 'admin'};
const googleArgs = {
  action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
  account_id: '123',
  payload: {operations: [{create: {name: 'Budget', amount_micros: '1000000', delivery_method: 'STANDARD'}}]},
};
const metaCampaign = {
  action: 'meta_campaign_create',
  account_id: '123',
  payload: {name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
};
function fixture({gateway = 'google_ads_native_action', policy = {allowWrites: true}, grant = true, reply} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'c',
      tenantId: owner.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: grant ? ['123'] : [],
      enabled: true,
      label: 'Synthetic',
      scopes: gateway === 'meta_native_action' ? ['ads_management'] : [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const requests = [];
  const audit = () => store.audit(owner.tenantId, 1000).map(row => JSON.parse(row.event));
  const transport = new NativeTransport(async (url, init = {}) => {
    const path = new URL(String(url)).pathname,
      method = init.method ?? 'GET';
    requests.push({path, method, body: init.body, audited: audit().map(e => e.event)});
    if (method === 'GET' && path === '/v26.0/act_123')
      return Response.json({id: 'act_123', account_id: '123', currency: 'USD', account_status: 1});
    if (reply) return reply({path, method, body: init.body});
    return Response.json(gateway === 'meta_native_action' ? {success: true} : {results: []});
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    maxBudgetChange: 0,
    requireBeforeState: true,
    ...policy,
  });
  const validate = (args = gateway === 'meta_native_action' ? metaCampaign : googleArgs) =>
    service.call('amcp_campaign', {action: 'validate_provider', gateway, connection_id: 'c', arguments: args}, owner);
  const claims = () => store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n;
  return {store, service, requests, audit, validate, claims, close: () => store.close()};
}

test('provider validation is refused in a read-only deployment without the owner opt-in, and nothing is sent', async () => {
  const f = fixture({policy: {allowWrites: false}});
  try {
    const r = await f.validate();
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'LIVE_WRITES_DISABLED', JSON.stringify(r.error));
    assert.equal(f.requests.length, 0);
    assert.equal(
      f.audit().some(e => e.event === 'provider_validation_started'),
      false,
    );
  } finally {
    f.close();
  }
});

test('the owner opt-in allows validation in a read-only deployment, audited before it is sent', async () => {
  const f = fixture({policy: {allowWrites: false, providerValidation: true}});
  try {
    const r = await f.validate();
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
    assert.equal(r.data.status, 'provider_validated');
    assert.equal(r.data.executed, false);
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.parse(f.requests[0].body).validateOnly, true);
    assert.ok(f.requests[0].audited.includes('provider_validation_started'), 'the start is audited before the send');
    const started = f.audit().find(e => e.event === 'provider_validation_started');
    assert.equal(started.deployment_writes_enabled, false);
    assert.equal(f.claims(), 0);
  } finally {
    f.close();
  }
});

test('provider validation needs the account write grant even when writes are allowed', async () => {
  for (const policy of [{allowWrites: true}, {allowWrites: false, providerValidation: true}]) {
    const f = fixture({grant: false, policy});
    try {
      const r = await f.validate();
      assert.equal(r.error?.code, 'WRITE_ACCOUNT_FORBIDDEN', JSON.stringify(r).slice(0, 600));
      assert.equal(f.requests.length, 0);
    } finally {
      f.close();
    }
  }
});

test('a reviewed Meta write refuses validate_only and include_recommendations without any request', async () => {
  const f = fixture({gateway: 'meta_native_action'});
  try {
    for (const options of [['validate_only'], '["include_recommendations"]', 'validate_only']) {
      const r = await f.service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: 'meta_native_action',
          connection_id: 'c',
          arguments: {...metaCampaign, payload: {...metaCampaign.payload, execution_options: options}},
        },
        owner,
      );
      assert.equal(r.error?.code, 'WRITE_CONTRACT_UNAVAILABLE', JSON.stringify(r).slice(0, 600));
      assert.equal(r.error.details.field, 'execution_options');
      assert.match(r.error.message, /validate_provider/);
    }
    assert.equal(f.requests.length, 0);
    assert.equal(f.claims(), 0);
    // Other execution options are not validation, and are not refused by this rule.
    const inspect = await f.service.call(
      'amcp_write',
      {
        action: 'inspect',
        gateway: 'meta_native_action',
        arguments: {
          ...metaCampaign,
          payload: {...metaCampaign.payload, execution_options: ['synchronous_ad_review']},
        },
      },
      owner,
    );
    assert.equal(inspect.data.review_contract_supported, true, JSON.stringify(inspect).slice(0, 600));
  } finally {
    f.close();
  }
});

test('Meta provider validation validates a campaign without a review or claim, and reports a rejection', async () => {
  const ok = fixture({gateway: 'meta_native_action'});
  try {
    const r = await ok.validate();
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
    assert.equal(r.data.status, 'provider_validated');
    assert.equal(r.data.objects_created, false);
    const sent = ok.requests.find(x => x.method === 'POST');
    assert.equal(sent.path, '/v26.0/act_123/campaigns');
    assert.deepEqual(JSON.parse(new URLSearchParams(String(sent.body)).get('execution_options')), ['validate_only']);
    assert.equal(ok.claims(), 0);
    assert.equal(ok.store.documents(owner.tenantId, 'write_review').length, 0);
  } finally {
    ok.close();
  }
  const rejected = fixture({
    gateway: 'meta_native_action',
    reply: () =>
      Response.json(
        {error: {message: 'Invalid parameter', code: 100, error_data: {blame_field_specs: [['objective']]}}},
        {status: 400},
      ),
  });
  try {
    const r = await rejected.validate();
    assert.equal(r.error.code, 'PROVIDER_VALIDATION_FAILED', JSON.stringify(r.error));
    assert.deepEqual(r.error.details.field_paths, ['objective']);
    assert.equal(r.error.details.http_status, 400);
    assert.equal(rejected.claims(), 0);
    assert.ok(rejected.audit().some(e => e.event === 'provider_validation_failed'));
  } finally {
    rejected.close();
  }
});

test('a Google provider_check rejection appears in the review and execute refuses it until prepared again', async () => {
  const f = googleBudgetFixture();
  try {
    let reject = true;
    f.hooks.respond = body => {
      if (!body.validateOnly) return undefined;
      if (!reject) return Response.json({results: [{}]});
      return Response.json(
        {
          error: {
            code: 400,
            message: 'Request contains an invalid argument.',
            details: [
              {
                errors: [
                  {
                    message: 'Too low.',
                    location: {
                      fieldPathElements: [
                        {fieldName: 'operations', index: 0},
                        {fieldName: 'update'},
                        {fieldName: 'amount_micros'},
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
        {status: 400},
      );
    };
    const applied = () => f.writes.filter(w => !w.validateOnly).length;
    const prepare = () =>
      f.write({
        action: 'prepare',
        gateway: 'google_ads_native_action',
        connection_id: 'g',
        provider_check: true,
        arguments: {
          action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
          account_id: '123',
          payload: {
            operations: [
              {update: {resourceName: budgetName(1), amountMicros: '100000000'}, updateMask: 'amount_micros'},
            ],
          },
        },
      });
    const review = await prepare();
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 800));
    assert.equal(review.data.provider_check.status, 'provider_rejected');
    assert.deepEqual(review.data.provider_check.field_paths, ['operations[0].update.amount_micros']);
    assert.equal(f.writes.length, 1, 'one validation request');
    assert.ok(f.audit().some(e => e.event === 'provider_validation_started'));
    const refused = await f.execute(review.data.review_id);
    assert.equal(refused.error.code, 'PROVIDER_VALIDATION_FAILED', JSON.stringify(refused.error));
    assert.deepEqual(refused.error.details.field_paths, ['operations[0].update.amount_micros']);
    assert.equal(applied(), 0);
    assert.equal(f.claim(review.data.review_id), undefined);
    // Prepared again once the provider accepts it, the review executes.
    reject = false;
    const again = await prepare();
    assert.equal(again.data.provider_check.status, 'provider_validated');
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    assert.equal(applied(), 1);
  } finally {
    f.close();
  }
});

test('a lost validation reply is reported as unanswered, not as a write whose outcome is uncertain', async () => {
  const f = fixture({
    reply: () => {
      throw new TypeError('synthetic connection reset');
    },
  });
  try {
    const r = await f.validate();
    assert.equal(r.error?.code, 'UPSTREAM_UNAVAILABLE', JSON.stringify(r).slice(0, 600));
    assert.equal(r.error.details.validation_only, true);
    assert.ok(f.audit().some(e => e.event === 'provider_validation_started'));
    assert.equal(f.claims(), 0);
    assert.equal(f.store.documents(owner.tenantId, 'provider_validation').length, 0);
  } finally {
    f.close();
  }
});

test('an expired provider_check review prepares again with provider_check', async () => {
  const f = googleBudgetFixture();
  try {
    const review = await f.write({
      action: 'prepare',
      gateway: 'google_ads_native_action',
      connection_id: 'g',
      provider_check: true,
      arguments: {
        action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
        account_id: '123',
        payload: {
          operations: [{update: {resourceName: budgetName(1), amountMicros: '95000000'}, updateMask: 'amount_micros'}],
        },
      },
    });
    assert.equal(review.data.provider_check.status, 'provider_validated', JSON.stringify(review).slice(0, 600));
    const stored = f.store.document(f.actor.tenantId, 'write_review', review.data.review_id);
    f.store.putDocument(f.actor.tenantId, 'write_review', review.data.review_id, {...stored, expires_at: Date.now() - 1});
    const expired = await f.execute(review.data.review_id);
    assert.equal(expired.error.code, 'REVIEW_EXPIRED', JSON.stringify(expired.error));
    assert.equal(expired.error.details.next_call.arguments.provider_check, true);
  } finally {
    f.close();
  }
});

test('AMCP_PROVIDER_VALIDATION must be true or false, so an ambiguous opt-in is never guessed', async () => {
  const {execFile} = await import('node:child_process');
  const runtime = new URL('../dist/server/runtime.js', import.meta.url).href;
  const script = `const {createRuntime}=await import(${JSON.stringify(runtime)});createRuntime();process.stdout.write("started");`;
  const result = await new Promise(resolve =>
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      {env: {...process.env, MIRROR_ALLOW_WRITES: 'false', AMCP_PROVIDER_VALIDATION: 'yes'}, timeout: 20000},
      (error, stdout, stderr) => resolve({started: !error && stdout === 'started', stderr: String(stderr)}),
    ),
  );
  assert.equal(result.started, false);
  assert.match(result.stderr, /AMCP_PROVIDER_VALIDATION must be true or false/);
});

test('provider_check is refused on a route without a validation path and at execute', async () => {
  const f = googleBudgetFixture();
  try {
    const unsupported = await f.write({
      action: 'prepare',
      gateway: 'google_ads_native_action',
      connection_id: 'g',
      provider_check: true,
      arguments: {
        action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
        account_id: '123',
        payload: {operations: [{remove: budgetName(1)}]},
      },
    });
    // A remove is a mutate request too: it is supported. An execute with the flag is not.
    assert.equal(unsupported.success, true, JSON.stringify(unsupported).slice(0, 400));
    const atExecute = await f.write({
      action: 'execute',
      review_id: unsupported.data.review_id,
      confirmed: true,
      provider_check: true,
    });
    assert.equal(atExecute.error.code, 'INVALID_ARGUMENT');
    assert.equal(atExecute.error.details.field, 'provider_check');
  } finally {
    f.close();
  }
  const meta = fixture({gateway: 'meta_native_action'});
  try {
    const r = await meta.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'meta_native_action',
        connection_id: 'c',
        provider_check: true,
        arguments: {action: 'meta_ad_account_id_adlabels_create', account_id: '123', payload: {name: 'Label'}},
      },
      owner,
    );
    assert.equal(r.success, false);
    assert.equal(meta.requests.length, 0, 'refused before any read: ' + JSON.stringify(r.error).slice(0, 300));
  } finally {
    meta.close();
  }
});
