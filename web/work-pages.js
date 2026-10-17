'use strict';
// WEB-07: the paged work lists of the workspace (Operations and Monitoring, Capabilities, Creative, report allocation
// and presentation, workbook bindings). A page that lists work loads this small module instead of the whole Operations
// center and its workbook controllers.
// Each loader owns its DOM node and request sequence. A late page cannot replace a newer filter, route or session.
function workPageLoader(selector, title, fetchPage, renderRows, bindRows = () => {}, active = () => true) {
  const root = $(selector),
    generation = navigationGeneration,
    identity = identityGeneration;
  const current = () =>
    generation === navigationGeneration && identity === identityGeneration && root.isConnected && active();
  let sequence = 0,
    page = 0,
    cursors = [undefined],
    next = null;
  const go = async (index = 0, reset = false) => {
    if (!current()) return;
    const request = ++sequence,
      cursor = reset ? undefined : cursors[index];
    root.setAttribute('aria-busy', 'true');
    const status = root.querySelector('[data-page-status]');
    if (status) status.textContent = uiText('Loading…');
    try {
      const result = await fetchPage(cursor);
      if (request !== sequence || !current()) return;
      page = index;
      if (reset) cursors = [undefined];
      next = result.next_cursor ?? result.next_offset ?? null;
      root.innerHTML = `<div class="panel-header"><h2>${esc(uiText(title))}</h2><span class="form-note">${esc(uiText('Page'))} ${page + 1}${Number.isInteger(result.total) ? uiText(' · {count} matching', {count: result.total}) : ''}</span></div>${renderRows(result)}<p data-page-status role="status">${next !== null ? uiText('More results are available.') : uiText('End of available results.')}</p><nav class="dialog-actions work-actions" aria-label="${esc(uiText('{title} pages', {title: uiText(title)}))}"><button class="button small" data-page-prev ${page ? '' : 'disabled'}>${esc(uiText('Previous'))}</button><button class="button small" data-page-next ${next !== null ? '' : 'disabled'}>${esc(uiText('Next'))}</button></nav>`;
      workspaceBind(selector + ' [data-page-prev]', () => go(page - 1));
      workspaceBind(selector + ' [data-page-next]', () => {
        cursors[page + 1] = next;
        return go(page + 1);
      });
      bindRows(result);
    } catch (e) {
      if (request !== sequence || !current()) return;
      const errorStatus = root.querySelector('[data-page-status]');
      const message = uiText('Could not load this page. ') + errorMessage(e);
      if (errorStatus) errorStatus.textContent = message;
      else
        root.innerHTML = `<h2>${esc(uiText(title))}</h2><p class="error" role="alert">${esc(message)}</p><p>${esc(uiText('Apply the filters or refresh to try again.'))}</p>`;
    } finally {
      if (request === sequence && current()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load: () => go(0, true)};
}
