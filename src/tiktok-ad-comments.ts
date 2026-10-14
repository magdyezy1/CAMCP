import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Hiding and unhiding comments on an advertiser's ads (PRV-06 B), per TikTok's official Business API SDK
 * (tiktok/tiktok-business-api-sdk, yml_files/comment_status_update.yml, read 2026-10-08 by the engineering review):
 * POST /v1.3/comment/status/update/ with advertiser_id, comment_ids and operation PUBLIC or HIDDEN ("change the statuses
 * of a list of comments from public to hidden, or vice versa"), and an optional ad_type BIDDING (TikTok's default) or
 * BRAND. Hiding is reversible. Replies (comment/post) and deletion (comment/delete) stay blocked writes.
 *
 * The request names comments only by ID, so the review finds them in TikTok's comment list (GET /v1.3/comment/list/,
 * whose search_field, search_value, start_time and end_time the captured catalog lists as required). The caller gives
 * that read as comment_scope beside the request: one ad, ad group or campaign of the advertiser and a window of at most
 * 31 days. AMCP never sends it with the update; it is part of the frozen review. Every comment must be in that list
 * with a known status, and none may already have the status asked for. Comment text and authors are third-party
 * content about people: the review keeps only each comment's ID, ad and status, and nothing else the list returns. No
 * spending confirmation: comments do not change delivery or spend. Verification reads the same list again and compares
 * each comment's status; a receipt that names failures, or omits a requested comment, is a partial outcome.
 *
 * Unverified until native acceptance on a test ad: the list response's field names (data.comments or data.list, and
 * status), its date format (YYYY-MM-DD) and the search_field names; a list that does not match is refused, never guessed.
 */
type State = {ids: string[]};
type Read = CompiledRequest & {tiktokCommentState?: State};
export const tiktokCommentStatusPath = '/v1.3/comment/status/update/';
const gateway = 'tiktok_native_action',
  listPath = '/v1.3/comment/list/',
  source = 'https://github.com/tiktok/tiktok-business-api-sdk/blob/main/yml_files/comment_status_update.yml',
  maxComments = 100,
  pageSize = 100,
  maxPages = 20,
  maxWindowDays = 31,
  day = 86400000,
  // The ID field each documented search field filters on, checked in every row TikTok returns.
  scopes: Record<string, string> = {AD_ID: 'ad_id', ADGROUP_ID: 'adgroup_id', CAMPAIGN_ID: 'campaign_id'};
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,32}$/.test(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string, details: JsonObject = {}): never {
  return fail('INVALID_TIKTOK_COMMENT', message, details);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokCommentKind(p: CompiledRequest): 'hide' | 'unhide' | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport || p.path !== tiktokCommentStatusPath) return;
  return obj(p.body) && p.body.operation === 'PUBLIC' ? 'unhide' : 'hide';
}
/**
 * Compiler hook: the comment_scope of a comment status update, carried beside the request as tiktokCommentScope and
 * never sent. Refused for every other TikTok action; validated by the family before any read.
 */
export function tiktokCommentScope(path: string, value: unknown): JsonObject | undefined {
  if (value === undefined) return;
  if (path !== tiktokCommentStatusPath)
    fail('UNSUPPORTED_PARAMETER', 'comment_scope only reviews a TikTok comment status update.', {
      parameter: 'comment_scope',
    });
  if (!obj(value)) invalid('comment_scope is an object.', {field: 'comment_scope'});
  return JSON.parse(JSON.stringify(value));
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const ids = (p: CompiledRequest): string[] => (body(p).comment_ids as string[]) ?? [];
const target = (p: CompiledRequest) => (body(p).operation === 'PUBLIC' ? 'PUBLIC' : 'HIDDEN');
const scopeOf = (p: CompiledRequest): JsonObject => (obj(p.tiktokCommentScope) ? p.tiktokCommentScope : {});
function date(v: unknown, field: string): number {
  const t = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v)
    invalid('start_time and end_time are dates (YYYY-MM-DD).', {field: 'comment_scope.' + field});
  return t;
}
/** The comment list read that finds the comments: one ad, ad group or campaign and at most 31 days. */
function assertScope(p: CompiledRequest, now = Date.now()): void {
  const s = p.tiktokCommentScope;
  if (s === undefined)
    invalid(
      'Give comment_scope beside the request: the comment list read that finds these comments (search_field, search_value, start_time, end_time).',
      {field: 'comment_scope'},
    );
  if (!obj(s) || Object.keys(s).sort().join() !== 'end_time,search_field,search_value,start_time')
    invalid('comment_scope takes exactly search_field, search_value, start_time and end_time.', {
      field: 'comment_scope',
    });
  if (!Object.hasOwn(scopes, s.search_field as string))
    invalid('comment_scope.search_field is AD_ID, ADGROUP_ID or CAMPAIGN_ID.', {field: 'comment_scope.search_field'});
  if (!numeric(s.search_value))
    invalid('comment_scope.search_value is the ID of an ad, ad group or campaign of the advertiser.', {
      field: 'comment_scope.search_value',
    });
  const start = date(s.start_time, 'start_time'),
    end = date(s.end_time, 'end_time');
  if (end < start) invalid('end_time is on or after start_time.', {field: 'comment_scope.end_time'});
  if ((end - start) / day + 1 > maxWindowDays)
    invalid('The comment window spans at most 31 days.', {field: 'comment_scope', limit_days: maxWindowDays});
  if (end > now + day) invalid('end_time is not in the future.', {field: 'comment_scope.end_time'});
}
export function assertTiktokComments(p: CompiledRequest): void {
  if (!tiktokCommentKind(p)) return;
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('A comment status update takes no query or header overrides.');
  const b = p.body;
  if (!obj(b) || Object.keys(b).some(k => !['advertiser_id', 'comment_ids', 'operation', 'ad_type'].includes(k)))
    invalid('This request takes advertiser_id, comment_ids, operation and ad_type.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  const list = b.comment_ids;
  if (!Array.isArray(list) || !list.length || list.length > maxComments || !list.every(numeric))
    invalid('comment_ids lists 1 to 100 comment IDs, each a string of digits.', {field: 'comment_ids'});
  if (new Set(list).size !== list.length) invalid('comment_ids lists a comment twice.', {field: 'comment_ids'});
  if (!['HIDDEN', 'PUBLIC'].includes(b.operation as string))
    invalid('operation is HIDDEN (hide) or PUBLIC (unhide).', {field: 'operation'});
  if (b.ad_type !== undefined && !['BIDDING', 'BRAND'].includes(b.ad_type as string))
    invalid('ad_type is BIDDING (the default) or BRAND.', {field: 'ad_type'});
  assertScope(p);
}
const listRead = (p: CompiledRequest): Read => {
  const s = scopeOf(p);
  return {
    ...p,
    action: 'tiktok_comment_list_get',
    method: 'GET',
    path: listPath,
    query: {
      advertiser_id: p.accountId,
      search_field: s.search_field,
      search_value: s.search_value,
      start_time: s.start_time,
      end_time: s.end_time,
      page: 1,
      page_size: pageSize,
    },
    body: undefined,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
    tiktokCommentScope: undefined,
    tiktokCommentState: {ids: [...ids(p)].sort()},
  };
};
export function tiktokCommentSnapshots(p: CompiledRequest): Read[] {
  return [listRead(p)];
}
export function isTiktokCommentRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokCommentState;
}
/**
 * The requested comments in the comment list of the scope, every page (at most 20 pages of 100). Only their ID, ad and
 * status are kept: the text, the author and every other comment the list returns are dropped here.
 */
export async function readTiktokComments(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokCommentState;
  if (!s) return request(p);
  const field = scopes[String(p.query.search_field)],
    wanted = new Set(s.ids),
    found = new Map<string, JsonObject>();
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > maxPages)
      unverified('The comment list of comment_scope has more pages than one review reads; narrow it.');
    const r = await request({...p, query: {...p.query, page}}),
      d = r.data;
    if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
      unverified('TikTok did not return the comment list.');
    const data = (d as JsonObject).data as JsonObject,
      rows = Array.isArray(data.comments) ? data.comments : Array.isArray(data.list) ? data.list : undefined;
    if (!rows) unverified('TikTok did not return the comment list.');
    const pages = Number(obj(data.page_info) ? (data.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(pages) || pages < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(pages, 1);
    for (const row of rows as unknown[]) {
      if (!obj(row) || !numeric(String(row.comment_id ?? ''))) unverified('A comment row is malformed.');
      const c = row as JsonObject;
      if (c.advertiser_id !== undefined && String(c.advertiser_id) !== p.accountId)
        fail('STATE_TARGET_MISMATCH', 'TikTok listed a comment of another advertiser.', {}, 409);
      if (field && c[field] !== undefined && c[field] !== null && String(c[field]) !== String(p.query.search_value))
        unverified('TikTok listed a comment outside comment_scope.');
      const id = String(c.comment_id);
      if (!wanted.has(id)) continue;
      if (found.has(id)) unverified('TikTok listed a comment twice.');
      const status = c.status ?? c.comment_status;
      found.set(id, {
        comment_id: id,
        listed: true,
        status: status === 'PUBLIC' || status === 'HIDDEN' ? status : null,
        ad_id: c.ad_id === undefined || c.ad_id === null ? null : String(c.ad_id),
      });
    }
  }
  return {
    status: 200,
    headers: {},
    data: {comments: s.ids.map(id => found.get(id) ?? {comment_id: id, listed: false, status: null, ad_id: null})},
  };
}
export function validateTiktokCommentState(p: CompiledRequest, r: TransportResult): void {
  if (!(p as Read).tiktokCommentState || r.status !== 200 || !obj(r.data) || !Array.isArray(r.data.comments))
    unverified('Missing verified comment state.');
}
const comments = (states: unknown[]): JsonObject[] => {
  const s = states[0];
  if (!obj(s) || !Array.isArray(s.comments)) unverified('Missing verified comment state.');
  return (s as JsonObject).comments as JsonObject[];
};
/**
 * Every comment is in the list of the scope with a known status, and none already has the status asked for. Checked on
 * the whole reviewed state (stateChecks): at prepare, and at execute once the state is unchanged, so a comment that
 * changed or vanished since review is STATE_CHANGED naming it.
 */
export function tiktokCommentStateChecks(p: CompiledRequest, states: unknown[]): void {
  if (!tiktokCommentKind(p)) return;
  const rows = comments(states),
    missing = rows.filter(c => c.listed !== true).map(c => c.comment_id as string);
  if (missing.length)
    fail(
      'STATE_NOT_FOUND',
      'Some comments are not in the comment list of comment_scope; list the comments of that ad and window first.',
      {comment_ids: missing},
    );
  if (rows.some(c => c.status === null)) unverified('TikTok did not give the status of every comment.');
  const same = rows.filter(c => c.status === target(p)).map(c => c.comment_id as string);
  if (same.length)
    fail('CONFIGURATION_EXISTS', 'Some comments already have this status; leave them out of the request.', {
      comment_ids: same,
      status: target(p),
    });
}
export function tiktokCommentImpact(p: CompiledRequest, states: unknown[]): JsonObject | undefined {
  const kind = tiktokCommentKind(p);
  if (!kind) return;
  const s = states[0],
    rows = obj(s) && Array.isArray(s.comments) ? (s.comments as JsonObject[]) : [];
  return {
    provider: 'tiktok',
    scope: 'ad_comments',
    operation: kind,
    status_after: target(p),
    ad_type: body(p).ad_type ?? 'BIDDING',
    comments: rows.map(c => ({comment_id: c.comment_id, ad_id: c.ad_id ?? null, status_before: c.status ?? null})),
    count: rows.length,
    found_in: scopeOf(p),
    may_affect_serving: false,
    effect:
      kind === 'hide'
        ? 'Hides these comments on the advertiser’s ads: only their authors still see them. Unhide them with operation PUBLIC.'
        : 'Makes these hidden comments public again on the advertiser’s ads.',
    retained:
      'The review keeps each comment’s ID, ad and status only; its text and author are third-party content and are not kept.',
    verification: 'Reads the comment list of the same scope again and compares the status of each comment.',
    source,
  };
}
/** The reply's own lists, when it has them: failed comments, and the comments it says it changed. */
function replied(r: TransportResult): {ok: boolean; failed: string[]; changed?: string[]} {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0) return {ok: false, failed: []};
  const data = obj(d.data) ? d.data : {},
    failed = Object.entries(data)
      .filter(([k, v]) => /fail|error/i.test(k) && Array.isArray(v))
      .flatMap(([, v]) => (v as unknown[]).map(x => String(obj(x) ? (x.comment_id ?? '') : x))),
    changed = Array.isArray(data.comment_ids) ? (data.comment_ids as unknown[]).map(String) : undefined;
  return {ok: true, failed, ...(changed ? {changed} : {})};
}
/** True only when TikTok accepted every comment: a reply naming failures, or omitting a comment, is partial. */
export function tiktokCommentOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const reply = replied(r);
  return reply.ok && !reply.failed.length && (!reply.changed || ids(p).every(id => reply.changed!.includes(id)));
}
/** One receipt per comment: accepted, failed, or not named by the reply. */
export function tiktokCommentReceipt(p: CompiledRequest, r: TransportResult): JsonObject {
  const reply = replied(r);
  return {
    comment_receipts: ids(p).map(id => ({
      comment_id: id,
      receipt: !reply.ok
        ? 'refused'
        : reply.failed.includes(id)
          ? 'failed'
          : reply.changed
            ? reply.changed.includes(id)
              ? 'accepted'
              : 'not_named'
            : 'accepted',
    })),
  };
}
export function tiktokCommentVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  return [
    {
      read: listRead(p),
      expected: {statuses: Object.fromEntries([...ids(p)].sort().map(id => [id, target(p)]))},
      id: 'status of ' + ids(p).length + ' comments',
    },
  ];
}
export function tiktokCommentObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  const rows = Array.isArray(data.comments) ? (data.comments as JsonObject[]) : [];
  return {statuses: Object.fromEntries(rows.map(c => [String(c.comment_id), c.listed === true ? c.status : null]))};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokCommentFamily: ReviewedFamily = {
  name: 'tiktok_ad_comments',
  files: ['src/tiktok-ad-comments.ts', ['tests/tiktok-ad-comments.test.mjs']],
  kind: tiktokCommentKind,
  assert: assertTiktokComments,
  snapshots: tiktokCommentSnapshots,
  isRead: isTiktokCommentRead,
  reader: readTiktokComments,
  validateState: validateTiktokCommentState,
  stateChecks: (plan, state) => tiktokCommentStateChecks(plan, state),
  impact: tiktokCommentImpact,
  outcome: tiktokCommentOutcome,
  receipt: tiktokCommentReceipt,
  verification: tiktokCommentVerification,
  observed: tiktokCommentObserved,
  exemptFromSpendTextMatch: true,
  activates: () => false,
  destructive: () => false,
};
