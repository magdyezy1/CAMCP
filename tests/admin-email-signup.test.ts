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
/** The statements (their SQL texts, in order) the site's database prepared while `run` ran. */
async function prepared<T>(f: Site, run: () => Promise<T>): Promise<{result: T; statements: string[]}> {
  const db = f.store.db as unknown as {prepare: (sql: string) => unknown},
    original = db.prepare.bind(db),
    statements: string[] = [];
  db.prepare = (sql: string) => {
    statements.push(sql);
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

test('closed sign-up: every other address gets today’s closed answer, identical whether an account holds it, and costs the same statements', async () => {
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
    const answers: ReturnType<typeof stripped>[] = [],
      lists: string[][] = [];
    for (const email of probes) {
      // Each probe is inside its budget here (the next tests pin the budget); the table of budgets starts empty again.
      f.store.db.prepare('DELETE FROM amcp_login_limits').run();
      const {result, statements} = await prepared(f, async () => answer(await register(f, email)));
      answers.push(stripped(result));
      lists.push(statements);
      assert.equal(result.status, 403);
      assert.equal(result.body.error.code, 'SIGNUP_DISABLED');
    }
    for (const a of answers) assert.deepEqual(a, answers[0]);
    // Review S3-2: every request is counted against the budgets before the address is looked at (so guessing the
    // configured address is bounded), and it makes the same statements whatever it holds, so nothing but the status of
    // the configured address's own answer depends on the address. Review S4-10 (the lead's follow-up of 2026-11-22): equal
    // counts alone would let the refusal read an account or a challenge for every address and still pass, so the texts of
    // the statements are compared: the same list for every address, and nothing in it but the table of budgets.
    assert.ok(lists[0]!.length > 0, 'the request is counted');
    for (const list of lists) assert.deepEqual(list, lists[0], 'the same statements for every address');
    for (const sql of lists[0]!) assert.match(sql, /amcp_login_limits/, 'only the table of budgets: ' + sql);
    for (const sql of lists.flat())
      assert.doesNotMatch(
        sql,
        /amcp_users|amcp_account_challenges|workspace_memberships/,
        'no account is read: ' + sql,
      );
    assert.equal(f.emails.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM amcp_account_challenges').get()!.n, 0);
  } finally {
    await f.close();
  }
});

// Review S4-10: the configured address and any other make the same statements, the same texts in the same order, up to the
// comparison of the address; only after it does the configured address's own request go on, to the account lookup and the link.
test('closed sign-up: the configured address makes the same statements as another address up to the comparison, and goes on after it', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    const reset = () => f.store.db.prepare('DELETE FROM amcp_login_limits').run();
    reset();
    const other = await prepared(f, async () => answer(await register(f, 'someone-else@example.test')));
    assert.equal(other.result.body.error.code, 'SIGNUP_DISABLED');
    reset();
    const configured = await prepared(f, async () => answer(await register(f, adminAddress)));
    assert.equal(configured.result.status, 200);
    assert.ok(other.statements.length > 0);
    assert.deepEqual(
      configured.statements.slice(0, other.statements.length),
      other.statements,
      'the same texts in the same order before the comparison',
    );
    const rest = configured.statements.slice(other.statements.length);
    assert.ok(
      rest.some(sql => /amcp_users/.test(sql)),
      'after it, the account lookup',
    );
    assert.ok(
      rest.some(sql => /amcp_account_challenges/.test(sql)),
      'after it, the link',
    );
    assert.equal(f.emails.length, 1);
  } finally {
    await f.close();
  }
});

// Review S3-2 (the lead's decision of 2026-11-21): while sign-up is closed the configured address was the one that did not
// get the closed answer, and nothing counted the guesses, so a script could try a list of addresses without limit. The
// budgets of the other e-mail requests (five a network and five an address in 15 minutes) now apply to every address.
test('closed sign-up: guessing the configured address is bounded by the network budget, and the answer after it is the same for every address', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    for (let i = 1; i <= 5; i++) {
      const answered = await answer(await register(f, 'guess' + i + '@example.test'));
      assert.equal(answered.body.error.code, 'SIGNUP_DISABLED', 'guess ' + i);
    }
    // The sixth request from this network is refused for every address alike, the configured one included: it learns
    // nothing, and nothing is sent.
    const refused = [
      await answer(await register(f, 'guess6@example.test')),
      await answer(await register(f, adminAddress)),
      await answer(await register(f, ' ADMIN@example.test ')),
    ];
    for (const r of refused) {
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, 'LOGIN_RATE_LIMIT');
      assert.deepEqual(stripped(r), stripped(refused[0]!));
    }
    assert.equal(f.emails.length, 0);
    // A later window (the budget expired) answers as it did.
    f.store.db.prepare('UPDATE amcp_login_limits SET until_at=?').run(Date.now() - 1);
    assert.equal((await answer(await register(f, adminAddress))).status, 200);
    assert.equal(f.emails.length, 1);
  } finally {
    await f.close();
  }
});

test('closed sign-up: the budget is its own, so probing it never uses up the e-mail budget of password resets', async () => {
  const f = await site({adminEmail: adminAddress, env: closed});
  try {
    await f.deploymentOwner();
    await f.account('member@example.test');
    for (let i = 1; i <= 6; i++) await register(f, 'guess' + i + '@example.test');
    assert.equal((await answer(await register(f, 'guess7@example.test'))).status, 429);
    const reset = await f.request('/api/account/forgot-password', 'POST', {email: 'member@example.test'});
    assert.equal(reset.status, 200, 'a person who forgot a password is not locked out by probes of the sign-up route');
    assert.equal(f.emails.length, 1, 'and their reset link is sent');
  } finally {
    await f.close();
  }
});

test('closed sign-up: an address has its own budget across networks, answered as before, and the cap of five links holds', async () => {
  const f = await site({adminEmail: adminAddress, env: closed, trustedProxyCidrs: ['127.0.0.1/32']});
  try {
    await f.deploymentOwner();
    const from = (n: number) => ({'X-Forwarded-For': '203.0.113.' + n}),
      reg = (email: string, n: number) =>
        f.request('/api/account/register', 'POST', {name: 'Some person', email}, from(n));
    // The same guess from seven networks: each is answered as closed, the budget of the address included.
    for (let n = 1; n <= 7; n++) {
      const answered = await answer(await reg('same-guess@example.test', n));
      assert.equal(answered.body.error.code, 'SIGNUP_DISABLED', 'network ' + n);
    }
    // The configured address from eight networks: the answer is the same every time, and at most five links go out.
    for (let n = 10; n < 18; n++) {
      const answered = await answer(await reg(adminAddress, n));
      assert.equal(answered.status, 200, 'network ' + n);
    }
    assert.equal(f.emails.length, 5, 'the cap of five links to one address holds');
  } finally {
    await f.close();
  }
});

test('closed sign-up without the variable is as it was: not even the would-be address registers', async () => {
  const f = await site({env: closed});
  try {
    const {result: refused, statements} = await prepared(f, async () => answer(await register(f, adminAddress)));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'SIGNUP_DISABLED');
    assert.deepEqual(
      statements,
      [],
      'without the variable nothing is counted: the closed answer costs what it always did',
    );
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
