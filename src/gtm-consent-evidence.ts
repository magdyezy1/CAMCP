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

/** Selected workspace configuration, not built-in checks, a published snapshot or runtime consent verification. */
export function gtmConsentEvidence(workspace: JsonObject, tags: JsonObject[]): JsonObject {
  if (
    typeof workspace.path !== 'string' ||
    workspace.path.length > 512 ||
    !/^accounts\/[A-Za-z0-9_-]+\/containers\/[A-Za-z0-9_-]+\/workspaces\/[A-Za-z0-9_-]+$/.test(workspace.path) ||
    !Array.isArray(tags) ||
    tags.length > 1000
  )
    throw new MirrorError('STATE_TOO_LARGE', 'Consent evidence exceeds the workspace scope or tag bound.');
  const seen = new Set<string>(),
    counts = {notSet: 0, notNeeded: 0, needed: 0, unknown: 0};
  const rows = tags.map(tag => {
    if (
      !object(tag) ||
      typeof tag.tagId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(tag.tagId) ||
      tag.path !== workspace.path + '/tags/' + tag.tagId ||
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
      path: tag.path,
      tag_id: tag.tagId,
      name: typeof tag.name === 'string' ? tag.name : null,
      type: typeof tag.type === 'string' ? tag.type : null,
      paused: typeof tag.paused === 'boolean' ? tag.paused : null,
      ...consent,
    };
  });
  const selected = {
    workspace_path: workspace.path,
    workspace_fingerprint: typeof workspace.fingerprint === 'string' ? workspace.fingerprint : null,
    rows,
  };
  if (Buffer.byteLength(JSON.stringify(selected)) > 4 * 1024 * 1024)
    throw new MirrorError('STATE_TOO_LARGE', 'Consent evidence exceeds the selected metadata byte bound.');
  return {
    version: 1,
    scope: 'workspace_configuration',
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
