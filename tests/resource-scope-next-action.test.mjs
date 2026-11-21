import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B6 (the owner's field report of 2026-11-21, issue 3; lead's brief): a RESOURCE_SCOPE_REQUIRED whose details
// name neither a next_call nor ownership_reads (no account collection of the provider proves the resource) said "Run the
// ownership read in details.next_call", a call that does not exist. Its next_action now promises no call.

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const promisesNoCall =
  'No account collection proves ownership of this resource for AMCP; an administrator provisions a resource binding.';
const refused = (details = {}) =>
  errorResult(
    new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Resource ownership is not established.', details, 403),
    'request-1',
    0,
  ).error;
const base = {gateway: 'gtm_native_action', path: '/tagmanager/v2/accounts', account_id: '111'};

test('an ownership refusal without a next_call or ownership_reads says no read settles it and names no call', () => {
  const error = refused(base);
  assert.equal(error.code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(error.next_action, promisesNoCall);
  assert.doesNotMatch(error.next_action, /next_call|ownership_reads/);
  // The remedy itself is the grant remedy it always was; only the next step changed.
  assert.equal(error.category, 'grant');
  assert.equal(error.remedy.category, 'grant');
});

test('a refusal that names one read, or several, keeps the step that names them', () => {
  const read = {tool: 'amcp_workspace', arguments: {action: 'measurement_ledger'}};
  const single = refused({...base, ownership_reads: [read], next_call: read});
  assert.match(single.next_action, /details\.next_call/);
  assert.notEqual(single.next_action, promisesNoCall);
  const several = refused({...base, ownership_reads: [read, read]});
  assert.match(several.next_action, /details\.ownership_reads/);
  assert.notEqual(several.next_action, promisesNoCall);
  // An empty list names no read either: the sentence that promises none is the true one.
  assert.equal(refused({...base, ownership_reads: []}).next_action, promisesNoCall);
});

test('the guard refusal of a Tag Manager account collection read carries no call, and its envelope promises none', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  try {
    const guard = new ScopeGuard(new Registry(), store),
      connection = {
        id: 'c-gtm',
        tenantId: 'scope-next-action',
        gateway: 'gtm_native_action',
        accounts: ['111'],
        label: 'Synthetic',
        enabled: true,
        scopes: [],
      },
      plan = {
        gateway: 'gtm_native_action',
        action: 'gtm_ops/LIST_ACCOUNTS',
        method: 'GET',
        path: '/tagmanager/v2/accounts',
        query: {},
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        accountId: '111',
        evidence: 'TEST',
        warnings: [],
      };
    let thrown;
    assert.throws(
      () => guard.authorize(plan, connection),
      error => {
        thrown = error;
        return assertRefused(error, 'RESOURCE_SCOPE_REQUIRED', {status: 403});
      },
    );
    assert.equal(thrown.details.next_call, undefined);
    assert.equal(thrown.details.ownership_reads, undefined);
    const envelope = errorResult(thrown, 'request-2', 0).error;
    assert.equal(envelope.next_action, promisesNoCall);
  } finally {
    store.close();
  }
});

test('the new next step has Arabic in the catalog', () => {
  assert.match(catalog[promisesNoCall] ?? '', /\p{Script=Arabic}/u);
});
