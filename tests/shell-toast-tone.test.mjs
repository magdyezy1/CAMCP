// Package closing-small, item 2 (web-shell report, "Found and not fixed" 3; WCAG 2.2.1 Timing Adjustable): every toast left
// after six seconds, so a failure could vanish before it was read. toast(message, tone) takes an optional tone: 'error'
// reports a failure and stays until the person dismisses it (a labelled Dismiss button; focus is never moved to it; the
// live region is written with the toast and never again), every other toast keeps its six seconds. The real web/app.js
// functions run in a VM with a small fake DOM; the call sites are read from the scripts' syntax trees.
// always-run: lists web/ for the toast calls of every script
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  app = read('app.js'),
  catalog = JSON.parse(read('locales/ar.json'));
const slice = (from, to) => {
  const start = app.indexOf(from),
    end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'web/app.js still defines ' + from);
  return app.slice(start, end);
};

/** The shell's toast in a VM: #toast and the page heading are fake nodes, timers are recorded and fired by hand. */
function fixture({locale = 'en'} = {}) {
  const timers = [],
    document = {activeElement: null},
    nodes = new Map();
  const make = tag => {
    const node = {
      tag,
      hidden: false,
      isConnected: true,
      attributes: {},
      listeners: {},
      writes: 0,
      focused: 0,
      parts: [],
      get textContent() {
        return this.parts.map(part => (typeof part === 'string' ? part : part.textContent)).join('');
      },
      // textContent replaces every child; append adds one: each is one write of the live region's content.
      set textContent(value) {
        this.parts = value === '' ? [] : [String(value)];
        this.writes++;
      },
      append(...items) {
        this.parts.push(...items);
        this.writes++;
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      addEventListener(event, fn) {
        (this.listeners[event] ??= []).push(fn);
      },
      click() {
        for (const fn of this.listeners.click ?? []) fn({currentTarget: this, target: this});
      },
      focus() {
        document.activeElement = this;
        this.focused++;
      },
      button() {
        return this.parts.find(part => typeof part !== 'string' && part.tag === 'button');
      },
    };
    return node;
  };
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, make(selector));
    return nodes.get(selector);
  };
  // index.html ships the toast hidden.
  node('#toast').hidden = true;
  const context = createContext({
    $: node,
    document: {
      get activeElement() {
        return document.activeElement;
      },
      createElement: tag => make(tag),
      querySelectorAll: () => [],
    },
    uiText: text => (locale === 'ar' ? (catalog[text] ?? text) : text),
    // The shell's own (web/app.js, tested in tests/website-navigation.test.mjs): focus on the page heading.
    focusPageHeading: () => node('#content h1').focus(),
    setTimeout: (fn, ms) => timers.push({fn, ms, cleared: false, fired: false}),
    clearTimeout: id => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    // What resetPrivateState reads besides its own declarations.
    content: {innerHTML: ''},
  });
  new Script(slice('let toastTimer;', '// A page that fails to open')).runInContext(context);
  new Script(slice('let session =', 'function resetTabState(')).runInContext(context);
  return {
    context,
    node,
    document,
    timers,
    toast: (message, tone) => context.toast(message, tone),
    box: node('#toast'),
    shown: () => node('#toast').hidden === false,
    // Timers still waiting; firing one runs its callback, as the clock would.
    pending: () => timers.filter(timer => !timer.cleared && !timer.fired),
    fireAll() {
      for (const timer of this.pending()) {
        timer.fired = true;
        timer.fn();
      }
    },
  };
}

test('a toast without a tone is what it was: its text, shown, and gone after six seconds', () => {
  const f = fixture();
  f.toast('Saved.');
  assert.equal(f.box.textContent, 'Saved.');
  assert.equal(f.shown(), true);
  assert.equal(f.box.button(), undefined, 'a timed toast has no button');
  assert.deepEqual(
    f.pending().map(timer => timer.ms),
    [6000],
  );
  f.fireAll();
  assert.equal(f.shown(), false);
  // The newest toast restarts the clock instead of stacking a second one.
  const g = fixture();
  g.toast('One.');
  g.toast('Two.');
  assert.equal(g.box.textContent, 'Two.');
  assert.deepEqual(
    g.pending().map(timer => timer.ms),
    [6000],
    'one timer, the first was cleared',
  );
  // Nothing to say, nothing shown.
  const h = fixture();
  h.toast('');
  h.toast(undefined, 'error');
  assert.equal(h.shown(), false);
  assert.equal(h.timers.length, 0);
});

test('only the error tone stays: any other tone, or none, leaves after six seconds', () => {
  for (const tone of [undefined, null, '', 'success', 'info', 'warning', 'danger', 'ERROR']) {
    const f = fixture();
    f.toast('Something happened.', tone);
    assert.equal(f.box.button(), undefined, String(tone));
    assert.deepEqual(
      f.pending().map(timer => timer.ms),
      [6000],
      String(tone),
    );
    f.fireAll();
    assert.equal(f.shown(), false, String(tone));
  }
});

test('an error toast stays until it is dismissed: no timer, a labelled Dismiss button, and focus is not moved', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture({locale}),
      page = f.node('#save');
    page.focus();
    const focusedBefore = f.document.activeElement;
    f.toast('The report could not be saved.', 'error');
    assert.equal(f.shown(), true, locale);
    assert.ok(f.box.textContent.startsWith('The report could not be saved.'), locale);
    assert.equal(f.pending().length, 0, locale + ': nothing is waiting to hide it');
    f.fireAll();
    assert.equal(f.shown(), true, locale + ': time passing changes nothing');
    const button = f.box.button();
    assert.ok(button, locale + ': a Dismiss button');
    assert.equal(button.getAttribute('type') ?? button.type, 'button', locale);
    // The label is the catalogue's, so the Arabic page reads it in Arabic; the glyph is decoration.
    assert.equal(button.getAttribute('aria-label'), locale === 'ar' ? catalog.Dismiss : 'Dismiss');
    assert.notEqual(button.getAttribute('aria-label'), '');
    assert.equal(button.focused, 0, locale + ': focus is never moved to the button');
    assert.equal(f.box.focused, 0);
    assert.equal(f.document.activeElement, focusedBefore, locale + ': nor away from where the person was');
  }
  assert.ok(catalog.Dismiss, 'the Arabic catalogue has the label');
});

test('the live region is written with the toast and never rewritten: nothing runs later to announce it again', () => {
  const f = fixture();
  f.toast('The report could not be saved.', 'error');
  const written = f.box.writes,
    button = f.box.button();
  assert.ok(button, 'an error toast has its Dismiss button');
  assert.ok(written >= 1 && written <= 2, 'the message, then its button, in the one call: ' + written);
  f.fireAll();
  button.focus();
  assert.equal(f.box.writes, written, 'focus on the button, and time, leave the region as it was');
  // A plain toast is written once.
  const g = fixture();
  g.toast('Saved.');
  assert.equal(g.box.writes, 1);
});

test('a newer toast replaces the one showing, and a timed one never makes an error toast leave', () => {
  // A timed toast that is showing when a failure arrives: its pending hide must not take the failure with it.
  const f = fixture();
  f.toast('Saved.');
  f.toast('Then it failed.', 'error');
  assert.equal(f.pending().length, 0, 'the six-second hide of the first toast was cancelled');
  f.fireAll();
  assert.equal(f.shown(), true);
  assert.ok(f.box.textContent.startsWith('Then it failed.'));
  // A failure followed by another failure: one toast, the newest, one button.
  f.toast('And again.', 'error');
  assert.ok(f.box.textContent.startsWith('And again.'));
  assert.equal(f.box.parts.filter(part => typeof part !== 'string').length, 1);
  // A failure followed by a timed toast: the timed toast takes its place and leaves after six seconds, button and all.
  f.toast('Saved at last.');
  assert.equal(f.box.textContent, 'Saved at last.');
  assert.equal(f.box.button(), undefined);
  assert.deepEqual(
    f.pending().map(timer => timer.ms),
    [6000],
  );
  f.fireAll();
  assert.equal(f.shown(), false);
});

test('dismissing an error toast hides it and puts focus back where it was, or on the page heading', () => {
  // Focus was on the control that failed: it goes back there.
  const f = fixture(),
    save = f.node('#save');
  save.focus();
  f.toast('The report could not be saved.', 'error');
  const button = f.box.button();
  assert.ok(button, 'an error toast has its Dismiss button');
  button.focus();
  assert.equal(f.document.activeElement, button, 'the person tabbed to the button');
  button.click();
  assert.equal(f.shown(), false);
  assert.equal(f.box.textContent, '', 'the button leaves with the text');
  assert.equal(f.document.activeElement, save, 'back on the control that failed');
  // That control is gone: the page heading.
  const g = fixture(),
    gone = g.node('#gone'),
    heading = g.node('#content h1');
  gone.focus();
  g.toast('The page could not be loaded.', 'error');
  const goneButton = g.box.button();
  assert.ok(goneButton);
  gone.isConnected = false;
  goneButton.focus();
  goneButton.click();
  assert.equal(g.document.activeElement, heading);
  // Nothing was focused when it appeared: the page heading again.
  const h = fixture();
  h.toast('The page could not be loaded.', 'error');
  const headButton = h.box.button();
  assert.ok(headButton);
  headButton.focus();
  headButton.click();
  assert.equal(h.document.activeElement, h.node('#content h1'));
  // A click that did not leave focus on the button (Safari) moves nothing.
  const i = fixture(),
    elsewhere = i.node('#elsewhere');
  elsewhere.focus();
  i.toast('The page could not be loaded.', 'error');
  const safariButton = i.box.button();
  assert.ok(safariButton);
  safariButton.click();
  assert.equal(i.shown(), false);
  assert.equal(i.document.activeElement, elsewhere);
});

test('an identity change clears an error toast with its button, so one person’s message never reaches the next', () => {
  const f = fixture();
  f.toast('Delivery to a client’s sheet failed.', 'error');
  assert.equal(f.shown(), true);
  f.context.resetPrivateState();
  assert.equal(f.box.textContent, '');
  assert.equal(f.shown(), false);
  assert.equal(f.box.button(), undefined);
  assert.equal(f.pending().length, 0);
});

// The call sites. Every toast that reports a failure passes 'error'; every other passes no tone. The inventory is the
// decision (file, first literal of the message or its source): a new toast either joins it or stays timed, on purpose.
const parse = file => parsers.babel.parse(read(file), {filepath: file});
const skip = new Set(['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'tokens']);
function toastCalls() {
  const calls = [];
  // about.js has its own toast (a status line of the About page, no shell).
  for (const file of fs.readdirSync('web').filter(name => name.endsWith('.js') && name !== 'about.js')) {
    const text = read(file),
      visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'toast') {
          const [message, tone] = node.arguments,
            literals = [];
          const collect = inner => {
            if (!inner || typeof inner !== 'object') return;
            if (inner.type === 'StringLiteral') literals.push(inner.value);
            if (inner.type === 'TemplateLiteral') for (const quasi of inner.quasis) literals.push(quasi.value.cooked);
            for (const [key, value] of Object.entries(inner))
              if (!skip.has(key)) for (const child of Array.isArray(value) ? value : [value]) collect(child);
          };
          collect(message);
          calls.push({
            file,
            line: node.loc.start.line,
            argc: node.arguments.length,
            message: text.slice(message.start, message.end),
            literals,
            first: literals[0] ?? text.slice(message.start, message.end).replace(/\s+/g, ' '),
            // 'error', 'conditional' (a tone chosen by the outcome, with 'error' as one of its branches) or nothing.
            tone:
              tone === undefined
                ? null
                : tone.type === 'StringLiteral'
                  ? tone.value
                  : tone.type === 'ConditionalExpression' && tone.consequent.value === 'error'
                    ? 'conditional'
                    : '?',
          });
        }
        for (const [key, value] of Object.entries(node))
          if (!skip.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child);
      };
    visit(parse(file).program);
  }
  return calls;
}

test('every call site passes no tone or the error tone, and every failure toast built from an error passes it', () => {
  const calls = toastCalls();
  assert.ok(calls.length >= 90, 'the scan finds the shell’s toasts: ' + calls.length);
  for (const call of calls) {
    assert.ok(call.argc >= 1 && call.argc <= 2, `${call.file}:${call.line} passes at most a message and a tone`);
    assert.ok([null, 'error', 'conditional'].includes(call.tone), `${call.file}:${call.line} passes tone ${call.tone}`);
    // A toast made from a caught error, an error message or an error object reports a failure.
    if (/\berrorMessage\(|\berrorLines\(|\berror\.message\b/.test(call.message))
      assert.notEqual(call.tone, null, `${call.file}:${call.line} reports a failure and must stay until dismissed`);
  }
});

test('the failure toasts are exactly these; every other toast, a confirmation or a note, stays timed', () => {
  const stays = toastCalls()
    .filter(call => call.tone !== null)
    .map(call => call.file + ' | ' + call.first)
    .sort();
  assert.deepEqual(
    stays,
    [
      'account-security.js | Select the codes and copy them.',
      'account-security.js | Select the key and copy it.',
      'app.js | Add the {platform} app credentials to your server environment to enable Connect.',
      'app.js | Confirm account write access before saving.',
      'app.js | Confirm operator access before creating this token.',
      // r25-admin-email (merge 6, d155049a: this test is green before that merge and red from it): the two checks of the Owner choice. Each is a validation stop, like the
      // operator one above: a missing consent checkbox, refused before any request is made (the token form's, and the consent page's).
      'app.js | Confirm owner access before creating this token.',
      'app.js | Confirm owner access for this app before authorizing.',
      'app.js | Confirm report-job access before saving.',
      'app.js | Login disconnected from AMCP.',
      'app.js | Sync needs attention',
      'app.js | That connection is no longer in this workspace.',
      'app.js | Use a login name of 1 to 80 characters.',
      'app.js | errorMessage(e)',
      'app.js | errorMessage(e)',
      'app.js | errorMessage(e)',
      'app.js | message',
      'campaign-workflows.js | errorMessage(error)',
      'capability-center.js | Copy failed; select the reference manually.',
      'creative-push.js | errorMessage(e)',
      'evidence-workflows.js | Copy is unavailable in this browser. Select the ID from its tooltip instead.',
      'identity.js | errorMessage(err)',
      'localization.js | The language could not be loaded. Your current view is unchanged.',
      'localization.js | error.message',
      'reporting-overview.js | Use a label, unique identifier and formula.',
      'reporting-overview.js | errorMessage(e)',
      'reporting-overview.js | errorMessage(e)',
      'workspace.js | errorMessage(e)',
      'workspace.js | errorMessage(e)',
      'workspace.js | errorMessage(error)',
    ].sort(),
  );
  // Successes, copies, progress and plain facts keep their six seconds (a sample of each).
  const timed = new Set(
    toastCalls()
      .filter(call => call.tone === null)
      .flatMap(call => call.literals),
  );
  for (const message of [
    'Recovery codes copied.',
    'Security settings saved.',
    'Accounts synced successfully.',
    'Workspace refreshed. Use Sync to refresh provider assets.',
    'No newly selected accounts to check.',
    'Reference copied.',
    'Delivery queued again.',
    'The tab does not show this delivery yet.',
    'Error details copied.',
  ])
    assert.ok(timed.has(message), 'stays timed: ' + message);
  // The disconnect toast chooses its tone by what Google answered: only an unconfirmed revocation is a failure.
  const disconnect = toastCalls().find(call => call.first === 'Login disconnected from AMCP.');
  assert.equal(disconnect.tone, 'conditional');
});
