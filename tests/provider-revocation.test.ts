// CON-05 sub-item 10 (review 2026-10-08, owner decision D19 (4)): disconnect was local only, so a person who removed a
// login from AMCP still had to find and revoke AMCP's grant in each provider's settings. An administrator may now also
// ask Google to revoke the login's token, as a separate, explicitly confirmed choice. It is off unless the deployment
// owner sets AMCP_PROVIDER_REVOCATION=on, because Google revokes one OAuth client's grant for a Google account as a
// whole and every AMCP Google login shares that client (Q25: the owner tests that with disposable logins first). All
// provider answers below come from synthetic fetchers; no request leaves the process.
import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {
  disconnectWithProviderRevocation,
  providerRevocationOffer,
  revokeProviderToken,
  revocationTarget,
} from '../src/provider-revocation.js';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import {MirrorError} from '../src/errors.js';
import {assertRefused} from './helpers/assert-refused.js';
import type {Connection} from '../src/types.js';

const master = Buffer.alloc(32, 91).toString('base64'),
  password = 'synthetic-revocation-password',
  origin = 'https://amcp.shop',
  owner = {tenantId: 'local', userId: 'tester', role: 'admin' as const},
  refreshToken = 'synthetic-refresh-token-value-0001',
  accessToken = 'synthetic-access-token-value-0001';
const google: Connection = {
  id: 'synthetic-google',
  tenantId: 'local',
  gateway: 'google_ads_native_action',
  accounts: ['1234567890'],
  enabled: true,
  label: 'Synthetic Google',
  scopes: ['https://www.googleapis.com/auth/adwords'],
};
const meta: Connection = {
  id: 'synthetic-meta',
  tenantId: 'local',
  gateway: 'meta_native_action',
  accounts: ['111'],
  enabled: true,
  label: 'Synthetic Meta',
  scopes: ['ads_read'],
};
interface Sent {
  url: string;
  method: string;
  body: string;
  contentType: string | null;
  redirect: RequestRedirect | undefined;
}
async function site(
  env: NodeJS.ProcessEnv,
  answer: (sent: Sent) => Response | Promise<Response>,
  {testPassword}: {testPassword?: string} = {},
) {
  const sent: Sent[] = [],
    fetcher: typeof fetch = async (url, init) => {
      const request = {
        url: String(url),
        method: String(init?.method ?? 'GET'),
        body: String(init?.body ?? ''),
        contentType: new Headers(init?.headers).get('content-type'),
        redirect: init?.redirect,
      };
      sent.push(request);
      return answer(request);
    };
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store),
    listener = await listenForFetch(
      createHttpApp(service, store, {
        website: {
          origin,
          masterKey: master,
          adminPassword: password,
          ...(testPassword ? {testPassword} : {}),
          fetcher,
          authEnv: env,
        },
      }),
    );
  store.putConnection(owner, google, {accessToken, refreshToken});
  store.putConnection(owner, meta, {accessToken: 'synthetic-meta-token'});
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {Origin: origin, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, json: (await response.json()) as any};
  };
  const signIn = async (path: string, secret: string) => {
    const login = await fetch(base + path, {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: secret}),
    });
    return {Cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'X-AMCP-CSRF': ((await login.json()) as any).csrf};
  };
  const headers = await signIn('/api/session', password);
  const audit = () =>
    (store.db.prepare('SELECT event FROM audit ORDER BY seq').all() as {event: string}[]).map(r => r.event).join('\n');
  const ids = (tenant = 'local') => store.listConnections(tenant).map(c => c.id);
  return {
    store,
    sent,
    audit,
    ids,
    disconnect: (id: string, body?: unknown) => request('/api/connections/' + id, 'DELETE', body, headers),
    platforms: () => request('/api/platforms', 'GET', undefined, headers),
    anonymousPlatforms: () => request('/api/platforms'),
    /** The shared reviewer door (AMCP_TEST_PASSWORD): its workspace and the requests of its session. */
    reviewer: async () => {
      const reviewerHeaders = await signIn('/api/session/test', testPassword!);
      return {
        disconnect: (id: string, body?: unknown) => request('/api/connections/' + id, 'DELETE', body, reviewerHeaders),
        platforms: () => request('/api/platforms', 'GET', undefined, reviewerHeaders),
      };
    },
    close: async () => {
      const closed = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}
const unreachable = () => {
  throw Error('Unexpected provider egress');
};

test('by default disconnect stays local: revocation is refused before any token read or request', async () => {
  const s = await site({}, unreachable);
  try {
    const listed = (await s.platforms()).json.platforms;
    assert.deepEqual(listed.find((p: any) => p.gateway === 'google_ads_native_action').provider_revocation, {
      available: false,
      reason: 'deployment_off',
      provider: 'google',
      shared_client: true,
    });
    assert.equal(
      listed.find((p: any) => p.gateway === 'meta_native_action').provider_revocation.reason,
      'provider_not_supported',
    );
    // A visitor without a session is not told how the deployment is configured.
    const anonymous = (await s.anonymousPlatforms()).json.platforms;
    assert.ok(anonymous.length > 0);
    assert.ok(anonymous.every((p: any) => !('provider_revocation' in p)));
    const refused = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(refused.status, 409);
    assertRefused(refused.json.error, 'PROVIDER_REVOCATION_DISABLED');
    assert.deepEqual(s.ids().sort(), [google.id, meta.id].sort(), 'the login stays');
    assert.equal(s.sent.length, 0);
    const invalid = await s.disconnect(google.id, {revoke_at_provider: 'yes'});
    assert.equal(invalid.status, 400);
    assertRefused(invalid.json.error, 'INVALID_ARGUMENT');
    // The ordinary disconnect is unchanged: local only, no provider request.
    const local = await s.disconnect(google.id);
    assert.equal(local.status, 200);
    assert.deepEqual(local.json, {success: true});
    assert.deepEqual(s.ids(), [meta.id]);
    assert.equal(s.sent.length, 0);
    const plain = s.store.documents('local', 'connection_disconnection')[0]!;
    assert.match(plain.effect, /provider OAuth grants are unchanged\.$/);
    assert.equal(plain.provider_revocation, undefined);
    assert.equal(plain.network_requests, 0);
  } finally {
    await s.close();
  }
});

test('when the owner turns it on, a confirmed revocation sends the refresh token once in the body, then disconnects', async () => {
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, () => new Response('', {status: 200}));
  try {
    const offer = (await s.platforms()).json.platforms.find(
      (p: any) => p.gateway === 'google_ads_native_action',
    ).provider_revocation;
    assert.equal(offer.available, true);
    const done = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(done.json, {
      success: true,
      provider_revocation: {provider: 'google', shared_client: true, outcome: 'revoked', status: 200},
    });
    assert.equal(s.sent.length, 1);
    const [sent] = s.sent;
    assert.equal(sent!.url, 'https://oauth2.googleapis.com/revoke', 'the token is never in the URL');
    assert.equal(sent!.method, 'POST');
    assert.equal(sent!.contentType, 'application/x-www-form-urlencoded');
    assert.equal(sent!.body, 'token=' + refreshToken);
    assert.equal(sent!.redirect, 'manual');
    assert.deepEqual(s.ids(), [meta.id]);
    const receipt = s.store.documents('local', 'connection_disconnection')[0]!;
    assert.equal(receipt.provider_revocation.outcome, 'revoked');
    assert.equal(receipt.network_requests, 1);
    assert.equal(receipt.provider_changes, 1);
    // The receipt no longer says the provider grant is unchanged once AMCP asked the provider to revoke it.
    assert.doesNotMatch(receipt.effect, /provider OAuth grants are unchanged/);
    assert.match(receipt.effect, /also asked to revoke this login’s OAuth grant/);
    assert.match(receipt.effect, /share its OAuth client may lose access too/);
    // Audited before it was sent, then its outcome; no token anywhere in the trail or the receipt.
    const trail = s.audit();
    assert.ok(trail.indexOf('provider_revocation_requested') < trail.indexOf('provider_revocation_result'));
    assert.match(trail, /"outcome":"revoked"/);
    assert.doesNotMatch(
      trail + JSON.stringify(receipt) + JSON.stringify(done.json),
      /synthetic-(refresh|access)-token/,
    );
  } finally {
    await s.close();
  }
});

test('a token Google reports already invalid still disconnects, and says so', async () => {
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, () =>
    Response.json({error: 'invalid_token', error_description: 'Token expired or revoked'}, {status: 400}),
  );
  try {
    const done = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(done.status, 200);
    assert.equal(done.json.provider_revocation.outcome, 'token_already_invalid');
    assert.deepEqual(s.ids(), [meta.id]);
    assert.equal(s.store.documents('local', 'connection_disconnection')[0]!.provider_changes, 0);
  } finally {
    await s.close();
  }
});

for (const [name, answer, outcome] of [
  ['an unconfirmed answer', () => new Response('busy', {status: 503}), 'refused'],
  ['a redirect', () => new Response(null, {status: 302, headers: {Location: 'https://example.invalid/'}}), 'refused'],
  [
    'a lost response',
    () => {
      throw new TypeError('fetch failed');
    },
    'unknown',
  ],
] as const)
  test('after ' + name + ' AMCP keeps the login, so the administrator can retry or disconnect locally', async () => {
    const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, answer);
    try {
      const refused = await s.disconnect(google.id, {revoke_at_provider: true});
      assert.equal(refused.status, 502);
      assertRefused(refused.json.error, 'PROVIDER_REVOCATION_FAILED');
      assert.deepEqual(s.ids().sort(), [google.id, meta.id].sort());
      assert.match(s.audit(), new RegExp('"outcome":"' + outcome + '"'));
      assert.doesNotMatch(JSON.stringify(refused.json), /synthetic-(refresh|access)-token/);
      const local = await s.disconnect(google.id);
      assert.equal(local.status, 200);
      assert.deepEqual(s.ids(), [meta.id]);
      assert.equal(s.sent.length, 1, 'the local disconnect sends nothing');
    } finally {
      await s.close();
    }
  });

test('logins of a provider AMCP does not revoke at are refused without a request, even when it is on', async () => {
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, unreachable);
  try {
    const refused = await s.disconnect(meta.id, {revoke_at_provider: true});
    assert.equal(refused.status, 409);
    assertRefused(refused.json.error, 'PROVIDER_REVOCATION_UNAVAILABLE');
    assert.deepEqual(s.ids().sort(), [google.id, meta.id].sort());
    assert.equal(s.sent.length, 0);
  } finally {
    await s.close();
  }
});

// Everyone with the shared reviewer password manages the same logins, so one evaluator could otherwise end another
// evaluator's Google grant, in that person's own workspaces too. Test accounts keep the local disconnect only, like
// every capability the test-account allow-list does not name.
test('a test account is never offered revocation and is refused before the token is read; it still disconnects', async () => {
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, unreachable, {testPassword: 'synthetic-reviewer-door-0001'});
  try {
    const reviewers = 'local-test',
      reviewerGoogle = {...google, id: 'synthetic-reviewer-google', tenantId: reviewers};
    s.store.ensureTenant(reviewers);
    s.store.putConnection({tenantId: reviewers, userId: 'synthetic', role: 'admin'}, reviewerGoogle, {
      accessToken,
      refreshToken,
    });
    let reads = 0;
    const original = s.store.credentials.bind(s.store);
    s.store.credentials = (tenant: string, id: string) => {
      if (id === reviewerGoogle.id) reads++;
      return original(tenant, id);
    };
    const reviewer = await s.reviewer();
    const offer = (await reviewer.platforms()).json.platforms.find(
      (p: any) => p.gateway === 'google_ads_native_action',
    ).provider_revocation;
    assert.deepEqual(offer, {available: false, reason: 'test_account', provider: 'google', shared_client: true});
    // Counted from here: the Connections listing reads a Google Ads login to describe its authorization.
    reads = 0;
    const refused = await reviewer.disconnect(reviewerGoogle.id, {revoke_at_provider: true});
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assertRefused(refused.json.error, 'TEST_ACCOUNT_SCOPE');
    assert.match(refused.json.error.message, /^A test account cannot revoke logins at the provider\./);
    assert.equal(reads, 0, 'the token was never read');
    assert.equal(s.sent.length, 0);
    assert.deepEqual(s.ids(reviewers), [reviewerGoogle.id], 'the login stays');
    assert.doesNotMatch(s.audit(), /provider_revocation/);
    const local = await reviewer.disconnect(reviewerGoogle.id);
    assert.equal(local.status, 200);
    assert.deepEqual(local.json, {success: true});
    assert.deepEqual(s.ids(reviewers), []);
    assert.equal(s.sent.length, 0);
    // The owner workspace is untouched and still offered revocation.
    assert.deepEqual(s.ids().sort(), [google.id, meta.id].sort());
    const owners = (await s.platforms()).json.platforms.find((p: any) => p.gateway === 'google_ads_native_action');
    assert.equal(owners.provider_revocation.available, true);
  } finally {
    await s.close();
  }
});

test('only an administrator may revoke, refused before the token is read; every Google login shares the client', async () => {
  const store = new Store(':memory:', master);
  try {
    store.putConnection(owner, google, {accessToken, refreshToken});
    let reads = 0;
    const original = store.credentials.bind(store);
    store.credentials = (tenant: string, id: string) => {
      reads++;
      return original(tenant, id);
    };
    await assert.rejects(
      disconnectWithProviderRevocation(store, {...owner, role: 'operator'}, google.gateway, google.id, {
        env: {AMCP_PROVIDER_REVOCATION: 'on'},
        fetcher: unreachable,
      }),
      e => assertRefused(e, 'FORBIDDEN', {status: 403}),
    );
    assert.equal(reads, 0);
    for (const gateway of [
      'google_ads_native_action',
      'ga4_native_action',
      'gtm_native_action',
      'google_search_console_native_action',
      'dv360_native_action',
      'google_business_native_action',
      'google_sheets_native_action',
      'google_drive_native_action',
    ])
      assert.equal(revocationTarget(gateway)?.shared_client, true, gateway);
    for (const gateway of [
      'meta_native_action',
      'tiktok_native_action',
      'linkedin_native_action',
      'microsoft_ads_native_action',
    ])
      assert.equal(revocationTarget(gateway), undefined, gateway);
    assert.equal(providerRevocationOffer('ga4_native_action', {AMCP_PROVIDER_REVOCATION: 'true'}).available, false);
    assert.equal(providerRevocationOffer('ga4_native_action', {AMCP_PROVIDER_REVOCATION: 'on'}).available, true);
    assert.deepEqual(
      providerRevocationOffer('ga4_native_action', {AMCP_PROVIDER_REVOCATION: 'on'}, {testAccount: true}),
      {
        available: false,
        reason: 'test_account',
        provider: 'google',
        shared_client: true,
      },
    );
    // An access token is revoked when the login holds no refresh token (Google then revokes its grant too).
    const sent: string[] = [];
    const result = await revokeProviderToken(
      revocationTarget('ga4_native_action')!,
      accessToken,
      async (_url, init) => {
        sent.push(String(init?.body));
        return new Response('{}', {status: 200});
      },
    );
    assert.deepEqual(result, {outcome: 'revoked', status: 200});
    assert.deepEqual(sent, ['token=' + accessToken]);
  } finally {
    store.close();
  }
});

// Fenced on the login revision (CON-01): the token sent was read from one login. Before this fence, a login
// reauthorized while Google answered was deleted with its new, never-revoked token and a receipt that said "revoked".
test('a login reauthorized while Google answers is kept with its new token; a routine token refresh is no change', async () => {
  let during = () => {};
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, () => {
    during();
    return new Response('', {status: 200});
  });
  try {
    during = () =>
      s.store.putConnection(owner, google, {
        accessToken: 'synthetic-access-token-value-0002',
        refreshToken: 'synthetic-refresh-token-value-0002',
      });
    const changed = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(changed.status, 409, JSON.stringify(changed.json));
    assertRefused(changed.json.error, 'CONNECTION_CHANGED');
    assert.match(changed.json.error.message, /reauthorized while AMCP asked the provider to revoke its previous token/);
    assert.deepEqual(s.ids().sort(), [google.id, meta.id].sort(), 'the reauthorized login stays');
    assert.equal(s.store.credentials('local', google.id).refreshToken, 'synthetic-refresh-token-value-0002');
    assert.equal(s.sent[0]!.body, 'token=' + refreshToken, 'only the previous token was sent');
    assert.deepEqual(s.store.documents('local', 'connection_disconnection'), []);
    const trail = s.audit();
    assert.match(trail, /provider_revocation_requested/);
    assert.match(trail, /"login_revision":0/);
    assert.match(trail, /provider_revocation_result/);
    assert.doesNotMatch(trail, /website_local_disconnect/);
    assert.doesNotMatch(trail + JSON.stringify(changed.json), /synthetic-(refresh|access)-token/);
    // Deciding again sends the current token and disconnects.
    during = () => {};
    const again = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(s.sent[1]!.body, 'token=synthetic-refresh-token-value-0002');
    assert.deepEqual(s.ids(), [meta.id]);
  } finally {
    await s.close();
  }
  // AMCP's own refresh keeps the login revision, so it never blocks the disconnect.
  const r = await site({AMCP_PROVIDER_REVOCATION: 'on'}, () => {
    during();
    return new Response('', {status: 200});
  });
  try {
    during = () => {
      const stored = r.store.listConnections('local').find(c => c.id === google.id)!,
        held = r.store.credentials('local', google.id);
      r.store.completeCredentialRefresh(stored, held, {...held, accessToken: 'synthetic-access-token-value-refreshed'});
    };
    const done = await r.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.provider_revocation.outcome, 'revoked');
    assert.deepEqual(r.ids(), [meta.id]);
  } finally {
    await r.close();
  }
});

test('a token goes only to its own provider: a gateway that does not match the stored login is refused unsent', async () => {
  const store = new Store(':memory:', master),
    sent: string[] = [];
  try {
    store.putConnection(owner, meta, {accessToken: 'synthetic-meta-token'});
    await assert.rejects(
      disconnectWithProviderRevocation(store, owner, 'google_ads_native_action', meta.id, {
        env: {AMCP_PROVIDER_REVOCATION: 'on'},
        fetcher: async url => {
          sent.push(String(url));
          return new Response('', {status: 200});
        },
      }),
      e => assertRefused(e, 'CONNECTION_NOT_FOUND', {status: 404}),
    );
    assert.deepEqual(sent, []);
    assert.deepEqual(
      store.listConnections('local').map(c => c.id),
      [meta.id],
    );
    const events = (store.db.prepare('SELECT event FROM audit').all() as {event: string}[]).map(r => r.event).join();
    assert.doesNotMatch(events, /provider_revocation/);
  } finally {
    store.close();
  }
});

test('a login disconnected by another request while Google answers reports this revocation with that receipt', async () => {
  let during = () => {};
  const s = await site({AMCP_PROVIDER_REVOCATION: 'on'}, () => {
    during();
    return new Response('', {status: 200});
  });
  try {
    during = () => disconnectLocalConnection(s.store, owner, google.gateway, google.id, 'website');
    const done = await s.disconnect(google.id, {revoke_at_provider: true});
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(done.json.provider_revocation, {
      provider: 'google',
      shared_client: true,
      outcome: 'revoked',
      status: 200,
    });
    assert.deepEqual(s.ids(), [meta.id]);
    assert.match(s.audit(), /"outcome":"revoked"/);
  } finally {
    await s.close();
  }
});

// Before, the whole answer was read into memory and only then cut to 4 KB (an endless answer never finished).
test('an oversized provider answer is read only to its first 4 KB', async () => {
  let pulled = 0;
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulled > 4096) return controller.close();
      controller.enqueue(new Uint8Array(1024).fill(120));
    },
  });
  const result = await revokeProviderToken(
    revocationTarget('ga4_native_action')!,
    accessToken,
    async () => new Response(oversized, {status: 400}),
  );
  assert.deepEqual(result, {outcome: 'refused', status: 400});
  assert.ok(pulled < 16, 'pulled ' + pulled + ' chunks of 1 KB');
  // A bounded invalid_token answer is still recognized.
  assert.deepEqual(
    await revokeProviderToken(revocationTarget('ga4_native_action')!, accessToken, async () =>
      Response.json({error: 'invalid_token'}, {status: 400}),
    ),
    {outcome: 'token_already_invalid', status: 400},
  );
});

test('a session check that fails after Google answered keeps the login and reports what Google did', async () => {
  // Regression (wave 3a review): the session and CSRF recheck after Google's answer threw its own error, which dropped
  // provider_revocation; the login was kept while its access at Google was already gone, and only the audit said so.
  const store = new Store(':memory:', master),
    env = {AMCP_PROVIDER_REVOCATION: 'on'},
    sent: string[] = [];
  try {
    store.putConnection(owner, google, {accessToken, refreshToken});
    const fetcher = (answer: () => Response): typeof fetch =>
      (async (url: unknown) => {
        sent.push(String(url));
        return answer();
      }) as typeof fetch;
    const stale = () => {
      throw new MirrorError('REAUTH_REQUIRED', 'Confirm it’s you to continue.', {}, 403);
    };
    await assert.rejects(
      disconnectWithProviderRevocation(store, owner, google.gateway, google.id, {
        env,
        fetcher: fetcher(() => new Response('', {status: 200})),
        recheck: stale,
      }),
      (e: MirrorError) => {
        assertRefused(e, 'REAUTH_REQUIRED', {status: 403});
        assert.deepEqual(e.details.provider_revocation, {
          provider: 'google',
          shared_client: true,
          outcome: 'revoked',
          status: 200,
        });
        return true;
      },
    );
    assert.deepEqual(
      store.listConnections('local').map(c => c.id),
      [google.id],
      'the login is kept, as for any refusal',
    );
    // Signed in again, the retry finds the token already invalid at Google and disconnects.
    const retried = await disconnectWithProviderRevocation(store, owner, google.gateway, google.id, {
      env,
      fetcher: fetcher(() => Response.json({error: 'invalid_token'}, {status: 400})),
      recheck: () => {},
    });
    assert.equal((retried.provider_revocation as {outcome: string}).outcome, 'token_already_invalid');
    assert.deepEqual(store.listConnections('local'), []);
    assert.equal(sent.length, 2);
  } finally {
    store.close();
  }
});
