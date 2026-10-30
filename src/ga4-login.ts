import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import {MirrorError} from './errors.js';
import {collectMeasurementAssets} from './google-measurement-assets.js';
import {googleOAuth} from './google-oauth.js';

/**
 * Google Analytics 4's website login steps (ARC-01 phase B; registered in src/provider-logins.ts). Discovery: the
 * login's properties, with the collector the MCP sync_assets workflow uses, and the data streams of the selected
 * properties with their type and web measurement ID. It authorizes with Google's OAuth steps (src/google-oauth.ts), by
 * default with the shared Google client.
 */
async function ga4Discovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'properties')
    return (
      await collectMeasurementAssets(c.connection.gateway, c.read, {
        maxPages: 25,
        deadline: performance.now() + 60000,
      })
    ).assets;
  const assets: WorkspaceAsset[] = [];
  if (!c.connection.accounts.length)
    throw new MirrorError('SELECT_ACCOUNT_FIRST', 'Select GA4 properties before syncing their data streams.', {}, 409);
  for (const id of c.connection.accounts) {
    if (!/^\d+$/.test(id))
      throw new MirrorError('ASSET_ID_INVALID', 'GA4 property identifiers must be numeric.', {}, 400);
    const rows = await c.pages(
      '/v1beta/properties/' + id + '/dataStreams',
      {pageSize: 200},
      d => d.dataStreams ?? [],
      'https://analyticsadmin.googleapis.com',
    );
    for (const row of rows) {
      if (typeof row.name !== 'string' || !new RegExp('^properties/' + id + '/dataStreams/\\d+$').test(row.name))
        throw new MirrorError('ASSET_ID_INVALID', 'GA4 returned a data stream outside the selected property.', {}, 502);
      // MSR-03: keep the stream type and web measurement ID so Measurement can check a trace's stream and
      // relate Google tags to streams without another request. Malformed values are left out, not guessed.
      const type =
          typeof row.type === 'string' &&
          ['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'].includes(row.type)
            ? row.type
            : undefined,
        measurementId = row.webStreamData?.measurementId;
      assets.push({
        ...c.asset({id: row.name, name: row.displayName}, kind, id),
        ...(type ? {streamType: type} : {}),
        ...(type === 'WEB_DATA_STREAM' && typeof measurementId === 'string' && /^G-[A-Z0-9]{4,20}$/.test(measurementId)
          ? {measurementId}
          : {}),
      });
    }
  }
  return assets;
}

export const ga4Login: ProviderLogin = Object.freeze({
  gateway: 'ga4_native_action',
  oauth: googleOAuth,
  discovery: Object.freeze({kind: ga4Discovery}),
});
