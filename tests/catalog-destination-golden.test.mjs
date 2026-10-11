import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {MirrorService} from '../dist/src/service.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';
import {catalogComparisonData, catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {xImportInput} from './fixtures/x-catalog-import-data.mjs';

/**
 * COM-03 golden responses: the Meta and X catalog previews and comparisons, pinned before their destinations moved
 * behind one adapter contract. A refactor may only add fields; the additive fields of the shared comparison item v2
 * are removed before the comparison with the pinned response and checked on their own.
 * Regenerate only for a deliberate wire change: AMCP_UPDATE_GOLDEN=1 node --test tests/catalog-destination-golden.test.mjs
 */
const goldenFile = new URL('./fixtures/catalog-destination-golden.json', import.meta.url);
const actor = {tenantId: 'catalog-golden', userId: 'operator', role: 'operator'};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1500));
  return r.data;
};
/** Times and the hashes that cover them change on every read; everything else is deterministic. */
const volatile = new Set(['requested_at', 'captured_at', 'comparison_hash', 'observations_hash']);
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, volatile.has(k) ? '<volatile>' : normalize(v)]));
}
/** Fields the shared comparison item v2 and its destination contract add (COM-03); their own tests check them. */
const additive = new Set(['item_schema_version', 'destination', 'serving_notes', 'blocked_reason']);
/** Every pinned value is unchanged; the current response may only add the fields named above. */
function assertAdditive(current, pinned, path) {
  if (Array.isArray(pinned)) {
    assert.ok(Array.isArray(current), path + ' is no longer a list');
    assert.equal(current.length, pinned.length, path + ' length');
    pinned.forEach((v, i) => assertAdditive(current[i], v, path + '[' + i + ']'));
    return;
  }
  if (!pinned || typeof pinned !== 'object') return assert.deepEqual(current, pinned, path);
  assert.ok(current && typeof current === 'object' && !Array.isArray(current), path + ' is no longer an object');
  for (const [k, v] of Object.entries(pinned)) {
    assert.ok(Object.hasOwn(current, k), path + '.' + k + ' was removed');
    assertAdditive(current[k], v, path + '.' + k);
  }
  for (const k of Object.keys(current))
    assert.ok(Object.hasOwn(pinned, k) || additive.has(k), path + '.' + k + ' is not an additive item v2 field');
}
function metaService() {
  const store = new Store(':memory:', Buffer.alloc(32, 53).toString('base64')),
    data = catalogComparisonData(structuredClone(catalogComparisonInput));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: 'catalog-login',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      enabled: true,
      accounts: ['123'],
      writeAccounts: [],
      scopes: ['ads_read'],
      label: 'Synthetic read-only catalog',
    },
    {accessToken: 'synthetic'},
  );
  const transport = new NativeTransport(
    async raw => Response.json(data.response(raw)),
    async () => {},
    30000,
    8 * 1024 * 1024,
    200,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: false,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {store, call: args => service.call('amcp_workspace', args, actor)};
}

export async function goldenResponses() {
  const out = {};
  out.meta_preview = catalogIngestion(structuredClone(catalogComparisonInput));
  out.meta_preview_create_only = catalogIngestion({...structuredClone(catalogComparisonInput), allow_upsert: false});
  const meta = metaService();
  try {
    out.meta_compare = ok(await meta.call(structuredClone(catalogComparisonInput)));
    out.meta_compare_create_only = ok(
      await meta.call({...structuredClone(catalogComparisonInput), allow_upsert: false}),
    );
  } finally {
    meta.store.close();
  }
  out.x_preview = catalogIngestion(xImportInput());
  for (const [name, mutate, extra] of [
    ['x_compare', () => {}, {}],
    ['x_compare_inventory', () => {}, {inspect_other_listed_products: true, absent_source_policy: 'retain'}],
    [
      'x_compare_grouped',
      f => {
        f.items[9001][0].item_group_id = 'Original group';
      },
      {},
    ],
    [
      'x_compare_unknown_fields',
      f => {
        delete f.items[9001][2].image_link;
        f.items[9001][1].price = 'native unknown';
      },
      {},
    ],
  ]) {
    const f = xCatalogComparisonFixture();
    try {
      mutate(f);
      out[name] = ok(await f.call({...f.input, ...extra}));
    } finally {
      f.store.close();
    }
  }
  return normalize(out);
}

test('COM-03 golden: Meta and X previews and comparisons are unchanged except for additive item v2 fields', async () => {
  const current = await goldenResponses();
  if (process.env.AMCP_UPDATE_GOLDEN === '1') fs.writeFileSync(goldenFile, JSON.stringify(current, null, 2) + '\n');
  const pinned = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  assert.deepEqual(Object.keys(current).sort(), Object.keys(pinned).sort());
  for (const key of Object.keys(pinned)) assertAdditive(current[key], pinned[key], key);
});
