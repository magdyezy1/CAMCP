import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {WriteReviewService, writeTool} from '../dist/src/write-review.js';

// ARC-04 stage D: WriteReviewService.call (507 lines) dispatched amcp_write's actions through an if-chain. They are now
// entries of two action tables (src/tool-actions.ts) and execute, consulted in the order of the checks the chain ran
// between them, and each long action is a method whose body is the chain's block unchanged. These tests hold what that
// order decided: status and reconcile take only their own arguments and run before the argument checks; prepare,
// inspect and execute run after them and after the evidence form; an action in no table is refused with the chain's
// sentence. The write suites run every action end to end.
const actor = {tenantId: 'write-actions', userId: 'operator', role: 'operator'};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 29).toString('base64'));
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider request is allowed');
    }),
    {mode: 'strict'},
    {allowWrites: true},
  );
  const writes = new WriteReviewService(
    service.registry,
    service.compiler,
    store,
    service.transport,
    service.credentials,
    service.options,
    service.policy,
  );
  return {store, writes, requests: () => requests, call: input => writes.call(input, actor)};
}
const refused =
  (message, code = 'INVALID_ARGUMENT') =>
  e =>
    e.code === code && e.message === message;

test('every amcp_write action has one place, in the stage whose checks the if-chain ran before it', () => {
  const f = fixture();
  try {
    const placed = [
      ...Object.keys(f.writes.retainedActions).map(action => [action, 'retained']),
      ...Object.keys(f.writes.reviewActions).map(action => [action, 'review']),
      // The one action left after both tables: call checks it and its review_id, then executes.
      ['execute', 'call'],
    ];
    assert.deepEqual(placed.map(([action]) => action).sort(), [...writeTool.inputSchema.properties.action.enum].sort());
    assert.deepEqual(Object.fromEntries(placed), {
      status: 'retained',
      reconcile: 'retained',
      prepare: 'review',
      inspect: 'review',
      execute: 'call',
    });
  } finally {
    f.store.close();
  }
});

test('status and reconcile take only their own arguments, and run before the checks of the other actions', async () => {
  const f = fixture();
  try {
    // A prepare-only argument is refused by status's own check, not by the shared one (which names prepare).
    await assert.rejects(
      f.call({action: 'status', review_id: 'missing', supersedes_review_id: 'other'}),
      e => e.code === 'INVALID_ARGUMENT' && e.message === 'status takes action, review_id.',
    );
    await assert.rejects(
      f.call({action: 'reconcile', review_id: 'missing', evidence: 'nonsense'}),
      e => e.message === 'reconcile takes action, review_id, accept_applied, reconciliation_id.',
    );
    // status reads the retained review: a missing one is not found, whatever evidence form another action would need.
    await assert.rejects(f.call({action: 'status', review_id: 'missing'}), e => e.code === 'NOT_FOUND');
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('the argument checks and the evidence form precede prepare, inspect and execute', async () => {
  const f = fixture();
  try {
    for (const action of ['prepare', 'inspect', 'execute', 'nope'])
      await assert.rejects(
        f.call({action, review_id: 'r', accept_applied: true}),
        refused('accept_applied is for reconcile.'),
        action,
      );
    for (const action of ['inspect', 'execute'])
      await assert.rejects(
        f.call({action, review_id: 'r', supersedes_review_id: 'old'}),
        refused('supersedes_review_id is for prepare.'),
        action,
      );
    await assert.rejects(
      f.call({action: 'inspect', gateway: 'meta_native_action', arguments: {}, provider_check: true}),
      refused('provider_check is a boolean that prepare takes.'),
    );
    await assert.rejects(
      f.call({action: 'prepare', gateway: 'meta_native_action', arguments: {}, destructive_confirmed: true}),
      refused('destructive_confirmed is a boolean that execute takes.'),
    );
    for (const action of ['prepare', 'execute'])
      await assert.rejects(
        f.call({action, review_id: 'r', evidence: 'nonsense'}),
        refused('evidence must be "full" or "ref".'),
        action,
      );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('an unknown or inherited action, or execute without its review, is refused with the chain’s sentence', async () => {
  const f = fixture();
  try {
    for (const action of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])
      for (const input of [{action}, {action, review_id: 'r'}])
        await assert.rejects(f.call(input), refused('Use prepare or execute with a review_id.'), JSON.stringify(input));
    await assert.rejects(f.call({action: 'execute'}), refused('Use prepare or execute with a review_id.'));
    // execute reads the review it names after its own argument checks.
    await assert.rejects(
      f.call({action: 'execute', review_id: 'missing', confirmed: true}),
      e => e.code === 'NOT_FOUND',
    );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});
