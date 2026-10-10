import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * WRT-05 Stage E on the media page: an upload review or a video-asset write review that expires offers "Prepare
 * again", which sends the same prepare request again and shows the new review (with its own countdown). A review whose
 * request the page cannot repeat (a recovery) gets no Prepare again.
 */
function fixture(respond) {
  const nodes = new Map(),
    bindings = new Map(),
    countdowns = [],
    calls = [];
  let showMediaStatus;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        innerHTML: '',
        isConnected: true,
        data: {},
        addEventListener() {},
        insertAdjacentHTML() {},
        setAttribute() {},
        focus() {},
      });
    return nodes.get(id);
  };
  node('#media-import').data = {target: '0', name: 'Synthetic media', reuse: 'on'};
  node('#media-source').data = {drive_url: 'https://drive.google.com/file/d/synthetic/view'};
  const context = createContext({
    document: {addEventListener() {}},
    content: node('#content'),
    $: node,
    platforms: [
      {
        id: 'meta',
        gateway: 'meta_native_action',
        name: 'Meta',
        connections: [{id: 'conn', enabled: true, accounts: ['act_1']}],
      },
    ],
    accountLabel: () => 'Meta act_1',
    accountText: () => 'act_1',
    creativePushPanel: () => '',
    pushDrives: () => [],
    adPreviewsPanel: () => '',
    bindCreativePush() {},
    bindAdPreviews() {},
    bindCreativeLibrary: async (_targets, show) => {
      showMediaStatus = show;
    },
    workspaceCall: async (tool, args) => {
      calls.push({tool, args: JSON.parse(JSON.stringify(args))});
      return respond(tool, args, calls.length);
    },
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    reviewView: review => 'REVIEW ' + review.review_id,
    bindReviewCountdown: (review, prepareAgain) =>
      countdowns.push({review: review.review_id, unchanged: review.unchanged_since_review, prepareAgain}),
    readReviewConsents: () => ({confirmed: true}),
    FormData: function (form) {
      return Object.entries(form.data ?? {});
    },
    Object,
    JSON,
    Number,
    String,
    Math,
    URLSearchParams,
    encodeURIComponent,
    location: {search: ''},
    esc: value => String(value ?? ''),
    date: String,
    badge: String,
    blank: String,
    recordDetails: () => '',
    controls: () => '',
    toast() {},
    navigate() {},
    clearTimeout() {},
    setTimeout() {},
    pollTimer: undefined,
  });
  const source = readFileSync('web/workspace.js', 'utf8');
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(
    source.slice(
      // From the media job panel: the library uses its not-sent notice (MED-02) as well as the review countdown.
      source.indexOf('function mediaJobPanel('),
      source.indexOf('async function renderDecisionReports()'),
    ),
  ).runInContext(context);
  return {
    node,
    bindings,
    countdowns,
    calls,
    render: () => new Script('renderMediaLibrary()').runInContext(context),
    status: id => showMediaStatus(id),
  };
}

test('an expired upload review is prepared again with the same request and shows the new review', async () => {
  const f = fixture((_tool, args, n) =>
    args.action === 'list'
      ? {presets: {}, sources: [], recovery_reviews: []}
      : {review_id: 'upload-review-' + n, idempotency_key: 'key-' + n, expires_at: '2026-10-10T12:05:00Z'},
  );
  await f.render();
  await f.bindings.get('#media-import')(f.node('#media-import'));
  const first = f.calls.at(-1);
  assert.equal(first.args.action, 'prepare');
  assert.equal(f.node('#media-review').innerHTML, 'REVIEW upload-review-2');
  assert.equal(f.countdowns.length, 1);
  assert.equal(typeof f.countdowns[0].prepareAgain, 'function', 'the expired review offers Prepare again');
  await f.countdowns[0].prepareAgain();
  const again = f.calls.at(-1);
  assert.deepEqual(again, first, 'the same prepare request, nothing executed');
  assert.equal(f.node('#media-review').innerHTML, 'REVIEW upload-review-3');
  assert.equal(f.countdowns.at(-1).review, 'upload-review-3');
  assert.equal(typeof f.countdowns.at(-1).prepareAgain, 'function', 'the new review can be prepared again too');
  assert.ok(f.calls.every(c => !['execute', 'execute_async'].includes(c.args.action)));
});

test('a video-asset write review prepares the same amcp_write request again', async () => {
  const writePrepare = {
    action: 'prepare',
    gateway: 'meta_native_action',
    connection_id: 'conn',
    arguments: {account_id: 'act_1', action: 'synthetic_video_create'},
  };
  let stateHash = 'state-1';
  const f = fixture((tool, args, n) =>
    args.action === 'list'
      ? {presets: {}, sources: [], recovery_reviews: []}
      : args.action === 'status'
        ? {next_call: {tool: 'amcp_write', arguments: writePrepare}}
        : {
            review_id: tool + '-review-' + n,
            idempotency_key: 'key-' + n,
            expires_at: '2026-10-10T12:05:00Z',
            fingerprint: 'request-1',
            state_hash: stateHash,
          },
  );
  await f.render();
  await f.status('upload-1');
  await f.bindings.get('#prepare-video-asset')();
  assert.deepEqual(f.calls.at(-1), {tool: 'write', args: writePrepare});
  assert.equal(f.countdowns.at(-1).unchanged, undefined);
  await f.countdowns.at(-1).prepareAgain();
  assert.deepEqual(f.calls.at(-1), {tool: 'write', args: writePrepare});
  assert.equal(f.node('#media-review').innerHTML, 'REVIEW write-review-4');
  // Same server fingerprint and state hash: the new review says nothing changed since the expired one.
  assert.equal(f.countdowns.at(-1).unchanged, 'write-review-3');
  // The state changed: nothing is claimed.
  stateHash = 'state-2';
  await f.countdowns.at(-1).prepareAgain();
  assert.equal(f.countdowns.at(-1).review, 'write-review-5');
  assert.equal(f.countdowns.at(-1).unchanged, undefined);
});

test('a recovery review the page cannot repeat offers no Prepare again', async () => {
  const f = fixture((_tool, args) =>
    args.action === 'list'
      ? {presets: {}, sources: [], recovery_reviews: []}
      : {
          review_id: 'recovered',
          idempotency_key: 'key',
          can_execute: true,
          journal: {},
          expires_at: '2026-10-10T12:05:00Z',
        },
  );
  await f.render();
  f.node('#media-review').innerHTML = '';
  await f.bindings.get('[data-media-recovery]')({dataset: {mediaRecovery: 'recovered'}});
  assert.equal(f.countdowns.at(-1).review, 'recovered');
  assert.equal(f.countdowns.at(-1).prepareAgain, undefined);
});
