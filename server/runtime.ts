import path from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import type {CallOptions} from '../src/types.js';
import {loadConfig, type AmcpConfig} from './config.js';
import {checkVolumeMarker, verifyDataVolume, type VolumeLog, type VolumeStat} from './volume.js';
/** Metadata-only start-up lines: info on stdout for HTTP and the worker; everything on stderr for stdio MCP. */
export function startupLog(entry: AmcpConfig['entry']): VolumeLog {
  return line =>
    (entry === 'stdio' || line.level !== 'info' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
/**
 * Opens the store and service for one entry point. Every precondition runs before the database opens (OPS-03): the
 * validated configuration, then, in production, the persistent-volume guard; the volume marker is checked after.
 */
export function createRuntime(
  config: AmcpConfig = loadConfig(process.env, 'stdio'),
  options: {log?: VolumeLog; stat?: VolumeStat} = {},
) {
  const log = options.log ?? startupLog(config.entry);
  for (const problem of config.problems) log({level: 'warn', event: 'config_problem', message: problem});
  const volume = verifyDataVolume(config, log, options.stat);
  const registry = new Registry();
  const store = new Store(config.databasePath, config.masterKey);
  if (volume?.persistent)
    volume.marker = checkVolumeMarker(store, path.dirname(path.resolve(config.databasePath)), log);
  store.volume = volume;
  const callOptions: CallOptions = {mode: config.mode, flags: config.flags as CallOptions['flags']};
  const service = new MirrorService(registry, store, undefined, callOptions, {
    allowWrites: config.allowWrites,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  service.transport.coordination = store;
  // Metadata-only failure lines on stderr (stdout carries stdio MCP); the HTTP app replaces this with its own log.
  service.onToolFailure = entry => process.stderr.write(JSON.stringify(entry) + '\n');
  return {registry, store, service, config};
}
