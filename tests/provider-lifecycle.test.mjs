import test from 'node:test';
import assert from 'node:assert/strict';
import {checkLifecycle, lifecycleText} from '../dist/tools/provider-lifecycle.js';
test('documentation watch distinguishes change, challenge and missing baseline without fabricating deprecation', async () => {
  const url = 'https://developers.google.com/google-ads/api/docs/sunset-dates',
    body =
      '<main><h1>Official lifecycle</h1>' +
      'supported versions and dates '.repeat(12) +
      '</main><script>random nonce</script>';
  const base = await checkLifecycle(url, undefined, async () => new Response(body));
  assert.equal(base.status, 'baseline_required');
  assert.equal(
    (await checkLifecycle(url, base, async () => new Response(body.replace('random nonce', 'different script'))))
      .status,
    'unchanged',
  );
  assert.equal(
    (await checkLifecycle(url, base, async () => new Response(body.replace('Official', 'Updated official')))).status,
    'changed_requires_review',
  );
  const unavailable = await checkLifecycle(url, base, async () => new Response('Just a moment'));
  assert.equal(unavailable.status, 'fetch_failed');
  assert.equal(unavailable.sha256, base.sha256);
  assert.equal(unavailable.baseline_checked_at, base.checked_at);
  await assert.rejects(() =>
    checkLifecycle('https://evil.invalid', base, async () => {
      throw Error('No egress');
    }),
  );
  assert.equal(lifecycleText('<main>a <b>b</b></main><footer>rotating</footer>'), 'a b');
});
