import {MirrorError} from './errors.js';
import {fingerprint} from './workspace-core.js';
import type {JsonObject} from './types.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
type Setting = 'notSet' | 'notNeeded' | 'needed' | 'unknown';
function setting(value: unknown): {
  setting: Setting;
  required_types: string[] | null;
  setting_source: string;
  reason: string | null;
} {
  const unknown = (reason: string) => ({
    setting: 'unknown' as const,
    required_types: null,
    setting_source: 'native',
    reason,
  });
  if (value === undefined)
    return {setting: 'notSet', required_types: [], setting_source: 'default_when_omitted', reason: null};
  if (!object(value)) return unknown('unrecognized_setting');
  const status = value.consentStatus ?? (value.consentStatus === undefined ? 'notSet' : null);
  if (!['notSet', 'notNeeded', 'needed'].includes(status)) return unknown('unrecognized_setting');
  if (status !== 'needed')
    return {
      setting: status,
      required_types: [],
      setting_source: value.consentStatus === undefined ? 'default_when_omitted' : 'native',
      reason: null,
    };
  const types = value.consentType;
  if (!object(types) || types.type !== 'list' || !Array.isArray(types.list) || !types.list.length)
    return unknown('missing_required_types');
  // Interpret only bounded literal list parameters. Never resolve GTM variables or guess future encodings.
  if (types.list.length > 20 || Object.keys(types).some(key => !['type', 'key', 'list'].includes(key)))
    return unknown('unresolved_types');
  const names: string[] = [];
  for (const item of types.list) {
    if (
      !object(item) ||
      item.type !== 'template' ||
      Object.keys(item).some(key => !['type', 'key', 'value'].includes(key)) ||
      typeof item.value !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(item.value) ||
      names.includes(item.value)
    )
      return unknown('unresolved_types');
    names.push(item.value);
  }
  return {setting: 'needed', required_types: names, setting_source: 'native', reason: null};
}

/** The consent types Google documents for consent mode (developers.google.com/tag-platform/security/guides/consent,
 * accessed 2026-10-08). Any other literal is a non-standard type: no consent platform grants a misspelling (MSR-01). */
export const gtmDocumentedConsentTypes: readonly string[] = Object.freeze([
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
]);
export const gtmNonStandardConsentTypes = (types: string[]): string[] =>
  types.filter(type => !gtmDocumentedConsentTypes.includes(type));

const nativeId = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Selected workspace or published-version configuration, not built-in checks or runtime consent verification.
 * A workspace scope requires each tag's exact workspace path. A version scope (MSR-01) is the container's published
 * version the audit already read: its tags must name the same account and container, a native path (when present)
 * must end in the tag's own ID, and identities stay unique and bounded. A version tag's path is not assumed.
 */
export function gtmConsentEvidence(
  scope: JsonObject,
  tags: JsonObject[],
  kind: 'workspace' | 'version' = 'workspace',
): JsonObject {
  const version = kind === 'version',
    parts = typeof scope.path === 'string' && scope.path.length <= 512 ? scope.path.split('/') : [],
    shaped =
      parts.length === 6 &&
      parts[0] === 'accounts' &&
      parts[2] === 'containers' &&
      parts[4] === (version ? 'versions' : 'workspaces') &&
      [parts[1], parts[3], parts[5]].every(value => /^[A-Za-z0-9_-]+$/.test(value!));
  if (!shaped || (version && scope.containerVersionId !== parts[5]) || !Array.isArray(tags) || tags.length > 1000)
    throw new MirrorError('STATE_TOO_LARGE', 'Consent evidence exceeds the workspace scope or tag bound.');
  const container = parts.slice(0, 4).join('/');
  const versionTag = (tag: JsonObject) => {
    if (tag.accountId !== undefined && tag.accountId !== parts[1]) return false;
    if (tag.containerId !== undefined && tag.containerId !== parts[3]) return false;
    if (tag.path === undefined) return true;
    if (typeof tag.path !== 'string' || !tag.path.startsWith(container + '/')) return false;
    const rest = tag.path.slice(container.length + 1).split('/');
    return (
      rest.length === 4 &&
      ['workspaces', 'versions'].includes(rest[0]!) &&
      /^[A-Za-z0-9_-]+$/.test(rest[1]!) &&
      rest[2] === 'tags' &&
      rest[3] === tag.tagId
    );
  };
  const seen = new Set<string>(),
    counts = {notSet: 0, notNeeded: 0, needed: 0, unknown: 0};
  const rows = tags.map(tag => {
    if (
      !object(tag) ||
      typeof tag.tagId !== 'string' ||
      !nativeId.test(tag.tagId) ||
      !(version ? versionTag(tag) : tag.path === scope.path + '/tags/' + tag.tagId) ||
      seen.has(tag.tagId)
    )
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Consent evidence has foreign, duplicate or ambiguous tag identity.',
      );
    seen.add(tag.tagId);
    const consent = setting(tag.consentSettings);
    counts[consent.setting]++;
    return {
      path: typeof tag.path === 'string' ? tag.path : null,
      tag_id: tag.tagId,
      name: typeof tag.name === 'string' ? tag.name : null,
      type: typeof tag.type === 'string' ? tag.type : null,
      paused: typeof tag.paused === 'boolean' ? tag.paused : null,
      ...consent,
    };
  });
  const selected = version
    ? {
        version_path: scope.path,
        version_id: scope.containerVersionId,
        version_fingerprint: typeof scope.fingerprint === 'string' ? scope.fingerprint : null,
        rows,
      }
    : {
        workspace_path: scope.path,
        workspace_fingerprint: typeof scope.fingerprint === 'string' ? scope.fingerprint : null,
        rows,
      };
  if (Buffer.byteLength(JSON.stringify(selected)) > 4 * 1024 * 1024)
    throw new MirrorError('STATE_TOO_LARGE', 'Consent evidence exceeds the selected metadata byte bound.');
  return {
    version: 1,
    scope: version ? 'published_version_configuration' : 'workspace_configuration',
    ...selected,
    configuration_hash: fingerprint(selected),
    tag_count: rows.length,
    counts,
    checks: {
      built_in_consent: 'unverified',
      consent_defaults: 'unverified',
      consent_updates: 'unverified',
      runtime_order: 'unverified',
      event_delivery: 'unverified',
    },
  };
}

/**
 * Draft workspace versus published version per tag ID, from evidence the audit already read (MSR-01). Required types
 * compare as sets. Either side unknown stays unknown; a tag on one side only is reported as such. This makes no
 * request and does not establish which version a site serves or how consent behaves at runtime.
 */
export function gtmConsentDiff(draft: JsonObject, live: JsonObject): JsonObject {
  const side = (row: JsonObject | undefined) =>
    row ? {setting: row.setting, required_types: row.required_types === null ? null : [...row.required_types]} : null;
  const draftRows = new Map<string, JsonObject>(draft.rows.map((row: JsonObject) => [row.tag_id, row])),
    liveRows = new Map<string, JsonObject>(live.rows.map((row: JsonObject) => [row.tag_id, row])),
    counts = {same: 0, differs: 0, draft_only: 0, live_only: 0, unknown: 0};
  const rows = [...new Set([...draftRows.keys(), ...liveRows.keys()])].map(id => {
    const d = draftRows.get(id),
      l = liveRows.get(id);
    const state: keyof typeof counts = !l
      ? 'draft_only'
      : !d
        ? 'live_only'
        : d.setting === 'unknown' || l.setting === 'unknown'
          ? 'unknown'
          : d.setting === l.setting &&
              d.required_types.length === l.required_types.length &&
              d.required_types.every((type: string) => l.required_types.includes(type))
            ? 'same'
            : 'differs';
    counts[state]++;
    return {tag_id: id, name: d?.name ?? l?.name ?? null, draft: side(d), live: side(l), state};
  });
  return {
    version: 1,
    draft_workspace_path: draft.workspace_path,
    live_version_id: live.version_id,
    rows,
    counts,
    network_requests: 0,
  };
}
