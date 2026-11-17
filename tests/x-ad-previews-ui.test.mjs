// Package r12-xpreview, item 3: the Preview your ads page offers X accounts and shows an X entry the way it shows the others: a
// row with its title, the IDs that identify it, the expiry the platform states (X states none) and its links, or the reason it has
// none, with Arabic for every sentence the page adds. The panel's own script runs in a VM with the shell's markup helpers
// (web/localization.js), as tests/ad-previews-paging-ui.test.mjs runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {loaderFiles, chunksWith} from '../tools/locale-chunks.mjs';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  loaded = new Set(
    [...chunksWith('ad-previews.js', loaderFiles().dependencies)].flatMap(name =>
      Object.keys(JSON.parse(readFileSync('web/locales/ar/' + name + '.json', 'utf8'))),
    ),
  ),
  arabic = /\p{Script=Arabic}/u;
const tweet = n => '19000000000000' + String(n).padStart(5, '0'),
  link = n => 'https://ton.twimg.com/ads-manager/tweet-preview/index.html?data=H4sISYNTHETIC' + tweet(n) + '%2BAbC%3D',
  expires = 'X states no expiry for this preview link.';

/** The panel's script in a VM, with a fake page and the accounts offered (X first, Snapchat second). */
function fixture(locale = 'en') {
  const nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) {
      const self = {
        textContent: '',
        hidden: false,
        listeners: new Map(),
        _html: '',
        addEventListener(name, fn) {
          this.listeners.set(name, fn);
        },
        setAttribute() {},
        insertAdjacentHTML(position, markup) {
          assert.equal(position, 'beforeend');
          this._html += markup;
        },
        focus() {},
        get innerHTML() {
          return this._html;
        },
        set innerHTML(markup) {
          this._html = markup;
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
  // A row's detail line is an element of the markup the page wrote, as it is in a browser: a lookup of one the markup does not hold
  // finds nothing, so a write to a line the page never drew cannot pass for the update of a row.
  const drawn = id =>
    [node('#preview-results')._html, node('#preview-rows')._html].some(m => m.includes('id="' + id + '"'));
  const context = createContext({
    document: {addEventListener() {}},
    platforms: [
      {gateway: 'x_ads_native_action', connections: [{id: 'login-x', enabled: true, accounts: ['acct1']}]},
      {gateway: 'snapchat_native_action', connections: [{id: 'login-s', enabled: true, accounts: ['100']}]},
    ],
    accountLabel: (_platform, _connection, account) => 'Account ' + account,
    $: id => (id.startsWith('#preview-detail-') && !drawn(id.slice(1)) ? null : node(id)),
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
    catalog,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar')
    new Script("uiLocale = 'ar'; uiMessages = new Map(Object.entries(catalog));").runInContext(context);
  new Script(readFileSync('web/ad-previews.js', 'utf8')).runInContext(context);
  new Script('bindAdPreviews()').runInContext(context);
  const choose = index => {
    form.elements.target.value = String(index);
    form.listeners.get('change')();
  };
  return {
    form,
    node,
    calls,
    choose,
    results: node('#preview-results'),
    submit: () => submit(form),
    loadMore: () =>
      node('#preview-results').listeners.get('click')({target: {closest: wanted => wanted === '#preview-load-more'}}),
    panel: () => new Script('adPreviewsPanel()').runInContext(context),
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = {
  previews: [
    {
      ad_id: tweet(1),
      name: null,
      tweet_id: tweet(1),
      promoted_tweet_ids: ['pt1', 'pt2'],
      links: [link(1)],
      expires,
    },
    {ad_id: tweet(90), name: 'Dark launch', tweet_id: tweet(90), promoted_tweet_ids: [], links: [link(90)], expires},
    {
      ad_id: tweet(3),
      name: null,
      tweet_id: tweet(3),
      promoted_tweet_ids: ['pt3'],
      links: [],
      reason: 'not_returned',
      note: 'X returned no preview for this Tweet.',
    },
  ],
  meaning: 'Synthetic notice.',
  has_more: false,
  next_cursor: null,
  // A Tweet ID that is not among the account's dark Tweets, with the sentence the tool gives for it (review S4-5).
  not_found: [tweet(77)],
  not_found_reason: 'Not among this account’s dark Tweets; use its promoted Tweet ID.',
};
const rows = html => [...html.matchAll(/<div class="token-row"[\s\S]*?<\/div><\/div>/g)].map(m => m[0]);

test('the page offers an X account as x_ads, sends no Meta placement for it, and says what X takes as ad IDs only for X', async () => {
  const f = fixture();
  // The panel lists the X account first, then Snapchat's, so the preview form can address either.
  const panel = f.panel();
  assert.match(panel, /<option value="0" [^>]*>Account acct1<\/option>/);
  assert.match(panel, /<option value="1" [^>]*>Account 100<\/option>/);
  // X is the chosen account: its note is shown, and the Meta placement stays hidden.
  assert.equal(f.node('#preview-x-note').hidden, false);
  assert.equal(f.node('#preview-format').hidden, true);
  const first = f.submit();
  assert.deepEqual(f.calls[0].args, {
    platform: 'x_ads',
    account_id: 'acct1',
    connection_id: 'login-x',
    statuses: ['active'],
  });
  f.calls[0].resolve({previews: [], meaning: 'Synthetic notice.', has_more: false});
  await first;
  // Another platform hides the note again; named IDs go to X as the person typed them.
  f.choose(1);
  assert.equal(f.node('#preview-x-note').hidden, true);
  f.choose(0);
  assert.equal(f.node('#preview-x-note').hidden, false);
  f.form.elements.ad_ids.value = ' pt1, ' + tweet(90) + ' ';
  const named = f.submit();
  assert.deepEqual(f.calls[1].args.ad_ids, ['pt1', tweet(90)]);
  f.calls[1].resolve({previews: [], meaning: 'Synthetic notice.', has_more: false});
  await named;
  // The note is in the panel, as a hint beside the IDs field, and not shown until X is chosen.
  assert.match(panel, /id="preview-x-note"/);
  assert.match(panel, /For X, enter promoted Tweet IDs or the ID of a dark Tweet\./);
});

test('an X entry shows its Tweet, the promoted Tweets that share it, the validated link and the expiry X does not state', async () => {
  const f = fixture(),
    pending = f.submit();
  f.calls[0].resolve(answer);
  await pending;
  const [promoted, dark, missing] = rows(f.results.innerHTML);
  // A Tweet promoted twice: its Tweet, both promoted-Tweet IDs, the expiry sentence and the link, opened in a new tab.
  assert.match(promoted, /<strong>Untitled<\/strong>/);
  assert.match(
    promoted,
    new RegExp('Tweet ' + tweet(1) + ' · Promoted Tweets pt1, pt2 · X states no expiry for this preview link\\.'),
  );
  assert.match(
    promoted,
    /<a class="button small" href="https:\/\/ton\.twimg\.com\/ads-manager\/tweet-preview\/index\.html\?data=[^"]+" target="_blank" rel="noopener noreferrer"/,
  );
  assert.doesNotMatch(promoted, /preview-links"><span/);
  // A dark Tweet has its name and its Tweet, and no promoted Tweet.
  assert.match(dark, /<strong>Dark launch<\/strong>/);
  assert.match(dark, new RegExp('Tweet ' + tweet(90) + ' · X states no expiry for this preview link\\.'));
  assert.doesNotMatch(dark, /Promoted Tweet/);
  // A promoted Tweet X gave no preview for: one promoted Tweet is the singular, and the page says why there is no link.
  assert.match(missing, new RegExp('Tweet ' + tweet(3) + ' · Promoted Tweet pt3'));
  assert.doesNotMatch(missing, /Promoted Tweets|<a /);
  assert.match(missing, /X returned no preview for this Tweet\./);
  // The IDs not found, and the platform’s notice, follow the rows.
  assert.match(
    f.results.innerHTML,
    new RegExp('Not found: ' + tweet(77) + '\\. Not among this account’s dark Tweets; use its promoted Tweet ID\\.'),
  );
  assert.match(f.results.innerHTML, /Synthetic notice\./);
  // The page opens https links only: a value that is not one never becomes a link.
  const hostile = f.submit();
  f.calls[1].resolve({
    previews: [
      {...answer.previews[0], links: ['javascript:alert(1)', 'http://ton.twimg.com/x', 'https://ton.twimg.com/ok']},
    ],
    meaning: 'Synthetic notice.',
    has_more: false,
  });
  await hostile;
  assert.doesNotMatch(f.results.innerHTML, /javascript:|http:\/\//);
  assert.match(f.results.innerHTML, /href="https:\/\/ton\.twimg\.com\/ok"/);
});

test('every sentence the page adds for X has Arabic in the chunks the page loads, with its slots kept, and the page reads in Arabic', async () => {
  const added = [
    'Tweet {tweet}',
    'Promoted Tweet {promoted}',
    'Promoted Tweets {promoted}',
    'For X, enter promoted Tweet IDs or the ID of a dark Tweet.',
  ];
  for (const message of added) {
    assert.ok(Object.hasOwn(catalog, message), 'Arabic for: ' + message);
    assert.ok(loaded.has(message), 'the page loads: ' + message);
    assert.match(catalog[message], arabic, message);
    assert.deepEqual(catalog[message].match(/\{\w+\}/g) ?? [], message.match(/\{\w+\}/g) ?? [], message + ': slots');
  }
  // The sentences X's answers carry reach the page in Arabic too (tests/ad-previews-localization.test.mjs collects them from the tool).
  for (const message of [
    expires,
    'X returned no preview for this Tweet.',
    'X returned a preview that AMCP does not accept as a safe link, so none is shown.',
    'Not among this account’s dark Tweets; use its promoted Tweet ID.',
  ])
    assert.ok(Object.hasOwn(catalog, message) && catalog[message].match(arabic), message);
  const f = fixture('ar'),
    pending = f.submit();
  f.calls[0].resolve(answer);
  await pending;
  const [promoted, dark, missing] = rows(f.results.innerHTML);
  assert.ok(promoted.includes(catalog['Promoted Tweets {promoted}'].replace('{promoted}', 'pt1, pt2')), promoted);
  assert.ok(promoted.includes(catalog['Tweet {tweet}'].replace('{tweet}', tweet(1))), promoted);
  assert.ok(promoted.includes(catalog[expires]), 'the expiry sentence is in Arabic');
  assert.ok(dark.includes(catalog['Tweet {tweet}'].replace('{tweet}', tweet(90))), dark);
  assert.ok(missing.includes(catalog['Promoted Tweet {promoted}'].replace('{promoted}', 'pt3')), missing);
  assert.ok(missing.includes(catalog['X returned no preview for this Tweet.']), missing);
  // The IDs not found keep their form, and the reason the tool gives for a Tweet ID is read in Arabic.
  assert.ok(f.results.innerHTML.includes(catalog['Not found:'] + ' ' + tweet(77)), 'the Tweet ID not found');
  assert.ok(
    f.results.innerHTML.includes(catalog['Not among this account’s dark Tweets; use its promoted Tweet ID.']),
    'the reason is in Arabic',
  );
  // Names and IDs stay as X gave them.
  assert.ok(dark.includes('Dark launch') && promoted.includes(tweet(1)));
});

// Review S4-1. A Tweet that is promoted twice can have its two promoted Tweets in two pages of the account's list, and an entry is
// a Tweet, so "Load more" can bring an entry for a Tweet whose row is already on the page. The page used to drop that entry, and the
// promoted Tweets it named with it. The row stands for the Tweet, so those promoted Tweets join it; only a Tweet not shown is a row.
test('Load more merges the promoted Tweets of a later entry for a Tweet already shown into its row, and adds only the Tweets not shown', async () => {
  const entry = (n, promoted) => ({
      ad_id: tweet(n),
      name: null,
      tweet_id: tweet(n),
      promoted_tweet_ids: promoted,
      links: [link(n)],
      expires,
    }),
    page = (previews, more) => ({
      previews,
      meaning: 'Synthetic notice.',
      has_more: more,
      next_cursor: more ? 'cursor' : null,
    });
  const f = fixture(),
    first = f.submit();
  // The first page holds one Tweet twice (the tool says each Tweet once in a call, but the page does not rely on it): the two
  // entries are merged the same way.
  f.calls[0].resolve(page([entry(1, ['pt1']), entry(2, ['pt2']), entry(2, ['pt5'])], true));
  await first;
  const [one, two, ...others] = rows(f.results.innerHTML);
  assert.equal(others.length, 0);
  assert.match(one, new RegExp('Tweet ' + tweet(1) + ' · Promoted Tweet pt1 · '));
  assert.doesNotMatch(one, /Promoted Tweets/);
  assert.match(two, new RegExp('Tweet ' + tweet(2) + ' · Promoted Tweets pt2, pt5 · '));
  // The second page: the first Tweet again with a promoted Tweet the first page lacked (and one it had), and a Tweet not shown.
  f.loadMore();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve(page([entry(1, ['pt3', 'pt1']), entry(4, ['pt4'])], true));
  await tick();
  // The row of the first Tweet now names both promoted Tweets, each once, in the order they were read.
  assert.equal(
    f.node('#preview-detail-0').textContent,
    'Tweet ' + tweet(1) + ' · Promoted Tweets pt1, pt3 · X states no expiry for this preview link.',
  );
  // The other row is as it was written. The Tweet not shown is one new row after the two, and the first Tweet has no second row.
  assert.equal(f.node('#preview-detail-1').textContent, '');
  const added = rows(f.node('#preview-rows')._html);
  assert.equal(added.length, 1);
  assert.match(added[0], new RegExp('id="preview-row-2"[\\s\\S]*Tweet ' + tweet(4) + ' · Promoted Tweet pt4'));
  assert.doesNotMatch(f.node('#preview-rows')._html, new RegExp(tweet(1)));
  assert.equal(f.node('#preview-status').textContent, '1 more preview');
  // A third page whose entry names only what its row already shows adds no row and leaves the row alone.
  f.loadMore();
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(page([entry(2, ['pt5', 'pt2'])], false));
  await tick();
  assert.equal(f.node('#preview-detail-1').textContent, '');
  assert.equal(rows(f.node('#preview-rows')._html).length, 1);
  assert.equal(f.node('#preview-detail-0').textContent.includes('pt1, pt3'), true);
});
