import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {actor as owner, campaign, googleWorld} from '../../dist/tests/helpers/google-write-fake.js';
import {CampaignRunner} from '../../dist/src/campaign-runner.js';
import {savePlanPolicy} from '../../dist/src/campaign-inventory.js';
import {createPlan, on} from './google-policy-failure.mjs';
import {AD_GROUP, keywordAction, keywordWorld} from './google-keyword-group.mjs';

/**
 * A seeded, randomized model of the campaign-plan lifecycle (r25-planmodel). One case builds a small plan (a budget create, a keyword create, a status update, a
 * write group of more than 25 records), then runs a random sequence of actions by two people (the plan's owner and an editor collaborator, and an approver for the
 * distinct-approver policy), some of them started and parked at an await point (a provider request, the target lock, the continuation's creation) while other
 * actions run, some abandoned there (a crash: the call is never resumed), with faults injected (a provider write refused or lost, read lag, a throw at the
 * continuation's creation, a cut-short plan save, a change of the provider's state). The invariants are judged from what the synthetic provider received, the
 * idempotency claims taken and the documents of the store, never from what the product says of itself:
 *   1  at most one live plan in a lineage;
 *   2  a provider write body is sent once per idempotency key, and again only after an earlier send whose claim was rejected (nothing applied);
 *   3  nothing is sent after a cancel (or after a continuation): no claim on a review of a cancelled or superseded plan;
 *   4  a retired review never executes: no claim on a marked review, and a direct execute of every review a plan went on from sends nothing and claims nothing;
 *   5  a mark stays as the plan wrote it (only a failed continuation reopens what it marked), and a cancelled plan never becomes live again;
 *   6  once every call has settled, no step is left executing, unless an injected crash reached it;
 *   7  after a crash, the reads an AI makes (get, the review's status, a refusal) name a call that leaves no step executing and sends nothing twice, and none
 *      names a standalone replacement of a review a plan's step holds; the case is recovered by an AI that reads the plan and again, from the same actions, by one
 *      that reads only the review's status;
 *   8  under the distinct-approver policy no write of a plan is sent unless another person approved its current hash;
 *   9  no call ends in an internal error that no injected fault explains;
 *  10  the plan kinds (item 4 of the audit of 2026-11-25): a case may be an activation plan, whose read-only gates may refuse and which the distinct-approver policy governs
 *      whatever its steps set, or a plan that retires catalog products; no write is sent in the lineage of an activation plan whose gates refuse (10a), and a plan that
 *      continues a bound plan carries the same binding, or is never made (10b).
 * A case is a seed: the same seed gives the same actions and the same result. `runModelCase({seed, actions})` replays a recorded list of actions.
 */
const T = 'google-world',
  editor = {tenantId: T, userId: 'editor2', role: 'operator'},
  approver = {tenantId: T, userId: 'approver', role: 'admin'},
  policyOwner = {tenantId: T, userId: 'owner', role: 'admin'},
  ACTORS = {O: owner, E: editor, A: approver},
  LIVE = ['draft', 'awaiting_review', 'in_progress', 'attention'],
  SETTLED = ['verified', 'verified_with_acceptance', 'complete', 'skipped_unchanged'],
  settled = s => SETTLED.includes(s.status),
  isLive = p => !!p && LIVE.includes(p.state),
  held = p => p?.state === 'superseded' && p.superseded_by?.pending === true,
  sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12),
  tick = ms => new Promise(resolve => setTimeout(resolve, ms)),
  WATCHDOG_MS = 8000;

/** mulberry32: a small deterministic generator, so a seed names a case. */
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next();
  return {
    int: n => Math.floor(next() * n),
    chance: p => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    weighted: table => {
      const total = table.reduce((sum, [, weight]) => sum + weight, 0);
      let at = next() * total;
      for (const [value, weight] of table) if ((at -= weight) < 0) return value;
      return table.at(-1)[0];
    },
  };
}

/** The seeds to run: a count (1..N), a range (a-b) or a list (a,b,c). */
export function parseSeeds(text, fallback) {
  const spec = String(text ?? '').trim();
  if (!spec) return fallback;
  if (/^\d+$/.test(spec)) return Array.from({length: Number(spec)}, (_, i) => i + 1);
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) return Array.from({length: Number(range[2]) - Number(range[1]) + 1}, (_, i) => Number(range[1]) + i);
  return spec
    .split(',')
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0);
}

export class ModelViolation extends Error {
  constructor(invariant, message) {
    super('invariant ' + invariant + ': ' + message);
    this.invariant = invariant;
    this.detail = message;
  }
}

const budgetAction = 'campaign_budget_mutate_campaign_budgets',
  statusAction = 'campaign_mutate_campaigns';
const planStep = (id, action, operations) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
});
/** The steps of a case's plan: 2 to 4 of a budget create, a keyword create, a status update and a write group of 26 or 27 records; every body is unique to its case. */
function planSteps(rng, tag) {
  const count = 2 + rng.int(3),
    kinds = [];
  for (let i = 0; i < count; i++) {
    const open = ['budget', 'budget', 'keywords', 'keywords', 'status', 'group'].filter(
      kind => !(['status', 'group'].includes(kind) && kinds.includes(kind)),
    );
    kinds.push(rng.pick(open));
  }
  return kinds.map((kind, i) => {
    const id = 's' + (i + 1),
      n = kind === 'group' ? 26 + rng.int(2) : 1 + rng.int(2),
      label = j => tag + ' ' + id + ' ' + kind + ' ' + j,
      keywords = () =>
        Array.from({length: n}, (_, j) => ({
          create: {ad_group: AD_GROUP, keyword: {text: label(j), match_type: 'BROAD'}},
        }));
    if (kind === 'budget')
      return planStep(
        id,
        budgetAction,
        Array.from({length: n}, (_, j) => ({
          create: {name: label(j), amount_micros: '50000000', delivery_method: 'STANDARD'},
        })),
      );
    if (kind === 'status')
      return planStep(id, statusAction, [
        {update: {resource_name: campaign(9), status: 'ENABLED'}, update_mask: 'status'},
      ]);
    return planStep(id, keywordAction, keywords());
  });
}
const isBudget = step => String(step.arguments?.action).includes('campaign_budget');
/** The kinds of plan a case may be (a seed draws one from a stream of its own, so that a seed of the plain kind is the case it always was). */
const KINDS = [
  ['plain', 55],
  ['activation_open', 15],
  ['activation_closed', 15],
  ['retirement', 15],
];
/** The plan's approval is another person's and is of the plan as it is now (src/campaign-runner.ts assertDistinctApproval). */
function approvedByAnother(plan) {
  const approval = plan.approval,
    who = plan.principal || plan.user_id;
  return (
    !!approval &&
    approval.plan_hash === plan.plan_hash &&
    Date.now() - approval.at <= 86400000 &&
    typeof approval.principal === 'string' &&
    approval.principal !== who
  );
}

class Call {
  constructor(model, id, kind, who, spec, label) {
    Object.assign(this, {m: model, id, kind, who, spec: spec ?? {}, label});
    this.actor = ACTORS[who];
    this.seen = {read: 0, write: 0, validation: 0};
    this.saves = 0;
    this.openClaims = [];
    this.locks = [];
    this.settled = this.crashed = this.parked = this.blocked = this.recheck = false;
    this.where = '';
    this.faultFired = false;
  }
  running() {
    return !this.settled && !this.crashed && !this.parked && (!this.blocked || this.recheck);
  }
  /** Parks the call at an await point until the model releases it. */
  async hold(where) {
    this.parked = true;
    this.where = where;
    this.m.poke();
    await new Promise(resolve => {
      this.resume = resolve;
    });
  }
  release() {
    this.parked = false;
    this.where = '';
    const resume = this.resume;
    this.resume = undefined;
    resume?.();
  }
  /** The process dies at this await point: the call is never resumed. */
  crash(where) {
    this.crashed = true;
    this.where = where;
    this.m.crashedCall(this);
    return new Promise(() => {});
  }
}

const outcome = result =>
  !result
    ? 'none'
    : result.success
      ? 'ok'
      : String(result.error?.code ?? 'failed') +
        (result.error?.details?.reason ? '/' + result.error.details.reason : '');

export class PlanModel {
  constructor(seed, options = {}) {
    this.seed = seed;
    this.rng = prng(seed * 7919 + 13);
    this.tag = 'm' + seed;
    this.replay = options.actions;
    // Who recovers a crash: an AI that reads the plan ('get', which also reads the review's status), or, on the same case again, one that reads only the review's status
    // ('status'): the status of a review a plan holds must lead back to the plan on its own, not only when the plan's own read names the way first (r25-planmodel, F4).
    this.via = options.via ?? 'get';
    this.recovered = false;
    // The plan's kind (r25-planmodel, item 4 of the audit of 2026-11-25): only when the case asks for the kinds (`flavors`), so that a seed pinned for an earlier finding is still that case.
    this.flavors = !!options.flavors;
    this.kind = 'plain';
    this.actions = [];
    this.trace = [];
    this.als = new AsyncLocalStorage();
    this.calls = new Map();
    this.callSeq = 0;
    this.seq = 0;
    this.ledger = {sends: []};
    this.claimChecks = [];
    this.violations = [];
    this.known = [];
    this.liveIds = [];
    this.pool = [];
    this.names = new Map();
    this.gone = new Map();
    this.marks = new Map();
    this.lastState = new Map();
    this.crashedSteps = new Set();
    this.counter = 0;
    this.skew = 0;
    this.wake = undefined;
    this.pause = false;
  }

  // ---- naming and the trace -------------------------------------------------------------------------------------------------------------------------------
  name(id, prefix) {
    const key = prefix + ':' + id;
    if (!this.names.has(key))
      this.names.set(key, prefix + [...this.names.keys()].filter(k => k.startsWith(prefix + ':')).length);
    return this.names.get(key);
  }
  pn = id => this.name(id, 'P');
  rn = id => this.name(id, 'r');
  log(text) {
    this.trace.push(String(this.trace.length + 1).padStart(2, '0') + ' ' + text);
  }
  planLine(snap) {
    return [...snap.plans]
      .map(
        ([id, p]) =>
          this.pn(id) +
          ':' +
          p.state +
          (held(p) ? '(held)' : '') +
          (p.archived ? '+archived' : '') +
          '[' +
          p.steps.map(s => s.id + '=' + s.status).join(' ') +
          ']',
      )
      .join(' ');
  }

  // ---- the scheduler ---------------------------------------------------------------------------------------------------------------------------------------
  poke() {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
  async tick() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the model made no progress for ' + WATCHDOG_MS + ' ms: ' + this.stuck())),
        WATCHDOG_MS,
      );
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  async until(done) {
    while (!done()) await this.tick();
  }
  stuck() {
    return [...this.calls.values()]
      .filter(c => !c.settled && !c.crashed)
      .map(
        c =>
          '#' +
          c.id +
          ' ' +
          c.kind +
          (c.parked ? ' parked at ' + c.where : c.blocked ? ' blocked on a lock' : ' running'),
      )
      .join(', ');
  }
  inflight = () => [...this.calls.values()].some(c => !c.settled && !c.crashed);
  parkedCalls = () => [...this.calls.values()].filter(c => c.parked);
  async drain() {
    await this.until(() => ![...this.calls.values()].some(c => c.running()));
  }
  crashedCall(call) {
    for (const lock of call.locks) this.realReleaseLocks(lock.keys, lock.owner);
    call.locks = [];
    for (const c of this.calls.values()) if (c.blocked) c.recheck = true;
    if (call.kind === 'execute' && call.stepId) this.crashedSteps.add(call.planId + '/' + call.stepId);
    this.poke();
  }
  current() {
    const ctx = this.als.getStore();
    return ctx ? this.calls.get(ctx.id) : undefined;
  }
  svc = (tool, input, who = 'O') => this.x.service.call(tool, input, ACTORS[who]);

  /** Starts a call: its synchronous part has run when this returns, and the rest of it goes on by itself until it settles, parks, crashes or blocks. */
  begin(kind, who, spec, label, fn, extra = {}) {
    const call = new Call(this, ++this.callSeq, kind, who, spec, label);
    Object.assign(call, extra);
    call.before = this.snapshot();
    this.calls.set(call.id, call);
    call.promise = this.als
      .run({id: call.id}, () => fn(call))
      .then(
        result => {
          call.result = result;
          call.settled = true;
          this.settle(call);
          this.poke();
        },
        error => {
          call.threw = error;
          call.result = {success: false, error: {code: 'HARNESS_THROW', message: String(error?.stack ?? error)}};
          call.settled = true;
          this.settle(call);
          this.poke();
        },
      );
    return call;
  }
  /** Starts a call and returns once it has settled, parked at a gate, crashed or blocked on a lock. */
  async launch(kind, who, spec, label, fn, extra = {}) {
    const call = this.begin(kind, who, spec, label, fn, extra);
    await this.until(() => call.settled || call.parked || call.crashed || call.blocked);
    return call;
  }

  // ---- the world and its hooks -----------------------------------------------------------------------------------------------------------------------------
  async setup() {
    const rng = this.rng,
      steps = planSteps(rng, this.tag);
    const coin = steps.some(isBudget) && rng.chance(0.4),
      kinds = this.flavors ? prng(this.seed * 104729 + 7) : undefined,
      kind = kinds ? kinds.weighted(KINDS) : 'plain',
      activation = kind.startsWith('activation') && kinds.chance(0.7);
    this.kind = kind;
    this.policyOn = kind.startsWith('activation') ? activation : coin;
    const x = (this.x = googleWorld({
      policy: on,
      world: {...keywordWorld(), campaignBudgets: {'customers/123/campaignBudgets/1': {}}},
    }));
    for (const user of ['operator', 'editor2'])
      x.store.db
        .prepare('INSERT OR IGNORE INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
        .run(T, user, 'operator', Date.now());
    if (this.policyOn) savePlanPolicy(x.store, policyOwner, {require_distinct_approver: true, confirmed: true});
    const id = await createPlan(x, steps),
      shared = await x.call('amcp_campaign', {action: 'assign', id, user_id: 'editor2', role: 'editor'});
    if (!shared.success) throw new Error('the editor could not be assigned: ' + JSON.stringify(shared.error));
    this.root = id;
    if (kind !== 'plain') this.bind(id);
    this.install();
    this.refresh(this.snapshot());
    this.log(
      'setup: ' +
        steps
          .map(s => s.id + '=' + (isBudget(s) ? 'budget' : String(s.arguments.action).replace(/^google_ads_v23_/, '')))
          .join(', ') +
        (kind === 'retirement'
          ? '; a catalog retirement plan'
          : kind.startsWith('activation')
            ? '; an activation plan' + (kind === 'activation_closed' ? ' whose gates refuse' : '')
            : '') +
        (this.policyOn ? '; the distinct-approver policy is on' : ''),
    );
  }
  /**
   * The plan is made what its kind says (item 4 of the audit of 2026-11-25): an activation plan (`activation_of`; with a conversion goal to read the gate refuses, and the world
   * has none to give, so the plan's preflight and every call after it are refused), or a plan that retires catalog products (`catalog_retirement`, which only catalog_plan can
   * bind). Written to the document as the audit's script wrote its recipe, before the model watches the store.
   */
  bind(id) {
    const {id: _id, revision, ...data} = this.x.store.document(T, 'campaign_run', id);
    if (this.kind === 'retirement')
      data.catalog_retirement = {retailer_ids: ['SKU-' + this.tag], availability: 'discontinued'};
    else
      data.activation_of = {
        id: 'launch-' + this.tag,
        plan_hash: 'launch-hash',
        recipe_id: 'google_search_clicks',
        platform: 'google',
        ...(this.kind === 'activation_closed' ? {conversion_goals: {currency: 'USD'}} : {}),
      };
    this.x.store.putDocument(T, 'campaign_run', id, data, revision);
  }
  /** What binds a plan (`activation_of`, `catalog_retirement`): its own, or that of a plan it continues. */
  bindingOf(snap, plan, key) {
    for (let p = plan, hops = 0; p && hops < 10; p = snap.plans.get(p.supersedes?.id), hops++)
      if (p[key]) return p[key];
    return undefined;
  }
  /** Whether the owner's distinct-approver policy governs the plan: it is on and a step sets a money field (src/plan-approval.ts approvalMoney) or the plan activates a launch. */
  governs(snap, plan) {
    return this.policyOn && (plan.steps.some(isBudget) || !!this.bindingOf(snap, plan, 'activation_of'));
  }

  install() {
    const x = this.x,
      model = this,
      transport = x.service.transport,
      realFetch = transport.fetcher,
      handle = CampaignRunner.prototype.handle,
      claim = x.store.claim.bind(x.store),
      put = x.store.putDocument.bind(x.store),
      acquire = x.store.acquireLocks.bind(x.store),
      release = x.store.releaseLocks.bind(x.store),
      created = x.created.get.bind(x.created),
      realNow = Date.now;
    this.realReleaseLocks = release;
    this.restore = () => {
      CampaignRunner.prototype.handle = handle;
      Date.now = realNow;
    };
    Date.now = () => realNow() + this.skew;
    transport.fetcher = async (url, init) => {
      const call = model.current(),
        body = JSON.parse(String(init?.body ?? '{}')),
        kind = String(url).endsWith('googleAds:search')
          ? 'read'
          : body.validateOnly === true || body.validate_only === true
            ? 'validation'
            : 'write';
      if (!call) return realFetch(url, init);
      const n = ++call.seen[kind],
        park = call.spec.park;
      if (park && park.at === kind && park.nth === n)
        await (park.mode === 'crash'
          ? call.crash('provider ' + kind + ' #' + n)
          : call.hold('provider ' + kind + ' #' + n));
      if (kind !== 'write') return realFetch(url, init);
      return model.sendWrite(call, n, () => realFetch(url, init));
    };
    x.store.claim = (tenant, key, fingerprint) => {
      const out = claim(tenant, key, fingerprint),
        call = model.current();
      if (out.fresh) {
        call?.openClaims.push(key);
        model.onFreshClaim(key, call);
      }
      return out;
    };
    x.store.putDocument = (tenant, kind, id, data, ...rest) => {
      const call = model.current(),
        cut = call?.spec.cutSave;
      if (call && cut && !call.cutDone && kind === 'campaign_run') {
        const hit =
          cut.variant === 'nth'
            ? ++call.saves === cut.n
            : cut.variant === 'hold'
              ? id === call.planId && data?.superseded_by?.pending === true
              : cut.variant === 'old-final'
                ? id === call.planId && typeof data?.superseded_by?.id === 'string'
                : id !== call.planId;
        if (hit) {
          call.cutDone = call.faultFired = true;
          if (call.kind === 'execute' && call.stepId) model.crashedSteps.add(call.planId + '/' + call.stepId);
          throw new Error('synthetic failure of a plan save (' + cut.variant + ')');
        }
      }
      // Another process acts on the plan just before this call saves it (the hold of a continuation): its revision is out of date when the save comes.
      const race = call?.spec.racer;
      if (
        race &&
        !call.raced &&
        kind === 'campaign_run' &&
        id === call.planId &&
        data?.superseded_by?.pending === true
      ) {
        call.raced = true;
        const who = call.who === 'O' ? 'E' : 'O',
          input =
            race.action === 'continue'
              ? {action: 'continue_as_new', id, confirmed: true}
              : {action: 'cancel', id, confirmed: true};
        model.log(
          'a second process: ' + who + ' ' + race.action + ' lands just before the hold of #' + call.id + ' is saved',
        );
        model.begin(race.action, who, {}, 'racing ' + race.action, () => model.svc('amcp_campaign', input, who), {
          planId: id,
          racing: true,
        });
      }
      return put(tenant, kind, id, data, ...rest);
    };
    x.store.acquireLocks = (keys, lockOwner, ttl) => {
      const call = model.current(),
        gate = call?.spec.park?.at === 'lock' && !call.gatePassed;
      if (gate && keys.length) {
        if (!call.gateEntered) {
          call.gateEntered = true;
          call.parked = true;
          call.where = 'the target lock';
          model.poke();
        }
        if (call.parked) return false;
        call.gatePassed = true;
      }
      const got = acquire(keys, lockOwner, ttl);
      if (call) {
        call.recheck = false;
        if (got) {
          call.blocked = false;
          if (keys.length) call.locks.push({keys, owner: lockOwner});
        } else if (!call.blocked) {
          call.blocked = true;
        }
        model.poke();
      }
      return got;
    };
    x.store.releaseLocks = (keys, lockOwner) => {
      release(keys, lockOwner);
      const call = model.current();
      if (call) call.locks = call.locks.filter(l => l.owner !== lockOwner);
      for (const c of model.calls.values()) if (c.blocked) c.recheck = true;
      model.poke();
    };
    x.created.get = name => {
      const lag = model.current()?.spec.lag;
      if (lag && lag.left > 0) {
        lag.left--;
        return undefined;
      }
      return created(name);
    };
    CampaignRunner.prototype.handle = function (input, who) {
      const call = model.current(),
        gate = call?.spec.create,
        nested =
          input?.action === 'create' &&
          typeof input.idempotency_key === 'string' &&
          input.idempotency_key.startsWith('continue-');
      // Only the creation a continuation makes under a gate is wrapped: every other call keeps the synchronous start it has, so that a call another process starts
      // while this one is between two saves does its work at once.
      if (!call || !nested || !gate) return handle.call(this, input, who);
      const at = async when => {
        if (gate.when !== when) return;
        const where = 'the continuation’s creation (' + when + ')';
        if (gate.mode === 'throw') {
          call.faultFired = true;
          throw new Error('synthetic failure ' + when + ' the new plan was made');
        }
        await (gate.mode === 'crash' ? call.crash(where) : call.hold(where));
      };
      return (async () => {
        await at('before');
        const out = await handle.call(this, input, who);
        await at('after');
        return out;
      })();
    };
  }

  /** A write that reaches the synthetic provider: attributed to the claim it was sent under, judged against the earlier sends of the same body, then sent or failed. */
  async sendWrite(call, n, send) {
    const fault = call.spec.writeFault?.nth === n ? call.spec.writeFault.kind : undefined,
      key = this.attribute(call);
    if (!key)
      this.violate(
        '2',
        'a write reached the provider with no idempotency claim behind it (call #' + call.id + ' ' + call.kind + ')',
      );
    if (fault === 'lose-before') {
      call.faultFired = true;
      throw new TypeError('fetch failed');
    }
    const hooks = this.x.hooks;
    if (fault === 'refuse')
      hooks.writeReply = () => ({
        status: 400,
        body: {error: {code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.'}},
      });
    const pending = send();
    hooks.writeReply = undefined;
    const received = this.x.log.at(-1),
      hash = sha(JSON.stringify(received.body)),
      claims = this.claimStates();
    for (const earlier of this.ledger.sends)
      if (earlier.hash === hash && claims.get(earlier.key) !== 'rejected')
        this.violate(
          '2',
          'a body was sent again (' +
            hash +
            ', ' +
            this.rn(key) +
            ' after ' +
            this.rn(earlier.key) +
            ' whose claim is ' +
            (claims.get(earlier.key) ?? 'gone') +
            ')',
        );
    if (this.ledger.sends.some(s => s.key === key)) this.violate('2', 'the key ' + this.rn(key) + ' was sent twice');
    this.ledger.sends.push({seq: ++this.seq, key, hash, call: call.id});
    if (fault === 'refuse') call.faultFired = true;
    const response = await pending;
    // The provider has applied the write and the process stops before it records the outcome: the claim stays pending.
    const park = call.spec.park;
    if (park?.at === 'written' && park.nth === n)
      await (park.mode === 'crash'
        ? call.crash('after the provider applied write #' + n)
        : call.hold('after the provider applied write #' + n));
    if (fault === 'lose') {
      call.faultFired = true;
      throw new TypeError('fetch failed');
    }
    return response;
  }
  attribute(call) {
    const exists = this.x.store.db.prepare('SELECT 1 FROM idempotency WHERE tenant_id=? AND key=?');
    while (call.openClaims.length) {
      const key = call.openClaims.shift();
      if (exists.get(T, key)) return key;
    }
    return undefined;
  }
  claimStates() {
    return new Map(
      this.x.store.db
        .prepare('SELECT key, state FROM idempotency WHERE tenant_id=?')
        .all(T)
        .map(r => [r.key, r.state]),
    );
  }
  violate(invariant, message) {
    this.violations.push(new ModelViolation(invariant, message));
  }

  // ---- what the store holds -------------------------------------------------------------------------------------------------------------------------------
  snapshot() {
    const plans = new Map(),
      reviews = new Map();
    for (const row of this.x.store.db
      .prepare(
        "SELECT kind, id, data FROM documents WHERE tenant_id=? AND kind IN ('campaign_run','write_review','write_review_group') ORDER BY rowid",
      )
      .all(T)) {
      const doc = JSON.parse(row.data);
      if (row.kind === 'campaign_run') plans.set(row.id, doc);
      else reviews.set(row.id, {...doc, group: row.kind === 'write_review_group'});
    }
    return {plans, reviews, claims: this.claimStates()};
  }
  /** Every review the plans name (the step's own, its earlier attempts, the parts of a group) and which step holds it, or went on from it. */
  holders(snap, key) {
    const out = [];
    for (const [pid, plan] of snap.plans)
      for (const step of plan.steps) {
        const mine = [['held', step.review_id], ...(step.previous_attempts ?? []).map(a => ['earlier', a.review_id])];
        for (const [role, id] of mine) {
          if (id === key) out.push({plan: pid, step, role});
          else if (typeof id === 'string' && snap.reviews.get(id)?.parts?.includes(key))
            out.push({plan: pid, step, role: role === 'held' ? 'part' : 'earlier'});
        }
      }
    return out;
  }
  claimedReview(snap, id) {
    return snap.claims.has(id) || (snap.reviews.get(id)?.parts ?? []).some(part => snap.claims.has(part));
  }
  refresh(snap) {
    for (const id of snap.plans.keys()) if (!this.known.includes(id)) this.known.push(id);
    this.liveIds = this.known.filter(id => isLive(snap.plans.get(id)));
    for (const plan of snap.plans.values())
      for (const step of plan.steps)
        for (const id of [step.review_id, ...(step.previous_attempts ?? []).map(a => a.review_id)])
          if (typeof id === 'string') {
            for (const r of [id, ...(snap.reviews.get(id)?.parts ?? [])]) if (!this.pool.includes(r)) this.pool.push(r);
          }
  }

  // ---- the checks made when a claim is taken --------------------------------------------------------------------------------------------------------------
  onFreshClaim(key, call, snap = this.snapshot()) {
    const review = snap.reviews.get(key),
      issues = [];
    if (review?.retired)
      issues.push(['4', 'a claim was taken on ' + this.rn(key) + ', which is retired (' + review.retired.reason + ')']);
    const holders = this.holders(snap, key);
    if (!review?.group && holders.length) {
      if (holders.every(h => h.role === 'earlier'))
        issues.push(['4', 'a claim was taken on ' + this.rn(key) + ', a review its step went on from']);
      for (const h of holders.filter(h => h.role !== 'earlier')) {
        const plan = snap.plans.get(h.plan);
        if (plan.state === 'cancelled')
          issues.push(['3', 'a claim was taken on ' + this.rn(key) + ' of cancelled ' + this.pn(h.plan)]);
        if (plan.state === 'superseded')
          issues.push(['3', 'a claim was taken on ' + this.rn(key) + ' of superseded ' + this.pn(h.plan)]);
        if (this.kind === 'activation_closed' && this.bindingOf(snap, plan, 'activation_of'))
          issues.push([
            '10a',
            'a claim was taken on ' +
              this.rn(key) +
              ' of ' +
              this.pn(h.plan) +
              ', in the lineage of an activation plan whose gates refuse',
          ]);
        if (this.governs(snap, plan)) {
          if (call?.kind === 'direct' || call?.kind === 'probe')
            issues.push([
              '8',
              'a direct execute sent ' +
                this.rn(key) +
                ' of ' +
                this.pn(h.plan) +
                ' under the distinct-approver policy',
            ]);
          else if (call?.kind === 'execute' && !call.firstClaimed && !call.resumed && !call.approvedAtStart)
            issues.push([
              '8',
              'execute_next sent ' +
                this.rn(key) +
                ' of ' +
                this.pn(h.plan) +
                ' with no current approval by another person',
            ]);
        }
      }
    }
    if (call?.kind === 'execute') call.firstClaimed = true;
    if (issues.length) this.claimChecks.push({key, issues});
  }

  // ---- the invariants ---------------------------------------------------------------------------------------------------------------------------------------
  checkpoint(label, quiescent = false) {
    if (this.fatal) throw this.fatal;
    const snap = this.snapshot();
    this.refresh(snap);
    for (const {key, issues} of this.claimChecks.splice(0))
      // A claim a refusal rolled back, or released, sent nothing and is no violation.
      if (snap.claims.has(key)) this.violate(issues[0][0], issues[0][1]);
    this.lineage(snap);
    this.marksAndStates(snap);
    if (quiescent && !this.inflight()) {
      for (const [pid, plan] of snap.plans)
        for (const step of plan.steps)
          if (step.status === 'executing' && !this.crashedSteps.has(pid + '/' + step.id))
            this.violate(
              '6',
              this.pn(pid) + ' step ' + step.id + ' is left executing with every call settled and no crash',
            );
    }
    const keys = new Set();
    for (const send of this.ledger.sends) {
      if (keys.has(send.key)) this.violate('2', 'the key ' + this.rn(send.key) + ' was sent twice');
      keys.add(send.key);
    }
    if (this.violations.length) {
      const first = this.violations[0];
      first.after = label;
      throw first;
    }
  }
  lineage(snap) {
    const parent = new Map(),
      find = id => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id))),
      join = (a, b) => parent.set(find(a), find(b));
    for (const id of snap.plans.keys()) parent.set(id, id);
    for (const [id, plan] of snap.plans)
      for (const other of [plan.supersedes?.id, plan.superseded_by?.id ?? plan.superseded_by?.to])
        if (typeof other === 'string' && snap.plans.has(other)) join(id, other);
    // 10b: a plan that continues another carries what bound it (an activation's gates and second approver, a retirement's check of the catalog).
    for (const [id, plan] of snap.plans) {
      const parent = snap.plans.get(plan.supersedes?.id);
      for (const key of ['activation_of', 'catalog_retirement'])
        if (parent?.[key] && !plan[key])
          this.violate(
            '10b',
            this.pn(id) +
              ' continues ' +
              this.pn(plan.supersedes.id) +
              ' without its ' +
              key +
              ': what bound the plan was not carried',
          );
    }
    const liveIn = new Map();
    for (const [id, plan] of snap.plans) if (isLive(plan)) liveIn.set(find(id), [...(liveIn.get(find(id)) ?? []), id]);
    for (const ids of liveIn.values())
      if (ids.length > 1)
        this.violate('1', 'two plans of one lineage are live: ' + ids.map(id => this.pn(id)).join(', '));
  }
  marksAndStates(snap) {
    for (const [id, review] of snap.reviews) {
      const mark = review.retired
          ? JSON.stringify([review.retired.plan_id, review.retired.step_id, review.retired.reason, review.retired.at])
          : undefined,
        before = this.marks.get(id);
      if (before !== undefined && mark !== before) {
        const [planId, , reason] = JSON.parse(before),
          plan = snap.plans.get(planId);
        // Only a failed continuation takes back what it marked, and only for a plan that is live again.
        if (mark === undefined && reason === 'continued' && isLive(plan)) this.marks.delete(id);
        else
          this.violate(
            '5',
            'the mark of ' +
              this.rn(id) +
              ' (' +
              reason +
              ' by ' +
              this.pn(planId) +
              ') ' +
              (mark ? 'was overwritten' : 'was removed') +
              ', and ' +
              this.pn(planId) +
              ' is ' +
              plan?.state,
          );
      }
      if (mark !== undefined) this.marks.set(id, mark);
    }
    for (const [id, why] of this.gone)
      if (!snap.reviews.get(id)?.retired)
        this.violate(
          '4',
          this.rn(id) + ', which ' + this.pn(why.plan) + ' went on from (' + why.reason + '), carries no mark',
        );
    for (const [id, plan] of snap.plans) {
      const now = {state: plan.state, held: held(plan)},
        was = this.lastState.get(id);
      if (was && !this.legal(was, now))
        this.violate(
          '5',
          this.pn(id) +
            ' went from ' +
            was.state +
            (was.held ? '(held)' : '') +
            ' to ' +
            now.state +
            (now.held ? '(held)' : ''),
        );
      this.lastState.set(id, now);
    }
  }
  legal(was, now) {
    if (was.state === now.state && was.held === now.held) return true;
    if (LIVE.includes(was.state) || (was.state === 'superseded' && was.held)) return true;
    // A plan that ran to its end may be cancelled (nothing is left to stop, and it can then be archived either way).
    if (was.state === 'complete') return now.state === 'complete' || now.state === 'cancelled';
    if (was.state === 'cancelled') return now.state === 'cancelled' || now.state === 'superseded';
    return now.state === 'superseded' && !now.held;
  }

  // ---- what a settled call leaves behind ------------------------------------------------------------------------------------------------------------------
  settle(call) {
    try {
      this.afterCall(call);
    } catch (error) {
      this.fatal ??= error;
    }
  }
  afterCall(call) {
    const result = call.result;
    if (call.racing) this.log('the second process’s ' + call.kind + ' -> ' + outcome(result));
    if (call.threw) throw call.threw;
    if (result?.error?.code === 'INTERNAL_ERROR' && !call.faultFired)
      this.violate(
        '9',
        call.kind +
          ' ended in an internal error no injected fault explains: ' +
          String(result.error.message).slice(0, 160),
      );
    if (!result?.success || !call.planId) return;
    const before = call.before,
      plan = before.plans.get(call.planId);
    if (!plan) return;
    const add = (id, reason, stepId, cancelling) => {
      const review = typeof id === 'string' ? before.reviews.get(id) : undefined;
      if (!review) return;
      const mark = target => this.gone.has(target) || this.gone.set(target, {plan: call.planId, step: stepId, reason});
      if (!review.group) return before.claims.has(id) ? undefined : mark(id);
      const parts = review.parts ?? [],
        untouched = !before.claims.has(id) && !parts.some(p => before.claims.has(p));
      if (untouched) [id, ...parts].forEach(mark);
      else if (cancelling) parts.filter(p => !before.claims.has(p)).forEach(mark);
    };
    if (call.kind === 'cancel')
      for (const step of plan.steps) if (!settled(step)) add(step.review_id, 'cancelled', step.id, true);
    if (call.kind === 'continue')
      for (const step of plan.steps) if (!settled(step)) add(step.review_id, 'continued', step.id, false);
    if (call.kind === 'recover')
      add(plan.steps.find(s => s.id === call.stepId)?.review_id, 'amended', call.stepId, false);
    if (call.kind === 'prepare') {
      const now = this.snapshot().plans.get(call.planId),
        step = plan.steps.find(s => !settled(s)),
        after = now?.steps.find(s => s.id === step?.id);
      if (step?.status === 'pending' && step.review_id && after?.review_id !== step.review_id)
        add(step.review_id, 'replaced', step.id, false);
    }
  }

  // ---- the generator ----------------------------------------------------------------------------------------------------------------------------------------
  /** The fault or gate a call starts with: a park at an await point, a refused or lost provider write, read lag, a throw at the continuation's creation, a cut-short save. */
  specFor(kind, heat = 0.4, parts = 1) {
    const r = this.rng,
      mode = p => (r.chance(p) ? 'crash' : 'hold'),
      write = () => 1 + r.int(parts);
    if (!r.chance(heat)) return {};
    if (kind === 'prepare')
      return r.weighted([
        [{park: {at: 'read', nth: 1 + r.int(2), mode: mode(0.3)}}, 4],
        [{park: {at: 'validation', nth: 1, mode: 'hold'}}, 2],
        [{cutSave: {variant: 'nth', n: 1 + r.int(2)}}, 2],
      ]);
    if (kind === 'execute' || kind === 'direct')
      return r.weighted([
        [{park: {at: 'lock', mode: 'hold'}}, 3],
        [{park: {at: 'read', nth: 1, mode: mode(0.35)}}, 6],
        [{park: {at: 'read', nth: 2 + r.int(parts), mode: mode(0.35)}}, 3],
        [{park: {at: 'write', nth: write(), mode: mode(0.35)}}, 3],
        [{park: {at: 'written', nth: write(), mode: mode(0.5)}}, 3],
        [{writeFault: {kind: 'refuse', nth: write()}}, 8],
        [{writeFault: {kind: 'lose', nth: write()}}, 3],
        [{writeFault: {kind: 'lose-before', nth: write()}}, 2],
        [{lag: 1 + r.int(2)}, 1],
        ...(kind === 'execute' ? [[{cutSave: {variant: 'nth', n: 2}}, 3]] : []),
      ]);
    if (kind === 'continue')
      return r.weighted([
        [{create: {when: 'before', mode: 'hold'}}, 8],
        [{create: {when: 'before', mode: 'crash'}}, 3],
        [{create: {when: 'before', mode: 'throw'}}, 4],
        [{create: {when: 'after', mode: 'throw'}}, 3],
        [{create: {when: 'after', mode: 'hold'}}, 2],
        [{create: {when: 'after', mode: 'crash'}}, 1],
        [{cutSave: {variant: 'old-final'}}, 4],
        [{cutSave: {variant: 'new-plan'}}, 3],
        [{cutSave: {variant: 'hold'}}, 2],
        [{racer: {action: 'cancel'}}, 6],
        [{racer: {action: 'continue'}}, 3],
      ]);
    return r.chance(0.12) ? {cutSave: {variant: 'nth', n: 1}} : {};
  }
  /**
   * The next action, chosen from what the case looks like now: it is mostly about the plan a parked call is working on, a plan held for a continuation, or a
   * cancelled plan, because those are where one person's call meets another's, and what a plan went on from is tried directly again and again.
   */
  nextAction() {
    const r = this.rng,
      snap = this.snapshot(),
      parked = this.parkedCalls(),
      focus = parked.length && r.chance(0.6) ? parked[r.int(parked.length)] : undefined,
      heldId = this.known.find(id => held(snap.plans.get(id))),
      cancelledId = this.known.find(id => snap.plans.get(id)?.state === 'cancelled');
    let plan;
    if (focus?.planId && snap.plans.has(focus.planId)) plan = this.known.indexOf(focus.planId);
    else if (heldId && r.chance(0.45)) plan = this.known.indexOf(heldId);
    else if (cancelledId && r.chance(0.3)) plan = this.known.indexOf(cancelledId);
    else
      plan = r.weighted([
        ['live', 7],
        ['latest', 3],
        ['root', 2],
        [r.int(8), 1],
      ]);
    const target = snap.plans.get(this.resolvePlan(plan)),
      alive = isLive(target),
      onHold = held(target),
      next = target?.steps.find(s => !settled(s)),
      review = snap.reviews.get(next?.review_id),
      executable = alive && !!review && ['review_ready', 'executing'].includes(next?.status),
      trouble = target?.steps.some(
        s => ['failed', 'uncertain'].includes(s.status) || (s.status === 'pending' && s.error),
      ),
      parkedHere = parked.filter(c => c.planId === this.resolvePlan(plan)),
      inflightExecute = parkedHere.some(c => ['execute', 'direct'].includes(c.kind)),
      inflightContinue = parkedHere.some(c => c.kind === 'continue'),
      weights = onHold
        ? [
            ['get', 5],
            ['continue', 12],
            ['cancel', 8],
            ['prepare', 4],
            ['execute', 3],
            ['recover', 3],
            ['archive', 4],
            ['direct', 5],
            ['approve', 2],
          ]
        : !alive
          ? [
              ['get', 3],
              ['continue', 8],
              ['direct', 10],
              ['archive', 5],
              ['prepare', 2],
              ['execute', 2],
              ['recover', 2],
              ['cancel', 1],
              ['approve', 1],
            ]
          : [
              ['get', 4],
              ['summary', 1],
              ['approve', this.policyOn ? 6 : 1],
              ['prepare', next?.status === 'pending' ? 18 : 4],
              ['execute', executable ? 26 : 1],
              ['recover', trouble ? 9 : 1],
              ['continue', inflightExecute ? 10 : 4],
              ['cancel', inflightExecute ? 10 : 3],
              ['archive', 1],
              ['direct', inflightExecute ? 8 : 6],
            ];
    const ready = alive && next?.status === 'review_ready',
      kind = r.weighted([
        ...weights.filter(([k]) => k !== 'direct' || this.pool.length),
        ['drift', ready ? 8 : 2],
        ['release', parked.length ? (inflightContinue || inflightExecute ? 10 : 18) : 0],
      ]),
      action = {k: kind, who: r.chance(0.6) ? 'O' : 'E', plan};
    if (kind === 'approve') action.who = this.policyOn && r.chance(0.85) ? 'A' : 'O';
    if (kind === 'get') action.full = r.chance(0.3);
    if (kind === 'continue' && onHold && r.chance(0.7))
      action.who = this.whoOf(target.superseded_by?.by) === 'O' ? 'E' : 'O';
    if (['prepare', 'continue', 'cancel', 'recover'].includes(kind))
      action.spec = this.specFor(kind, kind === 'continue' && !alive && !onHold ? 0.6 : 0.36);
    // A fault is attached to an execute only when there is a review to send, and a write fault names one of the writes the review makes.
    if (kind === 'execute')
      action.spec = executable ? this.specFor('execute', 0.5, review.group ? (review.parts?.length ?? 2) : 1) : {};
    if (kind === 'direct') action.spec = this.specFor('direct', 0.4);
    if (kind === 'execute') {
      action.stale = r.chance(0.08);
      action.pick = r.int(1000);
      const holder = next?.review_id,
        owner = typeof holder === 'string' ? snap.reviews.get(holder)?.user_id : undefined;
      if (owner && r.chance(0.8)) action.who = owner === 'editor2' ? 'E' : 'O';
    }
    if (kind === 'recover') {
      // The step that needs it: one that failed, or that went back to pending with a refusal.
      const troubled = target?.steps.findIndex(s => s.status === 'failed' || (s.status === 'pending' && s.error));
      action.step = troubled >= 0 && r.chance(0.85) ? troubled : r.int(8);
    }
    if (kind === 'archive') action.undo = r.chance(0.2);
    if (kind === 'direct') {
      action.which = r.weighted([
        ['plan', 6],
        ['gone', 4],
        ['current', 3],
        ['any', 2],
      ]);
      action.pick = r.int(1000);
    }
    if (kind === 'release') action.pick = r.int(1000);
    return action;
  }
  resolvePlan(ref) {
    if (!this.known.length) return undefined;
    if (ref === 'root') return this.known[0];
    if (ref === 'latest') return this.known.at(-1);
    // The newest plan that can still run, or the newest plan when none can.
    if (ref === 'live') return this.liveIds.at(-1) ?? this.known.at(-1);
    return this.known[ref % this.known.length];
  }
  describe(a, planId) {
    const spec = a.spec ?? {},
      bits = [];
    if (spec.park)
      bits.push('park ' + spec.park.at + (spec.park.nth ? '#' + spec.park.nth : '') + ' ' + spec.park.mode);
    if (spec.writeFault) bits.push('write ' + spec.writeFault.kind + '#' + spec.writeFault.nth);
    if (spec.lag) bits.push('lag ' + spec.lag);
    if (spec.cutSave) bits.push('cut save ' + spec.cutSave.variant + (spec.cutSave.n ?? ''));
    if (spec.create) bits.push('create ' + spec.create.when + ' ' + spec.create.mode);
    if (spec.racer) bits.push('racer ' + spec.racer.action);
    return (
      (a.k === 'drift' || a.k === 'release' ? '' : a.who + ' ') +
      a.k +
      (planId && !['direct', 'release', 'drift'].includes(a.k) ? ' ' + this.pn(planId) : '') +
      (a.stale ? ' (a stale review)' : '') +
      (bits.length ? ' [' + bits.join(', ') + ']' : '')
    );
  }

  // ---- the actions ----------------------------------------------------------------------------------------------------------------------------------------
  async approveFlow(who, id) {
    const preview = await this.svc('amcp_campaign', {action: 'approve', id}, who),
      next = preview.data?.next_call;
    if (!preview.success || !next?.arguments) return preview;
    return this.svc('amcp_campaign', {...next.arguments, ...(next.add_after_user_approval ?? {})}, who);
  }
  patchFor(step) {
    const action = String(step.arguments.action);
    if (action.includes('campaign_budget'))
      return [{path: '/payload/operations/0/create/amount_micros', value: String(51000000 + ++this.counter)}];
    if (action.includes('ad_group_criterion'))
      return [{path: '/payload/operations/0/create/keyword/text', value: this.tag + ' amended ' + ++this.counter}];
    return undefined;
  }
  reviewFor(a, snap, planId) {
    const current = [...snap.plans.values()].flatMap(p =>
        p.steps.map(s => s.review_id).filter(id => typeof id === 'string'),
      ),
      gone = [...this.gone.keys()],
      ofPlan = (snap.plans.get(planId)?.steps ?? []).flatMap(s =>
        [s.review_id, ...(s.previous_attempts ?? []).map(x => x.review_id)]
          .filter(id => typeof id === 'string')
          .flatMap(id => [id, ...(snap.reviews.get(id)?.parts ?? [])]),
      ),
      from =
        a.which === 'plan' && ofPlan.length
          ? ofPlan
          : a.which === 'gone' && gone.length
            ? gone
            : a.which === 'current' && current.length
              ? current
              : this.pool;
    return from.length ? from[a.pick % from.length] : 'none';
  }
  async perform(a) {
    const snap = this.snapshot();
    this.refresh(snap);
    if (a.k === 'drift') {
      const group = this.x.world.adGroups[AD_GROUP];
      group.status = group.status === 'PAUSED' ? 'ENABLED' : 'PAUSED';
      this.log('drift: the ad group is now ' + group.status);
      return;
    }
    if (a.k === 'release') {
      const parked = this.parkedCalls();
      if (!parked.length) return this.log('release -> nothing is parked');
      const call = parked[a.pick % parked.length];
      call.release();
      await this.until(() => call.settled || call.parked || call.crashed || call.blocked);
      await this.drain();
      return this.log('release #' + call.id + ' (' + call.who + ' ' + call.kind + ') -> ' + this.state(call));
    }
    const planId = this.resolvePlan(a.plan),
      plan = snap.plans.get(planId),
      spec = structuredClone(a.spec ?? {}),
      label = this.describe(a, planId);
    if (spec.lag !== undefined) spec.lag = {left: spec.lag};
    const run = (kind, fn, extra = {}) => this.launch(kind, a.who, spec, label, fn, {planId, ...extra}),
      svc = input => this.svc('amcp_campaign', input, a.who);
    let call;
    if (a.k === 'get')
      call = await run('get', () => svc({action: 'get', id: planId, ...(a.full ? {detail: 'full'} : {})}));
    else if (a.k === 'summary') call = await run('summary', () => svc({action: 'approval_summary', id: planId}));
    else if (a.k === 'approve') call = await run('approve', () => this.approveFlow(a.who, planId));
    else if (a.k === 'prepare') call = await run('prepare', () => svc({action: 'prepare_next', id: planId}));
    else if (a.k === 'execute') {
      const step = plan?.steps.find(s => !settled(s)),
        review = a.stale && this.pool.length ? this.pool[a.pick % this.pool.length] : (step?.review_id ?? 'none');
      call = await run(
        'execute',
        () =>
          svc({
            action: 'execute_next',
            id: planId,
            review_id: review,
            idempotency_key: review,
            confirmed: true,
            spend_change_confirmed: true,
          }),
        {stepId: step?.id, approvedAtStart: !!plan && approvedByAnother(plan), resumed: step?.status === 'executing'},
      );
    } else if (a.k === 'recover') {
      const step = plan?.steps[a.step % (plan?.steps.length ?? 1)],
        patch = step && this.patchFor(step);
      call = await run(
        'recover',
        () => svc({action: 'recover_step', id: planId, step_id: step?.id, confirmed: true, ...(patch ? {patch} : {})}),
        {stepId: step?.id},
      );
    } else if (a.k === 'continue')
      call = await run('continue', () => svc({action: 'continue_as_new', id: planId, confirmed: true}));
    else if (a.k === 'cancel') call = await run('cancel', () => svc({action: 'cancel', id: planId, confirmed: true}));
    else if (a.k === 'archive')
      call = await run('archive', () => svc({action: a.undo ? 'unarchive' : 'archive', id: planId, confirmed: true}));
    else if (a.k === 'direct') {
      const review = this.reviewFor(a, snap, planId);
      call = await run(
        'direct',
        () =>
          this.svc(
            'amcp_write',
            {
              action: 'execute',
              review_id: review,
              idempotency_key: review,
              confirmed: true,
              spend_change_confirmed: true,
            },
            a.who,
          ),
        {review},
      );
    } else throw new Error('unknown action ' + a.k);
    this.log(label + ' -> ' + this.state(call) + '   ' + this.planLine(this.snapshot()));
  }
  state(call) {
    return call.parked
      ? 'PARKED at ' + call.where
      : call.crashed
        ? 'CRASHED at ' + call.where
        : call.blocked && !call.settled
          ? 'BLOCKED on a lock'
          : outcome(call.result);
  }

  // ---- the end of a case ------------------------------------------------------------------------------------------------------------------------------------
  async finish() {
    for (let guard = 0; guard < 40; guard++) {
      const call = this.parkedCalls()[0];
      if (!call) break;
      call.release();
      await this.until(() => call.settled || call.parked || call.crashed || call.blocked);
      await this.drain();
      this.log('the end: release #' + call.id + ' (' + call.who + ' ' + call.kind + ') -> ' + this.state(call));
    }
    await this.drain();
    if (this.inflight()) throw new Error('calls are still in flight at the end: ' + this.stuck());
    this.checkpoint('after every call settled', true);
    await this.probeGone();
    this.checkpoint('after the direct executes of the retired reviews', true);
    await this.probeContinuations();
    this.checkpoint('after the runs of the continuations of bound plans', true);
    await this.recover();
    this.checkpoint('after the recovery', true);
  }
  /**
   * What the audit's script did (item 4 of the audit of 2026-11-25): a plan that continues a bound plan without its binding is prepared and its step executed by its owner alone.
   * A product that keeps the binding never makes such a plan; where one exists, nothing may be sent where the first plan's gates refuse or another person's approval is required.
   */
  async probeContinuations() {
    const snap = this.snapshot();
    for (const [id, plan] of snap.plans) {
      const parent = snap.plans.get(plan.supersedes?.id);
      if (!isLive(plan) || !parent || !['activation_of', 'catalog_retirement'].some(key => parent[key] && !plan[key]))
        continue;
      const at = this.known.indexOf(id);
      this.log('probe: the owner runs ' + this.pn(id) + ', a continuation that lost what bound its plan');
      await this.perform({k: 'prepare', who: 'O', plan: at});
      await this.perform({k: 'execute', who: 'O', plan: at, spec: {}, pick: 0});
      this.checkpoint('after a run of a continuation');
    }
  }
  /** A direct execute of every review a plan went on from, by both people: refused, with nothing claimed and nothing sent. */
  async probeGone() {
    const ids = [...this.gone.keys()];
    for (const id of ids)
      for (const who of ['O', 'E']) {
        const claims = () => this.x.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n,
          before = {claims: claims(), writes: this.x.writes()},
          call = await this.launch(
            'probe',
            who,
            {},
            'probe',
            () =>
              this.svc(
                'amcp_write',
                {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, spend_change_confirmed: true},
                who,
              ),
            {review: id},
          );
        this.log('probe: ' + who + ' executes ' + this.rn(id) + ' directly -> ' + this.state(call));
        if (call.result?.success || claims() !== before.claims || this.x.writes() !== before.writes)
          this.violate(
            '4',
            who +
              ' executed ' +
              this.rn(id) +
              ' directly, which ' +
              this.pn(this.gone.get(id).plan) +
              ' went on from (' +
              this.gone.get(id).reason +
              '): ' +
              this.state(call),
          );
        this.checkpoint('after a probe');
      }
  }
  /**
   * Invariant 7. After a crash a step may be left executing and a plan held for a continuation. What an AI reads then (the plan's get, compact and full, the review's
   * status, and the refusal its next call gets) must name a call, and following the calls those reads name, at most three times over, must leave no step executing
   * and send nothing twice. The crashed calls' locks lapsed (+3 min); a claim that is still pending is aged until it reads uncertain (+8 min) and given three hops more.
   */
  async recover() {
    const stuck = () => {
      const snap = this.snapshot(),
        out = [];
      for (const [plan, doc] of snap.plans) {
        if (held(doc)) out.push({held: true, plan});
        for (const step of doc.steps) if (step.status === 'executing') out.push({plan, step: step.id});
      }
      return out;
    };
    if (!stuck().length) return;
    this.recovered = stuck().some(item => !item.held);
    this.skew += 3 * 60000;
    this.log('recovery: the crashed calls’ locks lapse (+3 min)');
    for (const item of stuck())
      await (item.held ? this.recoverHold(item.plan) : this.recoverStep(item.plan, item.step));
  }
  whoOf = userId => (userId === 'editor2' ? 'E' : userId === 'approver' ? 'A' : 'O');
  /** The call a read names: its next_call, or the next_call of the refusal it carries. */
  named(result) {
    const next = result?.data?.next_call ?? result?.error?.details?.next_call;
    return next?.tool && next.arguments ? next : undefined;
  }
  async read(label, who, tool, input) {
    const call = await this.launch('read', who, {}, label, () => this.svc(tool, input, who));
    this.log('recovery: ' + who + ' ' + label + ' -> ' + this.state(call));
    this.judgeNamed(this.named(call.result), label);
    return call.result;
  }
  /**
   * What a read names is judged as well as followed (r25-planmodel, F4): a call that prepares a standalone replacement (supersedes_review_id) of the review of a step left
   * executing makes a review no step holds, and its execute makes the change outside the plan, so the plan's step stays executing and the change is made beside the plan's
   * approvals. The reads of such a review lead back to the plan, which resumes the step. (A step that is uncertain is replaced as it always was, R2.5 M2, journey J14.)
   */
  judgeNamed(next, source, snap = this.snapshot()) {
    const id = next?.arguments?.supersedes_review_id;
    if (next?.tool !== 'amcp_write' || next.arguments.action !== 'prepare' || typeof id !== 'string') return;
    const holder = this.holders(snap, id).find(h => h.role === 'held' && h.step.status === 'executing');
    if (holder)
      this.violate(
        '7c',
        source +
          ' names a standalone replacement of ' +
          this.rn(id) +
          ' (a prepare with supersedes_review_id), which ' +
          this.pn(holder.plan) +
          ' step ' +
          holder.step.id +
          ' holds',
      );
  }
  /** Follows a named call as the person it is for, adding what the user approves with it. */
  async follow(next, who) {
    const input = {...next.arguments, ...(next.add_after_user_approval ?? {})},
      call = await this.launch(
        'follow',
        who,
        {},
        next.tool + ' ' + input.action,
        () => this.svc(next.tool, input, who),
        {
          planId: input.id,
        },
      );
    this.log(
      'recovery: ' +
        who +
        ' follows ' +
        next.tool +
        ' ' +
        JSON.stringify(input).slice(0, 110) +
        ' -> ' +
        this.state(call),
    );
    this.judgeNamed(this.named(call.result), next.tool + ' ' + input.action);
    return call.result;
  }
  async recoverStep(pid, sid) {
    const look = () => {
        const snap = this.snapshot(),
          step = snap.plans.get(pid).steps.find(s => s.id === sid),
          id = step.review_id,
          claim =
            snap.claims.get(id) ??
            ((snap.reviews.get(id)?.parts ?? []).some(p => snap.claims.has(p)) ? 'parts' : 'none');
        return {step, claim, holder: this.whoOf(snap.reviews.get(id)?.user_id)};
      },
      start = look(),
      letter = start.claim === 'none' ? 'a' : start.claim === 'complete' ? 'b' : 'c',
      where = this.pn(pid) + ' step ' + sid + ' (claim ' + start.claim + ')';
    for (const phase of start.claim === 'pending' || start.claim === 'uncertain' || start.claim === 'parts'
      ? [0, 1]
      : [0]) {
      if (phase === 1) {
        this.skew += 8 * 60000;
        this.log('recovery: the claim ages (+8 min)');
      }
      for (let hop = 1; hop <= 3; hop++) {
        const now = look();
        if (now.step.status !== 'executing') return;
        const reads = [],
          calls = new Map();
        if (this.via === 'get') {
          reads.push(await this.read('get ' + this.pn(pid), 'O', 'amcp_campaign', {action: 'get', id: pid}));
          reads.push(
            await this.read('get full ' + this.pn(pid), 'O', 'amcp_campaign', {action: 'get', id: pid, detail: 'full'}),
          );
        }
        reads.push(
          await this.read('status of ' + this.rn(now.step.review_id), now.holder, 'amcp_write', {
            action: 'status',
            review_id: now.step.review_id,
          }),
        );
        for (const result of reads) {
          const next = this.named(result);
          if (next) calls.set(JSON.stringify(next), next);
        }
        if (!calls.size) {
          this.violate(
            '7' + letter,
            where +
              ' is left executing and no read names a call: ' +
              (this.via === 'get' ? 'the plan’s get, its full get and the review’s status' : 'the review’s status') +
              ' have no next_call',
          );
          return;
        }
        for (const next of calls.values()) await this.follow(next, next.arguments.review_id ? now.holder : 'O');
      }
    }
    const end = look();
    if (end.step.status === 'executing')
      this.violate(
        '7' + letter,
        where + ' is still executing after the calls the reads named were followed three times',
      );
  }
  async recoverHold(pid) {
    const look = () => {
        const snap = this.snapshot(),
          plan = snap.plans.get(pid);
        return {plan, hold: plan.superseded_by, made: snap.plans.has(plan.superseded_by?.to)};
      },
      where =
        this.pn(pid) +
        ' held for ' +
        look().hold?.by +
        '’s continuation (' +
        (look().made ? 'the new plan exists' : 'the new plan does not exist') +
        ')';
    for (let hop = 1; hop <= 3; hop++) {
      const now = look();
      if (!held(now.plan)) return;
      const reads = [];
      for (const who of ['O', 'E']) {
        reads.push(await this.read('get ' + this.pn(pid), who, 'amcp_campaign', {action: 'get', id: pid}));
        reads.push(
          await this.read('prepare_next ' + this.pn(pid), who, 'amcp_campaign', {action: 'prepare_next', id: pid}),
        );
      }
      reads.push(
        await this.read('get full ' + this.pn(pid), 'O', 'amcp_campaign', {action: 'get', id: pid, detail: 'full'}),
      );
      const calls = new Map();
      for (const result of reads) {
        const next = this.named(result);
        if (next) calls.set(JSON.stringify(next), next);
      }
      if (!calls.size) {
        this.violate(
          '7d',
          where + ': no read names a call (get, get full and the refusals of prepare_next have no next_call)',
        );
        return;
      }
      for (const next of calls.values())
        await this.follow(next, next.arguments.action === 'continue_as_new' ? this.whoOf(now.hold?.by) : 'O');
    }
    const end = look();
    if (held(end.plan) && !end.made)
      this.violate(
        '7d',
        where + ': still held with no new plan after the calls the reads named were followed three times',
      );
  }
}

export async function runModelCase(options) {
  const model = new PlanModel(options.seed, options),
    result = {seed: options.seed, ok: true},
    wait = process.env.AMCP_WRITE_TARGET_WAIT_MS;
  // No call times out of a lock wait inside a case: the model releases what it holds, so a waiter is never left to the product's own deadline.
  process.env.AMCP_WRITE_TARGET_WAIT_MS = '60000';
  try {
    await model.setup();
    model.checkpoint('after the setup');
    const count = model.replay ? model.replay.length : 6 + model.rng.int(15);
    for (let i = 0; i < count; i++) {
      const action = model.replay ? model.replay[i] : model.nextAction();
      model.actions.push(action);
      await model.perform(action);
      model.checkpoint('after action ' + (i + 1), true);
    }
    await model.finish();
  } catch (error) {
    result.ok = false;
    result.error = error;
  } finally {
    if (wait === undefined) delete process.env.AMCP_WRITE_TARGET_WAIT_MS;
    else process.env.AMCP_WRITE_TARGET_WAIT_MS = wait;
    for (const call of model.parkedCalls()) call.release();
    await Promise.race([model.drain().catch(() => {}), tick(300)]);
    model.restore?.();
    model.x?.store.close();
  }
  result.trace = model.trace;
  result.actions = model.actions;
  // A case that left a step executing is recovered again, from the same actions, by an AI that reads only the review's status (r25-planmodel, F4): the plan's own read names
  // the way first for the AI that reads the plan, and would hide a status that leads nowhere or somewhere else.
  if (result.ok && model.recovered && !options.via) {
    const again = await runModelCase({
      seed: options.seed,
      actions: model.actions,
      via: 'status',
      flavors: options.flavors,
    });
    if (!again.ok) return {...again, via: 'status'};
  }
  return result;
}
