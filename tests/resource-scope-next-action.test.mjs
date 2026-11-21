import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorError, errorResult} from '../dist/src/errors.js';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-field2-access, B6 (the owner's field report of 2026-11-21, issue 3; lead's brief) and its review round (lead review S2-1): a
// RESOURCE_SCOPE_REQUIRED whose details name neither a next_call nor ownership_reads said "Run the ownership read in
// details.next_call", a call that does not exist. B6 first said that no account collection proves the resource, which the review
// found false for the refusals of most other providers: their own messages name the right remedy (a list read, the review that
// created the resource). The next_action of such a refusal now promises no call and asserts nothing about the provider: it sends
// the reader to the refusal's own message, or to an administrator's resource binding.

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const neutral =
  'This refusal names no ownership read: do what its message says (list the resource through its account collection, or use the review that created it), or have an administrator provision an exact resource binding.';
const withdrawn =
  'No account collection proves ownership of this resource for AMCP; an administrator provisions a resource binding.';
const refused = (details = {}, message = 'Resource ownership is not established.') =>
  errorResult(new MirrorError('RESOURCE_SCOPE_REQUIRED', message, details, 403), 'request-1', 0).error;
const base = {gateway: 'gtm_native_action', path: '/tagmanager/v2/accounts', account_id: '111'};

test('an ownership refusal without a next_call or ownership_reads names no call and sends the reader to its own message', () => {
  const error = refused(base);
  assert.equal(error.code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(error.next_action, neutral);
  assert.doesNotMatch(error.next_action, /next_call|ownership_reads/);
  // It asserts nothing about what the provider can or cannot prove, so it cannot contradict what the refusal itself says.
  assert.notEqual(error.next_action, withdrawn);
  assert.doesNotMatch(error.next_action, /no account collection|proves/i);
  // The remedy itself is the grant remedy it always was; only the next step changed.
  assert.equal(error.category, 'grant');
  assert.equal(error.remedy.category, 'grant');
});

test('a refusal that names one read, or several, keeps the step that names them', () => {
  const read = {tool: 'amcp_workspace', arguments: {action: 'measurement_ledger'}};
  const single = refused({...base, ownership_reads: [read], next_call: read});
  assert.match(single.next_action, /details\.next_call/);
  assert.notEqual(single.next_action, neutral);
  const several = refused({...base, ownership_reads: [read, read]});
  assert.match(several.next_action, /details\.ownership_reads/);
  assert.notEqual(several.next_action, neutral);
  // An empty list names no read either: the sentence that promises none is the true one.
  assert.equal(refused({...base, ownership_reads: []}).next_action, neutral);
});

test('the guard refusal of every provider that gives no ownership read gets the neutral step, and keeps its own message', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  try {
    const guard = new ScopeGuard(new Registry(), store),
      reached = [];
    for (const adapter of providerAdapters) {
      const gateway = adapter.gateway,
        connection = {
          id: 'c-' + adapter.id,
          tenantId: 'scope-next-action',
          gateway,
          accounts: ['111'],
          label: 'Synthetic',
          enabled: true,
          scopes: [],
        },
        plan = {
          gateway,
          action: 'probe/GET',
          method: 'GET',
          path: '/zz/unowned/1',
          query: {},
          headers: {},
          readOnly: true,
          destructive: false,
          requiresConfirmation: false,
          accountId: '111',
          evidence: 'TEST',
          warnings: [],
        };
      try {
        guard.authorize(plan, connection);
      } catch (error) {
        if (!(error instanceof MirrorError) || error.code !== 'RESOURCE_SCOPE_REQUIRED') continue;
        if (error.details.next_call || error.details.ownership_reads?.length) continue;
        const envelope = errorResult(error, 'request-2', 0).error;
        // The guard's own message says to read the account-scoped collection: the step must not say the opposite.
        assert.match(envelope.message, /Read its account-scoped collection first/, adapter.id);
        assert.equal(envelope.next_action, neutral, adapter.id);
        assert.ok(!envelope.next_action.includes(gateway), adapter.id + ': the step names no provider');
        reached.push(adapter.id);
      }
    }
    // Most providers refuse an unowned path this way; the owner's Tag Manager case and every provider that lists accounts alike.
    for (const id of ['google', 'meta', 'tiktok', 'snapchat', 'linkedin', 'x', 'reddit', 'dv360', 'ga4', 'gtm'])
      assert.ok(reached.includes(id), id + ' reached the refusal');
    assert.ok(reached.length >= 12, 'the providers reached: ' + reached.join(', '));
  } finally {
    store.close();
  }
});

test('a sample of the refusals other providers raise themselves, in their own words, keeps its message and gets the neutral step', () => {
  // Each message is read from its source file, so the sample cannot drift from what the provider raises. Several of these name a
  // remedy of their own that the first wording of this step contradicted.
  const sample = [
    ['src/meta-portfolio.ts', 'Parent ownership expired during the read. Refresh its inventory page.'],
    ['src/microsoft-adapter.ts', 'Submit the Microsoft report using this account and connection before polling.'],
    ['src/linkedin-posts.ts', 'Read this newly created DSC through its completed review before reusing it.'],
    ['src/meta-insights-jobs.ts', 'Verify this report through its original review first.'],
    ['src/criteo-budget-overrides.ts', 'Budget override reads need current account-scoped membership.'],
    [
      'src/scope.ts',
      'Read its account-scoped collection first, or have an administrator provision an exact resource binding.',
    ],
  ];
  for (const [file, message] of sample) {
    assert.ok(fs.readFileSync(file, 'utf8').includes(message), file + ' still raises: ' + message);
    const envelope = refused({}, message);
    assert.equal(envelope.message, message, file);
    assert.equal(envelope.next_action, neutral, file);
    assert.doesNotMatch(envelope.next_action, /next_call|ownership_reads|no account collection/i, file);
  }
});

test('the guard refusal of a Tag Manager account collection read carries no call, and its envelope promises none', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 62).toString('base64'));
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
    const envelope = errorResult(thrown, 'request-3', 0).error;
    assert.equal(envelope.next_action, neutral);
  } finally {
    store.close();
  }
});

test('the neutral step has Arabic in the catalog, and the sentence it replaced is nowhere', () => {
  assert.match(catalog[neutral] ?? '', /\p{Script=Arabic}/u);
  assert.equal(catalog[withdrawn], undefined, 'no catalog entry for the withdrawn sentence');
  assert.ok(!fs.readFileSync('src/errors.ts', 'utf8').includes(withdrawn), 'src/errors.ts no longer says it');
});
