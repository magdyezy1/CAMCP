/** Small helpers the reviewed-write stages share. */
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

export const object = (v: unknown): JsonObject =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {};
export const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export function fail(code: string, message: string, details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
