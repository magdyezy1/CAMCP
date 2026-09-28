import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Introspection} from './introspection.js';
import type {CallOptions, JsonObject} from './types.js';
const strict: CallOptions = {mode: 'strict', flags: {}};
/** Replays evidence before reporting a pass; no inference from catalog or adapter counts. */
export function verifyCapturedContracts(registry: Registry) {
  const introspection = new Introspection(registry),
    compiler = new Compiler(registry);
  const gateways = registry.data.catalogs.map(c => ({
    gateway: c.gateway,
    tier0_schema_loaded: registry.tools.has(c.gateway),
    tier1: {catalog_pages: 0, descriptions: 0},
    tier2: {full_preview_envelopes: 0, compiled_route_subsets: 0},
    tier3_live_equivalence_comparisons: 0,
  }));
  for (const g of gateways) {
    const dir = '.mirror/RAW/' + g.gateway;
    if (!fs.existsSync(dir)) continue;
    for (const name of fs
      .readdirSync(dir)
      .sort()
      .filter(n => /^(catalog-\d{4}|describe-[^/]+)\.json$/.test(n))) {
      const raw = JSON.parse(fs.readFileSync(dir + '/' + name, 'utf8')),
        outer = JSON.parse(raw.response.content[0].text);
      if (outer.success !== true) continue;
      const input = raw.request.args,
        kind =
          input.action === 'LIST_ACTIONS'
            ? 'catalog_pages'
            : input.action === 'DESCRIBE_ACTION'
              ? 'descriptions'
              : undefined;
      assert.ok(kind, 'Unsupported evidence operation: ' + name);
      const actual =
        kind === 'catalog_pages'
          ? introspection.list(g.gateway, input, strict)
          : introspection.describe(g.gateway, input);
      assert.deepEqual(actual, outer.data, g.gateway + '/' + name);
      g.tier1[kind]++;
    }
  }
  const fixtures: JsonObject[] = JSON.parse(fs.readFileSync('tests/fixtures/observed-routing.json', 'utf8'));
  for (const fixture of fixtures) {
    assert.equal(fixture.comparison, 'compiled_route_subset');
    assert.match(fixture.source.sha256, /^[a-f0-9]{64}$/);
    registry.validate(fixture.gateway, fixture.input, strict);
    const p = compiler.compile(fixture.gateway, fixture.input, strict);
    assert.deepEqual(
      {action: p.action, method: p.method, path: p.path, query: p.query, body: p.body},
      fixture.expected,
      fixture.gateway + '/observed preview routing subset',
    );
    gateways.find(g => g.gateway === fixture.gateway)!.tier2.compiled_route_subsets++;
  }
  return {
    scope:
      'Frozen introspection payloads and four compiled route subsets; no full preview envelope or live equivalence claim.',
    gateways,
  };
}
