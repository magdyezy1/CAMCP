// MSR-04: LinkedIn's own last-callback times (lastCallbackAt, latestFirstPartyCallbackAt) are shown as clearly labelled
// observations. Before this change projectRule dropped them, so a rule LinkedIn reports as firing looked the same as one
// that never fired. Null stays unknown, never "never fired", and the times never enter a write fingerprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {
  conversionMetadataConnectionId,
  conversionMetadataFixture,
  conversionMetadataRule,
} from './fixtures/linkedin-conversion-metadata-data.mjs';
import {linkedinConversionConfiguration} from '../dist/src/linkedin-conversion-state.js';
import {stable} from '../dist/src/security.js';

const plain = value => JSON.parse(JSON.stringify(value));
const fired = Date.UTC(2026, 9, 1, 12, 30),
  firstParty = Date.UTC(2026, 9, 2, 8, 0);
const rows = () => [
  conversionMetadataRule(0, {lastCallbackAt: fired, latestFirstPartyCallbackAt: firstParty}),
  conversionMetadataRule(1, {lastCallbackAt: fired}),
  conversionMetadataRule(2),
  conversionMetadataRule(3, {lastCallbackAt: null}),
];
async function read(t, value = rows()) {
  const native = conversionMetadataFixture('unknown');
  t.after(native.close);
  native.setRows(value);
  const response = await native.call();
  return {native, response};
}

test('LinkedIn reported callback times are projected as observations and absent times stay null (unknown)', async t => {
  const {native, response} = await read(t);
  assert.equal(response.success, true, JSON.stringify(response));
  const [both, last, absent, explicitNull] = response.data.rules;
  assert.equal(both.last_callback_at, fired);
  assert.equal(both.latest_first_party_callback_at, firstParty);
  assert.equal(last.last_callback_at, fired);
  assert.equal(last.latest_first_party_callback_at, null);
  assert.equal(absent.last_callback_at, null);
  assert.equal(absent.latest_first_party_callback_at, null);
  assert.equal(explicitNull.last_callback_at, null);
  assert.equal(response.data.checks.observed_activity, 'provider_reported');
  // A reported time is not delivery proof.
  assert.equal(response.data.checks.event_delivery, 'unverified');
  assert.match(response.data.meaning, /null is unknown, not 'never fired'/);
  assert.equal(native.requests.length, 3);
  assert.ok(native.requests.every(r => r.method === 'GET'));
});

test('a LinkedIn response without callback times reports observed activity as not reported, never as never fired', async t => {
  const {response} = await read(t, [conversionMetadataRule(0), conversionMetadataRule(1)]);
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.data.checks.observed_activity, 'not_reported');
  assert.ok(response.data.rules.every(r => r.last_callback_at === null && r.latest_first_party_callback_at === null));
});

test('a malformed LinkedIn callback time refuses the whole read instead of showing a guessed time', async t => {
  for (const value of ['1700000000000', -1, 0, 1.5, {}, Number.MAX_SAFE_INTEGER + 2]) {
    const {response} = await read(t, [conversionMetadataRule(0, {lastCallbackAt: value})]);
    assert.equal(response.success, false, String(value));
    assert.equal(response.error.code, 'MEASUREMENT_EVIDENCE_INVALID');
    assert.match(response.error.message, /invalid conversion callback time/);
  }
  const {response} = await read(t, [conversionMetadataRule(0, {latestFirstPartyCallbackAt: 'yesterday'})]);
  assert.equal(response.error?.code, 'MEASUREMENT_EVIDENCE_INVALID');
  assert.match(response.error.message, /invalid conversion callback time/);
});

test('callback times never change the write-state projection or its fingerprint', () => {
  const base = {
      id: '42',
      account: 'urn:li:sponsoredAccount:100',
      name: 'Purchase',
      enabled: true,
      value: {amount: '010.50', currencyCode: 'USD'},
    },
    quiet = linkedinConversionConfiguration(structuredClone(base)),
    active = linkedinConversionConfiguration({...structuredClone(base), lastCallbackAt: fired}),
    firstPartyActive = linkedinConversionConfiguration({
      ...structuredClone(base),
      lastCallbackAt: firstParty,
      latestFirstPartyCallbackAt: firstParty,
    });
  assert.deepEqual(active, quiet);
  assert.equal(stable(active), stable(quiet));
  assert.equal(stable(firstPartyActive), stable(quiet));
  assert.equal('lastCallbackAt' in active, false);
  assert.equal('latestFirstPartyCallbackAt' in firstPartyActive, false);
});

async function page(t, locale, out) {
  const f = accountWorkflowFixture(locale);
  f.context.platforms.find(p => p.id === 'linkedin').connections[0].id = conversionMetadataConnectionId;
  f.respond(() => plain(out));
  await f.run('renderMeasurement()');
  await f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions'));
  return f;
}
for (const locale of ['en', 'ar']) {
  test(locale + ' the observed activity column shows reported times, keeps Unknown and states the lag', async t => {
    const {response} = await read(t);
    const f = await page(t, locale, response.data),
      html = f.node('#conversion-rule-rows').innerHTML;
    assert.match(html, locale === 'ar' ? /النشاط المرصود/ : /Observed activity/);
    assert.match(html, locale === 'ar' ? /آخر تفعيل: / : /Last fired: /);
    assert.match(html, locale === 'ar' ? /آخر استدعاء من بيانات الطرف الأول: / : /Latest first-party callback: /);
    assert.match(html, locale === 'ar' ? /غير معروف/ : /Unknown/);
    assert.match(html, locale === 'ar' ? /نحو 20 دقيقة/ : /about 20 minutes/);
    assert.match(html, locale === 'ar' ? /لا أن القاعدة لم تُفعَّل قط/ : /not that the rule never fired/);
    assert.doesNotMatch(html, /never fired<\/td>|>Never</);
    assert.equal(f.calls.length, 1);
  });
  test(locale + ' a malformed projected callback time refuses the whole view', async t => {
    const {response} = await read(t);
    for (const value of ['1700000000000', -5, 0, 2.5, {}]) {
      const invalid = plain(response.data);
      invalid.rules[0].last_callback_at = value;
      const f = accountWorkflowFixture(locale);
      f.context.platforms.find(p => p.id === 'linkedin').connections[0].id = conversionMetadataConnectionId;
      f.respond(() => plain(invalid));
      await f.run('renderMeasurement()');
      // The website's own response check refuses the view, in the interface language.
      await assert.rejects(
        f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions')),
        locale === 'ar' ? /تغيّرت أدلة التحويلات أو أنها غير مكتملة/ : /Conversion evidence changed or is incomplete/,
      );
      assert.equal(f.node('#conversion-rule-rows').innerHTML, '');
    }
  });
  test(locale + ' older responses without the callback fields remain readable as Unknown', async t => {
    const {response} = await read(t),
      legacy = plain(response.data);
    delete legacy.checks.observed_activity;
    for (const row of legacy.rules) {
      delete row.last_callback_at;
      delete row.latest_first_party_callback_at;
    }
    const f = await page(t, locale, legacy),
      html = f.node('#conversion-rule-rows').innerHTML;
    assert.doesNotMatch(html, locale === 'ar' ? /آخر تفعيل: / : /Last fired: /);
    assert.match(html, locale === 'ar' ? /غير معروف/ : /Unknown/);
  });
}
