'use strict';
// V2-WEB-02: the responsive table (web/components.js is the core). The caption is a heading outside the scroll area, named
// by both the scroll region and the table, so it stays put while the columns scroll; the header row and the first column are
// sticky (components-data.css); a column chooser hides columns and a density toggle changes the rows' height through one
// attribute; below a container width each row is a two-line card, which is why every element carries an explicit ARIA role
// (a table that stops being display:table keeps its meaning). A table is loading, empty (with one next action) or failed
// (with a way on) without losing its header. Values are text, never markup; a native name keeps its own direction.
const amcpTableStates = ['ready', 'loading', 'empty', 'error'];
AmcpUI.define(
  'table',
  ({
    id,
    caption,
    description,
    columns,
    rows,
    density = 'comfortable',
    chooser = true,
    densityToggle = true,
    state = 'ready',
    empty,
    error,
    skeletonRows = 5,
  }) => {
    amcpNeed(id, 'AMCP_UI_ID');
    amcpNeed(caption, 'AMCP_UI_CAPTION');
    if (!columns?.length) throw Error('AMCP_UI_COLUMNS');
    amcpChoose(state, amcpTableStates, 'AMCP_UI_STATE');
    amcpChoose(density, ['comfortable', 'compact'], 'AMCP_UI_DENSITY');
    const body = state === 'ready' && !rows.length ? 'empty' : state;
    if (body === 'empty' && !empty?.action) throw Error('AMCP_UI_TABLE_NEEDS_EMPTY_STATE');
    if (body === 'error' && !error?.retry) throw Error('AMCP_UI_TABLE_NEEDS_ERROR_STATE');
    const visible = columns.filter(column => !column.hidden).length,
      cell = (column, content, index, row) => {
        const shared = {
          'data-col': column.id,
          'data-label': column.label,
          'data-numeric': !!column.numeric,
          hidden: !!column.hidden,
        };
        const text = column.native ? html`<bdi>${content}</bdi>` : content;
        return index === 0
          ? html`<th${AmcpUI.attrs({...shared, scope: 'row', role: 'rowheader', 'data-label': false})}>${text}</th>`
          : html`<td${AmcpUI.attrs({...shared, role: 'cell'})}>${text}</td>`;
      },
      single = content =>
        html`<tr role="row"><td${AmcpUI.attrs({colspan: visible, role: 'cell', class: 'amcp-table-state'})}>${content}</td></tr>`,
      rowsMarkup =
        body === 'loading'
          ? Array.from(
              {length: skeletonRows},
              () =>
                html`<tr role="row" aria-hidden="true">${columns.map((column, index) => (index === 0 ? html`<th${AmcpUI.attrs({scope: 'row', role: 'rowheader', 'data-col': column.id, hidden: !!column.hidden})}><span class="amcp-skeleton" data-shape="text"></span></th>` : html`<td${AmcpUI.attrs({role: 'cell', 'data-col': column.id, hidden: !!column.hidden})}><span class="amcp-skeleton" data-shape="text"></span></td>`))}</tr>`,
            )
          : body === 'empty'
            ? single(AmcpUI.emptyState({title: empty.title, body: empty.body, action: empty.action}))
            : body === 'error'
              ? single(
                  AmcpUI.errorState({
                    title: error.title,
                    body: error.body,
                    retry: error.retry,
                    reference: error.reference,
                    details: error.details,
                  }),
                )
              : rows.map(
                  row =>
                    html`<tr role="row" data-row="${row.id}">${columns.map((column, index) => cell(column, row.cells[column.id] ?? '', index, row))}</tr>`,
                );
    return html`<div class="amcp-table" data-amcp="table" data-density="${density}" id="${id}"><div class="amcp-table-head"><div class="amcp-table-title"><h3 class="amcp-table-caption" id="${id}-caption">${caption}</h3>${description && html`<span class="amcp-table-description">${description}</span>`}</div>${
      (chooser || densityToggle) &&
      html`<div class="amcp-table-tools">${chooser && html`<details class="amcp-menu"><summary class="amcp-button" data-variant="secondary" data-size="sm">${uiText('Columns')}</summary><div class="amcp-menu-panel" role="group" aria-label="${uiText('Columns')}">${columns.map(column => AmcpUI.checkbox({id: id + '-column-' + column.id, name: id + '-columns', value: column.id, label: column.label, checked: !column.hidden, disabled: !column.hidden && visible === 1}))}</div></details>`}${
        densityToggle &&
        AmcpUI.segmented({
          name: id + '-density',
          label: uiText('Row density'),
          value: density,
          options: [
            {value: 'comfortable', label: uiText('Comfortable')},
            {value: 'compact', label: uiText('Compact')},
          ],
        })
      }</div>`
    }</div><div${AmcpUI.attrs({class: 'amcp-table-scroll', role: 'region', 'aria-labelledby': id + '-caption', tabindex: '0', 'aria-busy': body === 'loading' ? 'true' : false})}><table role="table" aria-labelledby="${id}-caption"><thead role="rowgroup"><tr role="row">${columns.map(column => html`<th${AmcpUI.attrs({scope: 'col', role: 'columnheader', 'data-col': column.id, 'data-numeric': !!column.numeric, hidden: !!column.hidden})}>${column.label}</th>`)}</tr></thead><tbody role="rowgroup">${rowsMarkup}</tbody></table></div>${body === 'loading' && html`<div class="amcp-visually-hidden" role="status">${uiText('Loading…')}</div>`}</div>`;
  },
);

/** The ids of the columns now shown, in order. */
const amcpTableVisible = host =>
  [...host.querySelectorAll('thead th')].filter(th => !th.hidden).map(th => th.getAttribute('data-col'));
AmcpUI.behave('table', {
  change(event, host) {
    const box = event.target.closest('.amcp-menu-panel input[type=checkbox]');
    if (box) {
      for (const part of host.querySelectorAll('[data-col]'))
        if (part.getAttribute('data-col') === box.value) part.hidden = !box.checked;
      const shown = amcpTableVisible(host),
        boxes = [...host.querySelectorAll('.amcp-menu-panel input[type=checkbox]')];
      // The last visible column keeps its box disabled, so a table always shows something.
      for (const other of boxes) other.disabled = shown.length === 1 && other.checked;
      for (const spanning of host.querySelectorAll('td[colspan]'))
        spanning.setAttribute('colspan', String(shown.length));
      AmcpUI.emit(host, 'amcp-change', {columns: shown});
      return true;
    }
    const radio = event.target.closest('input[type=radio]');
    if (radio && radio.name === host.id + '-density') {
      host.setAttribute('data-density', radio.value);
      AmcpUI.emit(host, 'amcp-change', {density: radio.value});
      return true;
    }
    return false;
  },
  keydown(event, host) {
    const menu = event.target.closest('details.amcp-menu');
    if (event.key !== 'Escape' || !menu?.open) return false;
    event.preventDefault();
    menu.open = false;
    menu.querySelector('summary').focus();
    return true;
  },
  focusout(event, host) {
    const menu = host.querySelector('details.amcp-menu');
    if (menu?.open && !(event.relatedTarget && menu.contains(event.relatedTarget))) menu.open = false;
    return false;
  },
});
