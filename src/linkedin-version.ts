import {MirrorError} from './errors.js';
import type {Action, JsonObject, ToolDefinition} from './types.js';

/**
 * The LinkedIn-Version values AMCP has reviewed (PRV-02). A version is added here only after LinkedIn's "Recent Marketing
 * API changes" page has been reviewed for what AMCP sends and reads; nothing else is sent. 202609 (Marketing September
 * 2026) since batch 32: LinkedIn's changes for 202606–202609 (read 2026-09-29) are all additive for AMCP's requests.
 * `sunset` is the first day AMCP stops sending a version: LinkedIn's published date (`official`), or the first day its
 * one-year support policy allows the version to end (`policy`, counted from the first day of the month).
 * AMCP_LINKEDIN_API_VERSION, or a call's api_version, may name another version of this table (a rollback), never one
 * outside it.
 */
export interface LinkedInVersionEntry {
  version: string;
  sunset: string;
  basis: 'official' | 'policy';
  reviewed: string;
}
export const linkedinVersions: readonly LinkedInVersionEntry[] = [
  {version: '202609', sunset: '2027-09', basis: 'policy', reviewed: '2026-09-29'},
];
export const linkedinDefaultVersion = '202609';
/** A stored version inside this many days of its sunset is migrated to the default; the owner view raises an alarm. */
export const linkedinVersionAlarmDays = 90;
const day = 86400000;
/** The first instant a reviewed version is no longer sent, in UTC. */
export function linkedinSunsetTime(entry: LinkedInVersionEntry): number {
  return Date.parse((/^\d{4}-\d{2}$/.test(entry.sunset) ? entry.sunset + '-01' : entry.sunset) + 'T00:00:00Z');
}
const reviewed = (now: number) => linkedinVersions.filter(v => now < linkedinSunsetTime(v)).map(v => v.version);
const refusal = (value: string, now: number) => ({
  api_version: value,
  default_version: linkedinDefaultVersion,
  reviewed_versions: reviewed(now),
});
/**
 * The LinkedIn-Version AMCP sends: an explicit value (a call's api_version), else AMCP_LINKEDIN_API_VERSION, else the
 * default. Each must be a reviewed version before its sunset (`now`, injectable for tests); every other value is
 * refused before any request is built.
 */
export function linkedinVersion(explicit?: unknown, now = Date.now()): string {
  const value = explicit ?? process.env.AMCP_LINKEDIN_API_VERSION ?? linkedinDefaultVersion;
  if (typeof value !== 'string' || !/^20\d{2}(?:0[1-9]|1[0-2])$/.test(value))
    throw new MirrorError(
      'INVALID_API_VERSION',
      'LinkedIn-Version must be a monthly YYYYMM version. Verify that the chosen version is supported by LinkedIn.',
    );
  const entry = linkedinVersions.find(v => v.version === value);
  if (!entry)
    throw new MirrorError(
      'API_VERSION_UNREVIEWED',
      'This LinkedIn-Version is not one AMCP has reviewed. Omit api_version to send the reviewed default named in details.default_version.',
      refusal(value, now),
    );
  if (now >= linkedinSunsetTime(entry))
    throw new MirrorError(
      'API_VERSION_SUNSET',
      'This LinkedIn-Version has reached its sunset. Omit api_version to send the reviewed default named in details.default_version, and prepare a stored request again.',
      refusal(value, now),
    );
  return value;
}
/**
 * The version a listing, description or contract names: the version sent, or the reviewed default when the configured
 * version is refused. Describing never throws, so a clock past a sunset cannot take down the catalog of every gateway;
 * each LinkedIn request still refuses through linkedinVersion with the reason.
 */
export function linkedinDescribedVersion(now = Date.now()): string {
  try {
    return linkedinVersion(undefined, now);
  } catch {
    return linkedinDefaultVersion;
  }
}
/**
 * A version stored with a saved report or source (source_request.api_version) as AMCP sends it now: the stored version
 * while it is reviewed and outside its alarm window, otherwise the current version. A fresh read is never sent at a
 * version AMCP no longer reviews.
 */
export function linkedinStoredVersion(stored: unknown, now = Date.now()): string {
  const entry = linkedinVersions.find(v => v.version === stored);
  return entry && now < linkedinSunsetTime(entry) - linkedinVersionAlarmDays * day
    ? entry.version
    : linkedinVersion(undefined, now);
}
/**
 * The owner-operations view of the LinkedIn-Version configuration: the version sent, whether
 * AMCP_LINKEDIN_API_VERSION overrides the default, and an alarm within the alarm window or for an invalid value.
 */
export function linkedinVersionStatus(
  now = Date.now(),
  configured = process.env.AMCP_LINKEDIN_API_VERSION,
): JsonObject {
  let sent: string | undefined, problem: string | undefined;
  try {
    sent = linkedinVersion(configured, now);
  } catch (e) {
    problem = e instanceof MirrorError ? e.code : 'INVALID_API_VERSION';
  }
  const entry = linkedinVersions.find(v => v.version === sent),
    left = entry ? Math.ceil((linkedinSunsetTime(entry) - now) / day) : undefined;
  return {
    version: sent ?? null,
    default_version: linkedinDefaultVersion,
    reviewed_versions: reviewed(now),
    linkedin_version_override: configured === undefined ? null : configured,
    ...(problem ? {problem} : {}),
    ...(entry ? {sunset: entry.sunset, sunset_basis: entry.basis, days_left: left} : {}),
    alarm: !!problem || (left !== undefined && left <= linkedinVersionAlarmDays),
  };
}

// Captured catalog parity: the captured LinkedIn catalog and its three DESCRIBE_ACTION records report 202605, the
// version of the li-lms-2026-05 documentation snapshot they were generated from. They are listed at the version sent.
const currentRecord = (record: JsonObject): JsonObject =>
  record.api_version !== undefined ? {...record, api_version: linkedinDescribedVersion()} : record;
/** A captured LinkedIn LIST_ACTIONS page or DESCRIBE_ACTION response, as AMCP answers it at the version sent. */
export function currentLinkedInCapture(data: JsonObject): JsonObject {
  return Array.isArray(data.actions)
    ? {...data, api_version: linkedinDescribedVersion(), actions: data.actions.map((a: JsonObject) => currentRecord(a))}
    : currentRecord(data);
}
/** The captured catalog's LinkedIn action: its routes are unversioned (the version is a header), so it is unchanged. */
export const linkedinActionVersion = (a: Action): Action => a;
/** The captured LinkedIn tool definition (and its help copy), stating the version sent. Its schema shape is unchanged. */
export function extendLinkedInTool(original: ToolDefinition): ToolDefinition {
  const tool = structuredClone(original),
    v = linkedinDescribedVersion();
  const restate = (definition: JsonObject) => {
    if (typeof definition.description === 'string')
      definition.description = definition.description.replace(
        'generated from the local li-lms-2026-05 documentation snapshot:',
        'generated from the local li-lms-2026-05 documentation snapshot (AMCP sends LinkedIn-Version ' + v + '):',
      );
    const version = definition.inputSchema?.properties?.api_version;
    if (typeof version?.description === 'string')
      version.description =
        'Optional LinkedIn-Version override in YYYYMM format. Only a version AMCP has reviewed is accepted (' +
        reviewed(Date.now()).join(', ') +
        '); omit it to send ' +
        v +
        '.';
  };
  restate(tool as unknown as JsonObject);
  if (tool.help) restate(tool.help);
  return tool;
}
