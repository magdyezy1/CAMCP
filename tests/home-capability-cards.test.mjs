// DOC-03: on the empty synthetic fixture, Home's capability block was the server's evidence sentence ("Implemented and
// fixture-tested are not live qualification") with every capability one disclosure away under its engineering name,
// MCP tool name and an "Implemented, not live-verified" badge: an owner met tool and evidence vocabulary, not what AMCP
// does for them. Home now names each capability by its outcome for the owner, in English and Arabic, with a plain
// sentence on what verified means; Technical details keeps the names, coverage, tool names and evidence states. These
// render Home's real scripts against the server's own capability list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {workspaceCapabilities} from '../dist/src/capabilities.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
  );
const plain =
  'Each is tested against simulated platforms. It counts as verified on one of your accounts only after AMCP reads the result back there.';

/** localization.js, workspace.js and work-center.js in a page with the given language, as Home loads them. */
function home(locale) {
  const content = {innerHTML: ''};
  const context = createContext({
    URL,
    URLSearchParams,
    Map,
    Set,
    Intl,
    content,
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    esc: escape,
    date: value => String(value),
    header: (title, description, action) => `<h1>${title}</h1><p>${description}</p>${action}`,
    glyph: () => '',
    session: {name: 'Synthetic Person'},
    workspaceBind() {},
    navigationGeneration: 1,
    identityGeneration: 1,
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(fs.readFileSync('web/workspace.js', 'utf8'));
  run(fs.readFileSync('web/work-center.js', 'utf8'));
  context.catalog = catalog;
  if (locale === 'ar') run("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))");
  return {run, context, content};
}
/** The markup without the <details> element whose summary is `summary` (its nested disclosures included). */
function without(html, summary) {
  const start = html.indexOf('<details class="workspace-details"><summary>' + summary + '</summary>');
  assert.ok(start >= 0, summary);
  const tag = /<\/?details\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (!depth)
      return {outside: html.slice(0, start) + html.slice(tag.lastIndex), inside: html.slice(start, tag.lastIndex)};
  }
  throw Error('unbalanced <details>');
}
const text = html => html.replace(/<[^>]+>/g, ' ');

// The empty workspace the review observed, and one with a login, a checked account and a verified change, whose
// evidence names the provider's own gateway and action.
const emptyStore = {documents: () => [], listConnections: () => [], connectionsFor: () => []};
const connection = {id: 'meta', gateway: 'meta_native_action', accounts: ['act_100']};
const usedStore = {
  documents: (_tenant, kind) =>
    kind === 'readiness'
      ? [{connection_id: 'meta', account_id: 'act_100', live_read: true, checked_at: 1}]
      : kind === 'write_verification'
        ? [
            {
              connection_id: 'meta',
              account_id: 'act_100',
              review_id: 'r1',
              action: 'update_campaign',
              status: 'verified',
              checked_at: 2,
            },
          ]
        : [],
  listConnections: () => [connection],
  connectionsFor: () => [connection],
};
function dashboard(store) {
  const capabilities = workspaceCapabilities(store, {tenantId: 'tenant-a'}),
    connections = store.connectionsFor().map(c => ({
      ...c,
      label: 'Synthetic',
      enabled: true,
      write_accounts: [],
      accounts_status: c.accounts.map(account_id => ({
        account_id,
        check: {ready: true, checked_at: 1},
        verified_writes: [],
      })),
    }));
  return {connections, campaigns: [], writes_paused: null, capabilities};
}

test('every capability of the server has an outcome label for the owner, with an Arabic entry', () => {
  const server = workspaceCapabilities(emptyStore, {tenantId: 'tenant-a'}),
    page = home('en'),
    outcomes = JSON.parse(page.run('JSON.stringify(homeCapabilityCopy.outcomes)'));
  // Home's own copy is in Home's page script (web/work-center.js), so no other page downloads it (WEB-07).
  assert.equal(page.run('homeCapabilityCopy.note'), plain);
  assert.ok(!fs.readFileSync('web/workspace.js', 'utf8').includes(plain), 'the shell script does not carry it');
  assert.deepEqual(
    Object.keys(outcomes).sort(),
    server.features.map(f => f.id).sort(),
    'src/capabilities.ts and Home agree',
  );
  for (const label of [...Object.values(outcomes), plain]) {
    assert.ok(Object.hasOwn(catalog, label), label);
    // An outcome is the owner's words: no tool name, code or evidence vocabulary.
    assert.doesNotMatch(label, /amcp_|_native_action|[A-Z]{2,}_|fixture|qualif|unverified/i, label);
  }
  // Outcome labels never claim more than the evidence: none says a capability is live or guaranteed.
  for (const label of Object.values(outcomes)) assert.doesNotMatch(label, /\b(?:live|guarantee)/i, label);
});

test('Home shows what each capability does and no raw tool name or evidence state outside Technical details', async () => {
  for (const store of [emptyStore, usedStore])
    for (const locale of ['en', 'ar']) {
      const page = home(locale),
        d = dashboard(store),
        label = value => (locale === 'ar' ? catalog[value] : value),
        outcomes = JSON.parse(page.run('JSON.stringify(homeCapabilityCopy.outcomes)'));
      page.context.workspaceCall = async (_tool, args) =>
        args.action === 'dashboard' ? d : {operations: [], has_more: false};
      await page.run('renderOverview()');
      const html = page.content.innerHTML,
        start = html.indexOf('<h2>' + label('Capabilities and evidence') + '</h2>'),
        block = html.slice(start, html.indexOf('</section>', start)),
        {outside, inside} = without(html, label('Technical details'));
      assert.ok(start > 0, locale);
      // Visible: the plain sentence and one outcome per capability, in the page's language.
      assert.ok(block.includes(escape(label(plain))), locale + ': the plain sentence');
      for (const f of d.capabilities.features)
        assert.ok(outside.includes('<li>' + escape(label(outcomes[f.id])) + '</li>'), locale + ' ' + f.id);
      // Nowhere on Home outside the disclosure: an MCP tool name, a provider gateway, the evidence badge or sentence.
      const tools = [...new Set(d.capabilities.features.map(f => f.tool))];
      assert.ok(tools.length >= 4);
      for (const shown of [...tools, 'meta_native_action', 'update_campaign'])
        assert.ok(!outside.includes(shown), locale + ': ' + shown + ' outside Technical details');
      assert.doesNotMatch(text(outside), /amcp_[a-z]|_native_action/);
      assert.ok(!outside.includes(label('Implemented, not live-verified')), locale + ': the evidence badge');
      assert.ok(!outside.includes(escape(label(d.capabilities.meaning))), locale + ': the evidence sentence');
      // Technical details keeps them: each capability's name, coverage, tool and evidence state, the evidence sentence
      // and the per-account evidence.
      for (const f of d.capabilities.features) {
        assert.ok(inside.includes('<strong>' + escape(label(f.name)) + '</strong>'), locale + ' ' + f.name);
        assert.ok(inside.includes(escape(label(f.coverage))), locale + ' ' + f.coverage);
        assert.ok(inside.includes('<code>' + f.tool + '</code>'), locale + ' ' + f.tool);
      }
      assert.equal(
        (inside.match(new RegExp('>' + label('Implemented, not live-verified') + '</span>', 'g')) ?? []).length,
        d.capabilities.features.length,
      );
      assert.ok(inside.includes(escape(label(d.capabilities.meaning))));
      if (store === usedStore) assert.ok(inside.includes('update_campaign') && inside.includes('act_100'));
      // In Arabic every word AMCP adds outside the disclosure is Arabic; the product name and the account and login
      // names the person chose stay literal.
      if (locale === 'ar')
        assert.doesNotMatch(
          text(outside).replace(/\bAMCP\b|Synthetic(?: Person)?|act_100/g, ''),
          /[A-Za-z]{2,}/,
          text(outside),
        );
    }
});
