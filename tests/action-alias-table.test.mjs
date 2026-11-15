import test from 'node:test';
import assert from 'node:assert/strict';
import {actionAliasTable, actionAliasWarning} from '../dist/src/action-aliases.js';

/**
 * T7 (Round 2.5, M0): the generated table of near-miss action names. It is a pure function of a gateway's exact names, so
 * every rule is pinned here on a small synthetic gateway whose expected answers are written out by hand; the real
 * gateways' invariants are in tests/action-aliases.test.mjs.
 */
const action = (name, {write = false, canonical = name, aliases = [], path = '/v1/' + name} = {}) => ({
  name,
  canonical_name: canonical,
  aliases,
  method: write ? 'POST' : 'GET',
  path,
  read_only: !write,
  destructive: false,
  required: [],
  path_parameters: [],
  evidence: 'synthetic',
  raw: {},
});
const gateway = actions => new Map(actions.map(a => [a.name, a]));
const synthetic = gateway([
  action('tt_campaign_create', {write: true}),
  action('tt_campaign_update', {write: true}),
  action('tt_campaign_get'),
  action('tt_ad_create', {write: true}),
  action('tt_ad_get'),
  action('tt_file_image_ad_info_get'),
  action('tt_file_video_ad_info_get'),
  // A read that comes in both forms: the spelling without the suffix could mean either.
  action('tt_big_thing_get'),
  action('tt_big_thing_list'),
  // A spelling that is already an exact name of another action.
  action('tt_widget_get'),
  action('tt_widget'),
  // A write whose name ends like a read: no read-looking spelling may lead to it.
  action('tt_odd_get', {write: true}),
  // A friendly entry whose canonical name is another action's: both names reach the same action.
  action('tt_campaign_list', {canonical: 'tt_campaign_get'}),
]);
const table = actionAliasTable(synthetic);
const target = spelling => table.aliases.get(spelling)?.canonical;

test('the provider prefix is dropped from a name, and the result names the one action', () => {
  assert.equal(target('campaign_create'), 'tt_campaign_create');
  assert.equal(target('campaign_get'), 'tt_campaign_get');
  assert.equal(target('ad_create'), 'tt_ad_create');
});

test('a read answers without its trailing _get, with or without the prefix', () => {
  for (const spelling of ['tt_file_image_ad_info', 'file_image_ad_info', 'file_image_ad_info_get'])
    assert.equal(target(spelling), 'tt_file_image_ad_info_get', spelling);
  assert.equal(target('tt_file_video_ad_info'), 'tt_file_video_ad_info_get');
});

test('a read answers its _get and _list twin when no action has that name', () => {
  assert.equal(target('tt_file_image_ad_info_list'), 'tt_file_image_ad_info_get');
  assert.equal(target('file_image_ad_info_list'), 'tt_file_image_ad_info_get');
});

test('a write keeps only the prefix rule: no suffix is dropped or swapped for it', () => {
  for (const spelling of ['tt_campaign_create_get', 'tt_campaign_update_list', 'tt_ad_create_get', 'ad_create_list'])
    assert.equal(table.aliases.has(spelling), false, spelling);
  assert.equal(target('campaign_update'), 'tt_campaign_update');
  // Every alias that reaches a write is the prefix-less form of an exact name of it, and nothing else.
  for (const [spelling, entry] of table.aliases)
    if (entry.action.read_only === false)
      assert.ok(synthetic.has('tt_' + spelling), spelling + ' is not the prefix-less name of a write');
  // Nothing spelled like a read leads to a write.
  for (const [spelling, entry] of table.aliases)
    if (/_(get|list)$/.test(spelling)) assert.equal(entry.action.read_only, true, spelling + ' leads to a write');
  assert.equal(table.aliases.has('odd_get'), false);
});

test('a spelling two actions could claim is ambiguous: it resolves to neither and is listed with its claimants', () => {
  for (const spelling of ['tt_big_thing', 'big_thing']) {
    assert.equal(table.aliases.has(spelling), false, spelling);
    assert.deepEqual(
      [...(table.ambiguous.get(spelling) ?? [])].sort(),
      ['tt_big_thing_get', 'tt_big_thing_list'],
      spelling,
    );
  }
});

test('a spelling that is already an exact name is never an alias, and what it would have shadowed stays reachable', () => {
  assert.equal(table.aliases.has('tt_widget'), false);
  for (const name of synthetic.keys()) assert.equal(table.aliases.has(name), false, name + ' is an exact name');
  assert.equal(target('widget_get'), 'tt_widget_get');
});

test('a friendly entry and its canonical action share the action every alias of either resolves to', () => {
  // tt_campaign_list is a catalog name of tt_campaign_get; its prefix-less form reaches the canonical action.
  assert.equal(target('campaign_list'), 'tt_campaign_get');
  assert.equal(table.aliases.get('campaign_list').action, synthetic.get('tt_campaign_get'));
});

test('every alias resolves to the very action its canonical name does', () => {
  for (const [spelling, entry] of table.aliases) assert.equal(entry.action, synthetic.get(entry.canonical), spelling);
});

test('a single word is never an alias: an alias must still say what it does', () => {
  for (const spelling of [...table.aliases.keys(), ...table.ambiguous.keys()])
    assert.ok(spelling.split('_').length >= 2, spelling);
});

test('the table is a pure function of the names: the same catalog gives the same table', () => {
  const again = actionAliasTable(gateway([...synthetic.values()].reverse()));
  assert.deepEqual(
    [...again.aliases].map(([k, v]) => [k, v.canonical]).sort(),
    [...table.aliases].map(([k, v]) => [k, v.canonical]).sort(),
  );
  assert.deepEqual([...again.ambiguous.keys()].sort(), [...table.ambiguous.keys()].sort());
});

test('a provider rule adds spellings of its own, which are held to the same tests', () => {
  const extra = a =>
    a.name === 'tt_ad_get'
      ? ['tt_ad_read', 'tt_campaign_get', 'tt_big_thing', 'Bad Name!', 'single']
      : a.name === 'tt_ad_create'
        ? ['tt_ad_make']
        : [];
  const own = actionAliasTable(synthetic, extra),
    to = spelling => own.aliases.get(spelling)?.canonical;
  assert.equal(to('tt_ad_read'), 'tt_ad_get');
  assert.equal(to('tt_ad_make'), 'tt_ad_create');
  // An exact name, a malformed spelling and a single word give nothing.
  assert.equal(to('tt_campaign_get'), undefined);
  assert.equal(own.aliases.has('Bad Name!'), false);
  assert.equal(own.aliases.has('single'), false);
  // The spelling another action already claims by rule becomes ambiguous rather than being taken over.
  assert.equal(own.aliases.has('tt_big_thing'), false);
  assert.deepEqual([...own.ambiguous.get('tt_big_thing')].sort(), [
    'tt_ad_get',
    'tt_big_thing_get',
    'tt_big_thing_list',
  ]);
  // A read-looking spelling of a provider rule may not lead to a write.
  const sneaky = actionAliasTable(synthetic, a => (a.name === 'tt_ad_create' ? ['tt_ad_fetch_get'] : []));
  assert.equal(sneaky.aliases.has('tt_ad_fetch_get'), false);
});

test('a catalog with no common prefix has no prefix rule, only the suffix rule', () => {
  const mixed = actionAliasTable(
    gateway([action('alpha_one_get'), action('beta_two_get'), action('gamma_three_create', {write: true})]),
  );
  assert.equal(mixed.aliases.get('alpha_one')?.canonical, 'alpha_one_get');
  assert.equal(mixed.aliases.has('one_get'), false);
  assert.equal(mixed.aliases.has('three_create'), false);
});

test('names that are not executable routes (no path) and legacy upper-case names make no aliases', () => {
  const legacy = actionAliasTable(
    gateway([
      action('tt_real_get'),
      action('tt_other_get'),
      {...action('tt_pathless_get'), path: null, method: null},
      action('FETCH_THINGS_LIST'),
    ]),
  );
  assert.equal(legacy.aliases.get('real_get')?.canonical, 'tt_real_get');
  assert.equal(legacy.aliases.has('pathless_get'), false);
  assert.equal(legacy.aliases.has('tt_pathless'), false);
  for (const spelling of legacy.aliases.keys()) assert.doesNotMatch(spelling, /[A-Z]/);
});

// The review's S4-2: a spelling a provider has retired is refused with the replacement it names (src/retired-provider-actions.ts,
// "match the alias, not its shared route"). A generated spelling that equals one would resolve it to another action instead,
// so the table leaves it out, whether a rule or a provider's own hook would have produced it.
test('a spelling the provider has retired is no alias, whatever rule would have produced it', () => {
  const retired = spelling => ['campaign_create', 'tt_ad_make', 'ad_get'].includes(spelling),
    extra = a => (a.name === 'tt_ad_create' ? ['tt_ad_make'] : []),
    own = actionAliasTable(synthetic, extra, retired);
  // Without the list the rules do produce all three; with it none is an alias or an ambiguous spelling.
  const free = actionAliasTable(synthetic, extra);
  for (const spelling of ['campaign_create', 'tt_ad_make', 'ad_get'])
    assert.ok(free.aliases.has(spelling) || free.ambiguous.has(spelling), spelling + ' would be produced');
  for (const spelling of ['campaign_create', 'tt_ad_make', 'ad_get']) {
    assert.equal(own.aliases.has(spelling), false, spelling);
    assert.equal(own.ambiguous.has(spelling), false, spelling);
  }
  // Everything else is as it was.
  assert.equal(own.aliases.get('campaign_get')?.canonical, 'tt_campaign_get');
  assert.equal(own.aliases.get('ad_create')?.canonical, 'tt_ad_create');
});

test('the deprecation warning names the spelling used, the canonical name and where the caller wrote it', () => {
  const w = actionAliasWarning('arguments.action', 'campaign_get', 'tiktok_campaign_get');
  assert.equal(w.code, 'ACTION_ALIAS_DEPRECATED');
  assert.equal(w.field, 'arguments.action');
  assert.equal(w.used, 'campaign_get');
  assert.equal(w.canonical, 'tiktok_campaign_get');
  assert.match(w.message, /campaign_get/);
  assert.match(w.message, /tiktok_campaign_get/);
  assert.match(w.message, /alias/);
});
