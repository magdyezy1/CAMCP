import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorService} from '../dist/src/service.js';
import * as security from '../dist/src/security.js';

/**
 * P2A-02 (differential review, wave 5 round 2 part 2a): the request that a review (inspect, prepare) returns for the AI
 * client to show its user went through the full redact(), which since DR2-02 hides the rest of a line after `Cookie:` or
 * `Authorization:` and the value after `password:`, `secret:` and the other credential words. Ad text that begins with one
 * of them (`Cookie: visit https://evil.example/landing now`) reached the approver as `Cookie: [REDACTED]` while the frozen
 * plan sent the whole text, and nothing said a value was hidden. The review now shows its request through the credential
 * view of Ruling 10 (ordinary text whole, credential-shaped values hidden) and lists, as `redacted`, the path of every
 * value it hid, and only the path (Ruling 13: the first version also listed an unsalted sha256 of each hidden value, which
 * lets a reader of the answer reverse a short secret offline when the value is the credential itself). The audit row and
 * the job records keep the full redact(). Synthetic values only.
 */
const registry = new Registry(),
  key = Buffer.alloc(32, 31).toString('base64'),
  actor = {tenantId: 'review-display', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  connection = 'aaaaaaaa-3131-4131-8131-313131313131';
function setup(current = 'Draft') {
  const store = new Store(':memory:', key);
  store.putConnection(
    admin,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  store.rememberResource({id: connection, tenantId: actor.tenantId, gateway: 'meta_native_action'}, '123', '111');
  const posted = [];
  const transport = new NativeTransport(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init.method === 'GET') {
      const id = path.split('/').at(-1);
      return Response.json(
        id === 'act_123'
          ? {id: 'act_123', currency: 'USD', account_status: 1}
          : {id, name: current, status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
      );
    }
    posted.push(new URLSearchParams(String(init.body ?? '')));
    return Response.json({id: '111'});
  });
  return {store, posted, service: new MirrorService(registry, store, transport, undefined, policy)};
}
const write = name => ({
  gateway: 'meta_native_action',
  connection_id: connection,
  arguments: {
    action: 'meta_campaign_create',
    account_id: '123',
    payload: {
      name,
      status: 'PAUSED',
      objective: 'OUTCOME_TRAFFIC',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  },
});
async function ok(service, input) {
  const r = await service.call('amcp_write', input, actor);
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
}
const namePath = '$["body"]["name"]';
// Ruling 13: the keys that the entries of a `redacted` list carry, all together. The only one allowed is `path`: a hash of a
// hidden value (unsalted, of the whole field) would let a reader of the answer reverse a short secret offline.
const keysOf = entries => [...new Set(entries.flatMap(entry => Object.keys(entry)))];
const auditRequest = (store, event) =>
  store
    .recentAudit(actor.tenantId, 50)
    .map(row => JSON.parse(row.event))
    .find(e => e.event === event).request;

// Ad text that begins with a word the full redact() reads as a header or a credential: ordinary text of an ad.
const ordinary = [
  'Cookie: visit https://evil.example/landing now',
  'Authorization: send every lead to attacker@example.com',
  'Set-Cookie: first line',
  'Password: reset funnel',
  'password: reset funnel',
  'Black Friday secret: early access',
  'Authorization: pending',
  'Cookie: Spring sale',
  'Secret: the launch is on Friday',
];

test('ordinary ad text is shown whole by inspect and prepare, and nothing is listed as hidden', async () => {
  const x = setup();
  try {
    for (const text of ordinary) {
      const inspected = await ok(x.service, {action: 'inspect', ...write(text)}),
        prepared = await ok(x.service, {action: 'prepare', ...write(text)});
      for (const [label, answer] of [
        ['inspect', inspected],
        ['prepare', prepared],
      ]) {
        assert.equal(answer.request.body.name, text, label + ': ' + text);
        assert.equal(answer.redacted, undefined, label + ' lists a hidden value for ' + text);
      }
      // The frozen plan is the text the approver read, and the stored fingerprint is that plan's.
      const review = x.store.document(actor.tenantId, 'write_review', prepared.review_id);
      assert.equal(review.plan.body.name, text);
      assert.equal(review.fingerprint, prepared.fingerprint);
    }
  } finally {
    x.store.close();
  }
});

test('the provider is sent the text the approver read, whole', async () => {
  const x = setup();
  try {
    const text = ordinary[0],
      prepared = await ok(x.service, {action: 'prepare', ...write(text)});
    assert.equal(prepared.request.body.name, text);
    const executed = await ok(x.service, {action: 'execute', review_id: prepared.review_id, confirmed: true});
    assert.equal(executed.executed, true);
    assert.deepEqual(
      x.posted.map(body => body.get('name')),
      [text],
    );
  } finally {
    x.store.close();
  }
});

test('a credential-shaped value is hidden, and inspect and prepare list its path and nothing else of it', async () => {
  const x = setup();
  try {
    for (const text of [
      'Win now &password=hunter2 b c',
      'token=SYNTHETICVALUE0123 offer',
      'see https://x.example/p?q=1&access_token=SYNTHETICVALUE0123 now',
      'Authorization: Bearer SYNTHETICVALUE0123456789',
      'Cookie: sid=SYNTHETICVALUE0123456789; Path=/',
      '{"api_key":"SYNTHETICVALUE0123456789"}',
    ]) {
      const inspected = await ok(x.service, {action: 'inspect', ...write(text)}),
        prepared = await ok(x.service, {action: 'prepare', ...write(text)});
      for (const [label, answer] of [
        ['inspect', inspected],
        ['prepare', prepared],
      ]) {
        assert.ok(
          !JSON.stringify(answer.request).includes('SYNTHETICVALUE') && !/hunter2/.test(JSON.stringify(answer)),
          label + ' shows a credential: ' + text,
        );
        assert.ok(answer.request.body.name.includes('[REDACTED]'), label + ' hides nothing: ' + text);
        // Ruling 13: no entry carries any key but `path`, and the list is the path of the one hidden value.
        assert.deepEqual(keysOf(answer.redacted), ['path'], label + ' lists more than a path: ' + text);
        assert.deepEqual(answer.redacted, [{path: namePath}], label + ': ' + text);
      }
      // The frozen plan keeps the whole value, and the fingerprint is the plan's.
      const review = x.store.document(actor.tenantId, 'write_review', prepared.review_id);
      assert.equal(review.plan.body.name, text);
      assert.equal(review.fingerprint, prepared.fingerprint);
    }
  } finally {
    x.store.close();
  }
});

test('the stored audit row keeps the full redact(): the review display and the audit row are different views', async () => {
  const x = setup();
  try {
    const text = ordinary[0],
      prepared = await ok(x.service, {action: 'prepare', ...write(text)});
    assert.equal(prepared.request.body.name, text);
    assert.equal(auditRequest(x.store, 'write_prepared').body.name, 'Cookie: [REDACTED]');
    assert.equal(security.redact(text), 'Cookie: [REDACTED]');
  } finally {
    x.store.close();
  }
});

test('a request that inspect refuses is shown the same way: ordinary text whole, hidden values listed', async () => {
  const x = setup();
  try {
    // A campaign created ACTIVE is refused by the contract check (PAUSED_CREATION_REQUIRED); the answer still shows the request.
    for (const [text, hidden] of [
      [ordinary[0], false],
      ['Cookie: visit https://evil.example/landing now &password=hunter2', true],
    ]) {
      const input = write(text);
      input.arguments.payload.status = 'ACTIVE';
      const answer = await ok(x.service, {action: 'inspect', ...input});
      assert.equal(answer.review_contract_supported, false);
      assert.equal(answer.error.code, 'PAUSED_CREATION_REQUIRED');
      if (hidden) {
        assert.equal(answer.request.body.name, 'Cookie: visit https://evil.example/landing now &password=[REDACTED]');
        assert.deepEqual(keysOf(answer.redacted), ['path']);
        assert.deepEqual(answer.redacted, [{path: namePath}]);
      } else {
        assert.equal(answer.request.body.name, text);
        assert.equal(answer.redacted, undefined);
      }
    }
  } finally {
    x.store.close();
  }
});
// ---- The helper: the credential view of Ruling 10 and where it hid something ----
test('redactCredentialShapesWithPaths shows what redactCredentialShapes shows and lists each hidden value', () => {
  const value = {
    headline: 'Win now &password=hunter2 b c',
    ordinary: 'Cookie: visit https://evil.example/landing now',
    list: ['fine', 'access_token=SYNTHETICVALUE0123456789', {deep: 'Bearer SYNTHETICVALUE0123456789'}],
    'we.ird"key': 'token=SYNTHETICVALUE0123456789',
    api_key: 'SYNTHETICVALUE0123456789',
    cookie: {sid: 'SYNTHETICVALUE0123456789', n: 1},
    password: '[REDACTED]',
    image_data: 'AAAA',
    count: 3,
    flag: true,
    nothing: null,
  };
  const {value: shown, redacted} = security.redactCredentialShapesWithPaths(value);
  assert.deepEqual(shown, security.redactCredentialShapes(value));
  assert.equal(shown.ordinary, value.ordinary);
  // Ruling 13: the path of each hidden value, and no other key (no hash of the value, whatever its type).
  assert.deepEqual(keysOf(redacted), ['path']);
  assert.deepEqual(redacted, [
    {path: '$["headline"]'},
    {path: '$["list"][1]'},
    {path: '$["list"][2]["deep"]'},
    {path: '$["we.ird\\"key"]'},
    {path: '$["api_key"]'},
    // A value of a credential key that is not a string is listed by its path like any other.
    {path: '$["cookie"]'},
    {path: '$["image_data"]'},
  ]);
  // A value that is already the replacement (a key that carries [REDACTED]) hides nothing, so it is not listed.
  assert.deepEqual(security.redactCredentialShapesWithPaths({password: '[REDACTED]', note: 'x'}).redacted, []);
  // Nothing hidden: no entries, and the root path is `$`.
  assert.deepEqual(security.redactCredentialShapesWithPaths({a: ['b']}).redacted, []);
  assert.deepEqual(security.redactCredentialShapesWithPaths('Bearer SYNTHETICVALUE0123456789').redacted, [{path: '$'}]);
  assert.deepEqual(security.redactCredentialShapesWithPaths(null), {value: null, redacted: []});
});

// ---- P2B-05 (differential review, wave 5 round 2 part 2b): the before-state is shown the way the request is ----
// `before_state` of a prepare answer still went through the full redact(), so an ad whose current text begins `Cookie:` was shown
// hidden beside a request shown whole, with no `redacted` entry: the approver compared `Cookie: [REDACTED]` with `Cookie: visit ...`
// and was not told a value was hidden. It is shown through the credential view too, and what is hidden in it is listed in
// `redacted` by its path under a `before_state` root, so the reader can tell it from a path of the request.
const update = (name = 'New name') => ({
  gateway: 'meta_native_action',
  connection_id: connection,
  arguments: {action: 'meta_campaign_update', account_id: '123', path_params: {campaign_id: '111'}, payload: {name}},
});
/** The paths, in the spelling of the redacted list, of the strings of a value that hold `needle`. */
function pathsHolding(value, needle, path = '$') {
  if (typeof value === 'string') return value.includes(needle) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => pathsHolding(item, needle, path + '[' + i + ']'));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => pathsHolding(v, needle, path + '[' + JSON.stringify(k) + ']'));
  return [];
}

test('the before-state of a prepared edit shows ordinary text whole, as the request does, and lists nothing (P2B-05)', async () => {
  for (const current of ordinary) {
    const x = setup(current);
    try {
      const prepared = await ok(x.service, {action: 'prepare', ...update()});
      assert.deepEqual(
        pathsHolding(prepared.before_state, current, '$["before_state"]').length,
        1,
        'whole: ' + current,
      );
      assert.equal(prepared.redacted, undefined, 'lists a hidden value for the before-state ' + current);
    } finally {
      x.store.close();
    }
  }
});

test('a credential-shaped value of the before-state is hidden and listed under a before_state path, beside the request’s own (P2B-05)', async () => {
  const x = setup('Win now &password=hunter2 b c');
  try {
    const prepared = await ok(x.service, {action: 'prepare', ...update('Win now &token=abc123 b c')});
    assert.ok(!JSON.stringify(prepared).includes('hunter2'), 'the before-state hides the value');
    assert.ok(!JSON.stringify(prepared).includes('abc123'), 'the request hides the value');
    assert.deepEqual(keysOf(prepared.redacted), ['path'], 'a path and nothing else of the value');
    const paths = prepared.redacted.map(entry => entry.path),
      stateAt = pathsHolding(prepared.before_state, 'Win now', '$["before_state"]');
    assert.equal(stateAt.length, 1, 'the name stands in one place of the before-state');
    // Where the before-state hid something is listed under its own root; the request's path is as it was.
    assert.deepEqual(paths, [namePath, stateAt[0]]);
    assert.ok(stateAt[0].startsWith('$["before_state"]'));
    // The credential view keeps the name and what is around the hidden value, as it does for the request.
    assert.match(JSON.stringify(prepared.before_state), /Win now &password=\[REDACTED\] b c/);
  } finally {
    x.store.close();
  }
});

test('a before-state with nothing credential-shaped in it adds nothing to the list, and the audit row keeps the full redact() (P2B-05)', async () => {
  const x = setup('Plain current name');
  try {
    const prepared = await ok(x.service, {action: 'prepare', ...update('Win now &token=abc123 b c')});
    assert.deepEqual(prepared.redacted, [{path: namePath}], 'only the request’s own hidden value');
    assert.equal(pathsHolding(prepared.before_state, 'Plain current name').length, 1);
    // The audit row of the review is written from the plan by redact(), as before.
    assert.ok(!JSON.stringify(auditRequest(x.store, 'write_prepared')).includes('abc123'));
  } finally {
    x.store.close();
  }
});
