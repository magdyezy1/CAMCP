// P2B-03 (differential review, wave 5 round 2 part 2b): the v2 transport refusals of server/mcp.ts (a refused `max_bytes`, a refused
// continuation, and the INVALID_CURSOR that the budget raises after the call) are built in the transport layer, outside
// MirrorService.call, and wrote no audit row, where the same refusal inside the service is audited with its input and outcome. An
// operator reading the trail could not see a client replaying another client's continuation or probing forged tokens. Each of
// them now leaves one row of the same shape as its twin in the service, and no secret of the arguments or the access token is in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';

const call = async (client, name, args) => (await client.callTool({name, arguments: args})).structuredContent;

/** Two AI clients of one workspace on v2 (a third on legacy), so that another client's continuation can be replayed. */
async function stack(t) {
  const s = await oauthStack(t),
    older = await s.connect('Legacy client'),
    newer = await s.connect('Opted-in client'),
    other = await s.connect('Another opted-in client');
  for (const client of [newer, other]) assert.equal(setContractProfile(s.store, client.client.client_id, 'v2'), true);
  return {...s, older, newer, other};
}
/** The audit rows of the workspace, oldest first, each with its request ID. */
const rowsOf = (s, tenant) =>
  s.store.audit(tenant, 1000).map(row => ({request_id: row.request_id, ...JSON.parse(row.event)}));

test('a v2 transport refusal leaves one audit row like its twin in the service, naming the tool, the input and the outcome (P2B-03)', async t => {
  const s = await stack(t),
    v2 = await s.client('modern', s.newer.access),
    other = await s.client('modern', s.other.access),
    args = {action: 'LIST_ACTIONS', limit: 500},
    first = await call(v2, 'meta_native_action', args),
    next = first.meta.budget.next_call.arguments;
  // The workspace the AI clients work in: the one whose trail now holds the rows of the clients' own calls.
  const tenant =
    s.store.db.prepare('SELECT tenant_id FROM audit ORDER BY seq DESC LIMIT 1').get()?.tenant_id ?? 'local';
  const token = next.continuation,
    parts = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
    pastTheEnd = Buffer.from(JSON.stringify({...parts, offset: 1000000})).toString('base64url');
  // The twin: a refusal inside MirrorService.call, from a call that reaches the service, as the same client.
  const beforeTwin = rowsOf(s, tenant).length;
  const twin = await call(v2, 'meta_native_action', {action: 'DESCRIBE_ACTION'});
  assert.equal(twin.success, false, 'the twin is refused inside the service');
  const twinRows = rowsOf(s, tenant).slice(beforeTwin);
  assert.equal(twinRows.length, 1, 'the twin is audited: ' + JSON.stringify(twinRows));
  const shape = Object.keys(twinRows[0]).sort();
  assert.ok(shape.includes('tool') && shape.includes('input') && shape.includes('outcome'), shape.join());

  const refusals = [
    ['a max_bytes under the cap', v2, {action: 'LIST_ACTIONS', limit: 5, max_bytes: 100}, 'INVALID_ARGUMENT'],
    [
      'a max_bytes that is not a number',
      v2,
      {action: 'LIST_ACTIONS', limit: 5, max_bytes: '65536'},
      'INVALID_ARGUMENT',
    ],
    ['a continuation with a changed argument', v2, {...next, limit: 499}, 'INVALID_CURSOR'],
    ['another client’s continuation', other, next, 'INVALID_CURSOR'],
    ['a made-up continuation', v2, {...next, continuation: 'not-a-token'}, 'INVALID_CURSOR'],
    [
      'a continuation of a call that reads nothing',
      v2,
      {action: 'no_such_action', continuation: token},
      'INVALID_CURSOR',
    ],
    [
      'a continuation past the end of the list (refused after the call)',
      v2,
      {...next, continuation: pastTheEnd},
      'INVALID_CURSOR',
    ],
  ];
  for (const [label, client, input, code] of refusals) {
    const before = rowsOf(s, tenant).length,
      answer = await call(client, 'meta_native_action', input);
    assertRefused(answer, code);
    const added = rowsOf(s, tenant).slice(before);
    assert.equal(added.length, 1, `${label}: one audit row, found ${JSON.stringify(added)}`);
    const [row] = added;
    assert.deepEqual(Object.keys(row).sort(), shape, `${label}: the row has the shape of its twin`);
    assert.equal(row.tool, 'meta_native_action', label);
    assert.equal(row.outcome.error.code, code, label);
    // The row is the one the envelope names, and it keeps the arguments the caller sent.
    assert.equal(row.request_id, answer.meta.requestId, label);
    assert.equal(row.outcome.meta.requestId, answer.meta.requestId, label);
    assert.deepEqual(row.input, input, `${label}: the input as it was sent`);
  }
});

test('the audit row of a transport refusal holds no secret of the arguments and none of the access token (P2B-03)', async t => {
  const s = await stack(t),
    v2 = await s.client('modern', s.newer.access);
  const before = s.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n;
  const secret = 'SYNTHETICSECRET0123456789';
  const answer = await call(v2, 'meta_native_action', {
    action: 'LIST_ACTIONS',
    max_bytes: 100,
    access_token: secret,
    note: 'password=' + secret,
  });
  assertRefused(answer, 'INVALID_ARGUMENT');
  const added = s.store.db.prepare('SELECT event FROM audit ORDER BY seq DESC LIMIT ?').all(1),
    stored = JSON.stringify(added);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, before + 1, 'one row');
  assert.ok(!stored.includes(secret), 'the secrets of the arguments are hidden: ' + stored);
  for (const credential of [s.newer.access, s.newer.credentials.refresh_token, s.other.access])
    assert.ok(!stored.includes(credential), 'no credential of any client is stored');
});
