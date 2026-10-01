'use strict';
function workbookBindingController(root, id, onChange = () => {}) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0;
  const present = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const load = async () => {
    if (!present()) return;
    const request = ++sequence,
      current = () => present() && request === sequence;
    root.setAttribute('aria-busy', 'true');
    try {
      const record = await workspaceCall('workspace', {action: 'report_binding', id});
      if (!current()) return;
      root.innerHTML = `<h2 id="workbook-binding-heading" tabindex="-1">${esc(record.spreadsheet_name)}</h2><p><strong>${esc(uiText('Saved spreadsheet ID'))}</strong> <bdi>${esc(record.spreadsheet_id)}</bdi></p><p class="notice">${esc(uiText('This is a saved local association. Spreadsheet access has not been verified. Workbook runs keep output in this workspace; Overview delivery destinations are managed separately.'))}</p>${record.name_omitted ? `<p class="error">${esc(uiText('The legacy name cannot be displayed. Enter a new local name to replace it.'))}</p>` : ''}${record.retired ? `<p class="notice">${esc(uiText('Retired workbook setup. Restore it before adding queries or changing its name.'))}</p>` : ''}${record.can_manage_state ? `<p><button id="workbook-binding-state-review" class="button">${esc(uiText(record.retired ? 'Review restoring workbook setup' : 'Review retiring workbook setup'))}</button></p>` : record.query_count ? `<p>${esc(uiText('Move linked queries and schedules before retiring this workbook setup.'))}</p>` : ''}<form id="workbook-binding-form"><fieldset ${record.can_edit ? '' : 'disabled'}><label>${esc(uiText('Local workbook name'))}<input name="spreadsheet_name" maxlength="120" required value="${esc(record.name_omitted ? '' : record.spreadsheet_name)}"></label><button class="button primary" type="submit">${esc(uiText('Review name change'))}</button></fieldset></form><div id="workbook-binding-preview"></div><p data-binding-status role="status"></p><button class="button" id="workbook-binding-refresh">${esc(uiText('Refresh workbook setup'))}</button><h3>${esc(uiText('Linked saved queries'))}</h3><p>${esc(uiText('{count} linked queries', {count: uiNumber(record.query_count)}))}</p>${record.queries.map(q => `<article class="operation-card"><h4>${esc(q.name)}</h4><p>${esc(uiText('Account'))} <bdi>${esc(q.account_id)}</bdi> · ${esc(q.gateway)}</p><a class="button small" href="/operations?query_id=${encodeURIComponent(q.id)}">${esc(uiText('Inspect saved query'))}</a></article>`).join('') || `<p>${esc(uiText('No saved queries use this workbook setup.'))}</p>`}${record.queries_truncated ? `<p>${esc(uiText('The first 100 linked queries are shown. Find more through Saved workbook queries in Operations.'))}</p>` : ''}`;
      const form = $('#workbook-binding-form'),
        preview = $('#workbook-binding-preview');
      let version = 0,
        saving = false;
      const invalidate = () => {
        if (current()) {
          version++;
          preview.innerHTML = '';
        }
      };
      form.addEventListener('input', invalidate);
      form.addEventListener('change', invalidate);
      workspaceBind('#workbook-binding-refresh', load);
      workspaceBind('#workbook-binding-state-review', async () => {
        if (!current() || !record.can_manage_state || saving) return;
        const edit = ++version,
          active = () => current() && form.isConnected && edit === version;
        preview.innerHTML = '';
        try {
          const reviewed = await workspaceCall('workspace', {
            action: 'preview_report_binding_state',
            id: record.id,
            binding_version: record.binding_version,
            active: record.retired,
          });
          if (!active()) return;
          preview.innerHTML = `<h3>${esc(uiText(reviewed.active ? 'Review restoring workbook setup' : 'Review retiring workbook setup'))}</h3><p><bdi>${esc(reviewed.spreadsheet_id)}</bdi></p><p>${esc(uiText('This preserves the saved spreadsheet ID and private settings. No query, schedule, report run or external spreadsheet is deleted.'))}</p><button id="workbook-binding-state-save" class="button primary">${esc(uiText(reviewed.active ? 'Restore workbook setup' : 'Retire workbook setup'))}</button>`;
          workspaceBind('#workbook-binding-state-save', async () => {
            if (!active() || saving) return;
            saving = true;
            try {
              const approved = await confirmAction({
                title: uiText(reviewed.active ? 'Restore this workbook setup?' : 'Retire this workbook setup?'),
                consequence: uiText(
                  reviewed.active
                    ? 'Restore the empty local setup for spreadsheet ID {id}. It becomes available for new queries; spreadsheet access remains unverified.'
                    : 'Retire the empty local setup for spreadsheet ID {id}. It leaves active lists and cannot receive queries until restored. Saved settings are preserved.',
                  {id: reviewed.spreadsheet_id},
                ),
                confirmLabel: uiText(reviewed.active ? 'Restore workbook setup' : 'Retire workbook setup'),
              });
              if (!approved || !active()) return;
              await workspaceCall('workspace', {
                action: 'save_report_binding_state',
                id: record.id,
                binding_version: reviewed.binding_version,
                active: reviewed.active,
                confirmed: true,
              });
              if (active()) {
                await load();
                if (present()) await onChange();
              }
            } catch (error) {
              if (active()) root.querySelector('[data-binding-status]').textContent = errorMessage(error);
            } finally {
              saving = false;
            }
          });
        } catch (error) {
          if (active()) root.querySelector('[data-binding-status]').textContent = errorMessage(error);
        }
      });
      workspaceBind('#workbook-binding-form', async () => {
        if (!current() || !form.isConnected || !record.can_edit || saving) return;
        const edit = ++version,
          binding = {spreadsheet_name: form.elements.spreadsheet_name.value},
          active = () =>
            current() &&
            form.isConnected &&
            edit === version &&
            form.elements.spreadsheet_name.value === binding.spreadsheet_name;
        preview.innerHTML = '';
        try {
          const reviewed = await workspaceCall('workspace', {
            action: 'preview_report_binding',
            id: record.id,
            binding_version: record.binding_version,
            binding,
          });
          if (!active()) return;
          preview.innerHTML = `<h3>${esc(uiText('Review local workbook name'))}</h3><dl class="review-facts"><div><dt>${esc(uiText('Current name'))}</dt><dd>${esc(record.name_omitted ? uiText('Unavailable') : record.spreadsheet_name)}</dd></div><div><dt>${esc(uiText('Proposed name'))}</dt><dd>${esc(reviewed.binding.spreadsheet_name)}</dd></div></dl><p>${esc(uiText('The saved spreadsheet ID, preferences, linked queries, schedules and existing runs stay unchanged.'))}</p>${reviewed.changes.length ? `<button id="workbook-binding-save" class="button primary">${esc(uiText('Save local name'))}</button>` : `<p>${esc(uiText('No name change to save.'))}</p>`}`;
          workspaceBind('#workbook-binding-save', async () => {
            if (!active() || saving || !reviewed.changes.length) return;
            saving = true;
            try {
              const approved = await confirmAction({
                title: uiText('Rename this local workbook setup?'),
                consequence: uiText(
                  'Save the name {name} for saved spreadsheet ID {id}. This changes only AMCP metadata; it does not rename or access the external spreadsheet.',
                  {name: reviewed.binding.spreadsheet_name, id: reviewed.spreadsheet_id},
                ),
                confirmLabel: uiText('Save local name'),
              });
              if (!approved || !active()) return;
              await workspaceCall('workspace', {
                action: 'save_report_binding',
                id: record.id,
                binding_version: reviewed.binding_version,
                binding: reviewed.binding,
                confirmed: true,
              });
              if (active()) {
                await load();
                if (present()) await onChange();
              }
            } catch (error) {
              if (active()) root.querySelector('[data-binding-status]').textContent = errorMessage(error);
            } finally {
              saving = false;
            }
          });
        } catch (error) {
          if (active()) root.querySelector('[data-binding-status]').textContent = errorMessage(error);
        }
      });
      $('#workbook-binding-heading').focus();
    } catch (error) {
      if (current())
        root.innerHTML = `<h2>${esc(uiText('Workbook setup unavailable'))}</h2><p class="error" role="alert">${esc(errorMessage(error))}</p>`;
    } finally {
      if (current()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}

async function renderWorkbookBindings(params) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  content.innerHTML = header(
    uiText('Workbook setup'),
    uiText(
      'Inspect saved workbook associations and their linked queries. Review local names without changing spreadsheet access or report execution.',
    ),
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a class="button" href="/operations">${esc(uiText('Back to Operations'))}</a><a class="button" href="/operations?queries=1">${esc(uiText('Saved workbook queries'))}</a><a class="button" href="/report-library">${esc(uiText('Reports and delivery destinations'))}</a></div>${params.has('workbook_binding_id') ? `<section class="panel workspace-form" id="workbook-binding-detail" aria-label="${esc(uiText('Workbook setup details'))}"><p role="status">${esc(uiText('Loading workbook setup…'))}</p></section>` : ''}<section class="panel workspace-form"><form id="workbook-binding-filter" class="work-filter"><label>${esc(uiText('Workbook search'))}<input name="search" type="search" maxlength="200"></label><label>${esc(uiText('Exact saved spreadsheet ID'))}<input name="spreadsheet_id" maxlength="200"></label><label>${esc(uiText('Workbook state'))}<select name="state"><option value="active">${esc(uiText('Active'))}</option><option value="retired">${esc(uiText('Retired'))}</option><option value="all">${esc(uiText('All'))}</option></select></label><button class="button" type="submit">${esc(uiText('Find workbooks'))}</button></form></section><section class="panel" id="workbook-binding-list"><p data-page-status role="status">${esc(uiText('Loading workbook setup…'))}</p></section>`;
  const form = $('#workbook-binding-filter'),
    current = () => generation === navigationGeneration && identity === identityGeneration && form.isConnected;
  let filters = {search: '', spreadsheet_id: '', state: 'active'};
  const pager = workPageLoader(
    '#workbook-binding-list',
    uiText('Saved workbook associations'),
    offset => workspaceCall('workspace', {action: 'report_bindings', ...filters, offset: offset ?? 0, limit: 20}),
    result =>
      result.bindings
        .map(
          b =>
            `<article class="operation-card"><h3>${esc(b.spreadsheet_name)}</h3>${b.retired ? `<p>${esc(uiText('Retired'))}</p>` : ''}<p><bdi>${esc(b.spreadsheet_id)}</bdi> · ${esc(uiText('{count} linked queries', {count: uiNumber(b.query_count)}))}</p>${b.name_truncated ? `<p>${esc(uiText('Long name shortened for this list. Open the setup for details.'))}</p>` : ''}<a class="button small" href="/operations?workbook_binding_id=${encodeURIComponent(b.id)}">${esc(uiText('Inspect workbook setup'))}</a></article>`,
        )
        .join('') || `<p>${esc(uiText('No accessible workbook setup on this page.'))}</p>`,
  );
  workspaceBind('#workbook-binding-filter', () => {
    if (!current()) return;
    filters = {
      search: form.elements.search.value,
      spreadsheet_id: form.elements.spreadsheet_id.value,
      state: form.elements.state.value,
    };
    return pager.load();
  });
  const detail = params.has('workbook_binding_id')
    ? workbookBindingController($('#workbook-binding-detail'), params.get('workbook_binding_id'), () => pager.load())
    : null;
  await Promise.all([pager.load(), ...(detail ? [detail.load()] : [])]);
}
