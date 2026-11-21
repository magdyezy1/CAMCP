// r25-admin-email, item 4: with sign-up closed (AMCP_ALLOW_SIGNUP=false), registration is open for exactly the configured
// address and nobody else. It still needs e-mail delivery, because the e-mail link is the verification. Every other
// address gets today's closed answer, the same whether or not an account holds it and before anything is read or written.
// The public pages keep saying sign-up is closed. Synthetic addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAddress, password, site, type Site} from './helpers/admin-email-site.js';
import type {JsonObject} from '../src/types.js';

const closed = {AMCP_ALLOW_SIGNUP: 'false'};
const answer = async (r: Response) => ({status: r.status, body: (await r.json()) as JsonObject});
const stripped = (a: {status: number; body: JsonObject}) => ({
  status: a.status,
  code: a.body.error?.code,
  message: a.body.error?.message,
  keys: Object.keys(a.body.error ?? {}).sort(),
});
const register = (f: Site, email: unknown) => f.request('/api/account/register', 'POST', {name: 'Some person', email});
/** How many statements the site's database prepared while `run` ran. */
async function prepared<T>(f: Site, run: () => Promise<T>): Promise<{result: T; statements: number}> {
  const db = f.store.db as unknown as {prepare: (sql: string) => unknown},
    original = db.prepare.bind(db);
  let statements = 0;
  db.prepare = (sql: string) => {
    statements++;
    return original(sql);
  };
  try {
    return {result: await run(), statements};
  } finally {
    delete (db as {prepare?: unknown}).prepare;
  }
}

test('closed sign-up: the configured address registers the usual way and is approved and made an owner at its first sign-in', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    const sent = await register(f, ' Admin@Example.TEST ');
    assert.equal(sent.status, 200);
    assert.equal(
      ((await sent.json()) as JsonObject).message,
      'If this email can be registered, an account setup link is on its way. Already a member? Sign in instead.',
    );
    assert.equal(f.emails.length, 1, 'the verification link was sent');
    const finished = await f.request('/api/account/verify-email', 'POST', {...f.link(), password});
    assert.equal(finished.status, 200);
    assert.equal(
      ((await finished.json()) as JsonObject).message,
      'Your account is ready. Sign in to open your workspace.',
      'the first sign-in approves it',
    );
    const created = f.store.db.prepare('SELECT * FROM amcp_users WHERE email=?').get(adminAddress) as JsonObject;
    assert.equal(created.approved, 0);
    await f.signedIn(adminAddress);
    assert.equal(f.membership(created.id)!.role, 'owner');
    // The public pages still say sign-up is closed.
    const options = (await (await f.request('/api/account/options')).json()) as JsonObject;
    assert.equal(options.signupEnabled, false);
    assert.equal(options.registrationAvailable, false);
  } finally {
    await f.close();
  }
});

test('closed sign-up: every other address gets today’s closed answer, identical whether an account holds it, with nothing read or written', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    await f.account('taken@example.test');
    const probes: unknown[] = [
      'taken@example.test',
      'free@example.test',
      'admin@example.test.evil',
      'xadmin@example.test',
      'admin+x@example.test',
      'not-an-address',
      '',
      undefined,
      12345,
      {email: adminAddress},
      [adminAddress],
    ];
    const answers = [],
      counts = [];
    for (const email of probes) {
      const {result, statements} = await prepared(f, async () => answer(await register(f, email)));
      answers.push(stripped(result));
      counts.push(statements);
      assert.equal(result.status, 403);
      assert.equal(result.body.error.code, 'SIGNUP_DISABLED');
    }
    for (const a of answers) assert.deepEqual(a, answers[0]);
    assert.deepEqual(
      counts,
      probes.map(() => 0),
      'the refusal reads and writes nothing, so it cannot depend on an account',
    );
    assert.equal(f.emails.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM amcp_account_challenges').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('closed sign-up without the variable is as it was: not even the would-be address registers', async () => {
  const f = await site({env: closed});
  try {
    const refused = await answer(await register(f, adminAddress));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'SIGNUP_DISABLED');
    assert.equal(f.emails.length, 0);
  } finally {
    await f.close();
  }
});

test('the configured address still needs e-mail delivery: without it the answer says so, and other addresses stay closed', async () => {
  const f = await site({adminEmail: adminAddress, env: {...closed, AMCP_EMAIL_API_KEY: '', AMCP_EMAIL_FROM: ''}});
  try {
    const needed = await answer(await register(f, adminAddress));
    assert.equal(needed.status, 503);
    assert.equal(needed.body.error.code, 'EMAIL_SETUP_REQUIRED');
    assert.equal((await answer(await register(f, 'other@example.test'))).body.error.code, 'SIGNUP_DISABLED');
  } finally {
    await f.close();
  }
});

test('a registration link only completes while the variable still names its address', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    assert.equal((await register(f, adminAddress)).status, 200);
    const link = f.link();
    // The variable now names someone else (the deployment restarted): the link no longer opens a registration.
    const g = await f.restart({adminEmail: 'someone-else@example.test'});
    try {
      const refused = await answer(await g.request('/api/account/verify-email', 'POST', {...link, password}));
      assert.equal(refused.body.error.code, 'SIGNUP_DISABLED');
      assert.equal(g.store.db.prepare('SELECT 1 FROM amcp_users WHERE email=?').get(adminAddress), undefined);
      // Without the variable too, and a token that was never issued is the same closed answer.
      const h = await g.restart({adminEmail: undefined});
      try {
        assert.equal(
          (await answer(await h.request('/api/account/verify-email', 'POST', {...link, password}))).body.error.code,
          'SIGNUP_DISABLED',
        );
        const forged = await answer(
          await h.request('/api/account/verify-email', 'POST', {token: 'A'.repeat(43), kind: 'register', password}),
        );
        assert.equal(forged.body.error.code, 'SIGNUP_DISABLED');
      } finally {
        await h.close();
      }
    } catch (error) {
      await g.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('closed sign-up: a social first sign-in stays closed, even with a verified address that is the configured one', async () => {
  const f = await site({
    adminEmail: adminAddress,
    env: closed,
    social: {email: adminAddress, verified: true, subject: 'closed-google'},
  });
  try {
    await f.deploymentOwner();
    const result = await f.social('google');
    assert.match(String(result.headers.get('location')), /error=SIGNUP_DISABLED/);
    assert.equal(f.store.db.prepare('SELECT 1 FROM amcp_users WHERE email=?').get(adminAddress), undefined);
  } finally {
    await f.close();
  }
});

test('open sign-up: the configured address registers like anyone and the first sign-in approves it', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    assert.equal((await register(f, adminAddress)).status, 200);
    const finished = (await (
      await f.request('/api/account/verify-email', 'POST', {...f.link(), password})
    ).json()) as JsonObject;
    assert.equal(finished.message, 'Your account is ready. Sign in to open your workspace.');
    // Another address in the same deployment still waits for the owner's approval.
    assert.equal((await register(f, 'newcomer@example.test')).status, 200);
    const other = (await (
      await f.request('/api/account/verify-email', 'POST', {...f.link(), password})
    ).json()) as JsonObject;
    assert.match(String(other.message), /awaiting approval/);
  } finally {
    await f.close();
  }
});
