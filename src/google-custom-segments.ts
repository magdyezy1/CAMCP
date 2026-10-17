import {familyCodeError, type OneCodeRefusal} from './family-kit.js';
import {stable} from './security.js';
import {googleJson} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';

export const segmentFields = ['name', 'description', 'status', 'type', 'members'];
const kinds = new Set(['customAudiences', 'customInterests']),
  resources = new Set(['custom_audience', 'custom_interest']);
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: OneCodeRefusal = familyCodeError('INVALID_CUSTOM_SEGMENT');
const plain = (v: unknown, max: number, empty = false): v is string =>
  typeof v === 'string' && (empty || !!v.trim()) && [...v].length <= max && !/[\u0000-\u001f]/.test(v);
const url = (v: unknown) => {
  if (!plain(v, 2048)) return false;
  try {
    const u = new URL(v);
    return ['http:', 'https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
};
const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF01-\uFF60\uFFE0-\uFFE6]/u;
function keyword(v: unknown) {
  return (
    plain(v, 80) && v.trim().split(/\s+/u).length <= 10 && [...v].reduce((n, c) => n + (wide.test(c) ? 2 : 1), 0) <= 80
  );
}
function member(value: unknown, interest: boolean, observed = false): JsonObject {
  if (!object(value) || typeof value.memberType !== 'string') fail('Every member needs an explicit native memberType.');
  const v = value as JsonObject,
    type = v.memberType;
  const key = interest
    ? 'parameter'
    : ({KEYWORD: 'keyword', URL: 'url', APP: 'app', PLACE_CATEGORY: 'placeCategory'} as Record<string, string>)[type];
  if (
    !key ||
    (interest && !['KEYWORD', 'URL'].includes(type)) ||
    (!observed && Object.keys(v).some(k => !['memberType', key].includes(k))) ||
    v.error !== undefined ||
    v.errors !== undefined
  )
    fail('Member fields must match the chosen native member type.');
  const field = key!;
  if (type === 'KEYWORD' && !keyword(v[field]))
    fail('Keywords use at most 10 words/80 character units; CJK and full-width characters count twice.');
  if (type === 'URL' && !url(v[field]))
    fail(
      'URL members require an HTTP(S) URL of at most 2048 characters without embedded credentials. AMCP does not fetch it.',
    );
  if (type === 'APP' && (!plain(v[field], 512) || !/^([A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/.test(v[field])))
    fail('APP members require an Android package name.');
  if (
    type === 'PLACE_CATEGORY' &&
    (typeof v[field] !== 'string' || !/^[1-9][0-9]{0,18}$/.test(v[field]) || BigInt(v[field]) > 9223372036854775807n)
  )
    fail('PLACE_CATEGORY requires a positive int64 category ID string discovered from provider data.');
  return v;
}
function members(value: unknown, interest: boolean, observed = false): JsonObject[] {
  if (!Array.isArray(value) || value.length > 1000)
    fail('A complete segment supports at most 1000 members per review.');
  const rows = (value as unknown[]).map(v => member(v, interest, observed)),
    keys = rows.map(v =>
      stable({
        memberType: v.memberType,
        value:
          v[
            interest
              ? 'parameter'
              : (
                  {KEYWORD: 'keyword', URL: 'url', APP: 'app', PLACE_CATEGORY: 'placeCategory'} as Record<
                    string,
                    string
                  >
                )[v.memberType]!
          ],
      }),
    );
  if (new Set(keys).size !== rows.length) fail('Duplicate segment members are not permitted.');
  return rows;
}
export function assertGoogleSegmentRecord(kind: string, row: JsonObject, creating: boolean) {
  if (!kinds.has(kind)) return;
  const interest = kind === 'customInterests';
  if (row.description !== undefined && !plain(row.description, 1024, true))
    fail('Description is at most 1024 characters without control characters.');
  if (creating && (!Array.isArray(row.members) || !row.members.length))
    fail('Creation requires at least one explicit targeting member.');
  if (
    row.type !== undefined &&
    !(interest ? ['CUSTOM_AFFINITY', 'CUSTOM_INTENT'] : ['AUTO', 'SEARCH']).includes(row.type)
  )
    fail('Choose a current native type; legacy INTEREST/PURCHASE_INTENT cannot be used for new custom audiences.');
  if (!creating && row.type !== undefined)
    fail('Changing an existing segment type is not qualified; preserve its native type.');
  if (
    row.status !== undefined &&
    (!interest || !(creating ? ['ENABLED'] : ['ENABLED', 'REMOVED']).includes(row.status))
  )
    fail('Custom-audience status is output-only. Custom-interest deletion uses explicit REMOVED status.');
  if (row.members !== undefined) members(row.members, interest);
}
export function assertGoogleSegmentOperation(kind: string, op: JsonObject) {
  if (!kinds.has(kind)) return;
  if (kind === 'customInterests' && op.remove)
    fail('CustomInterestOperation has no remove oneof; update status to REMOVED.');
  if (kind === 'customAudiences' && (op.create?.status !== undefined || op.update?.status !== undefined))
    fail('CustomAudience status is output-only. Use remove for deletion.');
}
export function googleSegmentResource(resource: string): boolean {
  return resources.has(resource);
}
export function googleSegmentCanonical(resource: string, row: JsonObject, defaults = false): JsonObject {
  if (!resources.has(resource)) return row;
  const out = {...row};
  if (defaults) {
    out.members ??= [];
    out.description ??= '';
  }
  if (out.members !== undefined)
    out.members = members(out.members, resource === 'custom_interest', true)
      .slice()
      .sort((a, b) => stable(a).localeCompare(stable(b), 'en'));
  return out;
}
export function googleSegmentRemoval(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    /^\/v\d+\/customers\/\d+\/customInterests:mutate$/.test(p.path) &&
    Array.isArray(googleJson(p.body).operations) &&
    googleJson(p.body).operations.some((v: JsonObject) => v.update?.status === 'REMOVED')
  );
}
export function googleSegmentKind(p: CompiledRequest): string | undefined {
  const match = /^\/v\d+\/customers\/\d+\/(customAudiences|customInterests):mutate$/.exec(p.path);
  return p.gateway === 'google_ads_native_action' && p.method === 'POST' && match ? match[1] : undefined;
}
export const googleSegmentImpact = {
  provider: 'google_ads',
  effect:
    'Creates a reusable audience definition or replaces its complete targeting membership. Edits and deletion can affect campaigns already using the segment; creating an unattached segment does not attach it to a campaign.',
  review:
    'Inspect the full existing members before replacement. Preserve every intended member explicitly; omitted members are removed. Existing segment types cannot be silently migrated.',
  verification:
    'Exact customer-scoped configuration reads verify native identity, member sets and explicit clearing. Audience reach, approval and serving are separate provider outcomes.',
  recovery:
    'Retain the original review/idempotency claim after partial or unknown outcomes. Read the resource before any correction; do not retry uncertain creation.',
};
