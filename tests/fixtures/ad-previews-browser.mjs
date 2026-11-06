import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Preview your ads panel in a real browser (audit F-L3-05 and F-L3-06): Load more appends instead of rewriting, keeps
// the reader's place, announces only how many previews came, and keeps the list when it fails. Every provider answer is
// synthetic: an ad account of eleven active ads, previewed five at a time, and an ads list that can be told to fail once.

export const adPreviewsConnection = {
  id: 'aaaaaaaa-1111-4111-8111-0000000000ad',
  account: '100',
  gateway: 'meta_native_action',
};
const ads = Array.from({length: 11}, (_, i) => ({
  id: String(9001 + i),
  // One word, so that an Arabic page has no run of Latin words to count as untranslated text.
  name: 'Synthetic' + (i + 1),
  account_id: adPreviewsConnection.account,
  effective_status: 'ACTIVE',
  campaign_id: '10',
  adset_id: '20',
}));

/**
 * The synthetic Graph API of the account. Each request is recorded in `native`. `failNext` makes the next read of the
 * ads list answer with something that is not a list: a 200 answer of the wrong shape, which AMCP refuses in its own
 * words (no retry, no provider wording on the page). The service answers such a refusal with a 200 envelope of its own,
 * so the page records no error response; failed() is how many reads the provider has failed so far.
 */
export function adPreviewsProvider(native) {
  let failures = 0,
    failed = 0;
  return {
    failNext: () => {
      failures++;
    },
    failed: () => failed,
    async transport(raw, init) {
      const url = new URL(String(raw)),
        route = /^\/v\d+\.\d+\/(.+)$/.exec(url.pathname)?.[1];
      assert.equal(init.method ?? 'GET', 'GET', 'Previews make reads only');
      assert.equal(url.origin, 'https://graph.facebook.com');
      native.push({method: 'GET', path: url.pathname});
      if (route === 'act_' + adPreviewsConnection.account + '/ads') {
        if (failures > 0) {
          failures--;
          failed++;
          return Response.json({data: 'not a list'});
        }
        const limit = Number(url.searchParams.get('limit') ?? 25),
          offset = Number(url.searchParams.get('after') ?? 0),
          page = ads.slice(offset, offset + limit);
        return Response.json({
          data: page,
          ...(offset + page.length < ads.length
            ? {
                paging: {
                  next: 'https://graph.facebook.com/v26.0/act_100/ads?after=' + (offset + page.length),
                  cursors: {after: String(offset + page.length)},
                },
              }
            : {}),
        });
      }
      const preview = /^(\d+)\/previews$/.exec(route ?? '');
      if (preview)
        return Response.json({
          data: [{body: '<iframe src="https://www.facebook.com/ads/preview/' + preview[1] + '"></iframe>'}],
        });
      throw Error('Unexpected synthetic Graph request ' + url.pathname);
    },
  };
}

/**
 * Drives the panel by keyboard, as a reader who cannot see it would, and checks what the audit found wrong: the rows
 * already read are the same elements after Load more (appended, not rewritten); focus goes to the first new row; the
 * live region holds one short message, not the rows; a failed Load more keeps the rows and focus on the button and says
 * why in an alert beside it; Start again lists the selection from its first page.
 */
export async function exerciseAdPreviews({page, site, locale, result, checks, catalogPath = 'web/locales/ar.json'}) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')),
    say = (message, count) => {
      const shown = locale === 'ar' ? catalog[message] : message;
      assert.equal(typeof shown, 'string', 'The Arabic catalog holds ' + message);
      return shown.replace('{count}', String(count));
    },
    form = page.locator('#preview-form'),
    status = page.locator('#preview-status'),
    more = page.locator('#preview-load-more'),
    error = page.locator('#preview-more-error'),
    active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName),
    rowCount = () => page.evaluate(() => document.querySelectorAll('#preview-rows .token-row').length),
    waitForRows = count =>
      page.waitForFunction(n => document.querySelectorAll('#preview-rows .token-row').length === n, count),
    waitForError = () =>
      page.waitForFunction(() => document.querySelector('#preview-more-error')?.textContent.trim().length > 0),
    // The elements marked before Load more: still the same ones afterwards only if the rows were appended.
    mark = () =>
      page.evaluate(() => {
        document.querySelector('#preview-row-0').setAttribute('data-kept', 'yes');
        window.__keptRow = document.querySelector('#preview-row-3');
        window.__keptRows = document.querySelector('#preview-rows');
      }),
    kept = () =>
      page.evaluate(
        () =>
          document.querySelector('#preview-row-0').getAttribute('data-kept') === 'yes' &&
          document.querySelector('#preview-row-3') === window.__keptRow &&
          document.querySelector('#preview-rows') === window.__keptRows,
      );
  await form.waitFor({state: 'visible'});
  assert.equal(await page.locator('#preview-results').getAttribute('role'), null, 'The rows are not a live region');
  assert.equal(await page.locator('#preview-results').getAttribute('aria-live'), null);
  assert.equal(await status.getAttribute('role'), 'status');
  // The fixture is shared by every case of the kind, so what this case asked to refuse is counted from here.
  const before = site.counts().nativeReads,
    refusedBefore = site.adPreviews.failed();

  // The first page: five previews, announced as a count.
  await form.locator('button[type="submit"]').click();
  await waitForRows(5);
  assert.equal(await status.innerText(), say('{count} previews', 5));
  assert.equal(await more.count(), 1);
  assert.equal(await page.locator('#preview-row-0').getAttribute('tabindex'), '-1');
  assert.equal(await page.locator('#preview-rows a[href^="https://www.facebook.com/ads/preview/"]').count(), 5);
  await checks.intermediate('previews first page');
  await mark();

  // Load more by keyboard: the new rows are appended, focus goes to the first of them, and the page announces a count.
  await more.focus();
  assert.equal(await active(), 'preview-load-more');
  await page.keyboard.press('Enter');
  await waitForRows(10);
  assert.equal(await active(), 'preview-row-5', 'Focus moves to the first new row, not to the page');
  assert.equal(await kept(), true, 'The rows already read are the same elements: they were appended to, not rewritten');
  assert.equal(await status.innerText(), say('{count} more previews', 5), 'The page says how many came, not the rows');
  assert.equal(await more.count(), 1);

  // A Load more that fails keeps the rows and the reader's place, and says why beside the button.
  site.adPreviews.failNext();
  await more.focus();
  await page.keyboard.press('Enter');
  await waitForError();
  assert.equal(await rowCount(), 10, 'The rows stay');
  assert.equal(await kept(), true, 'The rows stay the same elements');
  assert.equal(await error.getAttribute('role'), 'alert');
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('#preview-load-more').parentElement ===
        document.querySelector('#preview-more-error').parentElement,
    ),
    true,
    'The reason is told beside the button',
  );
  assert.equal(await active(), 'preview-load-more', 'Focus stays on the button');
  assert.equal(await more.getAttribute('aria-disabled'), 'false', 'The button is ready again');
  assert.equal(await more.getAttribute('disabled'), null, 'The button was never disabled, so focus was never lost');
  assert.equal(await page.locator('#preview-restart').isVisible(), true);
  await checks.intermediate('previews load more refused');

  // The same button goes on from the same place: the last page comes and the button goes with it.
  await page.keyboard.press('Enter');
  await waitForRows(11);
  assert.equal(await active(), 'preview-row-10');
  assert.equal(await status.innerText(), say('{count} more preview', 1));
  assert.equal(await more.count(), 0);
  assert.equal(await error.count(), 0);
  assert.equal(await kept(), true);

  // Start again: list the selection once more, refuse a Load more, and start over from the first page.
  await form.locator('button[type="submit"]').click();
  await waitForRows(5);
  await mark();
  await more.focus();
  await page.keyboard.press('Enter');
  await waitForRows(10);
  site.adPreviews.failNext();
  await more.focus();
  await page.keyboard.press('Enter');
  await waitForError();
  assert.equal(await rowCount(), 10);
  await page.locator('#preview-restart').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#preview-rows .token-row').length === 5 &&
      !document.querySelector('#preview-row-0').hasAttribute('data-kept'),
  );
  assert.equal(await status.innerText(), say('{count} previews', 5));
  assert.equal(await more.count(), 1);
  assert.ok(site.counts().nativeReads > before, 'The previews were read on request');
  const refused = site.adPreviews.failed() - refusedBefore;
  assert.equal(refused, 2, 'Exactly the two Load more reads it asked to refuse were refused');
  result.ad_previews = {rows_after_restart: await rowCount(), refused_load_more: refused};
}
