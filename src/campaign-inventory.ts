import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {doorPrincipal, ownsRecord, principalOf} from './actor-identity.js';
import {MirrorError} from './errors.js';
import {cursorBinding} from './page-cursor.js';
import {bad} from './workspace-core.js';

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
/**
 * Whether the actor may act on a plan with this right. Its owner and administrators may do anything their role allows;
 * `manage` (naming collaborators) is theirs alone. A collaborator acts by role, within current account access.
 */
export function planRight(store: Store, actor: Actor, run: JsonObject, right: PlanRight): boolean {
  if (ownsRecord(actor, run) || actor.role === 'admin') return true;
  if (right === 'manage') return false;
  const c = collaboratorOf(run, actor);
  if (!c || !rights[c.role]?.includes(right)) return false;
  return withinAccess(store, actor, planScopes(run.steps));
}
/** How the actor relates to a plan, for list rows: owner, admin or the collaborator role. */
function relation(actor: Actor, row: JsonObject, collaborators: JsonObject[]): string {
  if (ownsRecord(actor, row)) return 'owner';
  const person = principalOf(actor),
    c = collaborators.find(x => x?.user_id === person);
  return c ? String(c.role) : 'admin';
}

/** The SQL that limits plan documents to those the actor owns or collaborates on (everything for administrators). */
type Param = string | number | null;
function visibility(actor: Actor): {sql: string; params: Param[]} {
  if (actor.role === 'admin') return {sql: '1', params: []};
  const person = principalOf(actor);
  return {
    sql: `(json_extract(d.data,'$.principal')=?
      OR (coalesce(json_extract(d.data,'$.principal'),'')='' AND (json_extract(d.data,'$.user_id') IN (?,?)
        OR (?=? AND json_extract(d.data,'$.user_id') IN ('workspace-admin','workspace-test'))))
      OR EXISTS (SELECT 1 FROM json_each(d.data,'$.collaborators') c WHERE json_extract(c.value,'$.user_id')=?))`,
    params: [person, actor.userId, person, person, doorPrincipal, person],
  };
}
const updatedAt = "coalesce(json_extract(d.data,'$.updated_at'),0)";
const stepGateway =
  "CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action' ELSE json_extract(s.value,'$.gateway') END";
const plainAccount = (sql: string) => `replace(replace(${sql},'act_',''),'-','')`;

export type PlanFilters = {
  state?: string;
  archived?: boolean;
  gateway?: string;
  account_id?: string;
  connection_id?: string;
  profile_id?: string;
  search?: string;
  awaiting_approval?: boolean;
};
function filterSQL(actor: Actor, f: PlanFilters): {sql: string[]; params: Param[]} {
  const sql: string[] = [],
    params: Param[] = [];
  sql.push(f.archived ? "json_extract(d.data,'$.archived') IS NOT NULL" : "json_extract(d.data,'$.archived') IS NULL");
  if (f.state) {
    sql.push("json_extract(d.data,'$.state')=?");
    params.push(f.state);
  }
  if (f.profile_id) {
    sql.push("json_extract(d.data,'$.profile_id')=?");
    params.push(f.profile_id);
  }
  if (f.gateway || f.account_id || f.connection_id) {
    sql.push(`EXISTS (SELECT 1 FROM json_each(d.data,'$.steps') s WHERE (? IS NULL OR ${stepGateway}=?)
      AND (? IS NULL OR ${plainAccount("json_extract(s.value,'$.account_id')")}=${plainAccount('?')})
      AND (? IS NULL OR json_extract(s.value,'$.connection_id')=?))`);
    params.push(
      f.gateway ?? null,
      f.gateway ?? null,
      f.account_id ?? null,
      f.account_id ?? null,
      f.connection_id ?? null,
      f.connection_id ?? null,
    );
  }
  if (f.search) {
    const term = f.search.toLowerCase();
    sql.push(`(instr(lower(coalesce(json_extract(d.data,'$.name'),'')),?)>0 OR lower(d.id)=?
      OR EXISTS (SELECT 1 FROM json_each(d.data,'$.steps') s WHERE instr(lower(coalesce(json_extract(s.value,'$.account_id'),'')),?)>0))`);
    params.push(term, term, term);
  }
  if (f.awaiting_approval) {
    // Plans naming this person as approver that still wait for an approval of their current plan_hash.
    sql.push(`EXISTS (SELECT 1 FROM json_each(d.data,'$.collaborators') c WHERE json_extract(c.value,'$.user_id')=?
        AND json_extract(c.value,'$.role')='approver')
      AND json_extract(d.data,'$.state') NOT IN ('complete','cancelled','superseded')
      AND coalesce(json_extract(d.data,'$.approval.plan_hash'),'')<>json_extract(d.data,'$.plan_hash')`);
    params.push(principalOf(actor));
  }
  return {sql, params};
}
const projection = (steps: boolean) => `SELECT d.id, d.revision,
  json_extract(d.data,'$.name') AS name, json_extract(d.data,'$.state') AS state, ${updatedAt} AS at,
  json_extract(d.data,'$.created_at') AS created_at, json_array_length(d.data,'$.steps') AS step_count,
  json_extract(d.data,'$.archived') AS archived, json_extract(d.data,'$.profile_id') AS profile_id,
  json_extract(d.data,'$.recipe.id') AS recipe_id, json_extract(d.data,'$.user_id') AS user_id,
  json_extract(d.data,'$.principal') AS principal, json_extract(d.data,'$.collaborators') AS collaborators,
  CASE WHEN json_extract(d.data,'$.approval.plan_hash')=json_extract(d.data,'$.plan_hash') THEN 1 ELSE 0 END AS approved,
  (SELECT json_group_array(json_object('kind',json_extract(s.value,'$.kind'),'gateway',json_extract(s.value,'$.gateway'),
    'arguments',json_object('platform',json_extract(s.value,'$.arguments.platform')),
    'connection_id',json_extract(s.value,'$.connection_id'),'account_id',json_extract(s.value,'$.account_id')))
    FROM json_each(d.data,'$.steps') s) AS scopes
  ${
    steps
      ? `, (SELECT json_group_array(json_object('id',json_extract(s.value,'$.id'),'status',json_extract(s.value,'$.status'),
    'error',json_extract(s.value,'$.error'))) FROM json_each(d.data,'$.steps') s) AS steps`
      : ''
  }
  FROM documents d`;
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
  const v = visibility(actor),
    f = filterSQL(actor, filters),
    where = ['d.tenant_id=?', "d.kind='campaign_run'", v.sql, ...f.sql],
    params: Param[] = [actor.tenantId, ...v.params, ...f.params];
  if (options.after) {
    where.push(`(${updatedAt}<? OR (${updatedAt}=? AND d.id>?))`);
    params.push(options.after.at, options.after.at, options.after.id);
  }
  const scan = options.scan ?? Math.max(200, options.limit * 4);
  const rows = store.db
    .prepare(
      `${projection(options.steps === true)} WHERE ${where.join(' AND ')} ORDER BY at DESC, d.id LIMIT ? OFFSET ?`,
    )
    .all(...params, scan + 1, options.offset ?? 0) as JsonObject[];
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
    const own = actor.role === 'admin' || ownsRecord(actor, r);
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
  const v = visibility(actor),
    f = filterSQL(actor, filters);
  return Number(
    (
      store.db
        .prepare(
          `SELECT count(*) AS n FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND ${[v.sql, ...f.sql].join(' AND ')}`,
        )
        .get(actor.tenantId, ...v.params, ...f.params) as JsonObject
    ).n,
  );
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
  const page = scanPlans(store, actor, filters, {limit, ...(after ? {after} : {}), offset});
  const next =
    page.more && page.last
      ? Buffer.from(JSON.stringify({version: 1, binding, at: page.last.at, id: page.last.id})).toString('base64url')
      : null;
  return {
    campaigns: page.rows,
    total: countPlans(store, actor, filters),
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
  const v = visibility(actor);
  const rows = store.db
    .prepare(
      `SELECT json_extract(d.data,'$.state') AS state, json_extract(d.data,'$.archived') IS NOT NULL AS archived,
        count(*) AS n FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND ${v.sql} GROUP BY 1,2`,
    )
    .all(actor.tenantId, ...v.params) as JsonObject[];
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
  return Number(
    (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='campaign_run' AND json_extract(data,'$.archived') IS NULL",
        )
        .get(tenant) as JsonObject
    ).n,
  );
}
/**
 * The workspace's plans against the bound, for the owner's health (CMP-05 baseline: how close the workspace is to the
 * limit). Counts every person's plans; names nothing.
 */
export function planInventory(store: Store, tenant: string): JsonObject {
  const row = store.db
    .prepare(
      "SELECT count(*) AS total, sum(json_extract(data,'$.archived') IS NOT NULL) AS archived FROM documents WHERE tenant_id=? AND kind='campaign_run'",
    )
    .get(tenant) as JsonObject;
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
    const ids = (
      store.db
        .prepare(
          "SELECT id FROM documents WHERE tenant_id=? AND kind='campaign_run' AND json_extract(data,'$.archived.at')<?",
        )
        .all(tenant, cutoff) as {id: string}[]
    ).map(r => r.id);
    for (const id of ids)
      store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND kind='campaign_run' AND id=?").run(tenant, id);
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
  const row = store.db
    .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='plan_policy' AND id=?")
    .get(tenant, planPolicyId) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : {require_distinct_approver: false};
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
  const users = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='amcp_users'").get();
  return store.db
    .prepare(
      users
        ? 'SELECT m.user_id AS user_id, u.name AS name, m.role AS workspace_role FROM workspace_memberships m LEFT JOIN amcp_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.active=1 ORDER BY m.user_id LIMIT 100'
        : 'SELECT m.user_id AS user_id, NULL AS name, m.role AS workspace_role FROM workspace_memberships m WHERE m.tenant_id=? AND m.active=1 ORDER BY m.user_id LIMIT 100',
    )
    .all(tenant) as JsonObject[];
}
