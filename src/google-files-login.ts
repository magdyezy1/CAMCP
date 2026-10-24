import type {DiscoveryContext, ProviderLogin, WorkspaceAsset} from './provider-login.js';
import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * The website login steps of Google's file platforms (ARC-01 phase B; registered in src/provider-logins.ts): Google
 * Sheets, a report destination, and Google Drive, a private media source. Neither is an advertising account, and both
 * authorize with the shared Google OAuth client without a step of their own. Discovery: the spreadsheets a login may
 * edit, and Drive's media files and folders.
 */

/**
 * The spreadsheets the login can edit that drive.file lists, and the selected spreadsheets the Sheets grant reaches
 * outside that listing, each confirmed by its own read.
 */
async function sheetsDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  const rows = await c.pages(
    '/drive/v3/files',
    {
      q: "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
      pageSize: 100,
      fields: 'nextPageToken,incompleteSearch,files(id,name,capabilities(canEdit))',
    },
    d => {
      if (d.incompleteSearch) throw new MirrorError('ASSET_SYNC_INCOMPLETE', 'Spreadsheet discovery is incomplete.');
      return d.files ?? [];
    },
  );
  const assets = rows.filter(r => r.capabilities?.canEdit === true).map(r => c.asset(r, kind));
  // URL-selected spreadsheets can be outside drive.file's listing but inside the Sheets grant.
  if (c.connection.scopes.includes('https://www.googleapis.com/auth/spreadsheets'))
    for (const id of c.connection.accounts.filter(id => !assets.some(a => a.id === id))) {
      if (!/^[A-Za-z0-9_-]{5,180}$/.test(id))
        throw new MirrorError('ASSET_ID_INVALID', 'Invalid selected spreadsheet identifier.');
      const {data} = await c.request({
        ...c.plan('/v4/spreadsheets/' + id, {fields: 'spreadsheetId,properties(title)'}),
        origin: 'https://sheets.googleapis.com',
      });
      const sheet = data as JsonObject;
      if (sheet.spreadsheetId !== id || typeof sheet.properties?.title !== 'string')
        throw new MirrorError('ASSET_RESPONSE_INVALID', 'Google did not confirm a selected spreadsheet.', {}, 502);
      assets.push(c.asset({id, name: sheet.properties.title}, kind));
    }
  return assets;
}

/**
 * Drive's folders, a selected one granting the media files directly inside it (src/private-drive.ts checks each
 * file's parents), and its downloadable PNG, JPEG, MP4 and QuickTime files.
 */
async function driveDiscovery(kind: string, c: DiscoveryContext): Promise<WorkspaceAsset[]> {
  if (kind === 'folders') {
    const rows = await c.pages(
      '/drive/v3/files',
      {
        q: "trashed = false and mimeType = 'application/vnd.google-apps.folder'",
        pageSize: 100,
        fields: 'nextPageToken,incompleteSearch,files(id,name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
      d => {
        if (d.incompleteSearch === true)
          throw new MirrorError('ASSET_SYNC_INCOMPLETE', 'Drive search was incomplete. Narrow the connected login.');
        return d.files ?? [];
      },
    );
    return rows.map(r => c.asset(r, kind));
  }
  const rows = await c.pages(
    '/drive/v3/files',
    {
      q: "trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg' or mimeType = 'video/mp4' or mimeType = 'video/quicktime')",
      pageSize: 100,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,capabilities(canDownload))',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
    d => {
      if (d.incompleteSearch === true)
        throw new MirrorError('ASSET_SYNC_INCOMPLETE', 'Drive search was incomplete. Narrow the connected login.');
      return d.files ?? [];
    },
  );
  return rows.filter(r => r.capabilities?.canDownload === true).map(r => c.asset(r, kind));
}

export const googleSheetsLogin: ProviderLogin = Object.freeze({
  gateway: 'google_sheets_native_action',
  discovery: Object.freeze({kind: sheetsDiscovery}),
});
export const googleDriveLogin: ProviderLogin = Object.freeze({
  gateway: 'google_drive_native_action',
  discovery: Object.freeze({kind: driveDiscovery}),
});
