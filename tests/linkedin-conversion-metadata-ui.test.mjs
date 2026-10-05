import test from 'node:test';
import assert from 'node:assert/strict';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {
  conversionMetadataFixture,
  conversionMetadataConnectionId,
} from './fixtures/linkedin-conversion-metadata-data.mjs';
const plain = value => JSON.parse(JSON.stringify(value));
async function responseFor(t, scenario = 'owned') {
  const native = conversionMetadataFixture(scenario);
  t.after(native.close);
  const response = await native.call();
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(native.requests.length, 3);
  return {native, out: response.data};
}
async function setup(locale, out) {
  const f = accountWorkflowFixture(locale);
  f.context.platforms.find(p => p.id === 'linkedin').connections[0].id = conversionMetadataConnectionId;
  f.respond(() => plain(out));
  await f.run('renderMeasurement()');
  return {...f, submit: () => f.bindings.get('#measurement-conversions')(f.node('#measurement-conversions'))};
}
for (const locale of ['en', 'ar']) {
  test(
    locale + ' conversion methods and ownership are readable, escaped, searchable and paged without additional reads',
    async t => {
      const {native, out} = await responseFor(t),
        f = await setup(locale, out);
      const target = f.node('#measurement-conversions').elements.target.value;
      await f.submit();
      const html = f.node('#measurement-conversions-result').innerHTML,
        rows = f.node('#conversion-rule-rows').innerHTML;
      assert.match(html, locale === 'ar' ? /القواعد المشتركة/ : /Shared rules are not requested/);
      assert.match(html, /aria-describedby="conversion-rule-search-help"/);
      assert.match(rows, locale === 'ar' ? /طريقة تسجيل التحويل/ : /Registration method/);
      assert.match(rows, locale === 'ar' ? /الملكية التي أبلغت عنها المنصة/ : /Reported ownership/);
      assert.match(rows, /<code dir="ltr">CONVERSIONS_API<\/code>/);
      assert.match(rows, /<code dir="ltr">OWNED<\/code>/);
      assert.match(rows, /9007199254740993\.123456789/);
      assert.match(rows, /Metadata rule &lt;img&gt; 0/);
      assert.doesNotMatch(rows, /<img>/);
      assert.equal(f.node('#conversion-settings-heading').focused, true);
      f.node('#conversion-rule-next').events.get('click')();
      assert.match(f.node('#conversion-rule-rows').innerHTML, /Metadata rule &lt;img&gt; 50/);
      assert.match(f.node('#conversion-rule-rows').innerHTML, /INSIGHT_TAG/);
      assert.equal(f.node('#conversion-rule-status').focused, true);
      const search = f.node('#conversion-rule-search');
      for (const value of ['insight_tag', 'owned']) {
        search.value = value;
        search.events.get('input')();
        assert.match(f.node('#conversion-rule-rows').innerHTML, value === 'owned' ? /CONVERSIONS_API/ : /INSIGHT_TAG/);
      }
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.calls[0], native.input);
      assert.equal(native.requests.length, 3);
      assert.equal(f.node('#measurement-conversions').elements.target.value, target);
    },
  );
  test(
    locale +
      ' missing and future native metadata retain Unknown and literal reported SHARED values without health inference',
    async t => {
      const {native, out} = await responseFor(t, 'unknown'),
        f = await setup(locale, out);
      await f.submit();
      const rows = f.node('#conversion-rule-rows').innerHTML,
        html = f.node('#measurement-conversions-result').innerHTML;
      assert.match(rows, locale === 'ar' ? /غير معروف/ : /Unknown/);
      assert.match(rows, /FUTURE_METHOD_&lt;img&gt;/);
      assert.match(rows, /FUTURE_OWNERSHIP_&lt;img&gt;/);
      assert.match(rows, /<code dir="ltr">SHARED<\/code>/);
      assert.doesNotMatch(rows, /<img>/);
      assert.match(html, locale === 'ar' ? /الإحالة التاريخية/ : /historical attribution/);
      const search = f.node('#conversion-rule-search');
      for (const [needle, expected] of [
        ['future_method', 'FUTURE_METHOD_&lt;img&gt;'],
        ['future_ownership', 'FUTURE_OWNERSHIP_&lt;img&gt;'],
        ['shared', '<code dir="ltr">SHARED</code>'],
      ]) {
        search.value = needle;
        search.events.get('input')();
        assert.ok(f.node('#conversion-rule-rows').innerHTML.includes(expected));
        assert.equal(f.node('#conversion-rule-next').disabled, true);
      }
      assert.equal(native.requests.length, 3);
      assert.equal(out.collection_request.shared_rules_requested, false);
    },
  );
  test(
    locale + ' older complete conversion envelopes without the new fields remain readable with unknown metadata',
    async t => {
      const {out} = await responseFor(t),
        legacy = plain(out);
      delete legacy.collection_request;
      for (const row of legacy.rules) {
        delete row.conversion_method;
        delete row.ownership_type;
      }
      const f = await setup(locale, legacy);
      await assert.doesNotReject(f.submit());
      const rows = f.node('#conversion-rule-rows').innerHTML;
      assert.match(rows, /9007199254740993/);
      assert.match(rows, locale === 'ar' ? /غير معروف/ : /Unknown/);
      assert.doesNotMatch(rows, /CONVERSIONS_API|INSIGHT_TAG|<code dir="ltr">OWNED/);
    },
  );
  test(locale + ' projected malformed method or ownership refuses the entire current view', async t => {
    const {out} = await responseFor(t);
    for (const field of ['conversion_method', 'ownership_type'])
      for (const value of [0, false, {}, [], 'NUL\u0000', 'M'.repeat(101), '', '   ']) {
        const invalid = plain(out);
        invalid.rules[1][field] = value;
        const f = await setup(locale, invalid);
        await assert.rejects(f.submit());
        assert.equal(f.node('#measurement-conversions-result').innerHTML, '');
        assert.equal(f.node('#conversion-rule-rows').innerHTML, '');
      }
  });
  test(
    locale + ' changed collection request metadata refuses the view and cannot imply shared-rule qualification',
    async t => {
      const {out} = await responseFor(t);
      for (const value of [
        null,
        false,
        [],
        {},
        {finder: 'all', ownership_selection: 'provider_default_owned', shared_rules_requested: false},
        {finder: 'account', ownership_selection: 'owned_and_shared', shared_rules_requested: false},
        {finder: 'account', ownership_selection: 'provider_default_owned', shared_rules_requested: true},
        {...out.collection_request, extra: 'unqualified'},
      ]) {
        const invalid = plain(out);
        invalid.collection_request = value;
        const f = await setup(locale, invalid);
        await assert.rejects(f.submit());
        assert.equal(f.node('#measurement-conversions-result').innerHTML, '');
      }
    },
  );
}
