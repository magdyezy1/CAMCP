// DOC-03 (owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"): the website had no help and no link to
// documentation, so an owner met the guide only on GitHub. tools/help-pages.mjs turns the owner guide into escaped HTML
// fragments at build time for the members-only /help page. These checks hold the fragments to what the page may show:
// the committed file is the guide as it is now, every character is escaped, only headings, paragraphs, lists, tables,
// emphasis and links reach the page, no script, style or event attribute can, and a link opens another part of the
// guide or a page of the website.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  guideBlocks,
  guideOrder,
  helpFile,
  helpGuideProblems,
  helpGuideText,
  sitePath,
  staticPages,
} from '../tools/help-pages.mjs';
import {loadRouteRegistry} from '../tools/check-routes.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const committed = JSON.parse(fs.readFileSync(helpFile, 'utf8'));
const allowedTags = new Set([
  'div',
  'section',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
]);
for (const tag of ['th', 'td', 'strong', 'em', 'code', 'a']) allowedTags.add(tag);
const allowedAttributes = new Set([
  'class',
  'id',
  'href',
  'lang',
  'dir',
  'data-help-language',
  'aria-labelledby',
  'scope',
]);

/** A temporary repository with the guide's two languages and the route registry the links are checked against. */
function tree(t, pages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-help-pages-'));
  t.after(() => removeTestDirectory(root, 'amcp-help-pages-'));
  fs.mkdirSync(path.join(root, 'docs/owner/ar'), {recursive: true});
  fs.mkdirSync(path.join(root, 'web'), {recursive: true});
  fs.copyFileSync('web/routes.js', path.join(root, 'web/routes.js'));
  for (const [file, text] of Object.entries(pages)) fs.writeFileSync(path.join(root, 'docs/owner', file), text);
  return root;
}
const front = '---\nstatus: current\ntier: owner\n---\n\n';

test('the committed fragments are the owner guide as it is now, in both languages', () => {
  assert.deepEqual(helpGuideProblems('.'), []);
  assert.equal(helpGuideText('.'), fs.readFileSync(helpFile, 'utf8').replaceAll('\r\n', '\n'));
  assert.equal(committed.generator, 'tools/help-pages.mjs');
  assert.deepEqual(Object.keys(committed.languages), ['en', 'ar']);
  // Every page of both languages is a source, with its digest.
  const order = guideOrder('.');
  assert.equal(order[0], 'README.md');
  assert.deepEqual(Object.keys(committed.sources), [
    ...order.map(p => 'docs/owner/' + p),
    ...order.map(p => 'docs/owner/ar/' + p),
  ]);
  for (const digest of Object.values(committed.sources)) assert.match(digest, /^sha256:[0-9a-f]{64}$/);
});

test('the fragments hold only the guide’s own markup: no script, style, event attribute or unknown element', () => {
  for (const [language, {html}] of Object.entries(committed.languages)) {
    assert.ok(html.startsWith('<div class="help-guide-language" lang="' + language + '" dir="'), language);
    assert.match(html, language === 'ar' ? / dir="rtl"/ : / dir="ltr"/);
    for (const m of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
      assert.ok(allowedTags.has(m[1]), language + ': <' + m[1] + '>');
      for (const attribute of m[2].matchAll(/\s([a-z-]+)="([^"]*)"/g)) {
        assert.ok(allowedAttributes.has(attribute[1]), language + ': ' + attribute[1]);
        assert.doesNotMatch(attribute[2], /[<>]/);
      }
      // Nothing but attributes in quotes: no bare attribute, no event handler, no style.
      assert.equal(m[2].replace(/\s[a-z-]+="[^"]*"/g, ''), '', language + ': ' + m[0]);
    }
    assert.doesNotMatch(html, /<script|<style|javascript:|\son[a-z]+=|style=/i);
    // The text is escaped: an apostrophe of the English guide is an entity, never markup.
    if (language === 'en') assert.match(html, /clients&#39; ad accounts/);
    // Every heading has an id of its own language, and every page is a section named by its title.
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, language + ': ids are unique');
    for (const id of ids) assert.match(id, new RegExp('^help-' + language + '-[a-z-]+(?:-\\d+)?$'));
    assert.equal((html.match(/<section /g) ?? []).length, guideOrder('.').length, language);
  }
  // The two languages can sit in one page: no id is shared.
  const all = Object.values(committed.languages).flatMap(({html}) => [...html.matchAll(/\sid="([^"]+)"/g)]);
  assert.equal(new Set(all.map(m => m[1])).size, all.length);
});

test('every link opens a heading of the guide in the same language or a page of this website', () => {
  const routes = [...loadRouteRegistry().map(entry => entry.path), ...staticPages];
  for (const [language, {html}] of Object.entries(committed.languages)) {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])),
      links = [...html.matchAll(/<a href="([^"]+)">/g)].map(m => m[1]);
    assert.ok(links.length >= 10, language + ': the start page links every task');
    for (const href of links)
      if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), language + ': ' + href);
      else {
        assert.ok(routes.includes(href.split('?')[0]), language + ': ' + href);
        assert.doesNotMatch(href, /^\/\/|^[a-z]+:/i, 'a same-site address');
      }
  }
  assert.equal(sitePath('https://amcp.shop/privacy', ['/privacy']), '/privacy');
  assert.equal(sitePath('https://amcp.shop/privacy?lang=ar', ['/privacy']), '/privacy?lang=ar');
  for (const target of [
    'https://amcp.shop/unknown',
    'https://amcp.shop/privacy?next=x',
    'https://amcp.shop/privacy#top',
    'https://user@amcp.shop/privacy',
    'https://amcp.shop.example/privacy',
    'https://example.com/privacy',
  ])
    assert.equal(sitePath(target, ['/privacy']), undefined, target);
});

test('the generator escapes every character and refuses what the Help page cannot show', t => {
  const page = text => ({'README.md': front + '# Guide\n\n' + text + '\n'});
  const html = root => JSON.parse(helpGuideText(root)).languages.en.html;
  // A page needs its translation, and then escapes markup as text.
  const root = tree(
    t,
    page('Use <script>alert(1)</script> & "quotes" in **bold** and *one* `code` [Privacy](https://amcp.shop/privacy).'),
  );
  assert.match(helpGuideProblems(root)[0], /docs\/owner\/ar\/README\.md: is missing/);
  fs.writeFileSync(path.join(root, 'docs/owner/ar/README.md'), front + '# دليل\n\nنص.\n');
  const out = html(root);
  assert.ok(
    out.includes('Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; in <strong>bold</strong>'),
  );
  assert.ok(out.includes('<em>one</em> <code>code</code> <a href="/privacy">Privacy</a>.'));
  assert.doesNotMatch(out, /<script/);
  // What the page cannot show, or a link that would leave the guide and the website, stops the generator.
  for (const [text, reason] of [
    ['```\ncode\n```', /headings, paragraphs, lists, tables/],
    ['> a quote', /headings, paragraphs, lists, tables/],
    ['<b>raw</b>', /headings, paragraphs, lists, tables/],
    ['![image](a.png)', /headings, paragraphs, lists, tables/],
    ['- one\n  - nested', /no nested lists/],
    ['1. one\n3. three', /counts 1, 2, 3/],
    ['[deploy](../DEPLOY-RAILWAY.md)', /no page of this guide/],
    ['[a site](https://example.com/)', /opens the guide or a page of this website/],
    ['[a page](https://amcp.shop/not-a-page)', /opens the guide or a page of this website/],
    ['[a section](#nowhere)', /names no heading/],
    ['| a | b |\n| c | d |', /header row and a separator row/],
    ['# A second title', /one "# " title/],
  ]) {
    fs.writeFileSync(path.join(root, 'docs/owner/README.md'), front + '# Guide\n\n' + text + '\n');
    assert.match(helpGuideProblems(root).join('\n'), reason, text);
  }
});

test('a link to a section opens that heading; a changed page makes the fragments stale until they are written', t => {
  const root = tree(t, {
    'README.md': front + '# Guide\n\n1. [Team](team.md)\n2. [Roles](team.md#roles)\n',
    'team.md': front + '# Team\n\n## Roles\n\n| Role | Can |\n|---|---|\n| Owner | Everything |\n',
  });
  fs.writeFileSync(
    path.join(root, 'docs/owner/ar/README.md'),
    front + '# دليل\n\n1. [الفريق](team.md)\n2. [الأدوار](team.md#الأدوار)\n',
  );
  fs.writeFileSync(
    path.join(root, 'docs/owner/ar/team.md'),
    front + '# الفريق\n\n## الأدوار\n\n| الدور | يستطيع |\n|---|---|\n| مالك | كل شيء |\n',
  );
  assert.match(helpGuideProblems(root)[0], /out of date/);
  assert.deepEqual(helpGuideProblems(root, {write: true}), []);
  assert.deepEqual(helpGuideProblems(root), []);
  const {en, ar} = JSON.parse(fs.readFileSync(path.join(root, helpFile), 'utf8')).languages;
  assert.ok(
    en.html.includes('<a href="#help-en-team">Team</a>') && en.html.includes('<a href="#help-en-team-1">Roles</a>'),
  );
  assert.ok(ar.html.includes('<a href="#help-ar-team-1">الأدوار</a>'), 'an Arabic heading anchor resolves');
  assert.ok(
    en.html.includes('<th scope="col">Role</th>') && en.html.includes('<th scope="row">Owner</th><td>Everything</td>'),
  );
  fs.appendFileSync(path.join(root, 'docs/owner/team.md'), '\nA new line.\n');
  assert.match(helpGuideProblems(root)[0], /generated\/help-guide\.json is out of date/);
  // A page the start page does not link has no place in the guide.
  fs.writeFileSync(path.join(root, 'docs/owner/extra.md'), front + '# Extra\n');
  assert.match(helpGuideProblems(root)[0], /does not link docs\/owner\/extra\.md/);
  assert.equal(guideBlocks(front + '# T\n\nText\non two lines.\n')[1].text, 'Text on two lines.');
});

// The review of wave 4c: condensing the guide dropped section headings that wave 4b had published, so each page keeps
// their anchors on a line of its own (tests/owner-guide.test.mjs). The Help page shows nothing for that line, a guide
// link to one of its anchors opens the heading above it, and every other HTML stays refused.
test('a former section anchor shows nothing on the Help page, and a link to it opens the heading above it', t => {
  const root = tree(t, {
    'README.md': front + '# Guide\n\n1. [Old section](team.md#old-roles)\n',
    'team.md':
      front + '# Team\n\n## Roles\n\n<a id="old-roles"></a><a id="old-members"></a>\n\nOwners do everything.\n',
  });
  fs.writeFileSync(path.join(root, 'docs/owner/ar/README.md'), front + '# Guide (ar)\n\n1. [Old](team.md#old-roles)\n');
  fs.writeFileSync(
    path.join(root, 'docs/owner/ar/team.md'),
    front + '# Team (ar)\n\n## Roles (ar)\n\n<a id="old-roles"></a>\n\nText.\n',
  );
  assert.deepEqual(helpGuideProblems(root, {write: true}), []);
  const {en, ar} = JSON.parse(fs.readFileSync(path.join(root, helpFile), 'utf8')).languages;
  assert.ok(en.html.includes('<a href="#help-en-team-1">Old section</a>'));
  assert.ok(ar.html.includes('<a href="#help-ar-team-1">Old</a>'));
  assert.ok(en.html.includes('<h3 id="help-en-team-1">Roles</h3><p>Owners do everything.</p>'));
  for (const {html} of [en, ar]) assert.doesNotMatch(html, /old-roles|old-members/);
  for (const [text, reason] of [
    ['## Roles\n<a id="old"></a>\n\nText.', /stands alone, between blank lines/],
    ['## Roles\n\n<a id="old"></a>\nText.', /stands alone, between blank lines/],
    ['## Roles\n\n<a id="roles"></a>\n\nText.', /the anchor "roles" repeats an anchor of the page/],
    ['## Roles\n\n<a id="old-roles"></a><a id="old-roles"></a>\n\nText.', /repeats an anchor of the page/],
    ['## Roles\n\n<a id="old-roles"></a> and text\n\nText.', /headings, paragraphs, lists, tables/],
    ['## Roles\n\n<a id="old-roles" class="x"></a>\n\nText.', /headings, paragraphs, lists, tables/],
    ['## Roles\n\n<a name="old-roles"></a>\n\nText.', /headings, paragraphs, lists, tables/],
  ]) {
    fs.writeFileSync(path.join(root, 'docs/owner/team.md'), front + '# Team\n\n' + text + '\n');
    assert.match(helpGuideProblems(root).join('\n'), reason, text);
  }
  // A page still starts with its title.
  fs.writeFileSync(path.join(root, 'docs/owner/team.md'), front + '<a id="old-roles"></a>\n\n# Team\n');
  assert.match(helpGuideProblems(root).join('\n'), /starts with its "# " title/);
});
