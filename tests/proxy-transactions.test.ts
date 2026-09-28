import test from 'node:test';
import assert from 'node:assert/strict';
import type {Request} from 'express';
import {clientAddressResolver} from '../server/web-store.js';
import {Store} from '../src/store.js';

const req = (peer: string, forwarded?: string | string[]) =>
  ({socket: {remoteAddress: peer}, headers: {'x-forwarded-for': forwarded}}) as unknown as Request;
test('proxy trust ignores spoofed and malformed headers and stops at the nearest untrusted hop', () => {
  const resolve = clientAddressResolver(['10.0.0.0/24', '2001:db8:abcd::/48']);
  assert.equal(clientAddressResolver()(req('10.0.0.1', '203.0.113.1')), '10.0.0.1');
  assert.equal(resolve(req('198.51.100.1', '203.0.113.1')), '198.51.100.1');
  assert.equal(resolve(req('10.0.0.1', '192.0.2.99, 203.0.113.1, 10.0.0.2')), '203.0.113.1');
  assert.equal(resolve(req('10.0.1.1', '203.0.113.1')), '10.0.1.1');
  assert.equal(resolve(req('::ffff:10.0.0.1', '::ffff:cb00:7101')), '203.0.113.1');
  assert.equal(resolve(req('2001:db8:abcd::1', '2001:0db8:ffff:0000:0000:0000:0000:0001')), '2001:db8:ffff::1');
  for (const invalid of [
    'unknown',
    '203.0.113.1,',
    'evil.invalid',
    '203.0.113.1:443',
    '[2001:db8::1]',
    'fe80::1%eth0',
    'x'.repeat(2050),
    Array(33).fill('10.0.0.2').join(','),
    ['203.0.113.1'],
  ])
    assert.equal(resolve(req('10.0.0.1', invalid)), '10.0.0.1');
  for (const invalid of [
    'true',
    '10.0.0.1',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    '2001:db8::/129',
    '10.0.0.0/8/extra',
    '::ffff:10.0.0.0/120',
  ])
    assert.throws(() => clientAddressResolver([invalid]));
});

test('nested savepoints commit together, isolate caught failures and roll back released inner work with the parent', () => {
  const store = new Store(':memory:');
  store.db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY)');
  const insert = (id: number) => store.db.prepare('INSERT INTO sample VALUES(?)').run(id),
    ids = () =>
      store.db
        .prepare('SELECT id FROM sample ORDER BY id')
        .all()
        .map(r => r.id);
  try {
    const result = store.transaction(() => {
      insert(1);
      store.transaction(() => {
        insert(2);
        store.transaction(() => insert(3));
      });
      try {
        store.transaction(() => {
          insert(4);
          store.transaction(() => insert(5));
          throw Error('inner');
        });
      } catch {}
      insert(6);
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.deepEqual(ids(), [1, 2, 3, 6]);
    assert.equal(store.db.isTransaction, false);
    assert.throws(
      () =>
        store.transaction(() => {
          insert(7);
          store.transaction(() => insert(8));
          throw Error('outer');
        }),
      /outer/,
    );
    assert.deepEqual(ids(), [1, 2, 3, 6]);
    assert.throws(
      () =>
        store.transaction(() => {
          store.transaction(() => insert(1));
        }),
      /UNIQUE/,
    );
    store.transaction(() => insert(9));
    assert.deepEqual(ids(), [1, 2, 3, 6, 9]);
    let invoked = false;
    assert.throws(
      () =>
        store.transaction(async () => {
          invoked = true;
          insert(10);
        }),
      /synchronous/,
    );
    assert.equal(invoked, false);
    assert.throws(
      () =>
        store.transaction(() => {
          insert(11);
          return Promise.resolve();
        }),
      /synchronous/,
    );
    assert.deepEqual(ids(), [1, 2, 3, 6, 9]);
  } finally {
    store.close();
  }
});
