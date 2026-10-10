import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {ownerOperations} from '../dist/src/owner-operations.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';

/**
 * WRT-03, website side. Before, the account policy form always showed fixed defaults (confirm, +20 %, activation on,
 * caps blank) and a save replaced the whole policy, so an owner who changed one cap removed the others, switched block
 * to confirm and re-allowed activation without being told. These tests run the page's own helpers in a VM against the
 * real server: the form shows the stored policy, a one-field edit stores every other field as it was, and a weaker
 * save names each weakening in the confirmation.
 */
const source = readFileSync('web/owner-operations.js', 'utf8'),
  helpers = source.slice(source.indexOf('const policyMoney ='), source.indexOf('let pendingPolicyBinding')),
  ownerCallSource = source.slice(source.indexOf('const ownerCall ='), source.indexOf('renderSettings = async')),
  app = readFileSync('web/app.js', 'utf8'),
  confirmSource = app.slice(app.indexOf('function confirmAction('), app.indexOf('let toastTimer;'));
const owner = {tenantId: 'policy-ui', userId: 'owner', role: 'admin'},
  gateway = 'google_ads_native_action',
  account = '123-456-7890';
function vm(locale = 'en') {
  const context = createContext({
      Intl,
      document: {addEventListener() {}},
      date: value => (value === undefined ? 'unknown' : new Date(value).toISOString()),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    }),
    run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(helpers);
  return {
    context,
    call: (name, ...args) => {
      context.args = args.map(a => (typeof a === 'function' ? a : structuredClone(a)));
      // Back into this realm, so deepStrictEqual compares values rather than another realm's prototypes.
      const out = run(`${name}(...args)`);
      return out && typeof out === 'object' ? JSON.parse(JSON.stringify(out)) : out;
    },
  };
}
function server() {
  const store = new Store(':memory:', Buffer.alloc(32, 21).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: owner.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic Google',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const health = () => ownerOperations(store, {action: 'health'}, owner);
  const save = (policy, extra = {}) =>
    saveSpendPolicy(store, owner, {
      gateway,
      account_id: account,
      connection_id: 'g',
      confirmed: true,
      policy,
      ...extra,
    });
  return {store, health, save};
}
const editable = p => {
  const {id: _i, revision: _r, updated_at: _u, ...rest} = p;
  return rest;
};

test('the form shows the stored policy of the selected account, and the earlier defaults for one without', () => {
  const s = server(),
    page = vm();
  try {
    s.save({enforcement: 'block', allow_activation: false, max_budget_currency: 100, max_bid_currency: 5});
    const h = s.health(),
      stored = page.call('storedAccountPolicy', h, gateway, 'g', account);
    assert.equal(stored.revision, 1);
    const values = page.call('accountPolicyValues', stored);
    assert.deepEqual(values, {
      enforcement: 'block',
      unit: 'currency',
      // WRT-07: the form shows the currency of the caps (none stored and no live check here).
      currency: '',
      max_budget_increase_percent: '',
      allow_activation: false,
      allow_deletion: true,
      max_budget: '100',
      max_daily_increase: '',
      max_bid: '5',
      max_total_budget: '',
    });
    // The values reach the form: selects and inputs by value, checkboxes by checked.
    const elements = Object.fromEntries(
      Object.keys(values).map(name => [
        name,
        name.startsWith('allow_') ? {type: 'checkbox', checked: true} : {type: 'text', value: 'stale'},
      ]),
    );
    page.context.form = {elements: {namedItem: name => elements[name]}};
    page.context.values = values;
    new Script('fillPolicyForm(form, values)').runInContext(page.context);
    assert.equal(elements.enforcement.value, 'block');
    assert.equal(elements.max_budget_increase_percent.value, '');
    assert.equal(elements.max_bid.value, '5');
    assert.equal(elements.allow_activation.checked, false);
    assert.equal(elements.allow_deletion.checked, true);
    assert.match(page.call('storedPolicyNote', stored), /^Existing policy · revision 1 · last updated /);
    // Another account (or none stored): the form starts from the earlier defaults.
    assert.equal(page.call('storedAccountPolicy', h, gateway, 'g', '999'), undefined);
    assert.equal(page.call('accountPolicyValues', undefined).max_budget_increase_percent, '20');
    assert.match(page.call('storedPolicyNote', undefined), /no policy of its own yet/);
  } finally {
    s.store.close();
  }
});

test('the replace probe: changing only the maximum bid stores every other field as it was', () => {
  const s = server(),
    page = vm();
  try {
    s.save({enforcement: 'block', allow_activation: false, max_budget_currency: 100, max_bid_currency: 5});
    const stored = page.call('storedAccountPolicy', s.health(), gateway, 'g', account),
      values = {...page.call('accountPolicyValues', stored), max_bid: '3'},
      policy = page.call('accountPolicyInput', values, stored);
    assert.deepEqual(policy, {
      enforcement: 'block',
      allow_activation: false,
      max_budget_currency: 100,
      max_bid_currency: 3,
    });
    assert.deepEqual(page.call('policyWeakenings', stored, policy), [], 'a lower bid cap is not a weakening');
    const saved = s.save(policy, {expected_revision: stored.revision});
    assert.equal(saved.revision, 2);
    assert.equal(saved.warnings, undefined);
    const after = s.store.document(owner.tenantId, 'spend_policy', stored.id);
    assert.deepEqual(editable(after), {...editable(stored), max_bid_currency: 3, max_bid_native: 3000000});
    // The same edit sent with the revision the page showed is refused once another save came first.
    assert.throws(
      () => s.save(policy, {expected_revision: stored.revision}),
      e => e.code === 'REVISION_CONFLICT',
    );
  } finally {
    s.store.close();
  }
});

test('a weaker save names every weakening, in English and Arabic; a stricter one names none', () => {
  const s = server();
  try {
    s.save({
      enforcement: 'block',
      allow_activation: false,
      allow_deletion: false,
      max_budget_currency: 100,
      max_budget_increase_percent: 10,
      max_bid_currency: 5,
    });
    for (const locale of ['en', 'ar']) {
      const page = vm(locale),
        stored = page.call('storedAccountPolicy', s.health(), gateway, 'g', account),
        values = page.call('accountPolicyValues', stored);
      const weaker = page.call(
        'policyWeakenings',
        stored,
        page.call(
          'accountPolicyInput',
          {
            ...values,
            enforcement: 'confirm',
            allow_activation: true,
            allow_deletion: true,
            max_budget: '',
            max_budget_increase_percent: '25',
          },
          stored,
        ),
      );
      assert.equal(weaker.length, 5, weaker.join(' | '));
      if (locale === 'en')
        assert.deepEqual(weaker, [
          'A change beyond a cap is asked about instead of refused.',
          'Activation after review becomes allowed.',
          'Deletion after review becomes allowed, feed deletion rules included.',
          'Removes the maximum budget (was 100).',
          'Raises the maximum increase per change from 10 to 25.',
        ]);
      else {
        assert.match(weaker[3], /^يُزيل أقصى ميزانية \(كان /);
        assert.doesNotMatch(weaker.join(' '), /Removes|Raises|\{cap\}|\{was\}/);
      }
      const stricter = page.call(
        'policyWeakenings',
        stored,
        page.call('accountPolicyInput', {...values, max_budget: '90', max_bid: '4', max_total_budget: '500'}, stored),
      );
      assert.deepEqual(stricter, []);
    }
    // A cap stated natively and re-entered in currency cannot be compared here: the owner is asked to check it.
    const page = vm(),
      native = {id: 'synthetic', revision: 1, max_budget_native: 100000000},
      shown = page.call('accountPolicyValues', native);
    assert.equal(shown.unit, 'native');
    assert.equal(shown.max_budget, '100000000');
    assert.deepEqual(
      page.call(
        'policyWeakenings',
        native,
        page.call('accountPolicyInput', {...shown, unit: 'currency', max_budget: '100'}, native),
      ),
      ['States the maximum budget in another unit; check it.'],
    );
    // A first account policy replaces the workspace default for that account: compared with that default.
    const fallback = page.call(
      'workspaceDefaultFor',
      {enforcement: 'block', allow_deletion: false, per_gateway: {[gateway]: {max_budget_currency: 50}}},
      gateway,
    );
    assert.deepEqual(
      page.call(
        'policyWeakenings',
        fallback,
        page.call('accountPolicyInput', page.call('accountPolicyValues'), undefined),
      ),
      ['A change beyond a cap is asked about instead of refused.', 'Removes the maximum budget (was 50).'],
    );
  } finally {
    s.store.close();
  }
});

test('the workspace default form keeps the settings and platform caps it does not show', () => {
  const s = server(),
    page = vm();
  try {
    saveSpendPolicy(s.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: {
        enforcement: 'block',
        allow_deletion: false,
        max_budget_increase_percent: 15,
        per_gateway: {
          [gateway]: {max_budget_currency: 50, max_bid_currency: 2},
          meta_native_action: {max_budget_native: 7000},
        },
      },
    });
    const stored = s.health().policies.find(p => p.id === 'workspace_default'),
      // The page shows the Google cap and an empty Meta field (its cap is native only); the owner changes nothing.
      unchanged = page.call(
        'workspacePolicyInput',
        {enforcement: 'block', max_budget_increase_percent: '15', caps: {[gateway]: '50', meta_native_action: ''}},
        stored,
      );
    assert.deepEqual(page.call('policyWeakenings', stored, unchanged, String), []);
    const saved = saveSpendPolicy(s.store, owner, {
      scope: 'workspace',
      confirmed: true,
      policy: unchanged,
      expected_revision: stored.revision,
    });
    const after = s.store.document(owner.tenantId, 'spend_policy', 'workspace_default');
    assert.equal(saved.revision, 2);
    assert.deepEqual(editable(after), editable(stored));
    // Clearing the Google cap is a weakening the confirmation names.
    const cleared = page.call(
      'workspacePolicyInput',
      {enforcement: 'confirm', max_budget_increase_percent: '15', caps: {[gateway]: '', meta_native_action: ''}},
      after,
    );
    assert.deepEqual(
      page.call('policyWeakenings', after, cleared, () => 'Google Ads'),
      ['A change beyond a cap is asked about instead of refused.', 'Removes the Google Ads · maximum budget (was 50).'],
    );
    assert.deepEqual(cleared.per_gateway, {
      [gateway]: {max_bid_currency: 2},
      meta_native_action: {max_budget_native: 7000},
    });
    assert.equal(cleared.allow_deletion, false);
  } finally {
    s.store.close();
  }
});

test('the confirmation lists what a save changes, and a stale save reaches the page as REVISION_CONFLICT', async () => {
  const nodes = {};
  const element = id => {
    const node = {
      id,
      textContent: '',
      children: [],
      attributes: {},
      append(child) {
        this.children.push(child);
      },
      after(child) {
        nodes[child.id] = child;
      },
      remove() {
        delete nodes[this.id];
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
      addEventListener() {},
      removeEventListener() {},
      showModal() {},
      focus() {},
      querySelector: selector => nodes[selector.slice(1)],
    };
    return node;
  };
  for (const id of ['action-dialog', 'action-title', 'action-copy', 'action-confirm', 'action-cancel'])
    nodes[id] = element(id);
  const context = createContext({
    document: {createElement: () => element('')},
    $: selector => nodes[selector.slice(1)],
    uiText: s => s,
    api: async () => ({
      success: false,
      error: {code: 'REVISION_CONFLICT', message: 'The document changed since it was read.'},
    }),
  });
  new Script(confirmSource + ownerCallSource).runInContext(context);
  context.input = {title: 'T', consequence: 'C', items: ['First weakening', 'Second weakening']};
  new Script('confirmAction(input)').runInContext(context);
  assert.deepEqual(
    nodes['action-items'].children.map(li => li.textContent),
    ['First weakening', 'Second weakening'],
  );
  assert.equal(nodes['action-dialog'].attributes['aria-describedby'], 'action-copy action-items');
  context.input = {title: 'T', consequence: 'C'};
  new Script('confirmAction(input)').runInContext(context);
  assert.equal(nodes['action-items'], undefined);
  assert.equal(nodes['action-dialog'].attributes['aria-describedby'], 'action-copy');
  const error = await new Script("ownerCall({action: 'save_spend_policy'}).catch(e => e)").runInContext(context);
  assert.equal(error.code, 'REVISION_CONFLICT');
});

test('WRT-07: the form states the currency of the caps, prefilled from the live check, and names its removal', () => {
  const s = server(),
    page = vm();
  try {
    rememberAccountMetadata(s.store, owner.tenantId, 'g', account, {
      name: 'Synthetic',
      currency: 'KWD',
      timezone: 'UTC',
    });
    const h = s.health();
    assert.equal(page.call('bindingCurrency', h, gateway, 'g', account), 'KWD');
    const values = page.call('accountPolicyValues', undefined, 'KWD');
    assert.equal(values.currency, 'KWD');
    const policy = page.call('accountPolicyInput', {...values, max_budget: '100', currency: 'kwd'}, undefined);
    assert.equal(policy.currency, 'KWD');
    const saved = s.save(policy, {expected_revision: 0});
    assert.equal(saved.currency, 'KWD');
    assert.equal(saved.max_budget_native, 100000000);
    const stored = page.call('storedAccountPolicy', s.health(), gateway, 'g', account);
    assert.equal(page.call('accountPolicyValues', stored, 'USD').currency, 'KWD', 'the stored currency is shown');
    // An unchanged save resends the currency; removing or changing it is named before the save.
    assert.equal(page.call('accountPolicyInput', page.call('accountPolicyValues', stored), stored).currency, 'KWD');
    assert.deepEqual(page.call('policyWeakenings', stored, {...policy, currency: undefined}), [
      'Caps no longer name their currency (was KWD).',
    ]);
    assert.deepEqual(page.call('policyWeakenings', stored, {...policy, currency: 'USD'}), [
      'Caps are stated in USD instead of KWD; check them.',
    ]);
    // The workspace default states a currency per platform; an empty field removes it.
    const workspace = page.call(
      'workspacePolicyInput',
      {
        enforcement: 'confirm',
        max_budget_increase_percent: '',
        caps: {[gateway]: '50'},
        currencies: {[gateway]: 'usd'},
      },
      undefined,
    );
    assert.deepEqual(workspace.per_gateway, {[gateway]: {max_budget_currency: 50, currency: 'USD'}});
    const cleared = page.call(
      'workspacePolicyInput',
      {enforcement: 'confirm', max_budget_increase_percent: '', caps: {[gateway]: '50'}, currencies: {[gateway]: ''}},
      {per_gateway: {[gateway]: {max_budget_currency: 50, max_budget_native: 50000000, currency: 'USD'}}},
    );
    assert.deepEqual(cleared.per_gateway, {[gateway]: {max_budget_currency: 50}});
    // In Arabic the removal is translated with its values.
    const ar = vm('ar');
    assert.doesNotMatch(
      ar.call('policyWeakenings', stored, {...policy, currency: undefined}).join(' '),
      /Caps|\{was\}/,
    );
  } finally {
    s.store.close();
  }
});
