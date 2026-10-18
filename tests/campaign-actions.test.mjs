import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {CampaignRunner, campaignTool} from '../dist/src/campaign-runner.js';
import {campaignRecipe} from '../dist/src/campaign-recipes.js';

// ARC-04 stage D: CampaignRunner.handle (1,311 lines) dispatched amcp_campaign's actions through an if-chain. They are
// now entries of seven action tables (src/tool-actions.ts), consulted in the order of the checks the chain ran between
// them, and each long action is a method whose body is the chain's block unchanged. These tests hold what that order
// decided: which actions answer before the recipe-argument checks and the write check, which plan actions still run
// on an archived, superseded or cancelled plan, and where an action in no table is refused. The campaign suites run
// every action end to end.
const examples = JSON.parse(readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'));
function fixture() {
  const tenantId = 'campaign-actions-' + randomUUID(),
    store = new Store(':memory:', Buffer.alloc(32, 47).toString('base64')),
    operator = {tenantId, userId: 'alice', role: 'operator'},
    reader = {tenantId, userId: 'vera', role: 'reader'},
    admin = {tenantId, userId: 'owner-admin', role: 'admin'};
  store.putConnection(
    admin,
    {
      id: 'snap',
      tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const calls = [];
  const runner = new CampaignRunner(
    store,
    async (name, input) => {
      calls.push(name + ' ' + input.action);
      throw Error('No tool call is expected');
    },
    async () => {
      calls.push('verify');
      throw Error('No verification is expected');
    },
    async () => ({}),
    async () => ({status: 'ready', checks: []}),
  );
  const as = actor => input => runner.handle(input, actor);
  const plan = async () =>
    (
      await as(operator)({
        action: 'create',
        name: 'Snapchat launch',
        brief: 'Synthetic.',
        steps: campaignRecipe('snapchat_website_traffic', {
          ...examples.snapchat_traffic_business,
          connection_id: 'snap',
        }).steps,
      })
    ).id;
  return {store, runner, calls, operator: as(operator), reader: as(reader), plan};
}
const refused =
  (message, code = 'INVALID_ARGUMENT') =>
  e =>
    e.code === code && e.message === message;

test('every amcp_campaign action has one place, in the stage whose checks the if-chain ran before it', () => {
  const f = fixture();
  try {
    const stages = {
      recipe: f.runner.recipeActions,
      read: f.runner.readActions,
      creation: f.runner.creationActions,
      collaboration: f.runner.collaborationActions,
      recovery: f.runner.recoveryActions,
      approval: f.runner.approvalActions,
      step: f.runner.stepActions,
    };
    const placed = [
      ...Object.entries(stages).flatMap(([stage, table]) => Object.keys(table).map(action => [action, stage])),
      // Dispatched by handle itself between the plan-state checks: continue_as_new after the archive check, cancel
      // after the superseded check; preflight is the shared preflight check, which approve, run and prepare_next run too.
      ['continue_as_new', 'handle'],
      ['cancel', 'handle'],
      ['preflight', 'handle'],
    ];
    assert.deepEqual(
      placed.map(([action]) => action).sort(),
      [...campaignTool.inputSchema.properties.action.enum].sort(),
    );
    assert.equal(new Set(placed.map(([action]) => action)).size, placed.length);
    assert.deepEqual(Object.fromEntries(placed), {
      recipes: 'recipe',
      recipe_lookup: 'recipe',
      recipe_context: 'recipe',
      recipe_eligibility: 'read',
      preview_recipe: 'read',
      create_from_recipe: 'read',
      verify: 'read',
      validate_provider: 'read',
      list: 'read',
      get: 'read',
      clone: 'creation',
      create: 'creation',
      archive: 'collaboration',
      unarchive: 'collaboration',
      assign: 'collaboration',
      unassign: 'collaboration',
      confirm_absent: 'recovery',
      activation_plan: 'recovery',
      reconcile_step: 'recovery',
      recover_step: 'recovery',
      approve: 'approval',
      run: 'approval',
      run_background: 'approval',
      prepare_next: 'step',
      execute_next: 'step',
      continue_as_new: 'handle',
      cancel: 'handle',
      preflight: 'handle',
    });
  } finally {
    f.store.close();
  }
});

test('the recipe catalog answers before the recipe-argument checks; reads and plan actions are checked first', async () => {
  const f = fixture();
  try {
    const recipes = await f.operator({action: 'recipes', brief_id: 'brief-1', apply_playbook_rules: false});
    assert.ok(Array.isArray(recipes.recipes) && recipes.recipes.length > 0);
    const briefOnly =
      'brief_id and apply_playbook_rules apply to preview_recipe, recipe_eligibility and create_from_recipe.';
    for (const action of ['list', 'get', 'verify', 'create', 'cancel', 'nope'])
      await assert.rejects(f.operator({action, brief_id: 'brief-1'}), refused(briefOnly), action);
    for (const action of ['list', 'preview_recipe', 'prepare_next', 'nope'])
      await assert.rejects(
        f.operator({action, eligibility_ref: 'eligibility-1'}),
        refused('eligibility_ref applies to create_from_recipe only.'),
        action,
      );
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});

test('a reader’s reads run, but the write check refuses every creation and plan action before a plan is read', async () => {
  const f = fixture();
  try {
    const id = await f.plan();
    // The reads come before the write check: the list runs, and get reads the plan (and its owner refuses it).
    assert.equal((await f.reader({action: 'list'})).total, 0);
    await assert.rejects(
      f.reader({action: 'get', id}),
      refused('Campaign plan belongs to another actor.', 'FORBIDDEN'),
    );
    const operatorRequired = refused('An operator is required for workspace changes.', 'FORBIDDEN');
    for (const action of ['create', 'clone', 'cancel', 'archive', 'approve', 'prepare_next', 'nope', 'constructor'])
      for (const plan of [id, 'no-such-plan'])
        await assert.rejects(f.reader({action, id: plan}), operatorRequired, action + ' ' + plan);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});

test('archive and collaborators answer before the plan-state checks; a cancelled or archived plan refuses the rest', async () => {
  const f = fixture();
  try {
    const id = await f.plan();
    await assert.rejects(
      f.operator({action: 'cancel', id}),
      e => e.code === 'INVALID_ARGUMENT' && e.details.field === 'confirmed',
    );
    assert.equal((await f.operator({action: 'cancel', id, confirmed: true})).state, 'cancelled');
    const cancelled = refused('This campaign plan was cancelled.');
    for (const input of [
      {action: 'recover_step', id, step_id: 'campaign', confirmed: true},
      {action: 'reconcile_step', id, step_id: 'campaign'},
      {action: 'confirm_absent', id, step_id: 'campaign'},
      {action: 'activation_plan', id},
      {action: 'prepare_next', id},
      {action: 'nope', id},
    ])
      await assert.rejects(f.operator(input), cancelled, input.action);
    // cancel comes before the cancelled check, as in the chain: cancelling again keeps the plan cancelled.
    assert.equal((await f.operator({action: 'cancel', id, confirmed: true})).state, 'cancelled');
    await f.operator({action: 'archive', id, confirmed: true});
    const archived = e => e.code === 'PLAN_ARCHIVED' && e.details.next_call.arguments.action === 'unarchive';
    for (const action of ['continue_as_new', 'cancel', 'confirm_absent', 'prepare_next', 'nope'])
      await assert.rejects(f.operator({action, id, confirmed: true}), archived, action);
    await f.operator({action: 'unarchive', id, confirmed: true});
    await assert.rejects(f.operator({action: 'prepare_next', id}), cancelled);
    // A stale revision is refused before any of them.
    await assert.rejects(
      f.operator({action: 'archive', id, confirmed: true, expected_revision: -1}),
      refused('Reload the current campaign plan.', 'REVISION_CONFLICT'),
    );
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});

test('an unknown or inherited action is refused after the plan’s checks and next-step checks, as the chain refused it', async () => {
  const f = fixture();
  try {
    const id = await f.plan(),
      before = (await f.operator({action: 'get', id, detail: 'full'})).revision;
    for (const action of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
      await assert.rejects(f.operator({action, id}), refused('Unknown campaign action.'), action);
    // None of them changed the plan or reached a tool.
    assert.equal((await f.operator({action: 'get', id, detail: 'full'})).revision, before);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});
