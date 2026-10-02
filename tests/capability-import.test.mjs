import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('capability eligibility can initialize directly without service-first import ordering', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const m=await import('./dist/src/capability-eligibility.js'); if(!m.recordedWriteScopes.meta_native_action.includes('ads_management'))process.exit(2);",
    ],
    {encoding: 'utf8'},
  );
  assert.equal(result.status, 0, result.stderr);
});
