// V2-MCP-13 differential review DR-01 (docs: .runtime/wave5-claude/acceptance/differential-review-sdk-v2.md): the 2026-07-28
// endpoint builds one server per request from AMCP's factory, with the caller in `authInfo`, and the SDK refuses a server that
// is already serving. The property holds by reading; these tests are what fails if a later change caches or shares a server,
// or serves a request without a caller.
//
//  1. Two workspaces' keys send tools/call and resources/read to the real HTTP stack, interleaved and concurrently (15 requests
//     each, alternating, awaited together). Each answer holds only its own workspace's records, and nothing of the other's
//     appears in any answer, error or log line the test can see. Repeated for two members of one workspace whose client access
//     sets differ.
//  2. The server factory refuses a request whose authInfo carries no actor, with the error it throws, and no handler runs.
// Synthetic stores only: the provider transport throws on any request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createModernEndpoint, modernAuthInfo, modernServerFactory} from '../dist/server/mcp-modern.js';
import {serverInstructionsFor} from '../dist/src/tool-annotations.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const gateway = 'meta_native_action';
const version = '2026-07-28';

/** A store with a read-only service whose provider transport refuses every request, served on the real HTTP stack. */
async function stack(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 97).toString('base64')),
    provider = [],
    logs = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async url => {
        provider.push(String(url));
        throw new Error('No provider traffic in an isolation test');
      }),
    );
  t.after(() => store.close());
  const listener = await listenForFetch(
    createHttpApp(service, store, {mcpModernProtocol: 'on', mcpLimits: {perMinute: 0}, log: entry => logs.push(entry)}),
  );
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = 'http://127.0.0.1:' + listener.address().port + '/mcp';
  let sequence = 0;
  /** One 2026-07-28 request over the wire as a client sends it: the headers mirror the method and the name. */
  const rpc = async (key, method, params, headers = {}) => {
    const name = params.name ?? params.uri,
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer ' + key,
          'mcp-protocol-version': version,
          'mcp-method': method,
          ...(name ? {'mcp-name': name} : {}),
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++sequence,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': version,
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': {name: 'Synthetic isolation client', version: '1'},
            },
          },
        }),
      });
    return {status: response.status, text: await response.text()};
  };
  return {store, service, logs, provider, rpc};
}

const connect = (store, tenantId, userId, id, label, accounts) =>
  store.putConnection(
    {tenantId, userId, role: 'admin'},
    {id, tenantId, gateway, accounts, enabled: true, label, scopes: []},
    {accessToken: 'synthetic'},
  );

/** What a tools/call or resources/read answer is, parsed: the JSON-RPC result or error, and the raw text it came as. */
function parsed(response) {
  assert.equal(response.status, 200, response.text.slice(0, 300));
  const body = JSON.parse(response.text);
  return {...body, raw: response.text};
}
const workspace = (operation, args = {}) => ({
  name: 'amcp_platform_workspace',
  arguments: {operation, arguments: args},
});
const guide = 'amcp://guides/index';

/**
 * The calls one caller makes, in the order the loop below cycles them: the context of its workspace, its accounts, a guide,
 * a probe of an account that is not its own (refused), and a guide that does not exist (an error that echoes only the URI).
 */
function calls(self, other) {
  return [
    {
      method: 'tools/call',
      params: workspace('get_workspace_context'),
      check: answer => {
        const data = answer.result.structuredContent.data;
        assert.equal(answer.result.structuredContent.success, true, answer.raw);
        assert.equal(data.workspace.id, self.tenantId);
        assert.equal(data.actor.id, self.user);
        assert.deepEqual(data.connections.map(c => c.id).sort(), self.connections.sort());
        assert.deepEqual(data.connections.flatMap(c => c.accounts).sort(), self.accounts.sort());
        if (self.set) assert.equal(data.access_set.name, self.set);
        else assert.equal(data.access_set, undefined);
      },
    },
    {
      method: 'tools/call',
      params: workspace('list_accounts'),
      check: answer => {
        assert.equal(answer.result.structuredContent.success, true, answer.raw);
        assert.deepEqual(answer.result.structuredContent.data.map(a => a.id).sort(), self.accounts.sort());
      },
    },
    {
      method: 'resources/read',
      params: {uri: guide},
      check: answer => {
        const content = answer.result.contents[0];
        assert.equal(content.uri, guide);
        assert.ok(content.text.length > 100, 'the guide index is served whole');
      },
    },
    {
      // An account of the other caller: refused, and what is refused says nothing of whose it is. The ids are the caller's own
      // input, so they may be echoed; nothing else of the other side may be.
      method: 'tools/call',
      params: {
        name: gateway,
        arguments: {action: 'meta_campaign_list', connection_id: other.connections[0], account_id: other.accounts[0]},
      },
      sent: [other.connections[0], other.accounts[0]],
      check: answer => {
        assert.equal(answer.result.isError, true, answer.raw);
        assert.equal(answer.result.structuredContent.success, false);
        assert.notEqual(answer.result.structuredContent.error.code, 'INTERNAL_ERROR');
      },
    },
    {
      method: 'resources/read',
      params: {uri: 'amcp://guides/no-such-guide-' + self.user},
      sent: ['no-such-guide-' + self.user],
      check: answer => {
        assert.equal(typeof answer.error?.code, 'number', answer.raw);
        assert.equal(answer.error.data.uri, 'amcp://guides/no-such-guide-' + self.user);
      },
    },
  ];
}

/** Every request of both sides, alternating, awaited together; each answer is checked against its own side. */
async function interleaved(f, sides, rounds) {
  const [first, second] = sides,
    pending = [];
  let sent = 0;
  for (let round = 0; round < rounds; round++)
    for (const [self, other] of [
      [first, second],
      [second, first],
    ]) {
      const planned = calls(self, other)[round % 5];
      sent++;
      pending.push(
        f.rpc(self.key, planned.method, planned.params).then(response => {
          const answer = parsed(response);
          planned.check(answer);
          // Nothing of the other side is in what this side was answered, except what this side itself sent.
          const text = planned.sent
            ? planned.sent.reduce((rest, echoed) => rest.replaceAll(echoed, ''), answer.raw)
            : answer.raw;
          for (const marker of other.markers)
            assert.ok(
              !text.includes(marker),
              self.user + ' was answered the other side’s ' + marker + ': ' + answer.raw.slice(0, 400),
            );
          return {side: self.user, method: planned.method, answer};
        }),
      );
    }
  // Requests the endpoint itself refuses leave the log lines the check below reads: a header that does not mirror the body
  // (400) and a key that was revoked (401), once for each side, in the same concurrent batch.
  const refused = [];
  for (const self of sides) {
    const revoked = f.store.createKey({tenantId: self.tenantId, userId: self.user, role: 'reader'});
    f.store.revokeKey(revoked);
    refused.push(
      f.rpc(self.key, 'tools/call', workspace('get_workspace_context'), {'mcp-name': 'another_tool'}),
      f.rpc(revoked, 'tools/call', workspace('get_workspace_context')),
    );
  }
  const [answers, refusals] = await Promise.all([Promise.all(pending), Promise.all(refused)]);
  assert.deepEqual(
    refusals.map(r => r.status),
    [400, 401, 400, 401],
  );
  assert.equal(sent, rounds * 2);
  // The guide is the same text for every caller: nothing of the caller's workspace is in it.
  const guides = answers
    .filter(a => a.method === 'resources/read' && a.answer.result)
    .map(a => a.answer.result.contents[0].text);
  assert.ok(guides.length >= 6);
  assert.equal(new Set(guides).size, 1, 'every caller is served the same guide');
  // Nor is anything of either side in a log line the app or the service wrote, and there are lines to read: the four refusals.
  assert.ok(f.logs.length >= 4, 'the refusals left log lines: ' + f.logs.length);
  for (const entry of f.logs)
    for (const marker of [...first.markers, ...second.markers])
      assert.ok(!JSON.stringify(entry).includes(marker), 'a log line holds ' + marker + ': ' + JSON.stringify(entry));
  assert.equal(f.provider.length, 0, 'no provider request was sent');
  return answers;
}

test('two workspaces’ keys interleaved and concurrent on the 2026-07-28 endpoint: each answer holds only its own workspace', async t => {
  const f = await stack(t),
    sides = [
      {
        tenantId: 'workspace-alpha-4471',
        user: 'alpha-owner-4471',
        label: 'Alpha Retail Holdings',
        connections: ['login-alpha-4471'],
        accounts: ['4471000111'],
      },
      {
        tenantId: 'workspace-bravo-9902',
        user: 'bravo-owner-9902',
        label: 'Bravo Logistics Group',
        connections: ['login-bravo-9902'],
        accounts: ['9902000222'],
      },
    ];
  for (const side of sides) {
    connect(f.store, side.tenantId, side.user, side.connections[0], side.label, side.accounts);
    side.key = f.store.createKey({tenantId: side.tenantId, userId: side.user, role: 'reader'});
    side.markers = [side.tenantId, side.user, side.label, ...side.connections, ...side.accounts];
  }
  const answers = await interleaved(f, sides, 15);
  assert.equal(answers.filter(a => a.side === sides[0].user).length, 15);
  assert.equal(answers.filter(a => a.side === sides[1].user).length, 15);
  // Each side's refused probe was refused, never an answer about the other workspace.
  assert.ok(answers.some(a => a.answer.result?.isError === true));
});

test('two members of one workspace with different client access sets, interleaved and concurrent: each sees only its own set', async t => {
  const f = await stack(t),
    tenantId = 'workspace-shared-5530',
    admin = {tenantId, userId: 'shared-admin-5530', role: 'admin'};
  connect(f.store, tenantId, admin.userId, 'login-north-5530', 'North Region Accounts', ['5530000111']);
  connect(f.store, tenantId, admin.userId, 'login-south-5530', 'South Region Accounts', ['5530000222']);
  const bind = (connection, account) => ({gateway, connection_id: connection, account_id: account}),
    north = saveAccessSet(f.store, admin, {
      name: 'North Client Only',
      bindings: [bind('login-north-5530', '5530000111')],
    }),
    south = saveAccessSet(f.store, admin, {
      name: 'South Client Only',
      bindings: [bind('login-south-5530', '5530000222')],
    });
  const sides = [
    {
      tenantId,
      user: 'north-member-5530',
      set: 'North Client Only',
      connections: ['login-north-5530'],
      accounts: ['5530000111'],
      key: f.store.createKey({tenantId, userId: 'north-member-5530', role: 'operator', accessSetId: String(north.id)}),
      // What each side must never be told of the other's set.
      markers: ['North Client Only', 'North Region Accounts', 'login-north-5530', '5530000111', 'north-member-5530'],
    },
    {
      tenantId,
      user: 'south-member-5530',
      set: 'South Client Only',
      connections: ['login-south-5530'],
      accounts: ['5530000222'],
      key: f.store.createKey({tenantId, userId: 'south-member-5530', role: 'operator', accessSetId: String(south.id)}),
      markers: ['South Client Only', 'South Region Accounts', 'login-south-5530', '5530000222', 'south-member-5530'],
    },
  ];
  const answers = await interleaved(f, sides, 15);
  assert.equal(answers.filter(a => a.side === sides[0].user).length, 15);
  assert.equal(answers.filter(a => a.side === sides[1].user).length, 15);
});

// The factory itself. The SDK calls it once per request with the caller AMCP authenticated in `authInfo`; a request without
// one is refused rather than served as someone, so no handler can run without an actor.
const refusal = 'A modern MCP request needs the caller AMCP authenticated.';
const noActor = [
  ['no authInfo at all', undefined],
  ['authInfo without extra', {token: '', clientId: 'someone', scopes: []}],
  ['an extra without an actor', {token: '', clientId: 'someone', scopes: [], extra: {}}],
  ['an actor that is null', {token: '', clientId: 'someone', scopes: [], extra: {actor: null}}],
  ['an actor that is a string', {token: '', clientId: 'someone', scopes: [], extra: {actor: 'tenant-a'}}],
  ['an extra that is a string', {token: '', clientId: 'someone', scopes: [], extra: 'actor'}],
];

test('the modern server factory refuses a request whose authInfo carries no actor, with the error it throws', async t => {
  const f = await stack(t),
    factory = modernServerFactory(f.service),
    actor = {tenantId: 'workspace-alpha-4471', userId: 'alpha-owner-4471', role: 'reader'};
  for (const [name, authInfo] of noActor)
    assert.throws(() => factory({era: 'modern', authInfo}), {message: refusal}, name);
  // The positive control: an actor builds a server, and it is a new one for every request.
  const one = factory({era: 'modern', authInfo: modernAuthInfo(actor)}),
    another = factory({era: 'modern', authInfo: modernAuthInfo(actor)});
  assert.notEqual(one, another);
  await Promise.all([one.close(), another.close()]);
});

test('a request without a caller reaches no handler: the endpoint answers an error and nothing runs', async t => {
  const f = await stack(t),
    ran = [];
  // Everything a handler would do for a caller goes through one of these; none may run.
  const call = f.service.call.bind(f.service),
    list = f.service.listTools.bind(f.service),
    active = f.store.assertActorActive.bind(f.store);
  f.service.call = (...args) => (ran.push('call'), call(...args));
  f.service.listTools = (...args) => (ran.push('listTools'), list(...args));
  f.store.assertActorActive = (...args) => (ran.push('assertActorActive'), active(...args));
  const errors = [],
    endpoint = createModernEndpoint({
      factory: modernServerFactory(f.service),
      instructions: serverInstructionsFor(f.service.policy),
      onerror: error => errors.push(error.message),
    });
  t.after(() => endpoint.close());
  let id = 0;
  const post = (method, params, authInfo) => {
    const name = params.name ?? params.uri,
      message = {
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      };
    return endpoint.handle(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': version,
          'mcp-method': method,
          ...(name ? {'mcp-name': name} : {}),
        },
        body: JSON.stringify(message),
      }),
      {
        headers: {'mcp-protocol-version': version, 'mcp-method': method, ...(name ? {'mcp-name': name} : {})},
        message,
        authInfo,
      },
    );
  };
  for (const [name, authInfo] of noActor)
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', workspace('get_workspace_context')],
      ['resources/read', {uri: guide}],
    ]) {
      const response = await post(method, params, authInfo),
        body = await response.text();
      // An error answer, never a result: the caller got nothing of any workspace.
      assert.ok(
        response.status >= 400,
        name + ' ' + method + ' answered ' + response.status + ': ' + body.slice(0, 200),
      );
      assert.equal(JSON.parse(body).result, undefined, name + ' ' + method);
      assert.equal(typeof JSON.parse(body).error?.code, 'number', name + ' ' + method);
    }
  assert.deepEqual(ran, [], 'no handler ran for a request without a caller');
  assert.ok(errors.length > 0 && errors.every(message => message.includes(refusal)), JSON.stringify(errors));
  // The control: the same endpoint serves the same request for a caller, and then the handlers do run.
  const actor = {tenantId: 'workspace-alpha-4471', userId: 'alpha-owner-4471', role: 'reader'},
    served = await post('tools/list', {}, modernAuthInfo(actor));
  assert.equal(served.status, 200);
  assert.ok(ran.includes('listTools'));
});
