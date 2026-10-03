'use strict';
function render() {
  applyUILocale();
  document.getElementById('about-language-status').textContent = '';
}
function toast(message) {
  document.getElementById('about-language-status').textContent = message;
}
initializeUILocale();
document.addEventListener('change', async event => {
  if (event.target.matches('[data-language-select]')) await changeUILocale(event.target.value);
});
