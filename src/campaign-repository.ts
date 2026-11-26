import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {doorPrincipal} from './actor-identity.js';
import {tableExists} from './owner-health-repository.js';

/**
 * The campaign plan inventory's statements (CMP-05, src/campaign-inventory.ts) in the store layer (ARC-02), moved here
 * verbatim. Every statement reads the `campaign_run` documents of one workspace; the visibility condition limits a
 * person who is not an administrator to the plans they own or collaborate on, and src/campaign-inventory.ts still checks
 * a collaborator's current account access per row.
 */
export type PlanFilters = {
  state?: string;
  archived?: boolean;
  gateway?: string;
  account_id?: string;
  connection_id?: string;
  profile_id?: string;
  /** The client's bound accounts as `gateway NUL plain account` (set with profile_id; never part of the cursor). */
  client_accounts?: string[];
  search?: string;
  awaiting_approval?: boolean;
};
/** Who reads plans: an administrator, or the person (principalOf) behind a credential (its user id). */
export interface PlanReader {
  admin: boolean;
  person: string;
  userId: string;
}
type Param = string | number | null;

/** The SQL that limits plan documents to those the actor owns or collaborates on (everything for administrators). */
function visibility(reader: PlanReader): {sql: string; params: Param[]} {
  if (reader.admin) return {sql: '1', params: []};
  const person = reader.person;
  return {
    sql: `(json_extract(d.data,'$.principal')=?
      OR (coalesce(json_extract(d.data,'$.principal'),'')='' AND (json_extract(d.data,'$.user_id') IN (?,?)
        OR (?=? AND json_extract(d.data,'$.user_id') IN ('workspace-admin','workspace-test'))))
      OR EXISTS (SELECT 1 FROM json_each(d.data,'$.collaborators') c WHERE json_extract(c.value,'$.user_id')=?))`,
    params: [person, reader.userId, person, person, doorPrincipal, person],
  };
}
const updatedAt = "coalesce(json_extract(d.data,'$.updated_at'),0)";
const stepGateway =
  "CASE WHEN json_extract(s.value,'$.kind')='media' THEN json_extract(s.value,'$.arguments.platform')||'_native_action' ELSE json_extract(s.value,'$.gateway') END";
const plainAccount = (sql: string) => `replace(replace(${sql},'act_',''),'-','')`;

function filterSQL(reader: PlanReader, f: PlanFilters): {sql: string[]; params: Param[]} {
  const sql: string[] = [],
    params: Param[] = [];
  sql.push(f.archived ? "json_extract(d.data,'$.archived') IS NOT NULL" : "json_extract(d.data,'$.archived') IS NULL");
  if (f.state) {
    sql.push("json_extract(d.data,'$.state')=?");
    params.push(f.state);
  }
  if (f.profile_id) {
    // A client's plans (SEC-08): made with its profile, or naming an account the profile binds within current access.
    sql.push(`(json_extract(d.data,'$.profile_id')=? OR EXISTS (SELECT 1 FROM json_each(d.data,'$.steps') s
      WHERE ${stepGateway}||char(0)||${plainAccount("json_extract(s.value,'$.account_id')")} IN (SELECT value FROM json_each(?))))`);
    params.push(f.profile_id, JSON.stringify(f.client_accounts ?? []));
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
    params.push(reader.person);
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

/**
 * One page of a workspace's visible plans matching the filters, newest first (then by id), after the cursor position
 * `after` when given: at most `scan` + 1 projected rows (name, state, times, counts, scopes and, with `steps`, each
 * step's status), never arguments or receipts.
 */
export function planRows(
  store: Store,
  tenant: string,
  reader: PlanReader,
  filters: PlanFilters,
  options: {after?: {at: number; id: string}; steps: boolean; scan: number; offset: number},
): JsonObject[] {
  const v = visibility(reader),
    f = filterSQL(reader, filters),
    where = ['d.tenant_id=?', "d.kind='campaign_run'", v.sql, ...f.sql],
    params: Param[] = [tenant, ...v.params, ...f.params];
  if (options.after) {
    where.push(`(${updatedAt}<? OR (${updatedAt}=? AND d.id>?))`);
    params.push(options.after.at, options.after.at, options.after.id);
  }
  return store
    .sql()
    .prepare(`${projection(options.steps)} WHERE ${where.join(' AND ')} ORDER BY at DESC, d.id LIMIT ? OFFSET ?`)
    .all(...params, options.scan + 1, options.offset) as JsonObject[];
}
/**
 * The plans of a workspace that hold a step prepared as this review, each with that step's id (R2.5 M3, dupstep): what a refusal that names an
 * earlier review needs to point at the plan that holds it. One statement over the plan documents, with no provider call. It applies no
 * visibility: who may read each plan is the caller's to decide (src/campaign-inventory.ts planHoldingReview), as for every other plan read.
 * A review belongs to one step of one plan; the bound is only a guard.
 */
export function plansHoldingReview(store: Store, tenant: string, reviewId: string): {id: string; step_id: string}[] {
  return store
    .sql()
    .prepare(
      `SELECT d.id AS id, json_extract(s.value,'$.id') AS step_id FROM documents d, json_each(d.data,'$.steps') s
        WHERE d.tenant_id=? AND d.kind='campaign_run' AND json_extract(s.value,'$.review_id')=? ORDER BY d.id LIMIT 10`,
    )
    .all(tenant, reviewId) as {id: string; step_id: string}[];
}
/**
 * The plans of a workspace that were superseded while they carried one of `keys` (the bindings a continuation does not carry: r25-planmodel, N6), each with the plan its supersession
 * names (`done`, once the continuation was made) and the plan its hold names (`held`, while it is being made). One statement over the plan documents; `keys` is the caller's one list.
 */
export function boundSupersededPlans(
  store: Store,
  tenant: string,
  keys: readonly string[],
): {id: string; done: string | null; held: string | null}[] {
  if (!keys.length) return [];
  return store
    .sql()
    .prepare(
      `SELECT d.id AS id, json_extract(d.data,'$.superseded_by.id') AS done, json_extract(d.data,'$.superseded_by.to') AS held
        FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND json_extract(d.data,'$.state')='superseded'
          AND (${keys.map(() => 'json_extract(d.data,?) IS NOT NULL').join(' OR ')})`,
    )
    .all(tenant, ...keys.map(key => '$.' + key)) as {id: string; done: string | null; held: string | null}[];
}
/** How many visible plans of a workspace match the filters (collaborators' access is checked per page). */
export function planCount(store: Store, tenant: string, reader: PlanReader, filters: PlanFilters): number {
  const v = visibility(reader),
    f = filterSQL(reader, filters);
  return Number(
    (
      store
        .sql()
        .prepare(
          `SELECT count(*) AS n FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND ${[v.sql, ...f.sql].join(' AND ')}`,
        )
        .get(tenant, ...v.params, ...f.params) as JsonObject
    ).n,
  );
}
/** A workspace's visible plans counted by state and archived flag. */
export function planStateCounts(store: Store, tenant: string, reader: PlanReader): JsonObject[] {
  const v = visibility(reader);
  return store
    .sql()
    .prepare(
      `SELECT json_extract(d.data,'$.state') AS state, json_extract(d.data,'$.archived') IS NOT NULL AS archived,
        count(*) AS n FROM documents d WHERE d.tenant_id=? AND d.kind='campaign_run' AND ${v.sql} GROUP BY 1,2`,
    )
    .all(tenant, ...v.params) as JsonObject[];
}
/** How many plans of a workspace are not archived, of every person. */
export function unarchivedPlanCount(store: Store, tenant: string): number {
  return Number(
    (
      store
        .sql()
        .prepare(
          "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='campaign_run' AND json_extract(data,'$.archived') IS NULL",
        )
        .get(tenant) as JsonObject
    ).n,
  );
}
/** A workspace's plans of every person: how many, and how many of them are archived. */
export function planTotals(store: Store, tenant: string): JsonObject {
  return store
    .sql()
    .prepare(
      "SELECT count(*) AS total, sum(json_extract(data,'$.archived') IS NOT NULL) AS archived FROM documents WHERE tenant_id=? AND kind='campaign_run'",
    )
    .get(tenant) as JsonObject;
}
/** Up to 100 active members of a workspace by user id: their name (when the website keeps accounts) and role. */
export function activeMembers(store: Store, tenant: string): JsonObject[] {
  const users = tableExists(store, 'amcp_users');
  return store
    .sql()
    .prepare(
      users
        ? 'SELECT m.user_id AS user_id, u.name AS name, m.role AS workspace_role FROM workspace_memberships m LEFT JOIN amcp_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.active=1 ORDER BY m.user_id LIMIT 100'
        : 'SELECT m.user_id AS user_id, NULL AS name, m.role AS workspace_role FROM workspace_memberships m WHERE m.tenant_id=? AND m.active=1 ORDER BY m.user_id LIMIT 100',
    )
    .all(tenant) as JsonObject[];
}
