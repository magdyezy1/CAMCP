import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Compiler} from '../src/compiler.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {applyExecutionRisk} from '../src/execution-risk.js';
import {googleAccessKind, googleAccessOutcome, readGoogleAccessState} from '../src/google-user-access.js';
import {MirrorError} from '../src/errors.js';
import {removeTestDirectory} from './temp.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const gateway = 'google_ads_native_action',
  registry = new Registry(),
  compiler = new Compiler(registry),
  key = Buffer.alloc(32, 104).toString('base64'),
  id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const actor: Actor = {tenantId: 'google-access', userId: 'admin', role: 'admin'},
  memberRpc = 'google_ads_v23_customer_user_access_mutate_customer_user_access',
  inviteRpc = 'google_ads_v23_customer_user_access_invitation_mutate_customer_user_access_invitation';
const rn = (n = '20', kind = 'customerUserAccesses') => 'customers/123/' + kind + '/' + n,
  inv = (n = '30') => rn(n, 'customerUserAccessInvitations');
const update = (role = 'READ_ONLY') => ({
  action: memberRpc,
  account_id: '123',
  connection_id: id,
  payload: {operation: {update: {resourceName: rn(), accessRole: role}, updateMask: 'accessRole'}},
});
const invitation = (email = 'new@example.test', role = 'STANDARD') => ({
  action: inviteRpc,
  account_id: '123',
  connection_id: id,
  payload: {operation: {create: {emailAddress: email, accessRole: role}}},
});
const remove = (name = rn(), invite = false) => ({
  action: invite ? inviteRpc : memberRpc,
  account_id: '123',
  connection_id: id,
  payload: {operation: {remove: name}},
});
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    c: Connection = {
      id,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Selected synthetic login',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    calls: JsonObject[] = [],
    customer: JsonObject = {id: '123', currencyCode: 'USD', timeZone: 'UTC'};
  if (!store.listConnections(actor.tenantId).length) store.putConnection(actor, c, {accessToken: 'synthetic-access'});
  const members = new Map<string, JsonObject>(
    [
      ['10', 'ADMIN'],
      ['11', 'ADMIN'],
      ['20', 'STANDARD'],
    ].map(([n, role]) => [
      rn(n),
      {resourceName: rn(n), userId: n, emailAddress: 'user' + n + '@example.test', accessRole: role},
    ]),
  );
  const invitations = new Map<string, JsonObject>([
    [
      inv(),
      {
        resourceName: inv(),
        invitationId: '30',
        emailAddress: 'pending@example.test',
        accessRole: 'READ_ONLY',
        invitationStatus: 'PENDING',
      },
    ],
  ]);
  let mode = 'success',
    reads = 0,
    hook: ((kind: string) => void) | undefined,
    gate: Promise<void> | undefined,
    entered: (() => void) | undefined;
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>(r => (release = r));
    const ready = new Promise<void>(r => (entered = r));
    return {release, ready};
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        body = JSON.parse(String(init?.body));
      calls.push({path: u.pathname, body, headers: init?.headers});
      assert.equal(u.origin, 'https://googleads.googleapis.com');
      assert.equal(init?.method, 'POST');
      if (u.pathname.endsWith('/googleAds:search')) {
        reads++;
        const kind = / FROM ([a-z_]+)/.exec(body.query)![1]!;
        hook?.(kind);
        if (mode === 'denied') return Response.json({error: {message: 'Synthetic denied'}}, {status: 403});
        if (mode === 'unknown') return Response.json({unknown: []});
        if (mode === 'partial') return Response.json({partialFailureError: {code: 3}});
        let rows =
          kind === 'customer'
            ? [{...customer}]
            : [...(kind === 'customer_user_access' ? members : invitations).values()].map(row => ({...row}));
        if (kind !== 'customer') {
          if (mode === 'duplicate') rows = [...rows, ...rows];
          if (mode === 'foreign')
            rows = rows.map(r => ({...r, resourceName: r.resourceName.replace('customers/123/', 'customers/999/')}));
          if (mode === 'missing_id') rows = rows.map(r => ({...r, userId: undefined, invitationId: undefined}));
          if (mode === 'moving' && reads > 3) rows = rows.map(r => ({...r, accessRole: 'READ_ONLY'}));
          if (mode === 'telemetry')
            rows = rows.reverse().map(r => ({
              ...r,
              ...(kind === 'customer_user_access'
                ? {accessCreationDateTime: String(reads), inviterUserEmailAddress: 'different@example.test'}
                : {creationDateTime: String(reads)}),
            }));
        }
        const total = rows.length;
        let next: string | undefined;
        if (mode === 'pages' && kind !== 'customer') {
          const at = Number(body.pageToken ?? 0);
          rows = rows.slice(at, at + 1);
          if (at + 1 < total) next = String(at + 1);
        }
        if (mode === 'loop' && kind !== 'customer') next = 'same';
        const field = kind.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
        return Response.json({
          results: rows.map(r => ({[field]: r})),
          queryResourceConsumption: String(reads),
          requestId: 'changing-' + reads,
          ...(next ? {nextPageToken: next} : {}),
          ...(mode === 'count' ? {totalResultsCount: '999'} : {}),
        });
      }
      assert.ok(
        u.pathname.endsWith('/customerUserAccesses:mutate') ||
          u.pathname.endsWith('/customerUserAccessInvitations:mutate'),
      );
      assert.equal(body.operations, undefined);
      const op = body.operation;
      entered?.();
      if (gate) await gate;
      const isInvite = u.pathname.includes('Invitations'),
        target = op.create ? inv('40') : (op.remove ?? op.update.resourceName),
        map = isInvite ? invitations : members;
      if (mode !== 'ignored') {
        if (op.create)
          map.set(target, {
            resourceName: target,
            invitationId: '40',
            emailAddress: op.create.emailAddress.toLowerCase(),
            accessRole: op.create.accessRole,
            invitationStatus: 'PENDING',
          });
        else if (op.remove) map.delete(target);
        else if (mode === 'mpa')
          map.get(target)!.pendingMultiPartyAuthReview = 'customers/123/multiPartyAuthReviews/70';
        else map.get(target)!.accessRole = op.update.accessRole;
      }
      if (mode === 'lost') throw Error('Synthetic lost response');
      if (mode === 'empty_receipt') return Response.json({});
      if (mode === 'foreign_receipt')
        return Response.json({result: {resourceName: target.replace('customers/123/', 'customers/999/')}});
      if (mode === 'partial_receipt')
        return Response.json({result: {resourceName: target}, partialFailureError: {code: 3}});
      if (mode === 'old_receipt') return Response.json({result: {resourceName: inv()}});
      return Response.json({
        result: {
          resourceName: target,
          ...(mode === 'mpa' ? {multiPartyAuthReview: 'customers/123/multiPartyAuthReviews/70'} : {}),
        },
      });
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, strictOptions, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (args: JsonObject = update(), a = actor) =>
      service.call('amcp_write', {action: 'prepare', gateway, arguments: args}, a),
    execute = (r: JsonObject, a = actor) =>
      service.call(
        'amcp_write',
        {action: 'execute', review_id: r.data.review_id, idempotency_key: r.data.idempotency_key, confirmed: true},
        a,
      ),
    verify = (r: JsonObject, a = actor) => service.verifyWrite(a, r.data.review_id);
  return {
    store,
    c,
    calls,
    customer,
    members,
    invitations,
    service,
    prepare,
    execute,
    verify,
    hold,
    setMode: (s: string) => (mode = s),
    setHook: (h: typeof hook) => (hook = h),
    writes: () => calls.filter(c => !c.path.endsWith('/googleAds:search')),
  };
}
test('Google single-operation invitation, role update, access removal and revocation verify independent membership', async () => {
  for (const args of [invitation(), update(), remove(), remove(inv(), true)]) {
    const f = fixture();
    try {
      const prepared = await f.prepare(args);
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      assert.match(prepared.data.creative_impact.policy, /administrator/);
      const result = await f.execute(prepared);
      assert.equal(result.success, true, JSON.stringify(result));
      const verified = await f.verify(prepared);
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.equal(f.writes().length, 1);
      if (args.action === inviteRpc && (args.payload.operation as JsonObject).create) {
        assert.equal(verified.checks[0].invitation_sent, true);
        assert.equal(verified.checks[0].access_granted, false);
      }
      assert.equal((await f.execute(prepared)).data.replayed, true);
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('legacy create, update and remove use native singular operations with the same reviewed contract', async () => {
  for (const [action, payload] of [
    [
      'CREATE_CUSTOMER_USER_ACCESS_INVITATION',
      {resource: {email_address: 'another@example.test', access_role: 'READ_ONLY'}},
    ],
    [
      'UPDATE_CUSTOMER_USER_ACCESS',
      {resource: {resource_name: rn(), access_role: 'READ_ONLY'}, update_mask: 'access_role'},
    ],
    ['REMOVE_CUSTOMER_USER_ACCESS', {resource_name: rn()}],
    ['REMOVE_CUSTOMER_USER_ACCESS_INVITATION', {resource_name: inv()}],
  ]) {
    const f = fixture();
    try {
      const args = {action, account_id: '123', payload};
      const p = await f.prepare(args);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).success, true);
      assert.equal((await f.verify(p)).status, 'verified');
      assert.ok(f.writes()[0]!.body.operation);
    } finally {
      f.store.close();
    }
  }
});
test('native and legacy aliases cannot disguise another operation, batch, scope or mutable field', async () => {
  const f = fixture();
  try {
    const invalid = [
      {...update(), payload: {operations: [update().payload.operation]}},
      {...update(), payload: {operation: update().payload.operation, validateOnly: false}},
      {...update(), payload: {operation: update().payload.operation, partialFailure: false}},
      {...invitation(), action: 'CREATE_CUSTOMER_USER_ACCESS_INVITATION', payload: {operation: {remove: inv()}}},
      {...update(), payload: {operation: {create: {emailAddress: 'x@example.test', accessRole: 'READ_ONLY'}}}},
      {
        ...invitation(),
        payload: {operation: {update: {resourceName: inv(), accessRole: 'ADMIN'}, updateMask: 'accessRole'}},
      },
      {
        ...update(),
        payload: {
          operation: {
            update: {resourceName: rn().replace('/123/', '/999/'), accessRole: 'ADMIN'},
            updateMask: 'accessRole',
          },
        },
      },
      {
        ...update(),
        payload: {
          operation: {update: {resourceName: rn(), emailAddress: 'x@example.test'}, updateMask: 'emailAddress'},
        },
      },
      {
        ...update(),
        payload: {
          operation: {update: {resourceName: rn(), accessRole: 'ADMIN'}, updateMask: 'accessRole,emailAddress'},
        },
      },
      invitation('bad\0@example.test'),
      invitation('Name <user@example.test>'),
      invitation('a@example.test,b@example.test'),
      invitation('x@example.test', 'UNKNOWN'),
    ];
    for (const args of invalid) {
      assert.equal((await f.prepare(args)).success, false, JSON.stringify(args));
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('workspace administrators, exact write grants, selected connection and Ads scope are checked before reads', async () => {
  const f = fixture();
  try {
    assert.equal((await f.prepare(update(), {...actor, role: 'operator'})).error.code, 'ADMIN_REQUIRED');
    assert.equal((await f.prepare(update(), {...actor, testAccount: true})).error.code, 'ADMIN_REQUIRED');
    assert.equal((await f.prepare(update(), {...actor, tenantId: 'elsewhere'})).success, false);
    f.store.putConnection(actor, {...f.c, writeAccounts: []}, {accessToken: 'synthetic-access'});
    assert.equal((await f.prepare()).error.code, 'WRITE_ACCOUNT_FORBIDDEN');
    f.store.putConnection(actor, {...f.c, scopes: []}, {accessToken: 'synthetic-access'});
    assert.equal((await f.prepare()).error.code, 'INSUFFICIENT_SCOPE');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('current membership changes conflict while telemetry, creation timestamps and list order do not', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    f.setMode('telemetry');
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).status, 'verified');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare();
    g.members.get(rn('11'))!.accessRole = 'STANDARD';
    const r = await g.execute(p);
    assert.equal(r.error.code, 'STATE_CHANGED', JSON.stringify(r));
    assert.ok(r.error.details.changed_fields.some((p: string) => p.includes('accessRole')));
    assert.equal(g.writes().length, 0);
  } finally {
    g.store.close();
  }
});
test('deleting or accepting an invitation after preparation preserves concurrency diagnostics', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(remove(inv(), true));
    f.invitations.delete(inv());
    const r = await f.execute(p);
    assert.equal(r.error.code, 'STATE_CHANGED', JSON.stringify(r));
    assert.ok(r.error.details.changed_fields.some((p: string) => p.includes('invitations')));
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('new/increased access and removal/demotion obey the current owner policy at both stages', async () => {
  for (const [args, policy, code] of [
    [invitation(), {allow_activation: false}, 'POLICY_ACTIVATION_FORBIDDEN'],
    [update('ADMIN'), {allow_activation: false}, 'POLICY_ACTIVATION_FORBIDDEN'],
    [update(), {allow_deletion: false}, 'POLICY_DELETION_FORBIDDEN'],
    [remove(), {allow_deletion: false}, 'POLICY_DELETION_FORBIDDEN'],
    [remove(inv(), true), {allow_deletion: false}, 'POLICY_DELETION_FORBIDDEN'],
  ] as [JsonObject, JsonObject, string][]) {
    const f = fixture();
    try {
      const p = await f.prepare(args);
      assert.equal(p.success, true, JSON.stringify(p));
      saveSpendPolicy(f.store, actor, {gateway, account_id: '123', confirmed: true, policy});
      assert.equal((await f.execute(p)).error.code, code);
      assert.equal((await f.prepare(args)).error.code, code);
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('duplicate invitations, existing recipients, no-op roles and nonpending revocations are refused', async () => {
  const f = fixture();
  try {
    for (const args of [
      invitation('pending@example.test'),
      invitation('USER20@example.test'),
      update('STANDARD'),
      remove(rn('999')),
    ])
      assert.equal((await f.prepare(args)).error.code, 'INVALID_GOOGLE_ACCESS');
    f.invitations.get(inv())!.invitationStatus = 'EXPIRED';
    assert.equal((await f.prepare(remove(inv(), true))).error.code, 'INVALID_GOOGLE_ACCESS');
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('manager changes and last-direct-admin removal or demotion require a separate recovery contract', async () => {
  const f = fixture();
  try {
    f.customer.manager = true;
    assert.equal((await f.prepare()).error.code, 'GOOGLE_ACCESS_STATE_UNVERIFIED');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    g.members.delete(rn('11'));
    for (const op of [
      {remove: rn('10')},
      {update: {resourceName: rn('10'), accessRole: 'STANDARD'}, updateMask: 'accessRole'},
    ])
      assert.equal((await g.prepare({...update(), payload: {operation: op}})).error.code, 'INVALID_GOOGLE_ACCESS');
    assert.equal(g.writes().length, 0);
  } finally {
    g.store.close();
  }
});
test('complete paging and native membership counts are verified independently of query cost', async () => {
  const f = fixture();
  try {
    f.setMode('pages');
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(Object.keys(p.data.before_state[0].members).length, 3);
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).status, 'verified');
    assert.ok(f.calls.some(c => c.body.pageToken === '1'));
  } finally {
    f.store.close();
  }
});
test('failed, incomplete, foreign, repeated, changing and unknown membership results do not authorize execution', async () => {
  for (const mode of [
    'denied',
    'unknown',
    'partial',
    'foreign',
    'duplicate',
    'missing_id',
    'moving',
    'loop',
    'count',
  ]) {
    const f = fixture();
    try {
      f.setMode(mode);
      assert.equal((await f.prepare()).success, false, mode);
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('pending multi-party authorization is never confused with applied access', async () => {
  const f = fixture();
  try {
    f.members.get(rn())!.pendingMultiPartyAuthReview = 'customers/123/multiPartyAuthReviews/70';
    assert.equal((await f.prepare()).error.code, 'INVALID_GOOGLE_ACCESS');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare(update('ADMIN'));
    g.setMode('mpa');
    assert.equal((await g.execute(p)).success, true);
    const r = await g.verify(p);
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.checks[0].pending_multi_party_auth_review, 'customers/123/multiPartyAuthReviews/70');
    assert.ok(r.checks[0].changed_fields.some((p: string) => p.includes('accessRole')));
    assert.equal(g.writes().length, 1);
  } finally {
    g.store.close();
  }
});
test('an accepted invitation can change email and cannot be inferred from membership or disappearance', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(invitation());
    assert.equal((await f.execute(p)).success, true);
    f.invitations.delete(inv('40'));
    f.members.set(rn('50'), {
      resourceName: rn('50'),
      userId: '50',
      emailAddress: 'different-accepting-account@example.test',
      accessRole: 'STANDARD',
    });
    const r = await f.verify(p);
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.checks[0].access_granted, false);
    assert.equal(r.checks[0].invitation_sent, false);
    assert.equal(f.writes().length, 1);
  } finally {
    f.store.close();
  }
});
test('native ignored mutations and changed invitee roles remain inconclusive', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    f.setMode('ignored');
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.verify(p)).status, 'inconclusive');
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const p = await g.prepare(invitation());
    await g.execute(p);
    g.invitations.get(inv('40'))!.accessRole = 'ADMIN';
    const r = await g.verify(p);
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.checks[0].access_granted, false);
  } finally {
    g.store.close();
  }
});
test('in-flight grant, scope and administrator revocations prevent submission and read-back', async () => {
  for (const mode of ['grant', 'scope', 'actor']) {
    const f = fixture();
    try {
      f.setHook(kind => {
        if (kind === 'customer_user_access') {
          if (mode === 'actor')
            f.store.bindActorCheck(actor, () => {
              throw new MirrorError('MEMBERSHIP_REVOKED', 'Synthetic revoked membership');
            });
          else
            f.store.putConnection(
              actor,
              {...f.c, ...(mode === 'grant' ? {writeAccounts: []} : {scopes: []})},
              {accessToken: 'synthetic-access'},
            );
        }
      });
      const r = await f.prepare();
      assert.equal(r.success, false, mode);
      assert.equal(
        r.error.code,
        mode === 'actor' ? 'MEMBERSHIP_REVOKED' : mode === 'scope' ? 'INSUFFICIENT_SCOPE' : 'WRITE_ACCOUNT_FORBIDDEN',
      );
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('uncertain and foreign receipts preserve the original claim and never resend', async () => {
  for (const mode of ['lost', 'empty_receipt', 'foreign_receipt', 'partial_receipt', 'old_receipt']) {
    const f = fixture();
    try {
      const p = await f.prepare(invitation());
      assert.equal(p.success, true, JSON.stringify(p));
      f.setMode(mode);
      const r = await f.execute(p);
      assert.equal(r.success, false, mode);
      assert.equal((await f.execute(p)).success, false, mode);
      assert.equal(f.writes().length, 1, mode);
    } finally {
      f.store.close();
    }
  }
});
test('concurrent calls and reopening SQLite submit each reviewed user change once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-google-access-')),
    file = join(dir, 'test.sqlite');
  let f = fixture(file);
  try {
    const p = await f.prepare();
    const hold = f.hold(),
      first = f.execute(p);
    await hold.ready;
    const second = await f.execute(p);
    assert.equal(second.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(second));
    hold.release();
    assert.equal((await first).success, true);
    assert.equal(f.writes().length, 1);
    f.store.close();
    f = fixture(file);
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
    removeTestDirectory(dir, 'amcp-google-access-');
  }
});
test('expired or tampered reviews and cross-actor execution cannot mutate access', async () => {
  for (const mode of ['expired', 'tampered', 'actor']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      const r = f.store.document(actor.tenantId, 'write_review', p.data.review_id);
      if (mode === 'expired')
        f.store.putDocument(actor.tenantId, 'write_review', r.id, {...r, expires_at: Date.now() - 1});
      if (mode === 'tampered') {
        r.plan.body.operation.update.accessRole = 'ADMIN';
        f.store.putDocument(actor.tenantId, 'write_review', r.id, r);
      }
      const result = await f.execute(p, mode === 'actor' ? {...actor, userId: 'other'} : actor);
      assert.equal(result.success, false);
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('native direct execution remains reviewed-only and inspect exposes admin requirements without egress', async () => {
  const f = fixture();
  try {
    const args = update(),
      inspect = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: args}, actor);
    assert.equal(inspect.data.review_contract_supported, true);
    assert.equal(inspect.data.requirements.administrator_role_required, true);
    assert.equal(f.calls.length, 0);
    const direct = await f.service.call(
      gateway,
      {...args, dry_run: false, confirmed: true, idempotency_key: 'synthetic'},
      actor,
    );
    assert.equal(direct.success, false);
    assert.equal(f.writes().length, 0);
    const p = compiler.compile(gateway, args, strictOptions);
    await assert.rejects(
      () =>
        f.service.runPlan(p, {dry_run: false, confirmed: true, idempotency_key: 'synthetic', before_state: {}}, actor),
      {code: 'WRITE_REVIEW_REQUIRED'},
    );
  } finally {
    f.store.close();
  }
});
test('singular native remove operations have destructive risk and cannot impersonate another route', () => {
  const p = compiler.compile(gateway, remove(), strictOptions);
  assert.equal(applyExecutionRisk(p).destructive, true);
  assert.equal(googleAccessKind(p), 'members');
  assert.equal(googleAccessKind({...p, origin: 'https://evil.invalid'}), undefined);
  assert.equal(googleAccessKind({...p, action: inviteRpc}), undefined);
  assert.equal(googleAccessKind({...p, path: '/v25/customers/123/campaigns:mutate'}), undefined);
  const before = [{invitations: {[inv()]: {}}}];
  assert.equal(
    googleAccessOutcome(
      compiler.compile(gateway, invitation(), strictOptions),
      {status: 200, headers: {}, data: {result: {resourceName: inv()}}},
      before,
    ),
    false,
  );
});
test('Google user access capability inventory includes all six native and legacy write rows', () => {
  const rows = actionContracts(registry).filter(r => r.family === 'google_user_access');
  assert.equal(rows.length, 6);
  assert.ok(
    rows.every(
      r =>
        r.status === 'reviewed_write_family' &&
        r.live_qualification === 'unverified' &&
        r.implementation === 'src/google-user-access.ts',
    ),
  );
});

test('pinned v23 Discovery and source-hashed protos agree on singular operations and optional authorization reviews', () => {
  const evidence = JSON.parse(readFileSync('tests/fixtures/google-user-access-v25.json', 'utf8')),
    spec = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')).document,
    s = spec.schemas;
  assert.equal(Object.keys(evidence.sources).length, 9);
  for (const source of Object.values(evidence.sources) as JsonObject[]) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.match(
      source.url,
      /^https:\/\/raw\.githubusercontent\.com\/googleapis\/googleapis\/master\/google\/ads\/googleads\/v25\//,
    );
  }
  for (const type of ['CustomerUserAccess', 'CustomerUserAccessInvitation']) {
    assert.deepEqual(Object.keys(s['GoogleAdsGoogleadsV25Services__Mutate' + type + 'Request'].properties), [
      'operation',
    ]);
    assert.deepEqual(Object.keys(s['GoogleAdsGoogleadsV25Services__Mutate' + type + 'Response'].properties), [
      'result',
    ]);
    assert.deepEqual(Object.keys(s['GoogleAdsGoogleadsV25Services__Mutate' + type + 'Result'].properties).sort(), [
      'multiPartyAuthReview',
      'resourceName',
    ]);
  }
  assert.deepEqual(
    Object.keys(evidence.enums.access_role).filter(k => !['UNKNOWN', 'UNSPECIFIED'].includes(k)),
    ['ADMIN', 'STANDARD', 'READ_ONLY', 'EMAIL_ONLY'],
  );
  assert.deepEqual(
    Object.keys(evidence.enums.access_invitation_status).filter(k => !['UNKNOWN', 'UNSPECIFIED'].includes(k)),
    ['PENDING', 'DECLINED', 'EXPIRED'],
  );
});

test('native pending-review receipts require a scoped target and never establish applied access alone', async () => {
  const p = compiler.compile(gateway, update('ADMIN'), strictOptions),
    before = [{invitations: {}}];
  for (const result of [
    {multiPartyAuthReview: 'customers/123/multiPartyAuthReviews/70'},
    {resourceName: rn(), multiPartyAuthReview: 'customers/999/multiPartyAuthReviews/70'},
    {resourceName: rn(), multiPartyAuthReview: 123},
    {resourceName: rn(), unknown: 'extra'},
  ])
    assert.equal(googleAccessOutcome(p, {status: 200, headers: {}, data: {result}}, before), false);
  assert.equal(
    googleAccessOutcome(
      p,
      {
        status: 200,
        headers: {},
        data: {result: {resourceName: rn(), multiPartyAuthReview: 'customers/123/multiPartyAuthReviews/70'}},
      },
      before,
    ),
    true,
  );
  const f = fixture();
  try {
    const r = await f.prepare(update('ADMIN'));
    f.setMode('mpa');
    assert.equal((await f.execute(r)).success, true);
    const v = await f.verify(r);
    assert.equal(v.status, 'inconclusive');
    assert.equal(v.checks[0].provider_review, 'customers/123/multiPartyAuthReviews/70');
    assert.equal((await f.execute(r)).data.replayed, true);
    assert.equal(f.writes().length, 1);
  } finally {
    f.store.close();
  }
});

test('user-access discovery enforces byte, row and monotonic deadline bounds without mutation', async t => {
  const p = compiler.compile(gateway, update(), strictOptions);
  await assert.rejects(
    () =>
      readGoogleAccessState(p, async () => ({
        status: 200,
        headers: {},
        data: {results: [], queryResourceConsumption: 'x'.repeat(2 * 1024 * 1024)},
      })),
    {code: 'GOOGLE_ACCESS_STATE_UNVERIFIED'},
  );
  await assert.rejects(
    () =>
      readGoogleAccessState(p, async () => ({
        status: 200,
        headers: {},
        data: {results: Array.from({length: 2}, () => ({customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}))},
      })),
    {code: 'GOOGLE_ACCESS_STATE_UNVERIFIED'},
  );
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  try {
    await assert.rejects(
      () =>
        readGoogleAccessState(p, async () => {
          now = 60001;
          return {status: 200, headers: {}, data: {}};
        }),
      {code: 'GOOGLE_ACCESS_STATE_UNVERIFIED'},
    );
  } finally {
    t.mock.restoreAll();
  }
});

test('scope or workspace membership revoked during verification cannot return verified access', async () => {
  for (const mode of ['scope', 'actor']) {
    const f = fixture();
    try {
      const p = await f.prepare();
      await f.execute(p);
      f.setHook(kind => {
        if (kind === 'customer_user_access') {
          if (mode === 'actor')
            f.store.bindActorCheck(actor, () => {
              throw new MirrorError('MEMBERSHIP_REVOKED', 'Synthetic revoked membership');
            });
          else f.store.putConnection(actor, {...f.c, scopes: []}, {accessToken: 'synthetic-access'});
        }
      });
      if (mode === 'actor') await assert.rejects(() => f.verify(p), {code: 'MEMBERSHIP_REVOKED'});
      else {
        const v = await f.verify(p);
        assert.notEqual(v.status, 'verified');
        assert.ok(v.checks.some((c: JsonObject) => c.code === 'INSUFFICIENT_SCOPE'));
      }
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
