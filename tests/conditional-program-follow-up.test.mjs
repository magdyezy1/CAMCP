// CON-04: a refused program read names the owner's follow-up instead of offering the same live request again, keeps a
// timestamped "not a grant" observation (owner decision D20, purged on disconnect), and a live:false check returns the
// exact requirements template. A program with no selected account points to its setup, and PROGRAM_* remedies are
// read-specific. Before this change a denial returned next_call with the identical live request, nothing survived a
// reload, live:false listed only flat input names, and PROGRAM_ACCOUNT_REQUIRED told the caller a write is prepared again.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {conditionalProgramFixture as fixture, forecast, insights} from './fixtures/conditional-program-data.mjs';
import {programObservationLifetimeMs} from '../dist/src/conditional-programs.js';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {disconnectLocalConnection} from '../dist/src/connection-disconnect.js';

const good = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
const refusal = (code, status = 403) =>
  Response.json(
    {status, ...(code ? {code} : {}), message: 'Private message from the provider ' + code},
    {status, headers: {'x-li-uuid': 'AAYz-li-uuid_01'}},
  );

test('a refused program read returns the owner action and no live retry next_call', async () => {
  for (const [workflow, requirements, reply, kind, code] of [
    ['linkedin_forecast', forecast(), () => refusal('ACCESS_DENIED'), 'request_provisioning', 'PROVIDER_ACCESS_DENIED'],
    [
      'linkedin_audience_insights',
      insights(),
      () => refusal('USER_NOT_AUTHORIZED'),
      'verify_member_role',
      'PROVIDER_ACCESS_DENIED',
    ],
    ['linkedin_forecast', forecast(), () => refusal('SOMETHING_ELSE'), 'contact_provider', 'PROVIDER_ACCESS_DENIED'],
    ['linkedin_forecast', forecast(), () => refusal('EXPIRED', 401), 'reauthorize', 'AUTH_EXPIRED'],
    [
      'dv360_advertiser',
      {},
      () => Response.json({error: {code: 403, status: 'PERMISSION_DENIED', message: 'Private'}}, {status: 403}),
      'verify_member_role',
      'PROVIDER_ACCESS_DENIED',
    ],
  ]) {
    const f = fixture();
    try {
      f.reply(reply);
      const out = good(await f.call(f.input(workflow, requirements)));
      assert.equal(out.state, 'blocked', JSON.stringify(out));
      assert.deepEqual(out.blockers, [code]);
      // The old result offered {tool:'amcp_workspace', arguments:{...input}}: the same live request again.
      assert.equal(out.next_call, null);
      assert.equal(out.retry_after_provisioning, true);
      assert.equal(out.owner_action.kind, kind, workflow + ' ' + kind);
      assert.match(out.owner_action.reference, /^https:\/\//);
      assert.equal(typeof out.owner_action.text, 'string');
      assert.doesNotMatch(out.owner_action.text, /\bwrite\b/i);
      assert.equal(out.entitlement, 'unverified');
      assert.equal(f.calls.length, 1);
      assert.doesNotMatch(JSON.stringify(out), /Private message|"Private"/);
      if (kind === 'request_provisioning' || code === 'AUTH_EXPIRED' || kind === 'contact_provider')
        assert.equal(out.native_error.provider_request_id, 'AAYz-li-uuid_01');
    } finally {
      f.close();
    }
  }
});

test('a failure that is not a refusal keeps one clearly worded retry of the same read', async () => {
  const f = fixture();
  try {
    f.reply(() => Response.json({message: 'Private provider text'}, {status: 400}));
    const out = good(await f.call(f.input()));
    assert.equal(out.state, 'unverified');
    assert.equal(out.owner_action, undefined);
    assert.match(out.retry_hint.text, /not a refusal and no cause is inferred/);
    assert.deepEqual(out.next_call, {tool: 'amcp_workspace', arguments: {...f.input(), action: 'program_check'}});
    assert.doesNotMatch(JSON.stringify(out), /Private provider text/);
  } finally {
    f.close();
  }
});

test('each live read keeps one timestamped not-a-grant observation that capabilities and live:false show (D20)', async () => {
  const f = fixture();
  try {
    f.reply(() => refusal('ACCESS_DENIED'));
    const denied = good(await f.call(f.input()));
    assert.equal(denied.workspace_documents_saved, 1);
    assert.deepEqual(denied.observation, {
      kind: 'conditional_program_observation',
      expires_at: denied.checked_at + programObservationLifetimeMs,
      grant: false,
    });
    const [stored] = f.store.documents(f.actor.tenantId, 'conditional_program_observation');
    // Allow-listed facts only: no request, response body, provider message or evidence.
    assert.deepEqual(
      Object.keys(stored)
        .filter(k => !['id', 'revision'].includes(k))
        .sort(),
      [
        'account_id',
        'amcp_request_id',
        'checked_at',
        'code',
        'connection_id',
        'expires_at',
        'gateway',
        'grant',
        'http_status',
        'meaning',
        'provider_code',
        'provider_request_id',
        'record_kind',
        'state',
        'workflow_id',
      ],
    );
    assert.equal(stored.state, 'blocked');
    assert.equal(stored.code, 'PROVIDER_ACCESS_DENIED');
    assert.equal(stored.http_status, 403);
    assert.equal(stored.provider_code, 'ACCESS_DENIED');
    assert.equal(stored.provider_request_id, 'AAYz-li-uuid_01');
    assert.equal(stored.amcp_request_id, denied.native_error.amcp_request_id);
    assert.equal(stored.grant, false);
    assert.match(stored.meaning, /not a grant/);
    assert.doesNotMatch(JSON.stringify(stored), /Private message|sponsoredAccount|targetingCriteria/);
    const graph = good(await f.call({action: 'capabilities', workflow_id: 'program:linkedin_forecast'}));
    const evidence = graph.workflows[0].accounts[0].program_evidence;
    assert.equal(evidence.status, 'unverified');
    assert.equal(evidence.last_observation.state, 'blocked');
    assert.equal(evidence.last_observation.checked_at, denied.checked_at);
    const local = good(await f.call({...f.input(), live: false}));
    assert.equal(local.last_observation.provider_request_id, 'AAYz-li-uuid_01');
    assert.equal(f.calls.length, 1);
    // The next read replaces it; a successful read is an observation too, still not a grant.
    f.reply(undefined);
    const observed = good(await f.call(f.input()));
    assert.equal(observed.state, 'observed');
    const [latest] = f.store.documents(f.actor.tenantId, 'conditional_program_observation');
    assert.equal(f.store.documents(f.actor.tenantId, 'conditional_program_observation').length, 1);
    assert.equal(latest.state, 'observed');
    assert.equal(latest.code, null);
    assert.equal(typeof latest.amcp_request_id, 'string');
    // An expired observation is not shown.
    f.store.putDocument(f.actor.tenantId, 'conditional_program_observation', 'x', {});
    const id = f.store.db
      .prepare("SELECT id FROM documents WHERE tenant_id=? AND kind='conditional_program_observation' AND id<>'x'")
      .get(f.actor.tenantId).id;
    f.store.putDocument(f.actor.tenantId, 'conditional_program_observation', id, {
      ...latest,
      expires_at: Date.now() - 1,
    });
    const expired = good(await f.call({action: 'capabilities', workflow_id: 'program:linkedin_forecast'}));
    assert.equal(expired.workflows[0].accounts[0].program_evidence.last_observation, undefined);
  } finally {
    f.close();
  }
});

test('disconnecting the login purges its program observations and keeps other logins’ observations', async () => {
  const f = fixture();
  try {
    f.reply(() => refusal('ACCESS_DENIED'));
    good(await f.call(f.input()));
    f.reply(undefined);
    good(await f.call(f.input('dv360_advertiser', {})));
    assert.equal(f.store.documents(f.actor.tenantId, 'conditional_program_observation').length, 2);
    const receipt = disconnectLocalConnection(f.store, f.owner, 'linkedin_native_action', f.connections[0].id, 'mcp');
    assert.equal(receipt.local_changes.program_observations, 1);
    assert.match(receipt.effect, /conditional-program observations/);
    const left = f.store.documents(f.actor.tenantId, 'conditional_program_observation');
    assert.deepEqual(
      left.map(o => o.connection_id),
      [f.connections[1].id],
    );
  } finally {
    f.close();
  }
});

test('live:false returns the exact requirements template and argument paths a live check needs', async () => {
  const f = fixture(),
    ajv = new Ajv({strict: false});
  try {
    for (const [workflow, requirements, paths] of [
      [
        'linkedin_forecast',
        forecast(),
        [
          'requirements.forecast',
          'requirements.request.sponsoredAccountUrn',
          'requirements.request.objectiveType',
          'requirements.request.targetingCriteria',
        ],
      ],
      [
        'linkedin_audience_insights',
        insights(),
        [
          'requirements.request.requestMetaData.sponsoredAccountUrn',
          'requirements.request.targetingCriteria',
          'requirements.request.groupBy',
        ],
      ],
      ['dv360_advertiser', {}, []],
    ]) {
      const local = good(await f.call({...f.input(workflow, requirements), live: false}));
      assert.deepEqual(local.required_inputs, ['connection_id', 'account_id', ...paths]);
      const validate = ajv.compile(local.requirements_template);
      assert.equal(validate(requirements), true, workflow + JSON.stringify(validate.errors));
      if (workflow !== 'dv360_advertiser') {
        const other = structuredClone(requirements);
        (other.request.requestMetaData ?? other.request).sponsoredAccountUrn = 'urn:li:sponsoredAccount:456';
        assert.equal(validate(other), false, 'the template fixes the selected account');
      } else assert.deepEqual(local.next_call.arguments.requirements, {});
    }
    const bad = forecast();
    bad.request.currencyCode = 'SAR';
    const local = good(await f.call({...f.input(), live: false}));
    assert.equal(ajv.compile(local.requirements_template)(bad), false);
    const graph = good(await f.call({action: 'capabilities'}));
    for (const w of graph.workflows.filter(w => w.kind === 'conditional_program'))
      assert.equal(w.requirements_template.type, 'object', w.id);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('a program with no selected account points to its setup instead of a program_check loop', async () => {
  const f = fixture();
  try {
    // A disabled DV360 login with zero advertisers, as in the reviewed dead end; then no DV360 login at all.
    f.store.putConnection(f.owner, {...f.connections[1], enabled: false, accounts: []}, {accessToken: 'synthetic'});
    for (const remove of [false, true]) {
      if (remove) disconnectLocalConnection(f.store, f.owner, 'dv360_native_action', f.connections[1].id, 'mcp');
      const graph = good(await f.call({action: 'capabilities', workflow_id: 'program:dv360_advertiser'})),
        w = graph.workflows[0];
      assert.deepEqual(w.accounts, []);
      assert.equal(w.next_call, null, 'no program_check that can only refuse');
      assert.equal(w.website_path, '/connections');
      assert.equal(w.setup.website_path, '/connections');
      assert.deepEqual(
        w.setup.prerequisites.map(p => p.id),
        ['dv360_customer_role', 'display_video_oauth_scope', 'exact_advertiser_access'],
      );
      assert.match(w.setup.prerequisites[0].text, /Admin, Standard or Read only/);
      assert.deepEqual(w.setup.then, {
        tool: 'amcp_workspace',
        arguments: {action: 'capabilities', workflow_id: 'program:dv360_advertiser'},
      });
      assert.doesNotMatch(JSON.stringify(w.setup), /\bwrite\b/i);
    }
    // LinkedIn still has an account, so its card keeps the per-account program_check.
    const linkedin = good(await f.call({action: 'capabilities', workflow_id: 'program:linkedin_forecast'}));
    assert.equal(linkedin.workflows[0].setup, undefined);
    assert.equal(linkedin.workflows[0].accounts[0].next_call.arguments.action, 'program_check');
    const missing = await f.call({action: 'program_check', workflow_id: 'program:dv360_advertiser'});
    assert.equal(missing.success, false);
    assert.equal(missing.error.code, 'PROGRAM_ACCOUNT_REQUIRED');
    assert.doesNotMatch(missing.error.next_action, /\bwrite\b|prepared again/i);
    assert.match(missing.error.next_action, /Connections page/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test('PROGRAM_* remedies are read-specific and never say a write is prepared again', () => {
  for (const code of [
    'PROGRAM_ACCOUNT_REQUIRED',
    'PROGRAM_INPUT_REQUIRED',
    'PROGRAM_EVIDENCE_INVALID',
    'PROGRAM_NOT_FOUND',
  ]) {
    const action = errorResult(new MirrorError(code, 'Fixture'), 'ref', 0).error.next_action;
    assert.equal(typeof action, 'string', code);
    assert.doesNotMatch(action, /\bwrite\b|prepared again/i, code);
  }
  assert.match(
    errorResult(new MirrorError('PROGRAM_INPUT_REQUIRED', 'Fixture'), 'ref', 0).error.next_action,
    /requirements_template/,
  );
});
