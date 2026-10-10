import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {Store} from '../src/store.js';
import type {Actor} from '../src/types.js';

/**
 * Bounds on authenticated /mcp requests (SEC-02). One POST could carry a JSON-RPC batch of tens of thousands of
 * `tools/list` calls (about 2,400 times response amplification), and nothing limited how often or how many requests a
 * key sent, so one key could hold the single Node event loop for every workspace. Owner decision D6 (2026-10-08):
 * refuse batches, and start at 60 requests a minute, a burst of 20 and 4 requests in flight per actor; all four are
 * environment-tunable starting values.
 */
export interface McpLimitOptions {
  /** AMCP_MCP_BATCH_MAX: 1 refuses every JSON-RPC array; 2-10 allow that many items for protocol 2025-03-26 only. */
  batchMax?: number;
  /** AMCP_MCP_RATE_PER_MINUTE: sustained requests per actor and minute; 0 turns the rate limit off. */
  perMinute?: number;
  /** AMCP_MCP_RATE_BURST: requests an idle actor may send at once. */
  burst?: number;
  /** AMCP_MCP_MAX_IN_FLIGHT: concurrent requests per actor on this instance; 0 turns the cap off. */
  inFlight?: number;
}
export const mcpLimitDefaults = {batchMax: 1, perMinute: 60, burst: 20, inFlight: 4} as const;
/** The only protocol version whose clients may send JSON-RPC batches; 2025-06-18 removed batching. */
export const batchProtocolVersion = '2025-03-26';
const bounds: Record<keyof McpLimitOptions, [number, number, string]> = {
  batchMax: [1, 10, 'AMCP_MCP_BATCH_MAX'],
  perMinute: [0, 100000, 'AMCP_MCP_RATE_PER_MINUTE'],
  burst: [1, 10000, 'AMCP_MCP_RATE_BURST'],
  inFlight: [0, 1000, 'AMCP_MCP_MAX_IN_FLIGHT'],
};
/** Validated limits; any value outside its bounds stops start-up instead of guessing. */
export function mcpLimits(options: McpLimitOptions = {}): Required<McpLimitOptions> {
  const limits: Required<McpLimitOptions> = {
    batchMax: options.batchMax ?? mcpLimitDefaults.batchMax,
    perMinute: options.perMinute ?? mcpLimitDefaults.perMinute,
    burst: options.burst ?? mcpLimitDefaults.burst,
    inFlight: options.inFlight ?? mcpLimitDefaults.inFlight,
  };
  for (const [name, [min, max, env]] of Object.entries(bounds)) {
    const value = (limits as Record<string, unknown>)[name];
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
      throw Error(env + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  if (limits.perMinute > 0 && limits.burst < limits.batchMax)
    throw Error('AMCP_MCP_RATE_BURST must be at least AMCP_MCP_BATCH_MAX.');
  return limits;
}
/** Reads the four limits from the environment; unset or empty keeps the default. */
export function mcpLimitsFromEnv(env: NodeJS.ProcessEnv): McpLimitOptions {
  const read = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    if (!/^\d{1,6}$/.test(raw)) throw Error(name + ' must be a whole number.');
    return Number(raw);
  };
  return {
    batchMax: read('AMCP_MCP_BATCH_MAX'),
    perMinute: read('AMCP_MCP_RATE_PER_MINUTE'),
    burst: read('AMCP_MCP_RATE_BURST'),
    inFlight: read('AMCP_MCP_MAX_IN_FLIGHT'),
  };
}
/** A coarse size class of a request body for refusal logs; never the content. */
export function bodySizeBucket(contentLength: string | undefined): string {
  const bytes = Number(contentLength);
  if (contentLength === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  for (const [limit, label] of [
    [1024, '<1KiB'],
    [16384, '1-16KiB'],
    [262144, '16-256KiB'],
    [1048576, '256KiB-1MiB'],
    [4194304, '1-4MiB'],
  ] as const)
    if (bytes < limit) return label;
  return '>=4MiB';
}
/**
 * Refuses a JSON-RPC array unless the owner allowed legacy batches (AMCP_MCP_BATCH_MAX above 1) and the client
 * negotiated 2025-03-26. Returns how many requests the body carries, which is what the rate limit charges.
 */
export function batchItems(body: unknown, protocolVersion: string | undefined, batchMax: number): number {
  if (!Array.isArray(body)) return 1;
  if (batchMax > 1 && protocolVersion === batchProtocolVersion && body.length >= 1 && body.length <= batchMax)
    return body.length;
  // Fixed sentences with the numbers in details, so the Arabic inventory tracks each reason (tools/check-locales.mjs).
  if (batchMax > 1)
    throw new MirrorError(
      'BATCH_UNSUPPORTED',
      'JSON-RPC batches are accepted only for protocol 2025-03-26 and up to the configured number of requests. Send each request in its own POST.',
      {max_items: batchMax, protocol: batchProtocolVersion},
      400,
    );
  throw new MirrorError(
    'BATCH_UNSUPPORTED',
    'JSON-RPC batches are not supported. Send each request in its own POST.',
    {max_items: batchMax},
    400,
  );
}
/**
 * Per-actor request limits for /mcp: a token bucket shared through SQLite, so every process using the database
 * agrees on the rate, and an in-flight cap counted per instance. The actor is the credential's tenant and user (an
 * OAuth connector, a website connector key or an administrator key), never the client address, so the address
 * attribution of SEC-01 cannot merge or split it.
 */
export class McpRequestLimiter {
  readonly limits: Required<McpLimitOptions>;
  private readonly inFlight = new Map<string, number>();
  private readonly perMs: number;
  private prunedAt = -Infinity;
  /**
   * The bucket table is created by the first admitted request, inside its own write transaction, so building the HTTP
   * app never needs the write lock: a start while another process holds it (the health probe's busy case) still works.
   */
  private tableReady = false;
  constructor(
    private readonly store: Store,
    options: McpLimitOptions = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = mcpLimits(options);
    this.perMs = this.limits.perMinute / 60000;
  }
  /**
   * The bucket of one credential holder: tenant, user and, for an AI-client token, the person who approved it. An
   * OAuth actor's user is 'oauth/' + client_id, and a client metadata document's client ID is shared by every person
   * and workspace using that app, so without the approving person they would all share one bucket.
   */
  actorKey(actor: Actor): string {
    return sha256('mcp-actor:' + actor.tenantId + '\n' + actor.userId + '\n' + (actor.ownerUserId ?? ''));
  }
  /** Seconds to wait before `cost` requests fit the actor's bucket; 0 when they were admitted and charged. */
  private take(key: string, cost: number): number {
    if (this.limits.perMinute === 0) return 0;
    const now = this.clock(),
      db = this.store.db,
      fullAfterMs = this.limits.burst / this.perMs;
    const wait = this.store.transaction(() => {
      if (!this.tableReady)
        db.exec(
          'CREATE TABLE IF NOT EXISTS amcp_mcp_rate_limits(key TEXT PRIMARY KEY,tokens REAL NOT NULL,updated_at INTEGER NOT NULL)',
        );
      if (now - this.prunedAt > 60000) {
        // A bucket idle long enough to be full again carries no information.
        db.prepare('DELETE FROM amcp_mcp_rate_limits WHERE updated_at<?').run(now - fullAfterMs);
        this.prunedAt = now;
      }
      const row = db.prepare('SELECT tokens,updated_at FROM amcp_mcp_rate_limits WHERE key=?').get(key) as
        {tokens: number; updated_at: number} | undefined;
      const tokens = row
        ? Math.min(this.limits.burst, row.tokens + Math.max(0, now - row.updated_at) * this.perMs)
        : this.limits.burst;
      if (tokens < cost) return Math.max(1, Math.ceil((cost - tokens) / this.perMs / 1000));
      db.prepare(
        'INSERT INTO amcp_mcp_rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at',
      ).run(key, tokens - cost, now);
      return 0;
    });
    this.tableReady = true;
    return wait;
  }
  /**
   * Admits one request carrying `cost` JSON-RPC messages, or throws RATE_LIMITED (HTTP 429) with the seconds to wait.
   * The returned function releases the in-flight slot; it is safe to call more than once.
   */
  admit(actor: Actor, cost: number): () => void {
    const key = this.actorKey(actor),
      active = this.inFlight.get(key) ?? 0;
    if (this.limits.inFlight > 0 && active >= this.limits.inFlight)
      throw new MirrorError(
        'RATE_LIMITED',
        'Too many MCP requests from this key are still running. Wait for one to finish, then retry.',
        {retry_after_seconds: 1, limit: 'in_flight', max_in_flight: this.limits.inFlight},
        429,
        true,
      );
    const wait = this.take(key, cost);
    if (wait)
      throw new MirrorError(
        'RATE_LIMITED',
        'Too many MCP requests from this key. Wait the number of seconds in Retry-After, then retry.',
        {retry_after_seconds: wait, limit: 'rate', per_minute: this.limits.perMinute, burst: this.limits.burst},
        429,
        true,
      );
    this.inFlight.set(key, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left > 0) this.inFlight.set(key, left);
      else this.inFlight.delete(key);
    };
  }
}
