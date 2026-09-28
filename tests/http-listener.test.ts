import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type RequestListener, type Server} from 'node:http';
import {listenForFetch} from './http-listener.js';

const handler: RequestListener = (_request, response) => response.end('synthetic HTTP fixture');
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
test('Fetch rejects a forbidden port before issuing an HTTP request', async () => {
  await assert.rejects(
    fetch('http://127.0.0.1:6667/'),
    error => (error as Error).cause instanceof Error && ((error as Error).cause as Error).message === 'bad port',
  );
});
test('test listener releases a forbidden OS allocation, then serves HTTP on an allowed port', async () => {
  const servers: Server[] = [];
  const listener = await listenForFetch(handler, {
    create: request => {
      const server = createServer(request);
      servers.push(server);
      // Report a forbidden allocation deterministically, without reserving a fixed port.
      if (servers.length === 1) {
        const address = server.address.bind(server);
        server.address = () => ({...(address() as Exclude<ReturnType<Server['address']>, string | null>), port: 6667});
      }
      return server;
    },
  });
  try {
    assert.ok(servers.length >= 2);
    assert.equal(servers[0]!.listening, false);
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(await (await fetch('http://127.0.0.1:' + address.port)).text(), 'synthetic HTTP fixture');
  } finally {
    listener.closeAllConnections();
    await close(listener);
  }
});
test('test listener bounds allocation retries and closes every rejected listener', async () => {
  const servers: Server[] = [];
  await assert.rejects(
    listenForFetch(handler, {
      create: request => {
        const server = createServer(request);
        servers.push(server);
        server.address = () => ({address: '127.0.0.1', family: 'IPv4', port: 10080});
        return server;
      },
    }),
    /after 10 allocations/,
  );
  assert.equal(servers.length, 10);
  assert.ok(servers.every(server => !server.listening));
});
test('test listener preserves binding errors and rejects explicit forbidden ports', async () => {
  const listener = await listenForFetch(handler);
  try {
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(listenForFetch(handler, {port: address.port}), {code: 'EADDRINUSE'});
  } finally {
    await close(listener);
  }
  await assert.rejects(listenForFetch(handler, {port: 6667}), /not Fetch-compatible/);
});
