'use strict';
// Self-service deletion on /account (SEC-07, owner decision P3), a part after account security: an /account asset,
// not part of the shell every page downloads (WEB-07), with its markup escape-by-default.
/** The platform name of a saved login's gateway, from the platforms the shell loaded. */
const deletionPlatformName = gateway => (platforms ?? []).find(p => p.gateway === gateway)?.name ?? gateway;
/**
 * "Delete your account" (SEC-07, owner decision P3): a preview of what goes, a typed confirmation, the consequence
 * dialog and "Confirm it's you" (the server asks for it), then the erasure receipt in place of the page.
 */
function accountDeletionPanel() {
  insertHtml(
    content,
    'beforeend',
    html`<section class="panel account-deletion-panel" id="account-deletion" aria-labelledby="account-deletion-heading"><span class="eyebrow">${uiText('DELETE ACCOUNT')}</span><h2 id="account-deletion-heading">${uiText('Delete your account')}</h2><p>${uiText('Deleting your account erases it, your own workspace and everything that workspace holds: platform logins, reports, plans, files and settings. Your memberships in other workspaces end. This cannot be undone.')}</p><button type="button" class="button danger" id="account-deletion-review">${uiText('Review what will be deleted')}</button><p id="account-deletion-error" class="error" role="alert"></p><div id="account-deletion-plan"></div></section>`,
  );
  const error = $('#account-deletion-error');
  $('#account-deletion-review').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    error.textContent = '';
    try {
      showAccountDeletionPlan(await api('/api/account/deletion'));
    } catch (e) {
      error.textContent = errorMessage(e);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
/** What a deletion removes, one line each, from the server's counts (the preview's or the receipt's). */
function accountDeletionItems(w = {}) {
  const n = value => uiNumber(Number(value) || 0);
  return [
    uiText('Your own workspace and its settings'),
    uiText('{count} platform logins', {count: n(w.platform_logins)}),
    uiText('{count} saved records, such as reports and plans', {count: n(w.saved_records)}),
    uiText('{count} files', {count: n(w.files)}),
    uiText('{count} connector keys and AI-client connections', {count: n(w.connector_keys)}),
    uiText('{count} memberships in other workspaces', {count: n(w.other_workspaces)}),
  ];
}
function showAccountDeletionPlan(plan) {
  const area = $('#account-deletion-plan'),
    error = $('#account-deletion-error'),
    names = (plan.platforms ?? []).map(deletionPlatformName);
  if (!plan.available) {
    setHtml(
      area,
      html`<p class="notice" id="account-deletion-refusal">${plan.refusal?.message ? uiText(plan.refusal.message) : uiText('Your account cannot be deleted right now.')}</p>`,
    );
    return;
  }
  const items = accountDeletionItems(plan.will_delete);
  setHtml(
    area,
    html`<h3>${uiText('What will be deleted')}</h3><ul id="account-deletion-items">${items.map(i => html`<li>${i}</li>`)}</ul>${names.length ? html`<p class="form-note">${uiText('AMCP does not contact your platforms. Afterwards, remove AMCP’s access in each of them: {platforms}.', {platforms: names.join(', ')})}</p>` : ''}<p class="form-note">${uiText('Older backups keep a copy until they expire. If one is ever restored, the operator applies your deletion to it again.')}</p><form id="account-deletion-form" class="auth-form"><label>${plan.confirm_with === 'name' ? uiText('Type your account name to confirm') : uiText('Type your email address to confirm')}<span class="password-field"><input name="confirm" type="text" autocomplete="off" maxlength="254" spellcheck="false" required></span></label><button class="button danger">${uiText('Delete my account permanently')}</button></form>`,
  );
  $('#account-deletion-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter,
      confirm = new FormData(event.currentTarget).get('confirm');
    error.textContent = '';
    if (
      !(await confirmAction({
        title: uiText('Delete your account permanently?'),
        consequence: uiText(
          'Your account, your workspace and everything it holds are erased now. You are signed out everywhere. This cannot be undone.',
        ),
        confirmLabel: uiText('Delete permanently'),
      }))
    )
      return;
    button.disabled = true;
    try {
      const result = await api('/api/account/delete', {method: 'POST', body: JSON.stringify({confirm})});
      showAccountDeletionReceipt(result, (result.platforms ?? []).map(deletionPlatformName));
    } catch (e) {
      error.textContent = errorMessage(e);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
/** After the erasure: this tab forgets the person, and the receipt replaces the page. */
function showAccountDeletionReceipt(result, names) {
  const receipt = result.receipt ?? {},
    platformsNote = names.length
      ? uiText('AMCP does not contact your platforms. Remove AMCP’s access in each of them: {platforms}.', {
          platforms: names.join(', '),
        })
      : '',
    // The downloadable copy: the erasure's random id and UTC time, what went, and where to remove AMCP's access.
    lines = [
      uiText('AMCP account deletion receipt'),
      uiText('Erasure receipt {id}, {time}.', {
        id: receipt.erasure_id,
        time: new Date(Number(receipt.erased_at)).toISOString(),
      }),
      uiText('What was deleted'),
      ...accountDeletionItems(receipt.deleted).map(item => '- ' + item),
      ...(platformsNote ? [platformsNote] : []),
    ];
  resetPrivateState();
  session = {authenticated: false, csrf: null};
  shellLinks();
  setHtml(
    content,
    html`<section class="panel account-deletion-receipt" id="account-deletion-receipt"><span class="eyebrow">${uiText('DELETE ACCOUNT')}</span><h1 tabindex="-1">${uiText('Your account was deleted')}</h1><p>${uiText('Your account, your workspace and everything it held were erased from AMCP. Keep this receipt if you may need to show the deletion later.')}</p><p>${uiText('Erasure receipt {id}, {time}.', {id: receipt.erasure_id, time: date(receipt.erased_at)})}</p>${platformsNote ? html`<p>${platformsNote}</p>` : ''}<div class="dialog-actions"><button type="button" class="button" id="account-deletion-download">${uiText('Download receipt')}</button><a class="button primary" href="/">${uiText('Back to home')}</a></div></section>`,
  );
  $('#account-deletion-download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], {type: 'text/plain'}));
    link.download = 'AMCP-deletion-receipt.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  content.querySelector('h1').focus();
}
/**
 * The part follows account security, given the page's account: a personal account only, never a door or reviewer
 * sign-in, and not before a required two-step setup (the server refuses everything else until then).
 */
function renderAccountDeletion(account) {
  if (!account.administrator && !account.testAccount && !account.mfaEnrollmentRequired) accountDeletionPanel();
}
AMCP.routes.extend('/account', renderAccountDeletion, {order: 10});
