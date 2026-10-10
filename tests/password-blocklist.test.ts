// SEC-06 S5 (review 2026-10-08, R04 password-blocklist): only the length of a new password was checked, so
// "passwordpassword", "qwertyuiopasdfgh" or the person's own email name with a year were accepted. NIST SP 800-63B-4
// §3.1.1.2 says a verifier SHALL compare new passwords against a blocklist including context-specific words. The check
// is offline; signing in with an existing password is never refused by it. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts, hashUserPassword, verifyPassword} from '../server/user-accounts.js';
import {assertPasswordNotCommon, passwordGuessBits} from '../server/password-blocklist.js';
import {removeTestDirectory} from './temp.js';

const master = Buffer.alloc(32, 91).toString('base64');

test('SEC-06 S5: common, patterned and repeated passwords are refused as PASSWORD_COMMON', () => {
  for (const common of [
    'passwordpassword',
    'password12345678',
    'qwertyuiopasdfgh',
    'iloveyouiloveyou',
    'P@ssw0rd2024!!!!',
    'aaaaaaaaaaaaaaaa',
    '123456789012345',
    'amcpamcpamcpamcp',
    'welcome to amcp 2026',
    'correcthorsebatterystaple',
    'monkeydragon2024!',
    'zxcvbnm1234567890',
    'xk7qxk7qxk7qxk7q',
  ])
    assert.throws(() => assertPasswordNotCommon(common, {}, {}), {code: 'PASSWORD_COMMON'}, common);
  for (const strong of [
    'synthetic mfa policy member passphrase',
    'quiet-harbor-lantern-91',
    'Tz7#mK2$vQ9!pL4w',
    'a-new-long-password',
    'another-long-test-passphrase',
  ])
    assert.doesNotThrow(() => assertPasswordNotCommon(strong, {}, {}), strong);
  assert.ok(passwordGuessBits('passwordpassword') < passwordGuessBits('quiet-harbor-lantern-91'));
});

test('SEC-06 S5: the email local part, the name and AMCP are refused as the substance of a password', () => {
  const context = {email: 'averylongname@example.test', name: 'Fatimah Alzahrani'};
  for (const personal of ['averylongname2024!', 'averylongname-amcp', 'fatimahalzahrani1', 'Alzahrani Fatimah 99'])
    assert.throws(() => assertPasswordNotCommon(personal, context, {}), {code: 'PASSWORD_COMMON'}, personal);
  // The same text is fine for someone else, and a strong password may still contain a name.
  assert.doesNotThrow(() => assertPasswordNotCommon('averylongname2024!', {email: 'other@example.test'}, {}));
  assert.doesNotThrow(() => assertPasswordNotCommon('fatimah-quiet-harbor-lantern', context, {}));
});

test('SEC-06 S5: an operator-supplied exact list is honored when configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-blocklist-')),
    file = path.join(dir, 'common.txt');
  try {
    fs.writeFileSync(file, 'Quiet-Harbor-Lantern-91\nshort\n');
    assert.doesNotThrow(() => assertPasswordNotCommon('quiet-harbor-lantern-91', {}, {}));
    assert.throws(() => assertPasswordNotCommon('quiet-harbor-lantern-91', {}, {AMCP_PASSWORD_BLOCKLIST_FILE: file}), {
      code: 'PASSWORD_COMMON',
    });
  } finally {
    removeTestDirectory(dir, 'amcp-blocklist-');
  }
});

test('SEC-06 S5: new passwords are checked where they are chosen; an existing password is still rehashed at sign-in', async () => {
  await assert.rejects(hashUserPassword('passwordpassword'), {code: 'PASSWORD_COMMON'});
  await assert.rejects(hashUserPassword('short'), {code: 'PASSWORD_LENGTH'});
  // Sign-in upgrades an older hash of the password the person already has, whatever it is.
  assert.equal(await verifyPassword('passwordpassword', await hashUserPassword('passwordpassword', false)), true);
  const store = new Store(':memory:', master),
    web = new WebStore(store, {origin: 'https://amcp.shop', masterKey: master}),
    accounts = new UserAccounts(web);
  try {
    const current = 'synthetic blocklist current passphrase',
      user = accounts.newUser('Owner Person', 'owner.person@example.test', await hashUserPassword(current), true),
      s = accounts.session(user);
    const req = {
      headers: {origin: web.origin, cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf},
      socket: {remoteAddress: '127.0.0.1'},
    } as unknown as Request;
    await assert.rejects(accounts.changePassword(req, {currentPassword: current, password: 'ownerperson2026!!'}), {
      code: 'PASSWORD_COMMON',
    });
    assert.equal(await verifyPassword(current, accounts.user(String(user.id)).password_hash), true, 'unchanged');
    await accounts.changePassword(req, {currentPassword: current, password: 'quiet-harbor-lantern-91'});
    assert.equal(await verifyPassword('quiet-harbor-lantern-91', accounts.user(String(user.id)).password_hash), true);
  } finally {
    store.close();
  }
});
