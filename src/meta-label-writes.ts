import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {metaPrefix, metaRoute} from './meta-version.js';

type Kind = 'create' | 'rename' | 'delete' | 'attach';
const kinds: Record<string, Kind> = {
  meta_ad_account_id_adlabels_create: 'create',
  meta_ad_label_id_update: 'rename',
  meta_ad_label_id_delete: 'delete',
  meta_ad_id_adlabels_create: 'attach',
  meta_campaign_id_adlabels_create: 'attach',
  meta_creative_id_adlabels_create: 'attach',
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
const account = (v: unknown) => (typeof v === 'string' ? v.replace(/^act_/, '') : '');
function fail(message: string, code = 'META_LABEL_INVALID'): never {
  throw new MirrorError(code, message);
}
const only = (o: JsonObject, fields: string[]) => {
  if (Object.keys(o).some(k => !fields.includes(k)))
    fail('Unqualified label field. Use the documented name or exact adlabels identifiers.');
};
export function metaLabelKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'meta_native_action' ||
    (p.origin && p.origin !== 'https://graph.facebook.com') ||
    p.specialTransport
  )
    return;
  const kind = kinds[p.action];
  if (!kind) return;
  const path =
    kind === 'create'
      ? metaRoute('act_[1-9][0-9]*/adlabels$')
      : kind === 'attach'
        ? metaRoute('[1-9][0-9]*/adlabels$')
        : metaRoute('[1-9][0-9]*$');
  return path.test(p.path) && p.method === (kind === 'delete' ? 'DELETE' : 'POST') ? kind : undefined;
}
export function assertMetaLabel(p: CompiledRequest) {
  const kind = metaLabelKind(p);
  if (!kind) return;
  if (!id(account(p.accountId)) || Object.keys(p.headers).length || Object.keys(p.query).length)
    fail('Select one Meta account without header or query overrides.');
  const b = p.body ?? {};
  if (!object(b)) fail('Supply a native label object.');
  only(b, kind === 'delete' ? [] : kind === 'attach' ? ['adlabels'] : ['name']);
  if (kind === 'create' || kind === 'rename') {
    if (typeof b.name !== 'string' || !b.name.trim() || [...b.name].length > 1000 || /[\u0000-\u001f]/.test(b.name))
      fail('Supply a nonempty label name within the 1000-character AMCP limit.');
  }
  if (
    kind === 'attach' &&
    (!Array.isArray(b.adlabels) ||
      !b.adlabels.length ||
      b.adlabels.length > 25 ||
      b.adlabels.some((v: unknown) => !object(v) || Object.keys(v).length !== 1 || !id(v.id)) ||
      new Set(b.adlabels.map((v: JsonObject) => v.id)).size !== b.adlabels.length)
  )
    fail('Attach 1–25 existing, distinct label IDs using adlabels: [{id}].');
}
export function assertMetaLabelScope(c: Connection, write = false) {
  if (write ? !c.scopes.includes('ads_management') : !c.scopes.some(s => s === 'ads_management' || s === 'ads_read'))
    fail('Meta labels require ads_management to write and ads_read or ads_management to read.', 'INSUFFICIENT_SCOPE');
}
const targetId = (p: CompiledRequest) => p.path.split('/')[2]!;
const base = (p: CompiledRequest, path: string, query: JsonObject = {}): CompiledRequest => ({
  ...p,
  action: 'AMCP_META_LABEL_READ',
  method: 'GET',
  path,
  query,
  body: undefined,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  metaLabelState: undefined,
});
export function metaLabelSnapshots(p: CompiledRequest): CompiledRequest[] {
  const kind = metaLabelKind(p)!;
  return [
    {
      ...base(p, metaPrefix + 'act_' + account(p.accountId), {fields: 'id,account_status,currency'}),
      metaLabelState: {
        kind,
        ...(kind === 'attach' ? {targetId: targetId(p)} : kind !== 'create' ? {labelId: targetId(p)} : {}),
      },
    },
  ];
}
function response(r: TransportResult): JsonObject {
  if (
    r.status !== 200 ||
    !object(r.data) ||
    r.data.error ||
    r.data.errors !== undefined ||
    r.data.warnings !== undefined
  )
    fail('Meta label state returned an error or unknown envelope.', 'META_LABEL_STATE_UNVERIFIED');
  if (Buffer.byteLength(JSON.stringify(r.data)) > 4 * 1024 * 1024)
    fail('Meta label state exceeds the 4 MiB response limit.', 'META_LABEL_STATE_UNVERIFIED');
  return r.data;
}
function label(v: unknown, expectedAccount: string): JsonObject {
  if (
    !object(v) ||
    !id(v.id) ||
    typeof v.name !== 'string' ||
    !v.name.trim() ||
    (v.account !== undefined && (!object(v.account) || account(v.account.id) !== expectedAccount))
  )
    fail('Meta returned an invalid or foreign account label.', 'META_LABEL_STATE_UNVERIFIED');
  // Names and unknown returned configuration remain protected; timestamps are telemetry.
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => !['created_time', 'updated_time', 'account'].includes(k)),
  );
}
/** Validate the complete discovery page before recording any ownership. Fields
 * are selectable on this read, so names need not be returned; identity is not. */
export function metaLabelIdentities(data: unknown, expectedAccount: string): string[] {
  if (
    !object(data) ||
    data.error !== undefined ||
    data.errors !== undefined ||
    data.warnings !== undefined ||
    !Array.isArray(data.data)
  )
    fail('Meta label discovery did not return a successful identity collection.', 'META_LABEL_STATE_UNVERIFIED');
  const ids = data.data.map((v: unknown) => {
    if (
      !object(v) ||
      !id(v.id) ||
      (v.account !== undefined && (!object(v.account) || account(v.account.id) !== expectedAccount))
    )
      fail('Meta label discovery returned invalid or foreign identities.', 'META_LABEL_STATE_UNVERIFIED');
    return v.id;
  });
  if (new Set(ids).size !== ids.length)
    fail('Meta label discovery returned duplicate identities.', 'META_LABEL_STATE_UNVERIFIED');
  return ids;
}
const extraPage = (d: JsonObject) =>
  ['has_more', 'hasMore'].some(k => d[k] !== undefined && d[k] !== false) ||
  ['nextPageToken', 'next_page_token', 'next_cursor'].some(k => d[k] !== undefined && d[k] !== null && d[k] !== '');
export async function readMetaLabels(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const context = p.metaLabelState;
  if (!context) return request(p);
  const expectedAccount = account(p.accountId),
    started = performance.now();
  let requests = 0,
    bytes = 0;
  const call = async (path: string, query: JsonObject) => {
    if (++requests > 28 || performance.now() - started > 60000)
      fail('Meta label review exceeded its request/time bounds.', 'META_LABEL_STATE_UNVERIFIED');
    const raw = await request(base(p, path, query)),
      d = response(raw);
    if (performance.now() - started > 60000)
      fail('Meta label review exceeded its time bound.', 'META_LABEL_STATE_UNVERIFIED');
    bytes += Buffer.byteLength(JSON.stringify(d));
    if (bytes > 8 * 1024 * 1024) fail('Meta label state exceeds the 8 MiB total limit.', 'META_LABEL_STATE_UNVERIFIED');
    return d;
  };
  const a = await call(metaPrefix + 'act_' + expectedAccount, {fields: 'id,account_status,currency'});
  if (account(a.id) !== expectedAccount || !Number.isSafeInteger(a.account_status) || typeof a.currency !== 'string')
    fail('Meta did not verify the selected account.', 'META_LABEL_STATE_UNVERIFIED');
  const labels: JsonObject = {},
    seen = new Set<string>(),
    path = metaPrefix + 'act_' + expectedAccount + '/adlabels';
  let after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 25) fail('Meta labels exceed 25 pages.', 'META_LABEL_STATE_UNVERIFIED');
    const d = await call(path, {fields: 'id,name,account{id}', limit: 100, ...(after ? {after} : {})});
    if (!Array.isArray(d.data) || d.data.length > 100 || extraPage(d) || (d.paging !== undefined && !object(d.paging)))
      fail('Meta returned an incomplete label collection.', 'META_LABEL_STATE_UNVERIFIED');
    for (const raw of d.data) {
      const l = label(raw, expectedAccount);
      if (Object.hasOwn(labels, l.id)) fail('Meta returned a repeated label identity.', 'META_LABEL_STATE_UNVERIFIED');
      labels[l.id] = l;
    }
    if (Object.keys(labels).length > 1000)
      fail('Meta label review supports at most 1000 account labels.', 'META_LABEL_STATE_UNVERIFIED');
    if (!d.paging?.next) break;
    const cursor = d.paging.cursors?.after;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || seen.has(cursor) || !d.data.length)
      fail('Meta label pagination repeated or omitted its cursor.', 'META_LABEL_STATE_UNVERIFIED');
    let next: URL;
    try {
      next = new URL(d.paging.next);
    } catch {
      fail('Meta returned an invalid pagination URL.', 'META_LABEL_STATE_UNVERIFIED');
    }
    if (
      next.origin !== 'https://graph.facebook.com' ||
      next.pathname !== path ||
      next.username ||
      next.password ||
      next.hash ||
      next.searchParams.get('after') !== cursor
    )
      fail('Meta label pagination changed scope.', 'META_LABEL_STATE_UNVERIFIED');
    seen.add(cursor);
    after = cursor; // Rebuild our fixed path/query; never follow provider URLs or tokens.
  }
  const data: JsonObject = {
    account: {id: expectedAccount, account_status: a.account_status, currency: a.currency},
    labels,
  };
  if (context.labelId) {
    const l = labels[context.labelId];
    data.label = l ? {...l, present: true} : {id: context.labelId, present: false};
  }
  if (context.targetId) {
    const t = await call(metaPrefix + context.targetId, {fields: 'id,account_id,name,status,adlabels'});
    if (
      t.id !== context.targetId ||
      account(t.account_id) !== expectedAccount ||
      typeof t.name !== 'string' ||
      typeof t.status !== 'string'
    )
      fail('Meta did not verify the exact target and account.', 'META_LABEL_STATE_UNVERIFIED');
    // Fail closed on omitted/partial membership until provider absence semantics
    // are verified; a failed or omitted collection cannot mean no labels.
    if (!Array.isArray(t.adlabels) || t.adlabels.length > 1000)
      fail(
        'Meta must return complete explicit adlabels membership, including [] when empty.',
        'META_LABEL_STATE_UNVERIFIED',
      );
    const ids = t.adlabels.map((l: unknown) => {
      if (!object(l) || !id(l.id) || !Object.hasOwn(labels, l.id))
        fail('Target labels are malformed or absent from the selected account.', 'META_LABEL_STATE_UNVERIFIED');
      return l.id;
    });
    if (new Set(ids).size !== ids.length || t.paging !== undefined || extraPage(t))
      fail('Target label membership is repeated or incomplete.', 'META_LABEL_STATE_UNVERIFIED');
    data.target = {
      ...Object.fromEntries(
        Object.entries(t).filter(
          ([k]) => !['adlabels', 'updated_time', 'created_time', 'effective_status', 'paging'].includes(k),
        ),
      ),
      account_id: expectedAccount,
      labelIds: ids.sort(),
    };
  }
  return {data, status: 200, headers: {}};
}
export function validateMetaLabelState(p: CompiledRequest, r: TransportResult) {
  const d = r.data;
  if (!object(d) || r.status !== 200 || d.account?.id !== account(p.accountId) || !object(d.labels))
    fail('The complete account label snapshot is missing.', 'META_LABEL_STATE_UNVERIFIED');
  const context = p.metaLabelState!;
  if (!context.verification && context.labelId && d.label?.present !== true)
    fail('The selected label was not found in the account.', 'META_LABEL_STATE_UNVERIFIED');
  if (context.targetId && d.target?.id !== context.targetId)
    fail('The selected target was not verified.', 'META_LABEL_STATE_UNVERIFIED');
}
export function validateMetaLabelPrerequisites(p: CompiledRequest, states: unknown[]) {
  const kind = metaLabelKind(p);
  if (!kind) return;
  const state = states[0] as JsonObject;
  if (kind === 'create' && Object.keys(state.labels).length >= 1000)
    fail('Creating another label would exceed the complete 1000-label read-back limit.');
  if (kind !== 'attach') return;
  for (const l of (p.body as JsonObject).adlabels)
    if (!Object.hasOwn(state.labels, l.id))
      fail('Every label must exist in the selected account before attachment.', 'META_LABEL_STATE_UNVERIFIED');
  if (new Set([...state.target.labelIds, ...(p.body as JsonObject).adlabels.map((v: JsonObject) => v.id)]).size > 1000)
    fail('Resulting target membership exceeds the 1000-label review limit.');
}
export function metaLabelOutcome(p: CompiledRequest, r: TransportResult, before: unknown[]): boolean {
  const d = r.data;
  if (r.status !== 200 || !object(d) || d.error || d.errors !== undefined || d.warnings !== undefined) return false;
  if (metaLabelKind(p) === 'create')
    return (
      id(d.id) && Object.keys(d).every(k => k === 'id') && !Object.hasOwn((before[0] as JsonObject)?.labels ?? {}, d.id)
    );
  return d.success === true && Object.keys(d).every(k => k === 'success');
}
export function metaLabelVerification(
  p: CompiledRequest,
  r: JsonObject,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = metaLabelKind(p)!,
    prior = before[0] as JsonObject,
    b = p.body as JsonObject,
    read = metaLabelSnapshots(p)[0]!,
    context = read.metaLabelState!;
  context.verification = true;
  if (kind === 'attach')
    return [
      {
        read,
        expected: {
          target: {
            id: context.targetId,
            account_id: account(p.accountId),
            labelIds: [...new Set([...prior.target.labelIds, ...b.adlabels.map((v: JsonObject) => v.id)])].sort(),
          },
        },
        id: context.targetId!,
      },
    ];
  const labelId = kind === 'create' ? String(r.data?.id) : context.labelId!;
  if (!id(labelId) || (kind === 'create' && Object.hasOwn(prior.labels, labelId)))
    fail('Meta label creation returned an existing or invalid identity.', 'WRITE_PARTIAL_OR_FAILED');
  context.labelId = labelId;
  return [
    {
      read,
      expected: {label: {id: labelId, present: kind !== 'delete', ...(kind === 'delete' ? {} : {name: b.name})}},
      id: labelId,
    },
  ];
}
export function metaLabelImpact(p: CompiledRequest): JsonObject | undefined {
  const kind = metaLabelKind(p);
  if (!kind) return;
  return {
    provider: 'meta',
    scope: 'account_labels',
    effect:
      kind === 'delete'
        ? 'Deletes this shared organizational label; associations to existing objects may disappear. It does not delete those advertising objects.'
        : kind === 'attach'
          ? 'Adds existing account labels while retaining all current target membership.'
          : 'Creates or renames an account label.',
    may_affect_serving: false,
    verification:
      'Complete scoped label collection and exact membership read-back. No ad delivery or automation behavior is inferred.',
    recovery:
      'Retain the original claim after partial or lost responses. Read current state; never automatically recreate a label.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const metaLabelFamily: ReviewedFamily = {
  name: 'meta_labels',
  files: ['src/meta-label-writes.ts', ['tests/meta-label-writes.test.ts']],
  kind: metaLabelKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    assertMetaLabel(plan);
    gateway();
  },
  scope: (c, write) => assertMetaLabelScope(c, write),
  snapshots: metaLabelSnapshots,
  isRead: (read: CompiledRequest) => !!read.metaLabelState,
  reader: (read, next) => readMetaLabels(read, next),
  validateState: validateMetaLabelState,
  prerequisites: (plan, state) => validateMetaLabelPrerequisites(plan, state),
  impact: plan => metaLabelImpact(plan),
  outcome: metaLabelOutcome,
  verification: metaLabelVerification,
  afterReadBack: (plan, check, verification) => {
    if (check.consistent && check.expected.label?.present === true) {
      const current = verification.current();
      assertMetaLabelScope(current);
      verification.store.rememberResource(current, plan.accountId!, check.id);
    }
  },
};
