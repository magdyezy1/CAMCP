import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isProviderModule, providerRegistries} from '../../tools/architecture-map.mjs';

/**
 * Asserts that a shared module names no provider's gateway and imports no provider module except a registry (ARC-01
 * phase B), as the architecture ratchet counts them (tools/architecture-map.mjs). `versionReads` names provider version
 * modules whose import the module keeps for now: the versions package's typed version fact replaces them.
 */
export function assertNamesNoProvider(file, {versionReads = []} = {}) {
  const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const named = [...source.matchAll(/['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g)]
    .map(m => m[1])
    .filter(name => name !== 'amcp');
  assert.deepEqual(named, [], file + ' names no provider gateway');
  // Runtime imports and re-exports; a type-only one is erased from the compiled module.
  const imported = [...source.matchAll(/^(?:import|export) (?!type )[^;]*? from '\.\/([^']+)\.js';/gms)].map(m => m[1]);
  assert.ok(imported.length > 0, file + ' imports modules');
  const providers = imported.filter(
    module => isProviderModule('src/' + module + '.ts') && !providerRegistries.includes('src/' + module + '.ts'),
  );
  assert.deepEqual(providers, versionReads, file + ' imports no provider module but its named version reads');
}
