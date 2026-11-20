import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {ownsRecord, principalOf} from './actor-identity.js';
import {MirrorError} from './errors.js';
import {cursorBinding} from './page-cursor.js';
import {bad, optional} from './workspace-core.js';
import {clientView} from './client-scope.js';
import {archivedPlansBefore} from './retention-repository.js';
import {
  activeMembers,
  planCount,
  planRows,
  plansHoldingReview,
  planStateCounts,
  planTotals,
  unarchivedPlanCount,
  type PlanFilters,
  type PlanReader,
} from './campaign-repository.js';
export type {PlanFilters} from './campaign-repository.js';

/**
 * Campaign plan inventory and team handoff (CMP-05).
 *
 * - The workspace bound counts plans that are not archived; a plan nothing remains to run in (complete, cancelled or
 *   superseded) can be archived, which leaves it readable by get and out of the default list and the bound.
 * - Lists are an SQL projection of the plan documents, newest first, with a cursor bound to the caller and filters,
 *   and one account and platform summary per plan instead of the plan itself.
 * - A plan's owner (or an administrator) can name collaborators from the workspace's members: a viewer may read it, an
 *   editor may also prepare, run steps one by one, amend and archive it, and an approver may approve and run it. A
 *   collaborator sees a plan only while every account it names is within their current access, and every review and
 *   execution still checks the acting person's own account grant.
 */
export const activePlanLimit = 500;
export const planStates = [
  'draft',
  'awaiting_review',
  'in_progress',
  'attention',
  'complete',
  'cancelled',
  'superseded',
];
/** Nothing remains to run in a plan in these states, so it can be archived. */
export const archivableStates = ['complete', 'cancelled', 'superseded'];
/** Plan states a person needs to act on, for Home's attention items. */
export const attentionPlanStates = ['attention', 'awaiting_review'];
export const collaboratorRoles = ['editor', 'approver', 'viewer'];
export type PlanRight = 'view' | 'edit' | 'approve' | 'manage';
const rights: Record<string, PlanRight[]> = {
  viewer: ['view'],
  editor: ['view', 'edit'],
  approver: ['view', 'approve'],
};

/** The collaborator entry naming this actor's person on a plan, if any. */
export function collaboratorOf(run: JsonObject, actor: Actor): JsonObject | undefined {
  const person = principalOf(actor);
  return (Array.isArray(run.collaborators) ? run.collaborators : []).find((c: JsonObject) => c && c.user_id === person);
}
/** The gateway, connection and account of every step of a plan, without repeats. */
export function planScopes(steps: unknown): JsonObject[] {
  const seen = new Map<string, JsonObject>();
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    const gateway =
      s.kind === 'media' && typeof s.arguments?.platform === 'string'
        ? s.arguments.platform + '_native_action'
        : s.gateway;
    const scope = {gateway: gateway ?? null, connection_id: s.connection_id ?? null, account_id: s.account_id ?? null};
    seen.set(JSON.stringify(scope), scope);
  }
  return [...seen.values()];
}
/** Whether every account a plan names is within the actor's current access (connections of this workspace). */
function withinAccess(store: Store, actor: Actor, scopes: JsonObject[]): boolean {
  if (!scopes.length || scopes.length > 50) return false;
  try {
    for (const s of scopes) {
      if (typeof s.gateway !== 'string' || typeof s.account_id !== 'string' || !s.account_id) return false;
      store.resolveConnection(actor, s.gateway, s.account_id, s.connection_id ?? undefined);
    }
    return true;
  } catch (e) {
    if (e instanceof MirrorError) return false;
    throw e;
  }
}
/** An own plan as access limited to a client access set sees it (SEC-08): one naming no account yet, or within the set. */
function scopedOwnPlan(store: Store, actor: Actor, scopes: JsonObject[]): boolean {
  return !scopes.some(s => s.account_id) || withinAccess(store, actor, scopes);
}
/**
 * Whether the actor may act on a plan with this right. Its owner and administrators may do anything their role allows;
 * `manage` (naming collaborators) is theirs alone. A collaborator acts by role, within current account access.
 */
export function planRight(store: Store, actor: Actor, run: JsonObject, right: PlanRight): boolean {
  // Access limited to a client access set (SEC-08) reaches even its person's own plans only within the set.
  if (actor.accessSetId !== undefined && ownsRecord(actor, run))
    return scopedOwnPlan(store, actor, planScopes(run.steps));
  if (ownsRecord(actor, run) || actor.role === 'admin') return true;
  if (right === 'manage') return false;
  const c = collaboratorOf(run, actor);
  if (!c || !rights[c.role]?.includes(right)) return false;
  return withinAccess(store, actor, planScopes(run.steps));
}
/**
 * The plan the actor may read that holds a step prepared as this review, with that step's id (R2.5 M3, dupstep): the plan a refusal that names
 * an earlier review points at, so the person opens it and reads the step back instead of hunting for it. Found from the store, with no
 * provider call. The same right as `get` decides (`view`): a plan the actor cannot read (a colleague's, or one whose access ended) is never
 * named, and where no plan holds the review (a standalone write) there is nothing to name.
 */
export function planHoldingReview(
  store: Store,
  actor: Actor,
  reviewId: string,
): {plan_id: string; step_id: string} | undefined {
  for (const held of plansHoldingReview(store, actor.tenantId, reviewId)) {
    const plan = optional(store, actor.tenantId, 'campaign_run', held.id);
    if (plan && planRight(store, actor, plan, 'view')) return {plan_id: held.id, step_id: held.step_id};
  }
  return undefined;
}
/** How the actor relates to a plan, for list rows: owner, admin or the collaborator role. */
function relation(actor: Actor, row: JsonObject, collaborators: JsonObject[]): string {
  if (ownsRecord(actor, row)) return 'owner';
  const person = principalOf(actor),
    c = collaborators.find(x => x?.user_id === person);
  return c ? String(c.role) : 'admin';
}

/** Who reads plan lists: the plan SQL limits a person who is not an administrator to their own and shared plans. */
const reader = (actor: Actor): PlanReader => ({
  admin: actor.role === 'admin',
  person: principalOf(actor),
  userId: actor.userId,
});
/** As the plan SQL compares accounts: without act_ and dashes. */
const plainKey = (gateway: string, account: string) =>
  gateway + '\u0000' + account.replaceAll('act_', '').replaceAll('-', '');
/** The accounts of a client profile within current access, or none when the profile no longer exists. */
function clientAccounts(store: Store, actor: Actor, profileId: string): string[] {
  try {
    return clientView(store, actor, profileId).accounts.map(a => plainKey(a.gateway, a.account_id));
  } catch (e) {
    // A removed profile still finds the plans recorded with it.
    if (e instanceof MirrorError && e.code === 'PROFILE_NOT_FOUND') return [];
    throw e;
  }
}
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * One compact row per plan: what a list shows and a person needs to find it (name, state, time, accounts and
 * platforms), never its arguments, receipts or errors.
 */
function row(actor: Actor, r: JsonObject, scopes: JsonObject[]): JsonObject {
  const collaborators = parse(r.collaborators) ?? [],
    archived = parse(r.archived);
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    updated_at: r.at || null,
    created_at: r.created_at ?? null,
    step_count: r.step_count ?? 0,
    platforms: [...new Set(scopes.map(s => String(s.gateway ?? '').replace(/_native_action$/, '')).filter(Boolean))],
    accounts: scopes.slice(0, 10).map(s => ({gateway: s.gateway, account_id: s.account_id})),
    ...(scopes.length > 10 ? {accounts_truncated: true} : {}),
    ...(r.profile_id ? {profile_id: r.profile_id} : {}),
    ...(r.recipe_id ? {recipe_id: r.recipe_id} : {}),
    approved: r.approved === 1,
    access: relation(actor, r, collaborators),
    collaborators: Array.isArray(collaborators) ? collaborators.length : 0,
    ...(archived ? {archived: true, archived_at: archived.at ?? null} : {}),
  };
}
type Scan = {rows: JsonObject[]; withheld: number; last?: JsonObject; more: boolean; scanned: number};
/**
 * Visible plans in order, newest first. Owner and administrator rows come from SQL alone; a collaborator's row is
 * kept only within current account access (withheld counts the others). Scans at most `scan` rows.
 */
function scanPlans(
  store: Store,
  actor: Actor,
  filters: PlanFilters,
  options: {limit: number; after?: {at: number; id: string}; offset?: number; steps?: boolean; scan?: number},
): Scan {
  const scan = options.scan ?? Math.max(200, options.limit * 4);
  const rows = planRows(store, actor.tenantId, reader(actor), filters, {
    ...(options.after ? {after: options.after} : {}),
    steps: options.steps === true,
    scan,
    offset: options.offset ?? 0,
  });
  const out: JsonObject[] = [];
  let withheld = 0,
    last: JsonObject | undefined,
    more = false,
    scanned = 0;
  for (const [index, r] of rows.entries()) {
    if (index === scan) {
      more = true;
      break;
    }
    const scopes = planScopes(parse(r.scopes));
    // A client access set (SEC-08) shows its person's own plans too only within the set.
    const own =
      actor.accessSetId === undefined
        ? actor.role === 'admin' || ownsRecord(actor, r)
        : ownsRecord(actor, r) && scopedOwnPlan(store, actor, scopes);
    const visible = own || withinAccess(store, actor, scopes);
    if (visible && out.length === options.limit) {
      more = true;
      break;
    }
    scanned++;
    last = r;
    if (!visible) {
      withheld++;
      continue;
    }
    out.push({...row(actor, r, scopes), ...(options.steps ? {steps: parse(r.steps) ?? []} : {})});
  }
  return {rows: out, withheld, last, more, scanned};
}
/** How many visible plans match the filters, counted in SQL (collaborators' access is checked per page). */
function countPlans(store: Store, actor: Actor, filters: PlanFilters): number {
  return planCount(store, actor.tenantId, reader(actor), filters);
}

const text = (v: unknown, field: string, max = 200) => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    bad('Use a non-empty list filter of at most 200 characters.', 'INVALID_ARGUMENT', {field, max});
  return v.trim();
};
/**
 * `amcp_campaign list` (CMP-05): newest first, filtered by state, archive, gateway, account, connection, client profile,
 * a search over name, ID and account, or the plans awaiting the caller's approval. next_cursor continues the same
 * filters for the same caller; offset is still accepted.
 */
export function listPlans(store: Store, actor: Actor, input: JsonObject): JsonObject {
  store.assertActorActive(actor);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    bad('limit is a whole number of plans from 1 to 100.', 'INVALID_ARGUMENT', {field: 'limit'});
  if (input.state !== undefined && !planStates.includes(input.state))
    bad('state is one of the plan states in details.allowed.', 'INVALID_ARGUMENT', {
      field: 'state',
      allowed: planStates,
    });
  for (const key of ['archived', 'awaiting_approval'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      bad('archived and awaiting_approval are true or false.', 'INVALID_ARGUMENT', {field: key});
  const filters: PlanFilters = {
    ...(input.state ? {state: input.state} : {}),
    ...(input.archived === true ? {archived: true} : {}),
    ...(input.awaiting_approval === true ? {awaiting_approval: true} : {}),
  };
  for (const key of ['gateway', 'account_id', 'connection_id', 'profile_id', 'search'] as const) {
    const value = text(input[key], key);
    if (value !== undefined) filters[key] = value;
  }
  const binding = cursorBinding(store, actor, {action: 'campaign_list', limit, ...filters});
  const query: PlanFilters = filters.profile_id
    ? {...filters, client_accounts: clientAccounts(store, actor, filters.profile_id)}
    : filters;
  let after: {at: number; id: string} | undefined;
  if (input.cursor !== undefined) {
    if (input.offset !== undefined)
      bad('Continue with next_cursor or with offset, not both.', 'INVALID_ARGUMENT', {field: 'offset'});
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
        throw Error();
      const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (
        c?.version !== 1 ||
        c.binding !== binding ||
        !Number.isSafeInteger(c.at) ||
        c.at < 0 ||
        typeof c.id !== 'string' ||
        c.id.length > 160
      )
        throw Error();
      after = {at: c.at, id: c.id};
    } catch {
      bad(
        'Use the next_cursor this list returned, with the same identity, filters and page size, or start again without a cursor.',
        'INVALID_CURSOR',
        {field: 'cursor'},
      );
    }
  }
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    bad('offset is a whole number of plans to skip.', 'INVALID_ARGUMENT', {field: 'offset'});
  const page = scanPlans(store, actor, query, {limit, ...(after ? {after} : {}), offset});
  const next =
    page.more && page.last
      ? Buffer.from(JSON.stringify({version: 1, binding, at: page.last.at, id: page.last.id})).toString('base64url')
      : null;
  return {
    campaigns: page.rows,
    total: countPlans(store, actor, query),
    has_more: page.more,
    next_cursor: next,
    ...(page.more && input.cursor === undefined ? {next_offset: offset + page.scanned} : {}),
    ...(page.withheld ? {withheld: page.withheld} : {}),
    ...(Object.keys(filters).length ? {filters} : {}),
    ...(next
      ? {
          next_call: {
            tool: 'amcp_campaign',
            arguments: {action: 'list', ...filters, ...(input.limit !== undefined ? {limit} : {}), cursor: next},
          },
        }
      : {}),
  };
}

/** Counts of the actor's visible plans in SQL: those not archived by state, and the archived ones. */
export function planCounts(store: Store, actor: Actor): JsonObject {
  const rows = planStateCounts(store, actor.tenantId, reader(actor));
  const by_state: Record<string, number> = {};
  let total = 0,
    archived = 0;
  for (const r of rows) {
    if (r.archived) archived += Number(r.n);
    else {
      total += Number(r.n);
      by_state[String(r.state)] = (by_state[String(r.state)] ?? 0) + Number(r.n);
    }
  }
  return {total, by_state, archived};
}
/** The newest visible plans that are not archived, with each step's status (Home and dashboard sections). */
export function recentPlans(store: Store, actor: Actor, limit: number, filters: PlanFilters = {}): JsonObject[] {
  return scanPlans(store, actor, filters, {limit, steps: true}).rows;
}
/** Every visible plan that is not archived, newest first, with each step's status: a projection, not documents. */
export function visiblePlans(store: Store, actor: Actor): JsonObject[] {
  return scanPlans(store, actor, {}, {limit: 100000, steps: true, scan: 100000}).rows;
}

/** The plans counted against the workspace bound: every plan that is not archived, of every person. */
export function activePlanCount(store: Store, tenant: string): number {
  return unarchivedPlanCount(store, tenant);
}
/**
 * The workspace's plans against the bound, for the owner's health (CMP-05 baseline: how close the workspace is to the
 * limit). Counts every person's plans; names nothing.
 */
export function planInventory(store: Store, tenant: string): JsonObject {
  const row = planTotals(store, tenant);
  const total = Number(row.total ?? 0),
    archived = Number(row.archived ?? 0);
  return {active: total - archived, archived, limit: activePlanLimit};
}
/** Refuses a new or unarchived plan once the workspace holds the bound of plans that are not archived. */
export function assertPlanRoom(store: Store, actor: Actor): void {
  const active = activePlanCount(store, actor.tenantId);
  if (active < activePlanLimit) return;
  bad(
    'Limit reached: 500 campaign plans that are not archived. Archive complete, cancelled or superseded plans to make room; archived plans stay readable.',
    'PLAN_LIMIT_REACHED',
    {
      limit: activePlanLimit,
      active,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'list', state: 'complete'}},
    },
  );
}

/**
 * Deletes the plan documents archived before the cutoff (owner retention, opt-in). Audit records, write receipts,
 * reviews and their journals are separate records and stay. Returns how many plans were removed.
 */
export function purgeArchivedPlans(store: Store, tenant: string, cutoff: number): number {
  const removed = store.transaction(() => {
    const ids = archivedPlansBefore(store, tenant, cutoff),
      plans = store.repo('campaign_run', tenant);
    for (const id of ids) plans.delete(id);
    return ids;
  });
  if (removed.length)
    store.appendAudit(tenant, 'campaign_run/retention', {
      event: 'campaign_plans_purged',
      count: removed.length,
      archived_before: cutoff,
      ids: removed.slice(0, 100),
    });
  return removed.length;
}

/**
 * The collaborators of a plan a person creates from another person's plan (a continuation or an activation): the
 * source's collaborators, and its owner as an editor, so the team keeps the linked plan in view.
 */
export function linkedTeam(actor: Actor, source: JsonObject): JsonObject[] | undefined {
  const person = principalOf(actor),
    owner = typeof source.principal === 'string' && source.principal ? source.principal : source.user_id,
    team = (Array.isArray(source.collaborators) ? source.collaborators : []).filter(
      (c: JsonObject) => c && c.user_id !== person,
    );
  if (typeof owner === 'string' && !ownsRecord(actor, source) && !team.some((c: JsonObject) => c.user_id === owner))
    team.push({user_id: owner, role: 'editor', by: actor.userId, at: Date.now(), inherited_from: source.id});
  return team.length ? team.slice(0, 20) : undefined;
}

const planPolicyId = 'workspace';
/** The owner's campaign plan policy (CMP-05). Off by default: one person may approve their own plans. */
export function planPolicy(store: Store, tenant: string): JsonObject {
  return store.repo('plan_policy', tenant).payload(planPolicyId) ?? {require_distinct_approver: false};
}
/** Saves the plan policy (owner operations save_plan_policy, already owner-checked), audited. */
export function savePlanPolicy(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (input.confirmed !== true || typeof input.require_distinct_approver !== 'boolean')
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Confirm the campaign plan policy with require_distinct_approver true or false and confirmed: true.',
      {field: 'require_distinct_approver'},
    );
  const data = {
    require_distinct_approver: input.require_distinct_approver,
    updated_at: Date.now(),
    updated_by: actor.userId,
  };
  store.putDocument(actor.tenantId, 'plan_policy', planPolicyId, data);
  store.appendAudit(actor.tenantId, 'plan_policy/' + planPolicyId, {
    event: 'plan_policy_saved',
    require_distinct_approver: data.require_distinct_approver,
    by: actor.userId,
  });
  return {
    ...data,
    effect: data.require_distinct_approver
      ? 'A plan that changes budgets, bids or activation must be approved by someone other than its owner: the owner assigns an approver.'
      : 'Any person who may approve a plan, its owner included, may approve it.',
  };
}

/** Members of the workspace a plan can be shared with: active members, by account ID, name and workspace role. */
export function assignableMembers(store: Store, tenant: string): JsonObject[] {
  return activeMembers(store, tenant);
}
