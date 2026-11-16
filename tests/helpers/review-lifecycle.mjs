// One reviewed write through the real lifecycle (MirrorService, NativeTransport, the store) against a synthetic provider
// whose answer to a state read depends on the phase: `prepare` while the review is made, `execute` once the provider has
// changed. Nothing leaves the process; every value is synthetic (package r25-m1-hash, Round 2.5 M1).
import assert from 'node:assert/strict';
import {Registry} from '../../dist/src/catalog.js';
import {Store} from '../../dist/src/store.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

const registry = new Registry(),
  key = Buffer.alloc(32, 61).toString('base64'),
  actor = {tenantId: 'test', userId: 'writer', role: 'operator'},
  admin = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};

/**
 * `gateway` is the provider id (`x_ads`, `linkedin`, `dv360`). `args` are the amcp_write arguments; `reply` describes the
 * answer to the write (`response`, `status`, `headers`); `answer(path, phase, url)` is the answer to a state read;
 * `accountArgument: false` leaves account_id out (DV360 names its account in its parameters). Returns what execute
 * answered and how many writes the provider received.
 */
export async function lifecycle({gateway, args, reply = {}, answer, accountArgument = true}) {
  const store = new Store(':memory:', key),
    connection = {
      id: 'connection',
      tenantId: 'test',
      gateway: gateway + '_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(admin, connection, {
    accessToken: 'synthetic',
    consumerKey: 'synthetic',
    consumerSecret: 'synthetic',
    tokenSecret: 'synthetic',
  });
  store.rememberResource(connection, '123', '111');
  let phase = 'prepare',
    writes = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (input, init = {}) => {
      const url = new URL(String(input));
      if ((init.method ?? 'GET') === 'GET') return Response.json(answer(url.pathname, phase, url));
      writes++;
      return new Response(
        reply.response === undefined || reply.response === null ? null : JSON.stringify(reply.response),
        {
          status: reply.status ?? (reply.response === null ? 204 : 200),
          headers: reply.headers,
        },
      );
    }),
    undefined,
    policy,
  );
  try {
    const prepared = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: gateway + '_native_action',
        arguments: {...(accountArgument ? {account_id: '123'} : {}), ...args},
      },
      actor,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    phase = 'execute';
    const done = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      },
      actor,
    );
    return {prepared: prepared.data, done, writes: () => writes};
  } finally {
    store.close();
  }
}
