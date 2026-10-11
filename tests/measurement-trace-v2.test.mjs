import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// MSR-03 slice A: trace version 2 closes the consent and deduplication model gaps of version 1 (regional defaults,
// merge of undeclared types, default-after-update ordering, wait_for_update, empty transaction IDs, declared write
// columns, stream check) while version 1 keeps its original model. Everything runs in the page, with no call.
const plain = v => JSON.parse(JSON.stringify(v));
const test_id = 'amcp-test-synthetic-example';
const all = value => ({
  analytics_storage: value,
  ad_storage: value,
  ad_user_data: value,
  ad_personalization: value,
});
const emptyKey = 'opaque-' + createHash('sha256').update('').digest('hex');
const event = (sequence, at_ms, extra = {}) => ({
  sequence,
  at_ms,
  kind: 'event',
  event_name: 'page_view',
  test_id,
  ...extra,
});
const trace = (steps, visitor_region = 'US-CA', version = 2) => ({
  version,
  scope: {property_id: '123', stream_id: '100', test_id, ...(version === 2 ? {visitor_region} : {})},
  coverage: 'complete',
  steps,
});
function inspect(f, value, streams) {
  f.context.traceInput = typeof value === 'string' ? value : JSON.stringify(value);
  f.context.traceStreams = streams;
  return plain(f.run('measurementTraceInspect(traceInput,{account_id:"123"},traceStreams)'));
}
const codes = out => out.findings.map(f => f.code + '@' + f.step);

for (const locale of ['en', 'ar']) {
  test(locale + ' MSR-03 v2 applies the most specific regional default and merges undeclared types', () => {
    const f = accountWorkflowFixture(locale),
      steps = [
        {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied')},
        {sequence: 2, at_ms: 0, kind: 'consent_default', region: ['US'], consent: {analytics_storage: 'granted'}},
        {sequence: 3, at_ms: 0, kind: 'consent_default', region: ['US-CA'], consent: {analytics_storage: 'denied'}},
        event(4, 10, {analytics_storage_write: true}),
      ];
    const california = inspect(f, trace(steps, 'US-CA'));
    assert.equal(california.version, 2);
    assert.equal(california.consent_model, 'regional_defaults_merged');
    // Two defaults for different regions are legitimate: no repeated_default, and undeclared types keep the global value.
    assert.deepEqual(codes(california), ['analytics_storage_conflict@4']);
    assert.equal(california.rows[3].consent.analytics_storage, 'denied');
    assert.equal(california.rows[3].consent.ad_storage, 'denied');
    assert.deepEqual(california.rows[1].region, ['US']);
    const newYork = inspect(f, trace(steps, 'US-NY'));
    assert.deepEqual(codes(newYork), []);
    assert.equal(newYork.rows[3].consent.analytics_storage, 'granted');
    assert.equal(newYork.rows[3].consent.ad_user_data, 'denied');
    const spain = inspect(f, trace(steps, 'ES'));
    assert.equal(spain.rows[3].consent.analytics_storage, 'denied');
    // Version 1 resets undeclared types and treats every second default as repeated (its documented model).
    const v1 = inspect(
      f,
      trace(
        steps.map(({region: _region, ...s}) => s),
        null,
        1,
      ),
    );
    assert.ok(codes(v1).includes('repeated_default@2'));
    assert.equal(v1.rows[1].consent.ad_storage, 'unknown');
    assert.equal(f.calls.length + f.httpCalls.length, 0);
  });

  test(locale + ' MSR-03 v2 keeps a regional default unknown when the visitor region is undeclared', () => {
    const f = accountWorkflowFixture(locale),
      out = inspect(
        f,
        trace(
          [
            {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('granted')},
            {sequence: 2, at_ms: 0, kind: 'consent_default', region: ['DE', 'FR'], consent: {ad_storage: 'denied'}},
            {
              sequence: 3,
              at_ms: 0,
              kind: 'consent_default',
              region: ['DE'],
              consent: {analytics_storage: 'granted'},
            },
            event(4, 5, {ad_storage_write: true}),
          ],
          null,
        ),
      );
    assert.deepEqual(codes(out), ['default_region_unknown@2', 'default_region_unknown@3']);
    assert.equal(out.rows[3].consent.ad_storage, 'unknown', 'disagreeing values never become observed');
    assert.equal(out.rows[3].consent.analytics_storage, 'granted', 'agreeing values stay known');
    f.context.out = out;
    assert.ok(f.run('measurementTraceResult(out)').includes('—'));
  });

  test(locale + ' MSR-03 v2 reports a default after an update as ordering_ambiguous, never a conflict', () => {
    const f = accountWorkflowFixture(locale),
      steps = [
        {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied')},
        {sequence: 2, at_ms: 10, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
        {sequence: 3, at_ms: 20, kind: 'consent_default', consent: {analytics_storage: 'denied'}},
        event(4, 30, {analytics_storage_write: true}),
        {sequence: 5, at_ms: 40, kind: 'consent_update', consent: {analytics_storage: 'denied'}},
        event(6, 50, {analytics_storage_write: true}),
      ];
    const out = inspect(f, trace(steps, 'US'));
    assert.deepEqual(codes(out), ['repeated_default@3', 'ordering_ambiguous@3', 'analytics_storage_conflict@6']);
    assert.equal(out.rows[3].consent.analytics_storage, 'unknown');
    assert.equal(out.rows[5].consent.analytics_storage, 'denied', 'a later update resolves the ambiguity');
    // Version 1 asserts the later default replaced the update and reports a conflict (the gap this fixes).
    const v1 = inspect(f, trace(steps, null, 1));
    assert.ok(codes(v1).includes('analytics_storage_conflict@4'));
  });

  test(locale + ' MSR-03 v2 wait_for_update leaves events inside the wait window unknown', () => {
    const f = accountWorkflowFixture(locale),
      out = inspect(
        f,
        trace([
          {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied'), wait_for_update_ms: 500},
          event(2, 100, {analytics_storage_write: true}),
          {sequence: 3, at_ms: 200, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
          event(4, 300, {analytics_storage_write: true, ad_storage_write: true}),
          event(5, 600, {ad_storage_write: true}),
        ]),
      );
    assert.deepEqual(codes(out), [
      'event_during_consent_wait@2',
      'event_during_consent_wait@4',
      'ad_storage_conflict@5',
    ]);
    assert.equal(out.rows[1].consent.analytics_storage, 'unknown');
    assert.equal(out.rows[3].consent.analytics_storage, 'granted', 'an update ends the wait for its types');
    assert.equal(out.rows[3].consent.ad_storage, 'unknown');
    assert.equal(out.rows[4].consent.ad_storage, 'denied', 'after the timeout the default applies');
    assert.equal(out.rows[0].wait_for_update_ms, 500);
  });

  test(locale + ' MSR-03 the hash of an empty transaction ID is flagged in v1 and v2', () => {
    const f = accountWorkflowFixture(locale),
      purchase = (sequence, extra) => event(sequence, sequence * 10, {event_name: 'purchase', ...extra});
    const v1 = inspect(
      f,
      trace(
        [
          {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('granted')},
          purchase(2, {transaction_key: emptyKey}),
        ],
        null,
        1,
      ),
    );
    assert.deepEqual(codes(v1), ['empty_transaction_key@2']);
    const v2 = inspect(
      f,
      trace([
        {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('granted')},
        purchase(2, {transaction_id_empty: true}),
        purchase(3, {transaction_id_empty: true}),
        purchase(4, {transaction_key: 'opaque-' + 'c'.repeat(64)}),
      ]),
    );
    assert.deepEqual(codes(v2), ['empty_transaction_key@2', 'empty_transaction_key@3', 'repeated_purchase_key@3']);
    assert.doesNotMatch(JSON.stringify(v2), /opaque-|transaction_id/);
    f.context.out = v2;
    const markup = f.run('measurementTraceResult(out)');
    assert.doesNotMatch(markup, /opaque-|transaction_id/);
    assert.ok(
      markup.includes(
        f.run(
          'uiText("Purchase key comes from an empty transaction ID; GA4 deduplicates every purchase with an empty transaction ID")',
        ),
      ),
    );
  });

  test(locale + ' MSR-03 declared storage-write observations are rendered as their own columns', () => {
    const f = accountWorkflowFixture(locale),
      out = inspect(
        f,
        trace(
          [
            {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied')},
            event(2, 1, {analytics_storage_write: true}),
            event(3, 2, {ad_storage_write: false}),
            event(4, 3),
          ],
          null,
          1,
        ),
      );
    f.context.out = out;
    const markup = f.run('measurementTraceResult(out)'),
      t = value => f.run('uiText(' + JSON.stringify(value) + ')');
    assert.ok(markup.includes(t('Declared analytics storage write')));
    assert.ok(markup.includes(t('Declared advertising storage write')));
    const rows = markup.split('<tr>').slice(2);
    assert.equal(rows.length, 4);
    assert.ok(rows[1].includes('<td>' + t('Yes') + '</td><td>' + t('Not declared') + '</td>'));
    assert.ok(rows[2].includes('<td>' + t('Not declared') + '</td><td>' + t('No') + '</td>'));
    assert.ok(rows[0].endsWith('<td></td><td></td></tr>'), 'consent rows declare no writes');
  });

  test(locale + ' MSR-03 v2 refuses malformed regions, waits and empty-ID declarations; v1 stays strict', () => {
    const f = accountWorkflowFixture(locale),
      base = () =>
        trace([
          {sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied'), region: ['US']},
          {sequence: 2, at_ms: 1, kind: 'consent_update', consent: {analytics_storage: 'granted'}},
          event(3, 2, {event_name: 'purchase', transaction_id_empty: true}),
        ]);
    assert.equal(inspect(f, base()).version, 2);
    const mutations = [
      v => delete v.scope.visitor_region,
      v => (v.scope.visitor_region = 'usa'),
      v => (v.scope.visitor_region = ''),
      v => (v.steps[0].region = []),
      v => (v.steps[0].region = ['US', 'US']),
      v => (v.steps[0].region = ['us']),
      v => (v.steps[0].region = 'US'),
      v => (v.steps[0].region = Array.from({length: 51}, (_, i) => 'A' + String.fromCharCode(65 + (i % 26)))),
      v => (v.steps[0].wait_for_update_ms = -1),
      v => (v.steps[0].wait_for_update_ms = 60001),
      v => (v.steps[0].wait_for_update_ms = 1.5),
      v => (v.steps[1].region = ['US']),
      v => (v.steps[1].wait_for_update_ms = 1),
      v => (v.steps[2].transaction_id_empty = false),
      v => (v.steps[2].transaction_key = 'opaque-' + 'a'.repeat(64)),
      v => (v.steps[2].event_name = 'page_view'),
      v => (v.version = 3),
      v => (v.steps[0].consent.security_storage = 'granted'),
    ];
    for (const change of mutations) {
      const value = base();
      change(value);
      assert.throws(
        () => inspect(f, value),
        () => true,
        JSON.stringify(value),
      );
    }
    // Version 1 never accepts version 2 fields.
    for (const change of [
      v => (v.scope.visitor_region = 'US'),
      v => (v.steps[0].region = ['US']),
      v => (v.steps[0].wait_for_update_ms = 0),
      v => (v.steps[1] = event(2, 1, {event_name: 'purchase', transaction_id_empty: true})),
    ]) {
      const value = trace(
        [{sequence: 1, at_ms: 0, kind: 'consent_default', consent: all('denied')}, event(2, 1)],
        null,
        1,
      );
      change(value);
      // An authored refusal of the version 1 trace, never a crash.
      assert.throws(
        () => inspect(f, value),
        error => error.name === 'Error' && !/undefined|Cannot read|is not a function/.test(error.message),
        JSON.stringify(value),
      );
    }
    assert.throws(
      () => inspect(f, {...base(), scope: {...base().scope, visitor_region: 'usa'}}),
      error =>
        error.message ===
        f.run(
          'uiText("Use trace version 2 with the selected GA4 property, an exact stream, a synthetic test identifier, a visitor region code or null, and 1–1000 steps.")',
        ),
    );
    assert.equal(f.calls.length + f.httpCalls.length, 0);
  });

  test(locale + ' MSR-03 the trace stream is compared with synchronized data streams without a request', async () => {
    const f = accountWorkflowFixture(locale),
      value = trace([event(1, 0)], null, 1),
      t = text => f.run('uiText(' + JSON.stringify(text) + ')');
    assert.deepEqual(inspect(f, value).stream_check, {state: 'inventory_unavailable', stream_type: null});
    assert.deepEqual(inspect(f, value, [{id: '100', type: 'WEB_DATA_STREAM'}]).stream_check, {
      state: 'listed',
      stream_type: 'WEB_DATA_STREAM',
    });
    assert.deepEqual(inspect(f, value, [{id: '200', type: null}]).stream_check, {
      state: 'not_listed',
      stream_type: null,
    });
    f.context.out = inspect(f, value, [{id: '100', type: 'ANDROID_APP_DATA_STREAM'}]);
    const markup = f.run('measurementTraceResult(out)');
    assert.ok(markup.includes(t('GA4 deduplicates purchases by transaction ID only for web streams.')));
    // Through the form, the property's synchronized streams are used.
    f.context.platforms.find(p => p.id === 'ga4').connections[0].groups = [
      {
        kind: 'data_streams',
        complete: true,
        assets: [{id: 'properties/123/dataStreams/777', name: 'Web', streamType: 'WEB_DATA_STREAM'}],
      },
    ];
    await f.run('renderMeasurement()');
    const form = f.node('#measurement-trace');
    form.elements.target.value = '0';
    form.elements.trace.value = JSON.stringify({...value, scope: {...value.scope, stream_id: '777'}});
    await f.bindings.get('#measurement-trace')(form);
    assert.ok(
      f
        .node('#measurement-trace-result')
        .innerHTML.includes(t('The trace stream is one of the synchronized data streams of this property.')),
    );
    await f.bindings.get('#measurement-trace-example')();
    assert.equal(
      JSON.parse(form.elements.trace.value).scope.stream_id,
      '777',
      'the example uses a synchronized stream',
    );
    assert.equal(f.calls.length + f.httpCalls.length, 0);
  });

  test(locale + ' MSR-03 a pasted trace over 128 KiB reports its size instead of invalid JSON', async () => {
    const f = accountWorkflowFixture(locale);
    await f.run('renderMeasurement()');
    // The field no longer truncates a paste at the parser's limit, which used to surface as "Use valid JSON".
    const limit = Number(/name="trace"[^>]*maxlength="(\d+)"/.exec(f.node('content').innerHTML)[1]);
    assert.ok(limit > 140022);
    const big = JSON.stringify(trace([event(1, 0)], null, 1)).replace(
      '"coverage"',
      '"pad":"' + 'x'.repeat(140000) + '","coverage"',
    );
    assert.throws(
      () => inspect(f, big),
      error => error.message === f.run('uiText("Use a sanitized trace of at most 128 KiB.")'),
    );
  });
}
