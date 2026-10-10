import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLifecycle,
  lifecycleExitCode,
  lifecycleSources,
  lifecycleText,
  manualCheckStatus,
  offlineLifecycle,
  registrableDomain,
} from '../dist/tools/provider-lifecycle.js';
import {providerContracts} from '../dist/src/provider-contracts.js';

const url = 'https://developers.google.com/google-ads/api/docs/sunset-dates',
  body =
    '<main><h1>Official lifecycle</h1>' +
    'supported versions and dates '.repeat(12) +
    '</main><script>random nonce</script>';
const page = text => async () => new Response(text);
const now = Date.parse('2026-10-09T00:00:00Z');

test('documentation watch distinguishes change, challenge and missing baseline without fabricating deprecation', async () => {
  const base = await checkLifecycle(url, undefined, page(body), now);
  assert.equal(base.status, 'baseline_required');
  assert.equal(base.provider, 'google');
  assert.equal(base.final_url, url);
  assert.equal(
    (await checkLifecycle(url, base, page(body.replace('random nonce', 'different script')), now)).status,
    'unchanged',
  );
  assert.equal(
    (await checkLifecycle(url, base, page(body.replace('Official', 'Updated official')), now)).status,
    'changed_requires_review',
  );
  // PRV-04: a blocked page was `fetch_failed` and failed every run; it is now `unavailable` with a reason, keeping the
  // earlier baseline, and does not fail the run.
  const unavailable = await checkLifecycle(url, base, page('Just a moment'), now);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.reason, 'blocked_or_empty');
  assert.equal(unavailable.sha256, base.sha256);
  assert.equal(unavailable.baseline_checked_at, base.checked_at);
  assert.equal(lifecycleExitCode([unavailable], now), 0);
  await assert.rejects(() =>
    checkLifecycle('https://evil.invalid', base, async () => {
      throw Error('No egress');
    }),
  );
  assert.equal(lifecycleText('<main>a <b>b</b></main><footer>rotating</footer>'), 'a b');
});

test('a same-domain redirect is followed and recorded; a cross-domain redirect is unavailable; a moved page needs review', async () => {
  const moved = 'https://ads-developers.google.com/google-ads/api/docs/sunset-dates';
  const seen = [];
  const redirecting = target => async (requested, init) => {
    seen.push([String(requested), init.redirect]);
    return String(requested) === url
      ? new Response(null, {status: 301, headers: {location: target}})
      : new Response(body);
  };
  const base = await checkLifecycle(url, undefined, page(body), now);
  const followed = await checkLifecycle(url, base, redirecting(moved), now);
  assert.deepEqual(seen, [
    [url, 'manual'],
    [moved, 'manual'],
  ]);
  assert.equal(followed.final_url, moved);
  // Same text at a new address: the move itself is the change to review.
  assert.equal(followed.status, 'changed_requires_review');
  assert.equal(followed.reason, 'final_url_changed');
  assert.equal(followed.previous_final_url, url);
  assert.equal(lifecycleExitCode([followed], now), 1);
  // Once the moved address is the baseline, it is unchanged.
  assert.equal((await checkLifecycle(url, followed, redirecting(moved), now)).status, 'unchanged');
  const away = await checkLifecycle(url, base, redirecting('https://example.com/elsewhere'), now);
  assert.deepEqual([away.status, away.reason, away.sha256], ['unavailable', 'cross_domain_redirect', base.sha256]);
  const plain = await checkLifecycle(url, base, redirecting('http://developers.google.com/google-ads'), now);
  assert.equal(plain.reason, 'cross_domain_redirect');
  assert.equal(lifecycleExitCode([away, plain], now), 0);
  const http = await checkLifecycle(url, base, async () => new Response('gone', {status: 503}), now);
  assert.deepEqual([http.status, http.reason], ['unavailable', 'http_503']);
  const loop = await checkLifecycle(url, base, redirecting(url), now);
  assert.equal(loop.reason, 'too_many_redirects');
  assert.equal(registrableDomain('learn.microsoft.com'), 'microsoft.com');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
});

test('parked-provider pages are parked and never fetched; only a change or an overdue manual check fails the run', async () => {
  const criteo = [...lifecycleSources].find(([, provider]) => provider === 'criteo')[0];
  const parked = await checkLifecycle(
    criteo,
    undefined,
    async () => {
      throw Error('a parked page is not fetched');
    },
    now,
  );
  assert.deepEqual([parked.status, parked.reason], ['parked', 'provider_parked']);
  const changed = {status: 'changed_requires_review'};
  assert.equal(lifecycleExitCode([parked, {status: 'unchanged'}, {status: 'baseline_required'}], now), 0);
  assert.equal(lifecycleExitCode([parked, changed], now), 1);
  // The TikTok portal blocks automated reads: a named owner reads it by hand on a cadence.
  const tiktok = manualCheckStatus(now).find(m => m.provider === 'tiktok');
  assert.ok(tiktok.owner && tiktok.cadence_days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(tiktok.due));
  const overdue = Date.parse(tiktok.due + 'T00:00:00Z') + 86400000;
  assert.equal(lifecycleExitCode([parked], overdue), 1);
});

test('offline mode flags maintained sources without a baseline, stale checks and providers without a policy', () => {
  const snapshot = {
    pages: [
      {source: url, sha256: 'a'.repeat(64), status: 'unchanged', checked_at: '2026-10-01T00:00:00Z'},
      {
        source: 'https://docs.x.com/x-ads-api/fundamentals/versioning',
        sha256: 'b'.repeat(64),
        status: 'unavailable',
        checked_at: '2026-10-08T00:00:00Z',
        baseline_checked_at: '2026-08-01T00:00:00Z',
      },
    ],
  };
  const view = offlineLifecycle(snapshot, now);
  assert.equal(view.baselined, 2);
  assert.ok(view.unbaselined.some(s => s.source === 'https://developers.google.com/google-ads/api/docs/release-notes'));
  assert.ok(!view.unbaselined.some(s => s.source === url));
  // Parked and manual providers are not unbaselined; they have their own policy.
  assert.ok(!view.unbaselined.some(s => ['criteo', 'tiktok', 'amazon', 'adjust'].includes(s.provider)));
  assert.deepEqual(
    view.parked.map(s => s.provider),
    ['criteo', 'criteo'],
  );
  // An unavailable page counts from its last successful read, not from the failed attempt.
  assert.deepEqual(view.stale_checks, [
    {provider: 'x', source: 'https://docs.x.com/x-ads-api/fundamentals/versioning', age_days: 69},
  ]);
  assert.equal(view.strict_failure, true);
  // Every provider has a watched source or an explicit manual policy.
  assert.deepEqual(view.providers_without_policy, []);
  assert.equal(
    new Set([...lifecycleSources.values(), ...view.manual.map(m => m.provider)]).size,
    providerContracts.length,
  );
});
