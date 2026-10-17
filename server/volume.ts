import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Store} from '../src/store.js';
import type {StorageVolume} from '../src/storage-health.js';
import type {AmcpConfig} from './config.js';

export type VolumeLog = (entry: Record<string, unknown>) => void;
export type VolumeStat = (file: string) => {dev: number | bigint};
const STORAGE_REMEDY =
  'Attach a persistent volume and keep MIRROR_DB inside its mount (Railway sets RAILWAY_VOLUME_MOUNT_PATH; elsewhere set AMCP_DATA_MOUNT). For local or development use only, AMCP_ALLOW_EPHEMERAL_DB=true starts without one.';
/** The start-up refusal when production would put its database on storage that does not survive a redeploy. */
export class StorageNotPersistentError extends Error {
  constructor(readonly reason: string) {
    super('AMCP refuses to start: the production database is not on a verified persistent volume (' + reason + ').');
    this.name = 'StorageNotPersistentError';
  }
}
const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
/** The nearest path at or above `file` that exists, so a database not created yet is checked by its directory. */
function nearestExisting(file: string, stat: VolumeStat) {
  for (let current = file; ; current = path.dirname(current)) {
    try {
      return {path: current, dev: stat(current).dev};
    } catch {
      if (path.dirname(current) === current) return;
    }
  }
}
/**
 * The production volume guard (OPS-03). Before the database opens, its directory must lie inside a declared persistent
 * mount (`AMCP_DATA_MOUNT` or Railway's `RAILWAY_VOLUME_MOUNT_PATH`) that is a different device from the root file
 * system, and the database's own location must be on that device. Otherwise the image's own `/data` directory would
 * quietly hold a fresh database that the next deploy discards. Outside production nothing is checked. With
 * `AMCP_ALLOW_EPHEMERAL_DB=true` production starts anyway and health reports `storage: not_persistent`.
 */
export function verifyDataVolume(
  config: Pick<AmcpConfig, 'production' | 'databasePath' | 'dataMounts' | 'allowEphemeralDb'>,
  log: VolumeLog,
  stat: VolumeStat = fs.statSync,
): StorageVolume | undefined {
  if (!config.production) return;
  const database = config.databasePath,
    memory = database === ':memory:',
    directory = memory ? undefined : path.dirname(path.resolve(database));
  let reason = memory ? 'in_memory' : config.dataMounts.length ? 'outside_mount' : 'no_mount';
  if (directory)
    for (const mount of config.dataMounts) {
      if (!inside(mount, directory)) continue;
      let mountDevice, rootDevice;
      try {
        mountDevice = stat(mount).dev;
        rootDevice = stat(path.parse(mount).root).dev;
      } catch {
        reason = 'mount_missing';
        continue;
      }
      if (mountDevice === rootDevice) {
        reason = 'same_device';
        continue;
      }
      // A symbolic link or nested mount below the mount point must not lead the database elsewhere.
      if (nearestExisting(path.resolve(database), stat)?.dev !== mountDevice) {
        reason = 'outside_mount';
        continue;
      }
      log({
        level: 'info',
        event: 'storage_verified',
        message: 'The AMCP database is on a persistent volume.',
        mount,
      });
      return {persistent: true, mount, reason: 'verified'};
    }
  if (config.allowEphemeralDb) {
    log({
      level: 'warn',
      event: 'storage_not_persistent',
      message: 'AMCP_ALLOW_EPHEMERAL_DB=true: the production database is not on a verified persistent volume.',
      reason,
      override: true,
    });
    return {persistent: false, mount: null, reason: 'override'};
  }
  log({
    level: 'error',
    event: 'storage_not_persistent',
    message: 'AMCP refused to start: the production database is not on a verified persistent volume.',
    reason,
    database_directory: directory ?? null,
    mounts: config.dataMounts,
    remedy: STORAGE_REMEDY,
  });
  throw new StorageNotPersistentError(reason);
}
export const VOLUME_MARKER_FILE = '.amcp-volume-id';
// The marker is a service document (src/document-kinds.ts, partition `system`).
const markerId = 'marker';
function readMarkerFile(file: string): string | undefined {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f-]{36}$/.test(value) ? value : 'unreadable';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    return 'unreadable';
  }
}
function databaseMarker(store: Store): string | undefined {
  try {
    const value = store.serviceRepo('storage_volume').get(markerId).volume_id;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return;
  }
}
/**
 * Writes one new volume marker to both the data directory and the database. A deliberate restore or volume move uses
 * this (`npm run admin -- restamp-volume`) so the marker matches again.
 */
export function stampVolumeMarker(store: Store, directory: string, now = Date.now()): string {
  const id = randomUUID(),
    file = path.join(directory, VOLUME_MARKER_FILE),
    temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, id + '\n', {mode: 0o600, flag: 'wx'});
  try {
    store.serviceRepo('storage_volume').put(markerId, {volume_id: id, stamped_at: new Date(now).toISOString()});
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, {force: true});
  }
  return id;
}
/**
 * Compares the marker in the data directory with the one in the database (OPS-03). Both absent: a new database on a
 * new volume, which is stamped. Equal: verified. Anything else means the database or the volume was replaced (a
 * restore, a moved file, a new volume): `storage_volume_changed` is logged and owner health shows it until an operator
 * deliberately re-stamps the marker. The marker never decides whether AMCP starts.
 */
export function checkVolumeMarker(
  store: Store,
  directory: string,
  log: VolumeLog,
): 'stamped' | 'verified' | 'changed' | 'unavailable' {
  const onDisk = readMarkerFile(path.join(directory, VOLUME_MARKER_FILE)),
    inDatabase = databaseMarker(store);
  try {
    if (onDisk === undefined && inDatabase === undefined) {
      stampVolumeMarker(store, directory);
      log({level: 'info', event: 'storage_volume_stamped', message: 'AMCP stamped a new volume marker.'});
      return 'stamped';
    }
  } catch {
    log({
      level: 'warn',
      event: 'storage_volume_marker_unavailable',
      message: 'The volume marker could not be written.',
    });
    return 'unavailable';
  }
  if (onDisk !== undefined && onDisk === inDatabase) return 'verified';
  log({
    level: 'warn',
    event: 'storage_volume_changed',
    message: 'The volume marker does not match the database: the database or its volume was replaced.',
    marker_file: onDisk === undefined ? 'absent' : onDisk === 'unreadable' ? 'unreadable' : 'present',
    marker_database: inDatabase === undefined ? 'absent' : 'present',
    remedy: 'After a deliberate restore or volume move, run npm run admin -- restamp-volume as the application user.',
  });
  return 'changed';
}
