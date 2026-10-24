import {measurementOutcome, measurementSnapshots, measurementVerification} from './measurement-writes.js';
import type {ReviewedFamily} from './reviewed-family.js';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {familyCodeError, type OneCodeRefusal, readOf} from './family-kit.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

export const appleEntityContracts = {
  adgroup: {collection: 'adgroups', model: 'AdGroup', parents: {campaignId: 'campaigns'}, paused: true},
  ad: {collection: 'ads', model: 'Ad', parents: {adGroupId: 'adgroups', creativeId: 'creatives'}, paused: true},
  creative: {collection: 'creatives', model: 'Creative', parents: {}, paused: false},
  keyword: {collection: 'keywords', model: 'Keyword', parents: {adGroupId: 'adgroups'}, paused: true},
  negative_keyword: {
    collection: 'negative-keywords',
    model: 'NegativeKeyword',
    parents: {campaignId: 'campaigns', adGroupId: 'adgroups'},
    paused: false,
  },
  shared_budget: {collection: 'shared-budgets', model: 'SharedBudget', parents: {}, paused: false},
} as const;
type Kind = keyof typeof appleEntityContracts;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown) =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9]\d*$/.test(v));
const fail: OneCodeRefusal = familyCodeError('INVALID_APPLE_REQUEST');
let artifact: JsonObject | undefined;
export const appleModelEvidence = (): JsonObject =>
  (artifact ??= JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../../generated/apple-platform-v1-models.json', import.meta.url)), 'utf8'),
  ));
export function appleEntityKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'apple_ads_native_action' || p.origin !== 'https://api.ads.apple.com') return;
  for (const [kind, c] of Object.entries(appleEntityContracts))
    for (const [verb, method] of [
      ['create', 'POST'],
      ['update', 'PUT'],
      ['delete', 'DELETE'],
    ]) {
      if (
        p.action === 'apple_ads_v1_' + kind + '_' + verb &&
        p.method === method &&
        new RegExp('^/v1/' + c.collection + (verb === 'create' ? '' : '/[1-9]\\d*') + '$').test(p.path)
      )
        return kind as Kind;
    }
}
/** Vendor type facts supply the accepted field names; business safeguards below
 * remain explicit. No inferred endpoint or catalog addition grants permission. */
export function assertAppleEntityWrite(p: CompiledRequest): void {
  const kind = appleEntityKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length) fail('Apple entity mutations do not accept URL query overrides.');
  if (p.method === 'DELETE') {
    if (p.body !== undefined && (!obj(p.body) || Object.keys(p.body).length)) fail('Apple DELETE has no payload.');
    return;
  }
  if (!obj(p.body) || !Object.keys(p.body).length) fail('Provide a nonempty native Apple payload.');
  const body = p.body,
    contract = appleEntityContracts[kind],
    models = appleModelEvidence().models;
  let nodes = 0;
  const visit = (type: string, value: unknown, field: string, depth = 0): void => {
    if (++nodes > 20000 || depth > 32) fail('Apple request exceeds validation bounds.');
    if (type.endsWith(' | null')) {
      if (value === null) return;
      type = type.slice(0, -7);
    }
    if (type.startsWith('Array<')) {
      if (!Array.isArray(value) || value.length > 5000) fail('Expected an array with at most 5000 entries.', {field});
      value.forEach((v, i) => visit(type.slice(6, -1), v, field + '/' + i, depth + 1));
      return;
    }
    if (type === 'object') {
      if (!obj(value)) fail('Expected an object.', {field});
      return;
    }
    if (['string', 'number', 'boolean'].includes(type)) {
      if (typeof value !== type || (type === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value))))
        fail('Invalid native ' + type + ' value.', {field});
      return;
    }
    const model = models[type];
    if (!model)
      throw new MirrorError('VENDOR_SCHEMA_UNAVAILABLE', 'Apple model is absent from the pinned SDK facts.', {
        model: type,
      });
    if (model.enum) {
      if (!model.enum.includes(value))
        fail('Value is absent from the pinned Apple enum.', {field, allowed: model.enum});
      return;
    }
    if (!obj(value)) fail('Expected an object.', {field});
    for (const [key, definition] of Object.entries(model.fields) as [string, JsonObject][])
      if (definition.required && !Object.hasOwn(value, key))
        fail('A required native field is missing.', {field: field + '/' + key});
    for (const [key, v] of Object.entries(value)) {
      const definition = model.fields[key];
      if (!definition) fail('Field is absent from the pinned Apple model.', {field: field + '/' + key});
      visit(definition.type, v, field + '/' + key, depth + 1);
    }
    if (type === 'Money') {
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value.amount) || Number(value.amount) > Number.MAX_SAFE_INTEGER / 100)
        fail('Apple money requires a nonnegative decimal string with at most two decimal places.', {field});
      if (value.currency != null && !/^[A-Z]{3}$/.test(value.currency))
        fail('Money currency must be a three-letter uppercase code.', {field});
    }
  };
  visit(contract.model + (p.method === 'POST' ? 'Create' : 'Update'), body, '');
  for (const key of ['name', 'text']) if (body[key] !== undefined && !body[key].trim()) fail(key + ' cannot be blank.');
  for (const key of Object.keys(contract.parents))
    if (body[key] != null && !id(body[key])) fail(key + ' must be a positive resource ID.');
  if (p.method === 'POST' && contract.paused && body.status !== 'PAUSED')
    throw new MirrorError(
      'PAUSED_CREATION_REQUIRED',
      'New Apple ad groups, ads and keywords require explicit status PAUSED.',
    );
  if (
    kind === 'negative_keyword' &&
    p.method === 'POST' &&
    ['campaignId', 'adGroupId'].filter(k => body[k] != null).length !== 1
  )
    fail('A negative keyword requires exactly one campaignId or adGroupId parent.');
  if (kind === 'shared_budget' && body.adAccountIds !== undefined) {
    const ids = body.adAccountIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some(v => !id(v)) ||
      new Set(ids.map(String)).size !== ids.length ||
      !ids.map(String).includes(p.accountId!)
    )
      fail(
        'Shared budgets require 1–100 distinct accounts including account_id; every account needs a write grant on this connection.',
      );
  }
  for (const key of ['startTime', 'endTime'])
    if (
      body[key] != null &&
      (typeof body[key] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body[key]) ||
        !Number.isFinite(Date.parse(body[key])))
    )
      fail(key + ' must be an explicit ISO timestamp with a timezone.');
  if (body.startTime && body.endTime && Date.parse(body.startTime) >= Date.parse(body.endTime))
    fail('endTime must follow startTime.');
}
function read(p: CompiledRequest, path: string, account = p.accountId!, optional = false): CompiledRequest {
  return readOf(p, {
    before: {accountId: account},
    action: optional ? 'AMCP_STATE_OPTIONAL' : 'AMCP_APPLE_ENTITY_STATE',
    path,
    query: {},
    clears: ['specialTransport', 'responseControls'],
  });
}
export function appleSharedAccounts(p: CompiledRequest, value?: unknown): string[] {
  if (appleEntityKind(p) !== 'shared_budget') return [];
  const before = obj(value) && obj(value.result) ? value.result.adAccountIds : [];
  if (
    value !== undefined &&
    (!Array.isArray(before) ||
      !before.length ||
      before.length > 100 ||
      before.some(v => !id(v)) ||
      new Set(before.map(String)).size !== before.length ||
      !before.map(String).includes(p.accountId!))
  )
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Shared budget must identify its complete account membership, including the selected account.',
    );
  const body = obj(p.body) ? p.body : {};
  return [
    ...new Set([
      p.accountId!,
      ...(p.scopeContext?.appleSharedAccountIds ?? []),
      ...(body.adAccountIds ?? []).map(String),
      ...(before ?? []).map(String),
    ]),
  ].sort();
}
export function appleEntitySnapshots(p: CompiledRequest): CompiledRequest[] {
  const kind = appleEntityKind(p)!;
  const c = appleEntityContracts[kind],
    body = obj(p.body) ? p.body : {};
  const targets = p.method === 'POST' ? [] : [read(p, p.path)];
  const accounts = kind === 'shared_budget' ? appleSharedAccounts(p) : [p.accountId!];
  targets.push(...accounts.map(account => read(p, '/v1/ad-accounts/' + account, account)));
  if (p.method === 'POST')
    for (const [field, collection] of Object.entries(c.parents))
      if (body[field] != null) targets.push(read(p, '/v1/' + collection + '/' + body[field]));
  return targets;
}
/** Before exposing a shared resource or freezing it, callers authorize the union
 * of old and new accounts. The extra account reads also freeze org and currency. */
export function appleSharedAccountReads(p: CompiledRequest, accounts: string[]): CompiledRequest[] {
  return accounts.map(account => read(p, '/v1/ad-accounts/' + account, account));
}
export function validateAppleEntityState(readPlan: CompiledRequest, data: JsonObject): void {
  const r = data.result,
    collection = readPlan.path.split('/')[2];
  if (!obj(r) || !id(r.id) || String(r.id) !== readPlan.path.split('/').at(-1))
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Apple did not return the exact requested resource.');
  if (collection !== 'ad-accounts' && collection !== 'shared-budgets' && String(r.adAccountId) !== readPlan.accountId)
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Apple resource did not identify the selected ad account.');
  if (
    collection === 'shared-budgets' &&
    (!Array.isArray(r.adAccountIds) || !r.adAccountIds.map(String).includes(readPlan.accountId!))
  )
    throw new MirrorError('STATE_TARGET_MISMATCH', 'Shared budget does not include the selected ad account.');
}
export function validateAppleEntityPrerequisites(p: CompiledRequest, reads: CompiledRequest[], state: unknown[]): void {
  const kind = appleEntityKind(p);
  if (!kind) return;
  const body = obj(p.body) ? p.body : {},
    byPath = new Map(reads.map((r, i) => [r.path, (state[i] as JsonObject)?.result as JsonObject]));
  for (const r of byPath.values())
    if (r?.deleted === true)
      throw new MirrorError('STATE_TARGET_DELETED', 'A selected Apple resource or parent is deleted.');
  const target = byPath.get(p.path),
    start = body.startTime ?? target?.startTime,
    end = body.endTime === null ? null : (body.endTime ?? target?.endTime);
  if (start && end && Date.parse(start) >= Date.parse(end)) fail('The resulting endTime must follow startTime.');
  const accounts = [...byPath].filter(([path]) => path.startsWith('/v1/ad-accounts/')).map(([, v]) => v);
  const money = [
    body.bid,
    body.bidStrategy?.bid,
    body.cpaCap?.value,
    ...(kind === 'shared_budget' ? [body.value ?? target?.value] : []),
  ].filter(obj);
  if (money.length) {
    const currencies = new Set(accounts.map(a => a.currency));
    if (currencies.size !== 1 || typeof accounts[0]?.currency !== 'string')
      throw new MirrorError('STATE_CURRENCY_REQUIRED', 'Money changes require a known common account currency.');
    for (const m of money)
      if (m.currency != null && m.currency !== accounts[0]!.currency)
        throw new MirrorError('CURRENCY_MISMATCH', 'Money currency must match every affected account.');
  }
  if (kind === 'shared_budget') {
    const orgs = new Set(accounts.map(a => String(a.orgId ?? '')));
    if (orgs.size !== 1 || !id(accounts[0]?.orgId) || (target && String(target.orgId) !== String(accounts[0]!.orgId)))
      throw new MirrorError(
        'STATE_ORGANIZATION_MISMATCH',
        'All shared-budget accounts and the existing budget must identify the same organization.',
      );
  }
  if (!p.scopeContext?.appleCurrency && typeof accounts[0]?.currency === 'string')
    p.scopeContext = {...p.scopeContext, appleCurrency: accounts[0]!.currency};
}
export function appleEntityOutcome(p: CompiledRequest, response: TransportResult): boolean {
  const kind = appleEntityKind(p)!;
  if (!obj(response.data) || response.data.error) return false;
  const result = response.data.result;
  if (p.method === 'DELETE')
    return (
      response.status === 200 &&
      (result === null || result === undefined) &&
      Object.keys(response.data).every(k => ['result', 'error'].includes(k))
    );
  if (
    ![200, 201].includes(response.status) ||
    !obj(result) ||
    !id(result.id) ||
    (p.method !== 'POST' && String(result.id) !== p.path.split('/').at(-1))
  )
    return false;
  if (kind === 'shared_budget') {
    const expected = (obj(p.body) ? p.body.adAccountIds : undefined) ?? p.scopeContext?.appleSharedResultAccounts;
    if (
      !Array.isArray(expected) ||
      !Array.isArray(result.adAccountIds) ||
      result.adAccountIds.length !== expected.length ||
      new Set(result.adAccountIds.map(String)).size !== expected.length ||
      expected.some((v: unknown) => !result.adAccountIds.map(String).includes(String(v)))
    )
      return false;
    return id(result.orgId) && String(result.orgId) === p.scopeContext?.appleSharedOrgId;
  }
  if (String(result.adAccountId) !== p.accountId) return false;
  const body = obj(p.body) ? p.body : {};
  for (const field of Object.keys(appleEntityContracts[kind].parents))
    if (body[field] != null && String(result[field]) !== String(body[field])) return false;
  return true;
}
export function appleEntityVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  if (p.method === 'DELETE')
    return [{read: read(p, p.path, p.accountId, true), expected: {amcp_absent: true, path: p.path}, id: p.path}];
  const kind = appleEntityKind(p)!,
    id = String(result.data.result.id),
    path = '/v1/' + appleEntityContracts[kind].collection + '/' + id;
  const body = structuredClone(obj(p.body) ? p.body : {});
  if (Array.isArray(body.adAccountIds))
    body.adAccountIds.sort((a: unknown, b: unknown) => String(a).localeCompare(String(b), 'en'));
  for (const money of [
    body.bid,
    body.bidStrategy?.bid,
    body.cpaCap?.value,
    ...(kind === 'shared_budget' ? [body.value] : []),
  ].filter(obj))
    if (money.currency == null && p.scopeContext?.appleCurrency) money.currency = p.scopeContext.appleCurrency;
  return [{read: read(p, path), expected: {...body, id}, id}];
}
export function appleEntityServing(p: CompiledRequest): boolean {
  const kind = appleEntityKind(p);
  return (
    kind === 'shared_budget' ||
    kind === 'negative_keyword' ||
    (kind === 'creative' && p.method !== 'POST') ||
    (kind === 'adgroup' &&
      p.method === 'PUT' &&
      Object.keys(obj(p.body) ? p.body : {}).some(k => !['name', 'status'].includes(k)))
  );
}
export function appleBudgetState(p: CompiledRequest, before: unknown): unknown {
  if (appleEntityKind(p) !== 'shared_budget') return before;
  const rows = Array.isArray(before) ? before : [],
    target = rows.find(
      r =>
        obj(r) &&
        obj(r.result) &&
        String(r.result.id) === p.path.split('/').at(-1) &&
        Array.isArray(r.result.adAccountIds),
    );
  return target ? {shared_budget: {value: target.result.value}} : {};
}

/** What an entity write changes, as prepare returns it for review. */
export function appleEntityImpact(plan: CompiledRequest): JsonObject {
  return {
    provider: 'apple',
    scope: appleEntityKind(plan),
    affected_account_ids: plan.scopeContext?.appleSharedAccountIds ?? [plan.accountId],
    effect:
      appleEntityKind(plan) === 'shared_budget'
        ? 'Changes a budget shared by all listed accounts. Every affected account must remain write-authorized; each account policy reserves the entire positive increase conservatively.'
        : 'Changes the selected entity. Creative edits and exclusions may affect already enabled ads.',
    verification:
      'Exact configuration read-back proves the requested fields, not creative approval or serving. Provider business constraints and access remain live checks.',
    recovery:
      'Never repeat an uncertain mutation. Read the exact resources and retained receipt; a correction needs a fresh review.',
  };
}

/**
 * A shared-budget write, which changes a budget several ad accounts share. Each account must remain writable by the
 * review's connection, so the review lifecycle checks them itself (write-review.ts, write-verification.ts).
 */
export function appleSharedBudget(p: CompiledRequest): boolean {
  return appleEntityKind(p) === 'shared_budget';
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const appleEntityFamily: ReviewedFamily = {
  name: 'apple_entities',
  files: ['src/apple-entity-writes.ts', ['tests/apple-entity-writes.test.ts']],
  kind: appleEntityKind,
  snapshots: measurementSnapshots,
  prerequisites: (plan, state, reads) => validateAppleEntityPrerequisites(plan, reads, state),
  impact: appleEntityImpact,
  outcome: measurementOutcome,
  verification: measurementVerification,
  spendConfirmation: {
    needed: plan => !!appleEntityServing(plan),
    message:
      'Apple shared budgets, exclusions, creative edits and serving settings can affect existing campaigns. Provide spend_change_confirmed=true.',
  },
  activates: plan => !!appleEntityServing(plan),
};
