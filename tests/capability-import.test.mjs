import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('capability eligibility can initialize directly without service-first import ordering', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      // The recorded write scopes moved to the grant registry (CON-03); the module must still initialize on its own.
      "const m=await import('./dist/src/capability-eligibility.js'); if(m.readinessLifetimeMs!==900000||m.dependencyResolution('exact_account')!=='resolved_locally')process.exit(2);",
    ],
    {encoding: 'utf8'},
  );
  assert.equal(result.status, 0, result.stderr);
});
