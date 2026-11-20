import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';
import {MirrorError, errorResult} from '../dist/src/errors.js';

/**
 * WEB-03: one website presentation layer for errors, run stops and next actions. Before, the website printed run stop
 * codes ("time", "needs_attention") and the server's MCP-client instructions ("execute_next with it continues the step",
 * "details.next_call", "send the call again") to people, ran the message, remedy and reference together, showed a
 * report Pull refusal 1,000 px above the run bar, named no field in a JSON mistake and kept a Run button after the
 * plan approval expired. These tests run the real page scripts in a VM with synthetic responses; nothing reaches a
 * server or provider.
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  app = readFileSync('web/app.js', 'utf8'),
  presentationSource = app.slice(app.indexOf('function requestError('), app.indexOf("const content = $('#content')"));
// What an MCP client is told and a person must never be: tool and action names, envelope paths and consent flags.
const agentTokens = /execute_next|next_call|prepare_next|recover_step|reconcile_step|confirmed: true|details\.[a-z]/;
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

function page(locale = 'en', extra = {}) {
  const nodes = new Map(),
    bindings = new Map(),
    lists = new Map(),
    calls = [],
    toasts = [];
  let handler = async () => ({});
  const element = selector => {
    const listeners = new Map();
    return {
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
      scrolled: 0,
      listeners,
      elements: new Proxy({}, {get: (controls, name) => (controls[name] ??= element('control:' + String(name)))}),
      options: [],
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
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
      focus() {
        context.document.activeElement = this;
      },
      scrollIntoView() {
        this.scrolled++;
      },
    };
  };
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
      querySelectorAll: selector => lists.get(selector) ?? [],
      getElementById: id => node('#' + id),
      createElement: () => element('new'),
    },
    $: node,
    content: node('#content'),
    esc,
    date: String,
    toast: text => toasts.push(text),
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
    ...extra,
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(presentationSource);
  return {
    context,
    run,
    node,
    nodes,
    bindings,
    lists,
    calls,
    toasts,
    respond(fn) {
      handler = fn;
    },
    async call(tool, args) {
      calls.push({tool, args: JSON.parse(JSON.stringify(args))});
      return handler(tool, args);
    },
  };
}
/** A page with the campaign scripts loaded and its workspace calls answered by `respond`. */
function campaignPage(locale = 'en') {
  const p = page(locale);
  p.run(readFileSync('web/workspace.js', 'utf8'));
  p.run(readFileSync('web/campaign-workflows.js', 'utf8'));
  p.context.workspaceBind = (selector, fn) => p.bindings.set(selector, fn);
  p.context.workspaceCall = (tool, args) => p.call(tool, args);
  return p;
}
/** The server's own refusal envelope for a code, as the website receives it. */
const refusal = (p, code, message, details = {}) =>
  p.context.requestError(errorResult(new MirrorError(code, message, details), 'synthetic-reference-0001', 0));
const ast = file => parsers['babel-ts'].parse(readFileSync(file, 'utf8'));
function walk(n, visit) {
  if (!n || typeof n !== 'object') return;
  visit(n);
  for (const [key, value] of Object.entries(n))
    if (!['loc', 'extra', 'comments', 'tokens', 'leadingComments', 'trailingComments'].includes(key))
      for (const child of Array.isArray(value) ? value : [value]) walk(child, visit);
}
/** The string values an expression can take: a literal, or each branch of a conditional. */
const literals = n =>
  n?.type === 'StringLiteral'
    ? [n.value]
    : n?.type === 'ConditionalExpression'
      ? [...literals(n.consequent), ...literals(n.alternate)]
      : [];

test('every run stop of the campaign runner, remedy category and provider layer has website wording', () => {
  const p = campaignPage();
  // run.stopped: the reasons runApproved passes to stop(); `'needs_' + human` takes each value of `human`, and the stop
  // a person's decision waits for (WRT-09) is each value of `personDecisions`.
  const stops = new Set(),
    human = [],
    decisions = [];
  walk(ast('src/campaign-runner.ts'), n => {
    if (n.type === 'VariableDeclarator' && n.id?.name === 'human') human.push(...literals(n.init));
    if (n.type === 'VariableDeclarator' && n.id?.name === 'personDecisions')
      for (const property of n.init?.properties ?? []) decisions.push(...literals(property.value));
    if (n.type === 'CallExpression' && n.callee?.name === 'stop' && n.arguments[1]) {
      const reason = n.arguments[1];
      if (reason.type === 'BinaryExpression' && reason.left.type === 'StringLiteral')
        stops.add(reason.left.value + '*');
      else for (const value of literals(reason)) stops.add(value);
    }
  });
  assert.deepEqual(human.sort(), [
    'cap_override_confirmed',
    'creative_edit_confirmed',
    'destructive_confirmed',
    'spend_change_confirmed',
  ]);
  assert.deepEqual(decisions.sort(), ['needs_destructive_confirmed', 'needs_owner_approval', 'needs_website_approval']);
  const expanded = [...[...stops].flatMap(s => (s === 'needs_*' ? human.map(h => 'needs_' + h) : [s])), ...decisions];
  assert.ok(expanded.length >= 12, expanded.join());
  const labels = p.run('runStopLabels');
  for (const stop of [...expanded, 'blocked']) {
    assert.ok(Object.hasOwn(labels, stop), 'No website wording for run.stopped ' + stop);
    assert.ok(Object.hasOwn(catalog, labels[stop]), 'No Arabic for ' + stop);
  }
  // Remedy categories: every literal category errorRemedy, its family rules and their r() helper can return.
  const categories = new Set();
  walk(ast('src/errors.ts'), n => {
    if (n.type === 'ObjectProperty' && n.key?.name === 'category') for (const v of literals(n.value)) categories.add(v);
    if (n.type === 'CallExpression' && n.callee?.name === 'r' && n.arguments[0]?.type === 'StringLiteral')
      categories.add(n.arguments[0].value);
  });
  assert.ok(categories.size >= 10, [...categories].join());
  const byCategory = p.run('websiteCategoryRemedies');
  for (const category of categories) {
    assert.ok(Object.hasOwn(byCategory, category), 'No website wording for remedy category ' + category);
    assert.ok(Object.hasOwn(catalog, byCategory[category]), 'No Arabic for category ' + category);
  }
  // Provider-error layers (PRV-01): each one that names who must act; `unknown` is never guessed.
  const taxonomy = readFileSync('src/provider-error-taxonomy.ts', 'utf8'),
    union = /export type ProviderErrorLayer =([^;]+);/.exec(taxonomy)[1],
    layers = [...union.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).filter(l => l !== 'unknown');
  const byLayer = p.run('providerLayerRemedies');
  assert.deepEqual(Object.keys(byLayer).sort(), layers.sort());
  // Every website wording, by code, message or run outcome, has Arabic and addresses the person, not an MCP client.
  const wording = [
    ...p.run('websiteRemedies').map(([, text]) => text),
    ...Object.values(byLayer),
    ...Object.values(byCategory),
    ...Object.values(labels),
    ...Object.values(p.run('runRecoveryLabels')),
    ...Object.values(p.run('websiteMessages')).flatMap(fn => [fn('another connection'), fn('')]),
    ...p.run('websiteSafetyFacts').map(([, text]) => text),
  ];
  for (const text of wording) {
    assert.ok(Object.hasOwn(catalog, text), 'Missing Arabic: ' + text);
    assert.equal(p.run('agentDirected')(text), false, 'Website wording addresses an MCP client: ' + text);
  }
});

for (const locale of ['en', 'ar'])
  test(locale + ': each run stop renders its meaning and the one control that continues it', () => {
    const p = campaignPage(locale),
      run = {id: 'plan-1', steps: [{id: 'upload', review_id: 'review-1', status: 'verifying'}]};
    p.context.plan = run;
    const expected = {
      complete: [],
      time: ['outcome-continue'],
      limit: ['outcome-continue'],
      not_sent: ['outcome-continue'],
      waiting: ['outcome-read-back'],
      needs_attention: [],
      needs_spend_change_confirmed: ['outcome-review-step'],
      needs_cap_override_confirmed: ['outcome-review-step'],
      needs_creative_edit_confirmed: ['outcome-review-step'],
      // WRT-09: without an approval page of this site, the step's review says who approves it; Continue would only stop
      // here again.
      needs_destructive_confirmed: ['outcome-review-step'],
      needs_website_approval: ['outcome-review-step'],
      needs_owner_approval: ['outcome-review-step'],
      // R25 M1 (L5-04): the provider's state changed after the step's review. Nothing was sent, and the outcome offers no
      // Continue (an automatic retry): the person reviews the step again, on its current state.
      state_changed: ['outcome-review-step'],
    };
    const labels = p.run('runStopLabels');
    for (const [stopped, controls] of Object.entries(expected)) {
      p.context.out = {
        run: {
          executed: ['campaign'],
          stopped,
          retry_after_ms: 4200,
          // The server's reason, written for MCP clients, never reaches the page's text.
          reason: 'Step x needs spend_change_confirmed. Show the user this review; execute_next with it continues.',
          next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}},
        },
      };
      const html = p.run('runOutcomeView(out, plan)'),
        text = visible(html);
      assert.ok(text.includes(t(locale, labels[stopped])), stopped);
      assert.doesNotMatch(text, agentTokens, stopped);
      // The stop code itself is never the message (before, the page printed "time" or "needs_attention").
      assert.doesNotMatch(text, /\b(?:not_sent|needs_[a-z_]+)\b/, 'a raw stop code: ' + stopped);
      assert.notEqual(text.trim().split(/\s+/)[0], stopped);
      assert.deepEqual(
        [...html.matchAll(/id="(outcome-[a-z-]+)"/g)].map(m => m[1]),
        controls,
        stopped,
      );
      if (stopped !== 'complete') assert.ok(text.includes(locale === 'ar' ? 'نُفّذت 1 خطوة' : '1 step ran'), stopped);
      if (stopped === 'not_sent') assert.ok(text.includes(locale === 'ar' ? 'نحو 5 ثانية' : 'about 5 seconds'));
    }
    // Recovery kinds: each names the step's way forward and its control.
    for (const [out, control] of [
      [
        {
          blocked: true,
          recovery: 'Amend it with recover_step (next_call).',
          next_call: {tool: 'amcp_campaign', arguments: {action: 'recover_step', id: 'plan-1', step_id: 's'}},
        },
        'outcome-amend',
      ],
      [
        {
          blocked: true,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'confirm_absent', id: 'plan-1', step_id: 's'}},
        },
        'outcome-confirm-absent',
      ],
      [
        {
          blocked: true,
          next_call: {tool: 'amcp_campaign', arguments: {action: 'reconcile_step', id: 'plan-1', step_id: 's'}},
        },
        'outcome-read-back',
      ],
      [
        {
          decision: 'accept_observed: true',
          next_call: {
            tool: 'amcp_campaign',
            arguments: {action: 'reconcile_step', id: 'plan-1', step_id: 's'},
            add_after_user_approval: {accept_observed: true},
          },
        },
        'outcome-accept',
      ],
      [
        {approved: {by: 'a'}, next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}}},
        'outcome-continue',
      ],
      [
        {state: 'draft', next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: 'plan-1'}}},
        'outcome-review-step',
      ],
      [
        {blocked: true, next_call: {tool: 'amcp_campaign', arguments: {action: 'preflight', id: 'plan-1'}}},
        'outcome-preflight',
      ],
    ]) {
      p.context.out = out;
      const html = p.run('runOutcomeView(out, plan)');
      assert.match(html, new RegExp('id="' + control + '"'), JSON.stringify(out));
      assert.doesNotMatch(visible(html), agentTokens, JSON.stringify(out));
    }
    p.context.out = {blocked: true, next_call: {tool: 'amcp_write', arguments: {action: 'reconcile', review_id: 'r'}}};
    assert.match(p.run('runOutcomeView(out, plan)'), /href="\/operations"/);
  });

// R2.5 r25-field-plan (the owner's Google issue 2): a plan that adds keywords or locations names no money or status field, yet each of its
// reviews asks for the spending acknowledgement, so the approval names those steps (`spend_effect`) and the page offers the tick for them: the
// approval it saves then covers them, and the run does not stop at each.
for (const locale of ['en', 'ar'])
  test(locale + ': the plan approval offers the spending tick for a step whose review asks for it', () => {
    const p = campaignPage(locale),
      step = {id: 'keywords', gateway: 'google_ads_native_action', action: 'x', account_id: '1', fields_total: 0};
    const summary = spendEffect => ({
      steps: [{...step, ...(spendEffect === undefined ? {} : {spend_effect: spendEffect})}],
    });
    p.context.spending = summary(true);
    p.context.plain = summary(false);
    p.context.unnamed = summary(undefined);
    assert.equal(p.run('approvalSpending(spending)'), true);
    assert.match(p.run('approvalView(spending)'), /id="plan-spend-consent"/);
    // A step the approval shows as not spending, or names no effect, is offered no tick: the page asks only for what it shows.
    assert.equal(p.run('approvalSpending(plain)'), false);
    assert.doesNotMatch(p.run('approvalView(plain)'), /plan-spend-consent/);
    assert.equal(p.run('approvalSpending(unnamed)'), false);
  });

for (const locale of ['en', 'ar'])
  test(
    locale + ': a run that stops for a spending acknowledgement shows its review here, consent unchecked',
    async () => {
      const p = campaignPage(locale),
        plan = {id: 'plan-1', plan_hash: 'h', steps: [{id: 'budget', status: 'review_ready'}]},
        review = {
          review_id: 'review-7',
          idempotency_key: 'review-7',
          expires_at: new Date(Date.now() + 240000).toISOString(),
          request: {method: 'POST', path: '/v1/campaigns/1', body: {daily_budget: 5000}},
          execute_requirements: {spend_change_confirmed: true},
        };
      p.context.plan = plan;
      p.context.after = {
        outcome: {
          run: {
            executed: [],
            stopped: 'needs_spend_change_confirmed',
            reason: 'execute_next with it continues the step',
          },
          review,
        },
      };
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      const html = p.node('#campaign-review').innerHTML;
      assert.ok(visible(html).includes(t(locale, p.run('runStopLabels').needs_spend_change_confirmed)));
      assert.match(html, /id="spend-consent" type="checkbox">/, 'the acknowledgement starts unchecked');
      assert.doesNotMatch(html, /checked/);
      assert.doesNotMatch(visible(html), /execute_next/);
      // Without the ticks nothing is sent; with them, exactly this review and key are executed.
      // Design review 2026-10: the refusal stands beside the boxes, focuses the first one not ticked and is not a toast
      // (before, the error was the first box's label itself, shown for six seconds in the corner).
      // A description a box already has stays beside the refusal and after it (review fix: it was overwritten).
      p.node('#spend-consent').setAttribute('aria-describedby', 'spend-consent-help');
      await assert.rejects(p.bindings.get('#execute-reviewed')(), {
        message: t(locale, 'Tick each authorization above to execute this request.'),
        presented: true,
      });
      assert.equal(p.calls.length, 0);
      const refusalNote = p.node('#review-consent-error');
      assert.equal(refusalNote.hidden, false);
      assert.equal(refusalNote.textContent, t(locale, 'Tick each authorization above to execute this request.'));
      assert.equal(p.context.document.activeElement, p.node('#review-consent'), 'the first box not ticked has focus');
      for (const box of ['#review-consent', '#spend-consent']) {
        assert.equal(p.node(box).getAttribute('aria-invalid'), 'true', box);
        assert.match(p.node(box).getAttribute('aria-describedby'), /review-consent-error/, box);
      }
      assert.equal(
        p.node('#spend-consent').getAttribute('aria-describedby'),
        'spend-consent-help review-consent-error',
      );
      assert.deepEqual(p.toasts, []);
      // One box left: the refusal names a single authorization.
      p.node('#review-consent').checked = true;
      await assert.rejects(p.bindings.get('#execute-reviewed')(), {
        message: t(locale, 'Tick the authorization above to execute this request.'),
      });
      assert.equal(p.node('#review-consent').getAttribute('aria-invalid'), null, 'a ticked box is no longer invalid');
      assert.equal(p.context.document.activeElement, p.node('#spend-consent'));
      p.node('#review-consent').checked = false;
      p.node('#review-consent').checked = true;
      p.node('#spend-consent').checked = true;
      p.respond(async () => ({run: {executed: ['budget'], stopped: 'complete'}}));
      await p.bindings.get('#execute-reviewed')();
      assert.equal(p.node('#spend-consent').getAttribute('aria-describedby'), 'spend-consent-help');
      assert.equal(p.node('#review-consent').getAttribute('aria-describedby'), null);
      assert.deepEqual(p.calls[0].args, {
        action: 'execute_next',
        id: 'plan-1',
        review_id: 'review-7',
        idempotency_key: 'review-7',
        confirmed: true,
        spend_change_confirmed: true,
      });
    },
  );

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a run waiting for a person’s website approval links its approval page, and a deletion is acknowledged here',
    async () => {
      const p = campaignPage(locale),
        labels = p.run('runStopLabels');
      p.context.plan = {id: 'plan-1', steps: [{id: 'budget', status: 'review_ready'}]};
      // WRT-09: the run names the step's approval page. It is linked, and nothing continues the run before it.
      for (const stopped of ['needs_website_approval', 'needs_owner_approval']) {
        p.context.out = {
          run: {
            executed: [],
            stopped,
            reason: 'Step budget waits for a person: Ask a member to open website_path. Nothing was sent.',
            website_path: '/operations?approve=review-9',
            next_call: {tool: 'amcp_campaign', arguments: {action: 'run', id: 'plan-1'}},
          },
        };
        const html = p.run('runOutcomeView(out, plan)');
        assert.ok(visible(html).includes(t(locale, labels[stopped])), stopped);
        assert.match(html, /<a class="button primary" href="\/operations\?approve=review-9">/, stopped);
        assert.ok(html.includes(esc(t(locale, 'Open the approval page'))), stopped);
        assert.doesNotMatch(html, /id="outcome-continue"/, stopped);
        assert.doesNotMatch(visible(html), /website_path|\bneeds_[a-z_]+\b/, stopped);
        // A path that is not this site's own is never followed.
        for (const foreign of ['https://example.test/approve', '//example.test/approve', '/\\example.test']) {
          p.context.out.run.website_path = foreign;
          const other = p.run('runOutcomeView(out, plan)');
          assert.doesNotMatch(other, /<a /, foreign);
          assert.match(other, /id="outcome-review-step"/, foreign);
        }
      }
      // The owner's deletion acknowledgement: the returned review is shown here with the deletion consent unchecked,
      // and executing it sends exactly that review and key with the acknowledgement the person ticked.
      const plan = {id: 'plan-1', plan_hash: 'h', steps: [{id: 'remove', status: 'review_ready'}]},
        review = {
          review_id: 'review-8',
          idempotency_key: 'review-8',
          expires_at: new Date(Date.now() + 240000).toISOString(),
          request: {method: 'DELETE', path: '/v1/adgroups/1'},
          execute_requirements: {destructive_confirmed: true},
        };
      p.context.plan = plan;
      p.context.after = {outcome: {run: {executed: [], stopped: 'needs_destructive_confirmed'}, review}};
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      const html = p.node('#campaign-review').innerHTML;
      assert.ok(visible(html).includes(t(locale, labels.needs_destructive_confirmed)));
      assert.match(html, /id="destructive-consent" type="checkbox">/, 'the acknowledgement starts unchecked');
      assert.doesNotMatch(html, /checked/);
      // The authorizations not ticked are refused beside them (design review 2026-10: the error once repeated the
      // first box's label as a toast); nothing is sent.
      await assert.rejects(p.bindings.get('#execute-reviewed')(), {
        message: t(locale, 'Tick each authorization above to execute this request.'),
        presented: true,
      });
      assert.equal(p.calls.length, 0);
      assert.equal(p.node('#destructive-consent').getAttribute('aria-invalid'), 'true');
      p.node('#review-consent').checked = true;
      p.node('#destructive-consent').checked = true;
      p.respond(async () => ({run: {executed: ['remove'], stopped: 'complete'}}));
      await p.bindings.get('#execute-reviewed')();
      assert.deepEqual(p.calls[0].args, {
        action: 'execute_next',
        id: 'plan-1',
        review_id: 'review-8',
        idempotency_key: 'review-8',
        confirmed: true,
        destructive_confirmed: true,
      });
      // The refusals behind these stops are worded for the page, not for an MCP client.
      for (const [code, message] of [
        [
          'HUMAN_APPROVAL_REQUIRED',
          'The owner requires a person’s approval on the AMCP website before this change is executed. Nothing was sent. Ask a member to open website_path and approve this exact review, then execute it again.',
        ],
        [
          'CAP_OVERRIDE_OWNER_REQUIRED',
          'Only the workspace owner executes a change beyond a spending cap the owner set. Nothing was sent. The owner executes this review, or approves it on the AMCP website first (website_path); then execute it again with cap_override_confirmed=true.',
        ],
        [
          'DESTRUCTIVE_CONFIRMATION_REQUIRED',
          'The owner requires an explicit acknowledgement before anything is deleted on this account. Nothing was sent. Show the user what this review deletes, and execute again with destructive_confirmed=true once they approve.',
        ],
      ]) {
        p.context.error = refusal(p, code, message, {
          review_id: 'review-8',
          website_path: '/operations?approve=review-8',
        });
        const parts = p.run('errorParts(error)');
        assert.equal(p.run('agentDirected')(parts.message), false, code + ' message');
        assert.equal(p.run('agentDirected')(parts.remedy), false, code + ' remedy');
        assert.ok(parts.message.includes(t(locale, 'Nothing was sent.')), code);
        assert.ok(parts.remedy, code);
      }
    },
  );

for (const locale of ['en', 'ar'])
  test(locale + ': APPROVAL_REQUIRED and REVIEW_EXPIRED render website wording and their control', async () => {
    const p = campaignPage(locale),
      plan = {id: 'plan-1', plan_hash: 'h', steps: [{id: 'campaign', status: 'pending'}]};
    p.context.plan = plan;
    let opened = 0;
    p.context.open = async () => ++opened;
    p.run('bindCampaignWorkflow(plan, open, () => true)');
    // Run refused: the plan approval is missing (or expired after 24 hours).
    const approval = refusal(
      p,
      'APPROVAL_REQUIRED',
      'This plan has no current approval. Show the user the summary (approve), then approve it with confirmed: true.',
      {next_call: {tool: 'amcp_campaign', arguments: {action: 'approve', id: 'plan-1'}}},
    );
    p.respond(async (_tool, args) => {
      if (args.action === 'run') throw approval;
      return {approval: {plan_hash: 'h', summary_hash: 's', steps: []}};
    });
    await p.bindings.get('#run-campaign')();
    let html = p.node('#campaign-review').innerHTML;
    assert.match(html, /role="alert"/);
    assert.match(html, /id="outcome-approve"/);
    assert.ok(visible(html).includes(t(locale, 'This plan has no current approval.')));
    assert.ok(
      visible(html).includes(t(locale, p.run('websiteRemedies').find(([r]) => r.test('APPROVAL_REQUIRED'))[1])),
    );
    assert.ok(visible(html).includes(t(locale, 'Review plan approval')));
    assert.doesNotMatch(visible(html), agentTokens);
    assert.doesNotMatch(visible(html), /Show the user/);
    // The server's exact text stays available under Technical details.
    assert.match(html, /error-technical[\s\S]*confirmed: true/);
    await p.bindings.get('#outcome-approve')();
    assert.deepEqual(p.calls.at(-1).args, {action: 'approve', id: 'plan-1'}, 'the control opens the approval summary');
    // Execute refused: the step review expired after five minutes.
    const expired = refusal(p, 'REVIEW_EXPIRED', 'The review expired before execution.', {
      next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: 'plan-1'}},
    });
    p.respond(async (_tool, args) => {
      if (args.action === 'prepare_next')
        return {
          review: {
            review_id: 'review-2',
            idempotency_key: 'review-2',
            request: {},
            expires_at: new Date(Date.now() + 1e5).toISOString(),
          },
        };
      throw expired;
    });
    await p.bindings.get('#next-campaign')();
    p.node('#review-consent').checked = true;
    await p.bindings.get('#execute-reviewed')();
    html = p.node('#campaign-review').innerHTML;
    assert.match(html, /id="outcome-prepare-again"/);
    assert.ok(visible(html).includes(t(locale, 'Prepare again')));
    assert.ok(visible(html).includes(t(locale, p.run('websiteRemedies').find(([r]) => r.test('REVIEW_EXPIRED'))[1])));
    assert.doesNotMatch(visible(html), agentTokens);
    const before = p.calls.length;
    await p.bindings.get('#outcome-prepare-again')();
    assert.equal(p.calls[before].args.action, 'prepare_next', 'Prepare again reads the state again for a new review');
    assert.equal(opened, 0);
  });

test('a failed plan step and a failed upload say what to do in website words, the exact error kept in details', () => {
  for (const locale of ['en', 'ar']) {
    const p = campaignPage(locale);
    const error = {
      code: 'BRIEF_REQUIRED',
      message: 'A brief is required.',
      category: 'request',
      next_action: 'Supply what the message names, then send the call again (a write is prepared again).',
    };
    p.context.plan = {
      id: 'plan-1',
      name: 'Plan',
      brief: 'Brief',
      state: 'attention',
      steps: [{id: 'campaign', status: 'failed', error}],
    };
    let html = p.run('campaignJournal(plan)');
    const own = t(locale, 'Check the values you entered or selected, correct what the message names, then try again.');
    assert.ok(visible(html).includes(own));
    assert.doesNotMatch(visible(html), /send the call again/);
    assert.match(html, /workspace-details[\s\S]*send the call again/, 'the exact error stays under its details');
    // An upload that failed after a claim names its recovery; one that never reached the platform keeps its own copy.
    p.context.job = {
      state: 'failed',
      error: {
        ...error,
        code: 'MEDIA_UPLOAD_LEASE_LOST',
        category: 'state',
        next_action: 'Inspect amcp_media recovery for the original review.',
      },
    };
    html = p.run("mediaJobPanel(job, 'review-1')");
    assert.ok(
      visible(html).includes(t(locale, p.run('websiteRemedies').find(([r]) => r.test('MEDIA_UPLOAD_LEASE_LOST'))[1])),
    );
    assert.doesNotMatch(visible(html), /amcp_media/);
    p.context.job = {
      state: 'failed',
      not_submitted: true,
      error: {...error, code: 'MEDIA_UPLOAD_BUSY', next_action: 'Use amcp_media recovery.'},
    };
    html = p.run("mediaJobPanel(job, 'review-1')");
    assert.ok(
      !visible(html).includes(t(locale, p.run('websiteRemedies').find(([r]) => r.test('MEDIA_UPLOAD_BUSY'))[1])),
    );
  }
});

test('a remedy written for an MCP client is replaced; a remedy written for people is kept, translated', () => {
  for (const locale of ['en', 'ar']) {
    const p = page(locale);
    // The generic _REQUIRED remedy says "send the call again (a write is prepared again)".
    const required = refusal(p, 'BRIEF_REQUIRED', 'A brief is required.');
    assert.match(required.next_action, /send the call again/);
    p.context.error = required;
    let text = p.run('errorMessage(error)');
    assert.doesNotMatch(text, /send the call again|a write is prepared again/);
    assert.ok(
      text.includes(
        t(locale, 'Check the values you entered or selected, correct what the message names, then try again.'),
      ),
    );
    assert.ok(text.includes('synthetic-reference-0001'));
    // A remedy that starts with "Nothing was submitted" keeps that fact.
    p.context.error = refusal(p, 'IDEMPOTENCY_REQUIRED', 'idempotency_key is required.');
    p.context.error.next_action =
      'Nothing was submitted. Call execute again with idempotency_key equal to the review_id.';
    text = p.run('errorMessage(error)');
    assert.ok(text.startsWith(t(locale, 'idempotency_key is required.') ?? 'idempotency_key is required.'));
    assert.ok(text.includes(t(locale, 'Nothing was sent.')));
    assert.doesNotMatch(text, /idempotency_key equal/);
    // A remedy for people is shown as written.
    p.context.error = refusal(p, 'OWNER_REQUIRED', 'Only the workspace owner can do this.');
    text = p.run('errorMessage(error)');
    assert.ok(
      text.includes(
        t(
          locale,
          'Ask the workspace owner to do this, or to give you what you need from it. Changing the request does not help.',
        ),
      ),
    );
    // A superseded request stays silent.
    assert.equal(p.run('errorMessage(supersededRequest())'), '');
  }
});

for (const locale of ['en', 'ar'])
  test(locale + ': a GTM 403 shows separate lines with the provider status and request ID, never its body', () => {
    const p = page(locale);
    p.context.response = {
      success: false,
      error: {
        code: 'PROVIDER_ACCESS_DENIED',
        message: 'Platform returned HTTP 403',
        details: {
          http_status: 403,
          request_id: 'gtm-request-42',
          provider_code: 'PERMISSION_DENIED',
          upstream: {error: {message: 'Body text with token ya29.secret <img>'}},
        },
        category: 'provider',
        next_action:
          'The provider denied access. Check its error details and request ID; a 403 alone does not identify a missing OAuth scope.',
      },
      meta: {requestId: 'amcp-reference-7'},
    };
    p.run('error = requestError(response)');
    const lines = p.run('errorLines(error)').split('\n');
    assert.equal(lines.length, 4, lines.join(' | '));
    assert.equal(lines[0], 'Platform returned HTTP 403');
    assert.equal(lines[1], t(locale, p.context.response.error.next_action));
    assert.ok(
      lines[2].includes('403') && lines[2].includes('gtm-request-42') && lines[2].includes('PERMISSION_DENIED'),
    );
    assert.ok(lines[3].includes('amcp-reference-7'));
    const all = p.run('errorMessage(error) + errorBlock(error)');
    assert.doesNotMatch(all, /ya29|Body text|below/);
    // Technical details carry the server's code, message and remedy, never details or a provider body.
    assert.deepEqual(Object.keys(p.run('errorTechnical(error)')).sort(), ['code', 'message', 'next_action']);
    // Unsafe provider references are dropped, not shown; a non-provider error shows no provider facts.
    p.context.error.details = {http_status: 403, request_id: 'id with spaces <img>', provider_code: '<b>'};
    assert.equal(
      p.run('errorParts(error).provider'),
      t(locale, 'Provider response: HTTP {status}.').replace('{status}', '403'),
    );
    p.context.error.details = {request_id: 'local-id'};
    assert.equal(p.run('errorParts(error).provider'), '');
    // An HTTP status that is not the provider's answer (a media link, a Drive file, AMCP's own) is not shown as one.
    for (const [code, message] of [
      ['MEDIA_LINK_UNAVAILABLE', 'The link did not return the file (HTTP 404). Use a link anyone can open.'],
      ['DRIVE_FILE_UNAVAILABLE', 'Make this Drive file downloadable by anyone with the link, then prepare again.'],
    ]) {
      p.context.other = refusal(p, code, message, {http_status: 404});
      assert.equal(p.run('errorParts(other).provider'), '', code);
      assert.ok(
        !p.run('errorLines(other)').includes(t(locale, 'Provider response: HTTP {status}.').split('{status}')[0]),
        code,
      );
    }
    // A provider layer names who must act.
    p.context.error.details = {http_status: 401, layer: 'credential'};
    assert.equal(p.run('errorParts(error).remedy'), t(locale, p.run('providerLayerRemedies').credential));
  });

for (const locale of ['en', 'ar'])
  test(
    locale + ': the measurement reads keep the provider facts the page may show (regression: the GTM 403 had none)',
    async () => {
      // The GTM audit and the LinkedIn conversion read re-raise a provider refusal in their own words. Before, they kept
      // only its message and code, so the website could not name the provider's status or request ID (owner decision
      // D21) although the synthetic provider returned both. Allow-listed facts only: never the provider's body.
      const {workspaceFormRefusalFixture} = await import('./fixtures/workspace-form-refusal-data.mjs');
      for (const [kind, keys] of [
        ['gtm', ['http_status', 'layer', 'provider_code', 'request_id']],
        ['conversions', ['http_status', 'layer', 'request_id']],
      ]) {
        const f = workspaceFormRefusalFixture(kind);
        try {
          const response = await f.service.call('amcp_workspace', f.input, f.actor);
          assert.equal(response.error.code, 'PROVIDER_ACCESS_DENIED', kind);
          assert.deepEqual(Object.keys(response.error.details).sort(), keys, kind);
          assert.equal(response.error.details.http_status, 403, kind);
          assert.equal(response.error.details.request_id, 'synthetic-workspace-form-native-reference', kind);
          assert.doesNotMatch(JSON.stringify(response), /Synthetic selected account denial|upstream/, kind);
          const p = page(locale);
          p.context.response = response;
          p.run('error = requestError(response)');
          const lines = p.run('errorLines(error)').split('\n');
          assert.equal(lines[0], 'Platform returned HTTP 403', kind);
          assert.ok(
            lines.includes(
              t(locale, 'Provider response: HTTP {status}.').replace('{status}', '403') +
                ' ' +
                t(locale, 'Provider request ID: {id}.').replace('{id}', 'synthetic-workspace-form-native-reference'),
            ),
            kind + ': ' + lines.join(' | '),
          );
        } finally {
          f.close();
        }
      }
    },
  );

for (const locale of ['en', 'ar'])
  test(locale + ': the shared form alert puts each part on its own line and promises nothing "below"', async () => {
    const {workspaceFormUIFixture} = await import('./fixtures/workspace-form-ui.mjs');
    const f = workspaceFormUIFixture(locale),
      error = f.error();
    error.details = {http_status: 403, request_id: 'gtm-request-42'};
    f.bind(async () => {
      throw error;
    });
    await f.submit();
    const text = f.message().textContent;
    assert.equal(text.split('\n').length, 4, text);
    assert.ok(text.includes('gtm-request-42'));
    const markup = f.insertions.map(i => i.html).join('');
    assert.doesNotMatch(markup, /below/);
    assert.ok(markup.includes(esc(t(locale, 'Check these details and your selections, then try again.'))));
    const technical = [...f.nodes].find(el => el.id.endsWith('-technical-text'));
    assert.equal(JSON.parse(technical.textContent).code, 'PROVIDER_ACCESS_DENIED');
  });

test('a JSON mistake names its field in the interface language, and a wrong shape is refused', () => {
  for (const locale of ['en', 'ar']) {
    const p = page(locale);
    const field = t(locale, 'Template variables');
    p.context.field = field;
    assert.throws(
      () => p.run('parseJsonField(field, \'{"a": 1,}\')'),
      error => {
        assert.ok(error.message.startsWith(field));
        assert.doesNotMatch(error.message, /Unexpected|position|JSON\.parse/);
        return true;
      },
    );
    assert.throws(() => p.run("parseJsonField(field, '[1]')"), new RegExp(field));
    assert.throws(() => p.run("parseJsonField(field, '{}', 'array')"), new RegExp(field));
    assert.deepEqual(JSON.parse(JSON.stringify(p.run('parseJsonField(field, \'{"a": 1}\')'))), {a: 1});
    assert.deepEqual(JSON.parse(JSON.stringify(p.run("parseJsonField(field, '[1]', 'array')"))), [1]);
  }
});

test('an owner settings refusal keeps its remedy and request reference', async () => {
  const p = page('en');
  const source = readFileSync('web/owner-operations.js', 'utf8');
  // WEB-07: the owner's part of Settings is registered (AMCP.routes.extend), no longer a reassigned renderSettings.
  p.run(source.slice(source.indexOf('const ownerCall ='), source.indexOf('async function renderOwnerSettings()')));
  p.context.api = async () => ({
    success: false,
    error: {
      code: 'OWNER_REQUIRED',
      message: 'Only the workspace owner can do this.',
      next_action: 'Ask the workspace owner.',
    },
    meta: {requestId: 'owner-reference-9'},
  });
  const error = await p.run("ownerCall({action: 'health'}).catch(e => e)");
  assert.equal(error.code, 'OWNER_REQUIRED');
  p.context.error = error;
  assert.equal(
    p.run('errorMessage(error)'),
    'Only the workspace owner can do this. Ask the workspace owner. Reference: owner-reference-9',
  );
  assert.match(source, /\$\('#owner-error'\)\.textContent = errorMessage\(e\)/);
});

for (const locale of ['en', 'ar'])
  test(
    locale + ': a Pull with no account is refused at the run bar, focused and in view, before any request',
    async () => {
      const p = page(locale);
      for (const file of [
        'report-library',
        'report-source-settings',
        'report-quality',
        'report-workflows',
        'report-delivery',
        'reporting-overview',
      ])
        p.run(readFileSync('web/' + file + '.js', 'utf8'));
      p.context.authBind = (selector, fn) => p.bindings.set(selector, fn);
      p.context.overviewCall = args => p.call('overview', args);
      p.context.pull = async () => {
        const blocked = p.context.reportRunPreflight();
        if (blocked) throw new Error(blocked);
        await p.context.overviewCall({action: 'run'});
      };
      p.run("reportRunBind('#overview-config', pull)");
      const alert = p.node('#report-run-error');
      alert.hidden = true;
      await p.bindings.get('#overview-config')();
      assert.equal(alert.hidden, false);
      assert.equal(p.context.document.activeElement, alert, 'focus moves to the refusal');
      assert.equal(alert.scrolled, 1, 'the refusal is scrolled into view');
      assert.equal(alert.textContent, t(locale, 'Choose at least one account above, then pull the report.'));
      assert.equal(p.calls.length, 0, 'nothing is sent');
      // A server refusal is shown in the same place, with website wording.
      p.lists.set('[data-report-account]:checked', [{value: '["google","login","1"]'}]);
      p.respond(async () => {
        throw refusal(p, 'DATE_RANGE_REQUIRED', 'A date range is required.');
      });
      await p.bindings.get('#overview-config')();
      assert.ok(alert.textContent.includes('synthetic-reference-0001'));
      assert.doesNotMatch(alert.textContent, /send the call again/);
      // A custom range that ends before it starts is refused locally too.
      p.node('#report-range-mode').value = 'custom';
      p.node('[name="since"]').value = '2026-09-10';
      p.node('[name="until"]').value = '2026-09-01';
      assert.equal(
        p.run('reportRunPreflight()'),
        t(locale, 'The start date is after the end date. Correct the dates, then pull the report.'),
      );
      // The page registers Pull through the run-bar handler with this preflight.
      const source = readFileSync('web/reporting-overview.js', 'utf8');
      assert.match(source, /reportRunBind\('#overview-config', async \(\) => \{[\s\S]{0,300}reportRunPreflight\(\)/);
      assert.match(
        source,
        /<p id="report-run-error" class="error report-run-error" role="alert" tabindex="-1" hidden><\/p><div class="report-runbar">/,
      );
    },
  );

for (const locale of ['en', 'ar'])
  test(locale + ': an approval older than 24 hours offers the review again instead of a Run that fails', async () => {
    const p = campaignPage(locale);
    p.context.mountRecipeBuilder = async () => {};
    p.context.mountCampaignClone = () => {};
    p.context.header = () => '';
    p.context.routeLabel = () => 'Campaigns';
    p.context.location.search = '?id=plan-1';
    const plan = at => ({
      id: 'plan-1',
      name: 'Plan',
      brief: 'Brief',
      state: 'draft',
      revision: 1,
      plan_hash: 'hash-1',
      updated_at: Date.now(),
      approval: {plan_hash: 'hash-1', by: 'person-a', at},
      steps: [{id: 'campaign', kind: 'write', status: 'pending', arguments: {}}],
    });
    for (const [at, expired] of [
      [Date.now() - 25 * 3600000, true],
      [Date.now() - 3600000, false],
    ]) {
      p.respond(async (_tool, args) =>
        args.action === 'list' ? {campaigns: [], total: 0} : args.action === 'profiles' ? {profiles: []} : plan(at),
      );
      await p.run('renderCampaigns()');
      const html = p.node('#campaign-detail').innerHTML;
      assert.equal(html.includes('id="run-campaign"'), !expired);
      assert.equal(html.includes(esc(t(locale, 'Review whole plan again'))), expired);
      assert.equal(
        html.includes(
          esc(
            t(locale, 'The plan approval expired 24 hours after it was given. Review the whole plan again to run it.'),
          ),
        ),
        expired,
      );
    }
    // The 24 hours are counted on the server's clock, learned from a response's Date header: a device clock three
    // hours ahead no longer hides Run for a 22-hour-old approval, and one three hours behind no longer offers Run for a
    // 25-hour-old one (regression: the device clock decided).
    for (const [skew, age, expired] of [
      [3 * 3600000, 22 * 3600000, false],
      [-3 * 3600000, 25 * 3600000, true],
    ]) {
      const server = Date.now() - skew;
      p.run('noteServerClock')({headers: {get: name => (name === 'date' ? new Date(server).toUTCString() : null)}});
      const approved = plan(server - age);
      assert.equal(p.run('campaignApprovalCurrent')(approved), !expired, String(skew));
      assert.equal(p.run('campaignApprovalExpired')(approved), expired, String(skew));
    }
    // A response without a Date header leaves the last offset; none at all means the device clock, as before.
    p.run('noteServerClock')({headers: {get: () => null}});
    assert.equal(p.run('campaignApprovalExpired')(plan(Date.now() + 3 * 3600000 - 25 * 3600000)), true);
  });

// Design review 2026-10 (WEB-03): after an executed step that failed or whose answer was lost, the outcome said
// "Saved." (role=status), the word used for a plan saved without any execution.
for (const locale of ['en', 'ar'])
  test(locale + ': an executed step that did not complete is never announced as saved', () => {
    const p = campaignPage(locale),
      plan = {id: 'plan-1', steps: [{id: 'campaign', review_id: 'review-1', status: 'uncertain'}]};
    p.context.plan = plan;
    const outcomes = {
      uncertain:
        'The provider’s answer to this step was lost, so AMCP cannot confirm the change. It is never sent again: use Read back submitted step to check the account.',
      failed: 'This step did not complete. What happened and what to do are shown with the step.',
    };
    for (const [status, wording] of Object.entries(outcomes)) {
      // execute_next's compact answer: the plan in attention, the step it acted on, and no next call.
      p.context.out = {
        view: 'compact',
        id: 'plan-1',
        state: 'attention',
        steps: [{id: 'campaign', status, error: status === 'uncertain' ? 'WRITE_OUTCOME_UNCERTAIN' : 'STATE_CHANGED'}],
        current: {step_id: 'campaign', status},
      };
      const text = visible(p.run('runOutcomeView(out, plan)'));
      assert.ok(text.includes(t(locale, wording)), status);
      assert.ok(!text.includes(t(locale, 'Saved.')), status + ' is not "Saved."');
      assert.ok(Object.hasOwn(catalog, wording), 'Arabic for ' + status);
    }
    // A plan saved without an execution still says so.
    p.context.out = {view: 'compact', id: 'plan-1', state: 'draft'};
    assert.ok(visible(p.run('runOutcomeView(out, plan)')).includes(t(locale, 'Saved.')));
    // The plan's emphasized action is the safe way on: a read-back for an uncertain step, a correction for a failed one.
    assert.equal(p.run('campaignNextSafeAction')(plan), 'reconcile');
    assert.equal(p.run('campaignNextSafeAction')({steps: [{id: 'campaign', status: 'failed'}]}), 'amend');
    assert.equal(p.run('campaignNextSafeAction')({steps: [{id: 'campaign', status: 'verified'}]}), '');
  });

// R25 M1 (L5-04): a plan step whose review was refused for a changed provider state goes back to pending, unsent. The
// answer of execute_next is a saved plan with a pending step, which the page used to announce as "Saved.".
for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a step sent back to pending for a changed provider state is not announced as saved, and offers its review again',
    () => {
      const p = campaignPage(locale),
        plan = {id: 'plan-1', steps: [{id: 'campaign', review_id: 'review-1', status: 'pending'}]};
      p.context.plan = plan;
      const answer = error => ({
        view: 'compact',
        id: 'plan-1',
        state: 'attention',
        steps: [{id: 'campaign', status: 'pending', error}],
        current: {step_id: 'campaign', status: 'pending', error: {code: error}},
        next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: 'plan-1'}},
      });
      p.context.out = answer('STATE_CHANGED');
      const html = p.run('runOutcomeView(out, plan)'),
        text = visible(html),
        wording = p.run('runStopLabels').state_changed;
      assert.ok(text.includes(t(locale, wording)), 'says the provider changed and nothing was sent');
      assert.ok(!text.includes(t(locale, 'Saved.')), 'not "Saved."');
      assert.doesNotMatch(text, agentTokens);
      assert.deepEqual(
        [...html.matchAll(/id="(outcome-[a-z-]+)"/g)].map(m => m[1]),
        ['outcome-review-step'],
        'one control: the step is reviewed again, never continued',
      );
      // Another pending step, an expired review prepared again, is as it was: saved, for the next review.
      p.context.out = answer('REVIEW_EXPIRED');
      const other = visible(p.run('runOutcomeView(out, plan)'));
      assert.ok(other.includes(t(locale, 'Saved. Review the next step when you are ready.')));
      assert.ok(!other.includes(t(locale, wording)));
      // The plan's one emphasized action is that review: the step is not broken, so the correction is not the emphasized
      // one (it is offered as a second control, below), and Run does not lead (a non-empty lead takes the emphasis off Run).
      const refused = {steps: [{id: 'campaign', status: 'pending', error: {code: 'STATE_CHANGED'}}]};
      assert.equal(p.run('campaignNextSafeAction')(refused), 'review');
      assert.equal(p.run('campaignNeedsAmendment')(refused), true, 'an unsent step can be corrected in place');
      assert.equal(
        p.run('campaignNextSafeAction')({
          steps: [{id: 'campaign', status: 'pending', error: {code: 'REVIEW_EXPIRED'}}],
        }),
        '',
      );
      assert.equal(p.run('campaignNextSafeAction')({steps: [{id: 'campaign', status: 'pending'}]}), '');
      // The plan's row of buttons follows: "Review next step" is the emphasized one only for a refused review.
      for (const [steps, classes] of [
        [refused.steps, ['primary']],
        [[{id: 'campaign', status: 'pending'}], []],
      ]) {
        const next = p.node('#next-campaign');
        next.classList = {
          names: [],
          add(name) {
            this.names.push(name);
          },
        };
        p.context.plan = {id: 'plan-1', steps};
        p.run('bindCampaignWorkflow(plan, async () => true, () => true)');
        assert.deepEqual(next.classList.names, classes, JSON.stringify(steps));
      }
    },
  );

// R25 M1 (r25-m1-diff, lead review S3-2): a step the state check sent back to pending never reached the provider, so the page
// offers its correction too, as a second control beside the review of the step and never the emphasized one. The correction
// is the form of recover_step, which the server now accepts for such a step; opening it prepares nothing.
for (const locale of ['en', 'ar'])
  test(
    locale + ': a step refused for a changed provider state is corrected from the plan page and from its outcome',
    async () => {
      const p = campaignPage(locale),
        step = {
          id: 'campaign',
          status: 'pending',
          review_id: 'review-1',
          arguments: {action: 'tiktok_campaign_create', payload: {campaign_name: 'Original', budget: 50}},
          error: {code: 'STATE_CHANGED', details: {changed_fields: ['$[0]["x"]']}},
        },
        plan = {id: 'plan-1', revision: 4, steps: [step]},
        failed = {id: 'b', status: 'failed'};
      p.context.plan = plan;
      // The plan page offers the correction, and the emphasis stays on the review; a failed step still leads with the correction.
      assert.equal(p.run('campaignNeedsAmendment')(plan), true);
      assert.equal(p.run('campaignNextSafeAction')(plan), 'review');
      assert.equal(p.run('campaignNextSafeAction')({steps: [step, failed]}), 'amend');
      assert.equal(p.run('campaignNeedsAmendment')({steps: [{...step, error: {code: 'REVIEW_EXPIRED'}}]}), false);
      // The outcome of the refused execute: the review first and emphasized, the correction beside it.
      p.context.out = {
        view: 'compact',
        id: 'plan-1',
        state: 'attention',
        steps: [{id: 'campaign', status: 'pending', error: 'STATE_CHANGED'}],
        current: {step_id: 'campaign', status: 'pending', error: {code: 'STATE_CHANGED'}},
        next_call: {tool: 'amcp_campaign', arguments: {action: 'prepare_next', id: 'plan-1'}},
      };
      const html = p.run('runOutcomeView(out, plan)');
      assert.deepEqual(
        [...html.matchAll(/id="(outcome-[a-z-]+)"/g)].map(m => m[1]),
        ['outcome-review-step', 'outcome-correct-step'],
      );
      assert.match(html, /id="outcome-review-step" type="button" class="button primary"/);
      assert.match(html, /id="outcome-correct-step" type="button" class="button"/);
      assert.ok(visible(html).includes(t(locale, 'Correct blocked step')));
      // Both controls open the form of recover_step for this step without a call: nothing is prepared or sent by opening it.
      p.context.after = {outcome: p.context.out};
      p.node('#next-campaign').classList = {add() {}};
      p.run('bindCampaignWorkflow(plan, async () => true, () => true, after)');
      for (const control of ['#outcome-correct-step', '#amend-campaign']) {
        p.node('#campaign-review').innerHTML = '';
        await p.bindings.get(control)();
        assert.equal(p.calls.length, 0, control + ' prepares nothing');
        const form = p.node('#campaign-review').innerHTML;
        assert.match(form, /id="amend-step"/, control);
        assert.match(form, /\/payload\/campaign_name/, control);
        assert.match(form, /campaign<\/h2>/, control + ' names the step');
      }
      // The form sends recover_step for this step, with the person's confirmation and the plan's revision.
      p.node('#amend-step').elements.confirmed.checked = true;
      // The fields of the step's arguments, in their order: /action, /payload/campaign_name, /payload/budget.
      p.node('#amend-step').elements.field.value = '1';
      p.node('#amend-step').elements.value.value = 'Corrected name';
      p.respond(async () => ({}));
      await p.bindings.get('#amend-step')();
      assert.deepEqual(
        p.calls.map(c => c.args),
        [
          {
            action: 'recover_step',
            id: 'plan-1',
            step_id: 'campaign',
            expected_revision: 4,
            confirmed: true,
            patch: [{path: '/payload/campaign_name', value: 'Corrected name'}],
          },
        ],
      );
    },
  );

// Design review 2026-10 (WEB-03): an uncertain write told people not to "retry with a new key" and to avoid "a new
// idempotency key"; the page now says what happened and the one safe thing to do, in its own words.
test('a lost write answer is explained without keys, and its exact server text stays under Technical details', () => {
  for (const locale of ['en', 'ar']) {
    const p = campaignPage(locale),
      uncertain = refusal(
        p,
        'WRITE_OUTCOME_UNCERTAIN',
        'The write response was lost. Do not retry with a new key; inspect platform state.',
      );
    p.context.error = uncertain;
    const lines = p.run('errorLines(error)');
    // The server's remedy also says not to create the resource again ("Do not create another resource or use a new
    // idempotency key"); the page's words keep that as a prohibition: the change is not repeated unless a read-back (or
    // the account) shows it was not applied (review fix: "before you repeat the change yourself" read as an invitation).
    const remedy =
      'AMCP never sends it again. Do not repeat the change unless a read-back or the account itself shows it was not applied; a read-back changes nothing.';
    for (const owned of [
      'The provider’s answer to this change was lost, so AMCP cannot confirm whether it was applied.',
      remedy,
    ]) {
      assert.ok(Object.hasOwn(catalog, owned), 'Arabic for ' + owned);
      assert.ok(lines.includes(t(locale, owned)), owned);
    }
    assert.doesNotMatch(lines, /idempotency|new key|repeat the change yourself/i);
    assert.match(p.run('errorBlock(error)'), /error-technical[\s\S]*Do not retry with a new key/);
    // Review fix: another uncertain outcome is not called a lost answer, and an upload's remedy is its recovery in
    // Operations (uploads have no read-back); each server text stays under Technical details.
    for (const [message, upload] of [
      ['This review was already submitted. Inspect provider state; do not retry with a new key.', false],
      ['A library attachment was already submitted. Inspect the account library.', true],
      ['The retained Google session could not be queried.', true],
      ['Upload response was lost. Inspect the allocated media before retrying.', true],
    ]) {
      p.context.error = refusal(p, 'WRITE_OUTCOME_UNCERTAIN', message);
      const shown = p.run('errorLines(error)'),
        lost = /response was lost/.test(message);
      assert.equal(
        shown.includes(
          t(locale, 'The provider’s answer to this change was lost, so AMCP cannot confirm whether it was applied.'),
        ),
        lost,
        message,
      );
      if (!lost) assert.ok(shown.includes(t(locale, 'AMCP cannot confirm whether this change was applied.')), message);
      const own = upload
        ? 'AMCP never repeats an upload or step whose outcome is not confirmed. Check its recovery in Operations before you do anything else.'
        : remedy;
      assert.ok(Object.hasOwn(catalog, own) && shown.includes(t(locale, own)), message);
      assert.doesNotMatch(shown, /idempotency|new key/i, message);
      if (upload) assert.ok(!shown.includes(t(locale, remedy)), 'an upload is not offered a read-back: ' + message);
      assert.ok(p.run('errorBlock(error)').includes(message), message);
    }
    p.context.error = uncertain;
    // The plan step shows the same words; the stored error stays under its details. A step keeps the server's error
    // envelope (src/campaign-runner.ts), message included (an Error's own message does not spread).
    p.context.plan = {
      id: 'plan-1',
      name: 'Plan',
      brief: 'Brief',
      state: 'attention',
      steps: [
        {
          id: 'campaign',
          status: 'uncertain',
          review_id: 'review-1',
          error: {...uncertain, message: uncertain.message},
        },
      ],
    };
    const html = p.run('campaignJournal(plan)');
    assert.ok(
      visible(html).includes(
        t(locale, 'The provider’s answer to this change was lost, so AMCP cannot confirm whether it was applied.'),
      ),
    );
    assert.doesNotMatch(visible(html), /idempotency|new key/i);
    assert.match(html, /workspace-details[\s\S]*new key/, 'the exact error stays under its details');
  }
});

// Design review 2026-10 (WEB-03): a review of an account without a spending policy showed the server's advice for
// MCP clients ("… with amcp_workspace save_spend_policy") in a table of /configured false and /unprotected true, in
// English on the Arabic page.
test('a review of an unprotected account says so in the page’s words and links the owner to the policy', () => {
  for (const locale of ['en', 'ar']) {
    const p = campaignPage(locale),
      advice =
        'No spending policy protects this account. An owner can set one for this account, or a workspace default that covers every account, with amcp_workspace save_spend_policy.',
      notice =
        'No spending policy protects this account. The workspace owner can set one for this account, or a default for every account, in Workspace settings.';
    p.context.review = {
      review_id: 'review-3',
      expires_at: new Date(Date.now() + 1e5).toISOString(),
      request: {method: 'POST', path: '/act_1/campaigns', body: {status: 'PAUSED'}},
      spend_policy: {configured: false, unprotected: true, advice},
    };
    let html = p.run("readableReview(review, 'Execute')");
    assert.ok(visible(html).includes(t(locale, notice)));
    assert.ok(Object.hasOwn(catalog, notice));
    assert.doesNotMatch(visible(html), /amcp_workspace|save_spend_policy|\/unprotected/);
    assert.match(html, /href="\/settings#owner-spend-policy"/, 'the owner opens the policy form from the review');
    // A non-owner is told who sets it, without a link to a form they cannot use.
    p.context.session.workspaceRole = 'operator';
    html = p.run("readableReview(review, 'Execute')");
    assert.doesNotMatch(html, /href="\/settings#owner-spend-policy"/);
    // A configured policy keeps its exact table.
    p.context.review.spend_policy = {configured: true, policy_id: 'p', enforcement: 'block', units: 'native'};
    html = p.run("readableReview(review, 'Execute')");
    assert.match(visible(html), /\/enforcement/);
    // AMCP's own request warning is translated like the rest of the page (it stayed English in Arabic).
    p.context.review.request = {
      method: 'POST',
      warnings: ['Request routing compiled locally; live behavioral parity is tracked separately.'],
    };
    html = p.run("readableReview(review, 'Execute')");
    assert.ok(
      visible(html).includes(
        t(locale, 'Request routing compiled locally; live behavioral parity is tracked separately.'),
      ),
    );
  }
});

// r12-gpreview item 3 (found live 2026-11-16): a write whose provider answer did not match what AMCP reviewed told the person
// to check access, scopes and tier. It now says the answer was not accepted and what to do, in the page's language, in words that
// address a person and not an MCP client, so the page shows them as the server wrote them (WEB-03).
test('a write whose provider answer did not match what was reviewed is worded for people, in both languages', () => {
  const message =
      'The provider answered, but its answer does not match what AMCP reviewed for this request, so AMCP did not accept it.',
    details = {
      native_response_valid: false,
      response_hash: 'a'.repeat(64),
      response_mismatch: {check: 'link', reason: 'host_not_accepted', entry: 0, field: 'shareablePreviewUrl'},
    },
    oldRemedy =
      'Inspect the native error and request ID. Check account access, granted scopes, app access tier and payload against the named endpoint; HTTP status alone does not identify the cause.',
    server = errorResult(
      new MirrorError('WRITE_PARTIAL_OR_FAILED', message, details),
      'synthetic-reference-0001',
      0,
    ).error;
  for (const locale of ['en', 'ar']) {
    const p = page(locale);
    p.context.error = refusal(p, 'WRITE_PARTIAL_OR_FAILED', message, details);
    const parts = p.run('errorParts(error)');
    // Each is shown as the server wrote it, in the page's language: neither replaced by the page's wording for a category
    // of refusal, nor left in English on the Arabic page.
    assert.equal(parts.message, t(locale, message), locale);
    assert.equal(parts.remedy, t(locale, server.next_action), locale);
    assert.notEqual(server.next_action, oldRemedy);
    assert.ok(!parts.remedy.includes(t(locale, oldRemedy)), locale);
    if (locale === 'ar') {
      assert.match(parts.message, /[؀-ۿ]/);
      assert.match(parts.remedy, /[؀-ۿ]/);
      assert.notEqual(parts.remedy, server.next_action);
    }
    for (const text of [parts.message, parts.remedy, server.next_action])
      assert.equal(p.run('agentDirected')(text), false, 'Addresses an MCP client: ' + text);
  }
});
