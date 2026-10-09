// SEC-03: anyone who knew an email address could keep that person out of password sign-in (10 failures per 15 minutes)
// and stop their reset and registration emails (5 requests), because the per-identity counter was checked before the
// password for every client. A browser that already signed in as the person now has its own budget, and email flows
// at the per-email cap answer the same without sending.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts, accountLimitMessage, hashUserPassword} from '../dist/server/user-accounts.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const password = 'a-long-test-passphrase',
  master = Buffer.alloc(32, 86).toString('base64'),
  origin = 'https://amcp.shop',
  mailEnv = {AMCP_EMAIL_API_KEY: 'synthetic-key', AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>'};
function fixture(authEnv = {}) {
  const store = new Store(':memory:', master),
    web = new WebStore(store, {
      origin,
      masterKey: master,
      authEnv,
      fetcher: async () => new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}}),
    }),
    accounts = new UserAccounts(web);
  const req = (address, cookie) => ({
    headers: {origin, ...(cookie ? {cookie} : {})},
    socket: {remoteAddress: address},
    get: h => (h.toLowerCase() === 'origin' ? origin : undefined),
  });
  const device = user => accounts.deviceCookie(accounts.user(user.id)).split(';')[0];
  const failures = async (email, count = 10, first = 1) => {
    for (let i = 0; i < count; i++)
      await assert.rejects(
        () => accounts.login(req('198.51.100.' + (first + i)), {email, password: 'not-the-password'}),
        {code: 'INVALID_LOGIN'},
      );
  };
  const outbox = () => store.db.prepare('SELECT count(*) AS n FROM amcp_email_outbox').get().n;
  const limits = () =>
    ownerOperations(store, {action: 'health'}, {tenantId: web.tenantId, userId: 'workspace-admin', role: 'admin'})
      .rate_limits;
  return {store, web, accounts, req, device, failures, outbox, limits};
}

test('after ten failures by others, the victim signs in from a known device and a browser without one is refused', async () => {
  const f = fixture();
  try {
    const victim = f.accounts.newUser('Victim', 'victim@example.test', await hashUserPassword(password), true),
      cookie = f.device(victim);
    await f.failures(victim.email);
    await assert.rejects(() => f.accounts.login(f.req('203.0.113.1'), {email: victim.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
      message: accountLimitMessage,
    });
    const session = await f.accounts.login(f.req('203.0.113.2', cookie), {email: victim.email, password});
    assert.equal(session.actor.userId, victim.id);
    // A wrong password from the known device counts against that device's own budget only.
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        () => f.accounts.login(f.req('203.0.113.' + (10 + i), cookie), {email: victim.email, password: 'wrong-guess'}),
        {code: 'INVALID_LOGIN'},
      );
    await assert.rejects(() => f.accounts.login(f.req('203.0.113.30', cookie), {email: victim.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
    });
    assert.equal(f.limits().known_device_refusals, 1);
  } finally {
    f.store.close();
  }
});

test("another user's device cookie, a tampered cookie and an expired cookie are ignored", async () => {
  const f = fixture();
  const realNow = Date.now;
  try {
    const victim = f.accounts.newUser('Victim', 'victim2@example.test', await hashUserPassword(password), true),
      other = f.accounts.newUser('Other', 'other@example.test', await hashUserPassword(password), true),
      foreign = f.device(other),
      own = f.device(victim);
    Date.now = () => realNow() - 181 * 86400000;
    const expired = f.device(victim);
    Date.now = realNow;
    // One changed character in the nonce or in the MAC.
    const flip = (cookie, at) => cookie.slice(0, at) + (cookie[at] === 'A' ? 'B' : 'A') + cookie.slice(at + 1);
    for (const cookie of [foreign, expired, flip(own, own.length - 60), flip(own, own.length - 5)])
      assert.equal(f.accounts.knownDevice(f.req('203.0.113.3', cookie), victim), undefined, cookie);
    assert.ok(f.accounts.knownDevice(f.req('203.0.113.3', own), victim));
    await f.failures(victim.email);
    await assert.rejects(() => f.accounts.login(f.req('203.0.113.4', foreign), {email: victim.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
    });
  } finally {
    Date.now = realNow;
    f.store.close();
  }
});

test('a password change invalidates every device cookie of the account', async () => {
  const f = fixture();
  try {
    const victim = f.accounts.newUser('Victim', 'victim3@example.test', await hashUserPassword(password), true),
      before = f.device(victim),
      s = f.accounts.session(victim),
      signedIn = {
        ...f.req('203.0.113.5'),
        headers: {origin, cookie: f.web.cookie(s.id).split(';')[0], 'x-amcp-csrf': s.csrf},
      };
    const newPassword = 'another-long-test-passphrase';
    await f.accounts.changePassword(signedIn, {currentPassword: password, password: newPassword});
    const current = f.accounts.user(victim.id);
    assert.equal(f.accounts.knownDevice(f.req('203.0.113.6', before), current), undefined);
    await f.failures(victim.email);
    await assert.rejects(
      () => f.accounts.login(f.req('203.0.113.7', before), {email: victim.email, password: newPassword}),
      {code: 'LOGIN_RATE_LIMIT'},
    );
    // A cookie issued for the new account version works.
    const after = f.device(current);
    assert.equal(
      (await f.accounts.login(f.req('203.0.113.8', after), {email: victim.email, password: newPassword})).actor.userId,
      victim.id,
    );
  } finally {
    f.store.close();
  }
});

test('a reset or registration at the per-email cap returns the generic answer and queues no email', async () => {
  const f = fixture(mailEnv);
  try {
    const victim = f.accounts.newUser('Victim', 'victim4@example.test', await hashUserPassword(password), true),
      generic = 'If an account uses this email, a password reset link is on its way.';
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await f.accounts.requestReset(f.req('198.51.100.' + (40 + i)), {email: victim.email})).message,
        generic,
      );
    const queued = f.outbox();
    assert.equal(queued, 5);
    assert.deepEqual(await f.accounts.requestReset(f.req('198.51.100.60'), {email: victim.email}), {message: generic});
    assert.equal(f.outbox(), queued, 'nothing is sent at the cap');
    // The person's own known device still has its own budget.
    await f.accounts.requestReset(f.req('198.51.100.61', f.device(victim)), {email: victim.email});
    assert.equal(f.outbox(), queued + 1);
    const fresh = 'newcomer@example.test',
      registered =
        'If this email can be registered, an account setup link is on its way. Already a member? Sign in instead.';
    for (let i = 0; i < 5; i++)
      await f.accounts.register(f.req('198.51.100.' + (70 + i)), {email: fresh, name: 'Newcomer'});
    const afterRegistrations = f.outbox();
    assert.equal(afterRegistrations, queued + 6);
    assert.deepEqual(await f.accounts.register(f.req('198.51.100.80'), {email: fresh, name: 'Newcomer'}), {
      message: registered,
    });
    assert.equal(f.outbox(), afterRegistrations);
    assert.equal(f.limits().email_requests_withheld, 2);
  } finally {
    f.store.close();
  }
});

test('an address that guesses across identities is still blocked, known device or not', async () => {
  const f = fixture(mailEnv);
  try {
    const victim = f.accounts.newUser('Victim', 'victim5@example.test', await hashUserPassword(password), true),
      cookie = f.device(victim);
    for (let i = 0; i < 10; i++)
      await assert.rejects(
        () => f.accounts.login(f.req('192.0.2.50'), {email: 'guess' + i + '@example.test', password: 'wrong-guess'}),
        {code: 'INVALID_LOGIN'},
      );
    await assert.rejects(() => f.accounts.login(f.req('192.0.2.50', cookie), {email: victim.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
      message: 'Too many attempts. Please try again in 15 minutes.',
    });
    // Email flows still refuse at the address's cap; only the per-email cap is silent.
    for (let i = 0; i < 5; i++) await f.accounts.requestReset(f.req('192.0.2.51'), {email: 'x' + i + '@example.test'});
    await assert.rejects(() => f.accounts.requestReset(f.req('192.0.2.51'), {email: victim.email}), {
      code: 'LOGIN_RATE_LIMIT',
    });
  } finally {
    f.store.close();
  }
});

test('AMCP_KNOWN_DEVICES=false returns to the earlier behavior', async () => {
  const env = {},
    f = fixture(env);
  try {
    const victim = f.accounts.newUser('Victim', 'victim6@example.test', await hashUserPassword(password), true),
      cookie = f.device(victim);
    env.AMCP_KNOWN_DEVICES = 'false';
    assert.equal(f.accounts.deviceCookie(victim), undefined);
    await f.failures(victim.email);
    await assert.rejects(() => f.accounts.login(f.req('203.0.113.9', cookie), {email: victim.email, password}), {
      code: 'LOGIN_RATE_LIMIT',
    });
  } finally {
    f.store.close();
  }
});

test('a completed sign-in over HTTP sets a __Host- device cookie that keeps that browser signed in', async () => {
  const store = new Store(':memory:', master),
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('No provider traffic');
      }),
    );
  const app = createHttpApp(service, store, {
    publicOrigin: origin,
    website: {origin, masterKey: master, authEnv: {}, clientIpSource: 'railway'},
  });
  const listener = await listenForFetch(app),
    base = 'http://127.0.0.1:' + listener.address().port,
    accounts = app.locals.website.accounts,
    victim = accounts.newUser('Victim', 'victim7@example.test', await hashUserPassword(password), true);
  const login = (address, body, cookie) =>
    fetch(base + '/api/account/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'sec-fetch-site': 'same-origin',
        'x-real-ip': address,
        ...(cookie ? {cookie} : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const first = await login('203.0.113.90', {email: victim.email, password});
    assert.equal(first.status, 200);
    const cookies = first.headers.getSetCookie(),
      device = cookies.find(c => c.startsWith('__Host-amcp_device='));
    assert.ok(cookies[0].startsWith('__Host-amcp_session='), 'the session cookie comes first');
    assert.ok(device, cookies.join(' | '));
    assert.match(device, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure$/);
    assert.equal(device.includes(victim.email) || device.includes(victim.id), false, 'the cookie names no one');
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await login('198.51.100.' + (90 + i), {email: victim.email, password: 'not-the-password'})).status,
        401,
      );
    const refused = await login('198.51.100.120', {email: victim.email, password});
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.message, accountLimitMessage);
    assert.equal((await login('198.51.100.121', {email: victim.email, password}, device.split(';')[0])).status, 200);
  } finally {
    listener.closeAllConnections();
    await new Promise(r => listener.close(r));
    store.close();
  }
});
