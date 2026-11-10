// V2-WEB-03 decision 5: feedback. A toast never covers content: it sits in the page's flow at its block start, so it pushes
// the content down (the V2 toast's own rule, docs/DESIGN-SYSTEM.md), and stays in view under the header while the person has
// scrolled. (The scoped error that leads back to the registry's parent is in tests/website-navigation.test.mjs; the empty
// states are below.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cssDeclarations} from '../tools/check-colours.mjs';
import {dashboard, homePage} from './fixtures/shell-home.mjs';

const read = file => fs.readFileSync('web/' + file, 'utf8');
const declarations = (file, selector, atRule) =>
  cssDeclarations(read(file)).filter(
    d => d.selector === selector && (atRule ? d.atRules.includes(atRule) : d.atRules.length === 0),
  );
const value = (list, property) => list.find(d => d.property === property)?.value;

test('the toast is in the page flow at the block start of the main region, not fixed over the content', () => {
  const index = read('index.html'),
    main = index.slice(index.indexOf('<main id="main"'), index.indexOf('</main>')),
    toast = '<div id="toast" class="toast" role="status" hidden></div>';
  assert.ok(main.includes(toast), 'the toast is inside main');
  assert.ok(
    main.indexOf(toast) < main.indexOf('<div id="content">'),
    'and before the page, so it pushes the page down instead of covering it',
  );
  assert.equal((index.match(/id="toast"/g) ?? []).length, 1);
  assert.ok(!index.slice(index.indexOf('</main>')).includes('id="toast"'), 'no second copy after the page');
  const rule = declarations('app.css', '.toast');
  assert.equal(value(rule, 'position'), 'sticky', 'it stays in view under the header while the page is scrolled');
  assert.ok(
    !cssDeclarations(read('app.css')).some(d => /\.toast\b/.test(d.selector) && /fixed|absolute/.test(d.value)),
  );
  // Logical placement: the toast aligns to the inline end in both directions.
  assert.equal(value(rule, 'margin-inline-start'), 'auto');
  assert.ok(value(rule, 'inset-block-start'));
  assert.ok(!rule.some(d => /^(?:left|right|top|bottom)$/.test(d.property)));
  // On a phone the header is sticky and 64px tall, so the toast sticks below it and never under it.
  const phone = declarations('identity.css', '.toast', '@media (max-width: 850px)'),
    offset = parseInt(value(phone, 'inset-block-start'), 10),
    header = parseInt(value(declarations('identity.css', '.topbar', '@media (max-width: 850px)'), 'height'), 10);
  assert.ok(offset > header, 'the toast sticks below the ' + header + 'px header (' + offset + 'px)');
});

const catalog = JSON.parse(read('locales/ar.json'));

test('an empty state names one next action: the V2 state when the core is there, the same words before it', () => {
  for (const components of [true, false])
    for (const locale of ['en', 'ar']) {
      const page = homePage({components, locale});
      for (const action of [
        {label: 'New campaign plan', href: '/campaigns#campaign-create'},
        {label: 'Sign in →', command: 'login'},
      ]) {
        page.context.state = {title: 'No saved campaign plans yet', body: 'Start one.', action};
        const html = String(page.run('emptyBlock(state)')),
          where = [components, locale, action.label].join(' ');
        assert.ok(html.includes(components ? 'data-kind="empty"' : 'class="empty"'), where);
        assert.ok(html.includes('No saved campaign plans yet') && html.includes('Start one.'), where);
        // Exactly one action, a link to a page or a button that carries its command.
        assert.equal((html.match(/<(?:a|button)\b/g) ?? []).length, 1, where + ': one next action');
        assert.ok(
          action.href
            ? html.includes('<a') && html.includes('href="/campaigns#campaign-create"')
            : html.includes('<button') && html.includes('data-action="login"'),
          where,
        );
        assert.ok(html.includes(action.label), where);
      }
    }
  // A state without an action is refused by the component, so a shell empty state cannot be a dead end.
  const page = homePage();
  page.context.dead = {title: 'Nothing here', body: 'No way on.', action: undefined};
  assert.throws(() => page.run('emptyBlock(dead)'));
});

test('Home’s empty panels each say what to do next, in both languages', async () => {
  const label = (locale, text) => (locale === 'ar' ? catalog[text] : text),
    sectionOf = (html, heading) => {
      const start = html.indexOf('<h2>' + heading + '</h2>');
      assert.ok(start >= 0, heading);
      return html.slice(start, html.indexOf('</section>', start));
    };
  for (const locale of ['en', 'ar']) {
    const page = homePage({locale});
    // No account yet and no plan: the two panels that had only a sentence.
    page.context.workspaceCall = async (_tool, args) =>
      args.action === 'dashboard' ? dashboard : {operations: [], has_more: false};
    await page.run('renderOverview()');
    const html = page.content.innerHTML,
      recent = sectionOf(html, label(locale, 'Continue recent work')),
      readiness = sectionOf(html, label(locale, 'Account readiness'));
    for (const [block, title, body, action, href] of [
      [
        recent,
        'No saved campaign plans yet',
        'Your saved campaign plans will appear here.',
        'New campaign plan',
        '/campaigns#campaign-create',
      ],
      [
        readiness,
        'No accounts to check yet',
        'Connect a platform and select resources to check readiness.',
        'Set up connections',
        '/connections',
      ],
    ]) {
      const where = locale + ' ' + title;
      assert.ok(block.includes('data-kind="empty"'), where + ': the V2 empty state');
      assert.ok(block.includes(label(locale, title)) && block.includes(label(locale, body)), where);
      // The panel's own link (All plans, Manage connections) is a different link: this is the state's one action.
      assert.ok(block.includes('href="' + href + '"') && block.includes(label(locale, action)), where + ': ' + href);
      assert.equal((block.match(/class="amcp-button"/g) ?? []).length, 1, where + ': one action in the state');
      if (locale === 'ar')
        assert.doesNotMatch(block.replace(/<[^>]+>/g, ' '), /[A-Za-z]{3,}/, where + ': no English left');
    }
  }
});

test('the toast keeps its message API: one element, its text set and shown, then hidden', () => {
  const app = read('app.js'),
    toast = app.slice(app.indexOf('function toast('), app.indexOf('// A page that fails to open'));
  assert.match(toast, /\$\('#toast'\)\.textContent = message/);
  assert.match(toast, /\$\('#toast'\)\.hidden = false/);
  assert.match(toast, /\$\('#toast'\)\.hidden = true/);
});
