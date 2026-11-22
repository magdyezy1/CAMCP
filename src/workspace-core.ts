import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {MirrorError} from './errors.js';
import {guardInput, stable, sha256} from './security.js';
import {accessSetAudit} from './access-sets.js';
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
/**
 * Whether text is an opaque identifier or a credential rather than a name (R2.5 r25-field3-refs, the fix round, the lead's review S3-1): an alphanumeric
 * run of 20 or more characters that mixes letters and digits (a token, a signature), a hex run of 16 or more (a digest, a hex token), a UUID, or the start
 * of a well-known token (`ya29.`, `EAA`, `ghp_`, `eyJ` and their kind). A field name or a step ID is made of words, so a letters-only name of any length
 * stays: the result field of a build's listing group filter has 34 characters. The alphabets below only bound what a refusal may repeat; this is what
 * keeps a bare token, which is made of the same characters as a name, out of it.
 */
function opaque(text: string): boolean {
  return (
    (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(run => /[A-Za-z]/.test(run) && /[0-9]/.test(run)) ||
    /[0-9a-fA-F]{16,}/.test(text) ||
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(text) ||
    /(?:^|[^A-Za-z0-9])(?:ya29\.|EAA|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|eyJ|AIza|sk-|xox[abeprs]-)/.test(text)
  );
}
/**
 * A JSON pointer of a step's result as a refusal may repeat it (R2.5 r25-field3-refs, AMCP-02, F2-2): at most 16 parts of at most 40 characters
 * of the usual field-name alphabet, with no part that is opaque (a token, a digest, a UUID) and none with a run of six or more digits (the ID of a
 * provider's record), or null. A refusal of a reference names the pointer it was given so that its sender can correct it, but it never echoes text
 * of another shape (a link with a query string, a token): such a pointer is refused without its text.
 */
export function boundedPointer(value: unknown): string | null {
  return typeof value === 'string' &&
    /^(?:\/[A-Za-z0-9_~@$.-]{0,40}){0,16}$/.test(value) &&
    !/[0-9]{6}/.test(value) &&
    !opaque(value)
    ? value
    : null;
}
/**
 * A step ID as a refusal may repeat it: the plan's own spelling of one (letters, digits, hyphen, underscore), unless it is opaque, or null. Digits alone
 * do not make a step ID opaque: a plan's author names its steps, and a name such as `launch-20261121` is a name.
 */
export function boundedStepId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) && !opaque(value) ? value : null;
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
/**
 * A plan, and a saved template of plan steps, is stored as it is written, and the runner never sends the `arguments` that an execute takes
 * again for a secret-like value (src/secret-fields.ts), so a step that applies such a value, a creator's authorization code, cannot be
 * one of them: it would store the value, and it could never run (r25-m4b-smartpush, the lead's review S1-2). `ids` are the steps found to
 * do that (src/campaign-spend-effects.ts, `stepsWithSecretFields`); none is no refusal.
 */
export function noSecretSteps(ids: readonly string[]): void {
  if (ids.length)
    bad(
      'A creator’s authorization code is applied with amcp_write prepare and execute, which keep only its digest; a campaign plan does not keep it.',
      'INVALID_ARGUMENT',
      {steps: [...ids], use: 'amcp_write'},
    );
}
export const workspaceCredentialKey = /(?:password|secret|access.?token|refresh.?token|authorization|private.?key)/i;
export function noSecrets(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(noSecrets);
    return;
  }
  if (obj(value))
    for (const [k, v] of Object.entries(value)) {
      if (workspaceCredentialKey.test(k)) bad('Store credentials through Connections, not workspace documents.');
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
  store.appendAudit(actor.tenantId, randomUUID(), {
    event,
    actor: actor.userId,
    // Work done under a client access set names the set (SEC-08).
    ...accessSetAudit(actor),
    ...data,
  });
}
export function fingerprint(value: unknown) {
  return sha256(stable(value));
}
export function pointer(value: unknown, path: string): any {
  if (path === '') return value;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512)
    bad('Use a JSON pointer beginning with /.');
  let v: any = value;
  const parts = path.slice(1).split('/');
  for (const [i, part] of parts.entries()) {
    const k = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(k)) bad('Invalid JSON pointer.');
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k))
      // The message names the pointer only when it is a name, as the details do (R2.5 r25-field3-refs, the fix round, the lead's review S4-1): the
      // message goes to the response and to the audit trail, and a pointer holding a signed link or a token is not repeated there.
      bad(
        'Missing reference ' + (boundedPointer(path) ?? 'at the pointer given'),
        'REFERENCE_UNAVAILABLE',
        unavailableDetails(path, parts.slice(0, i), v),
      );
    v = v[k];
  }
  return v;
}
/**
 * What a missing reference says (R2.5 r25-field3-refs, AMCP-02, F2-2): the pointer, the level of the result that lacks the next part and what that
 * level holds. Names only: at most 20 field names of the level (a key of another shape, an ID, a link or an opaque string such as a UUID is no field
 * name and is never repeated), the length of an array, and the type of a scalar; never a value of the result, so that no value or signed link reaches a log.
 */
function unavailableDetails(path: string, above: string[], level: unknown): JsonObject {
  const names = level && typeof level === 'object' && !Array.isArray(level) ? Object.keys(level) : [],
    fields = names
      .filter(k => /^[A-Za-z][A-Za-z0-9_@$-]{0,63}$/.test(k) && !/\d{6,}/.test(k) && !opaque(k))
      .slice(0, 20);
  return {
    pointer: boundedPointer(path),
    missing_at: above.length ? boundedPointer('/' + above.join('/')) : '/',
    available_keys: fields,
    ...(names.length > fields.length ? {available_keys_total: names.length} : {}),
    found_type: level === null ? 'null' : Array.isArray(level) ? 'array' : typeof level,
    ...(Array.isArray(level) ? {array_length: level.length} : {}),
  };
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
