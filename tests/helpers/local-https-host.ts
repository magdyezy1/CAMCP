import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import type {TestContext} from 'node:test';
import {listenForFetch} from '../http-listener.js';

/**
 * A host that answers with exactly the bytes a test gives it (a status line, headers, a body), so a transport meets what
 * a server can really send: `HTTP/1.1 999`, for one, which no fetch Response can be built from (r25-hotfix-fetch). Plain
 * TCP on loopback. With `hold`, a connection stays open after the answer, to see whether the client closes it.
 */
export async function rawHost(answer: (path: string) => string | Buffer, {hold = false} = {}) {
  const open = new Set<net.Socket>();
  const connected = (socket: net.Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    let head = '';
    socket.on('data', chunk => {
      head += chunk.toString('latin1');
      const path = /^GET (\S+) HTTP\/1\.1\r\n[\s\S]*?\r\n\r\n/.exec(head)?.[1];
      if (path === undefined) return;
      head = '';
      const bytes = answer(path);
      socket.write(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
      if (!hold) socket.end();
    });
  };
  // The port comes from listenForFetch (tests/http-listener.ts), which asks again for one that Fetch forbids
  // (tests/fetch-port-listeners.test.mjs). It takes the server's constructor, and this one is plain TCP, not HTTP.
  const server = (await listenForFetch(() => {}, {
    create: () => net.createServer(connected) as never,
  })) as unknown as net.Server;
  return {
    port: (server.address() as net.AddressInfo).port,
    /** Whether every connection to the host has closed, waiting up to a second, which is less than any request timeout a test sets: a client that destroyed its response has closed its socket. */
    async closed() {
      for (let waited = 0; open.size && waited < 1000; waited += 10) await sleep(10);
      return open.size === 0;
    },
    async close() {
      for (const socket of open) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** A raw HTTP/1.1 answer: `headers` are whole lines (`'Name: value\r\n'`), and a Content-Length may promise more than `body`. */
export const raw = (status: number, headers = '', body = '') => `HTTP/1.1 ${status} Test\r\n${headers}\r\n${body}`;

/**
 * Sends the `https.request` calls of the code under test to `host` over plain HTTP on loopback, so its own response
 * callback receives a real node response. TLS is not under test, and nothing leaves the process: name resolution is
 * answered locally too. The ESM export sync lets a module that imports `request` by name (not `https.request`) see it.
 */
export function viaHost(t: TestContext, host: {port: number}) {
  const send = (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) =>
    http.request(
      {
        host: '127.0.0.1',
        port: host.port,
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        agent: false,
        signal: options.signal,
      },
      callback,
    );
  t.mock.method(https, 'request', send as never);
  t.mock.method(dns.promises, 'lookup', (async () => [{address: '93.184.216.34', family: 4}]) as never);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

/**
 * Records what would end a production process: an uncaught exception or an unhandled rejection. A test asserts that
 * `crashes` is empty at its end, which is what "the process stays up" means in a process that has handlers, and awaits
 * its calls through `during`, which throws the first crash at once instead of waiting for a call that will never settle.
 */
export function crashSentinel(t: TestContext) {
  const crashes: unknown[] = [];
  let crashed: (error: unknown) => void = () => {};
  const first = new Promise<never>((_, reject) => (crashed = reject));
  first.catch(() => {});
  const note = (error: unknown) => {
    crashes.push(error);
    crashed(error);
  };
  process.on('uncaughtException', note);
  process.on('unhandledRejection', note);
  t.after(() => {
    process.off('uncaughtException', note);
    process.off('unhandledRejection', note);
  });
  return {crashes, during: <T>(work: Promise<T>) => Promise.race([work, first])};
}
