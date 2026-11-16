/**
 * The advertiser row a TikTok review keeps (T1, Round 2.5; Q15, owner 2026-11-15).
 *
 * A TikTok create reads the advertiser it is created in, and the amcp_media upload reads it too. The review keeps that
 * answer and compares it again at execute. Asked without `fields`, TikTok's advertiser info carries far more than the
 * identity of the account: a signed licence link whose ticket changes on every read, a balance that moves with spend,
 * the creation time and the advertiser's contact record. Hashing all of it made every create fail with STATE_CHANGED
 * (the White Friday report), and showed the contact record to the model in before_state.
 *
 * A review keeps only the seven fields that identify the account and decide what a write under it means: its ID, name,
 * status, role, currency, timezone and country. Every consumer asks for them through the one read below, and the
 * projection keeps exactly them whatever TikTok returns, so a review prepared before this change, which saved the whole
 * row, compares equal to a fresh read. Only the account row is projected: the campaigns, ad groups and ads a write
 * changes keep their own protection (src/review-state-core.ts), and the general hash policy is not touched here.
 */
import type {StateReadBuilder} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';

export const tiktokAdvertiserInfoPath = '/v1.3/advertiser/info/';

/** Q15, owner 2026-11-15: what a review keeps of the advertiser row. */
const fields: readonly string[] = Object.freeze([
  'advertiser_id',
  'name',
  'status',
  'role',
  'currency',
  'timezone',
  'country',
]);

/** The query of the advertiser read: the one advertiser, and only the fields a review keeps. */
export const tiktokAdvertiserQuery = (advertiser: string): JsonObject => ({
  advertiser_ids: [advertiser],
  fields: [...fields],
});

/**
 * The advertiser read of a reviewed write, built the way every state read is (src/write-snapshots.ts stateRead), in the
 * ACCOUNT role (R2.5 M1): the account a create is made in. Its projection stays path-keyed, so a review saved before the role
 * existed is projected the same way.
 */
export const tiktokAdvertiserRead = (stateRead: StateReadBuilder, advertiser: string): CompiledRequest => ({
  ...stateRead(tiktokAdvertiserInfoPath, tiktokAdvertiserQuery(advertiser)),
  stateRole: 'account',
});

/**
 * One advertiser row as a review keeps it: its seven identity fields, as TikTok gave them, and nothing else. Idempotent
 * (a saved review is projected again at execute) and monotone (it only drops fields, so what it keeps is exactly what
 * TikTok said). A value that is no record is not an advertiser row and is left as it is.
 */
function advertiserRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(
    fields.filter(name => Object.hasOwn(row, name)).map(name => [name, (row as JsonObject)[name]]),
  );
}

/** The state of an advertiser info answer: its list of advertisers, each reduced to its identity fields; else undefined. */
export function tiktokAdvertiserState(answer: JsonObject): JsonObject | undefined {
  const list = answer.data?.list;
  return Array.isArray(list) ? {data: {list: list.map(advertiserRow)}} : undefined;
}
