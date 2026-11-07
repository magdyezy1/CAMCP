'use strict';
// V2-WEB-02: overlays (web/components.js is the core). A dialog is a native dialog element opened with showModal() in a portal at
// the end of the body, so the browser's top layer, Escape and focus containment apply, and the rest of the page is also
// marked inert and the Tab key is kept inside, because that is what the page promises. Closing returns focus to what opened
// it. A side sheet is the same panel at an edge, modal or not. Toasts are stacked in a polite live region that never takes
// focus, and wait while the pointer or the keyboard is on them.
const amcpFocusable =
  'button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const amcpDialogs = new WeakMap();
let amcpPortalElement = null;
function amcpPortal() {
  if (!amcpPortalElement?.isConnected) {
    amcpPortalElement = document.createElement('div');
    amcpPortalElement.setAttribute('data-amcp-portal', '');
    document.body.append(amcpPortalElement);
    AmcpUI.bind(amcpPortalElement);
  }
  return amcpPortalElement;
}
function amcpOpenPanel(kind, config) {
  const {
    title,
    body,
    actions = [],
    size = 'md',
    side = 'end',
    modal = true,
    dismissible = true,
    role,
    id = AmcpUI.uid(kind),
  } = config;
  amcpNeed(title, 'AMCP_UI_TITLE');
  amcpChoose(size, ['sm', 'md'], 'AMCP_UI_SIZE');
  amcpChoose(side, ['start', 'end'], 'AMCP_UI_SIDE');
  if (role !== undefined) amcpChoose(role, ['dialog', 'alertdialog'], 'AMCP_UI_ROLE');
  const portal = amcpPortal(),
    trigger = document.activeElement,
    holder = document.createElement('div');
  setHtml(
    holder,
    html`<dialog aria-labelledby="${id}-title" aria-describedby="${id}-body"${AmcpUI.attrs({class: 'amcp-dialog', id, 'data-kind': kind, 'data-size': size, 'data-side': kind === 'sheet' ? side : false, 'data-modal': String(modal), role})}><div class="amcp-dialog-panel" data-amcp="dialog"><header class="amcp-dialog-header"><h2 class="amcp-dialog-title" id="${id}-title">${title}</h2>${AmcpUI.iconButton({icon: 'close', label: uiText('Close'), attrs: {'data-dialog-close': ''}})}</header><div class="amcp-dialog-body" id="${id}-body">${body}</div><div class="amcp-dialog-error" role="alert" hidden></div>${actions.length > 0 && html`<footer class="amcp-dialog-actions">${actions.map(action => AmcpUI.button({variant: 'secondary', ...action, attrs: {...action.attrs, 'data-dialog-action': action.value ?? action.label, 'data-initial': !!action.initial, 'data-keep-open': !!action.keepOpen}}))}</footer>`}</div></dialog>`,
  );
  const element = holder.firstElementChild,
    panel = element.querySelector('[data-amcp=dialog]'),
    error = element.querySelector('.amcp-dialog-error'),
    covered = modal ? [...document.body.children].filter(el => el !== portal && !el.inert) : [];
  let settle;
  const closed = new Promise(resolve => (settle = resolve)),
    controller = Object.freeze({
      element,
      closed,
      close: (value = 'dismiss') => element.close(value),
      setLoading(on) {
        if (on) panel.setAttribute('aria-busy', 'true');
        else panel.removeAttribute('aria-busy');
        for (const button of panel.querySelectorAll('.amcp-dialog-actions button')) button.disabled = !!on;
      },
      setError(message) {
        error.hidden = !message;
        setHtml(error, message ? html`${AmcpUI.icon('error')}<span>${message}</span>` : html``);
      },
    });
  amcpDialogs.set(element, {controller, dismissible, modal});
  portal.append(element);
  for (const el of covered) el.inert = true;
  element.addEventListener('cancel', event => {
    if (dismissible) element.returnValue = 'dismiss';
    else event.preventDefault();
  });
  element.addEventListener('click', event => {
    if (event.target === element && dismissible) controller.close('dismiss');
  });
  element.addEventListener('close', () => {
    for (const el of covered) el.inert = false;
    const answer = element.returnValue || 'dismiss';
    element.remove();
    amcpDialogs.delete(element);
    if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
    settle(answer);
  });
  if (modal) element.showModal();
  else element.show();
  const first =
    element.querySelector('[data-initial]') ??
    element.querySelector('.amcp-dialog-body ' + amcpFocusable.split(', ').join(', .amcp-dialog-body ')) ??
    element.querySelector('.amcp-dialog-actions button') ??
    element.querySelector('[data-dialog-close]');
  first?.focus();
  return controller;
}
AmcpUI.define('dialog', {open: config => amcpOpenPanel('dialog', config)});
AmcpUI.define('sheet', {open: config => amcpOpenPanel('sheet', config)});
AmcpUI.behave('dialog', {
  click(event, host) {
    const element = host.closest('dialog'),
      state = amcpDialogs.get(element);
    if (!state) return false;
    if (event.target.closest('[data-dialog-close]')) {
      state.controller.close('dismiss');
      return true;
    }
    const action = event.target.closest('[data-dialog-action]');
    if (!action || action.disabled) return false;
    const value = action.getAttribute('data-dialog-action');
    if (action.hasAttribute('data-keep-open')) AmcpUI.emit(host, 'amcp-action', {value});
    else state.controller.close(value);
    return true;
  },
  keydown(event, host) {
    const element = host.closest('dialog'),
      state = amcpDialogs.get(element);
    if (!state) return false;
    if (event.key === 'Escape' && !state.modal) {
      event.preventDefault();
      if (state.dismissible) state.controller.close('dismiss');
      return true;
    }
    if (event.key !== 'Tab') return false;
    const controls = [...host.querySelectorAll(amcpFocusable)].filter(control => !control.closest('[hidden]')),
      edge = event.shiftKey ? controls[0] : controls.at(-1),
      active = document.activeElement;
    if (!controls.length || active !== edge) return false;
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0]).focus();
    return true;
  },
});

// Toasts: a polite list in a labelled region. Success and info leave on their own; warning and danger stay until dismissed.
const amcpToastTones = {success: 'check', info: 'info', warning: 'warning', danger: 'error'},
  amcpToasts = new WeakMap();
AmcpUI.define('toasts', {
  mount(host, {duration = 6000, limit = 3} = {}) {
    setHtml(
      host,
      html`<div class="amcp-toasts" data-amcp="toasts" role="region" aria-label="${uiText('Notifications')}"><ol class="amcp-toast-list" aria-live="polite" aria-relevant="additions"></ol></div>`,
    );
    const root = host.querySelector('.amcp-toasts'),
      list = root.querySelector('ol'),
      entries = new Map();
    let count = 0;
    const arm = entry => {
      clearTimeout(entry.timer);
      if (!entry.persistent) entry.timer = setTimeout(() => remove(entry.id), entry.duration);
    };
    const remove = id => {
      const entry = entries.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      const focused = entry.element.contains(document.activeElement);
      entries.delete(id);
      entry.element.remove();
      if (focused && entry.restore?.isConnected) entry.restore.focus();
    };
    const state = {entries, arm, remove};
    amcpToasts.set(root, state);
    AmcpUI.bind(root);
    return Object.freeze({
      show({tone = 'info', message, title, action, persistent, duration: own}) {
        amcpChoose(tone, Object.keys(amcpToastTones), 'AMCP_UI_TONE');
        amcpNeed(message, 'AMCP_UI_MESSAGE');
        const id = 'toast-' + ++count,
          holder = document.createElement('div');
        setHtml(
          holder,
          html`<li class="amcp-toast" data-tone="${tone}" data-toast="${id}">${AmcpUI.icon(amcpToastTones[tone], 'amcp-toast-icon')}<div class="amcp-toast-body">${title && html`<strong class="amcp-toast-title">${title}</strong>`}<span>${message}</span></div>${action && AmcpUI.button({variant: 'quiet', size: 'sm', ...action})}${AmcpUI.iconButton({icon: 'close', label: uiText('Dismiss'), size: 'sm', attrs: {'data-toast-dismiss': ''}})}</li>`,
        );
        const element = holder.firstElementChild,
          entry = {
            id,
            element,
            persistent: persistent ?? (tone === 'warning' || tone === 'danger'),
            duration: own ?? duration,
            restore: document.activeElement?.closest?.('.amcp-toasts') ? null : document.activeElement,
            timer: null,
          };
        entries.set(id, entry);
        list.append(element);
        arm(entry);
        while (entries.size > limit) {
          remove(entries.keys().next().value);
        }
        return id;
      },
      dismiss: remove,
      clear() {
        for (const id of [...entries.keys()]) remove(id);
      },
    });
  },
});
/** The pointer or the keyboard is on a toast: its timer stops. */
function amcpToastHold(event, host) {
  const toast = event.target.closest('[data-toast]');
  if (toast) clearTimeout(amcpToasts.get(host)?.entries.get(toast.getAttribute('data-toast'))?.timer);
  return false;
}
/** Both have left a toast: its full duration starts again. */
function amcpToastRelease(event, host) {
  const state = amcpToasts.get(host),
    toast = event.target.closest('[data-toast]');
  if (!state || !toast || (event.relatedTarget && toast.contains(event.relatedTarget))) return false;
  const entry = state.entries.get(toast.getAttribute('data-toast'));
  if (entry && !toast.contains(document.activeElement)) state.arm(entry);
  return false;
}
AmcpUI.behave('toasts', {
  click(event, host) {
    const state = amcpToasts.get(host);
    const dismiss = event.target.closest('[data-toast-dismiss]');
    if (!state || !dismiss) return false;
    state.remove(dismiss.closest('[data-toast]').getAttribute('data-toast'));
    return true;
  },
  keydown(event, host) {
    const state = amcpToasts.get(host),
      toast = event.target.closest('[data-toast]');
    if (!state || !toast || event.key !== 'Escape') return false;
    event.preventDefault();
    state.remove(toast.getAttribute('data-toast'));
    return true;
  },
  mouseover: amcpToastHold,
  focusin: amcpToastHold,
  mouseout: amcpToastRelease,
  focusout: amcpToastRelease,
});
