import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * TikTok custom audience edits, per API for Business v1.3 "Update an audience", "Delete audiences", "Apply audiences to
 * ad groups", "Get all audiences" and "Get audience details" (checked 2026-09-27). Every audience type can be renamed;
 * converting to the REACH_FREQUENCY sub type is one-way, not for lookalikes, and "If you update this field, changes to
 * other data fields will be ignored" (a REACH_FREQUENCY audience "can only be used in R&F ads"). "An expiring or expired
 * audience cannot be modified. It can only be deleted." Customer file changes (file_paths) upload customer data and stay
 * outside. Applying includes or excludes one audience in ad groups of the advertiser, or disconnects it. Replies carry
 * code 0 and empty data, so the review reads the audiences and ad groups and verification reads them again.
 */
type Route = 'update' | 'delete' | 'apply';
type State = {route: Route; audiences: string[]; adgroups: string[]; usage: boolean; details: boolean};
type Read = CompiledRequest & {tiktokAudienceEditState?: State};
export const tiktokAudienceEditPaths = {
  update: '/v1.3/dmp/custom_audience/update/',
  delete: '/v1.3/dmp/custom_audience/delete/',
  apply: '/v1.3/dmp/custom_audience/apply/',
};
const gateway = 'tiktok_native_action',
  maxIds = 100,
  nameMax = 128,
  usagePageSize = 1000,
  maxUsagePages = 10,
  smartPageSize = 100,
  maxSmartPages = 10;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).sort() : []);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_AUDIENCE_EDIT', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokAudienceEditKind(p: CompiledRequest): Route | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return Object.entries(tiktokAudienceEditPaths).find(([, path]) => path === p.path)?.[0] as Route | undefined;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const conversion = (p: CompiledRequest) =>
  tiktokAudienceEditKind(p) === 'update' && body(p).audience_sub_type !== undefined;
const audiencesOf = (p: CompiledRequest): string[] =>
  tiktokAudienceEditKind(p) === 'delete'
    ? [...(body(p).custom_audience_ids as string[])].sort()
    : [String(body(p).custom_audience_id)];
const adgroupsOf = (p: CompiledRequest): string[] =>
  tiktokAudienceEditKind(p) === 'apply' ? [...(body(p).adgroup_ids as string[])].sort() : [];
const mode = (p: CompiledRequest): 'include' | 'exclude' | 'none' =>
  body(p).action_mode === 'Disconnect' ? 'none' : body(p).usage_mode === 'Exclude' ? 'exclude' : 'include';
/** Applying or disconnecting an audience changes whom the ad groups reach. */
export function tiktokAudienceNeedsConfirmation(p: CompiledRequest): boolean {
  return tiktokAudienceEditKind(p) === 'apply';
}
function unique(v: unknown, field: string, label: string): void {
  if (!Array.isArray(v) || !v.length || v.length > maxIds || v.some(x => !numeric(x)) || new Set(v).size !== v.length)
    invalid(field + ' lists 1–' + maxIds + ' different numeric ' + label + ' IDs.');
}
export function assertTiktokAudienceEdit(p: CompiledRequest): void {
  const route = tiktokAudienceEditKind(p);
  if (!route) return;
  if (Object.keys(p.query).length) invalid('Audience edits take no query parameters.');
  const b = p.body;
  if (!obj(b)) invalid('Send the request as a JSON object.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (route === 'update') {
    if (b.file_paths !== undefined || b.action !== undefined)
      invalid('Customer file changes (file_paths, action) upload customer data and are not available here.');
    const extra = Object.keys(b).filter(
      k => !['advertiser_id', 'custom_audience_id', 'custom_audience_name', 'audience_sub_type'].includes(k),
    );
    if (extra.length)
      invalid(
        'An audience update takes custom_audience_id and custom_audience_name or audience_sub_type, not ' +
          extra.join(', ') +
          '.',
      );
    if (!numeric(b.custom_audience_id)) invalid('custom_audience_id names the audience as a numeric string.');
    if ((b.custom_audience_name === undefined) === (b.audience_sub_type === undefined))
      invalid(
        'Send either custom_audience_name or audience_sub_type; TikTok ignores other fields when the sub type changes.',
      );
    if (b.audience_sub_type !== undefined && b.audience_sub_type !== 'REACH_FREQUENCY')
      invalid('audience_sub_type can only become REACH_FREQUENCY.');
    const n = b.custom_audience_name;
    if (
      n !== undefined &&
      (typeof n !== 'string' ||
        !n.trim() ||
        n !== n.trim() ||
        [...n].length > nameMax ||
        /[\u0000-\u001f\u007f]/.test(n))
    )
      invalid('custom_audience_name has 1–' + nameMax + ' characters, without leading or trailing spaces.');
    return;
  }
  if (route === 'delete') {
    const extra = Object.keys(b).filter(k => !['advertiser_id', 'custom_audience_ids'].includes(k));
    if (extra.length) invalid('A deletion takes custom_audience_ids, not ' + extra.join(', ') + '.');
    unique(b.custom_audience_ids, 'custom_audience_ids', 'audience');
    return;
  }
  const extra = Object.keys(b).filter(
    k => !['advertiser_id', 'custom_audience_id', 'adgroup_ids', 'action_mode', 'usage_mode'].includes(k),
  );
  if (extra.length)
    invalid(
      'Applying an audience takes custom_audience_id, adgroup_ids, action_mode and usage_mode, not ' +
        extra.join(', ') +
        '.',
    );
  if (!numeric(b.custom_audience_id)) invalid('custom_audience_id names one audience as a numeric string.');
  unique(b.adgroup_ids, 'adgroup_ids', 'ad group');
  if (b.action_mode !== 'Apply' && b.action_mode !== 'Disconnect') invalid('action_mode is Apply or Disconnect.');
  if (b.action_mode === 'Apply' && b.usage_mode !== 'Include' && b.usage_mode !== 'Exclude')
    invalid('Applying an audience needs usage_mode Include or Exclude.');
  if (b.action_mode === 'Disconnect' && b.usage_mode !== undefined)
    invalid('Disconnecting an audience takes no usage_mode.');
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state?: State): Read =>
  stateReadOf<Read>(p, action, path, {advertiser_id: p.accountId, ...query}, {tiktokAudienceEditState: state});
function stateRead(p: CompiledRequest, s: State): Read {
  return read(
    p,
    'tiktok_dmp_custom_audience_list_get',
    '/v1.3/dmp/custom_audience/list/',
    {custom_audience_ids: s.audiences, page: 1, page_size: maxIds},
    s,
  );
}
function stateOf(p: CompiledRequest, verify = false): State {
  const route = tiktokAudienceEditKind(p)!;
  return {
    route,
    audiences: audiencesOf(p),
    adgroups: adgroupsOf(p),
    usage: !verify && (route === 'delete' || conversion(p)),
    details: conversion(p),
  };
}
export function tiktokAudienceEditSnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, stateOf(p))];
}
export function isTiktokAudienceEditRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokAudienceEditState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
    unverified('TikTok did not return the ' + label + '.');
  return (d as JsonObject).data;
}
async function pages(
  first: Read,
  label: string,
  max: number,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > max) unverified('The advertiser has more ' + label + ' than one review reads.');
    const d = ok(
      await request({...first, tiktokAudienceEditState: undefined, query: {...first.query, page}} as Read),
      label,
    );
    if (d.list !== undefined && !Array.isArray(d.list)) unverified('TikTok did not list the ' + label + '.');
    const n = Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(n) || n < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(n, 1);
    for (const row of (d.list ?? []) as unknown[]) {
      if (!obj(row)) unverified('A row of the ' + label + ' is malformed.');
      out.push(row as JsonObject);
    }
  }
  return out;
}
const include = (g: JsonObject) =>
  ids(g.audience_ids ?? (obj(g.targeting_spec) ? g.targeting_spec.audience_ids : undefined));
const exclude = (g: JsonObject) =>
  ids(g.excluded_audience_ids ?? (obj(g.targeting_spec) ? g.targeting_spec.excluded_audience_ids : undefined));
/** The named audiences; for deletions and conversions the ad groups that use them; for applying the named ad groups. */
export async function readTiktokAudienceEdits(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokAudienceEditState;
  if (!s) return request(p);
  const audiences: JsonObject = {};
  const d = ok(await request({...(p as Read), tiktokAudienceEditState: undefined} as Read), 'audiences');
  if (d.list !== undefined && !Array.isArray(d.list)) unverified('TikTok did not list the audiences.');
  if (Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1) > 1) unverified('TikTok paged the named audiences.');
  for (const a of (d.list ?? []) as unknown[]) {
    if (!obj(a) || !numeric(String(a.audience_id))) unverified('An audience row is malformed.');
    const id = String(a.audience_id);
    if (!s.audiences.includes(id)) unverified('TikTok listed an audience that was not named.');
    audiences['a' + id] = {
      present: true,
      id,
      name: a.name ?? null,
      type: a.audience_type ?? null,
      valid: a.is_valid === true,
      expiring: a.is_expiring === true,
      expired_time: a.expired_time ?? null,
      shared: a.shared === true,
      creator: a.is_creator === true,
    };
  }
  for (const id of s.audiences) if (!Object.hasOwn(audiences, 'a' + id)) audiences['a' + id] = {present: false, id};
  if (s.details) {
    const id = s.audiences[0]!,
      row = audiences['a' + id] as JsonObject;
    if (row.present === true) {
      const dd = ok(
        await request(
          read(p, 'tiktok_dmp_custom_audience_get', '/v1.3/dmp/custom_audience/get/', {custom_audience_ids: [id]}),
        ),
        'audience details',
      );
      const detail = (Array.isArray(dd.list) ? dd.list : [])
        .map((r: unknown) => (obj(r) && obj(r.audience_details) ? r.audience_details : undefined))
        .find((x: JsonObject | undefined) => x && String(x.audience_id) === id);
      if (!detail) unverified('TikTok did not return the audience details.');
      row.sub_type = detail.audience_sub_type ?? null;
    }
  }
  const out: JsonObject = {route: s.route, audiences};
  if (s.usage) {
    const groups = [
      ...(await pages(
        read(p, 'tiktok_adgroup_get', '/v1.3/adgroup/get/', {page: 1, page_size: usagePageSize}),
        'ad groups',
        maxUsagePages,
        request,
      )),
      ...(await pages(
        read(p, 'tiktok_smart_plus_adgroup_get', '/v1.3/smart_plus/adgroup/get/', {page: 1, page_size: smartPageSize}),
        'Upgraded Smart+ ad groups',
        maxSmartPages,
        request,
      )),
    ];
    const used: JsonObject = {};
    for (const id of s.audiences)
      used['a' + id] = [
        ...new Set(
          groups.filter(g => include(g).includes(id) || exclude(g).includes(id)).map(g => String(g.adgroup_id)),
        ),
      ].sort();
    out.used_by = used;
  }
  if (s.adgroups.length) {
    const found: JsonObject = {};
    for (const g of await pages(
      read(p, 'tiktok_adgroup_get', '/v1.3/adgroup/get/', {
        filtering: {adgroup_ids: s.adgroups},
        page: 1,
        page_size: maxIds,
      }),
      'ad groups',
      1,
      request,
    )) {
      const id = String(g.adgroup_id);
      if (!s.adgroups.includes(id)) unverified('TikTok listed an ad group that was not named.');
      found['g' + id] = {
        present: true,
        id,
        name: g.adgroup_name ?? null,
        status: g.operation_status ?? null,
        include: include(g),
        exclude: exclude(g),
      };
    }
    for (const id of s.adgroups) if (!Object.hasOwn(found, 'g' + id)) found['g' + id] = {present: false, id};
    out.adgroups = found;
  }
  return {status: 200, headers: {}, data: out};
}
export function validateTiktokAudienceEditState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokAudienceEditState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    !obj(d.audiences) ||
    s.usage !== obj(d.used_by) ||
    s.adgroups.length > 0 !== obj(d.adgroups)
  )
    unverified('Missing verified audience state.');
}
const expired = (a: JsonObject, now: number) =>
  typeof a.expired_time === 'string' &&
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.expired_time) &&
  Date.parse(a.expired_time.replace(' ', 'T') + 'Z') <= now;
export function tiktokAudienceEditPrerequisites(p: CompiledRequest, states: unknown[], now = Date.now()): void {
  const route = tiktokAudienceEditKind(p);
  if (!route) return;
  const s = states[0];
  if (!obj(s) || !obj(s.audiences)) unverified('Missing verified audience state.');
  const all = s.audiences as JsonObject,
    b = body(p),
    wanted = audiencesOf(p);
  const missing = wanted.filter(id => !obj(all['a' + id]) || (all['a' + id] as JsonObject).present !== true);
  if (missing.length)
    fail('STATE_NOT_FOUND', 'Not an audience of the selected advertiser: ' + missing.join(', ') + '.', {ids: missing});
  const rows = wanted.map(id => all['a' + id] as JsonObject);
  if (route !== 'apply') {
    const foreign = rows.filter(a => a.creator !== true).map(a => String(a.id));
    if (foreign.length)
      fail(
        'STATE_TARGET_MISMATCH',
        'Audiences ' +
          foreign.join(', ') +
          ' were shared with this advertiser by their owner; only the owner can ' +
          (route === 'delete' ? 'delete' : 'change') +
          ' them.',
        {ids: foreign},
        409,
      );
  }
  const usedBy = () => {
    if (!obj(s.used_by)) unverified('Missing verified audience usage.');
    return Object.fromEntries(
      wanted
        .map(id => [id, ((s.used_by as JsonObject)['a' + id] ?? []) as string[]])
        .filter(([, u]) => (u as string[]).length),
    );
  };
  if (route === 'update') {
    const a = rows[0]!;
    if (a.expiring === true || expired(a, now))
      fail(
        'AUDIENCE_EXPIRING',
        'Audience ' + String(a.id) + ' is expiring or expired; TikTok only deletes such audiences.',
        {audience_id: String(a.id)},
        409,
      );
    if (!conversion(p)) {
      if (a.name === b.custom_audience_name)
        invalid('Audience ' + String(a.id) + ' is already named "' + String(b.custom_audience_name) + '".');
      return;
    }
    if (a.type === 'Lookalike Audience') invalid('TikTok cannot convert a lookalike audience to REACH_FREQUENCY.');
    if (a.sub_type === 'REACH_FREQUENCY')
      invalid('Audience ' + String(a.id) + ' is already a REACH_FREQUENCY audience.');
    if (a.sub_type !== 'NORMAL') unverified('TikTok did not report the audience sub type.');
    const used = usedBy();
    if (Object.keys(used).length)
      fail(
        'AUDIENCE_IN_USE',
        'Ad groups ' +
          Object.values(used).flat().join(', ') +
          ' use audience ' +
          String(a.id) +
          '; a REACH_FREQUENCY audience can only be used in Reach & Frequency ads.',
        {in_use: used},
        409,
      );
    return;
  }
  if (route === 'delete') {
    const shared = rows.filter(a => a.shared === true).map(a => String(a.id));
    if (shared.length)
      fail(
        'AUDIENCE_SHARED',
        'Audiences ' +
          shared.join(', ') +
          ' are shared with other advertisers; cancel the sharing before deleting them.',
        {ids: shared},
        409,
      );
    const used = usedBy();
    if (Object.keys(used).length)
      fail(
        'AUDIENCE_IN_USE',
        'Ad groups ' +
          [...new Set(Object.values(used).flat())].join(', ') +
          ' include or exclude audiences ' +
          Object.keys(used).join(', ') +
          '; remove them from those ad groups first.',
        {in_use: used},
        409,
      );
    return;
  }
  const a = rows[0]!,
    id = String(a.id);
  if (expired(a, now))
    fail(
      'AUDIENCE_EXPIRING',
      'Audience ' + id + ' has expired; TikTok only deletes expired audiences.',
      {audience_id: id},
      409,
    );
  if (!obj(s.adgroups)) unverified('Missing verified ad group state.');
  const groups = adgroupsOf(p).map(g => (s.adgroups as JsonObject)['g' + g] as JsonObject);
  const absent = groups.filter(g => !obj(g) || g.present !== true).map(g => String(g?.id));
  if (absent.length)
    fail('STATE_NOT_FOUND', 'Not an ad group of the selected advertiser: ' + absent.join(', ') + '.', {ids: absent});
  const want = mode(p),
    usage = (g: JsonObject) =>
      (g.include as string[]).includes(id) ? 'include' : (g.exclude as string[]).includes(id) ? 'exclude' : 'none';
  const same = groups.filter(g => usage(g) === want).map(g => String(g.id));
  if (same.length)
    invalid(
      want === 'none'
        ? 'Ad groups ' + same.join(', ') + ' do not use audience ' + id + '.'
        : 'Ad groups ' + same.join(', ') + ' already ' + want + ' audience ' + id + '.',
    );
  const other = groups.filter(g => want !== 'none' && usage(g) !== 'none').map(g => String(g.id));
  if (other.length)
    invalid(
      'Ad groups ' +
        other.join(', ') +
        ' ' +
        (want === 'include' ? 'exclude' : 'include') +
        ' audience ' +
        id +
        '; disconnect it there first.',
    );
}
export function tiktokAudienceEditImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const route = tiktokAudienceEditKind(p);
  if (!route) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    all: JsonObject = obj(s.audiences) ? s.audiences : {},
    b = body(p);
  const source =
    'https://business-api.tiktok.com/portal/docs/' +
    (route === 'update'
      ? 'update-an-audience'
      : route === 'delete'
        ? 'delete-audiences'
        : 'apply-audiences-to-ad-groups') +
    '/v1.3';
  if (route === 'update') {
    const a = all['a' + audiencesOf(p)[0]] ?? {id: audiencesOf(p)[0]};
    return conversion(p)
      ? {
          provider: 'tiktok',
          scope: 'custom_audience',
          operation: 'convert_to_reach_frequency',
          audience: a,
          may_affect_serving: false,
          effect:
            'Makes the audience a REACH_FREQUENCY audience, which can only be used in Reach & Frequency ads; TikTok cannot convert it back. No ad group uses it.',
          verification: 'Reads the audience details again and expects the REACH_FREQUENCY sub type.',
          source,
        }
      : {
          provider: 'tiktok',
          scope: 'custom_audience',
          operation: 'rename',
          audience: a,
          name: b.custom_audience_name,
          may_affect_serving: false,
          effect: 'Renames the audience; its members and the ad groups that use it are unchanged.',
          verification: 'Reads the audience again and compares its name.',
          source,
        };
  }
  if (route === 'delete')
    return {
      provider: 'tiktok',
      scope: 'custom_audiences',
      operation: 'delete',
      deleting: audiencesOf(p).map(id => all['a' + id] ?? {id}),
      may_affect_serving: false,
      effect:
        'Deletes the audiences; they are not shared, and no ad group or Upgraded Smart+ ad group of the advertiser includes or excludes them.',
      verification: 'Lists the audiences again and expects them to be gone.',
      source,
    };
  const groups: JsonObject = obj(s.adgroups) ? s.adgroups : {},
    named = adgroupsOf(p).map(id => groups['g' + id] ?? {id}),
    want = mode(p);
  const enabled = named.filter((g: JsonObject) => g.status === 'ENABLE').map((g: JsonObject) => String(g.id));
  return {
    provider: 'tiktok',
    scope: 'adgroup_audiences',
    operation: want === 'none' ? 'disconnect' : want,
    audience: all['a' + audiencesOf(p)[0]] ?? {id: audiencesOf(p)[0]},
    adgroups: named.map((g: JsonObject) => ({id: g.id, name: g.name ?? null, status: g.status ?? null})),
    enabled_adgroups: enabled,
    may_affect_serving: enabled.length > 0,
    effect:
      (want === 'include'
        ? 'Adds the audience to the targeting of'
        : want === 'exclude'
          ? 'Excludes the audience from'
          : 'Removes the audience from the targeting of') +
      ' ' +
      named.length +
      ' ad group' +
      (named.length === 1 ? '' : 's') +
      (enabled.length ? '; ' + enabled.length + ' of them are enabled and reach different people at once.' : '.'),
    verification:
      'Reads the ad groups again and checks whether each one includes, excludes or no longer uses the audience.',
    source,
  };
}
export function tiktokAudienceEditOutcome(_p: CompiledRequest, r: TransportResult): boolean {
  return r.status === 200 && obj(r.data) && r.data.code === 0;
}
export function tiktokAudienceEditVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const route = tiktokAudienceEditKind(p)!,
    b = body(p),
    state = stateOf(p, true),
    list = audiencesOf(p);
  if (route === 'delete')
    return [
      {
        read: stateRead(p, state),
        expected: {audiences: Object.fromEntries(list.map(id => ['a' + id, {present: false}]))},
        id: list.join(','),
      },
    ];
  if (route === 'update')
    return [
      {
        read: stateRead(p, state),
        expected: {
          audiences: {
            ['a' + list[0]]: conversion(p)
              ? {present: true, sub_type: 'REACH_FREQUENCY'}
              : {present: true, name: b.custom_audience_name},
          },
        },
        id: list[0]!,
      },
    ];
  const want = mode(p);
  return [
    {
      read: stateRead(p, state),
      expected: {adgroups: Object.fromEntries(adgroupsOf(p).map(id => ['g' + id, {present: true, usage: want}]))},
      id: list[0] + ':' + adgroupsOf(p).join(','),
    },
  ];
}
/** Ad groups are compared by how they use the named audience; the audience lists themselves are kept in review state. */
export function tiktokAudienceEditObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const s = (read as Read).tiktokAudienceEditState,
    out: JsonObject = {audiences: obj(data.audiences) ? data.audiences : {}};
  if (s?.adgroups.length && obj(data.adgroups)) {
    const id = s.audiences[0]!;
    out.adgroups = Object.fromEntries(
      Object.entries(data.adgroups).map(([k, g]) => [
        k,
        obj(g) && g.present === true
          ? {
              present: true,
              usage: ids(g.include).includes(id) ? 'include' : ids(g.exclude).includes(id) ? 'exclude' : 'none',
            }
          : {present: false},
      ]),
    );
  }
  return out;
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokAudienceEditFamily: ReviewedFamily = defineFamily({
  name: 'tiktok_audience_edits',
  files: ['src/tiktok-audience-edits.ts', ['tests/tiktok-audience-edits.test.mjs']],
  kind: tiktokAudienceEditKind,
  assert: assertTiktokAudienceEdit,
  snapshots: tiktokAudienceEditSnapshots,
  isRead: isTiktokAudienceEditRead,
  reader: readTiktokAudienceEdits,
  validateState: validateTiktokAudienceEditState,
  prerequisites: (plan, state) => tiktokAudienceEditPrerequisites(plan, state),
  impact: tiktokAudienceEditImpact,
  outcome: tiktokAudienceEditOutcome,
  verification: tiktokAudienceEditVerification,
  observed: tiktokAudienceEditObserved,
  spendConfirmation: {
    needed: tiktokAudienceNeedsConfirmation,
    message:
      'Applying or disconnecting an audience changes whom the ad groups reach while they deliver. Review the ad groups and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
});
