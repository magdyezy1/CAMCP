import type {Store} from './store.js';
import {
  deleteClientGrants,
  deleteRegisteredClient,
  idleRegisteredClients,
  idleUnregisteredClients,
  registeredClientCount,
  registrationsSince,
  tableExists,
} from './mcp-client-repository.js';

/**
 * Registered MCP OAuth clients (dynamic client registration). Registration is anonymous and the table is deployment
 * wide; a client is released once nothing it was issued can be used any more (MCP-03, review 2026-10-08). Before this
 * rule, any grant row at all kept a client, and token pruning keeps each client's newest refresh row for good, so the
 * old 1,000-client cap filled permanently.
 *
 * MCP-03 phase 2 replaced that global refusal with limits on how fast registrations arrive: per client address (the
 * SEC-01 attribution) and per deployment, each in 24 hours, with an alarm in the owner's health view and the log. An
 * unused registration is released after a day, so anonymous registration alone can hold at most about two days of
 * the deployment's daily limit. `mcpClientLimit` remains as a storage backstop that those limits keep out of reach.
 */
export const mcpClientLimit = 5000;
/** How long after its newest grant expired a client stays registered, so a client that comes back soon finds it. */
export const mcpClientReleaseGraceMs = 7 * 86400000;
/** A registration that was never used for this long is released, as before. */
export const mcpClientUnusedMs = 86400000;
/** The window of the registration limits. */
export const mcpRegistrationWindowMs = 86400000;
/**
 * New registrations accepted in 24 hours from one client address (IPv6: one /64) and by the whole deployment. Starting
 * values to tune from the owner's health view: AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY and AMCP_MCP_REGISTRATIONS_DAILY.
 * Hosted clients (Claude.ai, ChatGPT) register from their own servers, so one address can carry many people's
 * connections; clients that use a client metadata document never register.
 */
export interface McpRegistrationLimits {
  perAddressDaily: number;
  daily: number;
}
export const mcpRegistrationLimitDefaults: Readonly<McpRegistrationLimits> = Object.freeze({
  perAddressDaily: 30,
  daily: 300,
});
const registrationLimitBounds: Record<keyof McpRegistrationLimits, [number, number, string]> = {
  perAddressDaily: [1, 1000, 'AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY'],
  daily: [1, 10000, 'AMCP_MCP_REGISTRATIONS_DAILY'],
};
/** The share of a limit at which the owner's health view and the log raise an alarm. */
export const mcpRegistrationAlarmShare = 0.8;
/** Validated registration limits; a value outside its bounds is refused with the setting's name. */
export function mcpRegistrationLimits(options: Partial<McpRegistrationLimits> = {}): McpRegistrationLimits {
  const limits = {
    perAddressDaily: options.perAddressDaily ?? mcpRegistrationLimitDefaults.perAddressDaily,
    daily: options.daily ?? mcpRegistrationLimitDefaults.daily,
  };
  for (const [name, [min, max, setting]] of Object.entries(registrationLimitBounds)) {
    const value = limits[name as keyof McpRegistrationLimits];
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error(setting + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  if (limits.perAddressDaily > limits.daily)
    throw Error('AMCP_MCP_REGISTRATIONS_PER_ADDRESS_DAILY must not exceed AMCP_MCP_REGISTRATIONS_DAILY.');
  return limits;
}
/** The limits the authorization server of a store applies, for the owner's health view (set by McpOAuth). */
const configuredLimits = new WeakMap<Store, McpRegistrationLimits>();
export function registerMcpRegistrationLimits(store: Store, limits: McpRegistrationLimits) {
  configuredLimits.set(store, limits);
}

/**
 * Registrations issued in the 24 hours before `now`, and when the oldest of them leaves that window. Rows are never
 * released within a day of registration, so the count is exact.
 */
export function mcpRecentRegistrations(store: Store, now = Date.now()): {count: number; oldestAt?: number} {
  if (!tableExists(store, 'amcp_mcp_clients')) return {count: 0};
  const row = registrationsSince(store, Math.floor((now - mcpRegistrationWindowMs) / 1000));
  return {count: row.n, ...(typeof row.oldest === 'number' ? {oldestAt: row.oldest * 1000} : {})};
}

/**
 * Why the owner should look at registrations now, if at all: the deployment's registrations of the last 24 hours, or
 * the registered count, reached the alarm share of its limit.
 */
export function mcpRegistrationAlarms(
  registered: number,
  recent: number,
  limits: McpRegistrationLimits,
): ('daily_registrations' | 'registered_clients')[] {
  const alarms: ('daily_registrations' | 'registered_clients')[] = [];
  if (recent >= Math.ceil(limits.daily * mcpRegistrationAlarmShare)) alarms.push('daily_registrations');
  if (registered >= Math.ceil(mcpClientLimit * mcpRegistrationAlarmShare)) alarms.push('registered_clients');
  return alarms;
}

/**
 * The registered clients the next registration releases: issued more than a day ago, with no live grant (no access,
 * refresh, code or consent request that is unused and unexpired), and whose newest grant expired more than the grace
 * period ago (or which never had one).
 */
export function releasableMcpClients(store: Store, now = Date.now()): string[] {
  if (!tableExists(store, 'amcp_mcp_clients') || !tableExists(store, 'amcp_mcp_grants')) return [];
  return idleRegisteredClients(store, Math.floor((now - mcpClientUnusedMs) / 1000), now, now - mcpClientReleaseGraceMs);
}

/**
 * Releases the clients releasableMcpClients names, with their grant rows and the expired keys of their access grants,
 * in one transaction. Grant rows of a client without a registration row (a client identified by its metadata
 * document URL, or an orphan) are removed under the same rule. Returns how many registrations were released.
 */
export function releaseStaleMcpClients(store: Store, now = Date.now()): number {
  if (!tableExists(store, 'amcp_mcp_clients') || !tableExists(store, 'amcp_mcp_grants')) return 0;
  return store.transaction(() => {
    const ids = releasableMcpClients(store, now),
      unregistered = idleUnregisteredClients(store, now, now - mcpClientReleaseGraceMs);
    for (const id of [...ids, ...unregistered]) deleteClientGrants(store, id, now);
    for (const id of ids) deleteRegisteredClient(store, id);
    return ids.length;
  });
}

/**
 * The registered-client count and its headroom under the storage backstop, the registrations of the last 24 hours
 * against the daily limits, and any alarm, for the owner's health view.
 */
export function mcpClientCapacity(store: Store, now = Date.now()) {
  const limits = configuredLimits.get(store) ?? mcpRegistrationLimitDefaults,
    registered = tableExists(store, 'amcp_mcp_clients') ? registeredClientCount(store) : 0,
    recent = mcpRecentRegistrations(store, now).count;
  return {
    registered,
    limit: mcpClientLimit,
    headroom: Math.max(0, mcpClientLimit - registered),
    releasable_on_next_registration: registered ? releasableMcpClients(store, now).length : 0,
    registered_last_24h: recent,
    daily_limit: limits.daily,
    per_address_daily_limit: limits.perAddressDaily,
    alarms: mcpRegistrationAlarms(registered, recent, limits),
  };
}
