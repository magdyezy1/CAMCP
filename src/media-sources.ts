import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import {MAX_MEDIA_BYTES, mediaType} from './drive-media.js';
import {jpegOrientation, orientationFilter} from './image-header.js';
import {downloadMediaLink, type LinkRequest} from './media-link.js';
import {convertMedia, ffprobeJson, withMediaDirectory, type MediaFileType} from './media-variants.js';
import {sha256} from './security.js';
import {RetainedMedia, retainedMediaId} from './retained-media.js';
import {ownerAccess, workspaceOwner} from './spend-policy.js';
import {assertWritesNotPaused, writePause} from './owner-operations.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import type {MediaSink} from './media-buffer.js';

/** Private Drive access for imports: a file (selected, or inside a selected folder) and a selected folder's files. */
export interface DriveImports {
  download(
    actor: Actor,
    connection: string,
    fileId: unknown,
    folderId: unknown,
    sink: MediaSink,
  ): Promise<{bytes: Buffer; name?: string}>;
  list(actor: Actor, connection: string, folderId: unknown): Promise<JsonObject>;
}

/** Upload parts are 1 MiB, so each arrives within the server's 45-second request limit on an uplink of 25 KB/s. */
export const SOURCE_CHUNK_BYTES = 1024 * 1024;
/** How long an uploaded file waits to be pushed. */
export const SOURCE_TTL_MS = 30 * 60 * 1000;
const kind = 'media_source',
  sourceId = /^src-[0-9a-f-]{36}$/,
  notMedia = 'This file is not a PNG, JPEG, MP4 or MOV file.',
  uploadTypes = ['image/png', 'image/jpeg', 'video/mp4', 'video/quicktime'];

/** A file name as people see it: its last path segment, without control characters, at most 120 characters. */
const displayName = (value: unknown) =>
  String(value ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 120) || 'upload';

/**
 * Media files brought into AMCP without Google Drive: uploaded from the website in 1 MiB parts, or imported from a
 * public HTTPS link. Each is held encrypted in the same staging as reviews for 30 minutes, so one file can be pushed to
 * several advertising accounts (amcp_media prepare with `source_id`). An upload belongs to the member who made it;
 * workspace administrators can use every upload of the workspace. An owner may explicitly copy one completed
 * original into separate encrypted retention; the temporary file's expiry is unchanged.
 */
export class MediaSources {
  private retained: RetainedMedia;
  constructor(
    private store: Store,
    private allowWrites: boolean,
    private linkRequest?: LinkRequest,
    private drive?: DriveImports,
  ) {
    this.retained = new RetainedMedia(store);
  }
  private uploader(actor: Actor) {
    this.store.assertActorActive(actor);
    if (!this.allowWrites)
      throw new MirrorError('LIVE_WRITES_DISABLED', 'Media uploads are disabled in this deployment.', {}, 403);
    if (actor.role === 'reader')
      throw new MirrorError('FORBIDDEN', 'An operator or administrator uploads media.', {}, 403);
  }
  private record(actor: Actor, id: unknown): JsonObject {
    this.store.assertActorActive(actor);
    if (typeof id !== 'string' || (!sourceId.test(id) && !retainedMediaId.test(id)))
      throw new MirrorError('INVALID_MEDIA_SOURCE', 'Use a source_id returned by an upload or a link import.');
    let r: JsonObject;
    try {
      r = this.store.document(actor.tenantId, retainedMediaId.test(id) ? 'retained_media_source' : kind, id);
    } catch (e) {
      if (e instanceof MirrorError && e.code === 'NOT_FOUND') throw gone();
      throw e;
    }
    if (r.user_id !== actor.userId && actor.role !== 'admin')
      throw new MirrorError('FORBIDDEN', 'This upload belongs to another member of the workspace.', {}, 403);
    if (retainedMediaId.test(id)) {
      if (r.state !== 'complete' || r.expires_at !== null || r.retained !== true)
        throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The retained original has invalid source metadata.');
    } else if (r.expires_at <= Date.now()) throw gone();
    return r;
  }
  private view(r: JsonObject, actor: Actor): JsonObject {
    const retained = retainedMediaId.test(r.id),
      owner = workspaceOwner(this.store, actor);
    return {
      source_id: r.id,
      filename: r.filename,
      state: r.state,
      origin: r.origin,
      size: r.size,
      uploaded_at: new Date(r.created_at).toISOString(),
      expires_at: retained ? null : new Date(r.expires_at).toISOString(),
      retained,
      can_retain:
        !retained && r.state === 'complete' && owner && this.allowWrites && !writePause(this.store, actor.tenantId),
      can_remove_retained: retained && owner,
      ...(retained
        ? {
            retention: {
              mode: 'until_removed',
              retained_at: new Date(r.retained_at).toISOString(),
              retained_by: r.retained_by,
              original_source_id: r.original_source_id,
            },
          }
        : {}),
      ...(r.link_host ? {link_host: r.link_host} : {}),
      ...(r.state === 'receiving'
        ? {chunk_bytes: r.chunk_bytes, chunks: r.chunks}
        : {
            mime: r.mime,
            kind: r.kind,
            sha256: r.sha256,
            width: r.width ?? null,
            height: r.height ?? null,
            duration: r.duration ?? null,
            inspection: r.inspection,
            thumbnail_url: r.thumbnail ? '/api/media/sources/' + r.id + '/thumbnail' : null,
            next_call: {tool: 'amcp_media', arguments: {action: 'prepare', source_id: r.id, fit_to_platform: true}},
            next_step:
              'Add platform and account_id (and connection_id when several logins cover the account) to prepare a reviewed upload.',
          }),
    };
  }
  /** Starts an upload of `size` bytes; the parts follow with `put`, then `complete`. */
  begin(actor: Actor, input: JsonObject) {
    this.uploader(actor);
    const size = input?.size;
    if (!Number.isSafeInteger(size) || size < 1)
      throw new MirrorError('INVALID_MEDIA_UPLOAD', 'State the file size in bytes.');
    if (size > MAX_MEDIA_BYTES)
      throw new MirrorError('MEDIA_TOO_LARGE', 'Media must be at most the configured media limit.', {
        maximum_bytes: MAX_MEDIA_BYTES,
      });
    if (![undefined, ''].includes(input.type) && !uploadTypes.includes(input.type))
      throw new MirrorError('MEDIA_TYPE_UNSUPPORTED', 'Upload a PNG, JPEG, MP4 or MOV file.');
    const id = 'src-' + randomUUID(),
      now = Date.now(),
      record = {
        user_id: actor.userId,
        filename: displayName(input.filename),
        origin: 'upload',
        state: 'receiving',
        size,
        chunk_bytes: SOURCE_CHUNK_BYTES,
        chunks: Math.ceil(size / SOURCE_CHUNK_BYTES),
        created_at: now,
        expires_at: now + SOURCE_TTL_MS,
      };
    this.store.reserveMediaSource(actor.tenantId, id, record.expires_at);
    this.store.putDocument(actor.tenantId, kind, id, record);
    return this.view({...record, id}, actor);
  }
  /** The exact length part `index` must have, after checking the upload is the actor's and still receiving. */
  partLength(actor: Actor, id: unknown, index: number): number {
    this.uploader(actor);
    const r = this.record(actor, id);
    if (r.state !== 'receiving')
      throw new MirrorError('MEDIA_UPLOAD_COMPLETE', 'This upload is already complete.', {}, 409);
    if (!Number.isSafeInteger(index) || index < 0 || index >= r.chunks)
      throw new MirrorError('INVALID_MEDIA_UPLOAD', 'This upload has parts 0 to ' + (r.chunks - 1) + '.');
    return index < r.chunks - 1 ? r.chunk_bytes : r.size - r.chunk_bytes * (r.chunks - 1);
  }
  /** Stores part `index`; sending a part again replaces it. */
  put(actor: Actor, id: unknown, index: number, bytes: Buffer) {
    const length = this.partLength(actor, id, index);
    if (bytes.length !== length)
      throw new MirrorError('INVALID_MEDIA_UPLOAD', 'Part ' + index + ' must be exactly ' + length + ' bytes.');
    this.store.putMediaChunk(actor.tenantId, id as string, index, bytes, SOURCE_CHUNK_BYTES);
    return {source_id: id, received: index};
  }
  /** Checks every part arrived and the file is PNG, JPEG, MP4 or MOV, then reads its size and a small preview frame. */
  async complete(actor: Actor, id: unknown) {
    this.uploader(actor);
    const r = this.record(actor, id);
    if (r.state === 'complete') return this.view(r, actor);
    const tenant = actor.tenantId,
      digest = this.store.finalizeMediaChunks(tenant, r.id, {
        chunks: r.chunks,
        size: r.size,
        chunkBytes: r.chunk_bytes,
      });
    try {
      const first = this.store.stagedMediaChunk(tenant, r.id, 0),
        type = mediaType(first, notMedia),
        facts = await this.inspect(tenant, r.id, type, first, async file => {
          const handle = await fs.open(file, 'wx', 0o600);
          try {
            for (let index = 0; index < r.chunks; index++)
              await handle.write(this.store.stagedMediaChunk(tenant, r.id, index));
          } finally {
            await handle.close();
          }
        });
      return this.finish(actor, {...r, sha256: digest, ...type, ...facts});
    } catch (e) {
      this.discard(tenant, r.id);
      throw e;
    }
  }
  /** Imports one file from a public HTTPS link (media-link.ts) as an upload. */
  async importLink(actor: Actor, link: unknown) {
    this.uploader(actor);
    const tenant = actor.tenantId,
      id = 'src-' + randomUUID(),
      now = Date.now(),
      lease = this.store.mediaAdmission(tenant);
    try {
      this.store.reserveMediaSource(tenant, id, now + SOURCE_TTL_MS);
      try {
        const sink = this.store.mediaSink(tenant, id, () => {
            this.store.assertActorActive(actor);
            lease.check();
          }),
          file = await downloadMediaLink(link, {request: this.linkRequest, sink}),
          type = mediaType(file.bytes, notMedia),
          facts = await this.inspect(tenant, id, type, file.bytes.subarray(0, SOURCE_CHUNK_BYTES), f =>
            fs.writeFile(f, file.bytes, {mode: 0o600}),
          );
        lease.check();
        let name = 'link';
        try {
          name = decodeURIComponent(new URL(String(link)).pathname.split('/').pop() ?? '') || 'link';
        } catch {}
        return this.finish(actor, {
          id,
          user_id: actor.userId,
          filename: displayName(name),
          origin: 'link',
          link_host: file.host,
          size: file.bytes.length,
          created_at: now,
          expires_at: now + SOURCE_TTL_MS,
          sha256: sha256(file.bytes),
          ...type,
          ...facts,
        });
      } catch (e) {
        this.discard(tenant, id);
        throw e;
      }
    } finally {
      lease.release();
    }
  }
  /** The media files directly inside a folder selected in a Drive login, to choose from. */
  async driveFolder(actor: Actor, input: JsonObject) {
    this.uploader(actor);
    if (!this.drive)
      throw new MirrorError('DRIVE_UNAVAILABLE', 'Google Drive imports are not available here.', {}, 501);
    if (typeof input.connection_id !== 'string' || !input.connection_id)
      throw new MirrorError('DRIVE_CONNECTION_REQUIRED', 'Choose the Drive login that selected the folder.');
    return this.drive.list(actor, input.connection_id, input.folder_id);
  }
  /**
   * Imports one private Drive file as an upload: a file selected in the Drive login, or a file directly inside a folder
   * selected there (folder_id), which Drive's own metadata must confirm.
   */
  async importDrive(actor: Actor, input: JsonObject) {
    this.uploader(actor);
    if (!this.drive)
      throw new MirrorError('DRIVE_UNAVAILABLE', 'Google Drive imports are not available here.', {}, 501);
    if (typeof input.connection_id !== 'string' || !input.connection_id)
      throw new MirrorError('DRIVE_CONNECTION_REQUIRED', 'Choose the Drive login that selected the file.');
    const tenant = actor.tenantId,
      id = 'src-' + randomUUID(),
      now = Date.now(),
      lease = this.store.mediaAdmission(tenant);
    try {
      this.store.reserveMediaSource(tenant, id, now + SOURCE_TTL_MS);
      try {
        const sink = this.store.mediaSink(tenant, id, () => {
            this.store.assertActorActive(actor);
            lease.check();
          }),
          file = await this.drive.download(actor, input.connection_id, input.file_id, input.folder_id, sink),
          type = mediaType(file.bytes, notMedia),
          facts = await this.inspect(tenant, id, type, file.bytes.subarray(0, SOURCE_CHUNK_BYTES), f =>
            fs.writeFile(f, file.bytes, {mode: 0o600}),
          );
        lease.check();
        return this.finish(actor, {
          id,
          user_id: actor.userId,
          filename: displayName(file.name ?? 'drive'),
          origin: 'drive',
          drive: {connection_id: input.connection_id, file_id: input.file_id, folder_id: input.folder_id ?? null},
          size: file.bytes.length,
          created_at: now,
          expires_at: now + SOURCE_TTL_MS,
          sha256: sha256(file.bytes),
          ...type,
          ...facts,
        });
      } catch (e) {
        this.discard(tenant, id);
        throw e;
      }
    } finally {
      lease.release();
    }
  }
  private finish(actor: Actor, r: JsonObject) {
    // Inspection awaits external work. Removal/expiry or member revocation during that wait must not resurrect
    // metadata for missing bytes. No await separates this check from persisting the completed record.
    this.uploader(actor);
    const staged = this.store.stagedMediaManifest(actor.tenantId, r.id);
    if (staged.sha256 !== r.sha256 || staged.size !== r.size)
      throw new MirrorError('MEDIA_SOURCE_CHANGED', 'The staged source changed during inspection. Upload it again.');
    const {id, revision: _revision, extension: _extension, ...record} = r,
      done: JsonObject = {...record, state: 'complete'};
    this.store.putDocument(actor.tenantId, kind, id, done);
    this.store.appendAudit(actor.tenantId, id, {
      event: 'media_source_added',
      source_id: id,
      origin: done.origin,
      ...(done.link_host ? {link_host: done.link_host} : {}),
      sha256: done.sha256,
      size: done.size,
      mime: done.mime,
      actor: actor.userId,
    });
    return this.view({...done, id}, actor);
  }
  private discard(tenant: string, id: string) {
    this.store.removeStagedMedia(tenant, id);
    this.store.deleteDocument(tenant, kind, id);
  }
  /**
   * The picture size (as the media is seen), duration and a 480-pixel preview frame, with the bounded FFmpeg of every
   * media step. A file FFmpeg cannot decode is refused; when FFmpeg is busy or missing, the upload is kept without them.
   */
  private async inspect(
    tenant: string,
    id: string,
    type: MediaFileType,
    head: Buffer,
    write: (file: string) => Promise<void>,
  ): Promise<JsonObject> {
    try {
      return await withMediaDirectory('Media inspection is currently at capacity.', async directory => {
        const input = path.join(directory, 'input.' + type.extension);
        await write(input);
        const metadata = await ffprobeJson(input, type),
          video = metadata.streams?.find((s: any) => s.codec_type === 'video');
        if (!Number.isInteger(video?.width) || !Number.isInteger(video?.height) || video.width < 1 || video.height < 1)
          throw new MirrorError('MEDIA_CONVERSION_FAILED', 'The media could not be decoded.');
        const orientation = type.mime === 'image/jpeg' ? jpegOrientation(head) : 1,
          rotation =
            type.kind === 'video'
              ? Number(
                  video.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0,
                )
              : 0,
          swapped = orientation >= 5 || Math.abs(rotation) % 180 === 90,
          duration = type.kind === 'video' ? Number(metadata.format?.duration ?? video.duration) : null,
          facts: JsonObject = {
            width: swapped ? video.height : video.width,
            height: swapped ? video.width : video.height,
            duration: Number.isFinite(duration) ? duration : null,
            codec: video.codec_name ?? null,
            inspection: 'complete',
          };
        if (video.width * video.height > 40000000) return {...facts, inspection: 'too_large_to_preview'};
        const thumbnail = path.join(directory, 'thumbnail.jpg');
        await convertMedia(input, type, thumbnail, {
          inputOptions: type.kind === 'image' ? ['-noautorotate'] : duration! > 2 ? ['-ss', '1'] : [],
          filter: [
            orientationFilter(orientation),
            'scale=480:480:force_original_aspect_ratio=decrease:flags=lanczos',
            'setsar=1',
          ]
            .filter(Boolean)
            .join(','),
          encoding: ['-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-f', 'image2'],
          videoOnly: true,
        });
        const jpeg = await fs.readFile(thumbnail);
        if (!jpeg.length || jpeg.length > 1024 * 1024) return {...facts, inspection: 'unavailable'};
        return {
          ...facts,
          thumbnail: this.store.sealValue(tenant, 'media-thumbnail', id, {jpeg: jpeg.toString('base64')}),
        };
      });
    } catch (e) {
      if (
        e instanceof MirrorError &&
        ['MEDIA_PROCESSOR_BUSY', 'MEDIA_PROCESSOR_UNAVAILABLE', 'MEDIA_CONVERSION_TIMEOUT'].includes(e.code)
      )
        return {width: null, height: null, duration: null, inspection: 'unavailable'};
      throw e;
    }
  }
  /** The uploads the actor can use: their own, or the whole workspace's for an administrator. */
  list(actor: Actor) {
    this.store.assertActorActive(actor);
    return [
      ...this.store.documents(actor.tenantId, kind),
      ...this.store.documents(actor.tenantId, 'retained_media_source'),
    ]
      .filter(
        r =>
          (retainedMediaId.test(r.id)
            ? r.retained === true && r.expires_at === null && r.state === 'complete'
            : r.expires_at > Date.now()) &&
          (r.user_id === actor.userId || actor.role === 'admin'),
      )
      .sort((a, b) => b.created_at - a.created_at)
      .map(r => this.view(r, actor));
  }
  private confirmation(r: JsonObject, input: JsonObject = {}) {
    if (input.confirmed !== true)
      throw new MirrorError(
        'MEDIA_RETENTION_CONFIRMATION_REQUIRED',
        'Confirm retention or permanent removal of this exact selected original.',
        {},
        409,
      );
    if (
      typeof input.expected_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.expected_sha256) ||
      input.expected_sha256 !== r.sha256
    )
      throw new MirrorError('MEDIA_SOURCE_CHANGED', 'Inspect this exact source and confirm its current SHA-256.');
  }
  /** An owner explicitly copies one completed original; neither temporary expiry nor provider objects change. */
  retain(actor: Actor, id: unknown, input: JsonObject = {}) {
    ownerAccess(this.store, actor, 'retain_media');
    this.uploader(actor);
    assertWritesNotPaused(this.store, actor.tenantId);
    let r: JsonObject;
    try {
      r = this.record(actor, id);
    } catch (error) {
      if (!(
        error instanceof MirrorError &&
        error.code === 'MEDIA_SOURCE_NOT_FOUND' &&
        typeof id === 'string' &&
        sourceId.test(id)
      ))
        throw error;
      r = this.record(actor, id.replace('src-', 'lib-'));
      if (r.original_source_id !== id) throw gone();
    }
    if (r.state !== 'complete')
      throw new MirrorError('MEDIA_UPLOAD_INCOMPLETE', 'Complete the upload before retaining its original.', {}, 409);
    this.confirmation(r, input);
    const lease = this.store.mediaAdmission(actor.tenantId);
    try {
      return this.store.transaction(() => {
        ownerAccess(this.store, actor, 'retain_media');
        assertWritesNotPaused(this.store, actor.tenantId);
        const target = retainedMediaId.test(r.id) ? r.id : r.id.replace('src-', 'lib-');
        let previous: JsonObject | undefined;
        try {
          previous = this.store.document(actor.tenantId, 'retained_media_source', target);
        } catch (e) {
          if (!(e instanceof MirrorError && e.code === 'NOT_FOUND')) throw e;
        }
        if (previous) {
          const current = this.record(actor, target),
            manifest = this.retained.verify(actor.tenantId, target);
          this.confirmation(current, input);
          if (
            manifest.sha256 !== current.sha256 ||
            manifest.size !== current.size ||
            (!retainedMediaId.test(r.id) && current.original_source_id !== r.id)
          )
            throw new MirrorError(
              'MEDIA_SOURCE_CHANGED',
              'The retained original no longer matches its source metadata.',
            );
          ownerAccess(this.store, actor, 'retain_media');
          lease.check();
          return this.view(current, actor);
        }
        r = this.record(actor, r.id);
        this.confirmation(r, input);
        this.retained.copy(actor.tenantId, r.id, target, {size: r.size, sha256: r.sha256}, head => {
          const type = mediaType(head, notMedia);
          if (type.mime !== r.mime || type.kind !== r.kind)
            throw new MirrorError('MEDIA_SOURCE_CHANGED', 'The original file type no longer matches its record.');
        });
        let thumbnail: string | undefined;
        if (r.thumbnail) {
          const image = this.store.openValue<{jpeg: string}>(actor.tenantId, 'media-thumbnail', r.id, r.thumbnail);
          if (typeof image.jpeg !== 'string' || image.jpeg.length > Math.ceil((1024 * 1024) / 3) * 4)
            throw new MirrorError('MEDIA_LIBRARY_INVALID', 'The original thumbnail exceeds its byte ceiling.');
          thumbnail = this.store.sealValue(actor.tenantId, 'media-thumbnail', target, image);
        }
        ownerAccess(this.store, actor, 'retain_media');
        assertWritesNotPaused(this.store, actor.tenantId);
        lease.check();
        const record = {
          user_id: r.user_id,
          filename: r.filename,
          state: 'complete',
          origin: r.origin,
          size: r.size,
          mime: r.mime,
          kind: r.kind,
          sha256: r.sha256,
          width: r.width ?? null,
          height: r.height ?? null,
          duration: r.duration ?? null,
          codec: r.codec ?? null,
          inspection: r.inspection,
          created_at: r.created_at,
          expires_at: null,
          retained: true,
          retained_at: Date.now(),
          retained_by: actor.userId,
          original_source_id: r.id,
          ...(r.link_host ? {link_host: r.link_host} : {}),
          ...(thumbnail ? {thumbnail} : {}),
        };
        this.store.putDocument(actor.tenantId, 'retained_media_source', target, record);
        this.store.appendAudit(actor.tenantId, target, {
          event: 'media_source_retained',
          source_id: target,
          original_source_id: r.id,
          sha256: r.sha256,
          size: r.size,
          retention: 'until_removed',
          actor: actor.userId,
        });
        return this.view({...record, id: target}, actor);
      });
    } finally {
      lease.release();
    }
  }
  remove(actor: Actor, id: unknown, input: JsonObject = {}) {
    const r = this.record(actor, id);
    if (retainedMediaId.test(r.id)) {
      ownerAccess(this.store, actor, 'remove_retained_media');
      this.confirmation(r, input);
      return this.store.transaction(() => {
        ownerAccess(this.store, actor, 'remove_retained_media');
        this.confirmation(this.record(actor, r.id), input);
        this.retained.remove(actor.tenantId, r.id);
        this.store.deleteDocument(actor.tenantId, 'retained_media_source', r.id);
        this.store.appendAudit(actor.tenantId, r.id, {
          event: 'retained_media_source_removed',
          source_id: r.id,
          sha256: r.sha256,
          actor: actor.userId,
        });
        return {source_id: r.id, removed: true, retained: true};
      });
    }
    this.discard(actor.tenantId, r.id);
    this.store.appendAudit(actor.tenantId, r.id, {event: 'media_source_removed', source_id: r.id, actor: actor.userId});
    return {source_id: r.id, removed: true};
  }
  /** A completed upload's bytes, checked against its record; for amcp_media prepare. */
  file(actor: Actor, id: unknown) {
    const r = this.record(actor, id);
    if (r.state !== 'complete')
      throw new MirrorError('MEDIA_UPLOAD_INCOMPLETE', 'Complete this upload before using it.', {}, 409);
    const bytes = retainedMediaId.test(r.id)
        ? this.retained.read(actor.tenantId, r.id)
        : this.store.stagedMedia(actor.tenantId, r.id),
      type = mediaType(bytes, notMedia);
    if (bytes.length !== r.size || sha256(bytes) !== r.sha256 || type.mime !== r.mime)
      throw new MirrorError('MEDIA_CHANGED', 'The uploaded file failed its integrity check.');
    return {bytes, ...type, record: r};
  }
  thumbnail(actor: Actor, id: unknown): Buffer {
    const r = this.record(actor, id);
    if (!r.thumbnail) throw new MirrorError('NOT_FOUND', 'This upload has no preview.', {}, 404);
    return Buffer.from(
      this.store.openValue<{jpeg: string}>(actor.tenantId, 'media-thumbnail', r.id, r.thumbnail).jpeg,
      'base64',
    );
  }
}
const gone = () =>
  new MirrorError('MEDIA_SOURCE_NOT_FOUND', 'The upload expired or was removed. Upload the file again.', {}, 404);
