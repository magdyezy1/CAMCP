import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {rollbackFixture} from './helpers/rollback-fixture.mjs';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {audit} from '../dist/src/workspace-core.js';

/**
 * Package closing-small, item 5 (sec-hardening DR2-04, decision 6): src/access-sets.ts holds the one helper for the audit
 * row of work done under a client access set (SEC-08, `accessSetAudit`), and src/workspace-core.ts still wrote the same
 * expression inline. A row written through audit() names the set the actor works under and, under full access, adds
 * nothing; the source guard keeps the expression in one place. (The first test holds before and after the change, as the
 * helper is the same expression; the second is what failed.)
 */
const A = '7200000001';

/** An administrator, one Meta login holding account A, a client access set bound to A, and a key limited to that set. */
function fixture(t) {
  const f = rollbackFixture(t, {platforms: []}),
    admin = f.actor;
  f.store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: admin.tenantId,
      gateway: 'meta_native_action',
      accounts: [A],
      writeAccounts: [A],
      enabled: true,
      label: 'Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  const set = saveAccessSet(f.store, admin, {
      name: 'Client A',
      bindings: [{gateway: 'meta_native_action', connection_id: 'meta-login', account_id: A}],
    }),
    scoped = f.store.authenticate(
      f.store.createKey({
        tenantId: admin.tenantId,
        userId: 'connector/client-a',
        role: 'operator',
        accessSetId: String(set.id),
      }),
    );
  return {f, set: String(set.id), scoped, admin};
}
/** The rows a name wrote: each audit row's event is its record as JSON. */
const rowsOf = (f, event) =>
  f.store
    .audit(f.actor.tenantId, 1000)
    .map(row => JSON.parse(row.event))
    .filter(row => row.event === event);

test('an audit row written through workspace-core names the access set the actor works under, and none under full access', t => {
  const {f, set, scoped, admin} = fixture(t);
  assert.equal(scoped.accessSetId, set, 'the key works under the set');
  assert.equal(admin.accessSetId, undefined, 'the administrator has full access');
  audit(f.store, scoped, 'closing_small_scoped', {note: 'under a set'});
  audit(f.store, admin, 'closing_small_full', {note: 'under full access'});
  const [limited] = rowsOf(f, 'closing_small_scoped'),
    [unlimited] = rowsOf(f, 'closing_small_full');
  assert.equal(rowsOf(f, 'closing_small_scoped').length, 1);
  assert.equal(limited.access_set_id, set, 'the row names the set');
  assert.equal(limited.actor, scoped.userId);
  assert.equal(limited.note, 'under a set', 'the caller’s fields are kept');
  assert.equal(rowsOf(f, 'closing_small_full').length, 1);
  assert.equal(Object.hasOwn(unlimited, 'access_set_id'), false, 'full access adds no field at all');
  assert.equal(unlimited.actor, admin.userId);
  assert.equal(unlimited.note, 'under full access');
});

test('the access-set audit expression is written once, in src/access-sets.ts, and workspace-core uses it', () => {
  const inline = /access_set_id\s*:\s*actor\.accessSetId/,
    offenders = fs
      .readdirSync('src')
      .filter(file => file.endsWith('.ts') && file !== 'access-sets.ts')
      .filter(file => inline.test(fs.readFileSync('src/' + file, 'utf8')));
  assert.deepEqual(offenders, [], 'these modules build the row field themselves; use accessSetAudit(actor)');
  assert.match(fs.readFileSync('src/access-sets.ts', 'utf8'), /export const accessSetAudit = /);
  const core = fs.readFileSync('src/workspace-core.ts', 'utf8');
  assert.match(core, /import \{accessSetAudit\} from '\.\/access-sets\.js';/);
  assert.match(core, /\.\.\.accessSetAudit\(actor\),/);
});
