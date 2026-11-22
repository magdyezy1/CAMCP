// r25-admin-email, item 1: AMCP_ADMIN_EMAIL holds exactly one e-mail address, parsed once by loadConfig. Trimmed and
// compared case-insensitively; matched exactly (no lists, wildcards or domains); an unparseable value stops the server
// and the worker without echoing the value; unset changes nothing. Synthetic addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../dist/server/config.js';
import {adminEmailMatches} from '../dist/server/admin-email.js';

const address = 'admin@example.test';

test('unset, empty and blank leave the setting off, for every entry point', () => {
  for (const entry of ['http', 'worker', 'stdio']) {
    assert.equal(loadConfig({}, entry).adminEmail, undefined);
    assert.equal(loadConfig({AMCP_ADMIN_EMAIL: ''}, entry).adminEmail, undefined);
    assert.equal(loadConfig({AMCP_ADMIN_EMAIL: '   \t '}, entry).adminEmail, undefined);
  }
  // Unset adds no startup problem and no other change to the configuration.
  const base = loadConfig({}, 'http'),
    keys = Object.keys(base).filter(key => key !== 'adminEmail');
  assert.equal(base.problems.length, 0);
  assert.deepEqual(
    keys.sort(),
    Object.keys(loadConfig({AMCP_ADMIN_EMAIL: address}, 'http'))
      .filter(key => key !== 'adminEmail')
      .sort(),
  );
});

test('the address is trimmed and lower-cased once, and the configuration stays frozen', () => {
  for (const raw of [address, '  Admin@Example.TEST ', '\tADMIN@EXAMPLE.TEST\n']) {
    const config = loadConfig({AMCP_ADMIN_EMAIL: raw}, 'http');
    assert.equal(config.adminEmail, address);
    assert.ok(Object.isFrozen(config));
    assert.equal(loadConfig({AMCP_ADMIN_EMAIL: raw}, 'worker').adminEmail, address);
  }
  // A plus-address and a subdomain are ordinary exact addresses, not patterns.
  assert.equal(
    loadConfig({AMCP_ADMIN_EMAIL: 'Admin+Tag@Mail.Example.test'}, 'http').adminEmail,
    'admin+tag@mail.example.test',
  );
});

// Each value has a fragment that must never appear in the refusal.
const refused = [
  ['zqlocal-plain-text', 'zqlocal-plain-text'],
  ['zqlocal@nodot', 'zqlocal@nodot'],
  ['@zqdomain.example.test', '@zqdomain.example.test'],
  ['zqlocal@', 'zqlocal@'],
  ['zqlocal@zqdomain.example.test, zqother@zqdomain.example.test', 'zqother'],
  ['zqlocal@zqdomain.example.test;zqother@zqdomain.example.test', 'zqother'],
  ['zqlocal@zqdomain.example.test zqother@zqdomain.example.test', 'zqother'],
  ['zqlocal@zqdomain.example.test,zqother@zqdomain.example.test', 'zqother'],
  ['*@zqdomain.example.test', 'zqdomain'],
  ['zqlocal@*.zqdomain.example.test', 'zqdomain'],
  ['zqlocal@zqdomain.*', 'zqdomain'],
  ['zq?local@zqdomain.example.test', 'zq?local'],
  ['zq%local@zqdomain.example.test', 'zq%local'],
  ['zqlocal@@zqdomain.example.test', 'zqdomain'],
  ['<zqlocal@zqdomain.example.test>', 'zqdomain'],
  ['Zq Name <zqlocal@zqdomain.example.test>', 'zqdomain'],
  ['"zqlocal"@zqdomain.example.test', 'zqdomain'],
  ['zqlocal\u0000@zqdomain.example.test', 'zqdomain'],
  ['zqdomain.example.test', 'zqdomain'],
  ['zq' + 'a'.repeat(260) + '@zqdomain.example.test', 'zqdomain'],
];
test('an unparseable value stops the HTTP server and the worker, and the refusal never echoes the value', () => {
  for (const [value, secret] of refused)
    for (const entry of ['http', 'worker']) {
      let caught;
      try {
        loadConfig({AMCP_ADMIN_EMAIL: value}, entry);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error, JSON.stringify(value) + ' must be refused by ' + entry);
      assert.match(caught.message, /AMCP_ADMIN_EMAIL/);
      assert.ok(!caught.message.includes(secret), 'the message echoes the value: ' + JSON.stringify(value));
      assert.ok(!String(caught.stack).includes(secret), 'the stack echoes the value: ' + JSON.stringify(value));
    }
});

test('the stdio entry serves no website, so a bad value there is ignored instead of stopping it', () => {
  assert.equal(loadConfig({AMCP_ADMIN_EMAIL: 'zqlocal-plain-text'}, 'stdio').adminEmail, undefined);
});

test('matching is exact: case and surrounding space match, everything else does not', () => {
  for (const candidate of [address, 'ADMIN@EXAMPLE.TEST', '  Admin@Example.Test  ', '\tadmin@example.test\n'])
    assert.equal(adminEmailMatches(address, candidate), true, JSON.stringify(candidate));
  for (const candidate of [
    'admin@example.test.evil',
    'xadmin@example.test',
    'admin+tag@example.test',
    'admin@sub.example.test',
    'admin@example.tes',
    'admin@example.test,other@example.test',
    'admin@example.test other',
    'adm in@example.test',
    '@example.test',
    'example.test',
    '',
    ' ',
    null,
    undefined,
    7,
    {},
    [address],
    {toString: () => address},
    'a'.repeat(5000) + address,
  ])
    assert.equal(adminEmailMatches(address, candidate), false, JSON.stringify(candidate));
  // Without the setting nothing matches, not even an empty candidate.
  for (const candidate of [address, '', undefined, null]) assert.equal(adminEmailMatches(undefined, candidate), false);
});
