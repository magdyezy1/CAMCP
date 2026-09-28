import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';

/**
 * Ad comment blocked words, per TikTok API for Business v1.3 "Create blocked words", "Update a blocked word", "Delete
 * blocked words", "Get blocked words", "Create an export task (blocked words)" and "Check the status of an export task
 * (blocked words)" (checked 2026-09-27). "Each ad account can have up to 500 blocked words." Comments containing a blocked
 * word are visible only to their author; "When a blocked word is deleted, comments that contain this word will become
 * public". Deleting a word that is not listed raises no error, and replies carry no word IDs, so the review reads the
 * complete list before and after. An export task (task_id in the reply) is checked until it SUCCEEDs.
 */
type Kind = 'create' | 'update' | 'delete' | 'export';
type State = {kind: 'list'} | {kind: 'task'; taskId: string};
type Read = CompiledRequest & {tiktokBlockedWordState?: State};
export const tiktokBlockedWordPaths = {
  create: '/v1.3/blockedword/create/',
  update: '/v1.3/blockedword/update/',
  delete: '/v1.3/blockedword/delete/',
  export: '/v1.3/blockedword/task/create/',
};
const gateway = 'tiktok_native_action',
  maxWords = 500,
  pageSize = 500,
  maxPages = 5,
  langs = ['EN', 'JA', 'ZH'];
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_BLOCKED_WORD', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const word = (v: unknown): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  [...v].length >= 1 &&
  [...v].length <= 30 &&
  !/[\u0000-\u001f\u007f]/.test(v);
const fold = (v: string) => v.toLowerCase();
export function tiktokBlockedWordKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return Object.entries(tiktokBlockedWordPaths).find(([, path]) => path === p.path)?.[0] as Kind | undefined;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
function words(v: unknown, label: string, required: boolean): string[] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || !v.length || v.length > maxWords || v.some(x => !word(x)))
    invalid(
      label + ' lists 1–' + maxWords + ' words of 1–30 characters without surrounding spaces or control characters.',
    );
  if (new Set((v as string[]).map(fold)).size !== v.length) invalid(label + ' lists a word twice.');
  return v as string[];
}
export function assertTiktokBlockedWords(p: CompiledRequest): void {
  const kind = tiktokBlockedWordKind(p);
  if (!kind) return;
  if (Object.keys(p.query).length) invalid('Blocked word writes take no query parameters.');
  const b = p.body,
    allowed = {
      create: ['blocked_words'],
      update: ['old_word', 'new_word'],
      delete: ['blocked_words'],
      export: ['blocked_words', 'lang'],
    }[kind];
  if (!obj(b) || Object.keys(b).some(k => k !== 'advertiser_id' && !allowed.includes(k)))
    invalid('This request takes advertiser_id and ' + allowed.join(', ') + '.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (kind === 'create' || kind === 'delete') {
    words(b.blocked_words, 'blocked_words', true);
    return;
  }
  if (kind === 'update') {
    if (!word(b.old_word) || !word(b.new_word))
      invalid('old_word and new_word are words of 1–30 characters without surrounding spaces or control characters.');
    if (fold(b.old_word) === fold(b.new_word)) invalid('new_word must differ from old_word.');
    return;
  }
  words(b.blocked_words, 'blocked_words', false);
  if (b.lang !== undefined && !langs.includes(b.lang as string)) invalid('lang is EN, JA or ZH.');
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state: State): Read => ({
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
  tiktokBlockedWordState: state,
});
const listRead = (p: CompiledRequest) =>
  read(p, 'tiktok_blockedword_list_get', '/v1.3/blockedword/list/', {page: 1, page_size: pageSize}, {kind: 'list'});
export function tiktokBlockedWordSnapshots(p: CompiledRequest): Read[] {
  return [listRead(p)];
}
export function isTiktokBlockedWordRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokBlockedWordState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || (d.data !== undefined && !obj(d.data)))
    unverified('TikTok did not return the ' + label + '.');
  return obj((d as JsonObject).data) ? (d as JsonObject).data : {};
}
/** The complete blocked word list (pages by number), or the status of an export task. */
export async function readTiktokBlockedWords(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokBlockedWordState;
  if (!s) return request(p);
  if (s.kind === 'task') {
    const d = ok(await request(p), 'export task');
    if (d.task_id !== undefined && String(d.task_id) !== s.taskId)
      fail('STATE_TARGET_MISMATCH', 'TikTok returned another export task.', {}, 409);
    return {status: 200, headers: {}, data: {task: {task_id: s.taskId, status: d.status ?? null}}};
  }
  const listed: string[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > maxPages) unverified('The blocked word list has more pages than one review reads.');
    const d = ok(await request({...p, query: {...p.query, page}}), 'blocked words');
    if (d.list !== undefined && !Array.isArray(d.list)) unverified('TikTok did not list the blocked words.');
    const pages = Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(pages) || pages < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(pages, 1);
    for (const row of (d.list ?? []) as unknown[]) {
      if (!obj(row) || typeof row.bw_content !== 'string') unverified('A blocked word row is malformed.');
      listed.push(row.bw_content);
    }
  }
  return {status: 200, headers: {}, data: {words: [...new Set(listed)].sort()}};
}
export function validateTiktokBlockedWordState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokBlockedWordState,
    d = r.data;
  if (!s || r.status !== 200 || !obj(d) || (s.kind === 'list' ? !Array.isArray(d.words) : !obj(d.task)))
    unverified('Missing verified blocked word state.');
}
export function tiktokBlockedWordPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = tiktokBlockedWordKind(p);
  if (!kind || kind === 'export') return;
  const s = states[0];
  if (!obj(s) || !Array.isArray(s.words)) unverified('Missing verified blocked word state.');
  const listed = s.words as string[],
    folded = new Set(listed.map(fold)),
    b = body(p);
  if (kind === 'create') {
    const taken = (b.blocked_words as string[]).filter(w => folded.has(fold(w)));
    if (taken.length)
      fail('CONFIGURATION_EXISTS', 'Already blocked: ' + taken.join(', ') + '.', {blocked_words: taken});
    if (listed.length + (b.blocked_words as string[]).length > maxWords)
      invalid('The ad account has ' + listed.length + ' blocked words; TikTok allows ' + maxWords + '.');
    return;
  }
  if (kind === 'delete') {
    const missing = (b.blocked_words as string[]).filter(w => !listed.includes(w));
    if (missing.length)
      fail('STATE_NOT_FOUND', 'Not blocked (TikTok ignores such deletions silently): ' + missing.join(', ') + '.', {
        blocked_words: missing,
      });
    return;
  }
  if (!listed.includes(b.old_word as string))
    fail('STATE_NOT_FOUND', '"' + String(b.old_word) + '" is not a blocked word of the ad account.', {
      old_word: String(b.old_word),
    });
  if (folded.has(fold(b.new_word as string)))
    fail('CONFIGURATION_EXISTS', '"' + String(b.new_word) + '" is already blocked.', {new_word: String(b.new_word)});
}
function after(p: CompiledRequest, before: string[]): string[] {
  const kind = tiktokBlockedWordKind(p)!,
    b = body(p);
  if (kind === 'create') return [...before, ...(b.blocked_words as string[])].sort();
  if (kind === 'delete') return before.filter(w => !(b.blocked_words as string[]).includes(w)).sort();
  if (kind === 'update') return [...before.filter(w => w !== b.old_word), b.new_word as string].sort();
  return before;
}
export function tiktokBlockedWordImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = tiktokBlockedWordKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    before = Array.isArray(s.words) ? (s.words as string[]) : [],
    b = body(p);
  const effect = {
    create: "Comments on the account's ads that contain these words become visible only to their authors.",
    update:
      'Replaces "' +
      String(b.old_word) +
      '" with "' +
      String(b.new_word) +
      '": comments with the old word become public, comments with the new one are hidden.',
    delete: 'Comments that contain these words become public again.',
    export: 'Starts an export of the blocked word list; nothing changes.',
  }[kind];
  return {
    provider: 'tiktok',
    scope: 'blocked_words',
    operation: kind,
    before: {count: before.length},
    ...(kind === 'export'
      ? {}
      : {
          after: {count: after(p, before).length},
          ...(kind === 'update' ? {replacing: {old_word: b.old_word, new_word: b.new_word}} : {words: b.blocked_words}),
        }),
    may_affect_serving: false,
    effect,
    verification:
      kind === 'export'
        ? 'Checks the export task until TikTok reports SUCCEED; verify again while it is RUNNING.'
        : 'Reads the complete blocked word list again and compares it.',
    source: 'https://business-api.tiktok.com/portal/docs?id=1739029218470913',
  };
}
export function tiktokBlockedWordOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0) return false;
  return (
    tiktokBlockedWordKind(p) !== 'export' ||
    (obj(d.data) && ((typeof d.data.task_id === 'string' && !!d.data.task_id) || typeof d.data.task_id === 'number'))
  );
}
export function tiktokBlockedWordVerification(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[] = [],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = tiktokBlockedWordKind(p)!;
  if (kind === 'export') {
    const task = String(result.data?.data?.task_id ?? '');
    if (!task) fail('VERIFICATION_UNSUPPORTED', 'The receipt names no export task to verify.');
    return [
      {
        read: read(
          p,
          'tiktok_blockedword_task_check',
          '/v1.3/blockedword/task/check/',
          {task_id: task},
          {kind: 'task', taskId: task},
        ),
        expected: {task: {task_id: task, status: 'SUCCEED'}},
        id: 'export task ' + task,
      },
    ];
  }
  const b = before[0],
    words = obj(b) && Array.isArray(b.words) ? (b.words as string[]) : undefined;
  if (!words) fail('VERIFICATION_UNSUPPORTED', 'The review did not record the blocked word list.');
  return [{read: listRead(p), expected: {words: after(p, words!)}, id: 'blocked words of ' + p.accountId}];
}
export function tiktokBlockedWordObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {...(Array.isArray(data.words) ? {words: data.words} : {}), ...(obj(data.task) ? {task: data.task} : {})};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokBlockedWordFamily: ReviewedFamily = {
  name: 'tiktok_blocked_words',
  files: ['src/tiktok-blocked-words.ts', ['tests/tiktok-blocked-words.test.mjs']],
  kind: tiktokBlockedWordKind,
  assert: assertTiktokBlockedWords,
  snapshots: tiktokBlockedWordSnapshots,
  isRead: isTiktokBlockedWordRead,
  reader: readTiktokBlockedWords,
  validateState: validateTiktokBlockedWordState,
  prerequisites: tiktokBlockedWordPrerequisites,
  impact: tiktokBlockedWordImpact,
  outcome: tiktokBlockedWordOutcome,
  verification: tiktokBlockedWordVerification,
  observed: tiktokBlockedWordObserved,
  exemptFromSpendTextMatch: true,
};
