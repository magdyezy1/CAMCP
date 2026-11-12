import assert from 'node:assert/strict';
import fs from 'node:fs';

// OWNER-REVIEWER-QA: the workspace as Meta's app reviewers see it, signed in with an invited test account in its own
// workspace (tests/fixtures/reviewer-workspace-data.mjs). The pages come from the route registry (web/routes.js),
// never from a copy: every page marked testAccount, and each member page the test workspace does not include. The
// server's test-account gate (server/website-gates.ts) decides what a reviewer reaches; these checks only read it.

/** The reviewer's pages in registry order, the sidebar and palette entries among them, and the member pages left out. */
export function reviewerRoutes(registry) {
  const entries = [...registry],
    scoped = entries.filter(entry => entry.testAccount === true);
  return {
    routes: scoped.map(entry => entry.path),
    nav: scoped.filter(entry => entry.nav === true).map(entry => entry.path),
    palette: scoped.filter(entry => entry.palette === true).map(entry => entry.path),
    excluded: entries.filter(entry => entry.public !== true && entry.testAccount !== true).map(entry => entry.path),
    labels: Object.fromEntries(entries.map(entry => [entry.path, entry.label])),
  };
}

/** The address a page opens with: a fresh AI-client authorization for consent, the reviewer's attempt for a result. */
export async function reviewerQuery(site, route) {
  if (route === '/oauth/consent') return '?request=' + encodeURIComponent(await site.reviewer.consentRequest());
  if (route === '/oauth/result') return '?attempt=' + encodeURIComponent(site.reviewer.attemptId);
  return '';
}

/**
 * Records every API answer the page receives (method, path, status, and a refusal's error code) and marks where the
 * page showed its first content. Installed before the page opens.
 */
export function captureApiResponses(page) {
  const responses = [],
    pending = [];
  let firstContent = null;
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const entry = {method: response.request().method(), path: url.pathname, status: response.status()};
    responses.push(entry);
    if (entry.status >= 400)
      pending.push(
        response.json().then(
          body => (entry.code = typeof body?.error?.code === 'string' ? body.error.code : null),
          () => (entry.code = null),
        ),
      );
  });
  return {
    responses,
    firstContent: () => (firstContent ??= responses.length),
    async loading() {
      await Promise.all(pending);
      return responses.slice(0, firstContent ?? responses.length);
    },
  };
}

/**
 * The reviewer-specific checks of one rendered case: nothing the page asked for while it loaded was refused (above all
 * not TEST_ACCOUNT_SCOPE), the case runs as the test account, the navigation and the palette offer exactly the pages
 * marked testAccount, a member page lands on Home with the notice that the test workspace does not include it, and the
 * sign-in return opens Home.
 */
export async function exerciseReviewerPage({page, route, locale, result, api, scope}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = (key, values = {}) =>
      (locale === 'ar' ? (catalog[key] ?? key) : key).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (slot, name) =>
        Object.hasOwn(values, name) ? String(values[name]) : slot,
      );
  const loading = await api.loading(),
    evidence = (result.reviewer = {
      api_responses: loading.map(({method, path, status, code}) => ({method, path, status, ...(code ? {code} : {})})),
    });
  assert.deepEqual(
    loading.filter(response => response.code === 'TEST_ACCOUNT_SCOPE'),
    [],
    'A reviewer page asked for an API its test account does not include',
  );
  assert.deepEqual(
    loading.filter(response => response.status >= 400),
    [],
    'A reviewer page received an error answer while it loaded',
  );
  evidence.session = await page.evaluate(() => ({
    authenticated: session.authenticated === true,
    test_account: session.testAccount === true,
    scoped_shell: document.body.classList.contains('test-account'),
  }));
  assert.deepEqual(
    evidence.session,
    {authenticated: true, test_account: true, scoped_shell: true},
    'The case runs as the signed-in test account',
  );
  // The sidebar: the links and groups the scope leaves showing, its footer's links (Account, Help) and the page footer's Help.
  evidence.navigation = await page.evaluate(() => {
    // Its accessible name is translated; data-ui-label keeps the English one.
    const nav = document.querySelector('#workspace-sidebar nav[data-ui-label="Main navigation"]');
    return {
      links: [...nav.querySelectorAll('a[data-route]')]
        .filter(link => !link.hidden && !link.closest('[hidden]'))
        .map(link => link.getAttribute('href')),
      // V2-WEB-03: Account and Help in the sidebar's footer (the promotional note with a connectors link is gone).
      footer: [...document.querySelectorAll('.sidebar-links a[data-route]')]
        .filter(link => !link.hidden && !link.closest('[hidden]'))
        .map(link => link.getAttribute('href').split(/[?#]/)[0]),
      footer_help: !document.getElementById('footer-help')?.hidden,
    };
  });
  assert.deepEqual(evidence.navigation.links, scope.nav, 'The navigation shows exactly the test-account pages');
  assert.deepEqual(
    evidence.navigation.footer.filter(path => !scope.routes.includes(path)),
    [],
    'A sidebar footer link opens a test-account page',
  );
  assert.deepEqual(
    evidence.navigation.footer,
    ['/account'],
    'The sidebar footer offers a test account its own page only',
  );
  assert.equal(evidence.navigation.footer_help, false, 'The footer offers no Help page to a test account');
  // The command palette with no query lists every page it offers this account, in registry order.
  await page.keyboard.press('Control+k');
  await page.locator('#command-dialog[open]').waitFor();
  evidence.palette = await page
    .locator('#command-results [data-command-go]')
    .evaluateAll(buttons => buttons.map(button => button.dataset.commandGo));
  await page.keyboard.press('Escape');
  await page.locator('#command-dialog:not([open])').waitFor({state: 'attached'});
  assert.deepEqual(evidence.palette, scope.palette, 'The palette lists exactly the test-account pages');
  // Where the case landed, and what it says there.
  evidence.landed = new URL(page.url()).pathname;
  const notice = page.locator('#scope-notice');
  if (scope.excluded.includes(route)) {
    assert.equal(evidence.landed, '/dashboard', route + ' opens Home for a test account');
    await notice.waitFor({state: 'visible'});
    evidence.notice = (await notice.innerText()).trim();
    assert.equal(
      evidence.notice,
      text('This test workspace does not include {page}.', {page: text(scope.labels[route])}),
      'Home says the test workspace does not include ' + route,
    );
    assert.equal(await notice.getAttribute('role'), 'status');
    assert.equal(
      await page.evaluate(() => {
        const guide = document.getElementById('help-guide');
        return !guide || (guide.hidden && guide.childElementCount === 0);
      }),
      true,
      'No member guide reaches a test account',
    );
    return;
  }
  assert.equal(await notice.count(), 0, 'A test-account page opens without the scope notice');
  if (route === '/auth/complete') {
    assert.equal(evidence.landed, '/dashboard', 'The sign-in return opens Home');
    return;
  }
  assert.equal(evidence.landed, route, route + ' stays open for a test account');
  if (route === '/oauth/result') {
    // The reviewer's Meta connection, as the provider callback recorded it; AMCP's own message in the case's language.
    assert.equal((await page.locator('.callback-card h1').innerText()).trim(), text('You’re connected.'));
    evidence.result_message = (await page.locator('.callback-top p').innerText()).trim();
    assert.equal(evidence.result_message, text('Connection secured. Choose the assets AMCP can use.'));
    assert.equal(await page.locator('[data-callback-manage="meta"]').count(), 1, 'The result offers Choose assets');
  }
  if (route === '/oauth/consent') {
    // A pending authorization for the reviewer's AI client, with both decisions offered.
    assert.equal((await page.locator('.consent-host').innerText()).trim(), 'claude.ai');
    for (const decision of ['approve', 'deny'])
      assert.equal(await page.locator(`[data-consent="${decision}"]`).isVisible(), true, decision + ' is offered');
  }
}
