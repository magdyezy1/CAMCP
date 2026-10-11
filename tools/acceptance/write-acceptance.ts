/**
 * ACC-01: the zero-spend live write acceptance harness. It runs one guided recipe through AMCP's own reviewed-write
 * loop on an owner-designated Google Ads test account: preflight, whole-plan review, approve, each step's review and
 * execution with every entity created paused or under a paused parent, automatic read-back, then the last review
 * executed again (a duplicate: no second write may reach Google). It records references only, as acceptance ledger rows.
 *
 * Usage, after `npm run build` (docs/acceptance/WRITE-ACCEPTANCE.md is the runbook):
 *   node dist/tools/acceptance/write-acceptance.js <plan.json>          dry run: validate and compile; no request
 *   node dist/tools/acceptance/write-acceptance.js <plan.json> --live   the live run, only with every flag below
 * Live flags, set in the environment through a secret-safe mechanism, never on the command line:
 *   AMCP_ACCEPTANCE_LIVE=true                      the explicit live switch
 *   AMCP_ACCEPTANCE_AUTHORIZATION=<ref>            equal to the plan's authorization_ref (the owner's written authorization)
 *   AMCP_ACCEPTANCE_PLAN_SHA256=<hex>              SHA-256 of the exact plan file the owner approved
 *   AMCP_ACCEPTANCE_RUN_ID=<id>                    a stable run ID; reuse it to resume after an interruption
 *   AMCP_ACCEPTANCE_STORAGE_KEY=<base64>           a 32-byte key for the run's encrypted local state
 *   AMCP_ACCEPTANCE_CREDENTIALS_JSON=<json>        {"accessToken": "..."}: a short-lived token of the test login
 * Without every flag the harness refuses before it reads a credential or sends anything.
 *
 * Safeguards beyond production's (none is relaxed): every request goes through a guard that allows only the Google Ads
 * API host and the plan's own test account, refuses DELETE, redirects and any `remove` operation, and refuses every
 * mutate until Google itself reported `customer.test_account = true` for that account in this run. The run's local
 * spending policy refuses any budget above the plan's own and any deletion.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Store} from '../../src/store.js';
import {Registry} from '../../src/catalog.js';
import {MirrorService} from '../../src/service.js';
import {NativeTransport} from '../../src/transport.js';
import {MirrorError} from '../../src/errors.js';
import {campaignRecipe, campaignRecipes} from '../../src/campaign-recipes.js';
import {saveSpendPolicy} from '../../src/spend-policy.js';
import {validateAcceptanceLedger} from '../../src/acceptance-ledger.js';
import type {Actor, Credentials, JsonObject} from '../../src/types.js';

/** Providers whose test-account status a guard can prove from the provider's own answer. */
export const qualifiedProviders = ['google'] as const;
const gateways: Record<string, string> = {google: 'google_ads_native_action'};
const label = /^[a-z][a-z0-9-]{1,39}$/,
  reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/,
  customer = /^[1-9][0-9]{9}$/;
export interface AcceptancePlan extends JsonObject {
  ticket: 'ACC-01';
  authorization_ref: string;
  provider: string;
  recipe: string;
  account_type: 'test';
  account_label: string;
  account_id: string;
  login_customer_id?: string;
  business: JsonObject;
  release: {revision: string; package_sha256: string};
}

/** Every problem with a plan file; an empty list means it can be compiled. */
export function validateAcceptancePlan(plan: unknown): string[] {
  const p = plan as JsonObject,
    problems: string[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['the plan is a JSON object'];
  const allowed = [
    'ticket',
    'authorization_ref',
    'provider',
    'recipe',
    'account_type',
    'account_label',
    'account_id',
    'login_customer_id',
    'business',
    'release',
  ];
  for (const key of Object.keys(p)) if (!allowed.includes(key)) problems.push('unknown field ' + key);
  if (p.ticket !== 'ACC-01') problems.push('ticket is ACC-01');
  if (typeof p.authorization_ref !== 'string' || !reference.test(p.authorization_ref))
    problems.push("authorization_ref names the owner's written authorization");
  if (!(qualifiedProviders as readonly string[]).includes(p.provider))
    problems.push(
      'provider is google: only a Google Ads test account reports its test status, which the guard requires. Microsoft and X use the sandbox runner (docs/SANDBOX-VERIFICATION.md); Meta and Snapchat wait on a qualified test-account proof.',
    );
  const recipe = campaignRecipes.find(r => r.id === p.recipe);
  if (!recipe) problems.push('recipe is a guided recipe ID');
  else if (recipe.platform !== p.provider) problems.push('the recipe belongs to provider ' + recipe.platform);
  // Only a non-serving test account: a real account is never an acceptance target of this harness.
  if (p.account_type !== 'test') problems.push('account_type is test');
  if (typeof p.account_label !== 'string' || !label.test(p.account_label) || /\d{6}/.test(p.account_label))
    problems.push('account_label is an owner label such as google-test-a, never an account ID');
  if (typeof p.account_id !== 'string' || !customer.test(p.account_id))
    problems.push('account_id is the 10-digit test account ID, without dashes');
  if (
    p.login_customer_id !== undefined &&
    (typeof p.login_customer_id !== 'string' || !customer.test(p.login_customer_id))
  )
    problems.push('login_customer_id is the 10-digit test manager account ID, without dashes');
  if (!p.business || typeof p.business !== 'object' || Array.isArray(p.business))
    problems.push('business holds the recipe inputs');
  else
    for (const key of ['account_id', 'connection_id'])
      if (p.business[key] !== undefined) problems.push('business.' + key + ' is set by the harness');
  if (
    !p.release ||
    typeof p.release.revision !== 'string' ||
    !/^[0-9a-f]{7,40}$/.test(p.release.revision) ||
    typeof p.release.package_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(p.release.package_sha256)
  )
    problems.push('release is the /versionz revision and package_sha256 the run is recorded against');
  return problems;
}

/** The live switches a run needs; each missing or different one is a refusal, checked before anything is read. */
export function liveRefusals(env: Record<string, string | undefined>, planBytes: Buffer, plan: JsonObject): string[] {
  const refusals: string[] = [];
  if (env.AMCP_ACCEPTANCE_LIVE !== 'true') refusals.push('AMCP_ACCEPTANCE_LIVE=true is not set');
  if (!env.AMCP_ACCEPTANCE_AUTHORIZATION || env.AMCP_ACCEPTANCE_AUTHORIZATION !== plan.authorization_ref)
    refusals.push("AMCP_ACCEPTANCE_AUTHORIZATION does not equal the plan's authorization_ref");
  if (env.AMCP_ACCEPTANCE_PLAN_SHA256 !== createHash('sha256').update(planBytes).digest('hex'))
    refusals.push('AMCP_ACCEPTANCE_PLAN_SHA256 does not match the plan file the owner approved');
  if (!env.AMCP_ACCEPTANCE_RUN_ID || !/^[A-Za-z0-9_-]{1,80}$/.test(env.AMCP_ACCEPTANCE_RUN_ID))
    refusals.push('AMCP_ACCEPTANCE_RUN_ID is not a stable run ID');
  if (!env.AMCP_ACCEPTANCE_STORAGE_KEY || Buffer.from(env.AMCP_ACCEPTANCE_STORAGE_KEY, 'base64').length !== 32)
    refusals.push('AMCP_ACCEPTANCE_STORAGE_KEY is not a 32-byte base64 key');
  if (!env.AMCP_ACCEPTANCE_CREDENTIALS_JSON) refusals.push('AMCP_ACCEPTANCE_CREDENTIALS_JSON is not set');
  return refusals;
}

/** The business the recipe compiles: the plan's inputs bound to the harness's own login and the test account. */
export const acceptanceConnection = '00000000-0000-4000-8000-00000000acc1';
const runBusiness = (plan: AcceptancePlan) => ({
  ...plan.business,
  account_id: plan.account_id,
  connection_id: acceptanceConnection,
});

/**
 * The dry run: the plan compiled locally, with what each step would create and the guard that would apply. It reads no
 * credential and sends nothing. Account IDs stay out of the output.
 */
export function dryRun(plan: AcceptancePlan, refusals: string[] = []): JsonObject {
  const problems = validateAcceptancePlan(plan);
  if (problems.length) return {mode: 'dry_run', status: 'invalid_plan', problems, provider_requests: 0};
  let compiled: JsonObject;
  try {
    compiled = campaignRecipe(plan.recipe, runBusiness(plan));
  } catch (e) {
    // The recipe's own refusal, such as a missing brief input, is a plan problem: nothing was sent.
    return {
      mode: 'dry_run',
      status: 'invalid_plan',
      problems: [(e as MirrorError).code + ': ' + (e as Error).message],
      provider_requests: 0,
    };
  }
  return {
    mode: 'dry_run',
    status: 'compiled',
    provider_requests: 0,
    ticket: plan.ticket,
    recipe: plan.recipe,
    account_label: plan.account_label,
    account_type: plan.account_type,
    steps: compiled.steps.map((s: JsonObject) => ({id: s.id, action: s.arguments?.action, depends_on: s.depends_on})),
    build: compiled.recipe?.build ?? null,
    paused_parent: JSON.stringify(compiled.steps).includes('"PAUSED"'),
    guard: [
      'only https://googleads.googleapis.com and this test account',
      'no DELETE, no redirect, no remove operation',
      "every mutate waits for Google's customer.test_account = true for this account",
      'a local spending policy that refuses a budget above the plan and any deletion',
    ],
    live_refusals: refusals,
    ready_for_live: refusals.length === 0,
  };
}

/**
 * The guard every request of a live run goes through. It answers ACCEPTANCE_TEST_ACCOUNT_REQUIRED for any mutate before
 * Google reported test status, and ACCEPTANCE_ROUTE_REFUSED for any other host, account, method or removal.
 */
export function testAccountFetch(fetcher: typeof fetch, accountId: string) {
  const state = {test_account: null as boolean | null, mutate_requests: 0, requests: 0};
  const refuse = (code: string, message: string) => {
    throw new MirrorError(code, message);
  };
  const guarded: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = String(init?.method ?? 'GET').toUpperCase(),
      body = typeof init?.body === 'string' ? init.body : '';
    if (url.protocol !== 'https:' || url.hostname !== 'googleads.googleapis.com' || url.port || url.username)
      refuse('ACCEPTANCE_ROUTE_REFUSED', 'The acceptance run reaches only the Google Ads API.');
    const owner = /\/customers\/([0-9]+)\//.exec(url.pathname)?.[1];
    if (owner !== accountId)
      refuse('ACCEPTANCE_ROUTE_REFUSED', 'The acceptance run reaches only the designated test account.');
    if (method === 'DELETE' || /"remove"\s*:/.test(body))
      refuse('ACCEPTANCE_ROUTE_REFUSED', 'The acceptance run never removes anything.');
    const mutate = /:mutate$/.test(url.pathname);
    if (mutate && state.test_account !== true)
      refuse(
        'ACCEPTANCE_TEST_ACCOUNT_REQUIRED',
        'Google has not reported this account as a test account in this run, so no change is sent.',
      );
    state.requests++;
    if (mutate) state.mutate_requests++;
    const response = await fetcher(input, {...init, redirect: 'error'});
    // Google's own answer for this account is the only proof of test status (Customer.test_account).
    if (!mutate && /customer\.test_account/.test(body) && response.ok) {
      const data = (await response
        .clone()
        .json()
        .catch(() => ({}))) as JsonObject;
      const c = data.results?.[0]?.customer;
      state.test_account = String(c?.id) === accountId && c?.testAccount === true;
    }
    return response;
  };
  return {fetch: guarded, state};
}

export interface RunOptions {
  store: Store;
  credentials: Credentials;
  runId: string;
  planSha256: string;
  fetcher?: typeof fetch;
  now?: () => number;
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The live run. It returns the record, accepted only when every step verified and the duplicate wrote nothing; the
 * record holds the review IDs, read-back digests and the provider contract, never an account ID, token or payload.
 */
export async function runWriteAcceptance(plan: AcceptancePlan, options: RunOptions): Promise<JsonObject> {
  const problems = validateAcceptancePlan(plan);
  if (problems.length) throw Error('Invalid acceptance plan: ' + problems.join('; '));
  const now = options.now ?? Date.now,
    gateway = gateways[plan.provider]!,
    actor: Actor = {tenantId: 'acceptance-' + options.runId, userId: 'acceptance-owner', role: 'admin'},
    guard = testAccountFetch(options.fetcher ?? fetch, plan.account_id),
    store = options.store;
  store.putConnection(
    actor,
    {
      id: acceptanceConnection,
      tenantId: actor.tenantId,
      gateway,
      accounts: [plan.account_id],
      writeAccounts: [plan.account_id],
      ...(plan.login_customer_id ? {accountLoginCustomers: {[plan.account_id]: plan.login_customer_id}} : {}),
      enabled: true,
      label: 'ACC-01 acceptance ' + plan.account_label,
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    options.credentials,
  );
  const service = new MirrorService(new Registry(), store, new NativeTransport(guard.fetch), undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const base = {
    record_kind: 'acceptance_write_run',
    ticket: plan.ticket,
    provider: plan.provider,
    gateway,
    recipe: plan.recipe,
    account_label: plan.account_label,
    account_type: plan.account_type,
    environment: 'native',
    release: plan.release,
    plan_sha256: options.planSha256,
    authorization_ref: plan.authorization_ref,
  };
  // 1. Google's own answer first: the account must be a test account before any change is prepared.
  const status = await service.call(
    gateway,
    {
      action: 'google_ads_v23_google_ads_search',
      customer_id: plan.account_id,
      connection_id: acceptanceConnection,
      payload: {query: 'SELECT customer.id, customer.test_account FROM customer LIMIT 1'},
    },
    actor,
  );
  if (guard.state.test_account !== true)
    return {
      ...base,
      checked_at: new Date(now()).toISOString(),
      outcome: 'refused',
      reason: status.success
        ? 'Google did not report this account as a test account; nothing was prepared or sent.'
        : 'The test status read failed (' + (status.error?.code ?? 'UNKNOWN') + '); nothing was prepared or sent.',
      provider_mutations: guard.state.mutate_requests,
      ledger_rows: [],
    };
  // 2. A local policy for this run: no budget above the plan's own, and no deletion.
  const budget = Number(plan.business.daily_budget);
  if (!Number.isFinite(budget) || budget <= 0) throw Error('business.daily_budget is the plan budget.');
  saveSpendPolicy(store, actor, {
    gateway,
    account_id: plan.account_id,
    confirmed: true,
    policy: {
      enforcement: 'block',
      allow_deletion: false,
      max_budget_currency: budget,
      currency: plan.business.currency,
    },
  });
  const call = async (input: JsonObject) => {
    const r = await service.call('amcp_campaign', input, actor);
    if (!r.success) throw new MirrorError(r.error.code, 'Acceptance call ' + input.action + ' failed: ' + r.error.code);
    return r.data;
  };
  // 3. The plan, resumed when this run ID already holds one.
  let run = store.documents(actor.tenantId, 'acceptance_run').find(d => d.id === options.runId);
  if (run && run.plan_sha256 !== options.planSha256)
    throw Error('This run ID belongs to another plan; keep its state and use a new run ID for a new plan.');
  if (!run) {
    const created = await call({action: 'create_from_recipe', recipe: plan.recipe, business: runBusiness(plan)});
    run = {plan_sha256: options.planSha256, campaign_id: created.id};
    store.putDocument(actor.tenantId, 'acceptance_run', options.runId, run);
  }
  const id = run.campaign_id;
  const preflight = await call({action: 'preflight', id});
  if (preflight.blocked)
    return {
      ...base,
      checked_at: new Date(now()).toISOString(),
      outcome: 'refused',
      reason:
        'Preflight blocked the plan: ' +
        (preflight.missing_requirements ?? []).map((m: JsonObject) => m.error?.code).join(', '),
      provider_mutations: guard.state.mutate_requests,
      ledger_rows: [],
    };
  // 4. The whole-plan review, then each step's own review and execution.
  const approval = await call({action: 'approve', id});
  for (let i = 0; i < 30; i++) {
    const prepared = await call({action: 'prepare_next', id});
    if (prepared.state === 'complete' || !prepared.review) break;
    const executed = await call({
      action: 'execute_next',
      id,
      review_id: prepared.review.review_id,
      idempotency_key: prepared.review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
    });
    if (executed.current?.status !== 'verified') break;
  }
  const stored = store.document(actor.tenantId, 'campaign_run', id),
    steps = stored.steps as JsonObject[];
  // 5. The last review once more: a duplicate, so no second write may reach Google.
  const mutationsBefore = guard.state.mutate_requests,
    last = steps.at(-1)!;
  const replay = last?.review_id
    ? await service.call(
        'amcp_campaign',
        {
          action: 'execute_next',
          id,
          review_id: last.review_id,
          idempotency_key: last.review_id,
          confirmed: true,
          spend_change_confirmed: true,
        },
        actor,
      )
    : undefined;
  const duplicateWrites = guard.state.mutate_requests - mutationsBefore,
    verified = stored.state === 'complete' && steps.every(s => s.status === 'verified'),
    provider = steps[0]?.review?.contract_evidence?.provider ?? {},
    checkedAt = new Date(now()).toISOString(),
    outcome = verified && duplicateWrites === 0 ? 'accepted' : 'inconclusive';
  const stepRecords = steps.map(s => ({
    id: s.id,
    action: s.arguments?.action,
    status: s.status,
    review_id: s.review_id ?? null,
    executed: s.result?.executed === true,
    readback_sha256: s.verification?.checks?.length
      ? sha(s.verification.checks.map((c: JsonObject) => c.actual_hash))
      : null,
  }));
  const actions = [...new Set(steps.map(s => String(s.review?.request?.action ?? '')).filter(Boolean))];
  const ledger_rows =
    outcome === 'accepted'
      ? actions.map((action, index) => {
          const own = steps.filter(s => s.review?.request?.action === action);
          return {
            id: ('acc-01-' + options.runId + '-' + (index + 1)).toLowerCase().slice(0, 80),
            ticket: 'ACC-01',
            gateway,
            action,
            effect: 'mutation',
            contract_digest: provider.contract_digest,
            api_version: provider.api_version,
            account_type: 'test',
            environment: 'native',
            scope: {account_label: plan.account_label, accounts: 1},
            checked_at: checkedAt.replace(/\.\d{3}Z$/, 'Z'),
            release: plan.release,
            authorization_ref: plan.authorization_ref,
            evidence: {
              review_id: own[0]!.review_id,
              receipt_refs: own.map(s => String(s.review_id)),
              readback_sha256: sha(own.flatMap(s => s.verification.checks.map((c: JsonObject) => c.actual_hash))),
            },
            outcome: 'accepted',
            note: 'Paused ' + plan.recipe + ' build on a Google Ads test account; the duplicate wrote nothing.',
          };
        })
      : [];
  const ledgerProblems = validateAcceptanceLedger({schema_version: 1, rows: ledger_rows});
  if (ledgerProblems.length) throw Error('The record would not pass the ledger: ' + ledgerProblems.join('; '));
  return {
    ...base,
    checked_at: checkedAt,
    outcome,
    api_version: provider.api_version ?? null,
    contract_digest: provider.contract_digest ?? null,
    plan_hash: approval.plan_hash ?? stored.plan_hash ?? null,
    steps: stepRecords,
    duplicate: {
      review_id: last?.review_id ?? null,
      provider_writes: duplicateWrites,
      answer: replay?.success ? 'no_change' : (replay?.error?.code ?? null),
    },
    provider_requests: guard.state.requests,
    provider_mutations: guard.state.mutate_requests,
    activation:
      'none: every entity was created paused or under a paused parent; activation is not part of this acceptance',
    ledger_rows,
  };
}

async function main(argv: string[]) {
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) throw Error('Usage: node dist/tools/acceptance/write-acceptance.js <plan.json> [--live]');
  const bytes = fs.readFileSync(file),
    plan = JSON.parse(bytes.toString('utf8')) as AcceptancePlan,
    refusals = liveRefusals(process.env, bytes, plan);
  if (!argv.includes('--live')) {
    console.log(JSON.stringify(dryRun(plan, refusals), null, 2));
    return;
  }
  const problems = validateAcceptancePlan(plan);
  if (problems.length || refusals.length) {
    console.log(JSON.stringify({mode: 'live', status: 'refused', problems, refusals, provider_requests: 0}, null, 2));
    process.exitCode = 1;
    return;
  }
  const runId = process.env.AMCP_ACCEPTANCE_RUN_ID!,
    directory = path.resolve('.runtime/acceptance', runId);
  fs.mkdirSync(directory, {recursive: true});
  let credentials: Credentials;
  try {
    credentials = JSON.parse(process.env.AMCP_ACCEPTANCE_CREDENTIALS_JSON!);
  } catch {
    throw Error('AMCP_ACCEPTANCE_CREDENTIALS_JSON is not valid JSON; its value is withheld.');
  }
  const store = new Store(path.join(directory, 'state.sqlite'), process.env.AMCP_ACCEPTANCE_STORAGE_KEY);
  try {
    const record = await runWriteAcceptance(plan, {
      store,
      credentials,
      runId,
      planSha256: process.env.AMCP_ACCEPTANCE_PLAN_SHA256!,
    });
    fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify({...record, record_file: path.join(directory, 'record.json')}, null, 2));
    if (record.outcome !== 'accepted') process.exitCode = 1;
  } finally {
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e instanceof MirrorError ? e.code + ': ' + e.message : e.message);
    process.exitCode = 1;
  });
