// Records the native report collector of the current build over the synthetic collection scenarios of
// tests/helpers/report-collect-scenarios.mjs (every reporting platform and level): the requests it sends, the checkpoints
// it saves and its results or refusals. tests/report-collect-golden.test.mjs holds them byte-identical (ARC-04 stage F,
// collection moving into the report sources). Regenerate only for an intended collection change, and say so in the
// commit:  npm run build && node tools/report-collect-golden.mjs tests/fixtures/report-collect-golden.json
import fs from 'node:fs';
import {collectRecordings} from '../tests/helpers/report-collect-scenarios.mjs';

const [out] = process.argv.slice(2);
if (!out) throw Error('Usage: node tools/report-collect-golden.mjs <output file>');
const recordings = await collectRecordings();
fs.writeFileSync(out, JSON.stringify({schema_version: 1, recordings}, null, 1) + '\n');
console.log(
  JSON.stringify({
    scenarios: recordings.length,
    refusals: recordings.filter(r => r.error).length,
    requests: recordings.reduce((n, r) => n + r.requests.length, 0),
  }),
);
