import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Renaming and deleting Meta ad creatives and custom audiences, Marketing API v25.0 ("Ad Creative" and "Custom Audience"
 * references, Updating and Deleting, checked 2026-09-27). A creative's name has up to 100 characters; a custom audience
 * has a name and a description. Both are deleted with DELETE /{id}, answering {success}. "When you delete a custom
 * audience, it will be permanently removed from your account and your ads using it will stop running", and Meta refuses
 * while lookalikes derive from it (error 2656). Other creative and audience fields (status, rules, retention, opt-out
 * links, customer lists) are outside this contract. A deleted object reads as status DELETED or as Meta's "does not
 * exist" error (code 100, subcode 33).
 */
type Kind = {object: 'creative' | 'audience'; op: 'rename' | 'delete'};
type Read = CompiledRequest & {metaObjectState?: {object: 'creative' | 'audience'; id: string; optional?: boolean}};
const actions: Record<string, Kind> = {
  meta_creative_id_update: {object: 'creative', op: 'rename'},
  meta_creative_update: {object: 'creative', op: 'rename'},
  meta_creative_id_delete: {object: 'creative', op: 'delete'},
  meta_custom_audience_update: {object: 'audience', op: 'rename'},
  meta_custom_audience_id_update: {object: 'audience', op: 'rename'},
  meta_custom_audience_delete: {object: 'audience', op: 'delete'},
  meta_custom_audience_id_delete: {object: 'audience', op: 'delete'},
};
const fields: Record<string, string> = {
  creative: 'id,account_id,name,status',
  audience: 'id,account_id,name,description,subtype,operation_status,delivery_status',
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const account = (v: unknown) => String(v ?? '').replace(/^act_/, '');
function invalid(message: string): never {
  return fail('INVALID_META_OBJECT_EDIT', message);
}
function unverified(message: string): never {
  return fail('META_OBJECT_STATE_UNVERIFIED', message, {}, 502);
}
export function metaObjectKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'meta_native_action' ||
    (p.origin && p.origin !== 'https://graph.facebook.com') ||
    p.specialTransport
  )
    return;
  const k = actions[p.action];
  if (!k || !metaRoute('[1-9][0-9]{0,31}$').test(p.path)) return;
  return p.method === (k.op === 'delete' ? 'DELETE' : 'POST') ? k : undefined;
}
const targetOf = (p: CompiledRequest) => p.path.split('/')[2]!;
function text(v: unknown, label: string, max: number): void {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > max || /[\u0000-\u001f]/.test(v))
    invalid(label + ' has 1–' + max + ' characters without surrounding spaces or control characters.');
}
export function assertMetaObject(p: CompiledRequest): void {
  const k = metaObjectKind(p);
  if (!k) return;
  if (!numeric(account(p.accountId))) invalid('Select one Meta ad account.');
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('These reviews take no query or header overrides.');
  const b = p.body ?? {};
  if (!object(b)) invalid('Send a native object body.');
  if (k.op === 'delete') {
    if (Object.keys(b).length) invalid('Deletion takes no body.');
    return;
  }
  const allowed = k.object === 'creative' ? ['name'] : ['name', 'description'],
    extra = Object.keys(b).filter(f => !allowed.includes(f));
  if (!Object.keys(b).length || extra.length)
    invalid(
      'A ' +
        (k.object === 'creative'
          ? 'creative rename sets name'
          : 'custom audience rename sets name and/or description') +
        (extra.length ? '; unqualified fields: ' + extra.join(', ') : '') +
        '.',
    );
  if (b.name !== undefined) text(b.name, 'name', k.object === 'creative' ? 100 : 255);
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' ||
      [...b.description].length > 1000 ||
      /[\u0000-\u0008\u000b-\u001f]/.test(b.description))
  )
    invalid('description is text of up to 1000 characters.');
}
export function assertMetaObjectScope(c: Connection, write = false): void {
  if (write ? !c.scopes.includes('ads_management') : !c.scopes.some(s => s === 'ads_management' || s === 'ads_read'))
    fail('INSUFFICIENT_SCOPE', 'Reconnect Meta with ads_management to change creatives and audiences.', {}, 403);
}
const read = (p: CompiledRequest, s: NonNullable<Read['metaObjectState']>): Read =>
  stateReadOf<Read>(p, 'AMCP_META_OBJECT_READ', metaPrefix + s.id, {fields: fields[s.object]!}, {metaObjectState: s});
export function metaObjectSnapshots(p: CompiledRequest): Read[] {
  const k = metaObjectKind(p)!;
  return [read(p, {object: k.object, id: targetOf(p)})];
}
export function isMetaObjectRead(p: CompiledRequest): p is Read {
  return p.gateway === 'meta_native_action' && !!(p as Read).metaObjectState;
}
/** Meta's "Unsupported get request. Object ... does not exist" (code 100, subcode 33). */
function missing(e: unknown): boolean {
  if (!(e instanceof MirrorError) || e.code !== 'UPSTREAM_ERROR' || e.status !== 400) return false;
  const up = object(e.details.upstream) ? e.details.upstream : {},
    err = object(up.error) ? up.error : {};
  return err.code === 100 && err.error_subcode === 33;
}
/** The object with its account; after a deletion, an absent or DELETED object reads as gone. */
export async function readMetaObject(
  p: CompiledRequest,
  fetch: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).metaObjectState;
  if (!s) return fetch(p);
  let r: TransportResult;
  try {
    r = await fetch({...(p as Read), metaObjectState: undefined});
  } catch (e) {
    if (s.optional && missing(e)) return {status: 200, headers: {}, data: {object: s.object, id: s.id, present: false}};
    throw e;
  }
  const d = r.data;
  if (r.status !== 200 || !object(d) || d.error) unverified('Meta did not return the ' + s.object + '.');
  if (String(d.id) !== s.id) unverified('Meta returned a different ' + s.object + '.');
  if (account(d.account_id) !== account(p.accountId))
    fail(
      'STATE_TARGET_MISMATCH',
      'This ' +
        s.object +
        " belongs to another ad account; only the account's own " +
        (s.object === 'creative' ? 'creatives' : 'audiences') +
        ' change here.',
      {id: s.id},
      409,
    );
  const deleted = d.status === 'DELETED';
  return {
    status: 200,
    headers: {},
    data: {
      object: s.object,
      id: s.id,
      present: !deleted,
      name: d.name ?? null,
      ...(s.object === 'audience'
        ? {
            description: d.description ?? null,
            subtype: d.subtype ?? null,
            deliveryStatus: object(d.delivery_status) ? (d.delivery_status.code ?? null) : null,
          }
        : {status: d.status ?? null}),
    },
  };
}
export function validateMetaObjectState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).metaObjectState,
    d = r.data;
  if (!s || r.status !== 200 || !object(d) || d.id !== s.id || typeof d.present !== 'boolean')
    unverified('Missing verified Meta object state.');
}
export function metaObjectPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const k = metaObjectKind(p);
  if (!k) return;
  const s = states[0];
  if (!object(s)) unverified('Missing verified Meta object state.');
  if (!s.present) invalid('This ' + k.object + ' is deleted.');
  if (k.op === 'rename') {
    const b = p.body as JsonObject;
    if (Object.entries(b).every(([f, v]) => s[f] === v)) invalid('This ' + k.object + ' already has these values.');
  }
}
export function metaObjectImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const k = metaObjectKind(p);
  if (!k) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {};
  return {
    provider: 'meta',
    scope: k.object === 'creative' ? 'ad_creative' : 'custom_audience',
    operation: k.op,
    target: {id: targetOf(p), name: s.name ?? null, ...(k.object === 'audience' ? {subtype: s.subtype ?? null} : {})},
    ...(k.op === 'rename' ? {after: p.body} : {}),
    may_affect_serving: k.op === 'delete',
    irreversible: k.op === 'delete',
    effect:
      k.op === 'rename'
        ? 'Renames the ' +
          (k.object === 'creative' ? 'creative in the creative library' : 'audience') +
          '; nothing that serves changes.'
        : k.object === 'audience'
          ? 'Deletes the audience permanently; ads that use it stop running. Meta refuses while lookalikes derive from it.'
          : 'Deletes the creative from the creative library.',
    verification:
      k.op === 'rename'
        ? 'Reads the ' + k.object + ' again and compares the fields written.'
        : 'Reads the ' + k.object + ' again and expects it to be gone or DELETED.',
    source:
      k.object === 'creative'
        ? 'https://developers.facebook.com/docs/marketing-api/reference/ad-creative/'
        : 'https://developers.facebook.com/docs/marketing-api/reference/custom-audience/',
  };
}
export function metaObjectOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && object(r.data) && r.data.success === true;
}
export function metaObjectVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const k = metaObjectKind(p)!,
    probe = read(p, {object: k.object, id: targetOf(p), optional: k.op === 'delete'});
  return [
    {
      read: probe,
      expected: k.op === 'delete' ? {present: false} : {present: true, ...(p.body as JsonObject)},
      id: targetOf(p),
    },
  ];
}
export function metaObjectObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return data;
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaObjectFamily: ReviewedFamily = defineFamily({
  name: 'meta_object_edits',
  files: ['src/meta-object-edits.ts', ['tests/meta-object-edits.test.mjs']],
  kind: metaObjectKind,
  assert: assertMetaObject,
  scope: assertMetaObjectScope,
  snapshots: metaObjectSnapshots,
  isRead: isMetaObjectRead,
  reader: readMetaObject,
  validateState: validateMetaObjectState,
  prerequisites: metaObjectPrerequisites,
  impact: metaObjectImpact,
  outcome: metaObjectOutcome,
  verification: metaObjectVerification,
  observed: metaObjectObserved,
  exemptFromSpendTextMatch: true,
});
