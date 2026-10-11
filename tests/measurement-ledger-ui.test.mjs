import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// MSR-03 slice C on the website: one evidence ledger task for a Google Ads account or a GA4 property. Choosing (in the
// task, the scope bar or a link) never reads; the ledger is read only on submit, and a foreign, mutating or partial
// response is never rendered.
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const text = (locale, value) => (locale === 'ar' ? catalog[value] : value);
const meaning =
  'Measurement evidence for one asset in six fixed layers. A layer is observed only from complete evidence of the selected asset; everything else stays unknown, unavailable or not applicable. Configuration and reported activity do not prove that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.';
const layer = (name, state, reason, evidence = null) => ({layer: name, state, reason, evidence, note: 'English note'});
const summary = layers =>
  Object.fromEntries(
    ['observed', 'unknown', 'unavailable', 'not_applicable'].map(s => [s, layers.filter(l => l.state === s).length]),
  );
function googleReply(overrides = {}) {
  const layers = overrides.layers ?? [
    layer('configuration', 'observed', 'complete_configuration', {summary: {goals: 2, matching_primary_actions: 1}}),
    layer('provider_observed_activity', 'observed', 'activity_reported', {
      primary_actions: [
        {
          resource_name: 'customers/001/conversionActions/1',
          name: '<img onerror=bad> purchase',
          last_conversion_date: '2026-10-01',
          last_tag_received_time: '2026-10-02 13:14:15',
        },
      ],
    }),
    layer('provider_diagnostics', 'unknown', 'read_failed', {error: 'PROVIDER_ACCESS_DENIED'}),
    layer('supplied_runtime_trace', 'unavailable', 'browser_only'),
    layer('consent', 'unavailable', 'no_provider_source'),
    layer('attribution_settings', 'observed', 'action_settings', {
      actions: [
        {
          resource_name: 'customers/001/conversionActions/1',
          name: 'Purchase',
          attribution_model: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN',
          click_through_lookback_window_days: 30,
          view_through_lookback_window_days: null,
        },
      ],
      action_count: 7,
    }),
  ];
  return {
    record_kind: 'measurement_ledger',
    scope: {gateway: 'google_ads_native_action', connection_id: 'google-login', account_id: '001'},
    requested_at: 1,
    captured_at: 2,
    layers,
    summary: summary(layers),
    checks: {
      event_delivery: 'unverified',
      deduplication: 'unverified',
      consent: 'unverified',
      attribution: 'unverified',
    },
    provider_mutations: 0,
    snapshot_saved: false,
    meaning,
    ...overrides,
  };
}
function ga4Reply() {
  const layers = [
    layer('configuration', 'observed', 'complete_configuration', {
      summary: {key_events: 1, data_streams: 1},
      data_streams: [{stream_id: '900', type: 'WEB_DATA_STREAM', measurement_id: 'G-ABC123'}],
    }),
    layer('provider_observed_activity', 'unknown', 'no_recent_key_events', {
      window_minutes: 30,
      events: [{event_name: 'purchase', reported_count: null, state: 'not_observed'}],
    }),
    layer('provider_diagnostics', 'unavailable', 'no_provider_source'),
    layer('supplied_runtime_trace', 'unavailable', 'browser_only'),
    layer('consent', 'unavailable', 'no_provider_source'),
    layer('attribution_settings', 'unavailable', 'unpinned_api'),
  ];
  return {
    ...googleReply({layers}),
    scope: {gateway: 'ga4_native_action', connection_id: 'ga4-login', account_id: '123'},
  };
}
function setup(locale, search = '') {
  const f = accountWorkflowFixture(locale),
    urls = [];
  f.context.location.search = search;
  f.context.location.pathname = '/measurement';
  f.context.location.hash = '';
  f.context.history = {
    state: null,
    replaceState(state, title, url) {
      urls.push(url);
      f.context.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    },
  };
  return {...f, urls};
}
const submit = f => f.bindings.get('#measurement-ledger')(f.node('#measurement-ledger'));

for (const locale of ['en', 'ar']) {
  test(locale + ' MSR-03 the ledger reads one Google Ads account only on submit and explains every layer', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    const html = f.node('content').innerHTML;
    assert.match(html, /id="measurement-task-link-ledger" href="#measurement-section-ledger"/);
    assert.match(html, /id="measurement-ledger"/);
    assert.ok(html.includes(text(locale, 'Measurement evidence ledger')));
    assert.match(html, /<option value="0" >google<\/option><option value="1" >ga4<\/option>/);
    assert.deepEqual(f.calls, [], 'rendering and preselection start no read');
    f.respond(() => googleReply());
    f.node('#measurement-ledger').elements.target.value = '0';
    await submit(f);
    assert.deepEqual(f.calls, [
      {
        action: 'measurement_ledger',
        gateway: 'google_ads_native_action',
        connection_id: 'google-login',
        account_id: '001',
      },
    ]);
    const out = f.node('#measurement-ledger-result').innerHTML;
    for (const value of [
      'Configuration',
      'Provider-observed activity',
      'Provider diagnostics',
      'Supplied runtime trace',
      'Consent',
      'Attribution settings',
      'Observed',
      'Unknown',
      'Unavailable',
      'This read failed or was incomplete, so the layer stays unknown.',
      'Supplied traces are inspected only in this browser and never reach AMCP.',
      meaning,
    ])
      assert.ok(out.includes(text(locale, value)), value);
    assert.match(out, /<code dir="ltr">PROVIDER_ACCESS_DENIED<\/code>/, 'a failed read shows only its code');
    assert.match(out, /<code dir="ltr">GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN<\/code>/, 'native values stay literal');
    assert.ok(out.includes('&lt;img onerror=bad&gt; purchase'), 'native names stay escaped');
    assert.match(out, /href="#measurement-section-goals"/);
    assert.match(out, /href="#measurement-section-trace"/);
    assert.match(out, /href="#measurement-section-gtm"/);
    assert.ok(out.includes(text(locale, '{shown} of {total} shown.').replace('{shown}', '1').replace('{total}', '7')));
    assert.equal(f.node('#measurement-ledger-heading').focused, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.httpCalls, [], 'no other request');
  });

  test(locale + ' MSR-03 a GA4 ledger shows absent key events as unknown, never as observed', async () => {
    const f = setup(locale);
    await f.run('renderMeasurement()');
    f.respond(() => ga4Reply());
    f.node('#measurement-ledger').elements.target.value = '1';
    await submit(f);
    assert.deepEqual(f.calls, [
      {action: 'measurement_ledger', gateway: 'ga4_native_action', connection_id: 'ga4-login', account_id: '123'},
    ]);
    const out = f.node('#measurement-ledger-result').innerHTML;
    assert.ok(
      out.includes(
        text(locale, 'No key event was reported in the last 30 minutes. Absence does not establish a broken tag.'),
      ),
    );
    assert.ok(out.includes(text(locale, 'None reported')));
    assert.ok(out.includes(text(locale, 'This is available only in a provider API version AMCP has not pinned.')));
    assert.match(out, /href="#measurement-section-ga4config"/);
    assert.match(out, /href="#measurement-section-events"/);
    assert.match(out, /<code dir="ltr">G-ABC123<\/code>/);
  });

  test(locale + ' MSR-03 a foreign, mutating, reordered or partial ledger response is never rendered', async () => {
    const reordered = googleReply();
    reordered.layers = [reordered.layers[1], reordered.layers[0], ...reordered.layers.slice(2)];
    const partial = googleReply();
    partial.layers[2] = layer('provider_diagnostics', 'unknown', 'read_failed', {
      error: 'X',
      upload_summaries: [{client: 'GOOGLE_ADS_API'}],
    });
    const upgraded = googleReply();
    upgraded.layers[2] = {...upgraded.layers[2], state: 'observed'};
    for (const [name, bad] of [
      [
        'foreign account',
        googleReply({scope: {gateway: 'google_ads_native_action', connection_id: 'google-login', account_id: '999'}}),
      ],
      [
        'other gateway',
        googleReply({scope: {gateway: 'ga4_native_action', connection_id: 'google-login', account_id: '001'}}),
      ],
      ['mutation', googleReply({provider_mutations: 1})],
      ['reordered layers', reordered],
      ['partial rows in a failed read', partial],
      ['failed read reported observed', upgraded],
      ['unknown state', googleReply({layers: googleReply().layers.map((l, i) => (i ? l : {...l, state: 'healthy'}))})],
      ['summary mismatch', googleReply({summary: {observed: 6, unknown: 0, unavailable: 0, not_applicable: 0}})],
    ]) {
      const f = setup(locale);
      await f.run('renderMeasurement()');
      f.respond(() => bad);
      f.node('#measurement-ledger').elements.target.value = '0';
      await assert.rejects(
        submit(f),
        error =>
          error.message.includes(
            text(
              locale,
              'The evidence ledger response is incomplete or belongs to a different selection. Read it again.',
            ),
          ),
        name,
      );
      assert.equal(f.node('#measurement-ledger-result').innerHTML, '', name);
    }
    // A response arriving after an identity change is dropped.
    const f = setup(locale);
    await f.run('renderMeasurement()');
    let release;
    f.respond(() => new Promise(resolve => (release = () => resolve(googleReply()))));
    f.node('#measurement-ledger').elements.target.value = '0';
    const pending = submit(f);
    f.context.identityGeneration++;
    f.node('#measurement-ledger-result').innerHTML = 'CURRENT-IDENTITY';
    release();
    await pending;
    assert.equal(f.node('#measurement-ledger-result').innerHTML, 'CURRENT-IDENTITY');
  });

  test(locale + ' MSR-03 a ledger link and the scope bar preselect an account without reading', async () => {
    const f = setup(locale, '?ledger=1&gateway=ga4_native_action&connection_id=ga4-login&account_id=123');
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-ledger').elements.target.value, '1');
    assert.ok(
      f
        .node('#measurement-ledger-result')
        .innerHTML.includes(
          text(locale, 'Account selected from an evidence ledger link. Read the ledger to refresh the evidence.'),
        ),
    );
    for (const search of [
      '?ledger=1&gateway=google_ads_native_action&connection_id=ga4-login&account_id=123',
      '?ledger=1&gateway=ga4_native_action&connection_id=ga4-login&account_id=999',
      '?ledger=1&ledger=1&gateway=ga4_native_action&connection_id=ga4-login&account_id=123',
    ]) {
      const g = setup(locale, search);
      await g.run('renderMeasurement()');
      assert.equal(g.node('#measurement-ledger').elements.target.value, '', search);
      assert.ok(
        g
          .node('#measurement-ledger-result')
          .innerHTML.includes(
            text(
              locale,
              'The linked account is unavailable. Choose a currently selected account, property, site or app.',
            ),
          ),
        search,
      );
      assert.deepEqual(g.calls, [], search);
    }
    // The scope bar fills the ledger with the kind chosen last: a GA4 property, then a Google Ads account.
    const s = setup(locale);
    await s.run('renderMeasurement()');
    const scope = s.node('#measurement-scope');
    s.node('measurement-scope:ga4').value = '0';
    scope.events.get('change')({target: {name: 'ga4'}});
    assert.equal(s.node('#measurement-ledger').elements.target.value, '1');
    s.node('measurement-scope:google').value = '0';
    scope.events.get('change')({target: {name: 'google'}});
    assert.equal(s.node('#measurement-ledger').elements.target.value, '0');
    s.node('measurement-scope:google').value = '';
    scope.events.get('change')({target: {name: 'google'}});
    assert.equal(s.node('#measurement-ledger').elements.target.value, '1', 'clearing Google Ads falls back to GA4');
    assert.deepEqual([...f.calls, ...s.calls], []);
  });
}

// Owner direction P8 (2026-10-11): Meta, Snapchat and TikTok ad accounts with their pixels, and Search Console sites,
// share the same ledger task. A pixel ID is sent only when entered, only for a pixel provider, and the response must
// name that pixel; native values stay literal and Meta's or Snap's free text is never rendered.
const otherLayers = (consent = layer('consent', 'unavailable', 'no_provider_source')) => [
  layer('supplied_runtime_trace', 'unavailable', 'browser_only'),
  consent,
  layer('attribution_settings', 'not_applicable', 'not_pixel_setting'),
];
function providerReply(gateway, account, layers, pixel) {
  return {
    ...googleReply({layers}),
    scope: {
      gateway,
      connection_id: gateway.replace(/_native_action$/, '').replace('google_search_console', 'gsc') + '-login',
      account_id: account,
      ...(pixel === undefined ? {} : {pixel_id: pixel}),
    },
  };
}
function metaReply(pixel = '701') {
  return providerReply(
    'meta_native_action',
    '001',
    [
      layer('configuration', 'observed', 'pixels_listed', {
        pixels: [
          {
            id: '701',
            name: '<b>Store</b> pixel',
            owner_business: '1001',
            last_fired_time: '2026-10-11T08:00:00+0000',
            is_unavailable: false,
          },
          {id: '702', name: 'Agency pixel', owner_business: null, last_fired_time: null, is_unavailable: true},
        ],
        pixel_count: 2,
        selected_pixel: pixel,
      }),
      layer('provider_observed_activity', 'observed', 'pixel_events_reported', {
        window_hours: 24,
        hours_reported: 2,
        events: [{event_name: 'Purchase', count: '5'}],
        event_count: 1,
        last_fired_time: '2026-10-11T08:00:00+0000',
      }),
      layer('provider_diagnostics', 'observed', 'dataset_quality', {
        events: [
          {
            event_name: 'Purchase',
            composite_score: 7.2,
            match_keys: [],
            event_coverage_percentage: 60,
            event_coverage_goal_percentage: 75,
            dedupe_keys: [{dedupe_key: 'event_id', browser_percentage: 100, server_percentage: 90}],
            upload_frequency: 'real_time',
            acr_percentage: 12,
          },
        ],
        event_count: 1,
      }),
      ...otherLayers(),
    ],
    pixel,
  );
}
function gscReply(extra = {}) {
  return providerReply(
    'google_search_console_native_action',
    'sc-domain:example.test',
    [
      layer('configuration', 'observed', 'site_permission', {
        site_url: 'sc-domain:example.test',
        permission_level: 'siteOwner',
      }),
      layer('provider_observed_activity', 'observed', 'search_totals_reported', {
        start_date: '2026-10-05',
        end_date: '2026-10-11',
        days_reported: 2,
        clicks: 10,
        impressions: 220,
        days: [],
      }),
      layer('provider_diagnostics', 'observed', 'sitemaps_listed', {
        sitemaps: [
          {
            path: 'https://example.test/sitemap.xml',
            errors: '2',
            warnings: '0',
            last_downloaded: '2026-10-10T00:00:00Z',
          },
        ],
        sitemap_count: 1,
        with_errors: 1,
        with_warnings: 0,
        pending: 0,
      }),
      layer('supplied_runtime_trace', 'unavailable', 'browser_only'),
      layer('consent', 'not_applicable', 'no_consent_setting'),
      layer('attribution_settings', 'not_applicable', 'no_attribution'),
    ],
    extra.pixel,
  );
}
function setupProviders(locale, search = '') {
  const f = setup(locale, search);
  for (const [id, gateway, account] of [
    ['snapchat', 'snapchat_native_action', '8f1c4a52-0b6e-4d1f-9a27-3c5d7e9f1a20'],
    ['tiktok', 'tiktok_native_action', '7000000000000000001'],
    ['gsc', 'google_search_console_native_action', 'sc-domain:example.test'],
  ])
    f.context.platforms.push({id, gateway, connections: [{id: id + '-login', enabled: true, accounts: [account]}]});
  return f;
}
// Picker order: Google Ads (0), GA4 (1), then Meta (2), Snapchat (3), TikTok (4) and Search Console (5).
const pick = (f, index, pixel = '') => {
  f.node('#measurement-ledger').elements.target.value = String(index);
  f.node('#measurement-ledger').elements.pixel_id.value = pixel;
};

for (const locale of ['en', 'ar']) {
  test(
    locale +
      ' MSR-03 P8 a Meta ledger sends the entered pixel and renders pixels, events and dataset quality literally',
    async () => {
      const f = setupProviders(locale);
      await f.run('renderMeasurement()');
      const html = f.node('content').innerHTML;
      assert.match(
        html,
        /<option value="2" >meta<\/option><option value="3" >snapchat<\/option><option value="4" >tiktok<\/option><option value="5" >gsc<\/option>/,
      );
      assert.ok(html.includes(text(locale, 'Pixel or dataset ID (optional)')));
      assert.ok(html.includes(text(locale, 'Account, property, site or app')));
      assert.deepEqual(f.calls, []);
      f.respond(() => metaReply());
      pick(f, 2, '701');
      await submit(f);
      assert.deepEqual(f.calls, [
        {
          action: 'measurement_ledger',
          gateway: 'meta_native_action',
          connection_id: 'meta-login',
          account_id: '001',
          requirements: {pixel_id: '701'},
        },
      ]);
      const out = f.node('#measurement-ledger-result').innerHTML;
      for (const value of [
        'The pixels the account lists, read completely from the provider.',
        'Meta reported pixel events by event name in the last 24 hours.',
        'Meta dataset quality of web events: match quality, Conversions API coverage, deduplication keys and freshness.',
        'Attribution windows are chosen per ad set, ad group or report, not on the pixel.',
        'Selected',
        'Last fired',
        'Conversions API coverage',
      ])
        assert.ok(out.includes(text(locale, value)), value);
      assert.ok(out.includes(text(locale, 'Match quality {score} of 10').replace('{score}', '7.2')));
      assert.ok(out.includes(text(locale, '{count} pixels listed').replace('{count}', '2')));
      assert.match(out, /<code dir="ltr">701<\/code>/);
      assert.match(out, /<code dir="ltr">real_time<\/code>/, 'native codes stay literal');
      assert.match(out, /<code dir="ltr">2026-10-11T08:00:00\+0000<\/code>/);
      assert.ok(out.includes('&lt;b&gt;Store&lt;/b&gt; pixel'), 'native names stay escaped');
      assert.match(out, /href="#measurement-section-gtm"/);
      assert.match(out, /href="#measurement-section-trace"/);
      assert.deepEqual(f.httpCalls, []);
    },
  );

  test(
    locale + ' MSR-03 P8 a pixel response for another pixel or another provider shape is never rendered',
    async () => {
      for (const [name, index, pixel, reply] of [
        ['another pixel than entered', 2, '702', metaReply('701')],
        [
          'pixel provider without a pixel scope',
          2,
          '',
          {...metaReply(), scope: {...metaReply().scope, pixel_id: undefined}},
        ],
        ['malformed pixel scope', 2, '', metaReply('70/1')],
        ['site with a pixel scope', 5, '', gscReply({pixel: '701'})],
      ]) {
        const f = setupProviders(locale);
        await f.run('renderMeasurement()');
        f.respond(() => reply);
        pick(f, index, pixel);
        await assert.rejects(
          submit(f),
          error =>
            error.message.includes(
              text(
                locale,
                'The evidence ledger response is incomplete or belongs to a different selection. Read it again.',
              ),
            ),
          name,
        );
        assert.equal(f.node('#measurement-ledger-result').innerHTML, '', name);
      }
      // A pixel ID for a site, or a malformed one, is refused before any request.
      for (const [index, pixel, message] of [
        [5, '701', 'A pixel ID applies only to a Meta, Snapchat or TikTok account.'],
        [2, '70/1', 'Use the exact pixel or dataset ID the account lists.'],
      ]) {
        const f = setupProviders(locale);
        await f.run('renderMeasurement()');
        pick(f, index, pixel);
        await assert.rejects(submit(f), error => error.message.includes(text(locale, message)), message);
        assert.deepEqual(f.calls, [], message);
      }
    },
  );

  test(
    locale + ' MSR-03 P8 Search Console, Snapchat and TikTok ledgers explain their layers without upgrading unknowns',
    async () => {
      const f = setupProviders(locale);
      await f.run('renderMeasurement()');
      f.respond(() => gscReply());
      pick(f, 5);
      await submit(f);
      assert.deepEqual(f.calls.at(-1), {
        action: 'measurement_ledger',
        gateway: 'google_search_console_native_action',
        connection_id: 'gsc-login',
        account_id: 'sc-domain:example.test',
      });
      let out = f.node('#measurement-ledger-result').innerHTML;
      for (const value of [
        'Final daily web search clicks and impressions over the last seven complete days.',
        'Submitted sitemaps with their errors, warnings and last download.',
        'This provider has no consent setting.',
        'This provider attributes no conversions.',
        'Not applicable',
      ])
        assert.ok(out.includes(text(locale, value)), value);
      assert.match(out, /<code dir="ltr">siteOwner<\/code>/);
      assert.match(out, /<code dir="ltr">https:\/\/example\.test\/sitemap\.xml<\/code>/);
      assert.doesNotMatch(out, /href="#measurement-section-gtm"/, 'Search Console has no consent task link');
      const snap = providerReply(
        'snapchat_native_action',
        '8f1c4a52-0b6e-4d1f-9a27-3c5d7e9f1a20',
        [
          layer('configuration', 'observed', 'pixels_listed', {
            pixels: [
              {id: 'a1', name: 'One', status: 'ACTIVE', effective_status: 'ACTIVE'},
              {id: 'b2', name: 'Two', status: 'PAUSED', effective_status: 'PAUSED'},
            ],
            pixel_count: 2,
            selected_pixel: null,
          }),
          layer('provider_observed_activity', 'unknown', 'pixel_not_selected'),
          layer('provider_diagnostics', 'unknown', 'pixel_not_selected'),
          ...otherLayers(),
        ],
        null,
      );
      f.respond(() => snap);
      pick(f, 3);
      await submit(f);
      out = f.node('#measurement-ledger-result').innerHTML;
      assert.ok(
        out.includes(text(locale, 'The account lists several pixels. Enter one pixel ID and read the ledger again.')),
      );
      assert.match(out, /<code dir="ltr">PAUSED<\/code>/);
      assert.ok(!out.includes(text(locale, 'Selected')), 'no pixel is marked selected');
      const tiktok = providerReply(
        'tiktok_native_action',
        '7000000000000000001',
        [
          layer('configuration', 'observed', 'pixels_listed', {
            pixels: [{pixel_id: '7100000000000000001', pixel_name: 'Store', pixel_code: 'CABC', owned: false}],
            pixel_count: 1,
            selected_pixel: '7100000000000000001',
          }),
          layer('provider_observed_activity', 'unavailable', 'unpinned_contract'),
          layer('provider_diagnostics', 'unavailable', 'no_provider_source'),
          ...otherLayers(),
        ],
        '7100000000000000001',
      );
      f.respond(() => tiktok);
      pick(f, 4);
      await submit(f);
      out = f.node('#measurement-ledger-result').innerHTML;
      for (const value of [
        'The provider publishes no response contract AMCP could pin, so this is not read.',
        'Shared or unbound',
        'Selected',
      ])
        assert.ok(out.includes(text(locale, value)), value);
      assert.equal(f.calls.length, 3);
      assert.deepEqual(f.httpCalls, []);
    },
  );

  test(locale + ' MSR-03 P8 a ledger link with a pixel preselects the account and pixel without reading', async () => {
    const f = setupProviders(
      locale,
      '?ledger=1&gateway=meta_native_action&connection_id=meta-login&account_id=001&pixel_id=701',
    );
    await f.run('renderMeasurement()');
    assert.equal(f.node('#measurement-ledger').elements.target.value, '2');
    assert.equal(f.node('#measurement-ledger').elements.pixel_id.value, '701');
    assert.deepEqual(f.calls, []);
    for (const search of [
      '?ledger=1&gateway=google_search_console_native_action&connection_id=gsc-login&account_id=sc-domain%3Aexample.test&pixel_id=701',
      '?ledger=1&gateway=meta_native_action&connection_id=meta-login&account_id=001&pixel_id=7%2F1',
      '?ledger=1&gateway=meta_native_action&connection_id=meta-login&account_id=001&pixel_id=701&pixel_id=702',
    ]) {
      const g = setupProviders(locale, search);
      await g.run('renderMeasurement()');
      assert.equal(g.node('#measurement-ledger').elements.target.value, '', search);
      assert.equal(g.node('#measurement-ledger').elements.pixel_id.value, '', search);
      assert.ok(
        g
          .node('#measurement-ledger-result')
          .innerHTML.includes(
            text(
              locale,
              'The linked account is unavailable. Choose a currently selected account, property, site or app.',
            ),
          ),
        search,
      );
      assert.deepEqual(g.calls, [], search);
    }
  });
}
