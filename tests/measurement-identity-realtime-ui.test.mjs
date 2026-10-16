// MSR-04: the website labels the realtime identity mode and its latency, sends a minute window instead of calendar
// dates, and refuses a response that does not carry the user-level, not-event-level labels it asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture as fixture} from './fixtures/account-workflows-ui.mjs';

const identity = 'amcp-test-12345678-abcd';
const realtimeObservation = () => ({
  record_kind: 'measurement_event_identity',
  mode: 'realtime_user_scope',
  state: 'observed',
  scope: {
    gateway: 'ga4_native_action',
    connection_id: 'ga4-login',
    property_id: '123',
    mode: 'realtime_user_scope',
    event_name: 'purchase',
    test_id: identity,
    identity_dimension: 'customUser:amcp_test_id',
    stream_id: '900',
    minutes: 10,
  },
  relative_window: {start_minutes_ago: 9, end_minutes_ago: 0, reference: 'provider request processing time'},
  latency: 'realtime',
  observation: {reported_count: '2', declared_expected_count: '1', comparison: 'above_declared'},
  rows: [{event_name: 'purchase', test_id: identity, stream_id: '900', event_count: '2'}],
  checks: {identity_scope: 'user', test_event_identity: 'user_scope_matched', event_level_proof: 'not_established'},
  requested_at: 1,
  captured_at: 2,
});
async function submit(locale, out, minutes = '10') {
  const f = fixture(locale);
  f.respond(() => out);
  await f.run('renderMeasurement()');
  const form = f.node('#measurement-event-identity');
  form.elements.mode.value = 'realtime_user_scope';
  form.elements.minutes.value = minutes;
  form.elements.mode.events.get('change')();
  return {f, form, pending: f.bindings.get('#measurement-event-identity')(form)};
}

for (const locale of ['en', 'ar'])
  test(
    locale + ' realtime identity sends a minute window, labels user scope and latency, and states cleanup',
    async () => {
      const {f, pending} = await submit(locale, realtimeObservation());
      await pending;
      assert.equal(f.node('#measurement-identity-dates').hidden, true);
      assert.equal(f.node('#measurement-identity-minutes').hidden, false);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.calls[0].requirements, {
        mode: 'realtime_user_scope',
        event_name: 'purchase',
        test_id: identity,
        minutes: 10,
        expected_count: 1,
        stream_id: '900',
      });
      const html = f.node('#measurement-event-identity-result').innerHTML;
      assert.match(html, locale === 'ar' ? /فترة الوقت الفعلي: آخر 10 دقيقة/ : /Realtime window: the last 10 minutes/);
      assert.match(html, locale === 'ar' ? /ليس إثباتًا على مستوى الحدث/ : /not event-level proof/);
      assert.match(html, locale === 'ar' ? /متصفحًا أو جهازًا مخصصًا/ : /dedicated test browser or device/);
      assert.doesNotMatch(html, locale === 'ar' ? /التواريخ التقويمية للموقع/ : /Property calendar dates/);
    },
  );

test('a realtime request refuses a response without the realtime labels or with another window', async () => {
  for (const change of [
    out => {
      delete out.mode;
    },
    out => {
      out.scope.minutes = 30;
    },
    out => {
      out.relative_window.start_minutes_ago = 29;
    },
    out => {
      out.scope.identity_dimension = 'customEvent:amcp_test_id';
    },
    out => {
      out.checks.event_level_proof = 'established';
    },
  ]) {
    const out = realtimeObservation();
    change(out);
    const {f, pending} = await submit('en', out);
    await pending;
    assert.equal(f.node('#measurement-event-identity-result').innerHTML, '');
  }
});

test('the core report form is unchanged: no mode or minutes are sent and a realtime response is refused', async () => {
  const f = fixture('en');
  f.respond(() => realtimeObservation());
  await f.run('renderMeasurement()');
  await f.bindings.get('#measurement-event-identity')(f.node('#measurement-event-identity'));
  assert.deepEqual(Object.keys(f.calls[0].requirements).sort(), [
    'date_from',
    'date_to',
    'event_name',
    'expected_count',
    'stream_id',
    'test_id',
  ]);
  assert.equal(f.node('#measurement-event-identity-result').innerHTML, '');
});

test('a realtime handoff link prefills the minute window and mode without reading; malformed links select nothing', async () => {
  const original = new URLSearchParams({
    event_identity: '1',
    connection_id: 'ga4-login',
    account_id: '123',
    event_name: 'purchase',
    test_id: identity,
    mode: 'realtime_user_scope',
    minutes: '10',
    expected_count: '2',
  });
  const f = fixture('en');
  f.context.location.search = '?' + original;
  await f.run('renderMeasurement()');
  const form = f.node('#measurement-event-identity');
  assert.equal(form.elements.target.value, '0');
  assert.equal(form.elements.mode.value, 'realtime_user_scope');
  assert.equal(form.elements.minutes.value, '10');
  assert.equal(f.node('#measurement-identity-dates').hidden, true);
  assert.deepEqual(f.calls, []);
  for (const change of [
    p => p.set('minutes', '31'),
    p => p.set('minutes', '0'),
    p => p.delete('minutes'),
    p => p.set('date_from', '2026-10-01'),
    p => p.set('mode', 'event_trace'),
  ]) {
    const g = fixture('en'),
      p = new URLSearchParams(original);
    change(p);
    g.context.location.search = '?' + p;
    await g.run('renderMeasurement()');
    assert.equal(g.node('#measurement-event-identity').elements.target.value, '', String(p));
    assert.deepEqual(g.calls, []);
  }
});
