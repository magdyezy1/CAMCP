// WEB-07: escape-by-default markup. web/localization.js defines html`…`, raw(), setHtml and insertHtml; the pages
// escaped every value by hand in untagged templates (284 innerHTML writes counted by the review). tools/check-markup.mjs
// counts what is still escaped by hand, refuses an increase and refuses the mistakes a conversion can make.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import * as prettier from 'prettier';
import {checkMarkup, inspectMarkup, markupRatchet, readMarkupBaseline} from '../tools/check-markup.mjs';

function markup() {
  const context = createContext({document: {addEventListener() {}}, Intl});
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  return {context, run};
}

test('html`…` escapes every value and keeps the markup it built itself', () => {
  const {run} = markup();
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(
    run(`String(html\`<p title="\${'"q" & \\'s\\''}">\${${JSON.stringify(hostile)}}</p>\`)`),
    '<p title="&quot;q&quot; &amp; &#39;s&#39;">&lt;img src=x onerror=alert(1)&gt;</p>',
  );
  // Lists of html`…` (from .map) go in as markup; their own values stay escaped.
  assert.equal(
    run("String(html`<ul>${['a', '<b>'].map(v => html`<li>${v}</li>`)}</ul>`)"),
    '<ul><li>a</li><li>&lt;b&gt;</li></ul>',
  );
  assert.equal(run("String(html`${[['x', html`<i>y</i>`], [null]]}`)"), 'x<i>y</i>');
  // raw() is the explicit marker for a fragment AMCP escaped itself.
  assert.equal(run("String(html`<p>${raw('<i>own</i>')}</p>`)"), '<p><i>own</i></p>');
  assert.equal(run('const once = html`<b></b>`; raw(once) === once'), true);
  // null and undefined insert nothing; other values read as text, as esc() reads them.
  assert.equal(run('String(html`${null}|${undefined}|${0}|${false}|${12.5}`)'), '||0|false|12.5');
  // The result reads as its markup wherever a string is expected, so existing templates can embed it.
  assert.equal(run('`<div>${html`<b>${"&"}</b>`}</div>`'), '<div><b>&amp;</b></div>');
  assert.equal(run("'<div>' + html`<br>`"), '<div><br>');
  assert.equal(run('Object.isFrozen(html`x`) && isSafeHtml(html`x`) && !isSafeHtml("<b>x</b>")'), true);
});

test('setHtml and insertHtml take only escape-by-default markup and write it as a string', () => {
  const {context, run} = markup();
  context.element = {
    innerHTML: '',
    inserted: [],
    insertAdjacentHTML(position, value) {
      this.inserted.push([position, value]);
    },
  };
  run("setHtml(element, html`<p>${'<b>'}</p>`)");
  assert.equal(typeof context.element.innerHTML, 'string');
  assert.equal(context.element.innerHTML, '<p>&lt;b&gt;</p>');
  run("insertHtml(element, 'beforeend', html`<i>${'&'}</i>`)");
  assert.deepEqual(context.element.inserted, [['beforeend', '<i>&amp;</i>']]);
  // A plain string, a template literal or an object that only looks like markup never reaches a sink.
  for (const value of ["'<b>x</b>'", '`<b>${1}</b>`', "({toString: () => '<b>x</b>'})", 'null'])
    assert.throws(() => run(`setHtml(element, ${value})`), /setHtml takes html`…` or raw\(\) markup/, value);
  assert.throws(() => run("insertHtml(element, 'beforeend', '<b>x</b>')"), /insertHtml takes html`…`/);
  assert.equal(context.element.innerHTML, '<p>&lt;b&gt;</p>', 'A refused write leaves the element unchanged');
});

test('the markup check counts what is escaped by hand and refuses the mistakes of a conversion', () => {
  const count = source => {
    const {sinks, unescaped, problems} = inspectMarkup(source, 'synthetic.js');
    return {sinks, unescaped, problems: problems.map(problem => problem.replace(/^synthetic\.js:\d+: /, ''))};
  };
  assert.deepEqual(count('el.innerHTML = `<b>${name}</b>`;'), {sinks: 1, unescaped: 1, problems: []});
  assert.deepEqual(count('el.innerHTML = `<b>${esc(name)} ${uiBidi(id, "ltr")}</b>`;'), {
    sinks: 1,
    unescaped: 0,
    problems: [],
  });
  assert.deepEqual(count("el.innerHTML = '';"), {sinks: 0, unescaped: 0, problems: []}, 'Clearing is not a write');
  assert.equal(count("el.insertAdjacentHTML('beforeend', `<p>${a ? `<b>${b}</b>` : ''}</p>`);").unescaped, 1);
  assert.equal(count("x = '<span>' + name + '</span>';").unescaped, 1);
  assert.equal(count('x = `<ul>${list.map(v => `<li>${esc(v)}</li>`).join("")}</ul>`;').unescaped, 0);
  assert.equal(count('x = `<ul>${list.map(v => `<li>${v}</li>`).join("")}</ul>`;').unescaped, 1);
  assert.equal(count('x = `Total: ${n}`;').unescaped, 0, 'Text without markup is not counted');
  // Escape-by-default markup counts nothing, except fragments trusted with raw().
  assert.deepEqual(count('setHtml(el, html`<ul>${list.map(v => html`<li>${v}</li>`)}</ul>`);'), {
    sinks: 0,
    unescaped: 0,
    problems: [],
  });
  assert.equal(count('setHtml(el, html`${raw(helper())}`);').unescaped, 1);
  assert.equal(count('setHtml(el, html`${raw(uiBidi(name))}${raw("<hr>")}`);').unescaped, 0);
  assert.deepEqual(
    count(
      'setHtml(el, html`<b>${esc(name)}</b>${uiBidi(id)}${list.map(v => html`<i>${v}</i>`).join("")}${a ? `<i>${b}</i>` : ""}`);',
    ).problems,
    [
      'html`…` escapes esc() a second time; interpolate the value',
      'html`…` would show the markup of uiBidi() as text; use raw() or html`…`',
      'html`…` would escape a joined list; interpolate the list of html`…` itself',
      'an untagged HTML template inside html`…` is escaped; tag it with html',
    ],
  );
  // Text joined with a separator is text, and html`…` escapes it correctly.
  assert.deepEqual(count('setHtml(el, html`<code>${names.join(", ")}</code>`);').problems, []);
  assert.deepEqual(count('setHtml(el, `<b>${x}</b>`); insertHtml(el, "beforeend", "<p></p>");').problems, [
    'setHtml() takes html`…` markup, not a string',
    'insertHtml() takes html`…` markup, not a string',
  ]);
});

test('a count above its limit is refused and the shipped scripts are within the committed baseline', () => {
  const baseline = {files: {'a.js': {sinks: 2, unescaped: 5}}};
  assert.deepEqual(markupRatchet({'a.js': {sinks: 2, unescaped: 5}}, baseline), []);
  assert.deepEqual(markupRatchet({'a.js': {sinks: 1, unescaped: 0}}, baseline), [], 'Going down is always allowed');
  assert.match(markupRatchet({'a.js': {sinks: 3, unescaped: 5}}, baseline).join('\n'), /web\/a\.js: 3 HTML writes/);
  assert.match(markupRatchet({'new.js': {sinks: 0, unescaped: 1}}, baseline).join('\n'), /web\/new\.js: 1 unescaped/);
  const committed = readMarkupBaseline(),
    {counts, problems} = checkMarkup();
  assert.deepEqual(problems, []);
  // The review counted 284 innerHTML writes escaped by hand; the ratchet started at the whole tree's 336 writes and
  // 1268 values (Work-here, 2026-10-16) and has only gone down since.
  assert.ok(committed.totals.sinks <= 336 && committed.totals.unescaped <= 1268);
  const totals = Object.values(counts).reduce((sum, value) => sum + value.sinks + value.unescaped, 0);
  assert.ok(totals <= committed.totals.sinks + committed.totals.unescaped);
  // check-web runs the ratchet.
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /checkMarkup\(\)/);
});

test('Prettier keeps html`…` markup exactly as written in shipped scripts', async () => {
  const options = await prettier.resolveConfig('web/app.js');
  assert.equal(options.embeddedLanguageFormatting, 'off');
  const source = 'setHtml(el, html`<div class="a"><span>${name}</span><b>${count}</b></div>`);\n';
  assert.equal(await prettier.format(source, {...options, filepath: 'web/app.js'}), source);
});

test('Activity renders audit identifiers and provider codes as text', async () => {
  const nodes = new Map(),
    node = key => {
      if (!nodes.has(key))
        nodes.set(key, {
          innerHTML: '',
          isConnected: true,
          elements: {search: {value: ''}, account_id: {value: ''}},
          setAttribute() {},
          addEventListener() {},
        });
      return nodes.get(key);
    };
  const hostile = '<img src=x onerror=alert(1)>',
    context = createContext({
      session: {authenticated: true},
      content: node('content'),
      navigationGeneration: 1,
      identityGeneration: 1,
      URLSearchParams,
      Intl,
      header: (title, description) => `<h1>${title}</h1><p>${description}</p>`,
      $: node,
      document: {addEventListener() {}},
      errorMessage: e => e.message,
      workspaceBind() {},
      renderSourceDiagnostic: () => '<p class="diagnostic">Diagnostic</p>',
      api: async () => ({
        events: [
          {
            at: 1,
            event: {
              event: hostile,
              platform: '"><svg onload=alert(1)>',
              account_id: '<script>x</script>',
              action: hostile,
              request_id: '</code><b>reference</b>',
              error: {code: '<u>CODE</u>'},
            },
            diagnostics: [{}],
          },
        ],
      }),
    });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  const app = fs.readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('async function renderActivity()'), app.indexOf('async function renderCallback()')));
  await run('renderActivity()');
  const page = node('content').innerHTML;
  assert.equal(typeof page, 'string');
  for (const markup of ['<img', '<svg', '<script', '<b>reference', '<u>CODE'])
    assert.equal(page.includes(markup), false, markup);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /<bdi dir="ltr">&quot;&gt;&lt;svg onload=alert\(1\)&gt;<\/bdi> · <bdi dir="ltr">&lt;script&gt;/);
  assert.match(page, /<summary>&lt;u&gt;CODE&lt;\/u&gt;<\/summary><p class="diagnostic">Diagnostic<\/p>/);
  assert.match(page, /<h1>Audit activity<\/h1>/);
});
