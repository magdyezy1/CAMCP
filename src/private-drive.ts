import {mediaDeadlineMs, mediaTooLarge, readMediaBody, type MediaSink} from './media-buffer.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {MirrorError} from './errors.js';
import {driveDownloadUrl, mediaType, MAX_MEDIA_BYTES} from './drive-media.js';
import type {Actor, Connection} from './types.js';
import {providerById} from './provider-adapters.js';
/** Google Drive's gateway, its provider adapter's (src/provider-adapters.ts; ARC-01: this module names no gateway). */
export const driveGateway = providerById('drive')!.gateway;
const driveId = /^[A-Za-z0-9_-]{10,200}$/,
  mediaMimes = ['image/png', 'image/jpeg', 'video/mp4', 'video/quicktime'],
  folderMime = 'application/vnd.google-apps.folder',
  /** Files listed from one folder at most (five Drive pages). */
  folderLimit = 500;
/** Whether a Drive login's granted scopes let it download the files it selected. */
const canDownload = (c: Connection) =>
  c.scopes.some(s =>
    [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
    ].includes(s),
  );
/**
 * The Drive login that selected this file or folder, with a scope that can download it. Selecting a folder in the
 * login grants the media files directly inside it; each is checked against Drive's own parents before download.
 */
function selected(store: Store, actor: Actor, connection: string, id: string): Connection {
  store.assertActorActive(actor);
  const c = store.resolveConnection(actor, driveGateway, id, connection);
  if (!canDownload(c))
    throw new MirrorError('DRIVE_SCOPE_REQUIRED', 'Reconnect Drive with permission to download selected files.');
  return c;
}
/**
 * Whether `connection` still selects `id` (the file, or the folder an import came through) with a scope that can
 * download it: the check every Drive download makes, without resolving or throwing. It only describes an imported
 * copy as "Drive access since revoked" (MED-05); the copy itself is frozen and never rechecked (owner decision D23).
 */
export function driveSelectionHeld(connection: Connection | undefined, id: string): boolean {
  return (
    connection?.gateway === driveGateway &&
    connection.enabled &&
    connection.accounts.includes(id) &&
    canDownload(connection)
  );
}
export function driveAccess(store: Store, actor: Actor, connection: string, url: string) {
  const fileId = driveDownloadUrl(url).searchParams.get('id')!;
  return {c: selected(store, actor, connection, fileId), fileId};
}
function validId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !driveId.test(id))
    throw new MirrorError('INVALID_DRIVE_ID', 'Use the Drive ID of a ' + what + ' selected in this Drive login.');
  return id;
}
async function bounded(response: Response, limit: number) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new MirrorError('DRIVE_FILE_UNAVAILABLE', 'Drive refused the download or the file exceeds its size limit.', {
      http_status: response.status,
    });
  }
  const reader = response.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new MirrorError('MEDIA_TOO_LARGE', 'The Drive response exceeded its size limit.');
        }
        chunks.push(value);
      }
  } finally {
    reader?.releaseLock();
  }
  return Buffer.concat(chunks);
}
const options = (token: string | undefined, extra: Record<string, string> = {}): RequestInit => {
  if (!token) throw new MirrorError('REAUTHORIZATION_REQUIRED', 'Reconnect Google Drive.', {}, 401);
  return {
    method: 'GET',
    headers: {Authorization: 'Bearer ' + token, ...extra},
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
  };
};
/**
 * Downloads one Drive file for the member. `grant` is what the login selected: the file itself, or the folder that
 * holds it, in which case Drive's metadata must list that folder among the file's parents. The grant is checked again
 * after each step, so revoking it mid-download stops the import.
 */
async function download(
  store: Store,
  credentials: CredentialProvider,
  actor: Actor,
  connection: string,
  fileId: string,
  folderId: string | undefined,
  resourceKey: string | null,
  fetcher: typeof fetch,
  sink?: MediaSink,
) {
  const recheck = () => selected(store, actor, connection, folderId ?? fileId),
    auth = await credentials.get(recheck());
  recheck();
  const request = options(
    auth.accessToken,
    resourceKey ? {'X-Goog-Drive-Resource-Keys': fileId + '/' + resourceKey} : {},
  );
  const url = new URL('https://www.googleapis.com/drive/v3/files/' + fileId);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id,name,mimeType,size,capabilities(canDownload)' + (folderId ? ',parents' : ''));
  const metadata = JSON.parse((await bounded(await fetcher(url, request), 65536)).toString('utf8'));
  if (folderId && !(Array.isArray(metadata.parents) && metadata.parents.includes(folderId)))
    throw new MirrorError('DRIVE_DOWNLOAD_FORBIDDEN', 'This file is not in the selected folder.');
  if (metadata.id !== fileId || metadata.capabilities?.canDownload !== true || !mediaMimes.includes(metadata.mimeType))
    throw new MirrorError(
      'DRIVE_DOWNLOAD_FORBIDDEN',
      'Select a downloadable PNG, JPEG, MP4 or MOV file in the connected Drive account.',
    );
  if (!/^\d+$/.test(metadata.size))
    throw new MirrorError(
      'MEDIA_TOO_LARGE',
      'Drive media must be at most the configured media limit (128 MiB by default).',
    );
  // The size is Drive's own, before any byte is downloaded: the refusal states it and the maximum (r25-media-drive-large).
  if (Number(metadata.size) > MAX_MEDIA_BYTES) throw mediaTooLarge(MAX_MEDIA_BYTES, Number(metadata.size));
  recheck();
  url.searchParams.delete('fields');
  url.searchParams.set('alt', 'media');
  // The metadata keeps its 45 seconds; the file is bounded by what the media limit gives, and by the idle time while it is
  // read (r25-media-drive-large, lead decision 2026-11-19).
  const signal = AbortSignal.timeout(mediaDeadlineMs(MAX_MEDIA_BYTES)),
    media = await fetcher(url, {...request, signal});
  if (!media.ok) {
    await media.body?.cancel();
    throw new MirrorError('DRIVE_FILE_UNAVAILABLE', 'Drive refused the file download.', {http_status: media.status});
  }
  const bytes = await readMediaBody(media, MAX_MEDIA_BYTES, sink, {signal});
  recheck();
  const type = mediaType(bytes);
  if (bytes.length !== Number(metadata.size) || type.mime !== metadata.mimeType)
    throw new MirrorError('MEDIA_CHANGED', 'The file changed during download. Prepare it again.');
  return {bytes, ...type, name: typeof metadata.name === 'string' ? metadata.name : undefined};
}
/** A private Drive file named by its share link; the file itself must be selected in the login. */
export async function downloadPrivateDrive(
  store: Store,
  credentials: CredentialProvider,
  actor: Actor,
  connection: string,
  source: string,
  fetcher: typeof fetch = fetch,
  sink?: MediaSink,
) {
  const link = driveDownloadUrl(source);
  return download(
    store,
    credentials,
    actor,
    connection,
    link.searchParams.get('id')!,
    undefined,
    link.searchParams.get('resourcekey'),
    fetcher,
    sink,
  );
}
/** A private Drive file by its ID: selected itself, or directly inside a folder selected in the login. */
export async function downloadDriveFile(
  store: Store,
  credentials: CredentialProvider,
  actor: Actor,
  connection: string,
  fileId: unknown,
  folderId: unknown,
  fetcher: typeof fetch = fetch,
  sink?: MediaSink,
) {
  const file = validId(fileId, 'file'),
    folder = folderId === undefined || folderId === null || folderId === '' ? undefined : validId(folderId, 'folder');
  return download(store, credentials, actor, connection, file, folder, null, fetcher, sink);
}
/**
 * The downloadable PNG, JPEG, MP4 and MOV files directly inside a folder selected in the login (Drive v3 files.list,
 * "'<folder>' in parents"), at most 500. Subfolders are not opened: select one to use its files.
 */
export async function listDriveFolder(
  store: Store,
  credentials: CredentialProvider,
  actor: Actor,
  connection: string,
  folderId: unknown,
  fetcher: typeof fetch = fetch,
) {
  const folder = validId(folderId, 'folder'),
    recheck = () => selected(store, actor, connection, folder),
    auth = await credentials.get(recheck());
  recheck();
  const request = options(auth.accessToken);
  const meta = new URL('https://www.googleapis.com/drive/v3/files/' + folder);
  meta.searchParams.set('supportsAllDrives', 'true');
  meta.searchParams.set('fields', 'id,name,mimeType');
  const info = JSON.parse((await bounded(await fetcher(meta, request), 65536)).toString('utf8'));
  if (info.id !== folder || info.mimeType !== folderMime)
    throw new MirrorError('DRIVE_FOLDER_REQUIRED', 'This Drive item is not a folder. Import it as a file instead.');
  const files: {id: string; name: string; mime: string; size: number}[] = [];
  let pageToken: string | undefined,
    truncated = false;
  for (let page = 0; ; page++) {
    recheck();
    const list = new URL('https://www.googleapis.com/drive/v3/files');
    list.searchParams.set(
      'q',
      "'" +
        folder +
        "' in parents and trashed = false and (" +
        mediaMimes.map(m => "mimeType = '" + m + "'").join(' or ') +
        ')',
    );
    list.searchParams.set(
      'fields',
      'nextPageToken,incompleteSearch,files(id,name,mimeType,size,capabilities(canDownload))',
    );
    list.searchParams.set('pageSize', '100');
    list.searchParams.set('supportsAllDrives', 'true');
    list.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) list.searchParams.set('pageToken', pageToken);
    const d = JSON.parse((await bounded(await fetcher(list, request), 4 * 1024 * 1024)).toString('utf8'));
    if (d.incompleteSearch === true)
      throw new MirrorError('DRIVE_LIST_INCOMPLETE', 'Drive could not list the whole folder. Try again.', {}, 502);
    for (const x of Array.isArray(d.files) ? d.files : [])
      if (
        typeof x?.id === 'string' &&
        driveId.test(x.id) &&
        mediaMimes.includes(x.mimeType) &&
        x.capabilities?.canDownload === true &&
        /^\d+$/.test(String(x.size ?? '')) &&
        Number(x.size) <= MAX_MEDIA_BYTES
      )
        files.push({id: x.id, name: String(x.name ?? x.id).slice(0, 200), mime: x.mimeType, size: Number(x.size)});
    pageToken = typeof d.nextPageToken === 'string' && d.nextPageToken ? d.nextPageToken : undefined;
    if (!pageToken) break;
    if (files.length >= folderLimit || page >= 4) {
      truncated = true;
      break;
    }
  }
  recheck();
  return {
    folder: {id: folder, name: typeof info.name === 'string' ? info.name : folder},
    files: files.slice(0, folderLimit),
    truncated: truncated || files.length > folderLimit,
  };
}
