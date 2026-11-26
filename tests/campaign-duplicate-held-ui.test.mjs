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
  // What to do, by what the refusal says (round 2, item 2, lead review S2-1 a and S3-2): the usual refusal names a create AMCP can read back and
  // the person can settle; the refusal of a create AMCP cannot look up, and of a colleague's, says something else.
  remedy:
    'Settle the earlier create first, in the plan that holds it (Read back submitted step) or in Operations. If it was applied, the object already exists: preparing this step again would make a second one. If it was not applied, preparing this step again replaces it.',
  uncheckable:
    'AMCP cannot look up this kind of create, so it cannot tell whether the earlier one was applied. Check at the provider whether the object exists. If it does, use it and do not create it again. If it does not, change this step’s request (its name, for example): a changed request is a new create.',
  colleague:
    'The earlier create belongs to a colleague. Ask them, or the workspace owner, to settle it first. If it was applied, the object already exists: preparing this step again would make a second one. If it was not applied, ask them to replace it where it was prepared.',
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
  // The website's own prepare_next answers with the whole plan, and its next call is the held step's own (S4-1: the page tells it from a run's stop).
  prepare: {...run, next_call: run.steps[0].error?.details?.next_call ?? settleCall},
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

// Fix round 2, item 4 (lead review S3-1): the Amend form's tick box said "invalidate the previous plan approval", which is false when the
// amendment changes nothing (the plan hash is recomputed from the same arguments, so the approval stands). The step the guard holds is
// refused an amendment that changes nothing (src/campaign-runner.ts recoverStep), and the sentence promises only what a save can do.
const approvalSentence = {
  unconditional: 'Save this correction and invalidate the previous plan approval.',
  conditional: 'Save this correction. If it changes the request, the previous plan approval is invalidated.',
};
const ticks = html =>
  [...html.matchAll(/<input name="confirmed" type="checkbox" required>([^<]*)<\/label>/g)].map(m => m[1].trim());
for (const locale of ['en', 'ar'])
  test(
    locale + ': the Amend form’s tick box does not say the approval is invalidated unless the request changes',
    async () => {
      const p = page(locale),
        run = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]);
      p.context.plan = run;
      p.context.after = answers(run).prepare;
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      // The field form of a held step.
      await p.bindings.get('#amend-campaign')();
      const field = p.node('#campaign-review').innerHTML;
      assert.deepEqual(ticks(field), [esc(t(locale, approvalSentence.conditional))]);
      assert.ok(!field.includes(esc(t(locale, approvalSentence.unconditional))), 'not the unconditional promise');
      // The native-arguments form of a failed step, which a response with a corrected request offers.
      const failed = {
        id: 'b',
        kind: 'write',
        status: 'failed',
        error: {code: 'WRITE_REJECTED', message: 'The provider refused the request.'},
        arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign'}},
        depends_on: [],
      };
      const other = page(locale),
        broken = plan([failed]);
      other.context.plan = broken;
      other.context.after = {};
      other.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      other.respond(async () => ({
        blocked: true,
        next_call: {
          tool: 'amcp_campaign',
          arguments: {action: 'recover_step', id: 'plan-1', step_id: 'b', confirmed: true},
          add_after_correction: {arguments: failed.arguments},
          correct:
            'Change what the error names in these arguments; the step is reviewed again before anything is sent.',
        },
      }));
      await other.bindings.get('#amend-campaign')();
      const native = other.node('#campaign-review').innerHTML;
      assert.match(native, /id="amend-arguments"/);
      for (const label of ticks(native)) assert.equal(label, esc(t(locale, approvalSentence.conditional)));
      assert.ok(ticks(native).length >= 1);
      // The Arabic is a real translation, and it keeps both halves of the sentence: the save and the condition.
      assert.ok(Object.hasOwn(catalog, approvalSentence.conditional), 'No Arabic for: ' + approvalSentence.conditional);
      assert.match(catalog[approvalSentence.conditional], /[\u0600-\u06ff]/u);
      assert.ok(!/[<>]/.test(catalog[approvalSentence.conditional]));
    },
  );

// Fix round 2, item 2 (lead review S2-1 a and S3-2): the page worded one remedy for every variant of the refusal, and it dropped the branch
// the server gives for a create that was applied ("accept that"): the person was led to prepare the step again, which makes a second object.
// It also sent the person to settle in the app a create AMCP cannot look up (refused for ever) and one that belongs to a colleague (whom
// Operations does not let them read). The words now follow the refusal: what is true of all, then what settles this variant.
const uncheckable = {
  details: {
    earlier_checkable: false,
    next_call: {
      tool: 'amcp_write',
      arguments: {action: 'status', review_id: 'review-earlier'},
      then: prepareNext('plan-1'),
    },
  },
};
const colleagues = {
  details: {
    earlier_review_id: undefined,
    earlier_next_call: undefined,
    readable: false,
    next_call: prepareNext('plan-1'),
  },
};
for (const locale of ['en', 'ar'])
  test(locale + ': the remedy follows the refusal: the usual, a create AMCP cannot look up, and a colleague’s', () => {
    const p = page(locale),
      variants = {
        remedy: {extra: {}},
        uncheckable: {extra: {...uncheckable.details}},
        colleague: {extra: {...colleagues.details}},
      };
    for (const [kind, {extra}] of Object.entries(variants)) {
      const run = plan([heldStep({earlier_plan_id: earlierPlan, ...extra})]);
      p.context.plan = run;
      const words = p.run('campaignDuplicateWords')(run.steps[0].error);
      assert.equal(words.message, t(locale, duplicateWords.message), kind);
      assert.equal(words.remedy, t(locale, duplicateWords[kind]), kind);
      // The journal and every answer say it, and say no other variant's.
      const journal = visible(p.run('campaignJournal')(run));
      const texts = {journal};
      for (const [how, out] of Object.entries(answers(run))) {
        p.context.out = out;
        texts[how] = visible(p.run('runOutcomeView(out, plan)'));
      }
      for (const [where, text] of Object.entries(texts)) {
        assert.ok(text.includes(t(locale, duplicateWords.message)), kind + ' ' + where);
        for (const other of ['remedy', 'uncheckable', 'colleague'])
          assert.equal(
            text.includes(t(locale, duplicateWords[other])),
            other === kind,
            kind + ' ' + where + ' ' + other,
          );
        assert.doesNotMatch(text, agentTokens, kind + ' ' + where);
      }
    }
    // The usual remedy keeps both branches of the server's: applied (the object exists: do not prepare again) and not applied (preparing the step again
    // replaces the earlier create, r25-field-plan item 3; a colleague's is replaced where it was prepared, by its owner).
    assert.match(
      duplicateWords.remedy,
      /If it was applied, the object already exists.*If it was not applied, preparing this step again replaces it\./,
    );
    assert.match(
      duplicateWords.colleague,
      /If it was applied, the object already exists.*If it was not applied, ask them to replace it where it was prepared\./,
    );
    // The remedy of a create AMCP cannot look up never sends the person to read it back or to prepare again: it is refused for ever.
    assert.doesNotMatch(duplicateWords.uncheckable, /Read back|Operations|prepare this step again/);
    // The Arabic of each: a translation, never the English left in a page, and the names the English points to.
    for (const key of ['remedy', 'uncheckable', 'colleague']) {
      const english = duplicateWords[key];
      assert.ok(Object.hasOwn(catalog, english), 'No Arabic for: ' + english);
      assert.match(catalog[english], /[\u0600-\u06ff]/u);
      assert.ok(!/[<>]/.test(catalog[english]));
    }
    assert.ok(catalog[duplicateWords.colleague].includes('مالك مساحة العمل'), 'the workspace owner is named');
  });

for (const locale of ['en', 'ar'])
  test(
    locale + ': the controls follow the refusal too: a create AMCP cannot look up is corrected, not prepared again',
    () => {
      const p = page(locale);
      // Not checkable: preparing again is refused for ever, so the way on is the correction of the request, which is not emphasized.
      for (const planId of [earlierPlan, undefined]) {
        const run = plan([heldStep({...uncheckable.details, earlier_plan_id: planId})]);
        p.context.plan = run;
        for (const [how, out] of Object.entries(answers(run))) {
          p.context.out = out;
          const html = p.run('runOutcomeView(out, plan)');
          assert.deepEqual(controlIds(html), ['outcome-correct-step'], how);
          assert.match(html, /id="outcome-correct-step" type="button" class="button"/, 'not emphasized: ' + how);
          assert.ok(visible(html).includes(t(locale, 'Correct blocked step')), how);
          assert.doesNotMatch(html, /outcome-prepare-again|outcome-earlier-plan/, how);
        }
        // The plan's own page shows no link to the earlier plan for it either: there is nothing to read back there.
        assert.doesNotMatch(p.run('campaignJournal')(run), /open-earlier-plan/);
      }
      // A colleague's create keeps preparing again (not emphasized): it is theirs to settle, and the guard lets the step through once they do.
      const run = plan([heldStep(colleagues.details)]);
      p.context.plan = run;
      p.context.out = answers(run).prepare;
      assert.deepEqual(controlIds(p.run('runOutcomeView(out, plan)')), ['outcome-prepare-again']);
    },
  );

// Fix round 2, item 5 (lead review S3-3): at execute the guard refuses a review prepared before its twin completed with
// DUPLICATE_OF_COMPLETED_WRITE, and the step goes back to pending, unsent (src/campaign-runner.ts holdDuplicate). The page held only the uncertain
// code, so that answer was announced as "Saved. Review the next step when you are ready." with the server's text (it names next_call, and stays
// English in Arabic) in the journal, and the plan's row emphasized Run. The page now holds it like the other: its own message and remedy.
const completedWords = {
  message:
    'An identical create completed after this step was prepared, so executing it would make a second object. Nothing was sent.',
  remedy:
    'Prepare the step again. The new review warns if the object was made in the last ten minutes; execute it only if you want a second one.',
};
const completedText =
  'An identical create completed after this review was prepared, so executing it would make a second object, and the person has not been shown that. Nothing was sent: prepare the request again (next_call); the new review carries the warning, and executing it makes the second object.';
const completedStep = (extra = {}, planId = 'plan-1') => ({
  ...heldStep({}, planId),
  error: {
    code: 'DUPLICATE_OF_COMPLETED_WRITE',
    message: completedText,
    category: 'state',
    details: {
      earlier_state: 'complete',
      earlier_review_id: 'review-earlier',
      submission: 'not_sent',
      next_call: prepareNext(planId),
      // The call that shows the warning (the guard's own at execute, src/write-review.ts expiredNext): the same request, prepared again.
      earlier_next_call: {
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway: 'meta_native_action',
          connection_id: 'login',
          arguments: {
            action: 'meta_campaign_create',
            account_id: '123',
            payload: {name: 'Synthetic campaign', status: 'PAUSED'},
          },
        },
      },
      ...extra,
    },
  },
});
const completedAnswers = run => ({
  execute: {
    view: 'compact',
    id: run.id,
    state: 'attention',
    steps: [{id: 'campaign', status: 'pending', error: 'DUPLICATE_OF_COMPLETED_WRITE'}],
    current: {step_id: 'campaign', status: 'pending', error: run.steps[0].error},
    next_call: prepareNext(run.id),
  },
  stop: {
    view: 'compact',
    id: run.id,
    state: 'attention',
    steps: [{id: 'campaign', status: 'pending', error: 'DUPLICATE_OF_COMPLETED_WRITE'}],
    current: {step_id: 'campaign', status: 'pending', error: run.steps[0].error},
    run: {
      executed: [],
      stopped: 'needs_attention',
      reason: 'Step campaign was refused (DUPLICATE_OF_COMPLETED_WRITE) ... prepare_next prepares the step again.',
      next_call: prepareNext(run.id),
    },
  },
});
for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a step held for a twin that completed is shown as waiting too: its own words, never "Saved.", and preparing it again leads',
    () => {
      const p = page(locale);
      for (const planId of [earlierPlan, undefined]) {
        const run = plan([completedStep({earlier_plan_id: planId, earlier_step_id: planId ? 'campaign' : undefined})]);
        p.context.plan = run;
        const words = p.run('campaignDuplicateWords')(run.steps[0].error);
        assert.equal(words.message, t(locale, completedWords.message));
        assert.equal(words.remedy, t(locale, completedWords.remedy));
        // The plan's row: the step is held, and its review is what leads (the review is where the warning is shown).
        assert.equal(p.run('campaignNextSafeAction')(run), 'review');
        assert.equal(p.run('campaignNeedsAmendment')(run), true, 'it may still be corrected on purpose');
        // The journal: pending, the page's words, and never the server's text for an MCP client.
        const journal = p.run('campaignJournal')(run),
          shown = visible(journal);
        assert.ok(shown.includes(t(locale, 'Pending')) && !shown.includes(t(locale, 'Failed')));
        assert.ok(shown.includes(words.message) && shown.includes(words.remedy));
        assert.doesNotMatch(shown, agentTokens);
        assert.ok(!shown.includes(completedText.slice(0, 60)), 'the server’s text is not the page’s');
        assert.ok(
          journal.includes(esc(completedText.slice(0, 60))),
          'the exact error is still kept under Error and remedy',
        );
        // The link to the plan that made the earlier object is offered, but it does not lead: preparing again does.
        if (planId)
          assert.match(journal, /<a id="open-earlier-plan" class="button small" href="\/campaigns\?id=plan-earlier">/);
        else assert.doesNotMatch(journal, /open-earlier-plan/);
        // Every answer about the step: the same words, never "Saved.", one emphasized control.
        for (const [how, out] of Object.entries({
          ...completedAnswers(run),
          prepare: {...run, next_call: prepareNext('plan-1')},
        })) {
          p.context.out = out;
          const html = p.run('runOutcomeView(out, plan)'),
            text = visible(html);
          assert.ok(text.includes(words.message) && text.includes(words.remedy), how);
          assert.ok(
            !text.includes(t(locale, 'Saved.')) &&
              !text.includes(t(locale, 'Saved. Review the next step when you are ready.')),
            how,
          );
          assert.doesNotMatch(text, agentTokens, how);
          assert.deepEqual(
            controlIds(html),
            planId ? ['outcome-prepare-again', 'outcome-earlier-plan'] : ['outcome-prepare-again'],
            how,
          );
          assert.match(
            html,
            /id="outcome-prepare-again" type="button" class="button primary"/,
            'prepare again leads: ' + how,
          );
          if (planId)
            assert.match(html, /<a id="outcome-earlier-plan" class="button" href="\/campaigns\?id=plan-earlier">/, how);
        }
        p.context.out = completedAnswers(run).stop;
        assert.ok(
          visible(p.run('runOutcomeView(out, plan)')).includes(t(locale, p.run('runStopLabels').needs_attention)),
        );
      }
      // The Arabic is a real translation of each sentence.
      for (const english of Object.values(completedWords)) {
        assert.ok(Object.hasOwn(catalog, english), 'No Arabic for: ' + english);
        assert.match(catalog[english], /[\u0600-\u06ff]/u);
        assert.ok(!/[<>]/.test(catalog[english]));
      }
      for (const text of Object.values(completedWords)) assert.equal(p.run('agentDirected')(text), false, text);
    },
  );

test('negative: a step held for an uncertain twin keeps its own outcome beside the completed one', () => {
  const p = page('en'),
    uncertain = plan([heldStep({earlier_plan_id: earlierPlan})]);
  p.context.plan = uncertain;
  assert.equal(p.run('campaignNextSafeAction')(uncertain), 'settle');
  p.context.out = answers(uncertain).execute;
  const html = p.run('runOutcomeView(out, plan)');
  assert.deepEqual(controlIds(html), ['outcome-earlier-plan']);
  assert.ok(visible(html).includes(duplicateWords.message));
  assert.ok(!visible(html).includes(completedWords.message));
});

// Fix round 2, item 3 (lead review S2-2): a review that repeats a create completed in the last ten minutes carries `duplicate_warning` (M2). No
// page showed it (it was only in the collapsed "Complete request" record), and a run that stopped with the warned review left the page saying only
// "A step needs your attention" while the plan's row emphasized Run, whose next click executed the review: a second object, shown to nobody. The
// review is now shown with the warning in the page's words and a tick of its own, which is the person's and is never sent; the plan's row leads with
// the review, and Run, while such a review waits, shows it instead of running.
const duplicateWords2 = {
  notice:
    'An identical create completed in the last ten minutes, so executing this review makes a second object. Execute it only if you want two.',
  tick: 'I want a second object, although an identical create completed in the last ten minutes.',
};
const warning = {
  earlier_state: 'complete',
  earlier_review_id: 'review-earlier',
  claimed_at: '2026-11-18T10:00:00.000Z',
  message:
    'An identical create completed in the last ten minutes. Executing this review makes a second object. Check with the user that two are wanted before it is executed.',
};
const warnedReview = (extra = {}) => ({
  review_id: 'review-2',
  idempotency_key: 'review-2',
  expires_at: new Date(Date.now() + 300000).toISOString(),
  summary: {text: 'Create 1 campaign.', operation: 'create', entity: 'campaign', count: 1},
  request: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
  execute_requirements: {},
  duplicate_warning: warning,
  ...extra,
});
const readyStep = review => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  account_id: '123',
  description: 'Create the paused campaign',
  depends_on: [],
  arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign', status: 'PAUSED'}},
  status: 'review_ready',
  review_id: review.review_id,
  review,
});
const warnedStop = review => ({
  view: 'compact',
  id: 'plan-1',
  state: 'attention',
  steps: [{id: 'campaign', status: 'review_ready'}],
  review: {...review, step_id: 'campaign'},
  run: {
    executed: [],
    stopped: 'needs_attention',
    reason:
      'Step campaign was refused earlier (DUPLICATE_OF_UNCERTAIN_WRITE) ... It is prepared again, and the new review carries a warning that says so: show the user this review, and only if they want a second object, execute_next with it.',
    next_call: {tool: 'amcp_campaign', arguments: {action: 'execute_next', id: 'plan-1', review_id: 'review-2'}},
  },
});

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a review that repeats a completed create shows the warning in the page’s words, with a tick that is never sent',
    () => {
      const p = page(locale),
        review = warnedReview(),
        markup = p.run('readableReview')(review, t(locale, 'Execute reviewed campaign step')),
        text = visible(markup);
      assert.ok(text.includes(t(locale, duplicateWords2.notice)), 'the warning is in the page’s words');
      assert.ok(text.includes(t(locale, duplicateWords2.tick)), 'with a tick of its own');
      assert.doesNotMatch(text, agentTokens);
      assert.ok(!text.includes('Check with the user'), 'not the server’s text, which is written for an MCP client');
      assert.match(markup, /<p class="notice warning" role="note">/);
      assert.match(markup, /<input id="duplicate-consent" type="checkbox">/);
      // The notice leads: before the request table and the authorizations.
      assert.ok(markup.indexOf('notice warning') < markup.indexOf('review-table'));
      // Without the warning, nothing of it.
      const plain = p.run('readableReview')(warnedReview({duplicate_warning: undefined}), 'Execute');
      assert.doesNotMatch(plain, /duplicate-consent|notice warning/);
      // Both boxes are needed, and only the server's own flag is sent.
      assert.throws(() => p.run('readReviewConsents')(review), /./, 'nothing ticked');
      p.node('#review-consent').checked = true;
      assert.throws(() => p.run('readReviewConsents')(review), /./, 'the duplicate acknowledgement is missing');
      p.node('#duplicate-consent').checked = true;
      assert.deepEqual(JSON.parse(JSON.stringify(p.run('readReviewConsents')(review))), {confirmed: true});
      // Another review is asked for its own boxes only.
      const other = warnedReview({duplicate_warning: undefined});
      p.node('#duplicate-consent').checked = false;
      assert.deepEqual(JSON.parse(JSON.stringify(p.run('readReviewConsents')(other))), {confirmed: true});
      // The Arabic is a translation of each sentence.
      for (const english of Object.values(duplicateWords2)) {
        assert.ok(Object.hasOwn(catalog, english), 'No Arabic for: ' + english);
        assert.match(catalog[english], /[\u0600-\u06ff]/u);
        assert.ok(!/[<>]/.test(catalog[english]));
      }
    },
  );

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a run that stopped with a warned review shows that review, and executing it sends only the review’s own consents',
    async () => {
      const p = page(locale),
        review = warnedReview(),
        run = plan([readyStep(review)]);
      p.context.plan = run;
      p.context.after = warnedStop(review);
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      const shown = p.node('#campaign-review').innerHTML,
        text = visible(shown);
      // The stop's own words, then the review with its warning and tick: not a page that says only that a step needs attention.
      assert.ok(text.includes(t(locale, p.run('runStopLabels').needs_attention)));
      assert.ok(text.includes(t(locale, duplicateWords2.notice)));
      assert.match(shown, /id="execute-reviewed"/);
      assert.match(shown, /id="duplicate-consent"/);
      assert.doesNotMatch(text, agentTokens);
      // Executing needs both ticks, and sends execute_next for exactly that review with `confirmed` and never the page's own acknowledgement.
      p.respond(async () => ({view: 'compact', id: 'plan-1', state: 'complete', steps: []}));
      await assert.rejects(() => p.bindings.get('#execute-reviewed')(), /./);
      assert.equal(p.calls.length, 0, 'nothing is sent while the boxes are not ticked');
      p.node('#review-consent').checked = true;
      await assert.rejects(() => p.bindings.get('#execute-reviewed')(), /./);
      assert.equal(p.calls.length, 0, 'nor with only the authorization ticked');
      p.node('#duplicate-consent').checked = true;
      await p.bindings.get('#execute-reviewed')();
      assert.deepEqual(p.calls[0].args, {
        action: 'execute_next',
        id: 'plan-1',
        review_id: 'review-2',
        idempotency_key: 'review-2',
        confirmed: true,
      });
    },
  );

test('the plan’s row leads with the review of a step whose review carries the warning, and Run shows that review instead of running', async () => {
  const p = page('en'),
    review = warnedReview(),
    warned = plan([readyStep(review)]),
    clean = plan([readyStep(warnedReview({duplicate_warning: undefined}))]);
  assert.equal(p.run('campaignNextSafeAction')(warned), 'review');
  assert.equal(p.run('campaignNextSafeAction')(clean), '', 'a review with no warning leaves the plan as it was');
  // Run, with the warned review waiting, asks for the review (the website's own prepare_next) and shows it; it never calls run.
  p.context.plan = warned;
  p.context.after = undefined;
  p.node('#next-campaign').classList = {
    names: [],
    add(name) {
      this.names.push(name);
    },
  };
  p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
  assert.deepEqual(p.node('#next-campaign').classList.names, ['primary'], 'Review next step is the emphasized one');
  p.respond(async (tool, args) => ({...warned, review, next_call: {tool: 'amcp_campaign', arguments: args}}));
  await p.bindings.get('#run-campaign')();
  assert.deepEqual(
    p.calls.map(call => call.args.action),
    ['prepare_next'],
    'run was never called',
  );
  assert.match(p.node('#campaign-review').innerHTML, /id="duplicate-consent"/, 'the warned review is what is shown');
  // With no warning, Run runs, as before.
  const q = page('en');
  q.context.plan = clean;
  q.context.after = undefined;
  q.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
  q.respond(async () => ({view: 'compact', id: 'plan-1', state: 'complete', steps: []}));
  await q.bindings.get('#run-campaign')();
  assert.deepEqual(
    q.calls.map(call => call.args.action),
    ['run'],
  );
});

// Fix round 2, item 6 (lead review S4-1): the page took any whole-plan answer that has `steps` and a `next_call` and no `blocked`, `approved` or `current`
// as being about the held step. A run that paused ("time", "limit") builds its stop without `current`, and its next call is `run`: it was worded as
// the held step's outcome, with the held step's controls. The website's own prepare_next answers with the whole plan, and its next call is the held
// step's own, or the plan's prepare_next (a twin still being sent, a colleague's): only such an answer is about the held step.
for (const locale of ['en', 'ar'])
  test(
    locale + ': only the answer of preparing the held step is worded as its outcome: a run that paused is not',
    () => {
      const p = page(locale),
        run = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]);
      p.context.plan = run;
      const runCall = {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}};
      // A run that paused to stay responsive, before it reached the held step: a whole plan with no `current`, whose next call is `run`.
      for (const stopped of ['time', 'limit']) {
        p.context.out = {
          ...run,
          steps: run.steps.map(s => ({id: s.id, status: s.status, error: s.error?.code})),
          run: {executed: ['earlier'], stopped, next_call: runCall},
          next_call: runCall,
        };
        const html = p.run('runOutcomeView(out, plan)'),
          text = visible(html);
        assert.deepEqual(controlIds(html), ['outcome-continue'], stopped + ': the run is continued');
        assert.ok(!text.includes(t(locale, duplicateWords.message)), stopped + ': nothing is said of the held step');
        assert.doesNotMatch(html, /outcome-earlier-plan|outcome-prepare-again/, stopped);
      }
      // The same answer with the next call of preparing the held step is its outcome: the step's own call, and the plan's prepare_next.
      for (const next of [run.steps[0].error.details.next_call, prepareNext('plan-1')]) {
        p.context.out = {...run, next_call: next};
        const text = visible(p.run('runOutcomeView(out, plan)'));
        assert.ok(text.includes(t(locale, duplicateWords.message)), JSON.stringify(next).slice(0, 80));
      }
      // Any other next call is not: an answer that leads to another action is shown as it was.
      for (const next of [runCall, {tool: 'amcp_campaign', arguments: {action: 'get', id: 'plan-1'}}, undefined]) {
        p.context.out = {...run, next_call: next};
        const text = visible(p.run('runOutcomeView(out, plan)'));
        assert.ok(!text.includes(t(locale, duplicateWords.message)), JSON.stringify(next ?? null));
      }
    },
  );

// Fix round 3, item 3 (lead re-review S4-c): the engine refuses a save of the Amend form that changes nothing, for a step the guard against creating
// twice holds (round 2, item 4), in English that names the guard's code and `next_call`, with no Arabic. For a create AMCP cannot look up the page's only
// control is the correction of the request, whose form is pre-filled with the current value, so a person who saved it unchanged read that text. The page
// now compares the value to the step's own before it asks the server, and refuses an unchanged save in its own words.
const unchangedSave =
  'Change the request first. Saved unchanged, it would leave this step held back by the earlier create.';
for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a save of the Amend form that changes nothing is refused on the page, in its own words, for a step the guard holds',
    async () => {
      const p = page(locale),
        run = plan([heldStep({earlier_plan_id: earlierPlan, earlier_step_id: 'campaign'})]);
      p.context.plan = run;
      p.context.after = answers(run).prepare;
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      await p.bindings.get('#amend-campaign')();
      const form = p.node('#amend-step');
      // The fields of the step's arguments, in order: /action, /payload/name, /payload/status. The name, saved as it is.
      form.elements.field.value = '1';
      form.elements.value.value = 'Synthetic campaign';
      form.elements.confirmed.checked = true;
      await assert.rejects(
        () => p.bindings.get('#amend-step')(),
        error => {
          assert.equal(error.message, t(locale, unchangedSave));
          assert.doesNotMatch(error.message, agentTokens, 'nothing of the engine’s text reaches a person');
          assert.doesNotMatch(error.message, /DUPLICATE_OF/);
          return true;
        },
      );
      assert.equal(p.calls.length, 0, 'nothing was asked of the server');
      // A changed value is sent, as it was.
      form.elements.value.value = 'Another campaign';
      p.respond(async () => ({...run, next_call: prepareNext('plan-1')}));
      await p.bindings.get('#amend-step')();
      assert.equal(p.calls.length, 1);
      assert.deepEqual(p.calls[0].args.patch, [{path: '/payload/name', value: 'Another campaign'}]);
      // The Arabic is a translation of the sentence.
      assert.ok(Object.hasOwn(catalog, unchangedSave), 'No Arabic for: ' + unchangedSave);
      assert.match(catalog[unchangedSave], /[\u0600-\u06ff]/u);
      assert.ok(!/[<>]/.test(catalog[unchangedSave]));
    },
  );

test('negative: a save that changes nothing is still sent for a step that is not held (a failed step may be retried as it is)', async () => {
  const p = page('en'),
    failed = {
      id: 'b',
      kind: 'write',
      status: 'failed',
      error: {code: 'WRITE_REJECTED', message: 'The provider refused the request.'},
      arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic campaign'}},
      depends_on: [],
    },
    broken = plan([failed]);
  p.context.plan = broken;
  p.context.after = {};
  p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
  p.respond(async () => ({
    blocked: true,
    next_call: {
      tool: 'amcp_campaign',
      arguments: {action: 'recover_step', id: 'plan-1', step_id: 'b', confirmed: true},
    },
  }));
  await p.bindings.get('#amend-campaign')();
  p.calls.length = 0;
  const form = p.node('#amend-step');
  form.elements.field.value = '1';
  form.elements.value.value = 'meta_campaign_create';
  form.elements.confirmed.checked = true;
  await p.bindings.get('#amend-step')();
  assert.equal(p.calls.at(-1).args.action, 'recover_step', 'the engine decides: the page does not refuse it');
});

// r25-mf-groups, the Opus review of 2026-11-25 (S3-2): an earlier create that was answered only in part, or without confirming every object, is warned about
// for 24 hours (src/write-duplicates.ts repeatedCreateWarning: `earlier_outcome: 'partial_or_failed'`), and some of its objects may already exist. The page
// said "An identical create completed in the last ten minutes ... a second object" for it, which is false of such a twin: it says "may" instead, for the
// review, its tick and the step that is held for a twin answered in part after its review was prepared (DUPLICATE_OF_COMPLETED_WRITE, details.earlier_outcome).
const partialWords = {
  notice:
    'An identical create was answered in the last 24 hours only in part, or without confirming every object, so some of its objects may already exist, and executing this review may make them a second time. Check at the provider whether they exist, and execute this review only if you want them made again.',
  tick: 'I want these objects made, although some may already exist: an identical create was answered in the last 24 hours only in part, or without confirming every object.',
  message:
    'An identical create was answered after this step was prepared, only in part or without confirming every object, so executing it may make some objects a second time. Nothing was sent.',
  remedy:
    'Prepare the step again. The new review carries the warning; check at the provider whether the objects exist, and execute it only if you want them made again.',
};
const partialWarning = {
  ...warning,
  earlier_outcome: 'partial_or_failed',
  message:
    'An identical create was answered in the last 24 hours only in part, or without confirming every object, so some or all of its objects may already exist. Executing this review may make them a second time. Check the provider for them, and check with the user that a repeat is wanted, before it is executed.',
};
for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a review that repeats a create answered only in part says its objects may exist, with a tick of its own that is never sent',
    () => {
      const p = page(locale),
        // A group's aggregate (src/write-duplicates.ts repeatedGroupWarning) says it for every part, whichever of them is the partial one.
        aggregate = {
          ...partialWarning,
          parts: [
            {part: 1, earlier_review_id: 'review-earlier', earlier_outcome: 'partial_or_failed'},
            {part: 2, earlier_review_id: 'review-earlier-2'},
          ],
        };
      for (const duplicate_warning of [partialWarning, aggregate]) {
        const review = warnedReview({duplicate_warning}),
          markup = p.run('readableReview')(review, t(locale, 'Execute reviewed campaign step')),
          text = visible(markup);
        assert.ok(text.includes(t(locale, partialWords.notice)), 'the notice says "may"');
        assert.ok(text.includes(t(locale, partialWords.tick)), 'and so does the tick');
        assert.ok(!text.includes(t(locale, duplicateWords2.notice)), 'not "completed in the last ten minutes"');
        assert.ok(!text.includes(t(locale, duplicateWords2.tick)));
        assert.doesNotMatch(text, agentTokens);
        assert.ok(!text.includes('check with the user'), 'not the server’s text, which is written for an MCP client');
        assert.match(markup, /<p class="notice warning" role="note">/);
        assert.equal(markup.match(/<input id="duplicate-consent" type="checkbox">/g)?.length, 1, 'one box');
        assert.ok(markup.indexOf('notice warning') < markup.indexOf('review-table'), 'the notice leads');
        // The box is needed, and only the server's own flag is sent: the acknowledgement is the person's and stays on the page.
        p.node('#review-consent').checked = true;
        p.node('#duplicate-consent').checked = false;
        assert.throws(() => p.run('readReviewConsents')(review), /./, 'the acknowledgement is missing');
        p.node('#duplicate-consent').checked = true;
        assert.deepEqual(JSON.parse(JSON.stringify(p.run('readReviewConsents')(review))), {confirmed: true});
      }
      // A twin that completed keeps its words, and nothing of "may" is in them.
      const certain = visible(p.run('readableReview')(warnedReview(), 'Execute'));
      assert.ok(
        certain.includes(t(locale, duplicateWords2.notice)) && certain.includes(t(locale, duplicateWords2.tick)),
      );
      assert.ok(!certain.includes(t(locale, partialWords.notice)) && !certain.includes(t(locale, partialWords.tick)));
      // The Arabic is a translation of each sentence, and none of them is written for an MCP client.
      for (const english of Object.values(partialWords)) {
        assert.ok(Object.hasOwn(catalog, english), 'No Arabic for: ' + english);
        assert.match(catalog[english], /[؀-ۿ]/u);
        assert.ok(!/[<>]/.test(catalog[english]));
        assert.equal(p.run('agentDirected')(english), false, english);
      }
    },
  );

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a step held for a twin answered in part after it was prepared says some objects may exist, and is prepared again like the other',
    () => {
      const p = page(locale);
      for (const planId of [earlierPlan, undefined]) {
        const run = plan([
          completedStep({
            earlier_outcome: 'partial_or_failed',
            earlier_plan_id: planId,
            earlier_step_id: planId ? 'campaign' : undefined,
          }),
        ]);
        p.context.plan = run;
        const words = p.run('campaignDuplicateWords')(run.steps[0].error);
        assert.equal(words.message, t(locale, partialWords.message));
        assert.equal(words.remedy, t(locale, partialWords.remedy));
        // The journal and every answer about the step say it, never "completed ... a second object", and lead with preparing the step again.
        const texts = {journal: visible(p.run('campaignJournal')(run))};
        for (const [how, out] of Object.entries({
          ...completedAnswers(run),
          prepare: {...run, next_call: prepareNext('plan-1')},
        })) {
          p.context.out = out;
          const html = p.run('runOutcomeView(out, plan)');
          texts[how] = visible(html);
          assert.deepEqual(
            controlIds(html),
            planId ? ['outcome-prepare-again', 'outcome-earlier-plan'] : ['outcome-prepare-again'],
            how,
          );
          assert.match(html, /id="outcome-prepare-again" type="button" class="button primary"/, how);
        }
        for (const [where, text] of Object.entries(texts)) {
          assert.ok(text.includes(words.message) && text.includes(words.remedy), where);
          assert.ok(!text.includes(t(locale, completedWords.message)), where + ': not the completed twin’s words');
          assert.ok(!text.includes(t(locale, completedWords.remedy)), where);
          assert.doesNotMatch(text, agentTokens, where);
        }
      }
      // The refusal of a twin that completed keeps its own words, with or without the field.
      for (const extra of [{}, {earlier_outcome: 'complete'}]) {
        const words = p.run('campaignDuplicateWords')(completedStep(extra).error);
        assert.equal(words.message, t(locale, completedWords.message));
        assert.equal(words.remedy, t(locale, completedWords.remedy));
      }
    },
  );
