import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const scope = {property_id: '123', stream_id: '100', test_id: 'amcp-test-synthetic-example'};
const consent = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};
const example = () => ({
  version: 1,
  scope: {...scope},
  coverage: 'partial',
  steps: [
    {sequence: 1, at_ms: 0, kind: 'consent_default', consent: {...consent}},
    {
      sequence: 2,
      at_ms: 10,
      kind: 'event',
      event_name: 'page_view',
      test_id: scope.test_id,
      analytics_storage_write: false,
    },
    {sequence: 3, at_ms: 10, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
    {
      sequence: 4,
      at_ms: 20,
      kind: 'event',
      event_name: 'purchase',
      test_id: scope.test_id,
      transaction_key: 'opaque-' + 'a'.repeat(64),
    },
  ],
});
function inspect(f, value) {
  f.context.traceInput = typeof value === 'string' ? value : JSON.stringify(value);
  return plain(f.run('measurementTraceInspect(traceInput,{account_id:"123"})'));
}
for (const locale of ['en', 'ar']) {
  test(
    locale + ' trace retains precise input order, consent inheritance and explicit evidence limits without any call',
    () => {
      const f = accountWorkflowFixture(locale),
        out = inspect(f, example());
      assert.equal(out.scope.property_id, '123');
      assert.equal(out.coverage, 'partial');
      assert.deepEqual(out.findings, []);
      assert.equal(out.rows[1].consent.analytics_storage, 'denied');
      assert.equal(out.rows[2].consent.analytics_storage, 'granted');
      assert.equal(out.rows[2].consent.ad_storage, 'denied');
      assert.equal(out.rows[1].at_ms, out.rows[2].at_ms);
      assert.equal(out.runtime_acceptance, 'unverified');
      assert.equal(out.native_deduplication, 'unverified');
      assert.equal(out.attribution, 'unverified');
      assert.equal(out.network_requests, 0);
      assert.doesNotMatch(JSON.stringify(out), /opaque-|cookie|transaction_id/);
      assert.equal(f.calls.length + f.httpCalls.length, 0);
    },
  );
  test(
    locale +
      ' identifies declared ordering, storage conflicts and repeated purchase keys without assuming native deduplication',
    () => {
      const f = accountWorkflowFixture(locale),
        trace = example();
      trace.steps[0] = {sequence: 1, at_ms: 0, kind: 'event', event_name: 'page_view', test_id: scope.test_id};
      trace.steps[1] = {sequence: 2, at_ms: 10, kind: 'consent_default', consent: {...consent}};
      trace.steps[2] = {
        sequence: 3,
        at_ms: 10,
        kind: 'event',
        event_name: 'purchase',
        test_id: scope.test_id,
        transaction_key: 'opaque-' + 'a'.repeat(64),
        analytics_storage_write: true,
        ad_storage_write: true,
      };
      const out = inspect(f, trace);
      assert.deepEqual(
        out.findings.map(f => f.code),
        [
          'event_without_default',
          'late_default',
          'analytics_storage_conflict',
          'ad_storage_conflict',
          'repeated_purchase_key',
        ],
      );
      assert.equal(out.rows[0].consent.analytics_storage, 'unknown');
      f.context.out = out;
      const markup = f.run('measurementTraceResult(out)');
      assert.doesNotMatch(markup, /opaque-|transaction_id/);
      assert.match(markup, locale === 'ar' ? /الموافقة|التتبّع/ : /does not prove that GA4 counted twice/);
      assert.equal(f.calls.length + f.httpCalls.length, 0);
    },
  );
  test(
    locale + ' rejects foreign scope, native personal data, ambiguous fields, invalid clocks and unbounded traces',
    () => {
      const f = accountWorkflowFixture(locale);
      const mutations = [
        v => (v.scope.property_id = '999'),
        v => (v.scope.stream_id = 100),
        v => (v.scope.test_id = 'real-user-identity'),
        v => (v.steps[1].test_id = 'amcp-test-other-example'),
        v => (v.scope.user_id = 'PRIVATE'),
        v => (v.steps[1].cookie = 'PRIVATE'),
        v => (v.steps[1].transaction_id = 'PRIVATE'),
        v => (v.steps[1].url = 'https://example.test/'),
        v => (v.steps[1].at_ms = -1),
        v => (v.steps[2].at_ms = 9),
        v => (v.steps[3].at_ms = 86400001),
        v => (v.steps[1].sequence = 3),
        v => (v.steps[0].consent.analytics_storage = 'unknown'),
        v => (v.steps[0].consent.security_storage = 'granted'),
        v => (v.steps[1].analytics_storage_write = 'true'),
        v => (v.steps[3].transaction_key = 'original-purchase'),
        v => (v.steps[1].event_name = '<script>'),
        v => (v.coverage = 'verified'),
        v => (v.steps = []),
        v => (v.version = 2),
      ];
      for (const change of mutations) {
        const trace = example();
        change(trace);
        assert.throws(() => inspect(f, trace));
      }
      const text = JSON.stringify(example());
      for (const duplicate of [
        text.replace('"property_id":"123"', '"property_id":"123","property_id":"999"'),
        text.replace('"property_id":"123"', '"property_id":"123","property_\\u0069d":"999"'),
        text.replace('"analytics_storage":"denied"', '"analytics_storage":"denied","analytics_storage":"granted"'),
      ])
        assert.throws(
          () => inspect(f, duplicate),
          error =>
            error.message ===
            (locale === 'ar'
              ? f.context.catalog['Duplicate trace fields cannot establish unambiguous evidence.']
              : 'Duplicate trace fields cannot establish unambiguous evidence.'),
        );
      assert.throws(() => inspect(f, ' '.repeat(131073)));
      assert.throws(() => inspect(f, 'ع'.repeat(65537)));
      assert.throws(() => inspect(f, '{"a":{"a":{"a":{"a":{"a":{"a":{"a":1}}}}}}}'));
      assert.throws(() => inspect(f, '{"version":1,'));
      assert.equal(f.calls.length + f.httpCalls.length, 0);
    },
  );
  test(
    locale +
      ' bounded trace inspection preserves drafts and refuses stale paging after identity, input or navigation changes',
    async () => {
      const f = accountWorkflowFixture(locale);
      await f.run('renderMeasurement()');
      const form = f.node('#measurement-trace');
      form.elements.target.value = '0';
      const property = f.run('accountChoices(["ga4"])[0].account_id');
      const trace = example();
      trace.scope.property_id = property;
      trace.steps = Array.from({length: 51}, (_, i) => ({
        sequence: i + 1,
        at_ms: i,
        kind: 'event',
        event_name: 'page_view',
        test_id: scope.test_id,
      }));
      form.elements.trace.value = JSON.stringify(trace);
      await f.bindings.get('#measurement-trace')(form);
      assert.match(
        f.node('#measurement-trace-result').innerHTML,
        locale === 'ar' ? /ملاحظات/ : /Supplied trace observations/,
      );
      assert.equal((f.node('#measurement-trace-result').innerHTML.match(/<tr>/g) ?? []).length, 26);
      const next = f.bindings.get('#measurement-trace-next');
      await next();
      assert.match(f.node('#measurement-trace-result').innerHTML, /26<\/th>/);
      assert.equal(form.elements.trace.value, JSON.stringify(trace));
      form.dispatchEvent(new Event('input'));
      assert.equal(f.node('#measurement-trace-result').innerHTML, '');
      await next();
      assert.equal(f.node('#measurement-trace-result').innerHTML, '');
      await f.bindings.get('#measurement-trace')(form);
      const stale = f.bindings.get('#measurement-trace-next');
      f.context.identityGeneration++;
      f.node('#measurement-trace-result').innerHTML = 'CURRENT-IDENTITY';
      await stale();
      assert.equal(f.node('#measurement-trace-result').innerHTML, 'CURRENT-IDENTITY');
      assert.equal(f.calls.length + f.httpCalls.length, 0);
    },
  );
}
