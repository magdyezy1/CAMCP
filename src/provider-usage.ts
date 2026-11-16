import {AsyncLocalStorage} from 'node:async_hooks';
import type {CompiledRequest} from './types.js';

// The rate governor (R2.5 M2, package r25-m2-refusal; MT3, L3-03, the owner's idea of 2026-11-15): what a provider's responses say
// of how much of its rate limit is used, kept beside the cooldowns the transport already opens when a provider refuses. A provider
// says it in its response headers (Meta's X-App-Usage, X-Ad-Account-Usage and X-Business-Use-Case-Usage, src/meta-usage.ts); AMCP
// read the last of them only when Meta had already refused, and dropped all of them from a response that succeeded. A leaf: it
// names no provider (the seam rule), takes what a provider's wire profile reports, and keeps nothing of a payload.

/** What one response's headers report of one bucket of a provider's rate limit. */
export interface UsageObservation {
  /** Whose limit it is: the login's, which every account of it shares, or one ad account's. */
  readonly level: 'login' | 'account';
  /** A closed-set name of the bucket, a token and never provider text. */
  readonly scope: string;
  /** How much of the limit is used, in percent: 0 or more, and over 100 where the provider says so. */
  readonly usage_pct?: number;
  /** How long the provider says access stays blocked, set only for a bucket it says is blocked now. */
  readonly regain_ms?: number;
}

/**
 * How a provider reports its usage (`WireProfile.usage`): `read` returns the observations of one response; `exposed: false`
 * declares that the provider sends none (Google's APIs), so a view of its limits says "not exposed" and not "unknown".
 */
export interface UsageProfile {
  readonly exposed: boolean;
  read?(headers: Headers, plan: CompiledRequest): readonly UsageObservation[];
}
/** A provider that sends no usage header (Google's APIs: only a throttle carries a delay). */
export const usageNotExposed: UsageProfile = Object.freeze({exposed: false});

/** What the governor keeps of an observation: the provider (its gateway), the bucket, the numbers and when, with no payload. */
export interface UsageRecord {
  provider: string;
  scope: string;
  usage_pct?: number;
  regain_ms?: number;
  at: number;
}

/** `ok`: usage is known and nothing is blocked; `cooling`: a throttle is known and nothing is sent until `until`. */
export type RateLimitState = 'ok' | 'cooling' | 'unknown' | 'not_exposed';
/**
 * The view of one provider's limits for a login and an account, as the response `meta` and `check` show it. It names no provider:
 * it is the small shape every answer of a call that sent a provider request carries (the journeys budget response bytes,
 * tests/journeys/baseline.json), and a check is for one connection, whose provider is known.
 */
export interface RateLimitView {
  state: RateLimitState;
  /** When a throttle that is known ends, as an ISO time; only while cooling. */
  until?: string;
  /** The worst usage seen, in percent. */
  usage_pct?: number;
}

/**
 * The most records the table holds. A flood of logins and accounts replaces the oldest records; it never fills the table into
 * a refusal (the transport's own maps refuse at capacity, and a usage table must not).
 */
const maxEntries = 1024;
/**
 * A percentage older than this is no longer what the provider would say now: Meta's windows are rolling, and what a response
 * said ten minutes ago is not a measure of the headroom an agent has. A block that has not ended is kept until it does.
 */
const staleAfterMs = 600000;
/**
 * The wait for a bucket at its limit whose provider names none: the minute the throttle path assumes when Meta names none
 * (src/provider-error-core.ts errorMinute), so that a limit known from a header and the same limit known from a refusal are
 * waited out alike.
 */
export const unnamedWaitMs = 60000;
const dayMs = 86400000;

/** The rate keys of a request's login and account (src/transport.ts): the governor files usage under the same ones. */
export interface UsageKeys {
  login: string;
  account: string;
}
/** A bucket that is blocked, with the key of its level and for how long, in milliseconds from now. */
export interface UsageBlock {
  key: string;
  ms: number;
}
interface Entry {
  level: 'login' | 'account';
  rateKey: string;
  provider: string;
  scope: string;
  usage_pct?: number;
  regain_ms?: number;
  at: number;
  /** The end of a block that is known, in wall-clock milliseconds. */
  blockedUntil?: number;
}

/** The usage a process has seen, by login, account and bucket. */
export class ProviderUsage {
  private entries = new Map<string, Entry>();
  get size(): number {
    return this.entries.size;
  }
  /**
   * Keeps what a response reported, one record per bucket (a newer one replaces it), and returns the buckets it says are blocked
   * now: at or over 100 percent, or with a wait the provider names. A provider's own reader drops what is not a percentage or a
   * wait; this keeps only what the type names.
   */
  record(
    provider: string,
    keys: UsageKeys,
    observations: readonly UsageObservation[],
    now: number = Date.now(),
  ): UsageBlock[] {
    const blocks: UsageBlock[] = [];
    for (const o of observations) {
      const rateKey = o.level === 'login' ? keys.login : keys.account,
        key = o.level + '\0' + rateKey + '\0' + o.scope,
        blocked = (o.regain_ms ?? 0) > 0 || (o.usage_pct ?? 0) >= 100,
        ms = blocked ? Math.min(dayMs, Math.ceil(o.regain_ms ?? unnamedWaitMs)) : 0;
      this.entries.delete(key);
      if (this.entries.size >= maxEntries) this.evict(now);
      this.entries.set(key, {
        level: o.level,
        rateKey,
        provider,
        scope: o.scope,
        ...(o.usage_pct !== undefined ? {usage_pct: o.usage_pct} : {}),
        ...(o.regain_ms !== undefined ? {regain_ms: o.regain_ms} : {}),
        at: now,
        ...(blocked ? {blockedUntil: now + ms} : {}),
      });
      if (blocked) blocks.push({key: rateKey, ms});
    }
    return blocks;
  }
  /** The records of a login and an account that are not stale, in scope order, as the governor keeps them. */
  records(keys: UsageKeys, now: number = Date.now()): UsageRecord[] {
    return this.live(keys, now)
      .map((e): UsageRecord => ({
        provider: e.provider,
        scope: e.scope,
        ...(e.usage_pct !== undefined ? {usage_pct: e.usage_pct} : {}),
        ...(e.regain_ms !== undefined ? {regain_ms: e.regain_ms} : {}),
        at: e.at,
      }))
      .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  }
  /** When the latest block known for a login or an account ends (wall-clock milliseconds), or undefined when none is in force. */
  blockedUntil(keys: UsageKeys, now: number = Date.now()): number | undefined {
    let until: number | undefined;
    for (const e of this.all(keys))
      if (e.blockedUntil !== undefined && e.blockedUntil > now && (until === undefined || e.blockedUntil > until))
        until = e.blockedUntil;
    return until;
  }
  /**
   * The view of a provider's limits for a login and an account. `cooldownUntil` is the end of a cooldown the transport itself
   * holds for them (a throttle it was refused with, or a block it opened under enforcement), in wall-clock milliseconds: it
   * stops a request as a block from a header does. `exposed` is the provider's own declaration (`WireProfile.usage`).
   */
  view(
    keys: UsageKeys,
    exposed: boolean | undefined,
    cooldownUntil: number | undefined,
    now: number = Date.now(),
  ): RateLimitView {
    const live = this.live(keys, now),
      percentages = live.map(e => e.usage_pct).filter((p): p is number => p !== undefined),
      usage = percentages.length ? Math.max(...percentages) : undefined,
      until = Math.max(this.blockedUntil(keys, now) ?? 0, cooldownUntil ?? 0);
    if (until > now)
      return {
        state: 'cooling',
        until: new Date(until).toISOString(),
        ...(usage !== undefined ? {usage_pct: usage} : {}),
      };
    if (live.length) return {state: 'ok', ...(usage !== undefined ? {usage_pct: usage} : {})};
    return {state: exposed === false ? 'not_exposed' : 'unknown'};
  }
  /** Every entry of a login and an account, stale or not. */
  private all(keys: UsageKeys): Entry[] {
    const found: Entry[] = [];
    for (const e of this.entries.values())
      if ((e.level === 'login' && e.rateKey === keys.login) || (e.level === 'account' && e.rateKey === keys.account))
        found.push(e);
    return found;
  }
  private live(keys: UsageKeys, now: number): Entry[] {
    return this.all(keys).filter(e => now - e.at <= staleAfterMs);
  }
  /** Makes room: the stale records that no block holds first, then the oldest. */
  private evict(now: number) {
    for (const [key, e] of this.entries)
      if (now - e.at > staleAfterMs && (e.blockedUntil ?? 0) <= now) this.entries.delete(key);
    while (this.entries.size >= maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * The governor's mode, from AMCP_PROVIDER_PACING_MODE (observe | enforce), as the shared provider quota's mode is
 * (src/provider-quota.ts, AMCP_PROVIDER_QUOTA_MODE). `observe`, the default, only counts the requests that were sent into a throttle
 * the provider's own headers had announced (`pacing_would_refuse`); `enforce` opens the cooldown such a header calls for before
 * the next request, which then refuses before it is sent. Anything but `enforce` is observe: a mistyped value never enforces.
 */
export type PacingMode = 'observe' | 'enforce';
export const pacingMode = (env: NodeJS.ProcessEnv = process.env): PacingMode =>
  env.AMCP_PROVIDER_PACING_MODE === 'enforce' ? 'enforce' : 'observe';

/**
 * The logins and accounts a call sent requests for, which the service shows the limits of in the answer's `meta`. The
 * transport notes one per request; a call collects them in its own scope, and a nested call (a plan step, a workflow's read) hands
 * what it touched to the call that made it.
 */
export interface UsageTouch {
  tenantId: string;
  gateway: string;
  connectionId: string;
  accountId?: string;
}
const touches = new AsyncLocalStorage<UsageTouch[]>();
/** The most requests a call remembers: a plan run of hundreds of steps names the same few accounts. */
const maxTouches = 256;
export async function collectUsageTouches<T>(run: () => Promise<T>): Promise<{result: T; touched: UsageTouch[]}> {
  const mine: UsageTouch[] = [],
    parent = touches.getStore();
  try {
    return {result: await touches.run(mine, run), touched: mine};
  } finally {
    if (parent) for (const t of mine) if (parent.length < maxTouches) parent.push(t);
  }
}
/** Notes that the running call sent a request for this login and account; nothing outside a collecting call. */
export function noteUsageTouch(touch: UsageTouch): void {
  const list = touches.getStore();
  if (list && list.length < maxTouches) list.push(touch);
}

/**
 * The one view a call's `meta` shows when it touched several: a throttle first (the one that ends last), then the highest usage
 * seen, then an unknown limit, then a provider that exposes none. Undefined when the call sent no request.
 */
export function rateLimitSummary(views: readonly RateLimitView[]): RateLimitView | undefined {
  const rank: Record<RateLimitState, number> = {cooling: 3, ok: 2, unknown: 1, not_exposed: 0};
  let worst: RateLimitView | undefined;
  for (const v of views) {
    if (!worst || rank[v.state] > rank[worst.state]) worst = v;
    else if (rank[v.state] === rank[worst.state]) {
      if (v.state === 'cooling' && (v.until ?? '') > (worst.until ?? '')) worst = v;
      else if (v.state === 'ok' && (v.usage_pct ?? 0) > (worst.usage_pct ?? 0)) worst = v;
    }
  }
  return worst;
}
