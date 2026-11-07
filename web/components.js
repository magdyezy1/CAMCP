'use strict';
// V2-WEB-02: the component layer (docs/DESIGN-SYSTEM.md). One namespace, AmcpUI, in the site's style: a classic script, no
// build step, markup written with the escape-by-default html`…` tag and nothing else (no innerHTML, no raw()). A component
// is a function that returns html`…`; the interactive ones add a delegated behaviour that AmcpUI.bind(root) attaches once
// to a page's root, so rendering and re-rendering never leaks listeners. Styles are web/components.css, from tokens only.
// This file holds the core and the simple components; controls, table and overlays are in the files beside it.
const AmcpUI = (() => {
  let sequence = 0;
  const behaviors = new Map(),
    bound = new WeakSet(),
    delegated = ['click', 'keydown', 'input', 'change', 'focusin', 'focusout', 'mousedown', 'mouseover', 'mouseout'];
  const ui = {
    /** A unique id for a control and the text that describes it. */
    uid: (prefix = 'amcp') => prefix + '-' + ++sequence,
    /** Registers a component once and freezes it. */
    define(name, component) {
      if (Object.hasOwn(ui, name)) throw Error('AMCP_UI_ALREADY_DEFINED: ' + name);
      ui[name] = Object.freeze(component);
      return ui[name];
    },
    /** Registers the delegated handlers of a component host ([data-amcp="name"]); a handler returns true when it is done. */
    behave(name, handlers) {
      if (behaviors.has(name)) throw Error('AMCP_UI_ALREADY_DEFINED: behaviour ' + name);
      behaviors.set(name, Object.freeze({...handlers}));
    },
    /** Attaches the delegated behaviours to a root, once: the nearest host that handles an event wins. */
    bind(root) {
      if (bound.has(root)) return root;
      bound.add(root);
      for (const type of delegated)
        root.addEventListener(type, event => {
          for (
            let host = event.target?.closest?.('[data-amcp]');
            host && root.contains(host);
            host = host.parentElement?.closest('[data-amcp]')
          )
            if (behaviors.get(host.dataset.amcp)?.[type]?.(event, host) === true) return;
        });
      return root;
    },
    /** Tells the page something changed in a component: a bubbling amcp-* event with its detail. */
    emit(host, name, detail) {
      host.dispatchEvent(new CustomEvent(name, {bubbles: true, detail}));
    },
    classes: (...parts) => parts.filter(Boolean).join(' '),
    /** Attributes as markup: false, null and undefined are left out, true is a bare attribute. Names are authored here. */
    attrs(map = {}) {
      return Object.entries(map)
        .filter(([, value]) => value !== false && value !== null && value !== undefined)
        .map(([name, value]) => {
          if (!/^[a-z][a-z0-9:-]*$/.test(name) || /^(?:on|style$)/.test(name))
            throw Error('AMCP_UI_ATTRIBUTE_NAME: ' + name);
          return html` ${name}="${value === true ? '' : value}"`;
        });
    },
    visuallyHidden: text => html`<span class="amcp-visually-hidden">${text}</span>`,
    spinner: () => html`<span class="amcp-spinner" aria-hidden="true"></span>`,
  };
  return ui;
})();

/** The value when it is one of the allowed words, or a refusal that names the code. */
function amcpChoose(value, allowed, code) {
  if (!allowed.includes(value)) throw Error(code + ': ' + value);
  return value;
}
function amcpNeed(value, code) {
  if (value === undefined || value === null || value === '') throw Error(code);
  return value;
}

// Icons: one 24px grid, drawn with the text colour; decoration beside words, so hidden from assistive technology.
const amcpIcons = Object.freeze({
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  minus: 'M6 12h12',
  plus: 'M12 6v12M6 12h12',
  chevron: 'M6 9l6 6 6-6',
  next: 'M9 6l6 6-6 6',
  info: 'M12 11v5M12 8h.01M12 3a9 9 0 100 18 9 9 0 000-18z',
  warning: 'M12 4l9.5 16h-19zM12 10v4M12 17h.01',
  error: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9 9l6 6M15 9l-6 6',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l5 5',
  dot: 'M12 9a3 3 0 100 6 3 3 0 000-6z',
});
AmcpUI.define(
  'icon',
  Object.assign(
    (name, extra = '') => {
      if (!Object.hasOwn(amcpIcons, name)) throw Error('AMCP_UI_ICON: ' + name);
      return html`<svg class="amcp-icon ${extra}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${AmcpUI.attrs({'data-mirror': name === 'next'})}><path d="${amcpIcons[name]}"/></svg>`;
    },
    {names: Object.freeze(Object.keys(amcpIcons))},
  ),
);

// Buttons: four variants, three sizes. A primary button is at least 44px high whatever its size; the others reach 24px or
// more (tokens). A busy button is disabled and says so (aria-busy), so it cannot be pressed twice.
const amcpButtonVariants = ['primary', 'secondary', 'quiet', 'danger'],
  amcpButtonSizes = ['sm', 'md', 'lg'];
function amcpButton({
  label,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  disabled = false,
  loading = false,
  loadingLabel,
  href,
  id,
  pressed,
  expanded,
  controls,
  state,
  icon,
  iconOnly = false,
  attrs = {},
}) {
  amcpNeed(label, 'AMCP_UI_LABEL');
  amcpChoose(variant, amcpButtonVariants, 'AMCP_UI_VARIANT');
  amcpChoose(size, amcpButtonSizes, 'AMCP_UI_SIZE');
  const busy = !!loading,
    inactive = !!disabled || busy,
    shown = busy && loadingLabel ? loadingLabel : label,
    common = {
      class: AmcpUI.classes('amcp-button', iconOnly && 'amcp-icon-button'),
      'data-variant': variant,
      'data-size': size,
      'data-loading': busy,
      'data-state': state,
      id,
      'aria-busy': busy ? 'true' : false,
      'aria-pressed': pressed === undefined ? false : String(!!pressed),
      'aria-expanded': expanded === undefined ? false : String(!!expanded),
      'aria-controls': controls,
      'aria-label': iconOnly ? label : false,
      ...attrs,
    },
    content = html`${busy && AmcpUI.spinner()}${icon && AmcpUI.icon(icon)}${!iconOnly && html`<span class="amcp-button-label">${shown}</span>`}`;
  return href === undefined
    ? html`<button${AmcpUI.attrs({...common, type, disabled: inactive})}>${content}</button>`
    : html`<a${AmcpUI.attrs({...common, href: inactive ? false : href, 'aria-disabled': inactive ? 'true' : false, tabindex: inactive ? '-1' : false})}>${content}</a>`;
}
AmcpUI.define('button', amcpButton);
AmcpUI.define('iconButton', ({icon, label, variant = 'quiet', size = 'md', ...rest}) => {
  amcpNeed(label, 'AMCP_UI_LABEL');
  return amcpButton({...rest, label, variant, size, icon, iconOnly: true});
});

// One badge replaces the four of the old pages (docs/DESIGN-SYSTEM.md lists them). A status tone always has an icon and
// its word, so colour is never the only cue; peach is a marker beside the word, never a surface behind it.
const amcpBadgeTones = ['neutral', 'success', 'warning', 'danger', 'info', 'marker'],
  amcpBadgeIcons = {success: 'check', warning: 'warning', danger: 'error', info: 'info'};
AmcpUI.define(
  'badge',
  Object.assign(
    ({label, tone = 'neutral', title}) => {
      amcpNeed(label, 'AMCP_UI_LABEL');
      amcpChoose(tone, amcpBadgeTones, 'AMCP_UI_TONE');
      return html`<span class="amcp-badge" data-tone="${tone}"${AmcpUI.attrs({title})}>${amcpBadgeIcons[tone] && AmcpUI.icon(amcpBadgeIcons[tone])}${tone === 'marker' && html`<span class="amcp-marker" aria-hidden="true"></span>`}<span>${label}</span></span>`;
    },
    {
      // The old page classes and the tone each becomes (the old pages keep their own CSS in this package).
      legacy: Object.freeze({
        status: 'neutral',
        'status online': 'success',
        'status attention': 'warning',
        'status offline': 'neutral',
        'status error': 'danger',
        'default-badge': 'info',
        'creative-tag': 'neutral',
        'measurement-ledger-state': 'info',
      }),
    },
  ),
);

// Filter chips are toggle buttons in a labelled group: they say "pressed" (aria-pressed), and a page reads the change from
// the amcp-change event. Removable chips (input chips) name what they remove and hand focus to a neighbour.
AmcpUI.define('chips', ({label, chips, mode = 'multi', removable = false, id = AmcpUI.uid('chips')}) => {
  amcpNeed(label, 'AMCP_UI_LABEL');
  amcpChoose(mode, ['multi', 'single'], 'AMCP_UI_MODE');
  return html`<div class="amcp-chips" data-amcp="chips" data-mode="${mode}" role="group" aria-label="${label}" id="${id}" tabindex="-1">${chips.map(
    chip =>
      removable
        ? html`<span class="amcp-chip" data-removable><span>${chip.label}</span><button type="button" class="amcp-chip-remove" data-chip-remove="${chip.id}" aria-label="${uiText('Remove {label}', {label: chip.label})}">${AmcpUI.icon('close')}</button></span>`
        : html`<button type="button" class="amcp-chip" data-chip="${chip.id}" aria-pressed="${String(!!chip.pressed)}"${AmcpUI.attrs({disabled: !!chip.disabled})}><span>${chip.label}</span>${chip.count !== undefined && html`<span class="amcp-chip-count">${chip.count}</span>`}</button>`,
  )}</div>`;
});
AmcpUI.behave('chips', {
  click(event, host) {
    const remove = event.target.closest('[data-chip-remove]');
    if (remove) {
      const all = [...host.querySelectorAll('.amcp-chip')],
        chip = remove.closest('.amcp-chip'),
        index = all.indexOf(chip),
        id = remove.getAttribute('data-chip-remove');
      chip.remove();
      const left = [...host.querySelectorAll('.amcp-chip')];
      (left[index] ?? left[index - 1])?.querySelector('button')?.focus();
      if (!left.length) host.focus();
      AmcpUI.emit(host, 'amcp-remove', {
        id,
        remainingIds: left.map(c => c.querySelector('[data-chip-remove]').getAttribute('data-chip-remove')),
      });
      return true;
    }
    const chip = event.target.closest('button[data-chip]');
    if (!chip || chip.disabled) return false;
    const single = host.getAttribute('data-mode') === 'single',
      wasPressed = chip.getAttribute('aria-pressed') === 'true';
    if (single && wasPressed) return true;
    if (single)
      for (const other of host.querySelectorAll('button[data-chip]')) other.setAttribute('aria-pressed', 'false');
    chip.setAttribute('aria-pressed', String(single ? true : !wasPressed));
    AmcpUI.emit(host, 'amcp-change', {
      id: chip.getAttribute('data-chip'),
      pressed: chip.getAttribute('aria-pressed') === 'true',
      pressedIds: [...host.querySelectorAll('button[data-chip][aria-pressed=true]')].map(c =>
        c.getAttribute('data-chip'),
      ),
    });
    return true;
  },
});

// Fields: a label, the control, a hint and an error, linked by ids. An error is words plus an icon (never colour alone),
// announced when it appears (role="alert"), and marks the control invalid. State lives on the wrapper's border, not the
// native control's, so the dark layer's rules for input, select and textarea cannot hide it.
const amcpInputTypes = ['text', 'search', 'number', 'date', 'email', 'url', 'password'];
function amcpField({id, label, hint, error, required, control, state, loading}) {
  amcpNeed(id, 'AMCP_UI_ID');
  amcpNeed(label, 'AMCP_UI_LABEL');
  return html`<div class="amcp-field"><label class="amcp-label" for="${id}">${label}${required && html`<span class="amcp-required" aria-hidden="true">*</span>`}</label><div${AmcpUI.attrs({class: 'amcp-control', 'data-state': error ? 'error' : state, 'aria-busy': loading ? 'true' : false})}>${control}${loading && AmcpUI.spinner()}</div>${hint && html`<span class="amcp-hint" id="${id}-hint">${hint}</span>`}${error && html`<span class="amcp-error" id="${id}-error" role="alert">${AmcpUI.icon('error')}<span>${error}</span></span>`}</div>`;
}
const amcpDescribed = ({id, hint, error}) =>
  [hint && id + '-hint', error && id + '-error'].filter(Boolean).join(' ') || false;
AmcpUI.define(
  'input',
  ({
    id,
    label,
    type = 'text',
    value,
    hint,
    error,
    required,
    disabled,
    readonly,
    loading,
    state,
    name,
    placeholder,
    min,
    max,
    step,
    autocomplete,
    attrs = {},
  }) => {
    amcpChoose(type, amcpInputTypes, 'AMCP_UI_TYPE');
    // A number is typed as text so its digits stay exact (no float conversion, no locale digits): see AmcpUI.decimal.
    const number = type === 'number';
    return amcpField({
      id,
      label,
      hint,
      error,
      required,
      state,
      loading,
      control: html`<input${AmcpUI.attrs({
        class: 'amcp-input',
        id,
        name,
        type: number ? 'text' : type,
        inputmode: number ? 'decimal' : false,
        dir: number ? 'ltr' : false,
        autocomplete: number ? 'off' : autocomplete,
        'data-amcp-kind': number ? 'number' : false,
        value,
        placeholder,
        min,
        max,
        step,
        required: false,
        'aria-required': required ? 'true' : false,
        'aria-invalid': error ? 'true' : false,
        'aria-describedby': amcpDescribed({id, hint, error}),
        disabled: !!disabled,
        readonly: !!readonly,
        ...attrs,
      })}>`,
    });
  },
);
AmcpUI.define(
  'select',
  ({id, label, options, value, hint, error, required, disabled, loading, state, name, attrs = {}}) =>
    amcpField({
      id,
      label,
      hint,
      error,
      required,
      state,
      loading,
      control: html`<select${AmcpUI.attrs({class: 'amcp-select', id, name, 'aria-required': required ? 'true' : false, 'aria-invalid': error ? 'true' : false, 'aria-describedby': amcpDescribed({id, hint, error}), disabled: !!disabled, ...attrs})}>${options.map(
        option =>
          html`<option${AmcpUI.attrs({value: option.value, selected: option.selected ?? option.value === value, disabled: !!option.disabled})}>${option.label}</option>`,
      )}</select><span class="amcp-caret" aria-hidden="true">${AmcpUI.icon('chevron')}</span>`,
    }),
);
AmcpUI.define('checkbox', ({id, label, checked = false, mixed = false, disabled = false, name, value, attrs = {}}) => {
  amcpNeed(id, 'AMCP_UI_ID');
  amcpNeed(label, 'AMCP_UI_LABEL');
  return html`<span class="amcp-check"><input${AmcpUI.attrs({class: 'amcp-checkbox', type: 'checkbox', id, name, value, checked: !!checked, 'data-mixed': mixed ? 'true' : false, disabled: !!disabled, ...attrs})}><label for="${id}">${label}</label></span>`;
});
/** An exact decimal from what a person typed: separators of thousands dropped, Latin digits only, no exponent. */
AmcpUI.define('decimal', text => {
  const typed = String(text ?? '').trim();
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(typed)) return {valid: true, value: typed.replaceAll(',', '')};
  return {valid: /^-?\d+(?:\.\d+)?$/.test(typed), value: typed};
});

// Progress is determinate only when the value is known; unknown is shown as in progress, never as 0%.
function amcpPercent(value, max = 100) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  return Math.round((Math.min(Math.max(value, 0), max) / max) * 100);
}
AmcpUI.define(
  'progress',
  Object.assign(
    ({label, value, max = 100, text, tone, id = AmcpUI.uid('progress')}) => {
      amcpNeed(label, 'AMCP_UI_LABEL');
      const percent = amcpPercent(value, max);
      return html`<div class="amcp-progress-row"><span class="amcp-progress-label" id="${id}-label">${label}</span><span class="amcp-progress-value">${text ?? (percent === null ? uiText('In progress') : uiNumber(percent) + '%')}</span><progress${AmcpUI.attrs({class: 'amcp-progress', 'aria-labelledby': id + '-label', max: percent === null ? false : max, value: percent === null ? false : Math.min(Math.max(value, 0), max), 'data-tone': tone})}></progress></div>`;
    },
    {percent: amcpPercent},
  ),
);

// Skeleton: one busy status that says "Loading…" once; the blocks are decoration and do not shimmer under reduced motion.
const amcpShapes = ['text', 'title', 'card', 'row', 'avatar'];
AmcpUI.define('skeleton', ({shape = 'text', lines = 1, label = uiText('Loading…')}) => {
  amcpChoose(shape, amcpShapes, 'AMCP_UI_SHAPE');
  const count = shape === 'text' ? Math.max(1, Math.min(lines, 12)) : 1;
  return html`<div class="amcp-skeleton-group" role="status" aria-busy="true">${AmcpUI.visuallyHidden(label)}${Array.from({length: count}, (_, index) => html`<span class="amcp-skeleton" data-shape="${shape}" data-last="${index === count - 1 && count > 1}" aria-hidden="true"></span>`)}</div>`;
});

// Empty and error states. An empty state always offers one next action; an error state always offers a way on.
const amcpAction = (action, variant) => amcpButton({variant, ...action, href: action.href, attrs: action.attrs ?? {}});
AmcpUI.define('emptyState', ({title, body, action, level = 3, icon}) => {
  amcpNeed(title, 'AMCP_UI_TITLE');
  if (!action?.label) throw Error('AMCP_UI_EMPTY_STATE_NEEDS_ACTION');
  const id = AmcpUI.uid('state'),
    tag = 'h' + amcpChoose(level, [2, 3, 4], 'AMCP_UI_LEVEL');
  return html`<section class="amcp-state" data-kind="empty" aria-labelledby="${id}">${icon && AmcpUI.icon(icon, 'amcp-state-icon')}${html`<${tag} class="amcp-state-title" id="${id}">${title}</${tag}>`}<div class="amcp-state-body">${body}</div>${amcpAction(action, 'primary')}</section>`;
});
AmcpUI.define('errorState', ({title, body, retry, secondary, reference, details, level = 3}) => {
  amcpNeed(title, 'AMCP_UI_TITLE');
  if (!retry?.label) throw Error('AMCP_UI_ERROR_STATE_NEEDS_RETRY');
  const id = AmcpUI.uid('state'),
    tag = 'h' + amcpChoose(level, [2, 3, 4], 'AMCP_UI_LEVEL');
  return html`<section class="amcp-state" data-kind="error" role="alert" aria-labelledby="${id}">${AmcpUI.icon('error', 'amcp-state-icon')}${html`<${tag} class="amcp-state-title" id="${id}">${title}</${tag}>`}<div class="amcp-state-body">${body}</div><div class="amcp-state-actions">${amcpAction(retry, 'primary')}${secondary && amcpAction(secondary, 'secondary')}</div>${reference && html`<div class="amcp-state-reference">${uiText('Reference')} <code dir="ltr">${reference}</code></div>`}${details && html`<details class="amcp-state-details"><summary>${uiText('Technical details')}</summary><div dir="auto">${details}</div></details>`}</section>`;
});

// Stepper: the order of a task. Each step says its state in words as well as by its marker.
const amcpStepStatus = {
  complete: () => uiText('Completed'),
  current: () => uiText('Current step'),
  upcoming: () => uiText('Not started'),
  error: () => uiText('Needs attention'),
};
AmcpUI.define('stepper', ({label, steps}) => {
  amcpNeed(label, 'AMCP_UI_LABEL');
  return html`<div class="amcp-stepper-wrap"><ol class="amcp-stepper" aria-label="${label}">${steps.map(
    (step, index) => {
      const status = amcpChoose(step.status ?? 'upcoming', Object.keys(amcpStepStatus), 'AMCP_UI_STATUS');
      return html`<li class="amcp-step" data-status="${status}"${AmcpUI.attrs({'aria-current': status === 'current' ? 'step' : false})}><span class="amcp-step-marker" aria-hidden="true">${status === 'complete' ? AmcpUI.icon('check') : status === 'error' ? AmcpUI.icon('warning') : uiNumber(index + 1)}</span><span class="amcp-step-text"><span class="amcp-step-label">${step.label}</span>${AmcpUI.visuallyHidden(amcpStepStatus[status]())}${step.description && html`<span class="amcp-step-description">${step.description}</span>`}</span></li>`;
    },
  )}</ol></div>`;
});

// Cards. A KPI tile is plain large type: a figure of 0 is shown as 0 and a missing figure as a dash with the reason in the
// note, so zero and unknown never look alike.
AmcpUI.define('kpi', ({label, value, unit, note, id = AmcpUI.uid('kpi')}) => {
  amcpNeed(label, 'AMCP_UI_LABEL');
  const missing = value === null || value === undefined || value === '';
  return html`<article class="amcp-card amcp-kpi"${AmcpUI.attrs({'data-state': missing ? 'missing' : false})}><dl><dt><span class="amcp-kpi-label">${label}</span></dt><dd class="amcp-kpi-value"><bdi>${missing ? '—' : value}</bdi>${unit && !missing && html`<span class="amcp-kpi-unit">${unit}</span>`}${missing && AmcpUI.visuallyHidden(uiText('No data'))}</dd></dl>${note && html`<div class="amcp-kpi-note">${note}</div>`}</article>`;
});
AmcpUI.define('platformCard', ({name, status, meta, action}) => {
  amcpNeed(name, 'AMCP_UI_TITLE');
  const id = AmcpUI.uid('platform');
  return html`<article class="amcp-card amcp-platform" aria-labelledby="${id}"><header class="amcp-card-header"><h3 class="amcp-card-title" id="${id}">${name}</h3>${status && AmcpUI.badge(status)}</header>${meta && html`<div class="amcp-card-meta">${meta}</div>`}${action && html`<div class="amcp-card-actions">${amcpAction(action, 'secondary')}</div>`}</article>`;
});
AmcpUI.define(
  'creativeCard',
  ({id, title, meta, mediaLabel, media, selectable = false, selected = false, badges = []}) => {
    amcpNeed(id, 'AMCP_UI_ID');
    amcpNeed(title, 'AMCP_UI_TITLE');
    const control = 'creative-' + id;
    return html`<article class="amcp-card amcp-creative"${AmcpUI.attrs({'data-selected': selected ? 'true' : false})}><div class="amcp-creative-media" role="img" aria-label="${mediaLabel}">${media}</div><div class="amcp-creative-body">${selectable ? AmcpUI.checkbox({id: control, label: title, checked: selected}) : html`<h3 class="amcp-card-title">${title}</h3>`}${meta && html`<div class="amcp-card-meta">${meta}</div>`}${badges.length > 0 && html`<div class="amcp-card-badges">${badges.map(badge => AmcpUI.badge(badge))}</div>`}</div></article>`;
  },
);
