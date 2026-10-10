import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
test('creative cards escape labels and keep exact verified-plan links', () => {
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const c = createContext({
    document: {addEventListener() {}},
    esc,
    pretty: String,
    badge: esc,
    date: String,
    blank: esc,
    // WEB-05: the card names its account through the shell's isolating helper; a synced name and login are escaped.
    platforms: [
      {
        id: 'meta',
        name: 'Meta',
        gateway: 'meta_native_action',
        connections: [
          {
            id: 'login',
            name: '<login>',
            enabled: true,
            accounts: ['act_1'],
            groups: [{assets: [{id: 'act_1', name: '<account>'}]}],
          },
          {id: 'other', name: 'Other', enabled: true, accounts: [], groups: []},
        ],
      },
    ],
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  const app = readFileSync('web/app.js', 'utf8');
  new Script(
    app.slice(app.indexOf("/** An account's own name"), app.indexOf('function renderConnections()')),
  ).runInContext(c);
  new Script(readFileSync('web/creative-library.js', 'utf8')).runInContext(c);
  c.a = {
    asset_id: 'asset"',
    name: '<script>bad</script>',
    platform: 'meta',
    connection_id: 'login',
    account_id: 'act_1',
    tags: ['<tag>'],
    media_id: '<native>',
    usage: [
      {
        name: '<plan>',
        website_path: '/campaigns?id=original',
        steps: [{step_id: '<step>', status: 'verified', resource_ids: ['<id>']}],
      },
    ],
  };
  const card = new Script('creativeAssetCard(a)').runInContext(c);
  assert.doesNotMatch(card, /<script>|<tag>|<native>|<account>|<login>/);
  assert.match(card, /asset&quot;/);
  assert.match(
    card,
    /<small><bdi><bdi>Meta<\/bdi> · <bdi><bdi>&lt;account&gt;<\/bdi> \(<bdi dir="ltr">act_1<\/bdi>\) · <bdi>&lt;login&gt;<\/bdi><\/bdi><\/bdi><\/small>/,
  );
  const usage = new Script('creativeUsageRows(a)').runInContext(c);
  assert.match(usage, /\/campaigns\?id=original/);
  assert.doesNotMatch(usage, /<plan>|<step>|<id>/);
});

test('linked performance tables preserve exact values, explicit unknowns and escaped source labels in both languages', () => {
  for (const locale of ['en', 'ar']) {
    const context = createContext({
      document: {addEventListener() {}},
      esc: v =>
        String(v ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
      Intl,
    });
    const run = source => new Script(source).runInContext(context);
    run(readFileSync('web/localization.js', 'utf8'));
    run(
      `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
    );
    run(readFileSync('web/creative-library.js', 'utf8'));
    context.result = {
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        attribution: 'Native declaration',
        conversion_definition: 'metrics.conversions',
        complete: true,
      },
      grain: 'ad group × ad × day',
      report_path: '/reports?id=exact',
      rows: [
        {
          entity_id: 'customers/100/adGroupAds/200~9007199254740993',
          entity_name: 'Native <img> العربية',
          date: '2026-09-01',
          spend: '12.500001',
          impressions: '9007199254740993',
          clicks: '0',
          conversions: null,
          conversion_value: '0',
          frequency: '1.230001',
        },
      ],
      limitations: [],
    };
    const html = run('creativePerformanceResults(result)');
    assert.doesNotMatch(html, /<img>/);
    assert.match(html, /&lt;img&gt;/);
    assert.match(html, /9007199254740993/);
    assert.match(html, /12\.500001/);
    assert.match(html, /1\.230001/);
    assert.match(html, locale === 'ar' ? /غير معروف/ : /Unknown/);
    assert.match(html, /role="region" tabindex="0"/);
    assert.match(html, /scope="row"/);
    assert.match(html, /dir="ltr"/);
    assert.match(html, /\/reports\?id=exact/);
    context.result.preset = 'snapchat_ad_leads';
    context.result.semantics.conversion_definition = 'native_leads (submitted native lead forms)';
    const leads = run('creativePerformanceResults(result)');
    assert.match(leads, locale === 'ar' ? /نماذج العملاء المحتملين المرسلة/ : /Native lead submissions/);
    assert.match(leads, /native_leads \(submitted native lead forms\)/);
    assert.equal(
      run('creativePerformanceMetric(result)'),
      locale === 'ar' ? 'نماذج العملاء المحتملين المرسلة (native_leads)' : 'Native lead submissions (native_leads)',
    );
    context.result.preset = 'snapchat_ad';
    assert.equal(
      run('creativePerformanceMetric(result)'),
      locale === 'ar' ? 'المشتريات (conversion_purchases)' : 'Purchases (conversion_purchases)',
    );
    context.result.rows = [];
    assert.match(run('creativePerformanceResults(result)'), /colspan="7"/);
  }
});
