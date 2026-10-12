import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// MSR-03 slice A converters: a dataLayer export or a HAR file becomes a sanitized version 2 trace in the page. The
// tests prove that URLs, cookies, user and client IDs and raw transaction IDs never reach the output, that the size is
// checked before a file is read, and that converting and inspecting make no request and store nothing.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const text = (locale, value) => (locale === 'ar' ? catalog[value] : value);
const secrets = [
  'https://',
  'shop.example',
  'person@example.com',
  'U-SECRET-1',
  '555.666',
  'T-SECRET-42',
  'GCLID-SECRET',
  'GA1.1',
  'functionality_storage',
  'gtm.js',
  '2026-10-10',
  'G111',
  'G-OTHER',
  'session-cookie',
];
const dataLayer = [
  {0: 'js', 1: '2026-10-10T00:00:00Z'},
  {
    0: 'consent',
    1: 'default',
    2: {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      functionality_storage: 'granted',
      region: ['US-CA'],
      wait_for_update: 500,
    },
  },
  {
    0: 'config',
    1: 'G-ABC123',
    2: {
      page_location: 'https://shop.example/checkout?email=person@example.com',
      user_id: 'U-SECRET-1',
      client_id: '555.666',
    },
  },
  {event: 'gtm.js', 'gtm.start': 1696900000000},
  {event: 'page_view', page_location: 'https://shop.example/p?gclid=GCLID-SECRET', user_id: 'U-SECRET-1'},
  ['consent', 'update', {analytics_storage: 'granted', ad_storage: 'granted'}],
  {
    0: 'event',
    1: 'purchase',
    2: {transaction_id: 'T-SECRET-42', value: 10, currency: 'SAR', user_data: {email: 'person@example.com'}},
  },
  {event: 'purchase', ecommerce: {transaction_id: '', items: [{item_id: 'U-SECRET-1'}]}},
  {event: 'purchase', ecommerce: {transaction_id: 'T-SECRET-42'}},
  {event: 'cookie_sync', _ga: 'GA1.1.123.456', cookie: 'session-cookie=1'},
];
const har = {
  log: {
    entries: [
      {
        request: {
          method: 'GET',
          url: 'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view&dl=https%3A%2F%2Fshop.example%2Fx&uid=U-SECRET-1&cid=555.666&gcs=G111',
          headers: [{name: 'Cookie', value: 'session-cookie=1; _ga=GA1.1.123'}],
          cookies: [{name: '_ga', value: 'GA1.1.123'}],
        },
      },
      {
        request: {
          method: 'POST',
          url: 'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=555.666',
          postData: {text: 'en=purchase&ep.transaction_id=T-SECRET-42&up.email=person%40example.com\r\nen=add_to_cart'},
        },
      },
      {request: {method: 'GET', url: 'https://region1.google-analytics.com/g/collect?v=2&tid=G-OTHER&en=page_view'}},
      {request: {method: 'POST', url: 'https://shop.example/api/checkout?user=U-SECRET-1', postData: {text: 'x=1'}}},
      {request: {method: 'GET', url: 'not a url'}},
    ],
  },
};
function setup(locale, options = {}) {
  const f = accountWorkflowFixture(locale),
    storage = [];
  f.context.location.search = '';
  f.context.location.pathname = '/measurement';
  f.context.history = {state: null, replaceState() {}};
  // Any request or storage write fails the test.
  f.context.fetch = () => {
    throw Error('A converter must not make a request');
  };
  f.context.XMLHttpRequest = function () {
    throw Error('A converter must not make a request');
  };
  for (const name of ['localStorage', 'sessionStorage'])
    f.context[name] = {
      setItem: key => storage.push(name + ':' + key),
      getItem: () => null,
      removeItem() {},
    };
  f.context.platforms.find(p => p.id === 'ga4').connections[0].groups = [
    {
      kind: 'data_streams',
      assets: options.unsynced
        ? [{id: 'properties/123/dataStreams/900', name: 'Web'}]
        : [
            {
              id: 'properties/123/dataStreams/900',
              name: 'Web',
              measurementId: 'G-ABC123',
              streamType: 'WEB_DATA_STREAM',
            },
          ],
    },
  ];
  return {...f, storage};
}
const choose = (f, format, content, size) => {
  const reads = [];
  f.node('measurement-trace:import_format').value = format;
  f.node('measurement-trace:import_file').files = [
    {
      size: size ?? Buffer.byteLength(content),
      text: async () => {
        reads.push(1);
        return content;
      },
    },
  ];
  return reads;
};
const convert = f => f.bindings.get('#measurement-trace-convert')();
const inspect = f => f.bindings.get('#measurement-trace')(f.node('#measurement-trace'));

for (const locale of ['en', 'ar']) {
  test(
    locale + ' MSR-03 a dataLayer export keeps only consent, event names, order and keyed purchase hashes',
    async () => {
      const f = setup(locale);
      await f.run('renderMeasurement()');
      const testId = f.node('measurement-trace:import_test_id').value;
      assert.match(testId, /^amcp-test-import-[0-9a-f]{12}$/, 'a synthetic identifier is generated locally');
      // WEB-05 regression (browser QA wave 2): the generated identifier is the field's starting value, so a fresh
      // /measurement reports no unsaved edits and a language switch asks nothing.
      assert.equal(
        f.node('measurement-trace:import_test_id').defaultValue,
        testId,
        'the generated identifier is not an unsaved edit',
      );
      choose(f, 'datalayer', JSON.stringify(dataLayer));
      await convert(f);
      const json = f.node('measurement-trace:trace').value;
      for (const secret of secrets) assert.ok(!json.includes(secret), 'leaked ' + secret);
      const trace = JSON.parse(json);
      assert.equal(trace.version, 2);
      assert.deepEqual(trace.scope, {property_id: '123', stream_id: '900', test_id: testId, visitor_region: null});
      assert.equal(trace.coverage, 'partial');
      assert.deepEqual(
        trace.steps.map(s => [s.sequence, s.at_ms, s.kind, s.event_name ?? null]),
        [
          [1, 0, 'consent_default', null],
          [2, 1, 'event', 'page_view'],
          [3, 2, 'consent_update', null],
          [4, 3, 'event', 'purchase'],
          [5, 4, 'event', 'purchase'],
          [6, 5, 'event', 'purchase'],
          [7, 6, 'event', 'cookie_sync'],
        ],
      );
      assert.deepEqual(trace.steps[0], {
        sequence: 1,
        at_ms: 0,
        kind: 'consent_default',
        consent: {
          analytics_storage: 'denied',
          ad_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
        },
        region: ['US-CA'],
        wait_for_update_ms: 500,
      });
      const [first, empty, second] = trace.steps.slice(3, 6);
      assert.match(first.transaction_key, /^opaque-[0-9a-f]{64}$/);
      assert.notEqual(
        first.transaction_key,
        'opaque-' + createHash('sha256').update('T-SECRET-42').digest('hex'),
        'an unkeyed hash of the ID never appears',
      );
      assert.equal(second.transaction_key, first.transaction_key, 'one key per page session');
      assert.deepEqual(Object.keys(empty).sort(), [
        'at_ms',
        'event_name',
        'kind',
        'sequence',
        'test_id',
        'transaction_id_empty',
      ]);
      assert.equal(empty.transaction_id_empty, true);
      for (const step of trace.steps.filter(s => s.kind === 'event'))
        assert.deepEqual(
          Object.keys(step).filter(
            k =>
              ![
                'sequence',
                'at_ms',
                'kind',
                'event_name',
                'test_id',
                'transaction_key',
                'transaction_id_empty',
              ].includes(k),
          ),
          [],
        );
      const status = f.node('#measurement-trace-import-status').textContent;
      assert.ok(status.length > 0);
      // The converted trace is inspected locally and reports what the inspector can establish.
      await inspect(f);
      const result = f.node('#measurement-trace-result').innerHTML;
      for (const finding of [
        'Repeated hashed purchase key',
        'Purchase key comes from an empty transaction ID; GA4 deduplicates every purchase with an empty transaction ID',
        'A region-specific default applies only if the visitor is in that region, and the trace declares no visitor region',
      ])
        assert.ok(result.includes(text(locale, finding)), finding);
      assert.deepEqual(f.calls, [], 'no workspace call');
      assert.deepEqual(f.httpCalls, [], 'no website request');
      assert.deepEqual(f.storage, [], 'nothing stored');
    },
  );

  test(locale + ' MSR-03 a HAR file keeps only GA4 collect event names of the selected stream', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    choose(f, 'har', JSON.stringify(har));
    await convert(f);
    const json = f.node('measurement-trace:trace').value;
    for (const secret of secrets) assert.ok(!json.includes(secret), 'leaked ' + secret);
    const trace = JSON.parse(json);
    assert.deepEqual(
      trace.steps.map(s => [s.kind, s.event_name]),
      [
        ['event', 'page_view'],
        ['event', 'purchase'],
        ['event', 'add_to_cart'],
      ],
    );
    assert.ok(trace.steps.every(s => !('transaction_key' in s) && !('consent' in s)));
    const status = f.node('#measurement-trace-import-status').textContent;
    assert.ok(
      status.includes(
        text(
          locale,
          'A HAR file establishes no consent state, because GA4 does not document its gcs and gcd parameters.',
        ),
      ),
    );
    assert.ok(
      status.includes(text(locale, '{count} requests of other streams were left out.').replace('{count}', '1')),
    );
    await inspect(f);
    assert.ok(
      f.node('#measurement-trace-result').innerHTML.includes(text(locale, 'Event has no preceding consent default')),
      'consent stays unknown',
    );
    // Without a synchronized measurement ID, every GA4 stream is kept and the status says so.
    const g = setup(locale, {unsynced: true});
    await g.run('renderMeasurement()');
    choose(g, 'har', JSON.stringify(har));
    await convert(g);
    assert.equal(JSON.parse(g.node('measurement-trace:trace').value).steps.length, 4);
    assert.ok(
      g
        .node('#measurement-trace-import-status')
        .textContent.includes(
          text(
            locale,
            'The measurement ID of this stream is not synchronized, so requests of every GA4 stream were kept.',
          ),
        ),
    );
    assert.deepEqual([...f.calls, ...g.calls, ...f.httpCalls, ...g.httpCalls, ...f.storage, ...g.storage], []);
  });

  test(locale + ' MSR-03 converter refusals: size before reading, malformed files and missing choices', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    const reads = choose(f, 'datalayer', '[]', 2 * 1024 * 1024 + 1);
    await assert.rejects(convert(f), e => e.message === text(locale, 'Choose a dataLayer export of at most 2 MiB.'));
    assert.equal(reads.length, 0, 'an oversized file is never read');
    const harReads = choose(f, 'har', '{}', 16 * 1024 * 1024 + 1);
    await assert.rejects(convert(f), e => e.message === text(locale, 'Choose a HAR file of at most 16 MiB.'));
    assert.equal(harReads.length, 0);
    // A file whose declared size understates its content is still refused after reading.
    choose(f, 'datalayer', JSON.stringify(['x'.repeat(2 * 1024 * 1024 + 10)]), 10);
    await assert.rejects(convert(f), e => e.message === text(locale, 'Choose a dataLayer export of at most 2 MiB.'));
    for (const [format, content, message] of [
      ['datalayer', '{"event":"purchase"}', 'A dataLayer export is a JSON array of dataLayer entries.'],
      ['datalayer', 'not json', 'A dataLayer export is a JSON array of dataLayer entries.'],
      ['har', '[]', 'A HAR file is JSON with log.entries.'],
      ['datalayer', '[{"event":"gtm.js"}]', 'The file contains no consent command or event that a trace can use.'],
    ]) {
      choose(f, format, content);
      await assert.rejects(convert(f), e => e.message === text(locale, message), content);
    }
    f.node('measurement-trace:import_file').files = [];
    await assert.rejects(convert(f), e => e.message === text(locale, 'Choose a file to convert.'));
    choose(f, 'datalayer', JSON.stringify(dataLayer));
    f.node('measurement-trace:import_test_id').value = 'not-synthetic';
    await assert.rejects(
      convert(f),
      e =>
        e.message ===
        text(
          locale,
          'Use a synthetic test identifier that starts with amcp-test- followed by 8–64 letters, digits or hyphens.',
        ),
    );
    f.node('measurement-trace:import_test_id').value = 'amcp-test-12345678';
    f.node('measurement-trace:import_stream').value = 'stream-1';
    await assert.rejects(
      convert(f),
      e => e.message === text(locale, 'Choose the GA4 property and enter its exact numeric data stream ID.'),
    );
    assert.equal(f.node('measurement-trace:trace').value, '', 'a refused conversion fills nothing');
    assert.deepEqual([...f.calls, ...f.httpCalls, ...f.storage], []);
  });

  test(locale + ' MSR-03 a long session keeps its first steps within the inspector limit', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    const long = Array.from({length: 1500}, (_, i) => ({event: i % 2 ? 'page_view' : 'scroll_depth_reached'}));
    choose(f, 'datalayer', JSON.stringify(long));
    await convert(f);
    const json = f.node('measurement-trace:trace').value,
      trace = JSON.parse(json);
    assert.ok(Buffer.byteLength(json) <= 131072);
    assert.ok(trace.steps.length > 0 && trace.steps.length <= 1000);
    assert.ok(
      f
        .node('#measurement-trace-import-status')
        .textContent.includes(
          text(locale, 'Only the first {steps} steps were kept.').replace(
            '{steps}',
            f.run(`uiNumber(${trace.steps.length})`),
          ),
        ),
    );
    await inspect(f);
    assert.match(f.node('#measurement-trace-result').innerHTML, /measurement-trace-heading/);
  });
}

test('MSR-03 every page session uses its own hashing key', async () => {
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const f = setup('en');
    await f.run('renderMeasurement()');
    choose(f, 'datalayer', JSON.stringify([{0: 'event', 1: 'purchase', 2: {transaction_id: 'T-SECRET-42'}}]));
    await convert(f);
    keys.push(JSON.parse(f.node('measurement-trace:trace').value).steps[0].transaction_key);
  }
  assert.notEqual(keys[0], keys[1]);
});
