import type {ReviewedFamily} from './reviewed-family.js';
import {fail} from './family-kit.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * Search Ads negative keywords of manual campaigns and ad groups, per TikTok API for Business v1.3 "Create negative
 * keywords", "Update a negative keyword", "Delete negative keywords", "Get negative keywords" and "Create Search Ads"
 * (checked 2026-09-26). An ad group needs Automatic Search Placement (search_result_enabled), and a campaign needs it on
 * at least one of its ad groups. Add and delete responses carry no keyword IDs, so the review reads the complete keyword
 * list of every edited campaign or ad group before and after. Adding exclusions only narrows delivery; removing,
 * replacing or renaming a keyword can widen it.
 */
export const tiktokNegativeKeywordPaths = {
  add: '/v1.3/search_ad/negative_keyword/add/',
  update: '/v1.3/search_ad/negative_keyword/update/',
  delete: '/v1.3/search_ad/negative_keyword/delete/',
};
export const tiktokNegativeKeywordGetPath = '/v1.3/search_ad/negative_keyword/get/';
const matchTypes = ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'],
  objectTypes = ['CAMPAIGN', 'ADGROUP'];
const maxObjects = 10,
  maxKeywords = 1000,
  maxPerObject = 10000,
  pageSize = 50,
  maxPages = 200,
  numeric = /^[1-9]\d*$/,
  forbidden = /[!@%^()={};~`<>?\\|]/;
type Kind = 'add' | 'update' | 'delete';
type Edit = {
  kind: Kind;
  objectType: string;
  objects: string[];
  replace: boolean;
  add: {name: string; match: string}[];
  remove: string[];
  update?: {from: string; name: string; match: string};
};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_NEGATIVE_KEYWORD', message);
}
const term = (name: unknown) => String(name).trim().toLowerCase();
const key = (name: unknown, match: unknown) => term(name) + ' [' + String(match ?? 'BROAD_WORD') + ']';
export function tiktokNegativeKeywordKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== 'tiktok_native_action' || p.method !== 'POST') return;
  return Object.entries(tiktokNegativeKeywordPaths).find(([, path]) => path === p.path)?.[0] as Kind | undefined;
}
function keyword(value: unknown, at: string, requireMatch: boolean): {name: string; match: string} {
  if (!obj(value) || Object.keys(value).some(k => k !== 'name' && k !== 'match_type'))
    invalid(at + ' takes name and match_type only.');
  const name = (value as JsonObject).name,
    match = (value as JsonObject).match_type;
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || [...name].length > 80 || forbidden.test(name))
    invalid(
      at +
        '.name must be 1–80 characters without surrounding spaces or the characters ! @ % ^ ( ) = { } ; ~ ` < > ? \\ |.',
    );
  if (match === undefined && requireMatch)
    invalid(at + '.match_type is required in an update; TikTok otherwise sets BROAD_WORD.');
  if (match !== undefined && !matchTypes.includes(match))
    invalid(at + '.match_type must be PRECISE_WORD, PHRASE_WORD or BROAD_WORD.');
  return {name: name as string, match: String(match ?? 'BROAD_WORD')};
}
export function tiktokNegativeKeywordEdit(p: CompiledRequest): Edit {
  const kind = tiktokNegativeKeywordKind(p)!,
    b = obj(p.body) ? p.body : {};
  const allowed = {
    add: ['object_ids', 'replace', 'keywords'],
    update: ['object_id', 'old_keyword_id', 'keyword'],
    delete: ['object_id', 'keyword_ids'],
  }[kind];
  if (!obj(p.body) || Object.keys(b).some(k => !['advertiser_id', 'object_type', ...allowed].includes(k)))
    invalid('This request takes advertiser_id, object_type and ' + allowed.join(', ') + '.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.');
  if (!objectTypes.includes(b.object_type)) invalid('object_type must be CAMPAIGN or ADGROUP.');
  if (kind === 'add') {
    if (
      !Array.isArray(b.object_ids) ||
      !b.object_ids.length ||
      b.object_ids.length > maxObjects ||
      b.object_ids.some((id: unknown) => typeof id !== 'string' || !numeric.test(id)) ||
      new Set(b.object_ids).size !== b.object_ids.length
    )
      invalid(
        'object_ids must name 1 to ' +
          maxObjects +
          ' distinct campaign or ad group IDs as decimal strings; the review reads each complete keyword list.',
      );
    if (b.replace !== undefined && typeof b.replace !== 'boolean') invalid('replace must be a boolean.');
    if (!Array.isArray(b.keywords) || !b.keywords.length || b.keywords.length > maxKeywords)
      invalid('keywords must hold 1 to ' + maxKeywords + ' negative keywords.');
    const add = (b.keywords as unknown[]).map((k, i) => keyword(k, 'keywords[' + i + ']', false));
    if (new Set(add.map(k => term(k.name))).size !== add.length)
      invalid('A keyword name appears twice; TikTok keeps one match type per name.');
    return {kind, objectType: b.object_type, objects: b.object_ids, replace: b.replace === true, add, remove: []};
  }
  if (typeof b.object_id !== 'string' || !numeric.test(b.object_id))
    invalid('object_id must be a campaign or ad group ID as a decimal string.');
  if (kind === 'update') {
    if (typeof b.old_keyword_id !== 'string' || !b.old_keyword_id)
      invalid('old_keyword_id must name the keyword to update.');
    const next = keyword(b.keyword, 'keyword', true);
    return {
      kind,
      objectType: b.object_type,
      objects: [b.object_id],
      replace: false,
      add: [],
      remove: [],
      update: {from: b.old_keyword_id, ...next},
    };
  }
  if (
    !Array.isArray(b.keyword_ids) ||
    !b.keyword_ids.length ||
    b.keyword_ids.length > maxKeywords ||
    b.keyword_ids.some((id: unknown) => typeof id !== 'string' || !id) ||
    new Set(b.keyword_ids).size !== b.keyword_ids.length
  )
    invalid('keyword_ids must list 1 to ' + maxKeywords + ' distinct keyword IDs.');
  return {kind, objectType: b.object_type, objects: [b.object_id], replace: false, add: [], remove: b.keyword_ids};
}
export function assertTiktokNegativeKeywords(p: CompiledRequest): void {
  if (!tiktokNegativeKeywordKind(p)) return;
  if (Object.keys(p.query).length) invalid('Negative keyword reviews take no query parameters.');
  tiktokNegativeKeywordEdit(p);
}
function read(
  p: CompiledRequest,
  path: string,
  query: JsonObject,
  action: string,
  marker: NonNullable<CompiledRequest['tiktokNegativeKeywordState']>,
): CompiledRequest {
  return {
    ...p,
    action,
    method: 'GET',
    path,
    query: {advertiser_id: p.accountId, ...query},
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    tiktokNegativeKeywordState: marker,
  };
}
/** The campaigns (with their ad groups) or ad groups, then each complete keyword list. */
export function tiktokNegativeKeywordReads(p: CompiledRequest): CompiledRequest[] {
  const e = tiktokNegativeKeywordEdit(p),
    ids = [...e.objects].sort();
  const holders =
    e.objectType === 'ADGROUP'
      ? [
          read(p, '/v1.3/adgroup/get/', {filtering: {adgroup_ids: ids}, page_size: 100}, 'tiktok_adgroup_get', {
            kind: 'adgroups',
            ids,
          }),
        ]
      : [
          read(p, '/v1.3/campaign/get/', {filtering: {campaign_ids: ids}, page_size: 100}, 'tiktok_campaign_get', {
            kind: 'campaigns',
            ids,
          }),
          read(p, '/v1.3/adgroup/get/', {filtering: {campaign_ids: ids}, page_size: 100}, 'tiktok_adgroup_get', {
            kind: 'campaign_adgroups',
            ids,
          }),
        ];
  return [
    ...holders,
    ...ids.map(id =>
      read(
        p,
        tiktokNegativeKeywordGetPath,
        {object_type: e.objectType, object_id: id, page: 1, page_size: pageSize},
        'tiktok_search_ad_negative_keyword_get',
        {kind: 'keywords', ids: [id], objectType: e.objectType},
      ),
    ),
  ];
}
export function isTiktokNegativeKeywordRead(p: CompiledRequest): boolean {
  return p.gateway === 'tiktok_native_action' && !!p.tiktokNegativeKeywordState;
}
function rows(d: JsonObject): JsonObject[] {
  return obj(d.data) && Array.isArray(d.data.list) ? d.data.list : [];
}
export function validateTiktokNegativeKeywordState(read: CompiledRequest, result: TransportResult): void {
  const m = read.tiktokNegativeKeywordState!,
    d = obj(result.data) ? result.data : {};
  if (result.status !== 200 || d.code !== 0 || !obj(d.data))
    fail('STATE_READ_FAILED', 'TikTok must confirm the negative keyword state read.');
  if (m.kind === 'keywords') {
    const list = d.data.keywords ?? [];
    if (!Array.isArray(list) || Number(d.data.page_info?.total_page ?? 1) > 1)
      fail('INCOMPLETE_STATE', 'The negative keyword list was read incompletely.');
    const seen = new Set<string>();
    for (const k of list) {
      if (
        !obj(k) ||
        typeof k.keyword_id !== 'string' ||
        !k.keyword_id ||
        typeof k.name !== 'string' ||
        !matchTypes.includes(k.match_type) ||
        seen.has(k.keyword_id)
      )
        fail('STATE_TARGET_MISMATCH', 'Negative keywords must have unique IDs, names and match types.');
      seen.add(k.keyword_id);
    }
    return;
  }
  const list = rows(d);
  if (!Array.isArray(d.data.list) || Number(d.data.page_info?.total_page ?? 1) > 1)
    fail(
      'INCOMPLETE_STATE',
      m.kind === 'campaign_adgroups'
        ? 'The campaigns have more than 100 ad groups; review fewer campaigns or name ad groups.'
        : 'The campaign or ad group list was read incompletely.',
    );
  const field = m.kind === 'campaigns' ? 'campaign_id' : m.kind === 'adgroups' ? 'adgroup_id' : 'campaign_id';
  if (
    list.some(
      r => !obj(r) || String(r.advertiser_id ?? read.accountId) !== read.accountId || !m.ids.includes(String(r[field])),
    )
  )
    fail('STATE_TARGET_MISMATCH', 'TikTok returned a campaign or ad group outside the review.');
  if (
    m.kind !== 'campaign_adgroups' &&
    (new Set(list.map(r => String(r[field]))).size !== m.ids.length || list.length !== m.ids.length)
  )
    fail(
      'STATE_NOT_FOUND',
      'Every ' +
        (m.kind === 'campaigns' ? 'campaign' : 'ad group') +
        ' of the review must exist in the selected advertiser.',
      {ids: m.ids},
    );
}
/** Complete bounded pagination of one keyword list; pages are requested by number, never by provider links. */
export async function readTiktokNegativeKeywords(
  p: CompiledRequest,
  request: (read: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (p.tiktokNegativeKeywordState?.kind !== 'keywords') return request(p);
  const all: JsonObject[] = [];
  let last: TransportResult | undefined,
    total = 1;
  for (let page = 1; page <= total; page++) {
    const response = await request({...p, query: {...p.query, page}}),
      d = obj(response.data) ? response.data : {};
    if (
      response.status !== 200 ||
      d.code !== 0 ||
      !obj(d.data) ||
      (d.data.keywords !== undefined && !Array.isArray(d.data.keywords)) ||
      Number(d.data.page_info?.page ?? page) !== page
    )
      fail('STATE_READ_FAILED', 'TikTok must return the requested page of negative keywords.');
    const pages = Number(d.data.page_info?.total_page ?? 1);
    if (!Number.isInteger(pages) || pages < 0) fail('STATE_READ_FAILED', 'TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(pages, 1);
    else if (pages !== total) fail('STATE_CHANGED', 'The keyword list changed while it was read.');
    // The first page names the page count; an oversized list is refused before reading the rest.
    if (total > maxPages)
      fail(
        'STATE_TOO_LARGE',
        'The keyword list has more than ' + maxPages * pageSize + ' entries; no mutation was submitted.',
      );
    all.push(...(d.data.keywords ?? []));
    last = response;
  }
  const keywords = all.sort((a, b) =>
    String(a.keyword_id) < String(b.keyword_id) ? -1 : String(a.keyword_id) > String(b.keyword_id) ? 1 : 0,
  );
  const result = {
    ...last!,
    data: {
      code: 0,
      message: 'OK',
      data: {keywords, page_info: {page: 1, page_size: pageSize, total_number: keywords.length, total_page: 1}},
    },
  };
  validateTiktokNegativeKeywordState(p, result);
  return result;
}
const keywordsOf = (v: unknown): JsonObject[] =>
  obj(v) && obj(v.data) && Array.isArray(v.data.keywords) ? v.data.keywords : [];
const listOf = (v: unknown): JsonObject[] => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : []);
/** Keyword set of one object after the edit, as comparable keys. */
function finalKeys(e: Edit, before: JsonObject[]): string[] {
  if (e.kind === 'add')
    return [
      ...(e.replace ? [] : before.map(k => key(k.name, k.match_type))),
      ...e.add.map(k => key(k.name, k.match)),
    ].sort();
  if (e.kind === 'delete')
    return before
      .filter(k => !e.remove.includes(k.keyword_id))
      .map(k => key(k.name, k.match_type))
      .sort();
  return [
    ...before.filter(k => k.keyword_id !== e.update!.from).map(k => key(k.name, k.match_type)),
    key(e.update!.name, e.update!.match),
  ].sort();
}
export function validateTiktokNegativeKeywordPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!tiktokNegativeKeywordKind(plan)) return;
  const e = tiktokNegativeKeywordEdit(plan),
    reads = tiktokNegativeKeywordReads(plan);
  if (state.length < reads.length) fail('STATE_READ_FAILED', 'Negative keyword state is incomplete.');
  const at = (kind: string) => reads.findIndex(r => r.tiktokNegativeKeywordState?.kind === kind);
  if (e.objectType === 'ADGROUP') {
    for (const g of listOf(state[at('adgroups')]))
      if (g.search_result_enabled !== true)
        invalid(
          'Ad group ' +
            g.adgroup_id +
            ' does not have Automatic Search Placement (search_result_enabled) enabled; negative keywords apply to Search Ads only.',
        );
  } else {
    const groups = listOf(state[at('campaign_adgroups')]);
    for (const id of e.objects)
      if (!groups.some(g => String(g.campaign_id) === id && g.search_result_enabled === true))
        invalid(
          'Campaign ' +
            id +
            ' has no ad group with Automatic Search Placement (search_result_enabled) enabled; negative keywords apply to Search Ads only.',
        );
  }
  reads.forEach((r, i) => {
    const m = r.tiktokNegativeKeywordState!;
    if (m.kind !== 'keywords') return;
    const id = m.ids[0]!,
      label = (e.objectType === 'ADGROUP' ? 'Ad group ' : 'Campaign ') + id,
      before = keywordsOf(state[i]);
    if (e.kind === 'add' && !e.replace) {
      const existing = new Set(before.map(k => term(k.name)));
      const dup = e.add.find(k => existing.has(term(k.name)));
      if (dup)
        fail(
          'CONFIGURATION_EXISTS',
          label + ' already has the negative keyword "' + dup.name + '". Update it to change its match type.',
          {object_id: id, name: dup.name},
        );
    }
    if (e.kind === 'delete')
      for (const k of e.remove)
        if (!before.some(b => b.keyword_id === k))
          fail('STATE_NOT_FOUND', label + ' has no negative keyword ' + k + '.', {object_id: id, keyword_id: k});
    if (e.kind === 'update') {
      const old = before.find(b => b.keyword_id === e.update!.from);
      if (!old)
        fail('STATE_NOT_FOUND', label + ' has no negative keyword ' + e.update!.from + '.', {
          object_id: id,
          keyword_id: e.update!.from,
        });
      if (key(old!.name, old!.match_type) === key(e.update!.name, e.update!.match))
        invalid('The update changes neither the name nor the match type of keyword ' + e.update!.from + '.');
      if (before.some(b => b.keyword_id !== e.update!.from && term(b.name) === term(e.update!.name)))
        fail('CONFIGURATION_EXISTS', label + ' already has another negative keyword named "' + e.update!.name + '".', {
          object_id: id,
          name: e.update!.name,
        });
    }
    if (finalKeys(e, before).length > maxPerObject)
      invalid(label + ' would have more than ' + maxPerObject + ' negative keywords.');
  });
}
export function tiktokNegativeKeywordImpact(plan: CompiledRequest, state: unknown[]): JsonObject | undefined {
  if (!tiktokNegativeKeywordKind(plan)) return;
  const e = tiktokNegativeKeywordEdit(plan),
    reads = tiktokNegativeKeywordReads(plan),
    widens = tiktokNegativeKeywordWidens(plan);
  const holder = state[0],
    objects = listOf(holder).map(r => ({
      id: String(r[e.objectType === 'ADGROUP' ? 'adgroup_id' : 'campaign_id']),
      name: r.adgroup_name ?? r.campaign_name ?? null,
      operation_status: r.operation_status ?? null,
    }));
  return {
    provider: 'tiktok',
    scope: 'search_negative_keywords',
    object_type: e.objectType,
    objects,
    may_affect_serving: widens,
    changes: {
      add: e.add.map(k => ({name: k.name, match_type: k.match})),
      remove: e.remove,
      replace_existing: e.replace,
      update: e.update ? {keyword_id: e.update.from, name: e.update.name, match_type: e.update.match} : null,
    },
    keywords_before: reads.flatMap((r, i) =>
      r.tiktokNegativeKeywordState?.kind === 'keywords'
        ? [{object_id: r.tiktokNegativeKeywordState.ids[0], count: keywordsOf(state[i]).length}]
        : [],
    ),
    effect: widens
      ? 'Removing, replacing or renaming negative keywords lets Search Ads show again for the removed search terms, at once for active ad groups.'
      : 'New negative keywords stop Search Ads from showing for matching search terms; this only narrows delivery.',
    verification:
      'Reads the complete negative keyword list of every campaign or ad group again and compares names and match types.',
    source: 'https://business-api.tiktok.com/portal/docs/create-negative-keywords/v1.3',
  };
}
export function tiktokNegativeKeywordOutcome(plan: CompiledRequest, response: TransportResult): boolean {
  const d = obj(response.data) ? response.data : {};
  if (response.status !== 200 || d.code !== 0 || !obj(d.data)) return false;
  return tiktokNegativeKeywordKind(plan) === 'update'
    ? typeof d.data.new_keyword_id === 'string' && !!d.data.new_keyword_id
    : true;
}
export function tiktokNegativeKeywordVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const e = tiktokNegativeKeywordEdit(plan);
  return tiktokNegativeKeywordReads(plan).flatMap((read, i) =>
    read.tiktokNegativeKeywordState?.kind === 'keywords'
      ? [
          {
            read,
            expected: {keywords: finalKeys(e, keywordsOf(before[i]))},
            id: e.objectType.toLowerCase() + ' ' + read.tiktokNegativeKeywordState.ids[0] + ' negative keywords',
          },
        ]
      : [],
  );
}
export function tiktokNegativeKeywordObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  if (read.tiktokNegativeKeywordState?.kind !== 'keywords') return data;
  return {
    keywords: keywordsOf(data)
      .map(k => key(k.name, k.match_type))
      .sort(),
  };
}
/** Adding exclusions only narrows delivery; deleting, replacing and renaming can widen it. */
export function tiktokNegativeKeywordWidens(p: CompiledRequest): boolean {
  const kind = tiktokNegativeKeywordKind(p);
  if (!kind) return false;
  return kind !== 'add' || (obj(p.body) && p.body.replace === true);
}
export function tiktokNegativeKeywordRemoves(p: CompiledRequest): boolean {
  const kind = tiktokNegativeKeywordKind(p);
  return kind === 'delete' || (kind === 'add' && obj(p.body) && p.body.replace === true);
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokNegativeKeywordFamily: ReviewedFamily = {
  name: 'tiktok_negative_keywords',
  files: ['src/tiktok-negative-keywords.ts', ['tests/tiktok-negative-keywords.test.mjs']],
  kind: tiktokNegativeKeywordKind,
  assert: plan => assertTiktokNegativeKeywords(plan),
  snapshots: tiktokNegativeKeywordReads,
  isRead: isTiktokNegativeKeywordRead,
  reader: (read, next) => readTiktokNegativeKeywords(read, next),
  validateState: validateTiktokNegativeKeywordState,
  snapshotState: (read, data, gateway) => gateway(),
  prerequisites: (plan, state) => validateTiktokNegativeKeywordPrerequisites(plan, state),
  impact: tiktokNegativeKeywordImpact,
  outcome: tiktokNegativeKeywordOutcome,
  verification: (plan: CompiledRequest, result: JsonObject, before: unknown[]) =>
    tiktokNegativeKeywordVerification(plan, before),
  observed: (read: CompiledRequest, data: JsonObject) =>
    data.amcp_absent === true ? data : tiktokNegativeKeywordObserved(read, data),
  spendConfirmation: {
    needed: plan => !!tiktokNegativeKeywordWidens(plan),
    message:
      'Removing, replacing or renaming negative keywords lets Search Ads show for more search terms. Review the keyword lists and provide spend_change_confirmed=true.',
  },
  activates: plan => !!tiktokNegativeKeywordWidens(plan),
  destructive: plan => !!tiktokNegativeKeywordRemoves(plan),
};
