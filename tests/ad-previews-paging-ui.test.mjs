import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * The previews panel's own script in a VM, with the shell's markup helpers (web/localization.js) and a fake page. The
 * results region is modelled as the page has it: rows and a footer inside it, so a write to the region and an append to
 * its rows can be told apart (`writes`, `appended`).
 */
function fixture() {
  const nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) {
      const self = {
        textContent: '',
        hidden: false,
        attributes: new Map(),
        appended: [],
        focused: 0,
        listeners: new Map(),
        _html: '',
        addEventListener(name, fn) {
          this.listeners.set(name, fn);
        },
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        insertAdjacentHTML(position, markup) {
          assert.equal(position, 'beforeend');
          this.appended.push(markup);
          this._html += markup;
        },
        focus() {
          this.focused++;
        },
        get innerHTML() {
          return id === '#preview-results' && this.structured
            ? '<div id="preview-rows">' +
                node('#preview-rows')._html +
                '</div><div id="preview-footer">' +
                node('#preview-footer')._html +
                '</div>'
            : this._html;
        },
        set innerHTML(markup) {
          this._html = markup;
          this.writes = (this.writes ?? 0) + 1;
          if (id !== '#preview-results') return;
          const parts = /^<div id="preview-rows">([\s\S]*?)<\/div><div id="preview-footer">([\s\S]*)<\/div>$/.exec(
            markup,
          );
          this.structured = !!parts;
          node('#preview-rows')._html = parts?.[1] ?? '';
          node('#preview-footer')._html = parts?.[2] ?? '';
        },
      };
      nodes.set(id, self);
    }
    return nodes.get(id);
  };
  const form = node('#preview-form');
  form.elements = {
    target: {value: '0'},
    ad_ids: {value: ''},
    statuses: {value: 'active'},
    ad_format: {value: 'MOBILE_FEED_STANDARD'},
  };
  let submit;
  const context = createContext({
    document: {addEventListener() {}},
    platforms: [{gateway: 'snapchat_native_action', connections: [{id: 'login', enabled: true, accounts: ['100']}]}],
    accountLabel: () => 'Synthetic',
    $: node,
    esc: s =>
      String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    blank: s => s,
    date: String,
    errorMessage: e => e.message,
    workspaceBind: (_selector, fn) => {
      submit = fn;
    },
    workspaceCall: (_tool, args) =>
      new Promise((resolve, reject) => calls.push({args: structuredClone(args), resolve, reject})),
  });
  // The shell's escape-by-default markup (html, raw, setHtml, insertHtml), uiText and uiPlural: English, as an empty catalog.
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/ad-previews.js', 'utf8')).runInContext(context);
  new Script('bindAdPreviews()').runInContext(context);
  const results = node('#preview-results'),
    click = (selector = '#preview-load-more') =>
      results.listeners.get('click')({target: {closest: wanted => wanted === selector}});
  return {form, node, calls, results, click, submit: () => submit(form), context};
}
const row = (id, source, links = ['https://ads.snapchat.com/preview/' + id]) => ({
  ad_id: id,
  source_ad_id: source,
  name: id,
  links,
});
const page = (previews, more) => ({
  previews,
  meaning: 'Synthetic',
  has_more: more,
  next_cursor: more ? 'signed-cursor' : null,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Load more reuses the selection and native cursor, keeps shared creatives and suppresses duplicate clicks', async () => {
  const f = fixture(),
    first = f.submit();
  assert.deepEqual(f.calls[0].args.statuses, ['active']);
  f.calls[0].resolve({
    previews: [row('cr1', 'a1')],
    meaning: 'Synthetic',
    has_more: true,
    next_cursor: 'signed-cursor',
  });
  await first;
  assert.match(f.results.innerHTML, /preview-load-more/);
  f.click();
  f.click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args.cursor, 'signed-cursor');
  assert.equal(f.calls[1].args.account_id, '100');
  f.calls[1].resolve({
    previews: [row('cr1', 'a3'), row('cr1', 'a1')],
    meaning: 'Synthetic',
    has_more: false,
    next_cursor: null,
  });
  await tick();
  assert.match(f.results.innerHTML, /Ad a1/);
  assert.match(f.results.innerHTML, /Ad a3/);
  assert.equal((f.results.innerHTML.match(/Ad a1/g) ?? []).length, 1);
  assert.doesNotMatch(f.results.innerHTML, /preview-load-more/);
});

test('changing the selection discards an in-flight answer and its continuation', async () => {
  const f = fixture(),
    pending = f.submit();
  f.form.elements.statuses.value = 'paused';
  f.form.listeners.get('change')();
  f.calls[0].resolve({previews: [row('stale', 'old')], meaning: 'Synthetic', has_more: true, next_cursor: 'old'});
  await pending;
  assert.doesNotMatch(f.results.innerHTML, /stale|preview-load-more/);
  f.click();
  assert.equal(f.calls.length, 1);
  const fresh = f.submit();
  assert.deepEqual(f.calls[1].args.statuses, ['paused']);
  assert.equal(f.calls[1].args.cursor, undefined);
  f.calls[1].resolve({previews: [], meaning: 'Synthetic', has_more: false});
  await fresh;
});

// F-L3-06: Load more rewrote the whole region, so the reader's focus fell to the page body and a screen reader read every
// row again. The new rows are appended, focus goes to the first of them, and only their number is announced.
test('Load more appends only the new rows, moves focus to the first of them and announces only how many came', async () => {
  const f = fixture(),
    first = f.submit(),
    status = f.node('#preview-status'),
    rows = f.node('#preview-rows');
  f.calls[0].resolve(page([row('cr1', 'a1'), row('cr2', 'a2')], true));
  await first;
  assert.equal(f.results.writes, 1);
  assert.equal(status.textContent, '2 previews');
  // Every row can take focus from the script and has a place of its own.
  assert.match(f.results.innerHTML, /id="preview-row-0" tabindex="-1"/);
  assert.match(f.results.innerHTML, /id="preview-row-1" tabindex="-1"/);
  f.click();
  assert.equal(f.node('#preview-load-more').attributes.get('aria-disabled'), 'true');
  assert.equal(f.node('#preview-load-more').disabled, undefined);
  f.calls[1].resolve(page([row('cr2', 'a2'), row('cr3', 'a3'), row('cr4', 'a4')], true));
  await tick();
  // The region was written once; the rows were appended, and only the two new ones (a2 was already there).
  assert.equal(f.results.writes, 1);
  assert.equal(rows.appended.length, 1);
  assert.match(rows.appended[0], /id="preview-row-2"/);
  assert.match(rows.appended[0], /id="preview-row-3"/);
  assert.doesNotMatch(rows.appended[0], /preview-row-[01]"|Ad a1|Ad a2/);
  assert.match(rows.appended[0], /Ad a3/);
  // Focus goes to the first new row, nowhere else; the page announces the count and not the rows.
  assert.equal(f.node('#preview-row-2').focused, 1);
  assert.equal(f.node('#preview-row-3').focused, 0);
  assert.equal(f.node('#preview-row-0').focused, 0);
  assert.equal(status.textContent, '2 more previews');
  assert.equal(f.node('#preview-load-more').attributes.get('aria-disabled'), 'false');
  // One more row is announced in the singular.
  f.click();
  f.calls[2].resolve(page([row('cr5', 'a5')], false));
  await tick();
  assert.equal(status.textContent, '1 more preview');
  assert.equal(f.node('#preview-row-4').focused, 1);
  assert.doesNotMatch(f.results.innerHTML, /preview-load-more/);
  assert.equal((f.results.innerHTML.match(/class="token-row"/g) ?? []).length, 5);
});

// F-L3-05: a Load more that failed (the cursor lives five minutes) replaced the list with the error, and the links just lost
// were good for hours or days. The rows stay, the error is told beside the button, and the reader can start again.
test('a failed Load more keeps the rows, tells the error beside the button and lets the reader start again', async () => {
  const f = fixture(),
    first = f.submit(),
    rows = f.node('#preview-rows');
  f.calls[0].resolve(page([row('cr1', 'a1'), row('cr2', 'a2')], true));
  await first;
  f.click();
  f.calls[1].reject(
    Object.assign(new Error('The preview cursor is invalid or expired; list the previews again without it.'), {}),
  );
  await tick();
  await tick();
  // The two rows are still there, the region was not written again, and nothing moved or was announced as rows.
  assert.equal((f.results.innerHTML.match(/class="token-row"/g) ?? []).length, 2);
  assert.equal(f.results.writes, 1);
  assert.equal(rows.appended.length, 0);
  assert.equal(
    f.node('#preview-more-error').textContent,
    'The preview cursor is invalid or expired; list the previews again without it.',
  );
  // The error is an alert, beside Load more, which can be pressed again; so can Start again.
  assert.match(f.results.innerHTML, /<p class="error" id="preview-more-error" role="alert"><\/p>/);
  assert.equal(f.node('#preview-restart').hidden, false);
  assert.equal(f.node('#preview-load-more').attributes.get('aria-disabled'), 'false');
  assert.equal(f.node('#preview-status').textContent, '');
  f.click();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].args.cursor, 'signed-cursor');
  assert.equal(f.node('#preview-more-error').textContent, '');
  assert.equal(f.node('#preview-restart').hidden, true);
  f.calls[2].reject(new Error('The platform is busy.'));
  await tick();
  await tick();
  assert.equal(f.node('#preview-more-error').textContent, 'The platform is busy.');
  // Start again lists the same selection from its first page, in place of the rows read so far.
  f.click('#preview-restart');
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].args.cursor, undefined);
  assert.equal(f.calls[3].args.account_id, '100');
  assert.deepEqual(f.calls[3].args.statuses, ['active']);
  f.calls[3].resolve(page([row('cr9', 'a9')], false));
  await tick();
  assert.equal(f.results.writes, 2);
  assert.doesNotMatch(f.results.innerHTML, /Ad a1|Ad a2|preview-load-more/);
  assert.match(f.results.innerHTML, /Ad a9/);
  assert.equal(f.node('#preview-status').textContent, '1 preview');
});

test('a failed first page still replaces the list with the error, and a stale failure does nothing', async () => {
  const f = fixture(),
    first = f.submit();
  f.calls[0].reject(new Error('The platform is busy.'));
  await assert.rejects(first, /busy/);
  assert.match(f.results.innerHTML, /No previews: The platform is busy\./);
  // A failure that arrives after the selection changed is not shown.
  const second = f.submit();
  f.form.listeners.get('change')();
  f.calls[1].reject(new Error('Too late.'));
  await second;
  assert.doesNotMatch(f.results.innerHTML, /Too late/);
});

// Design note 7: the page trusted the server for the scheme of every link it made an href of.
test('only an https link without credentials becomes a link, and a row left with none says so', async () => {
  const f = fixture(),
    first = f.submit();
  const links = [
    'javascript:alert(1)',
    'data:text/html,hello',
    'http://ads.snapchat.com/preview/x',
    'https://user:pw@ads.snapchat.com/preview/x',
    '//ads.snapchat.com/preview/x',
    '/preview/x',
    'https://',
    'https://ads.snapchat.com\\evil.example/x',
    'https://ads.snapchat.com/a b',
    42,
    null,
  ];
  f.calls[0].resolve(
    page(
      [row('bad', 'a1', links), row('good', 'a2', [...links, 'https://ads.snapchat.com/preview/ok?a=1&b=2'])],
      false,
    ),
  );
  await first;
  const html = f.results.innerHTML;
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/ads\.snapchat\.com\/preview\/ok\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /javascript:|data:text|http:\/\/|user:pw|evil\.example/);
  assert.match(html, /The platform returned no preview link for this ad\./);
});

test('a link or a name from the platform is escaped, not written as markup', async () => {
  const f = fixture(),
    first = f.submit();
  f.calls[0].resolve(
    page(
      [
        {
          ad_id: '1" onmouseover="x',
          name: '<img src=x onerror=alert(1)>',
          links: ['https://ads.snapchat.com/p?x="><script>alert(1)</script>'],
        },
      ],
      false,
    ),
  );
  await first;
  assert.doesNotMatch(f.results.innerHTML, /<img|<script|" onmouseover=/);
  assert.match(f.results.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
