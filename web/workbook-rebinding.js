'use strict';
function workbookQueryMoveController(root, id) {
  const generation = navigationGeneration,
    identity = identityGeneration;
  let sequence = 0,
    saving = false;
  const present = () => generation === navigationGeneration && identity === identityGeneration && root.isConnected;
  const load = async () => {
    if (!present()) return;
    const request = ++sequence,
      current = () => present() && request === sequence;
    root.setAttribute('aria-busy', 'true');
    try {
      const query = await workspaceCall('workspace', {action: 'report_query', id});
      if (!current()) return;
      root.innerHTML = `<h2 id="query-move-heading" tabindex="-1">${esc(uiText('Move saved query'))}: ${esc(query.name)}</h2><p>${esc(uiText('Account'))} <bdi>${esc(query.account_id)}</bdi></p><p><a href="/operations?workbook_binding_id=${encodeURIComponent(query.workbook_binding_id)}">${esc(uiText('Inspect current workbook setup'))}</a></p><p class="notice">${esc(uiText('Choose an existing workbook association. Moving keeps the query configuration and existing report runs, moves all linked schedules and pauses them for separate review. Spreadsheet access is not verified.'))}</p><form id="query-move-filter" class="work-filter"><label>${esc(uiText('Workbook search'))}<input name="search" type="search" maxlength="200"></label><button class="button" type="submit">${esc(uiText('Find workbooks'))}</button></form><section id="query-move-targets"><p data-page-status role="status">${esc(uiText('Loading workbook setup…'))}</p></section><div id="query-move-selected"></div><div id="query-move-preview"></div><p id="query-move-status" role="status"></p><button id="query-move-refresh" class="button">${esc(uiText('Refresh saved query'))}</button>`;
      const form = $('#query-move-filter'),
        preview = $('#query-move-preview'),
        selected = $('#query-move-selected');
      let edit = 0,
        search = '',
        page = 0;
      const invalidate = () => {
        if (current()) {
          edit++;
          preview.innerHTML = '';
          selected.innerHTML = '';
        }
      };
      form.addEventListener('input', invalidate);
      form.addEventListener('change', invalidate);
      workspaceBind('#query-move-refresh', () => {
        if (!saving) return load();
      });
      const pager = workPageLoader(
        '#query-move-targets',
        uiText('Choose destination workbook'),
        offset => workspaceCall('workspace', {action: 'report_bindings', search, offset: offset ?? 0, limit: 20}),
        result =>
          result.bindings
            .map(
              (binding, index) =>
                `<article class="operation-card"><h3>${esc(binding.spreadsheet_name)}</h3><p><bdi>${esc(binding.spreadsheet_id)}</bdi></p><button id="query-move-select-${index}" class="button small" ${!query.can_edit || binding.id === query.workbook_binding_id ? 'disabled' : ''}>${esc(uiText('Choose this workbook'))}</button><a class="button small" href="/operations?workbook_binding_id=${encodeURIComponent(binding.id)}">${esc(uiText('Inspect workbook setup'))}</a></article>`,
            )
            .join('') || `<p>${esc(uiText('No accessible workbook setup on this page.'))}</p>`,
        result => {
          const pageVersion = ++page;
          result.bindings.forEach((binding, index) =>
            workspaceBind('#query-move-select-' + index, () => {
              if (
                !current() ||
                saving ||
                !query.can_edit ||
                pageVersion !== page ||
                binding.id === query.workbook_binding_id
              )
                return;
              const version = ++edit,
                active = () => current() && form.isConnected && version === edit;
              preview.innerHTML = '';
              selected.innerHTML = `<h3>${esc(uiText('Selected destination'))}</h3><p>${esc(binding.spreadsheet_name)} · <bdi>${esc(binding.spreadsheet_id)}</bdi></p><button id="query-move-review" class="button primary">${esc(uiText('Review workbook move'))}</button>`;
              let reviewing = false;
              workspaceBind('#query-move-review', async () => {
                if (!active() || saving || reviewing) return;
                reviewing = true;
                preview.innerHTML = '';
                try {
                  const reviewed = await workspaceCall('workspace', {
                    action: 'preview_report_query_move',
                    id: query.id,
                    query_version: query.query_version,
                    target_binding_id: binding.id,
                  });
                  if (!active()) return;
                  preview.innerHTML = `<h3>${esc(uiText('Review workbook move'))}</h3><dl class="review-facts"><div><dt>${esc(uiText('Current workbook'))}</dt><dd>${esc(reviewed.source.spreadsheet_name)} · <bdi>${esc(reviewed.source.spreadsheet_id)}</bdi></dd></div><div><dt>${esc(uiText('Destination workbook'))}</dt><dd>${esc(reviewed.target.spreadsheet_name)} · <bdi>${esc(reviewed.target.spreadsheet_id)}</bdi></dd></div></dl><p>${esc(uiText('{count} schedules will move; {active} currently active schedules will pause.', {count: uiNumber(reviewed.schedules_to_rebind), active: uiNumber(reviewed.schedules_to_pause)}))}</p><p>${esc(uiText('Existing report runs keep their original configuration. One new report will be prepared without being submitted. No external spreadsheet will be changed.'))}</p><button id="query-move-save" class="button primary">${esc(uiText('Move query and pause schedules'))}</button>`;
                  workspaceBind('#query-move-save', async () => {
                    if (!active() || saving) return;
                    saving = true;
                    try {
                      const approved = await confirmAction({
                        title: uiText('Move this saved query?'),
                        consequence: uiText(
                          'Move from spreadsheet ID {source} to {target}. Move {count} schedules and keep all of them paused until reviewed and resumed.',
                          {
                            source: reviewed.source.spreadsheet_id,
                            target: reviewed.target.spreadsheet_id,
                            count: uiNumber(reviewed.schedules_to_rebind),
                          },
                        ),
                        confirmLabel: uiText('Move query and pause schedules'),
                      });
                      if (!approved || !active()) return;
                      const result = await workspaceCall('workspace', {
                        action: 'move_report_query',
                        id: query.id,
                        query_version: reviewed.query_version,
                        target_binding_id: reviewed.target.id,
                        rebinding_version: reviewed.rebinding_version,
                        confirmed: true,
                      });
                      if (!active()) return;
                      sequence++;
                      root.innerHTML = `<h2 tabindex="-1" id="query-move-complete">${esc(uiText('Query moved locally'))}</h2><p>${esc(uiText('Review each paused schedule before resuming future runs. Existing report runs are unchanged.'))}</p><a class="button" href="/operations?query_id=${encodeURIComponent(result.id)}">${esc(uiText('Inspect saved query'))}</a><a class="button" href="/operations?run_id=${encodeURIComponent(result.prepared_run_id)}">${esc(uiText('Inspect prepared report'))}</a><h3>${esc(uiText('Linked schedules'))}</h3>${result.schedules.map(schedule => `<a class="button small" href="/operations?workbook_schedule_id=${encodeURIComponent(schedule.id)}">${esc(schedule.id)}</a>`).join('')}`;
                      root.setAttribute('aria-busy', 'false');
                      $('#query-move-complete').focus();
                    } catch (error) {
                      if (active()) $('#query-move-status').textContent = errorMessage(error);
                    } finally {
                      saving = false;
                    }
                  });
                } catch (error) {
                  if (active()) $('#query-move-status').textContent = errorMessage(error);
                } finally {
                  reviewing = false;
                }
              });
            }),
          );
        },
      );
      workspaceBind('#query-move-filter', () => {
        if (!current() || saving) return;
        invalidate();
        search = form.elements.search.value;
        return pager.load();
      });
      $('#query-move-heading').focus();
      await pager.load();
    } catch (error) {
      if (current())
        root.innerHTML = `<h2>${esc(uiText('Saved query unavailable'))}</h2><p class="error" role="alert">${esc(errorMessage(error))}</p>`;
    } finally {
      if (current()) root.setAttribute('aria-busy', 'false');
    }
  };
  return {load};
}

async function renderWorkbookQueryMove(params) {
  content.innerHTML = header(
    uiText('Move saved query'),
    uiText('Review the source, destination and schedule impact before changing this local association.'),
  );
  content.innerHTML += `<div class="dialog-actions work-actions"><a class="button" href="/operations?query_id=${encodeURIComponent(params.get('move_query_id'))}">${esc(uiText('Inspect saved query'))}</a><a class="button" href="/operations?bindings=1">${esc(uiText('Workbook setup'))}</a></div><section class="panel workspace-form" id="query-move-root"><p role="status">${esc(uiText('Loading saved query…'))}</p></section>`;
  await workbookQueryMoveController($('#query-move-root'), params.get('move_query_id')).load();
}
