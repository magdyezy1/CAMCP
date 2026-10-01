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
    esc,
    pretty: String,
    badge: esc,
    date: String,
    blank: esc,
    recordAccountLabel: () => '<account>',
  });
  new Script(readFileSync('web/creative-library.js', 'utf8')).runInContext(c);
  c.a = {
    asset_id: 'asset"',
    name: '<script>bad</script>',
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
  assert.doesNotMatch(card, /<script>|<tag>|<native>|<account>/);
  assert.match(card, /asset&quot;/);
  const usage = new Script('creativeUsageRows(a)').runInContext(c);
  assert.match(usage, /\/campaigns\?id=original/);
  assert.doesNotMatch(usage, /<plan>|<step>|<id>/);
});
