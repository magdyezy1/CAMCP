import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {normalizeAccount} from './account-id.js';
import {tiktokAdvertiserRead} from './tiktok-advertiser-state.js';

/**
 * Account-level negative keywords of TikTok's Search Ads (R2.5 M4, package r25-m4-search2, item 4; S3-4 of the lead's review of 27528f0e).
 * TikTok's pages "Create negative keywords", "Get negative keywords", "Update a negative keyword", "Delete negative keywords" and "Download
 * negative keywords" (https://business-api.tiktok.com/portal/docs/negative-keywords/v1.3 and its five pages, read 2026-11-21, impl/r25-m4-search2-
 * DOCS.md, section 2, P8 to P12) give `object_type` three values on all five routes: `ADVERTISER` (the ad account), `CAMPAIGN` and `ADGROUP`. This
 * module is the ADVERTISER level of the family of src/tiktok-negative-keywords.ts, which keeps the other two: the routes are the same, and one family
 * claims each body (the registry's `familyOf` refuses a double claim, and the action ledger classifies each route by a probe with an empty body, so a
 * family that claimed only ADVERTISER bodies would own no route of it). `withTiktokAccountNegativeKeywords` is that family with this level added:
 * for a plan whose body names ADVERTISER the hooks below answer, for every other plan the family's own hooks do, and the reads of the complete list
 * are the family's (its bounded reader, state check and projection serve a read of any object type).
 *
 * What the pages say, and what this level does about it:
 * - add: `object_type`, `object_ids` (required, at most 50; for ADVERTISER "ad account IDs"), `replace` (a boolean, default false, described for "the
 *   campaign or ad group" only), `keywords` (required, at most 1,000, each a `name` of at most 80 characters without ! @ % ^ ( ) = { } ; ~ ` < > ?
 *   \ or the vertical bar, and a `match_type`, default BROAD_WORD). The scope here is exactly the selected advertiser: `object_ids` is that ID
 *   alone, never another account (ACCOUNT_SCOPE_MISMATCH), and `replace: true` is refused, since no page gives it a meaning at this level (delete,
 *   then add, says it). Duplicate names collapse to one name with one match type at TikTok, so a name given twice is refused here.
 * - update: `object_id`, `old_keyword_id` (must exist), `keyword` {name, match_type}; the ID of the keyword changes (`new_keyword_id`), which the
 *   outcome requires (src/tiktok-negative-keywords.ts). delete: `object_id`, `keyword_ids` (at most 1,000; an unknown ID is an error at TikTok, and
 *   a refusal here, from the list that was read). The optional `keyword_info_to_delete` of the delete page is not built: it is refused as an
 *   unknown key.
 * - get: one object at a time, `page_size` 1 to 50: the review reads the complete list of the account, 50 a page, at most 200 pages (STATE_TOO_LARGE
 *   beyond, before anything is sent), before and after. There is no read of a campaign or an ad group here and no Automatic Search Placement
 *   check: the account's list applies to the account's Search ads. No page states an account-level total of keywords, so none is enforced.
 *
 * What the review says of it: the list applies to every Search Ads campaign of the advertiser (TikTok's Smart+ Search pages: "Account-level negative
 * keywords will be applied"; other Search shapes are UNVERIFIED), an addition only narrows delivery, and a removal or a rename can widen it across
 * the whole account, so it needs spend_change_confirmed, and a deletion is the owner's `allow_deletion` (the family's hooks, unchanged).
 *
 * The TikTok scope group of these routes (the permission an app needs to call them) is MISSING: no page the lead read, no catalog entry and no hook of
 * the adapter names one (src/tiktok-adapter.ts has no write-scope hook), so AMCP cannot name a missing scope for TikTok. A login TikTok refuses for
 * its role or permission is refused by TikTok (codes 40001 and 40119), which AMCP records as rejected with the remedy of that code.
 * Live acceptance of the account level, and of the CAMPAIGN and ADGROUP levels on a Smart+ Search campaign, stays M4b LV-31.
 */
const paths: Readonly<Record<string, 'add' | 'update' | 'delete'>> = Object.freeze({
  '/v1.3/search_ad/negative_keyword/add/': 'add',
  '/v1.3/search_ad/negative_keyword/update/': 'update',
  '/v1.3/search_ad/negative_keyword/delete/': 'delete',
});
const getPath = '/v1.3/search_ad/negative_keyword/get/';
const matchTypes = ['PRECISE_WORD', 'PHRASE_WORD', 'BROAD_WORD'];
const maxKeywords = 1000,
  pageSize = 50,
  forbidden = /[!@%^()={};~`<>?\\|]/;
type Kind = 'add' | 'update' | 'delete';

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_NEGATIVE_KEYWORD', message);
}
const kindOf = (p: CompiledRequest): Kind | undefined =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' ? paths[p.path] : undefined;
/** Whether the request is an add, update or delete at the account level: its body names `object_type: ADVERTISER`. */
export const tiktokAccountNegativeKeywordLevel = (p: CompiledRequest): boolean =>
  kindOf(p) !== undefined && obj(p.body) && p.body.object_type === 'ADVERTISER';

const term = (name: unknown) => String(name).trim().toLowerCase();
const keyOf = (name: unknown, match: unknown) => term(name) + ' [' + String(match ?? 'BROAD_WORD') + ']';
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
type Edit = {
  kind: Kind;
  add: {name: string; match: string}[];
  remove: string[];
  update?: {from: string; name: string; match: string};
};
/**
 * The request at the account level, validated: the selected advertiser is the only object, `replace` is not given, and the lists are within the
 * pages' limits. Nothing here reads or contacts TikTok.
 */
export function tiktokAccountNegativeKeywordEdit(p: CompiledRequest): Edit {
  const kind = kindOf(p)!,
    b = obj(p.body) ? p.body : {};
  const allowed = {
    add: ['object_ids', 'replace', 'keywords'],
    update: ['object_id', 'old_keyword_id', 'keyword'],
    delete: ['object_id', 'keyword_ids'],
  }[kind];
  if (Object.keys(b).some(k => !['advertiser_id', 'object_type', ...allowed].includes(k)))
    invalid('This request takes advertiser_id, object_type and ' + allowed.join(', ') + '.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.');
  const scope = () =>
    fail(
      'ACCOUNT_SCOPE_MISMATCH',
      'At the account level the object is the selected advertiser alone: send its ID as object_ids (add) or object_id.',
    );
  if (kind === 'add') {
    if (!Array.isArray(b.object_ids) || b.object_ids.length !== 1 || b.object_ids[0] !== p.accountId) scope();
    if (b.replace !== undefined && typeof b.replace !== 'boolean') invalid('replace must be a boolean.');
    if (b.replace === true)
      invalid(
        'replace is documented for campaigns and ad groups only: delete the keywords you no longer want, then add the new ones.',
      );
    if (!Array.isArray(b.keywords) || !b.keywords.length || b.keywords.length > maxKeywords)
      invalid('keywords must hold 1 to ' + maxKeywords + ' negative keywords.');
    const add = (b.keywords as unknown[]).map((k, i) => keyword(k, 'keywords[' + i + ']', false));
    if (new Set(add.map(k => term(k.name))).size !== add.length)
      invalid('A keyword name appears twice; TikTok keeps one match type per name.');
    return {kind, add, remove: []};
  }
  if (b.object_id !== p.accountId) scope();
  if (kind === 'update') {
    if (typeof b.old_keyword_id !== 'string' || !b.old_keyword_id)
      invalid('old_keyword_id must name the keyword to update.');
    return {kind, add: [], remove: [], update: {from: b.old_keyword_id, ...keyword(b.keyword, 'keyword', true)}};
  }
  if (
    !Array.isArray(b.keyword_ids) ||
    !b.keyword_ids.length ||
    b.keyword_ids.length > maxKeywords ||
    b.keyword_ids.some((id: unknown) => typeof id !== 'string' || !id) ||
    new Set(b.keyword_ids).size !== b.keyword_ids.length
  )
    invalid('keyword_ids must list 1 to ' + maxKeywords + ' distinct keyword IDs.');
  return {kind, add: [], remove: b.keyword_ids};
}
/** Validates the request before review (the family's `assert` for a plan at the account level). */
export function assertTiktokAccountNegativeKeywords(p: CompiledRequest): void {
  if (Object.keys(p.query).length) invalid('Negative keyword reviews take no query parameters.');
  tiktokAccountNegativeKeywordEdit(p);
}

/**
 * The reads of the review: the advertiser, in the ACCOUNT role (its identity fields: it proves the account the list belongs to), and the complete
 * keyword list of the account. The list read carries the family's marker for a keyword list (`kind: keywords`), so its bounded reader, its state
 * check and its projection apply as to the list of a campaign or an ad group (src/tiktok-negative-keywords.ts).
 */
export function tiktokAccountNegativeKeywordReads(
  p: CompiledRequest,
  stateRead: Parameters<typeof tiktokAdvertiserRead>[0],
): CompiledRequest[] {
  const advertiser = normalizeAccount(p.gateway, p.accountId!);
  return [
    tiktokAdvertiserRead(stateRead, advertiser),
    stateReadOf(
      p,
      'tiktok_search_ad_negative_keyword_get',
      getPath,
      {advertiser_id: p.accountId, object_type: 'ADVERTISER', object_id: p.accountId, page: 1, page_size: pageSize},
      {tiktokNegativeKeywordState: {kind: 'keywords', ids: [p.accountId!], objectType: 'ADVERTISER'}},
    ),
  ];
}
const keywordsOf = (v: unknown): JsonObject[] =>
  obj(v) && obj(v.data) && Array.isArray(v.data.keywords) ? v.data.keywords : [];
const advertiserOf = (v: unknown): JsonObject | undefined =>
  obj(v) && obj(v.data) && Array.isArray(v.data.list) && obj(v.data.list[0]) ? v.data.list[0] : undefined;
/** The keyword set of the account after the edit, as comparable keys. */
function finalKeys(e: Edit, before: JsonObject[]): string[] {
  if (e.kind === 'add')
    return [...before.map(k => keyOf(k.name, k.match_type)), ...e.add.map(k => keyOf(k.name, k.match))].sort();
  if (e.kind === 'delete')
    return before
      .filter(k => !e.remove.includes(k.keyword_id))
      .map(k => keyOf(k.name, k.match_type))
      .sort();
  return [
    ...before.filter(k => k.keyword_id !== e.update!.from).map(k => keyOf(k.name, k.match_type)),
    keyOf(e.update!.name, e.update!.match),
  ].sort();
}

/** Refuses what the list that was read does not allow: a name the account already holds, a keyword ID it does not have, an update that changes nothing. */
export function tiktokAccountNegativeKeywordPrerequisites(plan: CompiledRequest, state: unknown[]): void {
  const e = tiktokAccountNegativeKeywordEdit(plan);
  if (state.length < 2) fail('STATE_READ_FAILED', 'Negative keyword state is incomplete.');
  const before = keywordsOf(state[1]),
    label = 'Advertiser ' + plan.accountId;
  if (e.kind === 'add') {
    const existing = new Set(before.map(k => term(k.name))),
      dup = e.add.find(k => existing.has(term(k.name)));
    if (dup)
      fail(
        'CONFIGURATION_EXISTS',
        label + ' already has the negative keyword "' + dup.name + '". Update it to change its match type.',
        {object_id: plan.accountId, name: dup.name},
      );
  }
  if (e.kind === 'delete')
    for (const k of e.remove)
      if (!before.some(b => b.keyword_id === k))
        fail('STATE_NOT_FOUND', label + ' has no negative keyword ' + k + '.', {
          object_id: plan.accountId,
          keyword_id: k,
        });
  if (e.kind === 'update') {
    const old = before.find(b => b.keyword_id === e.update!.from);
    if (!old)
      fail('STATE_NOT_FOUND', label + ' has no negative keyword ' + e.update!.from + '.', {
        object_id: plan.accountId,
        keyword_id: e.update!.from,
      });
    if (keyOf(old!.name, old!.match_type) === keyOf(e.update!.name, e.update!.match))
      invalid('The update changes neither the name nor the match type of keyword ' + e.update!.from + '.');
    if (before.some(b => b.keyword_id !== e.update!.from && term(b.name) === term(e.update!.name)))
      fail('CONFIGURATION_EXISTS', label + ' already has another negative keyword named "' + e.update!.name + '".', {
        object_id: plan.accountId,
        name: e.update!.name,
      });
  }
}

/** The review's summary: what the account level means, what is added, removed or renamed, and the count before. */
export function tiktokAccountNegativeKeywordImpact(plan: CompiledRequest, state: unknown[]): JsonObject {
  const e = tiktokAccountNegativeKeywordEdit(plan),
    before = keywordsOf(state[1]),
    row = advertiserOf(state[0]),
    widens = e.kind !== 'add';
  return {
    provider: 'tiktok',
    scope: 'search_negative_keywords',
    object_type: 'ADVERTISER',
    objects: [{id: plan.accountId, name: row?.name ?? null, operation_status: row?.status ?? null}],
    // The pages' own words for what the level covers (the Smart+ Search pages: "Account-level negative keywords will be applied"); the other
    // Search shapes are not stated.
    applies_to:
      'The list applies to every Search Ads campaign of this advertiser, not to one campaign or ad group. TikTok’s Smart+ Search pages say that account-level negative keywords are applied to a Smart+ Search campaign; whether they are to the other Search shapes is not stated.',
    may_affect_serving: widens,
    changes: {
      add: e.add.map(k => ({name: k.name, match_type: k.match})),
      remove: e.remove.map(id => {
        const k = before.find(b => b.keyword_id === id);
        return {keyword_id: id, name: k?.name ?? null, match_type: k?.match_type ?? null};
      }),
      replace_existing: false,
      update: e.update ? {keyword_id: e.update.from, name: e.update.name, match_type: e.update.match} : null,
    },
    keywords_before: [{object_id: plan.accountId, count: before.length}],
    effect: widens
      ? 'Removing or renaming account-level negative keywords lets Search Ads show again for the removed search terms, at once, across the whole account.'
      : 'New account-level negative keywords stop every Search Ads campaign of the advertiser from showing for matching search terms; this only narrows delivery.',
    verification: 'Reads the complete account-level negative keyword list again and compares names and match types.',
    source: 'https://business-api.tiktok.com/portal/docs/create-negative-keywords/v1.3',
  };
}

/** The read-back: the whole account list again, as the keyword set the edit leaves. */
export function tiktokAccountNegativeKeywordVerification(
  plan: CompiledRequest,
  before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const e = tiktokAccountNegativeKeywordEdit(plan);
  return [
    {
      read: stateReadOf(
        plan,
        'tiktok_search_ad_negative_keyword_get',
        getPath,
        {
          advertiser_id: plan.accountId,
          object_type: 'ADVERTISER',
          object_id: plan.accountId,
          page: 1,
          page_size: pageSize,
        },
        {tiktokNegativeKeywordState: {kind: 'keywords', ids: [plan.accountId!], objectType: 'ADVERTISER'}},
      ),
      expected: {keywords: finalKeys(e, keywordsOf(before[1]))},
      id: 'advertiser ' + plan.accountId + ' negative keywords',
    },
  ];
}

/**
 * The family of src/tiktok-negative-keywords.ts with the account level added: the hooks that read the request's object type answer for a plan at
 * the account level and defer to the family's own for every other plan. A hook of the family that this does not name and that parses the request
 * (a later addition) is neutral at this level (`followUps`), never the other levels' logic on an account plan. The ledger names both modules.
 */
export function withTiktokAccountNegativeKeywords(base: ReviewedFamily): ReviewedFamily {
  const account = tiktokAccountNegativeKeywordLevel;
  return defineFamily({
    ...base,
    files: [
      base.files[0] + ' / src/tiktok-account-negative-keywords.ts',
      [...base.files[1], 'tests/tiktok-account-negative-keywords.test.mjs'],
    ],
    assert: (plan, gateway, shape) => {
      if (account(plan)) return assertTiktokAccountNegativeKeywords(plan);
      const type = obj(plan.body) ? plan.body.object_type : undefined;
      if (type !== 'CAMPAIGN' && type !== 'ADGROUP') invalid('object_type must be CAMPAIGN, ADGROUP or ADVERTISER.');
      return base.assert?.(plan, gateway, shape);
    },
    snapshots: (plan, stateRead, classify) =>
      account(plan) ? tiktokAccountNegativeKeywordReads(plan, stateRead) : base.snapshots!(plan, stateRead, classify),
    prerequisites: (plan, state, reads) =>
      account(plan) ? tiktokAccountNegativeKeywordPrerequisites(plan, state) : base.prerequisites?.(plan, state, reads),
    impact: (plan, state, review) =>
      account(plan) ? tiktokAccountNegativeKeywordImpact(plan, state) : base.impact?.(plan, state, review),
    verification: (plan, result, before, verificationRead, classify) =>
      account(plan)
        ? tiktokAccountNegativeKeywordVerification(plan, before)
        : base.verification!(plan, result, before, verificationRead, classify),
    ...(base.followUps
      ? {
          followUps: (plan: CompiledRequest, read: CompiledRequest, data: unknown) =>
            account(plan) ? [] : base.followUps!(plan, read, data),
        }
      : {}),
  });
}
