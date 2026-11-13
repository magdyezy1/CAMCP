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
 * view of Ruling 10 (ordinary text whole, credential-shaped values hidden) and lists, as `redacted`, the path and the
 * sha256 of every value it hid. The audit row and the job records keep the full redact(). Synthetic values only.
 */
const registry = new Registry(),
  key = Buffer.alloc(32, 31).toString('base64'),
  actor = {tenantId: 'review-display', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  connection = 'aaaaaaaa-3131-4131-8131-313131313131';
function setup() {
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
  const posted = [];
  const transport = new NativeTransport(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init.method === 'GET') {
      const id = path.split('/').at(-1);
      return Response.json(
        id === 'act_123'
          ? {id: 'act_123', currency: 'USD', account_status: 1}
          : {id, name: 'Draft', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC'},
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

test('a credential-shaped value is hidden, and inspect and prepare list its path and the sha256 of the value', async () => {
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
        assert.deepEqual(answer.redacted, [{path: namePath, sha256: security.sha256(text)}], label + ': ' + text);
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
        assert.deepEqual(answer.redacted, [{path: namePath, sha256: security.sha256(text)}]);
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
  assert.deepEqual(redacted, [
    {path: '$["headline"]', sha256: security.sha256(value.headline)},
    {path: '$["list"][1]', sha256: security.sha256(value.list[1])},
    {path: '$["list"][2]["deep"]', sha256: security.sha256(value.list[2].deep)},
    {path: '$["we.ird\\"key"]', sha256: security.sha256(value['we.ird"key'])},
    {path: '$["api_key"]', sha256: security.sha256(value.api_key)},
    // A value of a credential key that is not a string is hashed as its stable JSON text.
    {path: '$["cookie"]', sha256: security.sha256(security.stable(value.cookie))},
    {path: '$["image_data"]', sha256: security.sha256('AAAA')},
  ]);
  // A value that is already the replacement (a key that carries [REDACTED]) hides nothing, so it is not listed.
  assert.deepEqual(security.redactCredentialShapesWithPaths({password: '[REDACTED]', note: 'x'}).redacted, []);
  // Nothing hidden: no entries, and the root path is `$`.
  assert.deepEqual(security.redactCredentialShapesWithPaths({a: ['b']}).redacted, []);
  assert.deepEqual(security.redactCredentialShapesWithPaths('Bearer SYNTHETICVALUE0123456789').redacted, [
    {path: '$', sha256: security.sha256('Bearer SYNTHETICVALUE0123456789')},
  ]);
  assert.deepEqual(security.redactCredentialShapesWithPaths(null), {value: null, redacted: []});
});
