// r25-admin-email, review S4-9 (the lead's follow-up of 2026-11-22): a client names itself, and the Owner confirmation puts that
// name inside a sentence ("I confirm that {name}, returning to {host}, gets owner access to this workspace."). A name that
// carries Unicode format characters (a right-to-left override, embeddings, isolates, marks, zero-width characters, a byte-order
// mark) or control characters can reorder that sentence or disguise it, so the consent screen shows the name without them,
// and so do the audit rows of the decision. One test per place the name enters, so removing the stripping from any one of
// them is noticed: registration, a metadata document, and what the consent screen shows (an older client's stored name).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {insertRegisteredClient} from '../src/mcp-client-repository.js';
import {clientDisplayText} from '../server/client-metadata.js';
import {adminAddress, origin, site, type Site} from './helpers/admin-email-site.js';
import type {LinkRequest} from '../src/media-link.js';
import type {JsonObject} from '../src/types.js';

const redirect = 'https://claude.ai/api/mcp/auth_callback',
  documentUrl = 'https://client.example.com/oauth/amcp-client.json';
/** A name that tries everything: an override, an isolate pair, a mark, a zero-width space, a control character and a BOM. */
const hostile = 'Trusted‮ App⁦ (beta)⁩‏​\u0007﻿',
  clean = 'Trusted App (beta)';
const formatOrControl = /[\p{Cc}\p{Cf}]/u;

/** Starts an authorization for `clientId` and returns what the consent screen's server answers for the signed-in owner. */
async function consentFor(f: Site, clientId: string, headers: Record<string, string>) {
  const verifier = randomBytes(48).toString('base64url');
  const start = await f.request(
    '/authorize?' +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: 'mcp:read mcp:write',
        state: 'synthetic-state',
        resource: origin + '/mcp',
      }),
  );
  assert.equal(start.status, 303, await start.clone().text());
  const request = new URL(start.headers.get('location')!).searchParams.get('request')!;
  const info = (await (
    await f.request('/api/mcp/consent?request=' + encodeURIComponent(request), 'GET', undefined, headers)
  ).json()) as JsonObject;
  return {request, info};
}
const register = async (f: Site, name: unknown) => {
  const response = await f.request('/register', 'POST', {
    ...(name === undefined ? {} : {client_name: name}),
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp:read mcp:write',
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as JsonObject;
};

test('a client registered with a hostile name is stored, shown and audited without the format and control characters', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    await f.deploymentOwner();
    const owner = await f.signedIn('owner@example.test');
    const client = await register(f, hostile);
    assert.equal(client.client_name, clean, 'the registration answers with the name as it is kept');
    const stored = JSON.parse(
      (f.store.db.prepare('SELECT data FROM amcp_mcp_clients WHERE id=?').get(client.client_id) as JsonObject).data,
    );
    assert.equal(stored.client_name, clean);
    const {request, info} = await consentFor(f, String(client.client_id), owner);
    assert.equal(info.name, clean, 'the consent screen names the client without them');
    assert.ok(!formatOrControl.test(String(info.name)));
    // The host shown beside the name is the registered redirect's own, plain.
    assert.equal(info.redirectHost, 'claude.ai');
    // The decision's audit row carries the name as shown.
    const decided = await f.request('/api/mcp/consent', 'POST', {request, approved: false}, owner);
    assert.equal(decided.status, 200);
    const denied = f.events().filter(e => e.event === 'mcp_oauth_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.client_name, clean);
  } finally {
    await f.close();
  }
});

test('a name with nothing visible left is shown as the generic client name', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    await f.deploymentOwner();
    const owner = await f.signedIn('owner@example.test');
    const client = await register(f, '‮⁦⁩​\u0007﻿  ');
    assert.equal(client.client_name, 'MCP client');
    assert.equal((await consentFor(f, String(client.client_id), owner)).info.name, 'MCP client');
  } finally {
    await f.close();
  }
});

test('the consent screen strips the name of a client registered before this stripping existed', async () => {
  const f = await site({adminEmail: adminAddress, allowWrites: true});
  try {
    await f.deploymentOwner();
    const owner = await f.signedIn('owner@example.test'),
      id = randomUUID();
    // What an earlier release stored: the name exactly as the client sent it.
    insertRegisteredClient(
      f.store,
      id,
      JSON.stringify({
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: hostile,
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mcp:read mcp:write',
      }),
    );
    const {info} = await consentFor(f, id, owner);
    assert.equal(info.name, clean);
    assert.ok(!formatOrControl.test(String(info.name)));
  } finally {
    await f.close();
  }
});

test('a client identified by a metadata document is kept and shown without the format and control characters', async () => {
  const request: LinkRequest = async () =>
    new Response(
      JSON.stringify({
        client_id: documentUrl,
        client_name: hostile,
        redirect_uris: [redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      {headers: {'content-type': 'application/json', 'cache-control': 'max-age=60'}},
    );
  const f = await site({adminEmail: adminAddress, allowWrites: true, mcpClientMetadata: {request}});
  try {
    await f.deploymentOwner();
    const owner = await f.signedIn('owner@example.test');
    const {info} = await consentFor(f, documentUrl, owner);
    assert.equal(info.name, clean);
    assert.equal(info.clientMetadataHost, 'client.example.com');
    // The name the authorization request keeps was already stripped when the document was read.
    const kept = JSON.parse(
      (
        f.store.db
          .prepare("SELECT data FROM amcp_mcp_grants WHERE kind='request' AND client_id=?")
          .get(documentUrl) as JsonObject
      ).data,
    );
    assert.equal(kept.clientName, clean);
  } finally {
    await f.close();
  }
});

test('clientDisplayText removes control and format characters and nothing else, and falls back when nothing visible is left', () => {
  // Removed: bidirectional embeddings, overrides, isolates and marks, zero-width characters, a soft hyphen, the Arabic
  // letter mark, a byte-order mark, a tag character (outside the first plane), and control characters (C0, DEL, C1).
  const removed = [
    '\u202A',
    '\u202B',
    '\u202C',
    '\u202D',
    '\u202E',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u200E',
    '\u200F',
    '\u061C',
    '\u200B',
    '\u200C',
    '\u200D',
    '\u2060',
    '\u00AD',
    '\uFEFF',
    '\u{E0041}',
    '\u0000',
    '\u0007',
    '\t',
    '\n',
    '\r',
    '\u007F',
    '\u0085',
  ];
  for (const character of removed) {
    assert.equal(clientDisplayText('A' + character + 'B', 'fallback'), 'AB', JSON.stringify(character));
    assert.equal(clientDisplayText(character + 'Claude' + character, 'fallback'), 'Claude');
  }
  // Kept: ordinary text of any script, spaces, punctuation and emoji; a host with its port.
  for (const text of [
    'Claude Code',
    'عميل الذكاء الاصطناعي',
    '代理客户端',
    'Café (beta) #2',
    'client.example.com:8443',
  ])
    assert.equal(clientDisplayText(text, 'fallback'), text);
  // Nothing visible left: the fallback. Anything that is no text is read as text, as before.
  assert.equal(clientDisplayText('\u202E\u2066\u200B \u0007\uFEFF', 'MCP client'), 'MCP client');
  assert.equal(clientDisplayText(undefined, 'MCP client'), 'MCP client');
  assert.equal(clientDisplayText(null, 'MCP client'), 'MCP client');
  assert.equal(clientDisplayText('', 'MCP client'), 'MCP client');
  assert.equal(clientDisplayText(12345, 'MCP client'), '12345');
  assert.equal(clientDisplayText('\u200B', ''), '');
});
