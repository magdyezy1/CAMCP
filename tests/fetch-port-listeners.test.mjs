// A test server bound to port 0 gets whatever port the OS hands out, and Fetch refuses a list of ports (tests/http-listener.ts,
// https://fetch.spec.whatwg.org/#port-blocking). On a host whose dynamic range starts at 1024 an unlucky draw (4190, 6000,
// 6665 to 6669, 6679, 6697, 10080) fails a test that has nothing wrong with it: this is how "ACC-07 fixture host" failed once.
// Every test, fixture or tool server that is reached through fetch binds through listenForFetch, which releases a forbidden
// allocation and asks again (r25-m0-merge, merge task 3). tests/http-listener.test.ts holds the helper's own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import {serveJourney} from '../tools/acceptance/assistive-results.mjs';
import {listenForFetch} from '../dist/tests/http-listener.js';

test('the ACC-07 fixture host releases a forbidden allocation of its sign-in server and serves its link on an allowed port', async () => {
  const servers = [];
  const host = await serveJourney('report-export', {
    workIntervalMs: 100000,
    // The first allocation reports a forbidden port, deterministically and without reserving a fixed port.
    listen: handler =>
      listenForFetch(handler, {
        create: request => {
          const server = createServer(request);
          servers.push(server);
          if (servers.length === 1) {
            const address = server.address.bind(server);
            server.address = () => ({...address(), port: 6667});
          }
          return server;
        },
      }),
  });
  try {
    assert.ok(
      servers.length >= 2,
      'the sign-in server binds through the listener it is given, and asks again after 6667',
    );
    assert.equal(servers[0].listening, false, 'the forbidden allocation was released');
    const link = new URL(host.link);
    assert.notEqual(link.port, '6667');
    assert.equal(Number(link.port), servers.at(-1).address().port);
    // A request through fetch reaches it: Fetch would refuse the forbidden port before sending anything.
    const first = await fetch(host.link, {redirect: 'manual'});
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), host.origin + '/reporting-overview');
  } finally {
    await host.close();
  }
});

// What may still bind an OS-chosen port by itself, and why that is safe. A file listed here must not call fetch (checked below).
const reachedWithoutFetch = new Map([
  ['tests/http-body-encoding.test.mjs', 'it sends every request through http.request, which has no blocked-port list'],
]);
// .listen() with no port, .listen(0, ...) and .listen({port: 0, ...}) all take the OS's draw. Production servers listen on a
// configured port (server/http.ts) and are not read here.
const osChosen = /\.listen\(\s*(?:\)|0\b|\{[^}]*\bport:\s*0\b)/;
const self = 'tests/fetch-port-listeners.test.mjs';
const scanned = ['tests', 'tools', 'codegen', 'deploy'];

function sources() {
  const found = [];
  for (const root of scanned) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, {recursive: true})) {
      const file = path.join(root, entry).replaceAll('\\', '/');
      if (file.split('/').includes('node_modules') || file === self) continue;
      if (!/\.(?:mjs|cjs|js|ts)$/.test(file) || !fs.statSync(file).isFile()) continue;
      found.push(file);
    }
  }
  return found;
}

test('no test, fixture or tool binds an OS-chosen port by itself where fetch can reach it', () => {
  const direct = sources().filter(
    file => osChosen.test(fs.readFileSync(file, 'utf8')) && !reachedWithoutFetch.has(file),
  );
  assert.deepEqual(direct, [], 'bind through listenForFetch (tests/http-listener.ts) instead of .listen(0)');
});

test('each server the scan allows to bind by itself still does, and is still never reached through fetch', () => {
  for (const [file, reason] of reachedWithoutFetch) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(
      source,
      osChosen,
      file + ' no longer binds an OS-chosen port: remove it from the list (' + reason + ')',
    );
    assert.doesNotMatch(
      source,
      /\bfetch\(/,
      file + ' calls fetch now, so it must bind through listenForFetch (' + reason + ')',
    );
  }
});

test('the scan reads the tests, the fixtures and the tools, and tells a direct bind from a configured one', () => {
  const read = sources();
  for (const file of [
    'tests/http-listener.ts',
    'tests/fixtures/compressed-body-server.mjs',
    'tools/acceptance/assistive-results.mjs',
    'tools/browser-qa-tls.mjs',
  ])
    assert.ok(read.includes(file), file + ' is read');
  for (const bound of ['server.listen(0, host, done)', 'app.listen({host, port: 0})', 'x.listen()', 'x.listen( 0 )'])
    assert.match(bound, osChosen, bound);
  for (const bound of [
    'server.listen(port, host)',
    'app.listen({host, port})',
    "server.listen('/tmp/socket')",
    'x.listen(8080)',
  ])
    assert.doesNotMatch(bound, osChosen, bound);
});
