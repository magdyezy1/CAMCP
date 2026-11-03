import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {MediaUploadService, mediaTool} from '../dist/src/media-upload.js';

// ARC-04 stage D: MediaUploadService.handle (732 lines) dispatched amcp_media's actions through an if-chain; they are
// now entries of three action tables (src/tool-actions.ts), consulted in the order of the checks the chain ran between
// them. These tests hold what that order decided: which actions need no review, which are refused before the review
// they name is read, and that a review action reads its review first. The media suites run every action end to end.
const actor = {tenantId: 'media-actions', userId: 'owner', role: 'admin'};
const key = Buffer.alloc(32, 63).toString('base64');
function fixture() {
  const store = new Store(':memory:', key),
    registry = new Registry();
  let requests = 0;
  const transport = new NativeTransport(async () => {
    requests++;
    throw Error('No provider request is allowed');
  });
  const media = new MediaUploadService(
    registry,
    store,
    transport,
    new CredentialProvider(store),
    {allowWrites: true},
    async () => {
      requests++;
      throw Error('No download is allowed');
    },
  );
  return {store, media, requests: () => requests, run: input => media.call(input, actor)};
}

test('every amcp_media business action has one table entry, in the stage whose checks the if-chain ran before it', () => {
  const f = fixture();
  try {
    const stages = {
      unreviewed: f.media.unreviewedActions,
      review: f.media.reviewActions,
      confirmed: f.media.confirmedActions,
    };
    const placed = Object.entries(stages).flatMap(([stage, table]) =>
      Object.keys(table).map(action => [action, stage]),
    );
    // asset_usage and help are answered by MirrorService before amcp_media is called; own help has SDK coverage.
    assert.deepEqual(
      placed.map(([action]) => action).sort(),
      mediaTool.inputSchema.properties.action.enum.filter(action => !['asset_usage', 'help'].includes(action)).sort(),
    );
    assert.equal(new Set(placed.map(([action]) => action)).size, placed.length);
    assert.deepEqual(Object.fromEntries(placed), {
      retain_source: 'unreviewed',
      remove_source: 'unreviewed',
      list: 'unreviewed',
      library: 'unreviewed',
      asset: 'unreviewed',
      save_asset_metadata: 'unreviewed',
      asset_performance: 'unreviewed',
      reuse: 'unreviewed',
      plan: 'unreviewed',
      inspect_eligibility: 'unreviewed',
      variant: 'unreviewed',
      prepare: 'unreviewed',
      prepare_library: 'review',
      job_status: 'review',
      cancel: 'review',
      recovery: 'review',
      status: 'review',
      execute_async: 'confirmed',
      execute: 'confirmed',
      resume: 'confirmed',
    });
  } finally {
    f.store.close();
  }
});

test('an unknown, inherited or MirrorService-only action, or a review action without its review, is refused first', async () => {
  const f = fixture();
  try {
    for (const action of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'asset_usage'])
      for (const input of [{action}, {action, review_id: 'r1'}])
        await assert.rejects(
          f.run(input),
          e =>
            e.code === 'INVALID_ARGUMENT' && e.message === 'Use prepare, execute, status or cancel with a review_id.',
          JSON.stringify(input),
        );
    for (const action of ['prepare_library', 'job_status', 'cancel', 'recovery', 'status', 'execute_async'])
      await assert.rejects(
        f.run({action}),
        e => e.code === 'INVALID_ARGUMENT' && e.message === 'Use prepare, execute, status or cancel with a review_id.',
        action,
      );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('a frozen-review action refuses fresh-file arguments before it reads the review, then reads the review first', async () => {
  const f = fixture();
  try {
    for (const action of ['prepare_library', 'job_status', 'cancel', 'recovery', 'status', 'execute', 'resume']) {
      await assert.rejects(
        f.run({action, review_id: 'missing', platform: 'meta'}),
        e => e.code === 'INVALID_ARGUMENT' && e.message === 'This action uses the frozen media review.',
        action,
      );
      // The review is read before any action of the review and confirmation stages runs, and before confirmation.
      await assert.rejects(f.run({action, review_id: 'missing'}), e => e.code === 'NOT_FOUND', action);
    }
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('the actions that name no review keep their own checks: list pages are bounded, stage_fits is plan’s only', async () => {
  const f = fixture();
  try {
    const listed = await f.run({action: 'list'});
    assert.deepEqual([listed.total, listed.recovery_total, listed.has_more], [0, 0, false]);
    await assert.rejects(f.run({action: 'list', limit: 101}), e => e.message === 'Invalid media pagination.');
    await assert.rejects(
      f.run({action: 'list', stage_fits: true}),
      e => e.code === 'INVALID_ARGUMENT' && e.details.parameter === 'stage_fits',
    );
    await assert.rejects(f.run({action: 'prepare', platform: 'meta'}), e =>
      e.message.startsWith('prepare requires platform, account_id and one file'),
    );
    await assert.rejects(
      f.run({action: 'variant'}),
      e => e.message === 'Name the original file: source_id, source_url or drive_url.',
    );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});
