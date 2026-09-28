import {MirrorError} from './errors.js';
import type {Action, JsonObject} from './types.js';

/**
 * The Meta Graph API version AMCP sends requests to: v26.0 since 2026-09-28 (the owner's decision to upgrade the
 * provider APIs). The captured Meta catalog recorded its routes at v25.0; the registry moves them to this version.
 * Evidence: Meta's official Python Business SDK at 25.0.3 and 26.0.2 (docs/implementation/META-V26-2026-09-28.md).
 * AMCP_META_API_VERSION=v25.0 moves every request back without a code change, should v26.0 misbehave in production.
 * No other version is accepted: AMCP holds evidence for these two only.
 */
export const metaApiVersions = ['v25.0', 'v26.0'];
export function resolveMetaVersion(value: unknown = process.env.AMCP_META_API_VERSION): string {
  const version = value ?? 'v26.0';
  if (typeof version !== 'string' || !metaApiVersions.includes(version))
    throw new MirrorError(
      'INVALID_API_VERSION',
      'AMCP_META_API_VERSION must be ' +
        metaApiVersions.join(' or ') +
        ', the Graph API versions AMCP has evidence for.',
    );
  return version;
}
export const metaApiVersion = resolveMetaVersion();
/** The prefix of every Graph API path at the current version: metaPrefix + 'act_1/campaigns'. */
export const metaPrefix = '/' + metaApiVersion + '/';
/** A Graph API route at the current version, for recognising requests: metaRoute('act_[0-9]+/adimages$'). */
export const metaRoute = (rest: string) => new RegExp('^' + metaPrefix.replaceAll('.', '\\.') + rest);
/** A Graph API URL at the current version: metaGraphUrl('oauth/access_token'). */
export const metaGraphUrl = (rest: string) => 'https://graph.facebook.com' + metaPrefix + rest;
/** The Facebook Login dialog of the current version. */
export const metaDialogUrl = 'https://www.facebook.com' + metaPrefix + 'dialog/oauth';
/** A recorded Graph API path or URL moved to the current version (Graph versions are vN.0). */
export const currentMetaPath = (path: string) =>
  path.replace(/^((?:https:\/\/graph\.facebook\.com)?\/)v\d+\.0(?=\/|$)/, '$1' + metaApiVersion);
/** A captured Meta catalog record or description (as the catalog lists it) at the current version. */
export function currentMetaRecord(record: JsonObject): JsonObject {
  return {
    ...record,
    ...(record.api_version !== undefined ? {api_version: metaApiVersion} : {}),
    ...(typeof record.path === 'string' ? {path: currentMetaPath(record.path)} : {}),
  };
}
/** A captured Meta LIST_ACTIONS page or DESCRIBE_ACTION response, as AMCP answers it at the current version. */
export function currentMetaCapture(data: JsonObject): JsonObject {
  return Array.isArray(data.actions)
    ? {...data, api_version: metaApiVersion, actions: data.actions.map((a: JsonObject) => currentMetaRecord(a))}
    : currentMetaRecord(data);
}
/** The captured catalog's Meta action at the current version, listed as it is sent. */
export function metaActionVersion(a: Action): Action {
  return {...a, ...(a.path ? {path: currentMetaPath(a.path)} : {}), raw: currentMetaRecord(a.raw)};
}
