'use strict';
function render() {
  applyUILocale();
  document.getElementById('about-language-status').textContent = '';
}
function toast(message) {
  document.getElementById('about-language-status').textContent = message;
}
// The page ships with sign-in calls to action, which are true without JavaScript. They offer sign-up only when this
// deployment says a new person can complete one (WEB-02).
async function applyRegistration() {
  let options;
  try {
    const response = await fetch('/api/account/options', {
      credentials: 'same-origin',
      headers: {Accept: 'application/json'},
    });
    if (response.ok) options = await response.json();
  } catch {
    // Without the answer the page keeps its sign-in calls to action.
  }
  if (options?.registrationAvailable !== true) return;
  for (const link of document.querySelectorAll('[data-registration-cta]')) {
    link.setAttribute('href', link.getAttribute('data-open-href'));
    link.setAttribute('data-ui-text', link.getAttribute('data-open-text'));
  }
  for (const note of document.querySelectorAll('[data-registration-note]')) note.hidden = true;
  applyUILocale();
}
// localization.js already handles the language select; a second handler here changed the language twice (WEB-05).
initializeUILocale();
applyRegistration();
