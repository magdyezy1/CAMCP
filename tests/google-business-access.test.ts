import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {DelegatedNativeCompiler} from '../src/delegated-native.js';
import {ScopeGuard} from '../src/scope.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {actionContracts} from '../src/action-contracts.js';
import {
  businessAccessKind,
  businessAccessSnapshots,
  readBusinessAccessState,
  businessAccessOutcome,
  assertBusinessAccessPolicy,
} from '../src/google-business-access.js';
import {removeTestDirectory} from './temp.js';
import type {Actor, Connection, JsonObject} from '../src/types.js';

const gateway = 'google_business_native_action',
  operation = 'gmb_account_ops',
  id = '336ecb51-2df8-4967-8bd3-cba64d552296',
  otherId = 'b9a767a2-e9a5-4863-9806-05a459367597';
const actor: Actor = {tenantId: 'business-access', userId: 'administrator', role: 'admin'},
  key = Buffer.alloc(32, 52).toString('base64'),
  registry = new Registry(),
  compiler = new DelegatedNativeCompiler();
const input = (action = 'PATCH_ACCOUNT_ADMIN', payload: JsonObject = {role: 'MANAGER'}, extra: JsonObject = {}) => ({
  operation,
  arguments: {
    action,
    ...(action.includes('LOCATION') ? {location_id: '456'} : {account_id: '123'}),
    connection_id: id,
    ...(action === 'PATCH_ACCOUNT' ? {} : action.startsWith('CREATE') ? {} : {admin_id: '20'}),
    ...(action.startsWith('DELETE') ? {} : {payload}),
    ...(action.startsWith('PATCH') ? {query: {updateMask: action === 'PATCH_ACCOUNT' ? 'accountName' : 'role'}} : {}),
    ...extra,
  },
});
function fixture(location = false, file = ':memory:') {
  const store = new Store(file, key),
    parent = location ? 'locations/456' : 'accounts/123',
    grant = location ? parent : '123',
    calls: JsonObject[] = [];
  const resource: JsonObject = location
    ? {name: parent, title: 'Synthetic Business', storeCode: 'shop'}
    : {
        name: parent,
        accountName: 'Synthetic business group',
        type: 'LOCATION_GROUP',
        role: 'PRIMARY_OWNER',
        permissionLevel: 'OWNER_LEVEL',
        verificationState: 'VERIFIED',
        vettedState: 'NOT_VETTED',
      };
  const targetGroup: JsonObject = {
    name: 'accounts/999',
    accountName: 'Selected location group',
    type: 'LOCATION_GROUP',
    role: 'OWNER',
    permissionLevel: 'OWNER_LEVEL',
  };
  const rows = new Map<string, JsonObject>([
    ['10', {name: parent + '/admins/10', admin: 'Primary Owner', role: 'PRIMARY_OWNER'}],
    ['20', {name: parent + '/admins/20', admin: 'Chosen User', role: 'OWNER'}],
    ['30', {name: parent + '/admins/30', admin: 'Another User', role: 'MANAGER'}],
  ]);
  const connection: Connection = {
    id,
    tenantId: actor.tenantId,
    gateway,
    label: 'Synthetic identity',
    enabled: true,
    accounts: [grant],
    writeAccounts: [grant],
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  };
  const provision = (change: Partial<Connection> = {}, token = 'selected-synthetic') =>
    store.putConnection(actor, {...connection, ...change}, {accessToken: token});
  if (!store.listConnections(actor.tenantId).length) provision();
  let mode = 'success',
    readCount = 0,
    nextId = 40,
    mutationEntered: (() => void) | undefined,
    mutationGate: Promise<void> | undefined;
  const hold = () => {
    let release!: () => void;
    const entered = new Promise<void>(r => (mutationEntered = r));
    mutationGate = new Promise<void>(r => (release = r));
    return {entered, release};
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname,
        method = init?.method ?? 'GET',
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({origin: u.origin, path, method, query: Object.fromEntries(u.searchParams), body});
      if (method === 'GET') {
        readCount++;
        if (mode === 'scope_revoke') provision({scopes: []});
        if (mode === 'grant_revoke') provision({accounts: ['777'], writeAccounts: ['777']});
        if (mode === 'write_revoke') provision({writeAccounts: []});
        if (mode === 'error') return Response.json({error: {code: 403, message: 'Synthetic denied'}}, {status: 403});
        if (mode === 'unknown') return Response.json({data: []});
        if (path === '/v1/accounts/999') {
          if (mode === 'group_grant_revoke') provision();
          return Response.json(targetGroup);
        }
        if (path === '/v1/' + parent) {
          assert.equal(
            u.origin,
            location
              ? 'https://mybusinessbusinessinformation.googleapis.com'
              : 'https://mybusinessaccountmanagement.googleapis.com',
          );
          if (location) assert.equal(u.searchParams.get('readMask'), 'name,title,storeCode');
          return Response.json({
            ...resource,
            ...(mode === 'wrong_identity' ? {name: location ? 'locations/999' : 'accounts/999'} : {}),
            ...(mode === 'moving' && readCount > 2 ? (location ? {title: 'Changed'} : {accountName: 'Changed'}) : {}),
          });
        }
        assert.equal(u.origin, 'https://mybusinessaccountmanagement.googleapis.com');
        assert.equal(path, '/v1/' + parent + '/admins');
        assert.equal(u.search, '');
        const values = [...rows.values()].map(v => ({...v}));
        if (mode === 'display_names') for (const row of values) row.admin = 'Mutable display ' + readCount;
        if (mode === 'reorder' && readCount % 4 === 0) values.reverse();
        return Response.json({
          [mode === 'wrong_envelope' ? (location ? 'accountAdmins' : 'admins') : location ? 'admins' : 'accountAdmins']:
            mode === 'empty' ? [] : values,
          ...(mode === 'partial' ? {nextPageToken: 'not-a-native-page'} : {}),
        });
      }
      assert.equal(u.origin, 'https://mybusinessaccountmanagement.googleapis.com');
      if (mutationGate) {
        mutationEntered!();
        await mutationGate;
      }
      let result: JsonObject;
      if (path === '/v1/' + parent) {
        assert.equal(method, 'PATCH');
        assert.equal(u.searchParams.get('updateMask'), 'accountName');
        result = {...resource, accountName: body.accountName};
        if (mode !== 'ignored') resource.accountName = body.accountName;
      } else if (method === 'POST') {
        const n = String(nextId++);
        result = {
          name: parent + '/admins/' + n,
          role: body.role,
          ...(body.account ? {account: body.account} : {admin: body.admin.toLowerCase()}),
          pendingInvitation: true,
        };
        if (mode !== 'ignored') rows.set(n, {...result});
        if (mode === 'accepted') rows.set(n, {...result, pendingInvitation: false, admin: 'Accepted display name'});
      } else if (method === 'PATCH') {
        assert.equal(u.searchParams.get('updateMask'), 'role');
        const n = path.split('/').at(-1)!;
        result = {...rows.get(n)!, role: body.role};
        if (mode !== 'ignored') rows.set(n, {...result});
      } else {
        assert.equal(method, 'DELETE');
        if (mode !== 'ignored') rows.delete(path.split('/').at(-1)!);
        result = {};
      }
      if (mode === 'lost') throw Error('Synthetic lost mutation response');
      if (mode === 'empty_receipt') return Response.json({});
      if (mode === 'foreign_receipt') return Response.json({...result, name: 'accounts/777/admins/99'});
      if (mode === 'wrong_role') return Response.json({...result, role: 'MANAGER'});
      if (mode === 'wrong_email') return Response.json({...result, admin: 'unapproved@example.com'});
      if (mode === 'existing_receipt') return Response.json({...result, name: parent + '/admins/20'});
      if (mode === 'unidentified_acceptance')
        return Response.json({...result, pendingInvitation: false, admin: 'Unverified display name'});
      if (mode === 'partial_receipt')
        return Response.json({...result, error: {code: 403, message: 'Synthetic failed'}});
      return Response.json(result);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (request = input(location ? 'PATCH_LOCATION_ADMIN' : 'PATCH_ACCOUNT_ADMIN'), who = actor) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: request}, who);
  const execute = (prepared: JsonObject, who = actor) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      },
      who,
    );
  return {
    store,
    connection,
    resource,
    targetGroup,
    rows,
    calls,
    service,
    provision,
    grant,
    parent,
    prepare,
    execute,
    hold,
    mode: (value: string) => {
      mode = value;
    },
    writes: () => calls.filter(c => c.method !== 'GET'),
  };
}
for (const location of [false, true])
  for (const kind of ['CREATE', 'PATCH', 'DELETE'])
    test(
      kind +
        ' ' +
        (location ? 'location' : 'account') +
        ' admin follows review, one exact mutation and complete read-back',
      async () => {
        const f = fixture(location);
        try {
          const action = kind + '_' + (location ? 'LOCATION' : 'ACCOUNT') + '_ADMIN',
            p = await f.prepare(
              input(action, kind === 'CREATE' ? {admin: 'Invitee@Example.com', role: 'OWNER'} : {role: 'MANAGER'}),
            );
          assert.equal(p.success, true, JSON.stringify(p));
          assert.equal(p.data.confirmation_required, true);
          assert.equal(f.writes().length, 0);
          assert.equal(p.data.before_state[0].admins[f.parent + '/admins/20'].invitee_email, null);
          const out = await f.execute(p);
          assert.equal(out.success, true, JSON.stringify(out));
          assert.equal(f.writes().length, 1);
          const replay = await f.execute(p);
          assert.equal(replay.success, true, JSON.stringify(replay));
          assert.equal(f.writes().length, 1);
          const v = await f.service.verifyWrite(actor, p.data.review_id);
          assert.equal(v.status, 'verified', JSON.stringify(v));
          if (kind === 'CREATE') {
            assert.equal(v.checks[0].invitation_status, 'pending_acceptance');
            assert.equal(v.checks[0].access_granted, false);
          }
          assert.equal(f.store.verifyAudit(), true);
        } finally {
          f.store.close();
        }
      },
    );
test('account renaming uses its sole mutable field without false spend confirmation from the name', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(input('PATCH_ACCOUNT', {accountName: 'Budget owners group'}));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.previous_account_name, 'Synthetic business group');
    assert.equal((await f.execute(p)).success, true);
    assert.equal(f.resource.accountName, 'Budget owners group');
    assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
    assert.equal(f.writes().length, 1);
  } finally {
    f.store.close();
  }
});
test('LocationGroup invitations require the exact additional read grant and native group type', async () => {
  for (const mode of ['success', 'missing_grant', 'wrong_type']) {
    const f = fixture(true);
    try {
      if (mode !== 'missing_grant') f.provision({accounts: [f.grant, '999']});
      if (mode === 'wrong_type') f.targetGroup.type = 'PERSONAL';
      const p = await f.prepare(input('CREATE_LOCATION_ADMIN', {account: 'accounts/999', role: 'MANAGER'}));
      assert.equal(p.success, mode === 'success', JSON.stringify(p));
      if (mode === 'success') {
        assert.equal(p.data.before_state[0].invitee_group.name, 'accounts/999');
        assert.equal((await f.execute(p)).success, true);
        assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
      } else assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('invitation acceptance during read-back is tied to its previously verified email receipt and native ID', async () => {
  const f = fixture(true);
  try {
    f.mode('accepted');
    const p = await f.prepare(input('CREATE_LOCATION_ADMIN', {admin: 'invitee@example.com', role: 'MANAGER'}));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    const v = await f.service.verifyWrite(actor, p.data.review_id);
    assert.equal(v.status, 'verified', JSON.stringify(v));
    assert.equal(v.checks[0].invitation_status, 'accepted');
    assert.equal(v.checks[0].access_granted, true);
  } finally {
    f.store.close();
  }
});
test('acceptance cannot hide a changed role, group binding or unrelated membership', async () => {
  for (const changed of [{role: 'OWNER'}, {account: 'accounts/777'}, {other: true}]) {
    const f = fixture(true);
    try {
      const p = await f.prepare(input('CREATE_LOCATION_ADMIN', {admin: 'invitee@example.com', role: 'MANAGER'}));
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).success, true);
      Object.assign(
        f.rows.get('40')!,
        {pendingInvitation: false, admin: 'Accepted display name'},
        changed.other ? {} : changed,
      );
      if (changed.other) f.rows.get('30')!.role = 'OWNER';
      const v = await f.service.verifyWrite(actor, p.data.review_id);
      assert.equal(v.status, 'inconclusive', JSON.stringify(v));
      assert.equal(v.checks[0].access_granted, false);
      assert.equal(v.verified_resources, undefined);
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('location-only native roles and pending invitations retain exact role and principal transitions', async () => {
  for (const kind of ['CREATE', 'PATCH', 'DELETE']) {
    const f = fixture(true);
    try {
      Object.assign(f.rows.get('20')!, {pendingInvitation: true, admin: 'pending@example.com'});
      const p = await f.prepare(
        input(
          kind + '_LOCATION_ADMIN',
          kind === 'CREATE' ? {admin: 'new@example.com', role: 'SITE_MANAGER'} : {role: 'SITE_MANAGER'},
        ),
      );
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).success, true);
      assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('revoking the separately scoped invitee group during its prerequisite read prevents the invitation', async () => {
  const f = fixture(true);
  try {
    f.provision({accounts: [f.grant, '999']});
    f.mode('group_grant_revoke');
    const p = await f.prepare(input('CREATE_LOCATION_ADMIN', {account: 'accounts/999', role: 'MANAGER'}));
    assert.equal(p.success, false, JSON.stringify(p));
    assert.equal(f.calls.length, 3);
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('membership snapshots reject more than 1000 admins and normalize omitted native default fields', async () => {
  const f = fixture();
  try {
    Object.assign(f.rows.get('20')!, {admin: '', account: '', pendingInvitation: false});
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.before_state[0].admins[f.parent + '/admins/20'].account, null);
    assert.equal((await f.execute(p)).success, true);
    assert.equal((await f.service.verifyWrite(actor, p.data.review_id)).status, 'verified');
    for (let i = 31; i <= 1028; i++) f.rows.set(String(i), {name: f.parent + '/admins/' + i, role: 'MANAGER'});
    assert.equal(f.rows.size, 1001);
    const rejected = await f.prepare();
    assert.equal(rejected.success, false);
    assert.equal(rejected.error.code, 'BUSINESS_ACCESS_STATE_UNVERIFIED');
    assert.equal(f.writes().length, 1);
  } finally {
    f.store.close();
  }
});
test('account and location role limits, immutable fields, masks and principals fail during inspection', async () => {
  const f = fixture();
  try {
    for (const request of [
      input('PATCH_ACCOUNT', {type: 'USER_GROUP', accountName: 'New'}),
      input('PATCH_ACCOUNT', {accountName: ''}),
      input('PATCH_ACCOUNT', {accountName: 'New'}, {query: {updateMask: 'accountName', validateOnly: true}}),
      input('PATCH_ACCOUNT_ADMIN', {role: 'PRIMARY_OWNER'}),
      input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'SITE_MANAGER'}),
      input('CREATE_ACCOUNT_ADMIN', {account: 'accounts/999', role: 'OWNER'}),
      input('CREATE_LOCATION_ADMIN', {admin: 'new@example.com', account: 'accounts/999', role: 'OWNER'}),
      input('CREATE_ACCOUNT_ADMIN', {admin: 'Display Name <new@example.com>', role: 'OWNER'}),
      input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'OWNER', pendingInvitation: false}),
      input('PATCH_ACCOUNT_ADMIN', {name: 'accounts/123/admins/99', role: 'MANAGER'}),
      input('PATCH_ACCOUNT_ADMIN', {role: 'MANAGER', admin: 'other@example.com'}),
      input('PATCH_ACCOUNT_ADMIN', {role: 'MANAGER'}, {query: {updateMask: 'admin'}}),
    ]) {
      const out = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: request}, actor);
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.review_contract_supported, false, JSON.stringify(request));
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('primary owner, missing member, duplicate pending invite, empty and malformed memberships stay protected', async () => {
  for (const mode of [
    'primary',
    'missing',
    'duplicate',
    'empty',
    'wrong_envelope',
    'partial',
    'unknown',
    'wrong_identity',
    'moving',
  ]) {
    const f = fixture();
    try {
      if (mode === 'primary') f.rows.get('20')!.role = 'PRIMARY_OWNER';
      if (mode === 'missing') f.rows.delete('20');
      if (mode === 'duplicate')
        f.rows.set('40', {
          name: f.parent + '/admins/40',
          admin: 'new@example.com',
          role: 'OWNER',
          pendingInvitation: true,
        });
      if (['empty', 'wrong_envelope', 'partial', 'unknown', 'wrong_identity', 'moving'].includes(mode)) f.mode(mode);
      const p = await f.prepare(
        mode === 'duplicate' ? input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'MANAGER'}) : undefined,
      );
      assert.equal(p.success, false, mode + ': ' + JSON.stringify(p));
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
  for (const action of ['PATCH_ACCOUNT_ADMIN', 'DELETE_ACCOUNT_ADMIN']) {
    const f = fixture();
    try {
      const p = await f.prepare(input(action, {role: 'MANAGER'}, {admin_id: '10'}));
      assert.equal(p.success, false);
      assert.equal(p.error.code, 'INVALID_BUSINESS_ACCESS');
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('membership order and active-user display changes are not conflicts, but roles, invitations and names remain protected', async () => {
  for (const mode of ['reorder', 'display_names', 'role_change', 'invitation_change', 'account_name']) {
    const f = fixture();
    try {
      if (['reorder', 'display_names'].includes(mode)) f.mode(mode);
      const p = await f.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      if (mode === 'role_change') f.rows.get('30')!.role = 'OWNER';
      if (mode === 'invitation_change')
        Object.assign(f.rows.get('30')!, {pendingInvitation: true, admin: 'new@example.com'});
      if (mode === 'account_name') f.resource.accountName = 'Changed';
      const out = await f.execute(p);
      assert.equal(out.success, ['reorder', 'display_names'].includes(mode), JSON.stringify(out));
      if (!out.success) {
        assert.equal(out.error.code, 'STATE_CHANGED');
        assert.match(
          JSON.stringify(out.error.details.changed_fields),
          mode === 'role_change'
            ? /role/
            : mode === 'invitation_change'
              ? /pendingInvitation|invitee_email/
              : /accountName/,
        );
      }
      assert.equal(f.writes().length, out.success ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('account administration requires a current native owner and a non-personal business account', async () => {
  for (const change of [{role: 'MANAGER'}, {role: undefined}, {type: 'PERSONAL'}, {permissionLevel: 'MEMBER_LEVEL'}]) {
    const f = fixture();
    try {
      Object.assign(f.resource, change);
      const p = await f.prepare();
      assert.equal(p.success, false, JSON.stringify(p));
      assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('only current workspace administrators with this exact write grant may prepare and execute', async () => {
  for (const mode of [
    'reader',
    'operator',
    'test',
    'tenant',
    'scope',
    'read_grant',
    'write_grant',
    'scope_revoke',
    'grant_revoke',
    'write_revoke',
  ]) {
    const f = fixture();
    try {
      let who = actor;
      if (mode === 'reader' || mode === 'operator') who = {...actor, role: mode};
      if (mode === 'test') who = {...actor, testAccount: true};
      if (mode === 'tenant') who = {...actor, tenantId: 'other'};
      if (mode === 'scope') f.provision({scopes: []});
      if (mode === 'read_grant') f.provision({accounts: ['777'], writeAccounts: []});
      if (mode === 'write_grant') f.provision({writeAccounts: []});
      if (mode.endsWith('_revoke')) f.mode(mode);
      const p = await f.prepare(undefined, who);
      assert.equal(p.success, false, mode + ': ' + JSON.stringify(p));
      assert.equal(f.writes().length, 0);
      assert.equal(f.calls.length, mode.endsWith('_revoke') ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('revocation after preparation and actor downgrade block execution even when the original review was valid', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p, {...actor, role: 'operator'})).success, false);
    f.provision({writeAccounts: []});
    assert.equal((await f.execute(p)).success, false);
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('owner activation and deletion controls distinguish promotion, demotion, removal and rename', async () => {
  const cases = [
    ['create', false, true, false],
    ['promote', false, true, false],
    ['demote', true, false, false],
    ['delete', true, false, false],
    ['demote', false, true, true],
    ['rename', false, false, true],
  ] as const;
  for (const [kind, activation, deletion, allowed] of cases) {
    const f = fixture();
    try {
      saveSpendPolicy(f.store, actor, {
        gateway,
        account_id: '123',
        confirmed: true,
        policy: {allow_activation: activation, allow_deletion: deletion},
      });
      const request =
        kind === 'create'
          ? input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'OWNER'})
          : kind === 'promote'
            ? input('PATCH_ACCOUNT_ADMIN', {role: 'OWNER'}, {admin_id: '30'})
            : kind === 'delete'
              ? input('DELETE_ACCOUNT_ADMIN')
              : kind === 'rename'
                ? input('PATCH_ACCOUNT', {accountName: 'Updated'})
                : input();
      const p = await f.prepare(request);
      assert.equal(p.success, allowed, kind + ': ' + JSON.stringify(p));
      if (allowed) assert.equal((await f.execute(p)).success, true);
      else assert.equal(f.writes().length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('changed owner policy after review blocks an otherwise unchanged access increase', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'MANAGER'}));
    assert.equal(p.success, true, JSON.stringify(p));
    saveSpendPolicy(f.store, actor, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    const out = await f.execute(p);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('unrecognized, foreign, existing and ambiguous invitation receipts retain the single original submission', async () => {
  for (const mode of [
    'empty_receipt',
    'foreign_receipt',
    'wrong_role',
    'wrong_email',
    'existing_receipt',
    'unidentified_acceptance',
    'partial_receipt',
    'lost',
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'OWNER'}));
      assert.equal(p.success, true, JSON.stringify(p));
      f.mode(mode);
      const out = await f.execute(p);
      assert.equal(out.success, false, mode + ': ' + JSON.stringify(out));
      assert.equal(f.writes().length, 1);
      await f.execute(p);
      assert.equal(f.writes().length, 1);
      assert.equal(
        f.store.documents(actor.tenantId, 'write_verification').filter(v => v.status === 'verified').length,
        0,
      );
    } finally {
      f.store.close();
    }
  }
});
test('ignored account rename, invitation, role change and deletion are inconclusive without mutation retry', async () => {
  for (const request of [
    input('PATCH_ACCOUNT', {accountName: 'Updated'}),
    input('CREATE_ACCOUNT_ADMIN', {admin: 'new@example.com', role: 'OWNER'}),
    input(),
    input('DELETE_ACCOUNT_ADMIN'),
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(request);
      assert.equal(p.success, true, JSON.stringify(p));
      f.mode('ignored');
      assert.equal((await f.execute(p)).success, true);
      const out = await f.service.verifyWrite(actor, p.data.review_id);
      assert.equal(out.status, 'inconclusive', JSON.stringify(out));
      assert.equal(f.writes().length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('concurrent calls and SQLite reopen retain the original successful or uncertain mutation claim', async () => {
  for (const mode of ['success', 'lost']) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-business-access-')),
      file = join(directory, 'test.sqlite');
    let f = fixture(false, file);
    let release: (() => void) | undefined;
    try {
      const p = await f.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      f.mode(mode);
      const held = f.hold();
      release = held.release;
      const first = f.execute(p);
      await held.entered;
      const concurrent = await f.execute(p);
      assert.equal(concurrent.success, false);
      assert.equal(concurrent.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      assert.equal(f.writes().length, 1);
      held.release();
      assert.equal((await first).success, mode === 'success');
      assert.equal(f.writes().length, 1);
      f.store.close();
      f = fixture(false, file);
      const replay = await f.execute(p);
      assert.equal(replay.success, mode === 'success', JSON.stringify(replay));
      assert.equal(f.writes().length, 0);
    } finally {
      release?.();
      f.store.close();
      removeTestDirectory(directory, 'amcp-business-access-');
    }
  }
});
test('same account in another login never replaces the explicit selected identity and direct writes stay gated', async () => {
  const f = fixture();
  try {
    f.provision({id: otherId, isDefault: true, scopes: []}, 'other-synthetic');
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.request.accountId, '123');
    const native = await f.service.call(gateway, input(undefined, undefined, {dry_run: false}), actor);
    assert.equal(native.success, false);
    assert.equal(native.error.code, 'CONFIRMATION_REQUIRED');
    await assert.rejects(
      () =>
        f.service.runPlan(
          compiler.compile(gateway, input()),
          {connection_id: id, dry_run: false, confirmed: true, idempotency_key: 'forged'},
          actor,
        ),
      {code: 'WRITE_REVIEW_REQUIRED'},
    );
    assert.equal(f.writes().length, 0);
  } finally {
    f.store.close();
  }
});
test('generic friendly resource parsing rejects trailing paths without changing valid resource names', () => {
  for (const extra of [
    {account_id: 'accounts/123/extra'},
    {account_id: 'accounts/123/'},
    {account_id: '123', params: {account_id: 'accounts/123/extra'}},
  ])
    assert.throws(() => compiler.compile(gateway, input(undefined, undefined, extra)), {code: 'INVALID_RESOURCE_NAME'});
  assert.equal(compiler.compile(gateway, input(undefined, undefined, {account_id: 'accounts/123'})).accountId, '123');
  const request = {dateRanges: [{startDate: '2026-01-01', endDate: '2026-01-02'}], metrics: [{name: 'sessions'}]};
  assert.equal(
    compiler.compile('ga4_native_action', {
      operation: 'ga4_run_report',
      arguments: {property: 'properties/123', request},
    }).accountId,
    '123',
  );
  assert.throws(
    () =>
      compiler.compile('ga4_native_action', {
        operation: 'ga4_run_report',
        arguments: {property: 'properties/123/extra', request},
      }),
    {code: 'INVALID_RESOURCE_NAME'},
  );
});
test('internal prerequisite scope cannot escape native origin, method, selected grant or fixed mask', () => {
  const f = fixture(true);
  try {
    const p = compiler.compile(gateway, input('CREATE_LOCATION_ADMIN', {account: 'accounts/999', role: 'OWNER'}));
    f.provision({accounts: [f.grant, '999']});
    const c = f.store.listConnections(actor.tenantId)[0]!,
      scope = new ScopeGuard(registry, f.store);
    for (const read of businessAccessSnapshots(p)) {
      assert.equal(scope.authorize(read, c), read.accountId);
      for (const changed of [
        {origin: 'https://mybusiness.googleapis.com'},
        {method: 'POST'},
        {headers: {'X-HTTP-Method-Override': 'DELETE'}},
        {path: '/v1/accounts/777'},
        {query: {fields: 'admins'}},
        {body: {}},
      ])
        assert.throws(() => scope.authorize({...read, ...changed}, c));
    }
  } finally {
    f.store.close();
  }
});
test('snapshot row/byte/deadline bounds and exact protocol receipts fail closed', async t => {
  const p = compiler.compile(gateway, input());
  await assert.rejects(
    () =>
      readBusinessAccessState(p, async () => ({status: 200, headers: {}, data: {extra: 'x'.repeat(2 * 1024 * 1024)}})),
    {code: 'BUSINESS_ACCESS_STATE_UNVERIFIED'},
  );
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  try {
    await assert.rejects(
      () =>
        readBusinessAccessState(p, async () => {
          elapsed = 30001;
          return {status: 200, headers: {}, data: {}};
        }),
      {code: 'BUSINESS_ACCESS_STATE_UNVERIFIED'},
    );
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(businessAccessOutcome(p, {status: 201, headers: {}, data: {}}, []), false);
  assert.throws(() => assertBusinessAccessPolicy(p, [], {allow_deletion: false}), {
    code: 'BUSINESS_ACCESS_STATE_UNVERIFIED',
  });
});
test('the seven native action rows and pinned Admin schema match the implemented access contract', () => {
  const rows = actionContracts(registry).filter(r => r.family === 'google_business_access');
  assert.equal(rows.length, 7);
  assert.ok(rows.every(r => r.status === 'reviewed_write_family'));
  const schemas = JSON.parse(readFileSync('.mirror/VENDOR/business-accounts-v1.json', 'utf8')).document.schemas;
  assert.deepEqual(Object.keys(schemas.Admin.properties).sort(), [
    'account',
    'admin',
    'name',
    'pendingInvitation',
    'role',
  ]);
  assert.deepEqual(Object.keys(schemas.ListAccountAdminsResponse.properties), ['accountAdmins']);
  assert.deepEqual(Object.keys(schemas.ListLocationAdminsResponse.properties), ['admins']);
  assert.equal(
    businessAccessKind(
      compiler.compile(
        gateway,
        input('CREATE_ACCOUNT', {accountName: 'New', type: 'USER_GROUP', primaryOwner: 'accounts/123'}),
      ),
    ),
    undefined,
  );
});
