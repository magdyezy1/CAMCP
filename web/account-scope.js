'use strict';
// A test account sees only the pages an evaluator needs, as the route registry marks them (web/routes.js). The server
// refuses the rest outright; this keeps the navigation honest so nothing offers a door that will not open (WEB-06):
// out-of-scope links, groups left empty and the sidebar's connectors link are hidden, the palette lists only pages in
// scope, and a page the workspace does not include says so after opening Home instead of silently replacing the URL.
// It adjusts every render through the shell's render hooks (WEB-07), before the page renders and once it has.
let scopeRedirectedFrom = null;
AMCP.hooks.beforeRender(() => {
  const scoped = !!(session.authenticated && session.testAccount);
  document.body.classList.toggle('test-account', scoped);
  for (const link of document.querySelectorAll('[data-route]'))
    link.hidden = scoped && !routeAvailable('/' + link.dataset.route);
  // A sidebar link outside the navigation list (the connectors note) follows the same scope.
  for (const link of document.querySelectorAll('.sidebar-note a[href^="/"]'))
    link.hidden = scoped && !routeAvailable(link.getAttribute('href').split(/[?#]/)[0]);
  // A group whose every link is hidden would open onto nothing.
  for (const group of document.querySelectorAll('.sidebar details.nav-more'))
    group.hidden = scoped && [...group.querySelectorAll('[data-route]')].every(link => link.hidden);
  if (scoped && !routeAvailable(location.pathname)) {
    scopeRedirectedFrom = location.pathname;
    history.replaceState({}, '', '/dashboard');
  }
});
AMCP.hooks.afterRender(() => {
  const from = scopeRedirectedFrom;
  scopeRedirectedFrom = null;
  if (!from || location.pathname !== '/dashboard' || !content.querySelector) return;
  const label = routeLabel(from);
  const notice = html`<p class="notice" role="status" id="scope-notice">${
    label
      ? uiText('This test workspace does not include {page}.', {page: uiText(label)})
      : uiText('This test workspace does not include that page.')
  }</p>`;
  const heading = content.querySelector('.page-heading');
  if (heading) insertHtml(heading, 'afterend', notice);
  else insertHtml(content, 'afterbegin', notice);
});
