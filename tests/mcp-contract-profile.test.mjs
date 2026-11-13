// V2-MCP-06, decision 1 (owner decision D26): the per-client contract profile. `legacy` is what every client is served today
// and until its profile is set; `v2` is the opt-in. The profile is read on the server from the AI client's record, never chosen
// by a request, and no website control sets it yet. Tested through the real stack: a client registers itself, is authorized by
// an administrator, exchanges its code and calls /mcp in both protocol eras with the tokens it was given.
//
// What differs by profile is added by the other decisions of the package and tested with them; here the observable is the
// help topic that announces the behaviour (amcp_workspace help, topic mcp_profile), which says which profile this connection
// is served.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {WebStore} from '../dist/server/web-store.js';
import {contractProfiles, currentContractProfile, withContractProfile} from '../dist/src/contract-profile.js';
import {contractProfileOf, mcpClientOf, setContractProfile} from '../dist/src/mcp-client-profile.js';
import {insertRegisteredClient, registeredClient} from '../dist/src/mcp-client-repository.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {oauthStack, origin} from './helpers/mcp-oauth-stack.mjs';

const eras = ['legacy', 'modern'];
const help = {action: 'help', topic: 'mcp_profile'};

/** What the help topic says this connection is served. */
async function profileOf(client, args = help) {
  const result = await client.callTool({name: 'amcp_workspace', arguments: args});
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.data.topic, 'mcp_profile');
  return result.structuredContent.data.profile;
}

test('the scope a client’s calls run in names its profile; outside one every call is legacy, and scopes never mix', async () => {
  assert.deepEqual([...contractProfiles], ['legacy', 'v2']);
  assert.equal(currentContractProfile(), 'legacy');
  const seen = [];
  const run = (profile, wait) =>
    withContractProfile(profile, async () => {
      seen.push(['start', profile, currentContractProfile()]);
      await new Promise(resolve => setTimeout(resolve, wait));
      await Promise.resolve();
      seen.push(['end', profile, currentContractProfile()]);
      return currentContractProfile();
    });
  // Two clients' calls in flight at once, each awaiting across the other: neither sees the other's profile.
  assert.deepEqual(await Promise.all([run('v2', 20), run('legacy', 5), run('v2', 1), run('legacy', 10)]), [
    'v2',
    'legacy',
    'v2',
    'legacy',
  ]);
  for (const [, profile, current] of seen) assert.equal(current, profile);
  assert.equal(currentContractProfile(), 'legacy');
});

test('a client is v2 only where its record says so: every other caller, record and store is legacy', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
  t.after(() => store.close());
  // An MCP-only store has no registration table at all: nothing can vouch for a client, so nothing is opted in.
  assert.equal(contractProfileOf(store, {userId: 'oauth/some-client'}), 'legacy');
  assert.equal(setContractProfile(store, 'some-client', 'v2'), false);
  new WebStore(store, {origin, masterKey: Buffer.alloc(32, 7).toString('base64')});
  const record = (id, data) =>
    insertRegisteredClient(store, id, typeof data === 'string' ? data : JSON.stringify(data));
  record('plain', {client_id: 'plain', client_name: 'Plain'});
  record('opted-in', {client_id: 'opted-in', client_name: 'Opted in', contract_profile: 'v2'});
  record('upper', {client_id: 'upper', contract_profile: 'V2'});
  record('future', {client_id: 'future', contract_profile: 'v3'});
  record('number', {client_id: 'number', contract_profile: 2});
  record('null', {client_id: 'null', contract_profile: null});
  record('explicit', {client_id: 'explicit', contract_profile: 'legacy'});
  record('garbled', '{not json');
  const profile = userId => contractProfileOf(store, {userId});
  assert.equal(profile('oauth/opted-in'), 'v2');
  for (const client of ['plain', 'upper', 'future', 'number', 'null', 'explicit', 'garbled', 'never-registered'])
    assert.equal(profile('oauth/' + client), 'legacy', client);
  // The client is the OAuth client of an AI client's actor; nobody else has a profile, whatever a record they name says.
  for (const caller of [
    'opted-in',
    'cli',
    'connector/opted-in',
    'workspace-admin',
    'workspace-test',
    'oauth/',
    'oauth',
  ])
    assert.equal(profile(caller), 'legacy', caller);
  assert.equal(mcpClientOf({userId: 'oauth/opted-in'}), 'opted-in');
  assert.equal(mcpClientOf({userId: 'oauth/'}), undefined);
  assert.equal(mcpClientOf({userId: 'connector/opted-in'}), undefined);
});

test('setting a profile writes only the profile of a client that has a record, and legacy removes it', t => {
  const store = new Store(':memory:', Buffer.alloc(32, 7).toString('base64'));
  t.after(() => store.close());
  new WebStore(store, {origin, masterKey: Buffer.alloc(32, 7).toString('base64')});
  const original = {client_id: 'one', client_name: 'One', redirect_uris: ['https://claude.ai/cb'], scope: 'mcp:read'};
  insertRegisteredClient(store, 'one', JSON.stringify(original));
  const read = () => JSON.parse(registeredClient(store, 'one').data);
  assert.equal(setContractProfile(store, 'one', 'v2'), true);
  assert.deepEqual(read(), {...original, contract_profile: 'v2'});
  assert.equal(contractProfileOf(store, {userId: 'oauth/one'}), 'v2');
  assert.equal(setContractProfile(store, 'one', 'legacy'), true);
  assert.deepEqual(read(), original);
  assert.equal(contractProfileOf(store, {userId: 'oauth/one'}), 'legacy');
  // A client that is not registered is not given a record, and a profile that is neither is refused.
  assert.equal(setContractProfile(store, 'two', 'v2'), false);
  assert.equal(registeredClient(store, 'two'), undefined);
  assert.throws(() => setContractProfile(store, 'one', 'v3'), TypeError);
  assert.throws(() => setContractProfile(store, 'one', undefined), TypeError);
  assert.deepEqual(read(), original);
});

for (const era of eras)
  test(`${era} HTTP: each client is served its own profile at every request, and a token refresh keeps it`, async t => {
    const s = await oauthStack(t),
      older = await s.connect('Legacy client'),
      newer = await s.connect('Opted-in client');
    // Nothing is on v2 until a profile is set: a freshly authorized client, like every API key, is legacy.
    const key = s.store.createKey({tenantId: 'local', userId: 'script', role: 'operator'}),
      connector = s.store.createKey({tenantId: 'local', userId: 'connector/script', role: 'operator'});
    for (const access of [older.access, newer.access, key, connector])
      assert.equal(await profileOf(await s.client(era, access)), 'legacy');
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'v2'), true);
    const optedIn = await s.client(era, newer.access);
    assert.equal(await profileOf(optedIn), 'v2');
    // The others are as they were: the switch is the client's.
    for (const access of [older.access, key, connector])
      assert.equal(await profileOf(await s.client(era, access)), 'legacy');
    // A switch applies at the client's next request, with the token it already holds, and back again.
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'legacy'), true);
    assert.equal(await profileOf(optedIn), 'legacy');
    assert.equal(setContractProfile(s.store, newer.client.client_id, 'v2'), true);
    assert.equal(await profileOf(optedIn), 'v2');
    // Another credential of the same client, by its refresh token, is the same client: it is v2 as well, and the first
    // client's new token is not.
    const refreshed = await newer.refresh();
    assert.notEqual(refreshed, newer.access);
    assert.equal(await profileOf(await s.client(era, refreshed)), 'v2');
    assert.equal(await profileOf(await s.client(era, await older.refresh())), 'legacy');
    // tools/list is the listing the client's profile is shown, served to both without error.
    assert.ok((await optedIn.listTools()).tools.length > 0);
  });

test('no request chooses its profile: not an argument, a header, a protocol field or a client’s own registration', async t => {
  const s = await oauthStack(t),
    older = await s.connect('Legacy client'),
    // The client names a profile in the metadata it registers with. Registration is anonymous, so this is the request that
    // must not be able to opt itself in.
    sly = await s.connect('Self-declared client', {
      registration: {contract_profile: 'v2', profile: 'v2', 'io.modelcontextprotocol/contractProfile': 'v2'},
    });
  assert.equal(sly.client.contract_profile, undefined);
  assert.equal(JSON.parse(registeredClient(s.store, sly.client.client_id).data).contract_profile, undefined);
  const newer = await s.connect('Opted-in client');
  setContractProfile(s.store, newer.client.client_id, 'v2');
  for (const era of eras) {
    // Arguments of the call name a profile: they are not read, and are reported as arguments the action does not take.
    const asked = await s.client(era, older.access),
      reported = await asked.callTool({
        name: 'amcp_workspace',
        arguments: {...help, profile: 'v2', contract_profile: 'v2'},
      });
    assert.equal(reported.structuredContent.data.profile, 'legacy');
    assert.equal(await profileOf(await s.client(era, sly.access)), 'legacy');
    // ...and an opted-in client cannot ask to be served the other.
    const opted = await s.client(era, newer.access),
      declined = await opted.callTool({
        name: 'amcp_workspace',
        arguments: {...help, profile: 'legacy', contract_profile: 'legacy'},
      });
    assert.equal(declined.structuredContent.data.profile, 'v2');
  }
  // Raw requests naming a profile in headers and in the protocol's own metadata, to the legacy and the modern endpoint.
  const post = (access, headers, meta = {}) =>
    fetch(s.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + access,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'amcp_workspace',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'amcp_workspace',
          arguments: help,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            ...meta,
          },
        },
      }),
    }).then(async response => (await response.json()).result.structuredContent.data.profile);
  const claims = {
      'x-amcp-profile': 'v2',
      'mcp-profile': 'v2',
      'x-contract-profile': 'v2',
      'amcp-contract-profile': 'v2',
    },
    metaClaims = {'amcp/contractProfile': 'v2', contractProfile: 'v2', 'io.modelcontextprotocol/contractProfile': 'v2'};
  assert.equal(await post(older.access, claims, metaClaims), 'legacy');
  assert.equal(await post(sly.access, claims, metaClaims), 'legacy');
  assert.equal(
    await post(newer.access, {'x-amcp-profile': 'legacy', 'mcp-profile': 'legacy'}, {contractProfile: 'legacy'}),
    'v2',
  );
});

test('the website’s own calls, workers and every call outside an MCP request stay legacy, even for an opted-in client’s actor', async t => {
  const s = await oauthStack(t),
    newer = await s.connect('Opted-in client');
  setContractProfile(s.store, newer.client.client_id, 'v2');
  const actor = s.store.authenticate(newer.access);
  assert.equal(actor.userId, 'oauth/' + newer.client.client_id);
  assert.equal(contractProfileOf(s.store, actor), 'v2');
  // The service's own entry, as the website routes and the workers call it, never enters a profile scope.
  const direct = await s.service.call('amcp_workspace', help, actor);
  assert.equal(direct.data.profile, 'legacy');
  // Inside the MCP server's scope the same actor is v2, and the scope ends with the call.
  const scoped = await withContractProfile('v2', () => s.service.call('amcp_workspace', help, actor));
  assert.equal(scoped.data.profile, 'v2');
  assert.equal(currentContractProfile(), 'legacy');
});

test('the help topic announces both profiles, lists what v2 changes, and is found from the tool’s help', async t => {
  const s = await oauthStack(t),
    key = s.store.createKey({tenantId: 'local', userId: 'script', role: 'operator'}),
    call = args => s.service.call('amcp_workspace', args, s.store.authenticate(key));
  const topic = await call(help);
  assert.equal(topic.success, true, JSON.stringify(topic.error));
  const data = topic.data;
  assert.equal(data.profile, 'legacy');
  assert.match(data.meaning, /legacy/);
  assert.match(data.meaning, /v2/);
  assert.match(data.meaning, /no argument, header or protocol field/);
  assert.ok(Array.isArray(data.v2_changes));
  for (const change of data.v2_changes) assert.deepEqual(Object.keys(change).sort(), ['id', 'text']);
  // The tool's help names the topic beside the guides, and an unknown topic is still refused.
  const general = await call({action: 'help'});
  assert.deepEqual(general.data.other_topics, ['guides', 'mcp_profile']);
  assertRefused(await call({action: 'help', topic: 'mcp_profiles'}), 'UNKNOWN_OPERATION');
  // Only the workspace tool has it.
  const other = await s.service.call('amcp_campaign', help, s.store.authenticate(key));
  assertRefused(other, 'UNKNOWN_OPERATION');
});

test('a profile the MCP server cannot read from the store serves the client as it always was', async t => {
  const s = await oauthStack(t),
    newer = await s.connect('Opted-in client');
  setContractProfile(s.store, newer.client.client_id, 'v2');
  const client = await s.client('modern', newer.access);
  assert.equal(await profileOf(client), 'v2');
  // The registration record is damaged: the client is legacy again, the call still answers, and nothing else changed.
  s.store.sql().prepare('UPDATE amcp_mcp_clients SET data=? WHERE id=?').run('{damaged', newer.client.client_id);
  assert.equal(await profileOf(client), 'legacy');
});
