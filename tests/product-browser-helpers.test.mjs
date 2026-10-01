import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
test('product CSV preserves quoted commas and escaped quotes, rejects ambiguous or oversized imports', () => {
  const c = createContext({document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(c);
  c.text =
    'retailer_id,name,price,currency,image_url\r\nsku1,"A, ""quoted"" item",19.99,USD,https://example.com/image.jpg\r\n';
  const rows = new Script('parseProductCSV(text)').runInContext(c);
  assert.equal(rows[0].name, 'A, "quoted" item');
  assert.equal(rows[0].price, '19.99');
  for (const text of ['id,id\na,b', 'id,name\na,b,c', 'id,name\na,"unclosed', 'id,name\na,"closed"bad']) {
    c.text = text;
    assert.throws(() => new Script('parseProductCSV(text)').runInContext(c));
  }
});
test('resumable creative plans preserve each previewed source hash and account without executing uploads', async () => {
  let request;
  const c = createContext({
    workspaceCall: async (tool, args) => {
      request = {tool, args};
      return {id: 'saved'};
    },
  });
  new Script(readFileSync('web/creative-push.js', 'utf8')).runInContext(c);
  c.rows = [
    {
      state: 'ready',
      name: 'Image',
      destination: {platform: 'meta', account_id: '100', connection_id: 'chosen'},
      source: {source_id: 'source'},
      file: {sha256: 'exact-file'},
      fit: true,
    },
  ];
  const out = await new Script('saveCreativePushPlan(rows)').runInContext(c);
  assert.equal(out.id, 'saved');
  assert.equal(request.tool, 'campaign');
  assert.equal(request.args.action, 'create');
  assert.equal(request.args.steps[0].arguments.expected_sha256, 'exact-file');
  assert.equal(request.args.steps[0].connection_id, 'chosen');
  assert.equal(request.args.confirmed, undefined);
});

test('client report markup escapes source content and keeps unknown money separate from currency', () => {
  const c = createContext({
    document: {addEventListener() {}},
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    pretty: value => String(value),
    date: () => 'Synthetic date',
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(c);
  new Script(readFileSync('web/evidence-workflows.js', 'utf8')).runInContext(c);
  c.pack = {
    client_name: '<script>bad</script>',
    title: 'Report',
    state: 'partial',
    date_range: {},
    row_count: 1,
    grain: 'total',
    sources: [],
    limitations: [],
    summary: [
      {
        platform: 'meta',
        account_id: '100',
        objective_group: 'awareness',
        currency: 'USD',
        metrics: {spend: 42.5, cpa: null, ctr: 0.85},
      },
    ],
  };
  const html = new Script('reportPackBody(pack)').runInContext(c);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Unknown USD/);
  assert.match(html, /0.85%/);
  assert.match(html, /scope="row"/);
  assert.match(html, /role="region"/);
});
