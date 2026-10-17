import {fingerprint, type ToolCall} from './workspace-core.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import type {Store} from './store.js';
import type {Actor, Connection, JsonObject} from './types.js';

/**
 * The portfolio adapter contract and the parts every adapter runs the same way (ARC-04 stage E): the login a read is
 * bound to, the gateway read bracketed by login checks, and the page's collection budget. The signed cursor is
 * src/signed-cursor.ts. Each adapter keeps its own validation order, provider checks, refusal sentences and output, so
 * pages and refusals are unchanged; the parts here take the adapter's refusals as functions.
 */
export interface PortfolioAdapter {
  /** The gateway whose inventory the adapter pages. */
  readonly gateway: string;
  /** The entity levels `requirements.entity` names, the root first. */
  readonly entities: readonly string[];
  /** One page of current inventory, under a signed five-minute cursor. */
  page(store: Store, call: ToolCall, actor: Actor, input: JsonObject): Promise<PortfolioPage>;
}

/** What every portfolio page holds; each adapter adds its provider's context (currency, filters, page number...). */
export interface PortfolioPage extends JsonObject {
  gateway: string;
  connection_id: string;
  account_id: string;
  entity: string;
  rows: JsonObject[];
  has_more: boolean;
  /** The signed cursor of the next page, or null on the last one. */
  next_cursor: string | null;
  captured_at: number;
  /** What the page shows and does not prove. */
  meaning: string;
}

/**
 * How a read stays bound to the login it started with. `login_and_scopes` fingerprints the stored login with the sorted
 * scopes (any change refuses with `changed`); `login` fingerprints the stored login only and checks on every re-check
 * that the connection still `permits` the read (`missingScope` refuses first), then the login (`changed`).
 */
export type PortfolioAuthorityRule =
  | {readonly binds: 'login_and_scopes'; changed(): never}
  | {
      readonly binds: 'login';
      permits(current: Connection, first: Connection): boolean;
      missingScope(): never;
      changed(): never;
    };

export interface PortfolioAuthority {
  /** The fingerprint the read is bound to: part of the cursor binding and its signing key. */
  readonly authorization: string;
  /** Resolves the connection again for the actor and refuses when the login (or its permission) changed. */
  current(): Connection;
}

export function portfolioAuthority(
  store: Store,
  actor: Actor,
  gateway: string,
  account: string,
  connection: Connection,
  rule: PortfolioAuthorityRule,
): PortfolioAuthority {
  const resolve = () => store.resolveConnection(actor, gateway, account, connection.id);
  if (rule.binds === 'login_and_scopes') {
    const stamp = (c: Connection) => fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}),
      authorization = stamp(connection);
    return {
      authorization,
      current: () => {
        const c = resolve();
        if (stamp(c) !== authorization) rule.changed();
        return c;
      },
    };
  }
  const authorization = fingerprint(storedLogin(store, connection));
  return {
    authorization,
    current: () => {
      const c = resolve();
      if (!rule.permits(c, connection)) rule.missingScope();
      if (fingerprint(storedLogin(store, c)) !== authorization) rule.changed();
      return c;
    },
  };
}

/**
 * A gateway read for one page: the login is checked before the call and again after it, and a refused read ends the
 * page with the adapter's `refused`, which keeps the gateway's own refusal.
 */
export function portfolioReader(
  call: ToolCall,
  actor: Actor,
  gateway: string,
  current: () => unknown,
  refused: (error: JsonObject | undefined) => never,
): (args: JsonObject) => Promise<JsonObject> {
  return async args => {
    current();
    const response = await call(gateway, args, actor);
    current();
    if (!response.success) refused(response.error);
    return response;
  };
}

/** The page's limits: requests, rows, bytes and elapsed time of one page. */
export interface PortfolioLimits {
  requests: number;
  rows: number;
  bytes: number;
  elapsed_ms: number;
}

/** Runs one page inside its own collection budget, bound to the read, and closes the budget on every exit. */
export async function withPortfolioBudget<T>(
  binding: string,
  limits: PortfolioLimits,
  page: (budget: ReportCollectionBudget) => Promise<T>,
): Promise<T> {
  const budget = new ReportCollectionBudget(undefined, binding, () => {}, limits);
  try {
    return await budget.run(() => page(budget));
  } finally {
    budget.close();
  }
}
