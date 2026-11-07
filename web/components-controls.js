'use strict';
// V2-WEB-02: the choosing components (web/components.js is the core): a segmented control, tabs, a searchable combobox for
// accounts and campaigns, and the tri-state tree of the scope picker. Their keyboard rules are pure functions
// (AmcpUI.tabs.next, AmcpUI.tree.keyAction, AmcpUI.combobox.filter) so they can be read and tested without a page; the
// delegated behaviours apply them to the markup. Only authored markup is written (html`…` and setHtml).

// Segmented control: native radios in one labelled group, so the browser supplies Tab, the arrow keys and the group. The
// checked segment is drawn from :checked; nothing here needs a script.
AmcpUI.define('segmented', ({name, label, options, value, id = AmcpUI.uid('segmented')}) => {
  amcpNeed(name, 'AMCP_UI_NAME');
  amcpNeed(label, 'AMCP_UI_LABEL');
  if (value !== undefined && !options.some(option => option.value === value)) throw Error('AMCP_UI_VALUE: ' + value);
  const current = value ?? options.find(option => !option.disabled)?.value;
  return html`<div class="amcp-segmented" role="radiogroup" aria-label="${label}" id="${id}">${options.map(
    option =>
      html`<label class="amcp-segment"><input${AmcpUI.attrs({class: 'amcp-segment-input', type: 'radio', name, value: option.value, checked: option.value === current, disabled: !!option.disabled})}><span class="amcp-segment-label">${option.label}</span></label>`,
  )}</div>`;
});

// Tabs: a tab list with a roving tab stop, and a panel for each tab. Arrow keys move (and by default select), Home and End
// jump, a disabled tab is skipped, and a right-to-left page swaps the arrows. activation "manual" waits for Enter or Space.
function amcpTabsNext({key, index, count, enabled = [], rtl = false, orientation = 'horizontal'}) {
  const usable = position => enabled[position] !== false,
    steps =
      orientation === 'vertical' ? {ArrowDown: 1, ArrowUp: -1} : {ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1};
  if (Object.hasOwn(steps, key))
    for (let distance = 1; distance <= count; distance++) {
      const position = (((index + steps[key] * distance) % count) + count) % count;
      if (usable(position)) return position;
    }
  if (key === 'Home' || key === 'End') {
    const positions = Array.from({length: count}, (_, position) => position).filter(usable);
    return (key === 'Home' ? positions[0] : positions.at(-1)) ?? null;
  }
  return null;
}
function amcpSelectTab(host, tab) {
  const list = host.querySelector('[role=tablist]'),
    tabs = [...list.querySelectorAll('[role=tab]')],
    changed = tab.getAttribute('aria-selected') !== 'true';
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.setAttribute('tabindex', on ? '0' : '-1');
    const panel = document.getElementById(other.getAttribute('aria-controls'));
    if (panel) panel.hidden = !on;
  }
  if (changed) AmcpUI.emit(host, 'amcp-change', {id: tab.getAttribute('data-tab')});
}
AmcpUI.define(
  'tabs',
  Object.assign(
    ({id = AmcpUI.uid('tabs'), label, tabs, selected, activation = 'auto', orientation = 'horizontal'}) => {
      amcpNeed(label, 'AMCP_UI_LABEL');
      if (!tabs.length) throw Error('AMCP_UI_TABS');
      amcpChoose(activation, ['auto', 'manual'], 'AMCP_UI_ACTIVATION');
      amcpChoose(orientation, ['horizontal', 'vertical'], 'AMCP_UI_ORIENTATION');
      const current = tabs.some(tab => tab.id === selected && !tab.disabled)
        ? selected
        : tabs.find(tab => !tab.disabled)?.id;
      return html`<div class="amcp-tabs" data-amcp="tabs" data-activation="${activation}" data-orientation="${orientation}" id="${id}"><div class="amcp-tablist" role="tablist" aria-label="${label}" aria-orientation="${orientation}">${tabs.map(
        tab =>
          html`<button${AmcpUI.attrs({type: 'button', class: 'amcp-tab', role: 'tab', id: id + '-tab-' + tab.id, 'data-tab': tab.id, 'aria-selected': String(tab.id === current), 'aria-controls': id + '-panel-' + tab.id, tabindex: tab.id === current ? '0' : '-1', disabled: !!tab.disabled})}>${tab.label}</button>`,
      )}</div>${tabs.map(
        tab =>
          html`<div${AmcpUI.attrs({class: 'amcp-tabpanel', role: 'tabpanel', id: id + '-panel-' + tab.id, 'aria-labelledby': id + '-tab-' + tab.id, tabindex: '0', hidden: tab.id !== current})}>${tab.panel}</div>`,
      )}</div>`;
    },
    {next: amcpTabsNext},
  ),
);
AmcpUI.behave('tabs', {
  keydown(event, host) {
    const tab = event.target.closest('[role=tab]');
    if (!tab || tab.closest('[data-amcp=tabs]') !== host) return false;
    const list = tab.closest('[role=tablist]'),
      tabs = [...list.querySelectorAll('[role=tab]')],
      next = amcpTabsNext({
        key: event.key,
        index: tabs.indexOf(tab),
        count: tabs.length,
        enabled: tabs.map(other => !other.disabled),
        rtl: getComputedStyle(list).direction === 'rtl',
        orientation: list.getAttribute('aria-orientation') ?? 'horizontal',
      });
    if (next === null) return false;
    event.preventDefault();
    tabs[next].focus();
    if (host.getAttribute('data-activation') !== 'manual') amcpSelectTab(host, tabs[next]);
    return true;
  },
  click(event, host) {
    const tab = event.target.closest('[role=tab]');
    if (!tab || tab.disabled || tab.closest('[data-amcp=tabs]') !== host) return false;
    amcpSelectTab(host, tab);
    return true;
  },
});

// Combobox: an editable text box with a listbox popup (the ARIA combobox pattern, list autocomplete, manual selection).
// Typing filters, ignoring case and accents, with label prefixes first; the active option is named by
// aria-activedescendant while focus stays in the box; the list says how many results there are and when it was cut short;
// a half-typed query is never a value, so leaving the box puts the chosen label back.
const amcpFold = char => char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Text folded for comparison, with where each folded character began in the original. */
function amcpFolded(text) {
  let folded = '',
    at = 0;
  const origin = [];
  for (const char of String(text ?? '')) {
    const next = amcpFold(char);
    for (let index = 0; index < next.length; index++) origin.push(at);
    folded += next;
    at += char.length;
  }
  origin.push(at);
  return {folded, origin};
}
function amcpComboboxFilter(options, query, limit = 50) {
  const needle = amcpFolded(String(query ?? '').trim()).folded;
  if (!needle) return {items: options.slice(0, limit), total: options.length};
  const ranked = [];
  for (const option of options) {
    const label = amcpFolded(option.label).folded;
    const rank = label.startsWith(needle)
      ? 0
      : label.includes(needle)
        ? 1
        : [option.description, option.value].some(text => text && amcpFolded(text).folded.includes(needle))
          ? 2
          : null;
    if (rank !== null) ranked.push({option, rank, order: ranked.length});
  }
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {items: ranked.slice(0, limit).map(entry => entry.option), total: ranked.length};
}
/** A label split around its first match, so the match can be marked. */
function amcpComboboxSegments(label, query) {
  const needle = amcpFolded(String(query ?? '').trim()).folded,
    text = String(label ?? '');
  if (!needle) return [{text, match: false}];
  const {folded, origin} = amcpFolded(text),
    found = folded.indexOf(needle);
  if (found < 0) return [{text, match: false}];
  const start = origin[found],
    end = origin[found + needle.length];
  return [
    {text: text.slice(0, start), match: false},
    {text: text.slice(start, end), match: true},
    {text: text.slice(end), match: false},
  ].filter(part => part.text);
}
const amcpComboboxes = new WeakMap();
function amcpComboboxMount(host, {options = [], value, limit = 50, onSelect, search} = {}) {
  const input = host.querySelector('input[role=combobox]'),
    hidden = host.querySelector('input[type=hidden]'),
    popup = host.querySelector('.amcp-popup'),
    list = popup.querySelector('[role=listbox]'),
    note = popup.querySelector('.amcp-listbox-note'),
    status = host.querySelector('[role=status]'),
    spinner = host.querySelector('.amcp-spinner'),
    id = input.id,
    state = {
      options,
      shown: [],
      total: 0,
      active: -1,
      open: false,
      chosen: null,
      query: '',
      sequence: 0,
      busy: false,
      failed: false,
      limit,
      onSelect,
      search,
    };
  const draw = () => {
    state.active = Math.min(state.active, state.shown.length - 1);
    input.setAttribute('aria-expanded', String(state.open));
    popup.hidden = !state.open;
    if (state.active >= 0) input.setAttribute('aria-activedescendant', id + '-option-' + state.active);
    else input.removeAttribute('aria-activedescendant');
    if (state.busy) host.setAttribute('aria-busy', 'true');
    else host.removeAttribute('aria-busy');
    spinner.hidden = !state.busy;
    // An empty listbox is not read as a list; the note beside it says why it is empty.
    if (state.shown.length) list.removeAttribute('aria-hidden');
    else list.setAttribute('aria-hidden', 'true');
    setHtml(
      list,
      html`${state.shown.map(
        (option, index) =>
          html`<li${AmcpUI.attrs({class: 'amcp-option', role: 'option', id: id + '-option-' + index, 'data-index': index, 'data-value': option.value, 'aria-selected': String(index === state.active), 'aria-disabled': option.disabled ? 'true' : false, 'data-chosen': state.chosen?.value === option.value})}><span class="amcp-option-label"><bdi>${amcpComboboxSegments(option.label, state.query).map(part => (part.match ? html`<mark>${part.text}</mark>` : part.text))}</bdi></span>${option.description && html`<span class="amcp-option-description"><bdi>${option.description}</bdi></span>`}</li>`,
      )}`,
    );
    let message = '';
    if (state.failed) {
      note.setAttribute('role', 'alert');
      setHtml(
        note,
        html`<span>${uiText('Could not load the options.')}</span> <button type="button" class="amcp-button" data-variant="secondary" data-size="sm" data-combobox-retry>${uiText('Try again')}</button>`,
      );
      message = uiText('Could not load the options.');
    } else if (state.busy) {
      note.removeAttribute('role');
      setHtml(note, html`<span>${uiText('Searching…')}</span>`);
      message = uiText('Searching…');
    } else if (!state.shown.length) {
      note.removeAttribute('role');
      setHtml(
        note,
        html`<span>${state.query.trim() ? uiText('No match for “{query}”.', {query: state.query.trim()}) : uiText('No options yet.')}</span> ${state.query && html`<button type="button" class="amcp-button" data-variant="secondary" data-size="sm" data-combobox-clear>${uiText('Clear the search')}</button>`}`,
      );
      message = uiText('No matches');
    } else {
      note.removeAttribute('role');
      setHtml(
        note,
        state.total > state.shown.length
          ? html`<span>${uiText('Showing {shown} of {total}. Keep typing to narrow the list.', {shown: uiNumber(state.shown.length), total: uiNumber(state.total)})}</span>`
          : html``,
      );
      message =
        state.total > state.shown.length
          ? uiText('Showing {shown} of {total}. Keep typing to narrow the list.', {
              shown: uiNumber(state.shown.length),
              total: uiNumber(state.total),
            })
          : uiPlural(state.shown.length, '{count} result', '{count} results');
    }
    status.textContent = state.open ? message : '';
  };
  const run = () => {
    if (!state.search) {
      const found = amcpComboboxFilter(state.options, state.query, state.limit);
      Object.assign(state, {shown: found.items, total: found.total, busy: false, failed: false});
      return draw();
    }
    const sequence = ++state.sequence;
    Object.assign(state, {busy: true, failed: false, shown: [], total: 0, active: -1});
    draw();
    let answer;
    try {
      answer = Promise.resolve(state.search(state.query));
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      found => {
        if (sequence !== state.sequence) return;
        Object.assign(state, {busy: false, shown: found.slice(0, state.limit), total: found.length});
        draw();
      },
      () => {
        if (sequence !== state.sequence) return;
        Object.assign(state, {busy: false, failed: true, shown: [], total: 0});
        draw();
      },
    );
  };
  const open = (fresh = false) => {
    if (fresh) state.query = '';
    state.open = true;
    run();
  };
  const close = () => {
    state.open = false;
    state.active = -1;
    draw();
  };
  const revert = () => {
    input.value = state.chosen?.label ?? '';
    state.query = '';
  };
  const choose = option => {
    if (!option || option.disabled) return;
    state.chosen = option;
    input.value = option.label;
    hidden.value = option.value;
    state.query = '';
    close();
    AmcpUI.emit(host, 'amcp-change', {value: option.value, label: option.label});
    state.onSelect?.(option);
  };
  const move = step => {
    if (!state.open) open();
    if (!state.shown.length) return;
    state.active =
      state.active < 0
        ? step > 0
          ? 0
          : state.shown.length - 1
        : (state.active + step + state.shown.length) % state.shown.length;
    draw();
    document.getElementById(id + '-option-' + state.active)?.scrollIntoView?.({block: 'nearest'});
  };
  Object.assign(state, {draw, run, openList: open, close, revert, choose, move, input, hidden, list, popup});
  amcpComboboxes.set(host, state);
  if (value !== undefined) state.chosen = options.find(option => option.value === value) ?? null;
  if (state.chosen) {
    input.value = state.chosen.label;
    hidden.value = state.chosen.value;
  }
  draw();
  return Object.freeze({
    setOptions(next) {
      state.options = next;
      if (state.open) run();
    },
    value: () => state.chosen?.value ?? null,
    open: () => open(true),
    close,
    destroy: () => amcpComboboxes.delete(host),
  });
}
AmcpUI.define(
  'combobox',
  Object.assign(
    ({id, label, hint, error, required, disabled, placeholder, name, loading = false}) => {
      amcpNeed(id, 'AMCP_UI_ID');
      amcpNeed(label, 'AMCP_UI_LABEL');
      return html`<div class="amcp-field amcp-combobox" data-amcp="combobox" id="${id}-root"><label class="amcp-label" for="${id}">${label}${required && html`<span class="amcp-required" aria-hidden="true">*</span>`}</label><div class="amcp-combobox-anchor"><div${AmcpUI.attrs({class: 'amcp-control', 'data-state': error ? 'error' : false})}><input${AmcpUI.attrs({class: 'amcp-input', id, type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id + '-listbox', 'aria-haspopup': 'listbox', 'aria-describedby': amcpDescribed({id, hint, error}), 'aria-required': required ? 'true' : false, 'aria-invalid': error ? 'true' : false, autocomplete: 'off', placeholder, disabled: !!disabled})}><input type="hidden"${AmcpUI.attrs({name})}><span class="amcp-spinner" aria-hidden="true" hidden></span><button type="button" class="amcp-combobox-toggle" tabindex="-1" aria-label="${uiText('Show options')}" aria-controls="${id}-listbox"${AmcpUI.attrs({disabled: !!disabled})}>${AmcpUI.icon('chevron')}</button></div><div class="amcp-popup" hidden><ul class="amcp-listbox" role="listbox" id="${id}-listbox" aria-label="${label}"></ul><div class="amcp-listbox-note"></div></div></div>${hint && html`<span class="amcp-hint" id="${id}-hint">${hint}</span>`}${error && html`<span class="amcp-error" id="${id}-error" role="alert">${AmcpUI.icon('error')}<span>${error}</span></span>`}<div class="amcp-visually-hidden" role="status" aria-live="polite" id="${id}-status"></div></div>`;
    },
    {filter: amcpComboboxFilter, segments: amcpComboboxSegments, mount: amcpComboboxMount},
  ),
);
AmcpUI.behave('combobox', {
  input(event, host) {
    const state = amcpComboboxes.get(host);
    if (!state || event.target !== state.input) return false;
    state.query = state.input.value;
    state.active = -1;
    state.open = true;
    state.run();
    return true;
  },
  keydown(event, host) {
    const state = amcpComboboxes.get(host);
    if (!state || event.target !== state.input) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.altKey && event.key === 'ArrowDown') {
        if (!state.open) state.openList();
      } else state.move(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (event.key === 'Enter' && state.open && state.active >= 0) {
      event.preventDefault();
      state.choose(state.shown[state.active]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.open) state.close();
      else {
        state.revert();
        state.draw();
      }
      return true;
    }
    return false;
  },
  mousedown(event, host) {
    if (!event.target.closest('.amcp-popup') || !amcpComboboxes.has(host)) return false;
    event.preventDefault();
    return true;
  },
  click(event, host) {
    const state = amcpComboboxes.get(host);
    if (!state) return false;
    const option = event.target.closest('.amcp-option');
    if (option) {
      state.choose(state.shown[Number(option.getAttribute('data-index'))]);
      state.input.focus();
      return true;
    }
    if (event.target.closest('.amcp-combobox-toggle')) {
      if (state.open) state.close();
      else state.openList(true);
      state.input.focus();
      return true;
    }
    if (event.target.closest('[data-combobox-clear]')) {
      state.input.value = '';
      state.query = '';
      state.run();
      state.input.focus();
      return true;
    }
    if (event.target.closest('[data-combobox-retry]')) {
      state.run();
      return true;
    }
    return false;
  },
  focusout(event, host) {
    const state = amcpComboboxes.get(host);
    if (!state || (event.relatedTarget && host.contains(event.relatedTarget))) return false;
    state.revert();
    state.close();
    return false;
  },
});

// Tree with tri-state checkboxes: the scope picker. A parent is checked when every selectable leaf under it is, mixed when
// some are; checking a parent checks (or clears) them all. Disabled leaves are never checked and do not count.
const amcpTreeKids = node => node.children ?? [];
/** Selectable leaves under a node (a disabled node hides its whole subtree from the count). */
function amcpTreeLeaves(node) {
  if (node.disabled) return [];
  return amcpTreeKids(node).length ? amcpTreeKids(node).flatMap(amcpTreeLeaves) : [node.id];
}
function amcpTreeStates(nodes, checked) {
  const out = new Map(),
    visit = node => {
      const leaves = amcpTreeLeaves(node),
        on = leaves.filter(leaf => checked.has(leaf)).length;
      out.set(node.id, leaves.length && on === leaves.length ? 'true' : on ? 'mixed' : 'false');
      amcpTreeKids(node).forEach(visit);
    };
  nodes.forEach(visit);
  return out;
}
function amcpTreeToggle(nodes, checked, id) {
  const find = list => {
    for (const node of list) {
      if (node.id === id) return node;
      const inner = find(amcpTreeKids(node));
      if (inner) return inner;
    }
    return null;
  };
  const node = find(nodes),
    next = new Set(checked);
  if (!node) return next;
  const leaves = amcpTreeLeaves(node),
    all = leaves.length > 0 && leaves.every(leaf => checked.has(leaf));
  for (const leaf of leaves)
    if (all) next.delete(leaf);
    else next.add(leaf);
  return next;
}
function amcpTreeVisible(nodes, expanded) {
  const out = [],
    visit = (list, level, parent) =>
      list.forEach((node, index) => {
        out.push({
          id: node.id,
          level,
          posinset: index + 1,
          setsize: list.length,
          parent,
          hasChildren: amcpTreeKids(node).length > 0,
          label: node.label,
          disabled: !!node.disabled,
        });
        if (expanded.has(node.id)) visit(amcpTreeKids(node), level + 1, node.id);
      });
  visit(nodes, 1, null);
  return out;
}
function amcpTreeKeyAction({key, id, nodes, expanded, rtl = false}) {
  const items = amcpTreeVisible(nodes, expanded),
    at = items.findIndex(item => item.id === id),
    item = items[at];
  if (!item) return null;
  const focus = target => (target && target.id !== id ? {type: 'focus', id: target.id} : null),
    open = expanded.has(id) && item.hasChildren,
    forward = rtl ? 'ArrowLeft' : 'ArrowRight',
    back = rtl ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return focus(items[at + 1]);
    case 'ArrowUp':
      return focus(items[at - 1]);
    case 'Home':
      return focus(items[0]);
    case 'End':
      return focus(items.at(-1));
    case forward:
      if (!item.hasChildren) return null;
      return open ? focus(items[at + 1]) : {type: 'expand', id};
    case back:
      if (open) return {type: 'collapse', id};
      return item.parent ? {type: 'focus', id: item.parent} : null;
    case ' ':
    case 'Enter':
      return {type: 'toggle', id};
    case '*':
      return {type: 'expandSiblings', id};
    default: {
      if (key.length !== 1 || !/\p{L}/u.test(key)) return null;
      const lead = amcpFold(key),
        order = [...items.slice(at + 1), ...items.slice(0, at)];
      return focus(order.find(other => amcpFolded(other.label).folded.startsWith(lead)));
    }
  }
}
const amcpTrees = new WeakMap();
function amcpTreeItems(state, id) {
  const states = amcpTreeStates(state.nodes, state.checked);
  const draw = (list, level) =>
    list.map((node, index) => {
      const kids = amcpTreeKids(node),
        open = kids.length > 0 && state.expanded.has(node.id),
        mark = states.get(node.id);
      return html`<li${AmcpUI.attrs({class: 'amcp-tree-item', role: 'treeitem', id: id + '-node-' + node.id, 'data-node': node.id, 'aria-level': level, 'aria-setsize': list.length, 'aria-posinset': index + 1, 'aria-expanded': kids.length ? String(open) : false, 'aria-checked': mark, 'aria-disabled': node.disabled ? 'true' : false, tabindex: node.id === state.active ? '0' : '-1'})}><div class="amcp-tree-row"><span class="amcp-tree-expander" aria-hidden="true">${kids.length > 0 && AmcpUI.icon('next')}</span><span class="amcp-tree-box" data-checked="${mark}" aria-hidden="true">${mark === 'true' ? AmcpUI.icon('check') : mark === 'mixed' ? AmcpUI.icon('minus') : false}</span><span class="amcp-tree-label"><bdi>${node.label}</bdi></span>${node.meta && html`<span class="amcp-tree-meta"><bdi>${node.meta}</bdi></span>`}</div>${open && html`<ul role="group">${draw(kids, level + 1)}</ul>`}</li>`;
    });
  return html`${draw(state.nodes, 1)}`;
}
function amcpTreeMount(host, {nodes, checked = [], expanded = [], onChange} = {}) {
  const list = host.querySelector('[role=tree]'),
    id = host.id,
    state = {nodes, checked: new Set(checked), expanded: new Set(expanded), active: null, onChange};
  state.active = amcpTreeVisible(nodes, state.expanded)[0]?.id ?? null;
  const item = node => [...list.querySelectorAll('[data-node]')].find(el => el.getAttribute('data-node') === node);
  const draw = (focus = false) => {
    if (!amcpTreeVisible(state.nodes, state.expanded).some(entry => entry.id === state.active))
      state.active = amcpTreeVisible(state.nodes, state.expanded)[0]?.id ?? null;
    setHtml(list, amcpTreeItems(state, id));
    if (focus) item(state.active)?.focus();
  };
  const activate = (node, focus = true) => {
    state.active = node;
    for (const el of list.querySelectorAll('[role=treeitem]'))
      el.setAttribute('tabindex', el.getAttribute('data-node') === node ? '0' : '-1');
    if (focus) item(node)?.focus();
  };
  const toggle = node => {
    const next = amcpTreeToggle(state.nodes, state.checked, node);
    if (next.size === state.checked.size && [...next].every(leaf => state.checked.has(leaf))) return;
    state.checked = next;
    draw(true);
    AmcpUI.emit(host, 'amcp-change', {id: node, checkedIds: [...next].sort()});
    state.onChange?.([...next].sort());
  };
  Object.assign(state, {draw, activate, toggle, item});
  amcpTrees.set(host, state);
  draw();
  return Object.freeze({
    checked: () => [...state.checked].sort(),
    setChecked(next) {
      state.checked = new Set(next);
      draw();
    },
    destroy: () => amcpTrees.delete(host),
  });
}
AmcpUI.define(
  'tree',
  Object.assign(
    ({id = AmcpUI.uid('tree'), label, nodes, checked = [], expanded = []}) => {
      amcpNeed(label, 'AMCP_UI_LABEL');
      const state = {
        nodes,
        checked: new Set(checked),
        expanded: new Set(expanded),
        active: amcpTreeVisible(nodes, new Set(expanded))[0]?.id ?? null,
      };
      return html`<div class="amcp-tree" data-amcp="tree" id="${id}"><ul class="amcp-tree-list" role="tree" aria-label="${label}" aria-multiselectable="true">${amcpTreeItems(state, id)}</ul></div>`;
    },
    {
      states: amcpTreeStates,
      toggle: amcpTreeToggle,
      visible: amcpTreeVisible,
      keyAction: amcpTreeKeyAction,
      mount: amcpTreeMount,
    },
  ),
);
AmcpUI.behave('tree', {
  keydown(event, host) {
    const state = amcpTrees.get(host),
      row = event.target.closest('[role=treeitem]');
    if (!state || !row || event.ctrlKey || event.metaKey || event.altKey) return false;
    const id = row.getAttribute('data-node'),
      action = amcpTreeKeyAction({
        key: event.key,
        id,
        nodes: state.nodes,
        expanded: state.expanded,
        rtl: getComputedStyle(host).direction === 'rtl',
      });
    if (!action) return false;
    event.preventDefault();
    if (action.type === 'focus') state.activate(action.id);
    else if (action.type === 'toggle') {
      if (!row.hasAttribute('aria-disabled')) state.toggle(id);
    } else if (action.type === 'expandSiblings') {
      const entries = amcpTreeVisible(state.nodes, state.expanded),
        parent = entries.find(entry => entry.id === id)?.parent;
      for (const sibling of entries)
        if (sibling.parent === parent && sibling.hasChildren) state.expanded.add(sibling.id);
      state.draw(true);
    } else {
      if (action.type === 'expand') state.expanded.add(id);
      else state.expanded.delete(id);
      state.draw(true);
    }
    return true;
  },
  click(event, host) {
    const state = amcpTrees.get(host),
      row = event.target.closest('[role=treeitem]');
    if (!state || !row) return false;
    const id = row.getAttribute('data-node');
    state.active = id;
    if (event.target.closest('.amcp-tree-expander')) {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      state.draw(true);
    } else if (event.target.closest('.amcp-tree-box, .amcp-tree-label') && !row.hasAttribute('aria-disabled'))
      state.toggle(id);
    else state.activate(id);
    return true;
  },
});
