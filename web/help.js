'use strict';
// DOC-03: the members-only Help page. The /help page the server sends a signed-in member carries the owner guide in a
// hidden element (server/help-routes.ts), built at build time from docs/owner/ and docs/owner/ar/ as escaped HTML
// (tools/help-pages.mjs). This module shows the guide in the interface language and hides it on every other page. It
// writes no markup besides the page heading, so the guide never passes through a script. A visitor who is not signed
// in goes to sign-in first, and comes back here.
const helpReloadKey = 'amcp.help.reload';
function helpGuideElement() {
  return document.getElementById('help-guide');
}
/**
 * Whether the server sends this session the guide (server/help-routes.ts): a signed-in member who is not a test account
 * and owes no two-step setup.
 */
function helpGuideAllowed() {
  return !!session.authenticated && !session.testAccount && !session.mfaEnrollmentRequired;
}
// The guide sits beside the page content, not in it: leaving Help only hides it, and a later visit shows it again.
// Once the session may no longer read it (after a sign-out, as a test account, or while two-step setup is owed), the
// guide leaves the document too, and is marked so that a member's next visit loads /help from the server again: the
// page does not keep the members-only guide for whoever uses the tab next.
AMCP.hooks.beforeRender(() => {
  const guide = helpGuideElement();
  if (!guide) return;
  guide.hidden = true;
  if (helpGuideAllowed()) return;
  guide.textContent = '';
  guide.setAttribute('data-help-unavailable', '');
});
/** Whether this tab reloaded /help in the last ten seconds, so a guide the server did not send never loops. */
function helpReloadedRecently() {
  try {
    const at = Number(sessionStorage.getItem(helpReloadKey));
    sessionStorage.setItem(helpReloadKey, String(Date.now()));
    return Number.isFinite(at) && Date.now() - at < 10000;
  } catch {
    return true;
  }
}
async function renderHelp() {
  if (!session.authenticated) return showLogin();
  const heading = html`<div class="page-heading"><div><h1>${uiText('Help')}</h1><p>${uiText(routeSubtitle('/help'))}</p></div></div>`,
    guide = helpGuideElement();
  if (!guide || guide.hasAttribute('data-help-unavailable')) {
    // This page was opened from another page, or before signing in: the server sends the guide with /help itself.
    if (!helpReloadedRecently()) {
      setHtml(
        content,
        html`${heading}<section class="panel" role="status" aria-busy="true"><p>${uiText('Opening the guide…')}</p></section>`,
      );
      location.reload();
      return;
    }
    setHtml(
      content,
      html`${heading}<p class="notice" role="alert">${uiText('The guide could not be opened. Reload the page to try again.')}</p>`,
    );
    return;
  }
  try {
    sessionStorage.removeItem(helpReloadKey);
  } catch {}
  setHtml(content, heading);
  const language = guide.querySelector('[data-help-language="' + uiLocale + '"]') ? uiLocale : 'en';
  for (const part of guide.querySelectorAll('[data-help-language]'))
    part.hidden = part.dataset.helpLanguage !== language;
  guide.hidden = false;
}
AMCP.routes.register('/help', {render: renderHelp});
