import type {Store} from './store.js';
import type {JsonObject} from './types.js';
import {sha256} from './security.js';

const hourMs = 3600000,
  keyLimit = 5000;
/**
 * Deployment-wide rate-limit diagnostics of one server process (SEC-01): which source supplies client addresses,
 * whether the proxy headers those sources rely on arrive, and how many distinct limit keys were used in the last hour.
 * Only counts and booleans are kept: never an address, an email address or a limit key, which is hashed on arrival.
 */
export class LimitDiagnostics {
  /** Hashed limit key -> last use, oldest first; holds the keys of the last hour, at most keyLimit of them. */
  private readonly keys = new Map<string, number>();
  private latest?: {at: number; xRealIp: boolean; cfConnectingIp: boolean};
  private readonly headerSeenAt = {xRealIp: -Infinity, cfConnectingIp: -Infinity};
  private capped = false;
  /** Email requests (reset, registration, email change) answered without sending at the per-email cap (SEC-03). */
  private withheldEmails = 0;
  /** LOGIN_RATE_LIMIT refusals of requests that carried a valid known-device cookie (SEC-03); expected 0. */
  private knownDeviceRefusals = 0;
  readonly startedAt: number;
  constructor(
    readonly keySource: string,
    readonly deploymentTenant: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = clock();
  }
  private prune(now: number) {
    for (const [key, at] of this.keys) {
      if (at >= now - hourMs) break;
      this.keys.delete(key);
    }
    if (this.keys.size < keyLimit) this.capped = false;
  }
  /** One rate-limit decision: the key it used and whether the request carried each proxy header. */
  observe(key: string, headers: {xRealIp: boolean; cfConnectingIp: boolean}) {
    const now = this.clock(),
      id = sha256('amcp-limit-key:' + key).slice(0, 32);
    this.prune(now);
    this.keys.delete(id);
    this.keys.set(id, now);
    if (this.keys.size > keyLimit) {
      this.keys.delete(this.keys.keys().next().value!);
      this.capped = true;
    }
    this.latest = {at: now, ...headers};
    if (headers.xRealIp) this.headerSeenAt.xRealIp = now;
    if (headers.cfConnectingIp) this.headerSeenAt.cfConnectingIp = now;
  }
  recordWithheldEmail() {
    this.withheldEmails++;
  }
  recordKnownDeviceRefusal() {
    this.knownDeviceRefusals++;
  }
  snapshot(): JsonObject {
    const now = this.clock();
    this.prune(now);
    const xRealIp = this.headerSeenAt.xRealIp >= now - hourMs,
      cfConnectingIp = this.headerSeenAt.cfConnectingIp >= now - hourMs;
    return {
      scope:
        'Deployment-wide, for this server process since it started. Counts and booleans only: no address, email or limit key is kept or shown.',
      key_source: this.keySource,
      observed_since: this.startedAt,
      distinct_limit_keys_last_hour: this.keys.size,
      distinct_limit_keys_capped: this.capped,
      latest_request: this.latest
        ? {
            at: this.latest.at,
            x_real_ip_present: this.latest.xRealIp,
            cf_connecting_ip_present: this.latest.cfConnectingIp,
          }
        : null,
      headers_seen_last_hour: {x_real_ip: xRealIp, cf_connecting_ip: cfConnectingIp},
      // A proxy sets X-Real-IP but the key source ignores it: every client may share the proxy's key.
      proxy_headers_ignored: xRealIp && !this.keySource.startsWith('railway'),
      email_requests_withheld: this.withheldEmails,
      known_device_refusals: this.knownDeviceRefusals,
    };
  }
}
const registered = new WeakMap<Store, LimitDiagnostics>();
export function registerLimitDiagnostics(store: Store, diagnostics: LimitDiagnostics) {
  registered.set(store, diagnostics);
}
/**
 * Whether `tenant` is the deployment's own workspace: the one the website serves its administrator sign-in from, which
 * owner migration keeps. Every deployment-wide owner panel (rate-limit attribution, AI-client registrations) uses this
 * one test, so owners of other workspaces never see deployment-wide figures. False where no website runs.
 */
export function isDeploymentTenant(store: Store, tenant: string): boolean {
  return registered.get(store)?.deploymentTenant === tenant;
}
/** The deployment workspace's owner view only: owners of other workspaces never see deployment-wide traffic counts. */
export function limitDiagnostics(store: Store, tenant: string): JsonObject | undefined {
  return isDeploymentTenant(store, tenant) ? registered.get(store)!.snapshot() : undefined;
}
