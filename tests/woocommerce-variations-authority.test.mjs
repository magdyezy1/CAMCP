import test from 'node:test';
import assert from 'node:assert/strict';
import {wooVariationsFixture, wooVariationInput} from './fixtures/woocommerce-variations-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

const run = (f, actor = f.actor) => f.service.call('amcp_workspace', wooVariationInput(), actor);
const hidden = out => {
  assertRefused(out, [
    'WOOCOMMERCE_SOURCE_CHANGED',
    'CONNECTION_REQUIRED',
    'UNAUTHORIZED',
    'WOOCOMMERCE_SOURCE_INCOMPLETE',
    'WOOCOMMERCE_SOURCE_UNAVAILABLE',
  ]);
  assert.equal(out.data, undefined);
  assert.doesNotMatch(JSON.stringify(out), /VAR-001|GROUP-001|syntheticsecret|newsecret|PRIVATE-WOO/);
};
function withdraw(f, kind, key) {
  if (kind === 'key')
    f.store.replaceCredentials(f.actor.tenantId, 'woo-login', {...f.credentials, consumerSecret: 'cs_newsecret'});
  else if (kind === 'actor') f.store.revokeKey(key);
  else if (kind === 'expiry')
    f.store.replaceCredentials(f.actor.tenantId, 'woo-login', {...f.credentials, expiresAt: Date.now() - 1});
  else
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        ...f.connection,
        ...(kind === 'origin' ? {baseUrl: 'https://other.example.test'} : {}),
        ...(kind === 'scope' ? {scopes: ['write']} : {}),
        ...(kind === 'account' ? {accounts: ['other-store']} : {}),
        ...(kind === 'connection' ? {enabled: false} : {}),
      },
      f.credentials,
    );
}

test('every variation read boundary withholds the complete hierarchy after current authority withdrawal', async () => {
  for (const phase of [1, 2, 3, 4, 5, 6]) {
    for (const kind of ['key', 'origin', 'scope', 'account', 'connection', 'actor', 'expiry']) {
      const f = wooVariationsFixture(),
        key = f.store.createKey(f.actor),
        actor = f.store.authenticate(key);
      try {
        f.respond((url, _options, n) => {
          const response = f.response(url);
          if (n === phase) withdraw(f, kind, key);
          return response;
        });
        hidden(await run(f, actor));
        assert.equal(f.calls.length, phase, kind + ':' + phase);
        assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
      } finally {
        f.close();
      }
    }
  }
});

test('late parent and final currency body chunks recheck credentials before exposing any child', async () => {
  for (const phase of [5, 6]) {
    const f = wooVariationsFixture();
    try {
      f.respond((url, _options, n) =>
        n !== phase
          ? f.response(url)
          : new Response(
              new ReadableStream(
                {
                  pull(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        JSON.stringify(phase === 5 ? f.data.parent : {id: 'woocommerce_currency', value: 'SAR'}),
                      ),
                    );
                    withdraw(f, 'key');
                    controller.close();
                  },
                },
                {highWaterMark: 0},
              ),
              {headers: {'content-type': 'application/json'}},
            ),
      );
      hidden(await run(f));
      assert.equal(f.calls.length, phase);
    } finally {
      f.close();
    }
  }
});

test('all six variation bodies share the byte budget and late native errors cannot expose earlier evidence', async () => {
  for (const kind of ['combined-bytes', 'length', 'redirect', 'native-error', 'utf8', 'body-error']) {
    const f = wooVariationsFixture();
    try {
      f.respond((url, _options, n) => {
        if (kind === 'combined-bytes' && [1, 2, 5].includes(n))
          return Response.json({
            ...(n === 1 ? {id: 'woocommerce_currency', value: 'SAR'} : f.data.parent),
            unused: ' '.repeat(1500000),
          });
        if (n !== 6) return f.response(url);
        if (kind === 'length')
          return new Response('{"id":"woocommerce_currency","value":"SAR"}', {
            headers: {'content-type': 'application/json', 'content-length': '1'},
          });
        if (kind === 'redirect')
          return new Response(null, {
            status: 302,
            headers: {location: 'https://other.example.test?secret=cs_syntheticsecret'},
          });
        if (kind === 'native-error') return new Response('cs_syntheticsecret', {status: 401});
        if (kind === 'utf8')
          return new Response(new Uint8Array([0xc3, 0x28]), {headers: {'content-type': 'application/json'}});
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(Error('cs_syntheticsecret'));
            },
          }),
          {headers: {'content-type': 'application/json'}},
        );
      });
      hidden(await run(f));
      assert.equal(f.calls.length, kind === 'combined-bytes' ? 5 : 6, kind);
    } finally {
      f.close();
    }
  }
});

test('one deadline spans parent children and final currency and aborts a late stalled request or body without retry', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 30000);
    return timeout(35);
  });
  for (const kind of ['request', 'body']) {
    const f = wooVariationsFixture();
    const keepAlive = setInterval(() => {}, 10);
    try {
      f.respond((url, _options, n) =>
        n !== 6
          ? f.response(url)
          : kind === 'request'
            ? new Promise(() => {})
            : new Response(
                new ReadableStream({
                  pull() {
                    return new Promise(() => {});
                  },
                }),
                {headers: {'content-type': 'application/json'}},
              ),
      );
      hidden(await run(f));
      assert.equal(f.calls.length, 6);
      assert.equal(new Set(f.calls.map(c => c.options.signal)).size, 1);
      assert.equal(f.calls[5].options.signal.aborted, true);
    } finally {
      clearInterval(keepAlive);
      f.close();
    }
  }
});
