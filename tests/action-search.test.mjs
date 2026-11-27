import test from 'node:test';
import assert from 'node:assert/strict';
import {Introspection} from '../dist/src/introspection.js';
import {registry} from './helpers/meta-service.mjs';

// r25-fr-meta-reads, D4 (the owner's friction report of 2026-11-26): on TikTok "adgroup get" and "report integrated" found nothing
// (the whole phrase had to be a substring of the record's JSON, and the names join words with underscores), "advertiser" found 375 of
// 561 actions because it is in their parameter lists, and 20 results ran to 13,000 characters. A search is its words: each must begin a
// word of the action's name, path, category or description, parameter lists are never searched, the names come first, and a page of a
// search is brief. Meta's own tool text recommends search="assigned users" and "business user": both found nothing.
const introspection = new Introspection(registry),
  strict = {mode: 'strict', flags: {}},
  list = (gateway, input) => introspection.list(gateway, {action: 'LIST_ACTIONS', ...input}, strict),
  nameOf = a => a.name ?? a.action,
  names = page => page.actions.map(nameOf);

// The oracle: the rule above, written again from its words and not from the code under test.
const fold = word => (word.length > 3 ? word.replace(/s$/, '') : word),
  tokens = text =>
    String(text)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(fold);
function tierOf(a, search) {
  const words = tokens(search),
    raw = a.raw ?? {},
    first = tokens(
      [a.name, a.canonical_name, ...(a.aliases ?? []), raw.name, raw.action, raw.canonical_action]
        .filter(Boolean)
        .join(' '),
    ),
    second = tokens([a.path, raw.path, raw.endpoint, raw.category].filter(Boolean).join(' ')),
    third = tokens(
      Object.values(raw)
        .filter(v => typeof v === 'string')
        .join(' '),
    );
  const covers = pool => words.every(w => pool.some(t => t.startsWith(w)));
  if (covers(first)) return 0;
  if (covers([...first, ...second])) return 1;
  if (covers([...first, ...second, ...third])) return 2;
  return undefined;
}
const found = (gateway, search) =>
  registry.catalogs
    .get(gateway)
    .actions.map(a => [a, tierOf(a, search)])
    .filter(([, tier]) => tier !== undefined);

test('a phrase finds the action whose name joins its words with underscores, whatever the order, case and joining', () => {
  const tiktok = 'tiktok_native_action';
  assert.ok(list(tiktok, {search: 'adgroup get'}).total_actions >= 1, 'adgroup get');
  for (const search of ['adgroup get', 'GET ADGROUP', 'adgroup_get', 'adgroup-get', '  adgroup   get  '])
    assert.equal(names(list(tiktok, {search}))[0], 'tiktok_adgroup_get', search);
  assert.ok(names(list(tiktok, {search: 'report integrated'})).includes('tiktok_report_integrated_get'));
  // Words are word beginnings: "adgroups" finds the singular, and "get" is not found inside "budget".
  assert.ok(names(list(tiktok, {search: 'adgroups'})).includes('tiktok_adgroup_get'));
  assert.equal(tierOf({name: 'tiktok_budget_update', raw: {}}, 'get'), undefined);
});

test('the search is its words and nothing in a parameter list: the result is exactly the actions whose name, path, category or text has them', () => {
  for (const [gateway, search] of [
    ['tiktok_native_action', 'advertiser'],
    ['tiktok_native_action', 'campaign'],
    ['tiktok_native_action', 'adgroup get'],
    ['meta_native_action', 'insights'],
    ['meta_native_action', 'ad account'],
    ['linkedin_native_action', 'campaign'],
    ['snapchat_native_action', 'history'],
  ]) {
    const want = found(gateway, search),
      page = list(gateway, {search, limit: 1000});
    // Snapchat's own listing envelope names its count `total`.
    assert.equal(page.total_actions ?? page.total, want.length, gateway + ' ' + search);
    // The first page lists the best of them: no later tier comes before an earlier one.
    const tiers = page.actions.map(a =>
      tierOf(registry.action(gateway, nameOf(a)) ?? {name: nameOf(a), raw: a}, search),
    );
    assert.ok(
      tiers.every(tier => tier !== undefined),
      gateway + ' ' + search,
    );
    assert.deepEqual(
      tiers,
      [...tiers].sort((x, y) => x - y),
      gateway + ' ' + search + ' is not names first',
    );
  }
  // "advertiser" is in the parameter list of most TikTok actions, and in the name or path of few.
  const advertiser = list('tiktok_native_action', {search: 'advertiser', limit: 50});
  assert.ok(advertiser.total_actions < 60, 'advertiser: ' + advertiser.total_actions);
  assert.ok(!names(advertiser).includes('tiktok_adgroup_get'));
});

test('Meta’s own examples find the access-management reads, and a search of no words finds nothing', () => {
  for (const search of ['assigned users', 'business user']) {
    const page = list('meta_native_action', {search});
    assert.ok(page.total_actions > 0, search);
    for (const name of names(page))
      assert.ok(tierOf(registry.action('meta_native_action', name), search) !== undefined, name);
  }
  assert.equal(list('tiktok_native_action', {search: '___'}).total_actions, 0);
});

test('a page of a search is brief and bounded, and the whole record is one DESCRIBE_ACTION away', () => {
  const tiktok = 'tiktok_native_action',
    page = list(tiktok, {search: 'campaign'});
  assert.equal(page.actions.length, 20, 'a search page is 20 records unless asked for more');
  assert.equal(page.limit, 20);
  assert.ok(JSON.stringify(page).length < 8192, 'the page is ' + JSON.stringify(page).length + ' characters');
  for (const a of page.actions) {
    assert.equal(a.native_fields, undefined, a.name);
    assert.equal(a.path_parameters, undefined, a.name);
    assert.ok(Array.isArray(a.required_parameters), a.name + ' keeps what it needs to be called');
    assert.deepEqual(a.omitted?.slice().sort(), ['native_fields', 'path_parameters'], a.name);
    assert.equal(typeof a.name + typeof a.method + typeof a.path, 'stringstringstring');
  }
  const more = list(tiktok, {search: 'get', limit: 500});
  assert.equal(more.actions.length, 50);
  assert.equal(more.limit, 50);
  assert.equal(more.has_more, true);
  // Paging a search is consistent.
  assert.deepEqual(
    [
      ...names(list(tiktok, {search: 'campaign', limit: 10})),
      ...names(list(tiktok, {search: 'campaign', limit: 10, offset: 10})),
    ],
    names(page),
  );
  const described = introspection.describe(tiktok, {target_action: 'tiktok_adgroup_get'});
  assert.ok(Array.isArray(described.native_fields) && described.native_fields.length > 5);
});

test('a listing without a search is the record as the capture holds it, page size as it was', () => {
  const tiktok = 'tiktok_native_action',
    plain = list(tiktok, {limit: 3});
  assert.equal(plain.limit, 3);
  assert.deepEqual(plain.actions[0], structuredClone(registry.catalogs.get(tiktok).actions[0].raw));
  assert.equal(list(tiktok, {}).limit, 50);
  assert.equal(list(tiktok, {category: 'Ad Group', limit: 2}).actions[0].native_fields === undefined, false);
});

test('the gateways whose listing AMCP serves from its own catalog search by the same words', () => {
  const dv360 = 'dv360_native_action',
    page = introspection.catalogRequest(dv360, {action: 'LIST_ACTIONS', search: 'advertisers get', limit: 20});
  assert.equal(page.actions[0].action, 'DV360_ADVERTISERS_GET');
  assert.ok(page.total_actions >= 1);
  assert.equal(
    introspection.catalogRequest(dv360, {action: 'LIST_ACTIONS', search: 'ADVERTISERS', limit: 5}).has_more,
    true,
  );
});
