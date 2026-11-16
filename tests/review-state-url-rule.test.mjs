import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewState, reviewStateHash, changedStateFields} from '../dist/src/review-state.js';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1, the safety net; lead review S2-2): the value-shape rule of the review
 * projection applies to the links a provider signs itself, and to no other URL. A provider signs its own asset, preview and
 * licence links anew on every read (TikTok's licence link carries a `ticket`, its CDN image a `x-expires` and
 * `x-signature`), so such a link is the same state however often it is read: a whole http(s) URL on a host the provider's
 * table declares (`signed-host:`), or under a field it declares (`signed-field:`), loses the query parameters that sign or
 * expire it (`ticket`, `signature`, `sig`, `token`, `expires`, `x-expires`, `x-signature`, `x-amz-*`, `x-goog-*`).
 * Everything else is configuration an advertiser wrote, and stays byte for byte: a landing page's or a tracking URL's
 * `token`, `ticket`, `sig` or `expires` is not a signature, and a change of it is a change the approver must see. The rule
 * only drops, and dropping twice drops nothing more, so a review saved before it existed is projected again at execute.
 * Synthetic values only.
 */
const table = Object.freeze([
  'stats',
  'signed-host:cdn.example',
  'signed-host:*.assets.example',
  'signed-field:preview_link',
]);
const norm = value => normalizeReviewState(value, table);
const hash = value => reviewStateHash(value, table);
const changed = (a, b) => changedStateFields(a, b, table);
// A link of the provider (a declared host) and a link of the advertiser (any other host).
const base = 'https://cdn.example/files/a.png';
const landing = 'https://shop.example/offer';

test('a rotating signing parameter of a provider link changes neither the state hash nor the changed fields, under any key and depth', () => {
  const state = ticket => ({
    licence: {link: 'https://cdn.example/pss/download?ticket=' + ticket},
    rows: [{image_url: base + '?x-expires=' + ticket + '&x-signature=' + ticket + '&v=2'}],
    deep: {a: {b: {c: ['https://img.assets.example/x?sig=' + ticket]}}},
  });
  assert.equal(hash(state('one')), hash(state('two')));
  assert.deepEqual(changed(state('one'), state('two')), []);
});

// The names the plan lists, each in the forms a URL may spell it: as is, upper case, capitalised and percent-escaped.
const signing = [
  'ticket',
  'signature',
  'sig',
  'token',
  'expires',
  'x-expires',
  // Not in the plan's list: TikTok's CDN spelling of the signature that goes with its x-expires (see the source's comment).
  'x-signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-algorithm',
  'x-amz-signedheaders',
  'x-goog-signature',
  'x-goog-credential',
  'x-goog-date',
  'x-goog-expires',
  'x-goog-algorithm',
  'x-goog-signedheaders',
];
const spellings = name => [
  ...new Set([
    name,
    name.toUpperCase(),
    name[0].toUpperCase() + name.slice(1),
    name.replace(/-/g, '%2D'),
    '%' + name.charCodeAt(0).toString(16) + name.slice(1),
  ]),
];

test('on a link of the provider every signing and expiry parameter is dropped, in any case, escaped or not', () => {
  for (const name of signing)
    for (const spelled of spellings(name)) {
      assert.equal(norm(base + '?' + spelled + '=SECRET'), base, spelled + ' alone');
      assert.equal(norm(base + '?a=1&' + spelled + '=SECRET'), base + '?a=1', spelled + ' last');
      assert.equal(norm(base + '?' + spelled + '=SECRET&a=1'), base + '?a=1', spelled + ' first');
      assert.equal(norm(base + '?a=1&' + spelled + '=SECRET&b=2'), base + '?a=1&b=2', spelled + ' between');
    }
});

test('a landing page or a tracking URL of the advertiser keeps every parameter, the signing names included (S2-2)', () => {
  for (const name of signing)
    for (const spelled of spellings(name)) {
      const url = landing + '?utm_source=amcp&' + spelled + '=AFF1';
      assert.equal(norm(url), url, spelled);
      // A change of its value is a change: the hash differs, the path is named, and the value is in the state.
      const other = url.replace('AFF1', 'AFF2');
      assert.notEqual(hash({landing_page_url: url}), hash({landing_page_url: other}), spelled);
      assert.deepEqual(changed({landing_page_url: url}, {landing_page_url: other}), ['$["landing_page_url"]'], spelled);
      assert.match(JSON.stringify(norm({landing_page_url: url})), /AFF1/, spelled);
    }
  // Removing the parameter altogether is a change as well.
  const withToken = landing + '?utm_source=amcp&token=AFF1';
  assert.deepEqual(changed({u: withToken}, {u: landing + '?utm_source=amcp'}), ['$["u"]']);
});

test('only the hosts a table declares are the provider’s: a lookalike host is the advertiser’s', () => {
  const signed = '?ticket=1&a=2';
  // Declared: the exact host (case-insensitive, any port, any path) and every host below a declared domain.
  for (const url of [
    'https://cdn.example/a' + signed,
    'https://CDN.Example/a' + signed,
    'http://cdn.example:8443/a' + signed,
    'https://a.assets.example/a' + signed,
    'https://deep.a.assets.example/a' + signed,
  ])
    assert.equal(norm(url).includes('ticket'), false, url);
  // Not declared: another domain, a prefix or suffix of a declared one, the declared domain of a wildcard itself, a host
  // that only holds the name in its userinfo or its path.
  for (const url of [
    'https://cdn.example.evil.test/a' + signed,
    'https://evilcdn.example/a' + signed,
    'https://sub.cdn.example/a' + signed,
    'https://assets.example/a' + signed,
    'https://notassets.example/a' + signed,
    'https://cdn.example@evil.test/a' + signed,
    'https://evil.test/cdn.example/a' + signed,
    'https://evil.test/a' + signed + '&host=cdn.example',
    'https://cdn.example./a' + signed,
  ])
    assert.equal(norm(url), url, url);
});

test('a field a table declares holds links of the provider on any host, in a list or a record under it', () => {
  const link = 'https://anywhere.example/p?ticket=1&a=2';
  assert.deepEqual(norm({preview_link: link}), {preview_link: 'https://anywhere.example/p?a=2'});
  assert.deepEqual(norm({previewLink: link}), {previewLink: 'https://anywhere.example/p?a=2'});
  assert.deepEqual(norm({preview_link: [link, link]}), {
    preview_link: ['https://anywhere.example/p?a=2', 'https://anywhere.example/p?a=2'],
  });
  assert.deepEqual(norm({preview_link: {url: link}}), {preview_link: {url: 'https://anywhere.example/p?a=2'}});
  // A field the table does not declare is not one, wherever it stands.
  assert.deepEqual(norm({link: link, other: {preview: link}}), {link, other: {preview: link}});
});

test('no table, and a table that declares no link, keep every URL: nothing is the provider’s that it did not say', () => {
  const state = {a: base + '?ticket=1&x-signature=2', b: landing + '?token=3'};
  assert.deepEqual(normalizeReviewState(state, []), state);
  assert.deepEqual(normalizeReviewState(state, ['stats']), state);
  assert.deepEqual(normalizeReviewState(state, undefined), state);
});

test('the table’s link entries are no field names: they drop no field and a field of that name is kept', () => {
  assert.deepEqual(norm({stats: 1, id: 2, 'signed-host:cdn.example': 3, 'signed-field:preview_link': 4}), {
    id: 2,
    'signed-field:preview_link': 4,
    'signed-host:cdn.example': 3,
  });
});

test('a landing page UTM and every other parameter is configuration: it stays, in its order and spelling, on a provider link too', () => {
  const link = base + '?utm_source=news%20letter&utm_campaign=BF26&ref=a+b&empty=&flag';
  assert.equal(norm(link), link);
  assert.notEqual(hash({url: link}), hash({url: link.replace('BF26', 'BF27')}));
  // Near misses of a signing name are other parameters.
  for (const other of [
    'tickets',
    'my-token',
    'signatures',
    'sigs',
    'expire',
    'x-amz',
    'x-goog',
    'xx-amz-date',
    'key',
  ]) {
    const url = base + '?' + other + '=value';
    assert.equal(norm(url), url, other);
  }
  // A signing name inside another parameter's value is part of that value.
  assert.equal(
    norm('https://cdn.example/go?next=https%3A%2F%2Fa.example%2F%3Fticket%3D1&a=1'),
    'https://cdn.example/go?next=https%3A%2F%2Fa.example%2F%3Fticket%3D1&a=1',
  );
});

test('only a whole http(s) URL is read: other text, other schemes and object keys are untouched', () => {
  for (const text of [
    'support ticket=12345',
    'See https://cdn.example/a?ticket=1 for details',
    'ftp://cdn.example/a?ticket=1',
    'data:text/plain,a?ticket=1',
    '//cdn.example/a?ticket=1',
    'ticket=1&sig=2',
    '?ticket=1',
    '',
  ])
    assert.equal(norm(text), text, text);
  for (const scheme of ['http', 'https', 'HTTP', 'Https'])
    assert.equal(norm(scheme + '://cdn.example/a?ticket=1&b=2'), scheme + '://cdn.example/a?b=2', scheme);
  // Keys, numbers, booleans and null are not strings to read.
  assert.deepEqual(norm({'https://cdn.example/?ticket=1': 1, n: 5, f: false, z: null}), {
    'https://cdn.example/?ticket=1': 1,
    f: false,
    n: 5,
    z: null,
  });
});

test('the path and the fragment stay, and a query that held only signing parameters leaves no question mark', () => {
  assert.equal(norm('https://cdn.example/p/q?ticket=1#frag'), 'https://cdn.example/p/q#frag');
  assert.equal(norm('https://cdn.example/p?a=1&ticket=2#frag?ticket=3'), 'https://cdn.example/p?a=1#frag?ticket=3');
  assert.equal(norm('https://cdn.example/?sig=1&token=2'), 'https://cdn.example/');
  assert.equal(norm('https://cdn.example?sig=1'), 'https://cdn.example');
  assert.equal(norm('https://cdn.example/p#ticket=1'), 'https://cdn.example/p#ticket=1');
});

test('a real change beside a rotating signature still changes the hash and names the path', () => {
  const state = (ticket, name) => ({row: {name, link: 'https://cdn.example/d?ticket=' + ticket + '&id=7'}});
  assert.notEqual(hash(state('one', 'A')), hash(state('two', 'B')));
  assert.deepEqual(changed(state('one', 'A'), state('two', 'B')), ['$["row"]["name"]']);
  // The identifier beside the ticket is configuration: a different one is a change.
  const other = {row: {name: 'A', link: 'https://cdn.example/d?ticket=one&id=8'}};
  assert.notEqual(hash(state('one', 'A')), hash(other));
  assert.deepEqual(changed(state('one', 'A'), other), ['$["row"]["link"]']);
});

test('a state with no URL in it hashes as it did', () => {
  // sha256 of the stable text {"a":1,"b":[true,null,"x"]}, recorded before the rule existed.
  assert.equal(hash({b: [true, null, 'x'], a: 1}), 'eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1');
});

// A small seeded generator: the same states on every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const names = [...signing, 'utm_source', 'utm_campaign', 'id', 'q', 'ticket2', 'my-token', 'Ticket', 'X-Amz-Date'];
// Hosts of the provider and of anyone else, so the rule is read on both sides of its scope.
const hosts = ['cdn.example', 'a.assets.example', 'shop.example', 'assets.example', 'h3.example'];
function randomUrl(r) {
  const pairs = Array.from({length: Math.floor(r() * 5)}, () => {
    const name = names[Math.floor(r() * names.length)];
    return r() < 0.1 ? name : name + '=' + Math.floor(r() * 1e6).toString(36);
  });
  const scheme = r() < 0.8 ? 'https' : 'http';
  return (
    scheme +
    '://' +
    hosts[Math.floor(r() * hosts.length)] +
    '/p' +
    (pairs.length ? '?' + pairs.join('&') : '') +
    (r() < 0.3 ? '#f' : '')
  );
}
function randomState(r, depth = 0) {
  const roll = r();
  if (depth > 3 || roll < 0.35)
    return r() < 0.5 ? randomUrl(r) : ['text', 'ticket=1', 7, true, null][Math.floor(r() * 5)];
  if (roll < 0.6) return Array.from({length: Math.floor(r() * 4)}, () => randomState(r, depth + 1));
  return Object.fromEntries(
    Array.from({length: Math.floor(r() * 4)}, (_, i) => [
      // Some keys are a field the table declares, so the rule is read under it as well.
      r() < 0.3 ? 'preview_link' : 'k' + i + Math.floor(r() * 3),
      randomState(r, depth + 1),
    ]),
  );
}
/** `out` is `input` with some `&`-separated query pairs of its URL strings deleted, and nothing else changed. */
function isReduction(out, input) {
  if (typeof input === 'string') {
    if (out === input) return true;
    if (typeof out !== 'string') return false;
    const split = text => {
      const [beforeFragment, ...fragment] = text.split('#');
      const [path, ...query] = beforeFragment.split('?');
      return {
        path,
        query: query.length ? query.join('?').split('&') : [],
        fragment: fragment.join('#'),
        hasFragment: fragment.length > 0,
      };
    };
    const a = split(out),
      b = split(input);
    if (a.path !== b.path || a.fragment !== b.fragment || a.hasFragment !== b.hasFragment) return false;
    let at = 0;
    for (const pair of b.query) if (at < a.query.length && a.query[at] === pair) at++;
    return at === a.query.length;
  }
  if (Array.isArray(input))
    return Array.isArray(out) && out.length === input.length && out.every((v, i) => isReduction(v, input[i]));
  if (input && typeof input === 'object')
    return (
      !!out &&
      typeof out === 'object' &&
      !Array.isArray(out) &&
      Object.keys(out).every(k => Object.hasOwn(input, k) && isReduction(out[k], input[k]))
    );
  return out === input;
}

test('property: the projection is idempotent, so a saved review projects again to what it was', () => {
  const r = seeded(20261116);
  for (let i = 0; i < 500; i++) {
    const state = randomState(r),
      once = norm(state);
    assert.deepEqual(norm(once), once, JSON.stringify(state));
    assert.equal(hash(once), hash(state));
  }
});

test('property: the projection is monotone, it only drops query parameters', () => {
  const r = seeded(7_161_126);
  let changedStates = 0;
  for (let i = 0; i < 500; i++) {
    const state = randomState(r),
      out = norm(state);
    assert.ok(isReduction(out, state), JSON.stringify({state, out}));
    if (JSON.stringify(out) !== JSON.stringify(state)) changedStates++;
  }
  assert.ok(changedStates > 50, 'the generator reaches the rule (' + changedStates + ' of 500)');
});

test('property: a URL on a host that is not the provider’s is never changed by the rule, outside a field it declares', () => {
  const r = seeded(1_126_716);
  let checked = 0;
  for (let i = 0; i < 500; i++) {
    const url = randomUrl(r),
      host = /^https?:\/\/([^/]+)/.exec(url)[1];
    if (['cdn.example', 'a.assets.example'].includes(host)) continue;
    checked++;
    assert.equal(norm(url), url, url);
    assert.equal(norm({k: url}).k, url, url);
    assert.deepEqual(norm({landing_page_url: [url]}), {landing_page_url: [url]}, url);
  }
  assert.ok(checked > 100, 'the generator reaches the hosts of others (' + checked + ' of 500)');
});
