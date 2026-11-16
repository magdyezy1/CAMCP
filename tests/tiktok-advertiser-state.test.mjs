import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeSnapshot, reviewStateHash, changedStateFields} from '../dist/src/review-state.js';
import {advertiserWorld, fullAdvertiserRow, identityFields, answer} from './helpers/tiktok-advertiser-noise.mjs';

/**
 * T1, Round 2.5 (package r25-m0-t1): the advertiser row a TikTok review keeps. TikTok's advertiser info answer carries a
 * signed licence link whose ticket rotates on every read, a balance that moves with spend, the creation time and the
 * advertiser's contact record. A review hashes the row at prepare and again at execute, so every TikTok create failed
 * with STATE_CHANGED (White Friday report). A review keeps only the seven identity fields (Q15, owner 2026-11-15):
 * advertiser_id, name, status, role, currency, timezone and country. Everything here runs the real compiled modules on
 * invented data.
 */
const world = advertiserWorld();
const read = {
  gateway: 'tiktok_native_action',
  accountId: world.id,
  action: 'AMCP_STATE_READ',
  method: 'GET',
  path: '/v1.3/advertiser/info/',
  query: {advertiser_ids: [world.id]},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  evidence: 'TEST',
  warnings: [],
};
/** The state a review keeps of one advertiser info answer holding `row`, as prepare and execute both keep it. */
const kept = row => normalizeSnapshot(read, answer({list: [row]}));
const hashOf = row => reviewStateHash([kept(row)]);
const rowPath = field => '$[0]["data"]["list"][0]["' + field + '"]';
const base = fullAdvertiserRow(world, 1);

test('a review keeps the seven identity fields of the advertiser row and nothing else of it', () => {
  assert.deepEqual(kept(base), {
    data: {
      list: [
        {
          advertiser_id: '9000000000000000001',
          name: 'Synthetic Advertiser | Test Market',
          status: 'STATUS_ENABLE',
          role: 'ROLE_ADVERTISER',
          currency: 'USD',
          timezone: 'Asia/Riyadh',
          country: 'SA',
        },
      ],
    },
  });
});

const harmless = {
  'a rotated licence ticket': {license_url: 'https://ads.tiktok.com/pssresource/internal/download?ticket=another'},
  'a balance that fell with spend': {balance: 12.5},
  'a balance given as text': {balance: '12.50'},
  'a different creation time': {create_time: 1},
  'a changed contact record': {
    email: 'other@example.test',
    phone_number: '+10005550199',
    cellphone_number: '+10005550198',
    contacter: 'Another Person',
    address: 'Elsewhere',
    company: 'Another Company',
  },
  'a field TikTok adds later': {some_future_field: {nested: ['x']}},
};
for (const [what, change] of Object.entries(harmless))
  test(what + ' leaves the reviewed state and its hash as they were', () => {
    assert.equal(hashOf({...base, ...change}), hashOf(base));
    assert.deepEqual(changedStateFields([kept(base)], [kept({...base, ...change})]), []);
  });

test('an advertiser without a licence file reviews the same state as one with it', () => {
  const {license_url: _licence, ...without} = base;
  assert.equal(hashOf(without), hashOf(base));
});

for (const field of identityFields)
  test('a changed ' + field + ' still changes the reviewed state and names that field', () => {
    const other = {advertiser_id: '9000000000000000002', country: 'AE'}[field] ?? 'Changed ' + field;
    assert.notEqual(hashOf({...base, [field]: other}), hashOf(base));
    assert.deepEqual(changedStateFields([kept(base)], [kept({...base, [field]: other})]), [rowPath(field)]);
  });

test('a saved review that kept the whole row and a fresh narrowed read keep the same state', () => {
  // A review prepared before this change saved the whole row; execute reads it again, narrowed or not.
  const saved = {data: {list: [fullAdvertiserRow(world, 1)]}},
    freshNarrow = answer({list: [Object.fromEntries(identityFields.map(f => [f, base[f]]))]}),
    freshWhole = answer({list: [fullAdvertiserRow(world, 9)]});
  assert.deepEqual(normalizeSnapshot(read, saved), normalizeSnapshot(read, freshNarrow));
  assert.deepEqual(normalizeSnapshot(read, saved), normalizeSnapshot(read, freshWhole));
});

/**
 * A review's state is hashed in two shapes. A write review keeps the array of its reads' states, so a changed path starts
 * $[0]; the amcp_media upload keeps the state of its one read, so a path starts $["data"]. The review-friction baseline
 * of production shows both for the licence link and the balance (T1). The projection is one for both, and so is the
 * projection again of a review saved before this change, which executes against a fresh read.
 */
const shapes = [
  {
    shape: 'array-wrapped, as a write review keeps it',
    prefix: '$[0]',
    state: row => [kept(row)],
    // write-review.ts reprojects each saved read's state by its read: review.state.map(...)
    reproject: saved => [saved].map(v => normalizeSnapshot(read, v)),
  },
  {
    shape: 'plain, as the media upload keeps it',
    prefix: '$',
    state: row => kept(row),
    // media-upload.ts reprojects the one saved state: normalizeSnapshot(p.read, review.state)
    reproject: saved => normalizeSnapshot(read, saved),
  },
];
for (const {shape, prefix, state, reproject} of shapes) {
  test('(' + shape + ') the noise changes neither the hash nor a path of the state', () => {
    for (const [what, change] of Object.entries(harmless)) {
      assert.equal(reviewStateHash(state({...base, ...change})), reviewStateHash(state(base)), what);
      assert.deepEqual(changedStateFields(state(base), state({...base, ...change})), [], what);
    }
  });
  test('(' + shape + ') a changed currency is the only path it names, beside the noise', () => {
    const noisy = {...base, ...harmless['a rotated licence ticket'], balance: 1, currency: 'EUR'};
    assert.deepEqual(changedStateFields(state(base), state(noisy)), [prefix + '["data"]["list"][0]["currency"]']);
  });
  test('(' + shape + ') a review saved with the whole row projects again to the state of a fresh read', () => {
    const saved = {data: {list: [fullAdvertiserRow(world, 1)]}},
      fresh = {...base, balance: 1, create_time: 7, license_url: 'https://ads.tiktok.com/x?ticket=later'};
    assert.deepEqual(reproject(saved), state(fresh));
    assert.equal(reviewStateHash(reproject(saved)), reviewStateHash(state(fresh)));
    assert.deepEqual(changedStateFields(reproject(saved), state({...fresh, currency: 'EUR'})), [
      prefix + '["data"]["list"][0]["currency"]',
    ]);
  });
}

test('a response with no list, an empty list or a row that is not a record is kept as it is', () => {
  assert.deepEqual(normalizeSnapshot(read, {code: 0, data: {}}), {code: 0, data: {}});
  assert.deepEqual(normalizeSnapshot(read, answer({list: []})), {data: {list: []}});
  assert.deepEqual(normalizeSnapshot(read, answer({list: [null, 'text']})), {data: {list: [null, 'text']}});
});

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
function generator(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (next, items) => items[Math.floor(next() * items.length)];
const scalar = next =>
  pick(next, ['A', 'B', 'STATUS_ENABLE', 'USD', 'x'.repeat(1 + Math.floor(next() * 5)), 7, 0, true, null]);
const value = (next, depth = 0) =>
  next() < 0.5 || depth > 1
    ? scalar(next)
    : next() < 0.5
      ? Array.from({length: Math.floor(next() * 3)}, () => value(next, depth + 1))
      : Object.fromEntries(Array.from({length: Math.floor(next() * 3)}, (_, i) => ['k' + i, value(next, depth + 1)]));
/** A row with a random subset of the identity fields, random scalars in them, and random other fields of any shape. */
function randomRow(next) {
  const row = {};
  for (const f of identityFields) if (next() < 0.8) row[f] = scalar(next);
  for (let i = Math.floor(next() * 8); i > 0; i--) row['field_' + Math.floor(next() * 40)] = value(next);
  if (next() < 0.5) row.license_url = 'https://ads.tiktok.com/pssresource/internal/download?ticket=' + next();
  if (next() < 0.5) row.balance = next() * 1000;
  return row;
}

test('the projection is idempotent and only drops fields (property, 400 random rows)', () => {
  const next = generator(20261115);
  for (let i = 0; i < 400; i++) {
    const row = randomRow(next),
      once = kept(row),
      twice = normalizeSnapshot(read, once);
    assert.deepEqual(twice, once, 'projecting twice changed row ' + JSON.stringify(row));
    const [projected] = once.data.list;
    for (const [key, field] of Object.entries(projected)) {
      assert.ok(identityFields.includes(key), key + ' is not one of the seven identity fields');
      assert.deepEqual(field, row[key], key + ' was changed, not only kept');
    }
    for (const f of identityFields)
      assert.equal(Object.hasOwn(projected, f), Object.hasOwn(row, f), f + ' was dropped or invented');
  }
});

test('only the identity fields decide the reviewed state (property, 400 random rows)', () => {
  const next = generator(7);
  for (let i = 0; i < 400; i++) {
    const row = randomRow(next),
      noisy = {
        ...row,
        license_url: 'https://ads.tiktok.com/x?ticket=' + next(),
        balance: next(),
        ['field_' + i]: value(next),
      };
    assert.equal(hashOf(noisy), hashOf(row), 'noise changed the state of ' + JSON.stringify(row));
    const f = pick(next, identityFields),
      changed = {...row, [f]: Object.hasOwn(row, f) ? [String(row[f]), 'changed'] : 'added'};
    assert.notEqual(hashOf(changed), hashOf(row), 'a change of ' + f + ' went unseen in ' + JSON.stringify(row));
    assert.deepEqual(changedStateFields([kept(row)], [kept(changed)]), [rowPath(f)], f);
  }
});

/**
 * The lint: every advertiser info read in src asks TikTok for the fields it needs, so a new site cannot bring the whole
 * row (the licence link, the balance and the contact record) back into a review. Two rules, both over the code with
 * its comments blanked:
 *  - an object that names `advertiser_ids`, the query of that read, also names `fields`;
 *  - the route itself is written only where it is built or compared: the shared read (tiktok-advertiser-state.ts), the
 *    adapter's scope check and readiness read, and the two reads that already name their own `fields` (the change-log
 *    review reads four of them and reduces the answer itself; the report job reads the currency and time zone).
 */
const blank = text =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\w'"`])\/\/[^\n]*/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
function enclosingObject(text, index) {
  let depth = 0,
    start = -1;
  for (let i = index - 1; i >= 0 && start < 0; i--)
    if (text[i] === '}') depth++;
    else if (text[i] === '{') depth ? depth-- : (start = i);
  if (start < 0) return '';
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}
const sources = () =>
  ['src', 'server'].flatMap(dir =>
    fs
      .readdirSync(new URL('../' + dir + '/', import.meta.url))
      .filter(f => f.endsWith('.ts'))
      .sort()
      .map(f => ({
        file: dir + '/' + f,
        code: blank(fs.readFileSync(new URL('../' + dir + '/' + f, import.meta.url), 'utf8')),
      })),
  );

test('lint: every object that names advertiser_ids also names fields', () => {
  const unnamed = [];
  for (const {file, code} of sources())
    for (const m of code.matchAll(/(?<![.\w'"`])advertiser_ids(?![\w'"`])\s*(?=[:,}])/g))
      if (!/\bfields\b/.test(enclosingObject(code, m.index))) unnamed.push(file + ':' + lineOf(code, m.index));
  // r25-m1-hash (M0's "Found, not fixed" 3): the adapter's own account read (readiness, plan preflight and report
  // collection) no longer holds the one exemption this test named; it asks for the seven fields too. Every site is checked.
  assert.deepEqual(unnamed, [], 'advertiser info reads without fields: ' + unnamed.join(', '));
});

test('lint: the advertiser info route is written only where it is built through the shared read or names its fields', () => {
  const allowed = new Set([
    // The shared read and its projection.
    'src/tiktok-advertiser-state.ts',
    // The scope check of the route and the readiness account read (see above).
    'src/tiktok-adapter.ts',
    // Reads that already name their own fields.
    'src/tiktok-change-logs.ts',
    'src/tiktok-report-jobs.ts',
  ]);
  const writers = sources()
    .filter(({code}) => /advertiser\/info\//.test(code))
    .map(({file}) => file);
  assert.deepEqual(
    writers.filter(file => !allowed.has(file)),
    [],
    'write the advertiser info route only through tiktokAdvertiserRead (src/tiktok-advertiser-state.ts)',
  );
});
