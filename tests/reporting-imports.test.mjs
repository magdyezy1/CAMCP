import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('reporting metadata modules initialize independently in fresh Node processes', () => {
  for (const file of ['operations-feed.js', 'report-runs.js', 'report-query-access.js', 'workbook-schedules.js']) {
    const uri = pathToFileURL(path.resolve('dist/src', file)).href,
      result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', 'await import(' + JSON.stringify(uri) + ');'],
        {
          encoding: 'utf8',
          timeout: 60000,
          windowsHide: true,
        },
      );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      file + ' must initialize without depending on a previous service import: ' + result.stderr,
    );
  }
});
