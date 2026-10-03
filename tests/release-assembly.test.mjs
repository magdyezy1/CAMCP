import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPublicImplementationReport, releasePathAllowed} from '../tools/prepare-public-release.mjs';
test('public release selection closes first-party dependencies and excludes private/runtime/review artifacts', () => {
  for (const p of [
    'tools/guidance-coverage.ts',
    'Skills/amcp-campaign-builder/references/media.md',
    'src/report-quality.ts',
    'docs/REPORTING-OVERVIEW.md',
    '.mirror/REPORTS/evidence-hashes.json',
    '.mirror/REPORTS/implementation-status.json',
    '.mirror/REPORTS/compatibility-verification.json',
    '.mirror/PARITY.md',
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
    '.mirror/REPORTS/private-account-responses.json',
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
test('public report assembly refuses live samples and malformed reports without exposing their contents', () => {
  assert.doesNotThrow(() => assertPublicImplementationReport(Buffer.from('{"live_read_samples":[]}\n')));
  for (const report of [
    '{"live_read_samples":[{"private":"PRIVATE_ACCOUNT_MARKER"}]}',
    '{"live_read_samples":"PRIVATE_ACCOUNT_MARKER"}',
    '{"private":"PRIVATE_ACCOUNT_MARKER"}',
    'null',
    'PRIVATE_ACCOUNT_MARKER',
  ]) {
    assert.throws(
      () => assertPublicImplementationReport(Buffer.from(report)),
      error =>
        /Public implementation report must/.test(error.message) && !error.message.includes('PRIVATE_ACCOUNT_MARKER'),
    );
  }
});
