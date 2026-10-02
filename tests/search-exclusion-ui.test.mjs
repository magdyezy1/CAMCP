import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const plain = v => JSON.parse(JSON.stringify(v));
const report = {
  id: 'report',
  revision: 2,
  preset: 'google_search_terms',
  gateway: 'google_ads_native_action',
  account_id: '123',
  connection_id: 'login',
  source_hash: 'a'.repeat(64),
  semantics: {currency: 'USD'},
};
const row = i => ({
  entity_id: 'customers/123/searchTermViews/1~2~term' + i,
  campaign_id: '1',
  ad_group_id: '2',
  ad_group_resource: 'customers/123/adGroups/2',
  search_term: 'Term <img> ' + i,
  observed_clicks: '40',
  observed_spend: '9007199254.740993',
  observed_conversions: '0',
  match_type: 'EXACT',
});
const rows = Array.from({length: 100}, (_, i) => row(i));
const candidates = (offset = 0) => ({
  record_kind: 'search_exclusion_candidates',
  report_id: report.id,
  report_revision: 2,
  source_hash: report.source_hash,
  gateway: report.gateway,
  account_id: '123',
  connection_id: 'login',
  currency: 'USD',
  options: {minimum_clicks: 30, maximum_age_days: 7},
  candidate_count: 100,
  candidates: rows.slice(offset, offset + 50),
  next_offset: offset === 0 ? 50 : null,
});
const preview = ids => ({
  record_kind: 'search_exclusion_preview',
  preview_id: 'preview',
  preview_hash: 'b'.repeat(64),
  expires_at: Date.now() + 60000,
  report_id: report.id,
  report_revision: 2,
  source_hash: report.source_hash,
  gateway: report.gateway,
  account_id: '123',
  connection_id: 'login',
  currency: 'USD',
  options: {minimum_clicks: 30, maximum_age_days: 7},
  targets: ids.map(id => rows.find(r => r.entity_id === id)),
  advertising_writes: 0,
});
function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  let selected = true,
    confirm = async () => true,
    handler = args =>
      args.action === 'search_exclusion_candidates'
        ? candidates(args.offset ?? 0)
        : args.action === 'preview_search_exclusions'
          ? preview(args.ids)
          : {record_kind: 'search_exclusion_plan', id: 'draft/id', advertising_writes: 0, approval_required: true};
  let focus;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        disabled: false,
        isConnected: true,
        events: new Map(),
        addEventListener(k, fn) {
          this.events.set(k, fn);
        },
        setAttribute() {},
        focus() {
          focus = id;
        },
      });
    return nodes.get(id);
  };
  const context = createContext({
    document: {addEventListener() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    $: node,
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    date: String,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: async (_tool, args) => {
      calls.push(plain(args));
      return handler(args);
    },
    confirmAction: args => confirm(args),
    recordDetails: v => JSON.stringify(v).replaceAll('<', '&lt;'),
    report,
    selectionCurrent: () => selected,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/evidence-workflows.js', 'utf8'));
  run('mountSearchExclusions(report,selectionCurrent)');
  node('#search-exclusion-clicks').value = '30';
  node('#search-exclusion-age').value = '7';
  return {
    context,
    node,
    calls,
    bindings,
    focus: () => focus,
    respond: fn => {
      handler = fn;
    },
    confirm: fn => {
      confirm = fn;
    },
    depart: () => {
      selected = false;
    },
    load: () => bindings.get('#search-exclusion-find')(),
    choose: (index, checked = true) => {
      const n = node('#search-exclusion-choose-' + index);
      n.checked = checked;
      n.events.get('change')();
    },
    preview: () => bindings.get('#search-exclusion-preview')(),
    save: () => bindings.get('#search-exclusion-save')(),
  };
}
test('search exclusion UI preserves exact source rows in both languages and confirms only an unapproved draft', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.load();
    assert.match(f.node('#search-exclusion-rows').innerHTML, /9007199254\.740993/);
    assert.match(f.node('#search-exclusion-rows').innerHTML, /Term &lt;img&gt; 0/);
    assert.doesNotMatch(f.node('#search-exclusion-rows').innerHTML, /<img>/);
    f.choose(0);
    await f.preview();
    assert.match(f.node('#search-exclusion-result').innerHTML, locale === 'ar' ? /المراجعة|مسودة/ : /unapproved|draft/);
    assert.equal(f.focus(), '#search-exclusion-preview-heading');
    f.confirm(async () => false);
    await f.save();
    assert.equal(f.calls.length, 2);
    f.confirm(async args => {
      assert.ok(args.consequence);
      return true;
    });
    await f.save();
    assert.match(f.node('#search-exclusion-result').innerHTML, /\/campaigns\?id=draft%2Fid/);
    assert.deepEqual(f.calls[2], {
      action: 'create_search_exclusion_plan',
      id: 'report',
      preview_id: 'preview',
      preview_hash: 'b'.repeat(64),
      confirmed: true,
    });
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[0], transcripts[1]);
});
test('search exclusion page selection stays explicit across pages and changing evidence thresholds clears it', async () => {
  const f = fixture();
  await f.load();
  f.choose(0);
  await f.bindings.get('#search-exclusion-next')();
  f.choose(0);
  await f.bindings.get('#search-exclusion-previous')();
  assert.equal(f.node('#search-exclusion-choose-0').checked, true);
  await f.preview();
  assert.deepEqual(f.calls.at(-1).ids, [rows[0].entity_id, rows[50].entity_id]);
  f.node('#search-exclusion-clicks').value = '50';
  f.node('#search-exclusion-find').events.get('input')();
  assert.equal(f.node('#search-exclusion-result').innerHTML, '');
  const n = f.calls.length;
  await f.preview();
  assert.equal(f.calls.length, n);
});
test('search exclusion callbacks discard late list and preview outcomes after edits, selection, identity or departure', async () => {
  for (const phase of ['list', 'preview'])
    for (const reason of ['edit', 'identity', 'navigation', 'detach', 'selection'])
      for (const reject of [false, true]) {
        const f = fixture();
        if (phase === 'preview') {
          await f.load();
          f.choose(0);
        }
        let finish;
        f.respond(
          args =>
            new Promise((yes, no) => {
              finish = () =>
                reject
                  ? no(Error('OLD ERROR'))
                  : yes(args.action === 'search_exclusion_candidates' ? candidates() : preview(args.ids));
            }),
        );
        const pending = phase === 'list' ? f.load() : f.preview();
        if (reason === 'edit') f.node('#search-exclusion-find').events.get('input')();
        else if (reason === 'identity') f.context.identityGeneration++;
        else if (reason === 'navigation') f.context.navigationGeneration++;
        else if (reason === 'detach') f.node('#search-exclusion-workflow').isConnected = false;
        else f.depart();
        f.node('#search-exclusion-result').innerHTML = 'Current destination';
        f.node('#search-exclusion-rows').innerHTML = 'Current rows';
        finish();
        await assert.doesNotReject(pending);
        assert.equal(f.node('#search-exclusion-result').innerHTML, 'Current destination');
        assert.equal(f.node('#search-exclusion-rows').innerHTML, 'Current rows');
      }
});
test('search exclusion preview refuses changed source, term identity or exact text and never offers a save', async () => {
  for (const change of [
    p => {
      p.source_hash = 'wrong';
    },
    p => {
      p.report_id = 'wrong';
    },
    p => {
      p.targets = [{...p.targets[0], search_term: 'different'}];
    },
    p => {
      p.targets = [{...p.targets[0], match_type: 'BROAD'}];
    },
    p => {
      p.targets = [];
    },
  ]) {
    const f = fixture();
    await f.load();
    f.choose(0);
    f.respond(args => {
      const p = preview(args.ids);
      change(p);
      return p;
    });
    await f.preview();
    assert.doesNotMatch(f.node('#search-exclusion-result').innerHTML, /id="search-exclusion-save"/);
    assert.match(f.node('#search-exclusion-result').innerHTML, /changed|incomplete|refresh/i);
  }
});
test('search exclusion save cannot outlive its confirmation scope and repeated pending clicks do not create extra calls', async () => {
  const f = fixture();
  await f.load();
  f.choose(0);
  await f.preview();
  let finish;
  f.confirm(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = f.save();
  await f.save();
  assert.equal(f.calls.length, 2);
  f.choose(1);
  finish(true);
  await pending;
  assert.equal(f.calls.length, 2);
  await f.preview();
  f.confirm(async () => true);
  f.respond(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const saving = f.save();
  await new Promise(resolve => setImmediate(resolve));
  await f.save();
  assert.equal(f.calls.length, 4);
  f.depart();
  f.node('#search-exclusion-result').innerHTML = 'Another report';
  finish({record_kind: 'search_exclusion_plan', id: 'old', advertising_writes: 0, approval_required: true});
  await saving;
  assert.equal(f.node('#search-exclusion-result').innerHTML, 'Another report');
});

test('failed draft saves keep the original preview and a visible retry instead of creating a replacement', async () => {
  const f = fixture();
  await f.load();
  f.choose(0);
  await f.preview();
  let attempts = 0;
  f.respond(() => {
    if (++attempts === 1) throw Error('Synthetic interrupted reply');
    return {record_kind: 'search_exclusion_plan', id: 'original', advertising_writes: 0, approval_required: true};
  });
  await f.save();
  assert.match(f.node('#search-exclusion-result').innerHTML, /id="search-exclusion-save"/);
  assert.match(f.node('#search-exclusion-save-status').innerHTML, /retry|again|Inspect/i);
  await f.save();
  assert.deepEqual(f.calls[2], f.calls[3]);
  assert.match(f.node('#search-exclusion-result').innerHTML, /campaigns\?id=original/);
});
