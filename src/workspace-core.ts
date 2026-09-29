import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {guardInput, stable, sha256} from './security.js';
import type {Actor, JsonObject} from './types.js';
export type ToolCall = (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>;
export const obj = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);
export function bad(message: string, code = 'INVALID_ARGUMENT', details: JsonObject = {}): never {
  throw new MirrorError(code, message, details);
}
/**
 * A plan's result reference: {$ref: "step#/JSON/pointer"}, or with a LinkedIn URN prefix
 * ({$ref, prefix: "urn:li:sponsoredCampaignGroup:"}) where the referenced value is the bare numeric ID LinkedIn returns
 * in x-restli-id but the next request needs its URN. Any other shape is refused.
 */
export function planReference(v: JsonObject): {ref: string; prefix?: string} {
  const keys = Object.keys(v).sort().join();
  if ((keys !== '$ref' && keys !== '$ref,prefix') || typeof v.$ref !== 'string')
    bad('Use {$ref:"step#/JSON/pointer"}, optionally with a LinkedIn URN prefix.');
  if (v.prefix !== undefined && (typeof v.prefix !== 'string' || !/^urn:li:[A-Za-z]+:$/.test(v.prefix)))
    bad('A $ref prefix is a LinkedIn URN prefix such as "urn:li:sponsoredCampaignGroup:".', 'INVALID_ARGUMENT', {
      field: 'prefix',
    });
  return {ref: v.$ref, ...(v.prefix !== undefined ? {prefix: v.prefix} : {})};
}
/** Checks an argument object: its keys, and its size. Each refusal says which it was (F-86). */
export function validate(input: JsonObject, keys: string[], max = 262144, what = 'argument') {
  guardInput(input);
  if (!obj(input)) bad('The ' + what + 's must be a JSON object.');
  const unsupported = Object.keys(input).filter(k => !keys.includes(k));
  if (unsupported.length)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Unsupported ' +
        what +
        (unsupported.length > 1 ? 's' : '') +
        ': ' +
        unsupported.join(', ') +
        '. Accepted: ' +
        keys.join(', ') +
        '.',
      {unsupported, accepted: keys},
    );
  const bytes = Buffer.byteLength(stable(input));
  if (bytes > max)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'The ' + what + 's take ' + bytes + ' bytes; the limit is ' + max + '. Send fewer or smaller values.',
      {bytes, limit: max},
    );
}
export function identifier(x: unknown, label = 'id'): string {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(x)) bad('Invalid ' + label);
  return x;
}
export function writer(store: Store, actor: Actor) {
  store.assertActorActive(actor);
  if (actor.role === 'reader')
    throw new MirrorError('FORBIDDEN', 'An operator is required for workspace changes.', {}, 403);
}
export function noSecrets(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(noSecrets);
    return;
  }
  if (obj(value))
    for (const [k, v] of Object.entries(value)) {
      if (/(?:password|secret|access.?token|refresh.?token|authorization|private.?key)/i.test(k))
        bad('Store credentials through Connections, not workspace documents.');
      noSecrets(v);
    }
}
export function read(store: Store, actor: Actor, kind: string, id: string) {
  store.assertActorActive(actor);
  return store.document(actor.tenantId, kind, identifier(id));
}
export function optional(store: Store, tenant: string, kind: string, id: string) {
  try {
    return store.document(tenant, kind, id);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
}
export function update(store: Store, actor: Actor, kind: string, id: string, data: JsonObject, revision?: number) {
  return store.transaction(() => {
    store.assertActorActive(actor);
    const old = optional(store, actor.tenantId, kind, id);
    if (old && revision !== old.revision)
      throw new MirrorError(
        'REVISION_CONFLICT',
        'Reload the current record before updating it.',
        {revision: old.revision},
        409,
      );
    store.putDocument(actor.tenantId, kind, id, data);
    return store.document(actor.tenantId, kind, id);
  });
}
export function audit(store: Store, actor: Actor, event: string, data: JsonObject) {
  store.appendAudit(actor.tenantId, randomUUID(), {event, actor: actor.userId, ...data});
}
export function fingerprint(value: unknown) {
  return sha256(stable(value));
}
export function pointer(value: unknown, path: string): any {
  if (path === '') return value;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512)
    bad('Use a JSON pointer beginning with /.');
  let v: any = value;
  for (const part of path.slice(1).split('/')) {
    const k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(k)) bad('Invalid JSON pointer.');
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k))
      bad('Missing reference ' + path, 'REFERENCE_UNAVAILABLE');
    v = v[k];
  }
  return v;
}
export function tool(name: string, description: string, actions: string[], properties: JsonObject) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {action: {type: 'string', enum: actions}, ...properties},
      additionalProperties: false,
    },
  };
}
export const field = {
  id: {type: 'string'},
  object: {type: 'object'},
  bool: {type: 'boolean'},
  integer: {type: 'integer', minimum: 0},
};
