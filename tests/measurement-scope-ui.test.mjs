import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// MSR-02: one measurement scope, inventory pickers, the audit's own discovery lists, consistent empty states and the
// Google Ads conversion goals task. Every case runs the actual website module; choosing never starts a read.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const text = (locale, value) => (locale === 'ar' ? catalog[value] : value);
function setup(locale = 'en', search = '') {
  const f = accountWorkflowFixture(locale),
    urls = [];
  f.context.location.search = search;
  f.context.location.pathname = '/measurement';
  f.context.location.hash = '';
  f.context.history = {
    state: null,
    replaceState(state, title, url) {
      urls.push(url);
      const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
      f.context.location.search = query;
    },
  };
  const gtm = f.context.platforms.find(p => p.id === 'gtm').connections[0],
    ga4 = f.context.platforms.find(p => p.id === 'ga4').connections[0];
  gtm.groups = [
    {
      kind: 'containers',
      assets: [
        {id: 'accounts/001/containers/31', name: 'Store web', parentId: '001'},
        {id: 'accounts/999/containers/77', name: 'Foreign', parentId: '999'},
      ],
    },
  ];
  ga4.groups = [
    {
      kind: 'data_streams',
      assets: [{id: 'properties/123/dataStreams/900', name: 'Web', parentId: '123', measurementId: 'G-ABC123'}],
    },
  ];
  return {...f, urls};
}
const field = (f, form, name) => f.node(form + ':' + name);
const change = (f, name, value) => {
  field(f, 'measurement-scope', name).value = value;
  f.node('#measurement-scope').events.get('change')({target: {name}});
};

for (const locale of ['en', 'ar']) {
  test(locale + ' MSR-02 the scope bar fills every task without typing and never starts a read', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    const html = f.node('content').innerHTML;
    assert.match(html, /id="measurement-scope"/);
    assert.match(html, /id="measurement-task-link-goals"/);
    assert.ok(html.includes(text(locale, 'Measurement scope')));
    // Single eligible accounts are preselected in the scope and in each task.
    for (const name of ['gtm', 'ga4', 'google', 'linkedin'])
      assert.equal(field(f, 'measurement-scope', name).value, '0');
    assert.match(field(f, 'measurement-scope', 'container').innerHTML, /value="31"/);
    assert.doesNotMatch(field(f, 'measurement-scope', 'container').innerHTML, /77/, 'other accounts stay out');
    assert.match(field(f, 'measurement-scope', 'stream').innerHTML, /value="900"[^>]*>Web \(900\) · G-ABC123/);
    assert.equal(field(f, 'measurement-scope', 'workspace').disabled, true);
    // Initially, typed task fields are kept.
    assert.equal(field(f, 'measurement-audit', 'container_id').value, '001');
    f.node('#measurement-result').innerHTML = 'EARLIER-RESULT';
    change(f, 'container', '31');
    assert.equal(field(f, 'measurement-audit', 'container_id').value, '31');
    assert.equal(field(f, 'measurement-audit', 'workspace_id').value, '');
    assert.equal(field(f, 'measurement-audit', 'target').value, '0');
    assert.equal(f.node('#measurement-result').innerHTML, '', 'a changed scope clears the earlier result');
    change(f, 'stream', '900');
    for (const form of ['measurement-events', 'measurement-event-identity'])
      assert.equal(field(f, form, 'stream_id').value, '900');
    assert.match(f.urls.at(-1), /ms_gtm_login=gtm-login&ms_gtm_account=001/);
    assert.match(f.urls.at(-1), /ms_container=31/);
    assert.match(f.urls.at(-1), /ms_stream=900/);
    assert.deepEqual(f.calls, []);
    // Clearing empties the shared choices and the URL parameters, still without a read.
    f.node('#measurement-scope-clear').events.get('click')();
    assert.equal(field(f, 'measurement-scope', 'gtm').value, '');
    assert.equal(field(f, 'measurement-audit', 'container_id').value, '');
    assert.doesNotMatch(f.urls.at(-1), /ms_/);
    assert.deepEqual(f.calls, []);
  });

  test(
    locale + ' MSR-02 audit discovery lists workspaces to choose and fills the scope without a request',
    async () => {
      const f = setup(locale);
      f.respond(args => ({
        meaning:
          'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
        scope: {connection_id: args.connection_id, account_id: args.account_id, ...args.requirements},
        configuration: {
          complete: true,
          findings: [],
          container: {path: 'accounts/001/containers/31', name: 'Store web'},
          workspaces: [
            {workspace_id: '7', name: 'Default Workspace', path: 'accounts/001/containers/31/workspaces/7'},
            {workspace_id: '8', name: '<b>Release</b>', path: 'accounts/001/containers/31/workspaces/8'},
          ],
        },
      }));
      await f.run('renderMeasurement()');
      change(f, 'container', '31');
      await f.bindings.get('#measurement-audit')(f.node('#measurement-audit'));
      assert.deepEqual(f.calls, [
        {
          action: 'measurement_audit',
          connection_id: 'gtm-login',
          account_id: '001',
          requirements: {container_id: '31'},
        },
      ]);
      const result = f.node('#measurement-result').innerHTML;
      assert.ok(result.includes(text(locale, 'Workspaces in this container')));
      assert.match(result, /id="gtm-choice-1"/);
      assert.ok(result.includes('&lt;b&gt;Release&lt;/b&gt;'), 'native names stay escaped');
      assert.match(field(f, 'measurement-scope', 'workspace').innerHTML, /value="7"/);
      f.node('#gtm-choice-0').events.get('click')();
      assert.equal(field(f, 'measurement-audit', 'container_id').value, '31');
      assert.equal(field(f, 'measurement-audit', 'workspace_id').value, '7');
      assert.equal(field(f, 'measurement-scope', 'workspace').value, '7');
      assert.match(f.urls.at(-1), /ms_workspace=7/);
      assert.equal(f.calls.length, 1, 'choosing a discovered workspace makes no request');
      // An identity change detaches the old discovery buttons.
      f.context.identityGeneration++;
      field(f, 'measurement-audit', 'workspace_id').value = '';
      f.node('#gtm-choice-1').events.get('click')();
      assert.equal(field(f, 'measurement-audit', 'workspace_id').value, '');
    },
  );

  test(locale + ' MSR-02 a stale linked scope is cleared after an identity change', async () => {
    const f = setup(
      locale,
      '?ms_gtm_login=former-login&ms_gtm_account=001&ms_container=31&ms_ga4_login=ga4-login&ms_ga4_property=123&ms_stream=900',
    );
    await f.run('renderMeasurement()');
    assert.equal(
      f.node('#measurement-scope-status').textContent,
      text(locale, 'Part of the linked measurement scope no longer matches your selected accounts and was cleared.'),
    );
    assert.doesNotMatch(f.urls.at(-1), /former-login|ms_container/);
    assert.match(f.urls.at(-1), /ms_ga4_property=123&ms_stream=900/);
    assert.equal(field(f, 'measurement-events', 'stream_id').value, '900');
    assert.deepEqual(f.calls, []);
    // The same link under another identity's accounts keeps nothing it cannot match.
    const g = setup(locale, '?ms_ga4_login=ga4-login&ms_ga4_property=456&ms_stream=900');
    await g.run('renderMeasurement()');
    assert.doesNotMatch(g.urls.at(-1) ?? '', /ms_/);
    assert.equal(field(g, 'measurement-events', 'stream_id').value, '900', 'the fixture default is not overwritten');
    assert.deepEqual(g.calls, []);
  });

  test(locale + ' MSR-02 every section without targets explains how to connect and disables its read', async () => {
    const f = setup(locale);
    f.context.platforms = [];
    await f.run('renderMeasurement()');
    const html = f.node('content').innerHTML,
      notices = [
        'Connect Google Tag Manager and select an account in Connections to audit its configuration.',
        'Connect a GA4 property in Connections to read recent events.',
        'Connect a GA4 property in Connections to inspect a test identifier.',
        'Connect a GA4 property in Connections to read its configuration.',
        'Connect LinkedIn and select an ad account to inspect conversion settings.',
        'Connect Google Ads and select a customer account in Connections to inspect conversion goals.',
        'Connect a GA4 property in Connections to inspect a trace for it.',
      ];
    // One notice, Connections link and disabled read per task section (MSR-03 added the GA4 configuration task).
    assert.equal((html.match(/class="notice measurement-empty"/g) ?? []).length, notices.length);
    assert.equal((html.match(/<a href="\/connections">/g) ?? []).length, notices.length);
    assert.equal((html.match(/<button[^>]*type="submit"[^>]*\sdisabled>/g) ?? []).length, notices.length);
    for (const notice of notices) assert.ok(html.includes(text(locale, notice)), notice);
    assert.deepEqual(f.calls, []);
  });

  test(locale + ' MSR-02 the only GA4 property is preselected and the synthetic example loads', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    assert.match(f.node('content').innerHTML, /<option value="0" selected>ga4<\/option>/);
    const form = f.node('#measurement-trace');
    form.elements.target.value = '';
    await f.bindings.get('#measurement-trace-example')();
    assert.equal(form.elements.target.value, '0');
    assert.equal(JSON.parse(form.elements.trace.value).scope.property_id, '123');
    // With two properties and none chosen, the example explains inline instead of a toast.
    const g = setup(locale);
    g.context.platforms.find(p => p.id === 'ga4').connections[0].accounts = ['123', '456'];
    await g.run('renderMeasurement()');
    g.node('#measurement-trace').elements.target.value = '';
    await g.bindings.get('#measurement-trace-example')();
    assert.ok(
      g.node('#measurement-trace-result').innerHTML.includes(text(locale, 'Choose a selected GA4 property first.')),
    );
    assert.equal(g.node('#measurement-trace').elements.trace.value, '');
    assert.deepEqual([...f.calls, ...g.calls], []);
  });

  test(locale + ' MSR-02 Google Ads conversion goals render complete and incomplete evidence', async () => {
    const f = setup(locale),
      base = {
        record_kind: 'measurement_google_goals',
        scope: {gateway: 'google_ads_native_action', connection_id: 'google-login', account_id: '001', currency: 'SAR'},
        requested_at: 1,
        captured_at: 2,
        provider_mutations: 0,
      };
    let reply = {
      ...base,
      complete: true,
      meaning:
        'Current Google Ads conversion configuration from two matching bounded reads. Configuration is not proof that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.',
      dependency_statuses: {
        account_default_conversion_goals: 'ready',
        primary_conversion_actions: 'ready',
        conversion_value_configuration: 'unknown',
        reported_conversion_activity: 'ready',
      },
      summary: {goals: 2, biddable_goals: 1, actions: 3, matching_primary_actions: 1, unknown_primary_flags: 0},
      goals: [
        {
          resource_name: 'customers/001/customerConversionGoals/PURCHASE~WEBSITE',
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: true,
          matching_primary_actions: 1,
        },
      ],
      primary_actions: [
        {
          resource_name: 'customers/001/conversionActions/1',
          name: '<img src=x> Purchase',
          status: 'ENABLED',
          category: 'PURCHASE',
          origin: 'WEBSITE',
          owner_customer: 'customers/001',
          primary_for_goal: true,
          value_settings: {default_value: 7.25, default_currency_code: 'SAR', always_use_default_value: null},
          activity: {last_conversion_date: '2026-10-01', last_tag_received_time: null},
        },
      ],
      display_omissions: {goals: 0, primary_actions: 0},
    };
    f.respond(() => reply);
    await f.run('renderMeasurement()');
    const form = f.node('#measurement-google-goals');
    await f.bindings.get('#measurement-google-goals')(form);
    assert.deepEqual(f.calls, [
      {
        action: 'measurement_google_goals',
        gateway: 'google_ads_native_action',
        connection_id: 'google-login',
        account_id: '001',
      },
    ]);
    let html = f.node('#measurement-google-goals-result').innerHTML;
    assert.ok(html.includes('&lt;img src=x&gt; Purchase'));
    assert.ok(html.includes('7.25 SAR'));
    assert.ok(html.includes(text(locale, 'Biddable account-default goals')));
    assert.ok(
      html.includes(
        text(
          locale,
          'Configured goals and actions are not proof that conversions are delivered, deduplicated, consented or attributed. Dates are reported by Google Ads in the account timezone. Nothing was changed and no snapshot was saved.',
        ),
      ),
    );
    reply = {
      ...base,
      complete: false,
      reason: 'manager_account',
      meaning:
        'The conversion configuration could not be completely inspected; no partial goal or primary-action evidence is reported as ready. Nothing was saved.',
      dependency_statuses: {account_default_conversion_goals: 'unknown', primary_conversion_actions: 'unknown'},
    };
    await f.bindings.get('#measurement-google-goals')(form);
    html = f.node('#measurement-google-goals-result').innerHTML;
    assert.ok(
      html.includes(
        text(locale, 'This is a manager account. Choose a client account that records its own conversions.'),
      ),
    );
    assert.doesNotMatch(html, /review-table/);
    // A response for another account, or one that claims a mutation, is refused.
    for (const wrong of [
      {...reply, scope: {...reply.scope, account_id: '002'}},
      {...reply, provider_mutations: 1},
    ]) {
      reply = wrong;
      await assert.rejects(
        f.bindings.get('#measurement-google-goals')(form),
        new RegExp(
          text(
            locale,
            'The conversion goal response is incomplete or belongs to a different selection. Read it again.',
          ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ),
      );
    }
  });

  test(locale + ' MSR-02 a late goals response cannot render after a scope change or identity change', async () => {
    const f = setup(locale);
    let release;
    const held = new Promise(resolve => {
      release = resolve;
    });
    f.respond(async () => {
      await held;
      return {record_kind: 'measurement_google_goals'};
    });
    await f.run('renderMeasurement()');
    const pending = f.bindings.get('#measurement-google-goals')(f.node('#measurement-google-goals'));
    change(f, 'google', '');
    release();
    await pending;
    assert.equal(f.node('#measurement-google-goals-result').innerHTML, '');
    assert.equal(field(f, 'measurement-google-goals', 'target').value, '');
  });

  test(locale + ' MSR-02 a conversion goal link preselects its account without reading', async () => {
    const f = setup(locale, '?google_goals=1&connection_id=google-login&account_id=001');
    await f.run('renderMeasurement()');
    assert.equal(field(f, 'measurement-google-goals', 'target').value, '0');
    assert.ok(
      f
        .node('#measurement-google-goals-result')
        .innerHTML.includes(
          text(locale, 'Account selected from a conversion goal link. Read current goals to refresh the evidence.'),
        ),
    );
    assert.equal(f.node('#measurement-result').innerHTML, '', 'the GTM audit ignores a goals link');
    assert.deepEqual(f.calls, []);
    const g = setup(locale, '?google_goals=1&connection_id=other&account_id=001');
    await g.run('renderMeasurement()');
    assert.equal(field(g, 'measurement-google-goals', 'target').value, '');
  });
}
