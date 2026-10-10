import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// MSR-03 slice B on the website: the GA4 property configuration task reads only on submit, renders every list,
// relates Google tags to streams from the synchronized Tag Manager inventory and refuses foreign or stale responses.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const text = (locale, value) => (locale === 'ar' ? catalog[value] : value);
const reply = (overrides = {}) => ({
  record_kind: 'measurement_ga4_config',
  scope: {gateway: 'ga4_native_action', connection_id: 'ga4-login', property_id: '123', sections: []},
  requested_at: 1,
  captured_at: 2,
  complete: true,
  key_events: [
    {
      name: 'properties/123/keyEvents/1',
      event_name: 'purchase',
      counting_method: 'ONCE_PER_EVENT',
      default_value: {numeric_value: 7.5, currency_code: 'SAR'},
    },
  ],
  custom_dimensions: [
    {name: 'properties/123/customDimensions/1', parameter_name: 'amcp_test_id', display_name: 'Test', scope: 'USER'},
  ],
  custom_metrics: [],
  data_streams: [
    {
      name: 'properties/123/dataStreams/900',
      stream_id: '900',
      type: 'WEB_DATA_STREAM',
      display_name: 'Web',
      measurement_id: 'G-ABC123',
    },
    {
      name: 'properties/123/dataStreams/901',
      stream_id: '901',
      type: 'WEB_DATA_STREAM',
      display_name: 'Shop',
      measurement_id: 'G-XYZ999',
    },
  ],
  google_ads_links: [
    {
      name: 'properties/123/googleAdsLinks/5',
      customer_id: '1234567890',
      ads_personalization_enabled: true,
      can_manage_clients: null,
    },
  ],
  data_retention: {
    event_data_retention: 'FOURTEEN_MONTHS',
    user_data_retention: 'TWO_MONTHS',
    reset_user_data_on_new_activity: false,
  },
  checks: {test_identifier_dimension: 'other_scope', web_streams: 2},
  provider_mutations: 0,
  meaning:
    'Current GA4 property configuration from complete bounded Admin API reads. Configuration is not proof that events are sent, counted, deduplicated, consented or attributed. Nothing was saved.',
  ...overrides,
});
function setup(locale, search = '') {
  const f = accountWorkflowFixture(locale);
  f.context.location.search = search;
  f.context.location.pathname = '/measurement';
  f.context.history = {state: null, replaceState() {}};
  f.context.platforms.find(p => p.id === 'gtm').connections[0].groups = [
    {
      kind: 'containers',
      assets: [{id: 'accounts/001/containers/5', name: 'Google tag', publicId: 'GT-ABCD12', tagIds: ['G-ABC123']}],
    },
  ];
  return f;
}

for (const locale of ['en', 'ar']) {
  test(
    locale + ' MSR-03 GA4 configuration reads only on submit and relates tags to streams from inventory',
    async () => {
      const f = setup(locale);
      await f.run('renderMeasurement()');
      const html = f.node('content').innerHTML;
      assert.match(html, /id="measurement-task-link-ga4config"/);
      assert.match(html, /id="measurement-ga4-config"/);
      assert.deepEqual(f.calls, [], 'rendering and preselection start no read');
      f.respond(() => reply());
      const form = f.node('#measurement-ga4-config');
      form.elements.target.value = '0';
      await f.bindings.get('#measurement-ga4-config')(form);
      assert.deepEqual(f.calls, [
        {action: 'measurement_ga4_config', gateway: 'ga4_native_action', connection_id: 'ga4-login', account_id: '123'},
      ]);
      const out = f.node('#measurement-ga4-config-result').innerHTML;
      for (const value of ['Key events', 'Data streams', 'Custom dimensions', 'Google Ads links', 'Data retention'])
        assert.ok(out.includes(text(locale, value)), value);
      assert.match(out, /<code dir="ltr">purchase<\/code>/);
      assert.match(out, /7\.5 SAR/);
      // G-ABC123 is a Google tag ID of a synchronized container; G-XYZ999 is not.
      assert.match(out, /Google tag<\/bdi> <code dir="ltr">GT-ABCD12<\/code>/);
      assert.ok(out.includes(text(locale, 'No synchronized container refers to this measurement ID.')));
      assert.ok(out.includes(text(locale, 'Registered with another scope')));
      assert.ok(
        out.includes(
          text(
            locale,
            'Inspecting a specific GA4 test identifier needs an event-scoped amcp_test_id custom dimension.',
          ),
        ),
      );
      assert.ok(out.includes(text(locale, 'None returned.')), 'an empty list says so');
      assert.equal(f.node('#measurement-ga4-config-heading').focused, true);
      assert.equal(f.calls.length, 1);
    },
  );

  test(locale + ' MSR-03 GA4 configuration without synchronized containers says so instead of guessing', async () => {
    const f = setup(locale);
    f.context.platforms.find(p => p.id === 'gtm').connections[0].groups = [];
    await f.run('renderMeasurement()');
    f.respond(() => reply({checks: {test_identifier_dimension: 'registered', web_streams: 2}}));
    const form = f.node('#measurement-ga4-config');
    form.elements.target.value = '0';
    await f.bindings.get('#measurement-ga4-config')(form);
    const out = f.node('#measurement-ga4-config-result').innerHTML;
    assert.ok(out.includes(text(locale, 'Tag Manager containers are not synchronized.')));
    assert.ok(out.includes(text(locale, 'Registered with event scope')));
    assert.ok(
      !out.includes(
        text(locale, 'Inspecting a specific GA4 test identifier needs an event-scoped amcp_test_id custom dimension.'),
      ),
    );
  });

  test(locale + ' MSR-03 a foreign, mutating or stale GA4 configuration response is never rendered', async () => {
    for (const bad of [
      reply({scope: {gateway: 'ga4_native_action', connection_id: 'ga4-login', property_id: '999'}}),
      reply({provider_mutations: 1}),
      reply({complete: false}),
      reply({data_streams: [{stream_id: 'x', type: 'WEB_DATA_STREAM', display_name: null, measurement_id: null}]}),
      reply({checks: {test_identifier_dimension: 'maybe'}}),
    ]) {
      const f = setup(locale);
      await f.run('renderMeasurement()');
      f.respond(() => bad);
      const form = f.node('#measurement-ga4-config');
      form.elements.target.value = '0';
      await assert.rejects(f.bindings.get('#measurement-ga4-config')(form), error =>
        error.message.includes(
          text(
            locale,
            'The GA4 configuration response is incomplete or belongs to a different selection. Read it again.',
          ),
        ),
      );
      assert.equal(f.node('#measurement-ga4-config-result').innerHTML, '');
    }
    const f = setup(locale);
    await f.run('renderMeasurement()');
    let release;
    f.respond(() => new Promise(resolve => (release = () => resolve(reply()))));
    const form = f.node('#measurement-ga4-config');
    form.elements.target.value = '0';
    const pending = f.bindings.get('#measurement-ga4-config')(form);
    f.context.identityGeneration++;
    f.node('#measurement-ga4-config-result').innerHTML = 'CURRENT-IDENTITY';
    release();
    await pending;
    assert.equal(f.node('#measurement-ga4-config-result').innerHTML, 'CURRENT-IDENTITY');
  });

  test(locale + ' MSR-03 a GA4 configuration link preselects its property without reading', async () => {
    const f = setup(locale, '?ga4_config=1&connection_id=ga4-login&account_id=123');
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-ga4-config').elements.target.value, '0');
    assert.ok(
      f
        .node('#measurement-ga4-config-result')
        .innerHTML.includes(
          text(
            locale,
            'Property selected from a configuration link. Read current configuration to refresh the evidence.',
          ),
        ),
    );
    const g = setup(locale, '?ga4_config=1&connection_id=ga4-login&account_id=999');
    await g.run('renderMeasurement()');
    assert.equal(g.node('#measurement-ga4-config').elements.target.value, '');
    assert.ok(
      g
        .node('#measurement-ga4-config-result')
        .innerHTML.includes(
          text(locale, 'The linked GA4 property is unavailable. Choose a currently selected property.'),
        ),
    );
    assert.deepEqual([...f.calls, ...g.calls], []);
  });
}
