import test from 'node:test';
import assert from 'node:assert/strict';
import {releasePathAllowed} from '../tools/prepare-public-release.mjs';
test('public release selection closes first-party dependencies and excludes private/runtime/review artifacts', () => {
  for (const p of [
    'tools/guidance-coverage.ts',
    'Skills/amcp-campaign-builder/references/media.md',
    'src/report-quality.ts',
    'docs/REPORTING-OVERVIEW.md',
    '.mirror/REPORTS/evidence-hashes.json',
    '.github/workflows/checks.yml',
    '.env.example',
    '.prettierrc.json',
    '.prettierignore',
    '.editorconfig',
  ])
    assert.equal(releasePathAllowed(p), true, p);
  for (const p of [
    '.env',
    '.env.production',
    '.mirror/PRIVATE/capture.json',
    '.mirror/RESULTS/live-read-samples.json',
    '.mirror/REVIEWS/report.md',
    'docs/token.key',
    'src/secrets/credentials.json',
    '.release/AMCP/server/http.ts',
    '.implementation/log.json',
    'server/auth.json',
    'server/mirror.sqlite-wal',
  ])
    assert.equal(releasePathAllowed(p), false, p);
});
