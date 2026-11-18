import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * Round 2.5, package r25-m3-dupstep (item 3): a plan step the guard against creating twice holds back (pending, unsent, the refusal on
 * it: src/campaign-runner.ts holdDuplicate) is shown as waiting, not broken. The M2 gate's failure screenshot showed such a step as FAILED,
 * with the emphasized action "Correct blocked step", an Amend panel open on /action, and the generic "Refresh the page to see the current
 * state, then try again." These tests run the real page scripts in a VM with synthetic responses (as tests/website-presentation.test.mjs
 * does for the step the state check sent back); nothing reaches a server or provider.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  app = readFileSync('web/app.js', 'utf8'),
  presentationSource = app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')"));
// The page's own words for such a step (web/campaign-workflows.js campaignDuplicateWords), as the English the catalogue keys them by.
const duplicateWords = {
  message:
    'An earlier create of the same object is still uncertain or being sent, so this change could make a second object. Nothing was sent.',
  remedy:
    'Settle the earlier create first: check whether it was applied, in the plan that holds it (Read back submitted step) or in Operations. Then prepare this change again.',
};
// What an MCP client is told and a person must never be: tool and action names, envelope paths, consent flags and the review a write replaces.
const agentTokens =
  /execute_next|next_call|prepare_next|recover_step|reconcile_step|confirmed: true|details\.[a-z]|supersedes_review_id/;
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
/** The visible text of rendered markup: the server's exact text under Technical details and record details excluded. */
const visible = html =>
  html
    .replace(/<details class="(?:error-technical|workspace-details)"[\s\S]*?<\/details>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const t = (locale, text) => (locale === 'ar' ? catalog[text] : text);
const controlIds = html => [...html.matchAll(/id="((?:outcome|open)-[a-z-]+)"/g)].map(m => m[1]);

function page(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  let handler = async () => ({});
  const element = selector => ({
    id: selector.startsWith('#') ? selector.slice(1) : '',
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    checked: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    attributes: {},
    elements: new Proxy({}, {get: (controls, name) => (controls[name] ??= element('control:' + String(name)))}),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    querySelector: selector => node(selector),
    querySelectorAll: () => [],
    append() {},
    remove() {},
    replaceWith() {},
    closest: () => null,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    focus() {},
    classList: {names: [], add() {}},
  });
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element(selector));
    return nodes.get(selector);
  };
  const context = createContext({
    catalog,
    Intl,
    Date,
    URL,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    location: {pathname: '/campaigns', search: '', hash: ''},
    history: {replaceState() {}, pushState() {}},
    document: {
      activeElement: null,
      addEventListener() {},
      querySelector: node,
      querySelectorAll: () => [],
      getElementById: id => node('#' + id),
      createElement: () => element('new'),
    },
    $: node,
    content: node('#content'),
    esc,
    date: String,
    toast() {},
    confirmAction: async () => true,
    session: {authenticated: true, id: 'person-a', workspaceRole: 'owner', csrf: 'csrf'},
    platforms: [],
    navigationGeneration: 1,
    identityGeneration: 1,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    crypto: {randomUUID: () => '11111111-1111-4111-8111-111111111111'},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(presentationSource);
  run(readFileSync('web/workspace.js', 'utf8'));
  run(readFileSync('web/campaign-workflows.js', 'utf8'));
  context.workspaceBind = (selector, fn) => bindings.set(selector, fn);
  context.workspaceCall = async (tool, args) => {
    calls.push({tool, args: JSON.parse(JSON.stringify(args))});
    return handler(tool, args);
  };
  return {
    context,
    run,
    node,
    bindings,
    calls,
    respond(fn) {
      handler = fn;
    },
  };
}

// The refusal as the plan stores it on the step (src/campaign-runner.ts heldDuplicate): the server's own text, which names next_call and
// supersedes_review_id, with the call that settles the earlier create and the plan that holds it.
const prepareNext = id => ({tool: 'amcp_campaign', arguments: {action: 'prepare_next', id}});
const refusalText =
  'An identical create is already uncertain or still being sent, so this one could make a second object. Settle that review first (next_call): read its status, or reconcile it with read-only lookups. If it was not applied, prepare this request again with supersedes_review_id set to its review_id; if it was applied, accept that.';
const heldError = (extra = {}, planId = 'plan-1') => ({
  code: 'DUPLICATE_OF_UNCERTAIN_WRITE',
  message: refusalText,
  category: 'state',
  remedy: {
    category: 'state',
    action:
      'Nothing was prepared or sent. An identical create is already uncertain or still being sent, so another could make a second object. Settle that review first (details.next_call): read amcp_write status.',
  },
  details: {
    earlier_state: 'uncertain',
    earlier_match: 'identical',
    earlier_review_id: 'review-earlier',
    submission: 'not_sent',
    next_call: {
      tool: 'amcp_write',
      arguments: {action: 'reconcile', review_id: 'review-earlier'},
      then: prepareNext(planId),
    },
    earlier_next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: 'review-earlier'}},
    ...extra,
  },
});
const heldStep = (extra = {}, planId = 'plan-1') => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  account_id: '123',
  description: 'Create the paused campaign',
  depends_on: [],
  arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
  status: 'pending',
  error: heldError(extra, planId),
});
// A stored plan carries what the engine saved with it: the prerequisites a prepare_next checked (the rendered journey caught a guard that read
// them as the answer of a preflight) and the approval.
const plan = (steps, id = 'plan-1') => ({
  id,
  name: 'Synthetic launch',
  revision: 4,
  state: 'attention',
  preflight: {status: 'ready', checks: [], checked_at: 1},
  approval: {plan_hash: 'hash', at: 1},
  steps,
});
const earlierPlan = 'plan-earlier';
const settleCall = {
  tool: 'amcp_write',
  arguments: {action: 'reconcile', review_id: 'review-earlier'},
  then: prepareNext('plan-1'),
};
/** The answers a person's click can bring back for the held step: execute_next (compact), the website's prepare_next (the whole plan), a run's stop. */
const answers = run => ({
  execute: {
    view: 'compact',
    id: run.id,
    state: 'attention',
    steps: [{id: 'campaign', status: 'pending', error: 'DUPLICATE_OF_UNCERTAIN_WRITE'}],
    current: {step_id: 'campaign', status: 'pending', error: run.steps[0].error},
    next_call: settleCall,
  },
  prepare: {...run, next_call: settleCall},
  stop: {
    view: 'compact',
    id: run.id,
    state: 'attention',
    steps: [{id: 'campaign', status: 'pending', error: 'DUPLICATE_OF_UNCERTAIN_WRITE'}],
    current: {step_id: 'campaign', status: 'pending', error: run.steps[0].error},
    run: {
      executed: [],
      stopped: 'needs_attention',
      reason: 'Step campaign was refused (DUPLICATE_OF_UNCERTAIN_WRITE) ... prepare_next then prepares the step again.',
      next_call: settleCall,
    },
  },
});

for (const locale of ['en', 'ar'])
  test(locale + ': a held step is shown as waiting, and the way on is the plan that holds the earlier create', () => {
    const p = page(locale),
      // The earlier create is held by another plan the person can open.
      withPlan = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]);
    p.context.plan = withPlan;
    assert.equal(p.run('campaignNextSafeAction')(withPlan), 'settle');
    // Nothing of the plan's row leads: the held step's own link does, and Run (which a non-empty lead takes the emphasis off) does not.
    assert.equal(p.run('campaignNeedsAmendment')(withPlan), true, 'the step may still be corrected on purpose');
    const answered = answers(withPlan);
    for (const [how, out] of Object.entries(answered)) {
      p.context.out = out;
      const html = p.run('runOutcomeView(out, plan)'),
        text = visible(html);
      // What happened and what settles it, in the page's words, and never "Saved." or the recovery of a broken step.
      assert.ok(text.includes(t(locale, duplicateWords.message)), how);
      assert.ok(text.includes(t(locale, duplicateWords.remedy)), how);
      assert.ok(!text.includes(t(locale, 'Saved.')), how + ': not announced as saved');
      assert.ok(
        !text.includes(t(locale, p.run('runRecoveryLabels').reconcile)),
        how + ': the step did not reach the provider',
      );
      assert.doesNotMatch(text, agentTokens, how);
      // One control, emphasized: the link to the plan that holds the earlier create. Never "Correct blocked step".
      assert.deepEqual(controlIds(html), ['outcome-earlier-plan'], how);
      assert.match(
        html,
        /<a id="outcome-earlier-plan" class="button primary" href="\/campaigns\?id=plan-earlier">/,
        how,
      );
      assert.ok(text.includes(t(locale, 'Open the plan that holds it')), how);
      assert.ok(!text.includes(t(locale, 'Correct blocked step')), how);
      assert.doesNotMatch(html, /outcome-amend|outcome-correct-step|amend-step/, how);
    }
    // A run's stop keeps its own words (the run stopped) and adds the held step's.
    p.context.out = answered.stop;
    const stopText = visible(p.run('runOutcomeView(out, plan)'));
    assert.ok(stopText.includes(t(locale, p.run('runStopLabels').needs_attention)));
  });

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': where no other plan holds the earlier create, preparing the step again is the one control, and it is not emphasized',
    () => {
      const p = page(locale);
      for (const [label, error] of [
        ['a standalone write: no plan names it', {}],
        ['a colleague’s write: nothing is named', {earlier_review_id: undefined, readable: false}],
        ['the plan itself holds the earlier create', {earlier_plan_id: 'plan-1', earlier_step_id: 'first'}],
      ]) {
        const run = plan([heldStep(error)]);
        p.context.plan = run;
        for (const [how, out] of Object.entries(answers(run))) {
          p.context.out = out;
          const html = p.run('runOutcomeView(out, plan)'),
            text = visible(html);
          assert.deepEqual(controlIds(html), ['outcome-prepare-again'], label + ' ' + how);
          assert.match(html, /id="outcome-prepare-again" type="button" class="button"/, 'not emphasized: ' + label);
          assert.ok(text.includes(t(locale, 'Prepare again')), label);
          assert.ok(text.includes(t(locale, duplicateWords.message)), label);
          assert.doesNotMatch(text, agentTokens, label + ' ' + how);
        }
      }
    },
  );

for (const locale of ['en', 'ar'])
  test(locale + ': a twin still being sent says to wait, and the run’s busy stop keeps its own outcome', () => {
    const p = page(locale),
      run = plan([heldStep({earlier_state: 'executing'})]);
    p.context.plan = run;
    // The website's prepare_next while the twin is still being sent: the whole plan, with the wait.
    p.context.out = {...run, busy: true, retry_after_ms: 5000, next_call: prepareNext('plan-1')};
    const html = p.run('runOutcomeView(out, plan)'),
      text = visible(html);
    assert.ok(text.includes(t(locale, duplicateWords.message)));
    assert.ok(text.includes(locale === 'ar' ? 'نحو 5 ثانية' : 'about 5 seconds'), 'how long to wait');
    assert.deepEqual(controlIds(html), ['outcome-prepare-again']);
    // The run that met it stops `not_sent` and continues in a moment: the outcome the page already words, with its own control. The
    // stop is the busy answer of prepare_next (next_call prepare_next, a wait) with the run's own fields added.
    p.context.out = {
      ...answers(run).execute,
      busy: true,
      retry_after_ms: 5000,
      next_call: prepareNext('plan-1'),
      run: {
        executed: [],
        stopped: 'not_sent',
        retry_after_ms: 5000,
        next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}},
      },
    };
    const stop = p.run('runOutcomeView(out, plan)');
    assert.deepEqual(controlIds(stop), ['outcome-continue']);
    assert.ok(visible(stop).includes(t(locale, p.run('runStopLabels').not_sent)));
  });

for (const locale of ['en', 'ar'])
  test(locale + ': the plan’s own page shows the held step as pending with its refusal and the link beside it', () => {
    const p = page(locale),
      run = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]),
      html = p.run('campaignJournal')(run),
      text = visible(html);
    assert.ok(text.includes(t(locale, 'Pending')), 'pending, not failed');
    assert.ok(!text.includes(t(locale, 'Failed')));
    // The refusal beside the step is the page's own wording, not the server's text for an MCP client.
    assert.ok(text.includes(t(locale, duplicateWords.message)));
    assert.ok(text.includes(t(locale, duplicateWords.remedy)));
    assert.doesNotMatch(text, agentTokens);
    assert.ok(!text.includes('Refresh the page'), 'not the generic "refresh" remedy of the state category');
    assert.match(
      html,
      /<a id="open-earlier-plan" class="button small primary" href="\/campaigns\?id=plan-earlier">/,
      'the emphasized action sits with the refused step',
    );
    // No plan to open: no link, and no other step carries one.
    const without = p.run('campaignJournal')(plan([heldStep()]));
    assert.doesNotMatch(without, /open-earlier-plan/);
    const sameplan = p.run('campaignJournal')(plan([heldStep({earlier_plan_id: 'plan-1'})]));
    assert.doesNotMatch(sameplan, /open-earlier-plan/, 'the plan itself is already open');
  });

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': preparing the held step on the page shows the outcome and opens no Amend panel; correcting it is only on request',
    async () => {
      const p = page(locale),
        run = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]);
      p.context.plan = run;
      p.context.after = answers(run).prepare;
      p.node('#next-campaign').classList = {
        names: [],
        add(name) {
          this.names.push(name);
        },
      };
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      const shown = p.node('#campaign-review').innerHTML;
      // The answer is shown as an outcome, with its one control; the Amend form (recover_step) is not opened.
      assert.match(shown, /id="outcome-earlier-plan"/);
      assert.doesNotMatch(shown, /id="amend-step"|id="amend-arguments"/, 'no Amend panel opens by default');
      assert.doesNotMatch(visible(shown), agentTokens);
      // The plan's row: no button of it leads (the lead is 'settle'), so "Review next step" is not emphasized either.
      assert.deepEqual(p.node('#next-campaign').classList.names, []);
      assert.equal(p.calls.length, 0, 'showing the answer asks nothing of the server');
      // "Correct blocked step" is offered on the plan's row for the step the person may choose to change; it opens the form only when clicked.
      p.node('#campaign-review').innerHTML = '';
      await p.bindings.get('#amend-campaign')();
      assert.equal(p.calls.length, 0, 'opening the form prepares and sends nothing');
      const form = p.node('#campaign-review').innerHTML;
      assert.match(form, /id="amend-step"/);
      assert.match(form, /campaign<\/h2>/, 'it names the step');
      // Prepare again (where no other plan holds the earlier create) asks prepare_next for the whole review, as the plan's own button does.
      const lone = plan([heldStep()]);
      p.context.plan = lone;
      p.context.after = answers(lone).prepare;
      p.node('#campaign-review').innerHTML = '';
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      assert.match(p.node('#campaign-review').innerHTML, /id="outcome-prepare-again"/);
      p.respond(async () => ({...lone, next_call: settleCall}));
      await p.bindings.get('#outcome-prepare-again')();
      assert.deepEqual(p.calls.at(-1).args, {action: 'prepare_next', id: 'plan-1', detail: 'full'});
    },
  );

test('negative: every other outcome is shown as it was', () => {
  const p = page('en'),
    held = heldStep({earlier_plan_id: earlierPlan}),
    failed = {id: 'b', kind: 'write', status: 'failed', error: {code: 'WRITE_REJECTED', message: 'x'}},
    stateChanged = {
      id: 'c',
      kind: 'write',
      status: 'pending',
      error: {code: 'STATE_CHANGED', message: 'x', details: {}},
    };
  // A failed step still leads with its correction, and a step the state check sent back with its review: a held step never takes over.
  assert.equal(p.run('campaignNextSafeAction')({steps: [held, failed]}), 'amend');
  assert.equal(p.run('campaignNextSafeAction')({steps: [stateChanged, held]}), 'review');
  assert.equal(p.run('campaignNextSafeAction')({steps: [{...held, review_id: 'r', status: 'uncertain'}]}), 'reconcile');
  // Another pending step is not a held one, and a step that no longer carries the refusal is not either.
  for (const step of [
    {id: 'a', status: 'pending', error: {code: 'REVIEW_EXPIRED'}},
    {id: 'a', status: 'pending'},
    {...held, status: 'review_ready'},
    {...held, status: 'failed'},
  ])
    assert.notEqual(p.run('campaignNextSafeAction')({steps: [step]}), 'settle', JSON.stringify(step));
  // The step the state check sent back keeps its outcome: its review first and emphasized, the correction beside it.
  p.context.plan = plan([stateChanged]);
  p.context.out = {
    view: 'compact',
    id: 'plan-1',
    steps: [{id: 'c', status: 'pending', error: 'STATE_CHANGED'}],
    current: {step_id: 'c', status: 'pending', error: {code: 'STATE_CHANGED'}},
    next_call: prepareNext('plan-1'),
  };
  assert.deepEqual(controlIds(p.run('runOutcomeView(out, plan)')), ['outcome-review-step', 'outcome-correct-step']);
  // A broken step's recovery is described as before (the plan has a held step too, but this answer is not about it).
  p.context.plan = plan([failed, held]);
  p.context.out = {
    blocked: true,
    recovery: 'Amend it with recover_step (next_call).',
    current: {step_id: 'b', status: 'failed', error: {code: 'WRITE_REJECTED'}},
    next_call: {tool: 'amcp_campaign', arguments: {action: 'recover_step', id: 'plan-1', step_id: 'b'}},
  };
  assert.deepEqual(controlIds(p.run('runOutcomeView(out, plan)')), ['outcome-amend']);
  // The answers of other actions on a plan that has a held step are shown as they were: approved, prerequisites checked.
  p.context.plan = plan([held]);
  for (const out of [
    {
      ...plan([held]),
      approved: {by: 'a'},
      next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}},
    },
    {...plan([held]), preflight: {status: 'ready'}, blocked: false, next_call: prepareNext('plan-1')},
  ]) {
    p.context.out = out;
    assert.doesNotMatch(p.run('runOutcomeView(out, plan)'), /outcome-earlier-plan|outcome-prepare-again/);
  }
});

for (const locale of ['en', 'ar'])
  test(locale + ': the page words the refusal itself, whatever the server’s text says', () => {
    const p = page(locale),
      words = p.run('campaignDuplicateWords')();
    assert.equal(words.message, t(locale, duplicateWords.message));
    assert.equal(words.remedy, t(locale, duplicateWords.remedy));
    // Every variant of the server's text (an identical create or one of the same object, one the person can read or a colleague's, one AMCP
    // cannot look up) is worded by the page in one way: what is true of all of them, and what settles an earlier create.
    for (const message of [
      refusalText,
      'A create of the same object (the same name under the same parent) is already uncertain or still being sent, and AMCP could not tell the object each of them made from the other’s, so this one could make a second object. It belongs to a colleague. Only the person who prepared it can replace it, if it was not applied, and only they or the workspace owner can accept it, if it was applied: ask them.',
      'An identical create is already uncertain or still being sent, so this one could make a second object. AMCP cannot check that kind of create by reading the provider, so it cannot say whether it was applied, and a new review cannot replace it. Check the provider for the object. Nothing was prepared or sent.',
    ]) {
      const html = p.run('campaignJournal')(plan([{...heldStep(), error: {...heldError(), message}}])),
        text = visible(html);
      assert.ok(text.includes(words.message), message.slice(0, 40));
      assert.ok(text.includes(words.remedy), message.slice(0, 40));
      assert.ok(
        !text.includes(message.slice(0, 60)),
        'the server’s text for an MCP client is not the page’s: ' + message.slice(0, 40),
      );
      // The server's exact text is still on the page, under Error and remedy, for whoever needs it.
      assert.match(html, /<details class="workspace-details"><summary>[^<]*<\/summary><pre[^>]*>[^]*server_message/);
      assert.ok(html.includes(esc(message.slice(0, 60))), 'the server’s exact text is kept: ' + message.slice(0, 40));
      assert.doesNotMatch(text, agentTokens, message.slice(0, 40));
    }
    for (const text of [words.message, words.remedy]) assert.equal(p.run('agentDirected')(text), false, text);
    // Another step's error is worded as before: the generic remedy of its category stays the shell's.
    const other = visible(
      p.run('campaignJournal')(
        plan([
          {
            ...heldStep(),
            status: 'failed',
            error: {code: 'STATE_NOT_FOUND', message: 'No such target.', category: 'state'},
          },
        ]),
      ),
    );
    assert.ok(!other.includes(words.message));
    // The Arabic is a real translation of each sentence, and keeps what the English names: the plan page's button and the Operations page.
    for (const text of [duplicateWords.message, duplicateWords.remedy, 'Open the plan that holds it']) {
      assert.ok(Object.hasOwn(catalog, text), 'No Arabic for: ' + text);
      assert.match(catalog[text], /[\u0600-\u06ff]/u);
      assert.ok(!/[<>]/.test(catalog[text]));
    }
    assert.ok(catalog[duplicateWords.remedy].includes(catalog['Read back submitted step']));
    assert.ok(catalog[duplicateWords.remedy].includes(catalog.Operations));
  });
