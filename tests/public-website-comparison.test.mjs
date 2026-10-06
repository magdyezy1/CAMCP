import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {comparePublicWebsite, publicWebsiteOrigin, explainAboutInjection} from '../tools/check-public-website.mjs';
import {listenForFetch} from '../dist/tests/http-listener.js';

const local = {
  '/about': fs.readFileSync('web/about.html'),
  '/assets/locales/ar.json': fs.readFileSync('web/locales/ar.json'),
};
async function site(overrides = {}) {
  const requests = [],
    timers = [];
  const listener = await listenForFetch((req, res) => {
    requests.push({method: req.method, path: req.url, headers: req.headers});
    if (overrides.hold === req.url) {
      if (overrides.holdBody) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.write('{"status":');
      }
      const timer = setTimeout(
        () =>
          overrides.holdBody ? res.end('"up"}') : res.writeHead(200, {'Content-Type': 'application/json'}).end('{}'),
        5000,
      );
      timers.push(timer);
      return;
    }
    const override = overrides[req.url];
    if (override) {
      res.writeHead(override.status ?? 200, override.headers ?? {'Content-Type': 'application/json'});
      res.end(override.body);
      return;
    }
    res.writeHead(200, {'Content-Type': req.url === '/about' ? 'text/html' : 'application/json'});
    res.end(req.url === '/healthz' ? '{"status":"up"}' : local[req.url]);
  });
  return {
    origin: 'http://127.0.0.1:' + listener.address().port,
    requests,
    close: async () => {
      timers.forEach(clearTimeout);
      listener.closeAllConnections();
      await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    },
  };
}
const beacon =
    '<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v0123456789abcdef0123456789abcdef" integrity="sha512-QUJDRA==" data-cf-beacon=\'{"token":"SYNTHETIC-PUBLIC-KEY"}\' crossorigin="anonymous"></script>',
  withBeacon = (text = local['/about'].toString(), addition = beacon) =>
    Buffer.from(text.replace('</body>', addition + '</body>'));
test('the current documented module beacon and insertion whitespace preserve every original About byte', () => {
  const text = local['/about'].toString(),
    marker = text.indexOf('</body>');
  let position = marker;
  while (position > 0 && /[ \t]/u.test(text[position - 1])) position--;
  const addition = '\n' + beacon.replace(' defer ', ' type="module" ') + '\n',
    received = Buffer.from(text.slice(0, position) + addition + text.slice(position));
  assert.deepEqual(explainAboutInjection(local['/about'], received), {
    kind: 'cloudflare_web_analytics_insertion',
    inserted_script_count: 1,
    original_html_content_equal: true,
    exact_public_bytes_equal: false,
  });
});
test('a documented single edge beacon explains unchanged original About content while exact byte comparison still fails', async () => {
  const s = await site({'/about': {headers: {'Content-Type': 'text/html'}, body: withBeacon()}});
  try {
    const proof = await comparePublicWebsite({origin: s.origin}),
      about = proof.observations[1];
    assert.equal(proof.passed, false);
    assert.equal(about.matches_local_bytes, false);
    assert.equal(about.passed, false);
    assert.equal(about.error_code, 'PUBLIC_SOURCE_BYTES_DIFFER');
    assert.deepEqual(about.html_transformation, {
      kind: 'cloudflare_web_analytics_insertion',
      inserted_script_count: 1,
      original_html_content_equal: true,
      exact_public_bytes_equal: false,
    });
    assert.notEqual(about.local_sha256, about.observed_sha256);
    assert.doesNotMatch(JSON.stringify(proof), /SYNTHETIC-PUBLIC-KEY|data-cf-beacon|integrity|beacon\.min/);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
for (const [name, addition] of [
  ['two scripts', beacon + beacon],
  ['inline executable content', beacon.replace('></script>', '>PRIVATE-CODE</script>')],
  ['a different host', beacon.replace('static.cloudflareinsights.com', 'private.invalid')],
  [
    'a misleading host suffix',
    beacon.replace('static.cloudflareinsights.com', 'static.cloudflareinsights.com.private.invalid'),
  ],
  ['a query', beacon.replace('beacon.min.js/v', 'beacon.min.js?token=PRIVATE&v=')],
  ['duplicate source', beacon.replace(' defer ', ' defer src="https://private.invalid/x.js" ')],
  ['an event handler', beacon.replace(' defer ', ' defer onload="PRIVATE-CODE" ')],
  ['missing integrity', beacon.replace(' integrity="sha512-QUJDRA=="', '')],
  ['invalid configuration', beacon.replace('{"token":"SYNTHETIC-PUBLIC-KEY"}', 'PRIVATE-NOT-JSON')],
])
  test('About insertion diagnosis refuses ' + name + ' without retaining body/configuration', () => {
    assert.equal(explainAboutInjection(local['/about'], withBeacon(undefined, addition)), null);
  });
test('a known beacon cannot explain changed native markup, insertion elsewhere, arbitrary encodings or oversized input', () => {
  assert.equal(
    explainAboutInjection(local['/about'], withBeacon(local['/about'].toString().replace('AMCP', 'PRIVATE-CHANGED'))),
    null,
  );
  assert.equal(explainAboutInjection(local['/about'], Buffer.concat([Buffer.from(beacon), local['/about']])), null);
  assert.equal(explainAboutInjection(Buffer.from([0xff]), withBeacon()), null);
  assert.equal(explainAboutInjection(local['/about'], Buffer.alloc(262145)), null);
  assert.equal(explainAboutInjection(local['/about'], local['/about']), null);
});
function originalPublicRequests(requests) {
  assert.deepEqual(
    requests.map(r => [r.method, r.path]),
    [
      ['GET', '/healthz'],
      ['GET', '/about'],
      ['GET', '/assets/locales/ar.json'],
    ],
  );
  for (const request of requests) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.origin, undefined);
  }
}
test('actual loopback public comparison reads only three original credential-free GET routes and proves two static byte matches', async () => {
  const s = await site();
  try {
    const proof = await comparePublicWebsite({origin: s.origin});
    assert.equal(proof.passed, true);
    assert.equal(proof.credentials_sent, false);
    assert.equal(proof.redirects_followed, false);
    assert.equal(proof.observations.length, 3);
    assert.equal(proof.observations[0].local_sha256, null);
    assert.equal(proof.observations[0].matches_local_bytes, null);
    for (const record of proof.observations.slice(1)) {
      assert.equal(record.passed, true);
      assert.equal(record.matches_local_bytes, true);
      assert.equal(record.observed_sha256, record.local_sha256);
      assert.ok(record.byte_length > 0);
    }
    assert.match(proof.comparison_scope, /not deployed backend Git\/image/);
    assert.equal(Object.hasOwn(proof, 'deployed_revision'), false);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
test('an actual stale valid public locale is a byte mismatch, despite HTTP success and a matching About page', async () => {
  const s = await site({'/assets/locales/ar.json': {body: '{"Old authored sentence.":"نص قديم."}'}});
  try {
    const proof = await comparePublicWebsite({origin: s.origin});
    assert.equal(proof.passed, false);
    assert.equal(proof.observations[1].passed, true);
    const locale = proof.observations[2];
    assert.equal(locale.status, 200);
    assert.equal(locale.matches_local_bytes, false);
    assert.equal(locale.error_code, 'PUBLIC_SOURCE_BYTES_DIFFER');
    assert.notEqual(locale.observed_sha256, locale.local_sha256);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
test('public redirects are refused without following or copying a Location containing private values', async () => {
  const s = await site({
    '/assets/locales/ar.json': {
      status: 302,
      headers: {Location: 'https://private.invalid/oauth?token=PRIVATE-REDIRECT'},
      body: 'PRIVATE-REDIRECT-BODY',
    },
  });
  try {
    const proof = await comparePublicWebsite({origin: s.origin});
    assert.equal(proof.passed, false);
    assert.equal(proof.observations[2].status, 302);
    assert.equal(proof.observations[2].error_code, 'PUBLIC_REDIRECT_REFUSED');
    assert.equal(proof.observations[2].byte_length, null);
    assert.equal(proof.observations[2].observed_sha256, null);
    assert.doesNotMatch(JSON.stringify(proof), /PRIVATE|private\.invalid/);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
test('malformed public JSON reports a fixed diagnostic without leaking a body or parser error', async () => {
  const s = await site({'/healthz': {body: '{"password":"PRIVATE-PASSWORD","token":"PRIVATE-TOKEN"}X'}});
  try {
    const proof = await comparePublicWebsite({origin: s.origin});
    assert.equal(proof.passed, false);
    assert.equal(proof.observations[0].status, 200);
    assert.equal(proof.observations[0].error_code, 'PUBLIC_JSON_INVALID');
    assert.doesNotMatch(JSON.stringify(proof), /PRIVATE|password|token/);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
test('an actual excessive public response stops collection at the per-resource limit', async () => {
  const s = await site({'/about': {headers: {'Content-Type': 'text/html'}, body: 'x'.repeat(262145)}});
  try {
    const proof = await comparePublicWebsite({origin: s.origin});
    assert.equal(proof.passed, false);
    assert.equal(proof.observations[1].error_code, 'PUBLIC_RESPONSE_TOO_LARGE');
    assert.equal(proof.observations[1].byte_length, null);
    assert.equal(proof.observations[1].observed_sha256, null);
    originalPublicRequests(s.requests);
  } finally {
    await s.close();
  }
});
for (const holdBody of [false, true])
  test('an actual public ' + (holdBody ? 'body' : 'header') + ' timeout retains safe bounded diagnostics', async () => {
    const s = await site({hold: '/healthz', holdBody});
    try {
      const proof = await comparePublicWebsite({origin: s.origin, timeoutMs: 500});
      assert.equal(proof.passed, false);
      assert.equal(proof.observations[0].error_code, 'PUBLIC_READ_TIMEOUT');
      assert.equal(proof.observations[0].status, holdBody ? 200 : null);
      assert.doesNotMatch(JSON.stringify(proof), /stack|PRIVATE/);
    } finally {
      await s.close();
    }
  });
test('public origin validation excludes credentials, arbitrary cleartext hosts and path/query/fragment targets before any request', async () => {
  for (const origin of [
    'https://user:PRIVATE-PASSWORD@example.invalid',
    'https://example.invalid/path',
    'https://example.invalid?token=PRIVATE-TOKEN',
    'https://example.invalid/#PRIVATE-FRAGMENT',
    'http://example.invalid',
    'http://localhost.example.invalid',
    'file:///C:/PRIVATE-FILE',
    'invalid PRIVATE-VALUE',
  ]) {
    let calls = 0;
    await assert.rejects(
      comparePublicWebsite({
        origin,
        fetcher: async () => {
          calls++;
          throw Error('Unexpected request');
        },
      }),
      {diagnosticCode: 'INVALID_PUBLIC_ORIGIN'},
    );
    assert.equal(calls, 0);
  }
  assert.equal(publicWebsiteOrigin('https://example.invalid/'), 'https://example.invalid');
  assert.equal(publicWebsiteOrigin('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const timeoutMs of [0, -1, 30001, 1.5])
    await assert.rejects(comparePublicWebsite({origin: 'https://example.invalid', timeoutMs}), {
      diagnosticCode: 'INVALID_PUBLIC_READ_TIMEOUT',
    });
});

for (const excess of [0, 1])
  test(
    'actual Arabic response ' +
      (excess ? 'over' : 'at') +
      ' the 2 MiB received-byte limit has the expected bounded outcome',
    async () => {
      const maximum = 2097152,
        empty = JSON.stringify({Boundary: ''}),
        body = JSON.stringify({Boundary: 'a'.repeat(maximum - Buffer.byteLength(empty) + excess)});
      assert.equal(Buffer.byteLength(body), maximum + excess);
      const s = await site({'/assets/locales/ar.json': {body}});
      try {
        const proof = await comparePublicWebsite({origin: s.origin}),
          record = proof.observations[2];
        assert.equal(proof.passed, false);
        assert.equal(record.error_code, excess ? 'PUBLIC_RESPONSE_TOO_LARGE' : 'PUBLIC_SOURCE_BYTES_DIFFER');
        assert.equal(record.byte_length, excess ? null : maximum);
        if (excess) assert.equal(record.observed_sha256, null);
        else assert.match(record.observed_sha256, /^[a-f0-9]{64}$/);
        originalPublicRequests(s.requests);
      } finally {
        await s.close();
      }
    },
  );

for (const status of ['up', 'degraded'])
  test('actual public liveness ' + status + ' remains accepted with only the fixed reported state', async () => {
    const s = await site({
      '/healthz': {
        body: JSON.stringify({
          status,
          version: 'PRIVATE-VERSION',
          checks: {database: 'PRIVATE-CHECK'},
          other: 'PRIVATE-FIELD',
        }),
      },
    });
    try {
      const proof = await comparePublicWebsite({origin: s.origin});
      assert.equal(proof.passed, true);
      assert.equal(proof.observations[0].passed, true);
      assert.equal(proof.observations[0].reported_liveness, status);
      assert.doesNotMatch(JSON.stringify(proof), /PRIVATE|version|database|other/);
      originalPublicRequests(s.requests);
    } finally {
      await s.close();
    }
  });
for (const status of ['unavailable', 'down', 'UP', 'PRIVATE-STATE', null, {}, 42, undefined])
  test(
    'actual public HTTP 200 with invalid liveness ' + JSON.stringify(status) + ' is refused without body leakage',
    async () => {
      const s = await site({'/healthz': {body: JSON.stringify({status, secret: 'PRIVATE-SECRET'})}});
      try {
        const proof = await comparePublicWebsite({origin: s.origin}),
          record = proof.observations[0];
        assert.equal(proof.passed, false);
        assert.equal(record.status, 200);
        assert.equal(record.passed, false);
        assert.equal(record.error_code, 'PUBLIC_LIVENESS_STATE_INVALID');
        assert.equal(record.reported_liveness, undefined);
        assert.doesNotMatch(JSON.stringify(proof), /PRIVATE|secret|unavailable|down/);
        assert.equal(proof.observations[1].passed, true);
        assert.equal(proof.observations[2].passed, true);
        originalPublicRequests(s.requests);
      } finally {
        await s.close();
      }
    },
  );
