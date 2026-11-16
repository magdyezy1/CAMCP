import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {object} from './write-common.js';

/**
 * TikTok's part of the read-only reconciliation of an uncertain write (R2.5 M2, L1-07 created-lookup part, L5-05): the
 * lookup of a standard campaign, ad group or ad create, which `reconcile` answered `no_read_contract` for.
 *
 * It reads the advertiser's own list of that kind (TikTok's `campaign/get`, `adgroup/get`, `ad/get`) in a creation window
 * around the claim, under the parent the review froze (an ad group's campaign, an ad's ad group), and compares names
 * itself. The provider facts are the captured DESCRIBE_ACTION of those reads (`.mirror/RAW/tiktok_native_action`): they
 * filter by `creation_filter_start_time` and `creation_filter_end_time`, "in the format of YYYY-MM-DD HH:MM:SS (UTC time
 * zone)", by `campaign_ids` (ad groups, ads) and `adgroup_ids` (ads), and `fields` narrows the answer. The name filter of
 * the campaign and ad group lists is "fuzzy" and the ad list has none, so no read depends on it: the window is listed and
 * the exact name is matched here. An ad's name is the one of its one creative (a reviewed ad create has exactly one).
 *
 * One object of that name and parent created in the window is the created object. None, in a complete list, is absence.
 * Two are shown and never chosen between. A row whose creation time is missing, unreadable, or close enough to the window
 * to be TikTok writing a time zone other than UTC in a response (which its documentation does not rule out) cannot be told
 * from an older object of the same name: it is `undated`, never created and never proof of absence.
 */
interface Kind {
  kind: 'campaign' | 'adgroup' | 'ad';
  id: string;
  name: string;
  /** The parent: its IDs filter, the body field that names it, and the field of a row that names it. */
  parent?: {filter: string; body: string; row: string};
  /** The `data` of the answer TikTok gives to the create, which a plan's later steps read the new ID from. */
  receipt(id: string): JsonObject;
}
const kinds: Record<string, Kind> = {
  '/v1.3/campaign/create/': {
    kind: 'campaign',
    id: 'campaign_id',
    name: 'campaign_name',
    receipt: id => ({campaign_id: id}),
  },
  '/v1.3/adgroup/create/': {
    kind: 'adgroup',
    id: 'adgroup_id',
    name: 'adgroup_name',
    parent: {filter: 'campaign_ids', body: 'campaign_id', row: 'campaign_id'},
    receipt: id => ({adgroup_id: id}),
  },
  '/v1.3/ad/create/': {
    kind: 'ad',
    id: 'ad_id',
    name: 'ad_name',
    parent: {filter: 'adgroup_ids', body: 'adgroup_id', row: 'adgroup_id'},
    receipt: id => ({ad_ids: [id]}),
  },
};
/** Clock skew: TikTok stamps the object after AMCP claimed the key, and the two clocks differ. */
const skewMs = 2 * 60000;
/**
 * How long after the claim the object may have been made: a claim that is still pending after 10 minutes counts as uncertain
 * (src/write-records.ts pendingUncertainMs), and five more for the skew.
 */
const afterMs = 15 * 60000;
/** No time zone is more than 14 hours from UTC: a creation time this near the window may be the advertiser's own. */
const zoneMs = 14 * 3600000;
/** A time as TikTok writes it (UTC, YYYY-MM-DD HH:MM:SS) in the filters, and the same read back from a row. */
const written = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function read(value: unknown): number | undefined {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value) : null;
  if (!m) return undefined;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(at) ? at : undefined;
}

/** A standard TikTok campaign, ad group or ad create: the advertiser's list in the creation window, matched by name and parent. */
export function tiktokCreated(
  plan: CompiledRequest,
  read_: StateReadBuilder,
  context: CreatedLookupContext = {state: [], claimedAt: Date.now()},
): CreatedLookup | undefined {
  const spec = plan.method === 'POST' ? kinds[plan.path] : undefined,
    body = object(plan.body);
  if (!spec || !plan.accountId) return undefined;
  const given =
      spec.kind === 'ad'
        ? object(Array.isArray(body.creatives) ? body.creatives[0] : undefined).ad_name
        : body[spec.name],
    name = typeof given === 'string' ? given.trim() : '',
    parent = spec.parent ? body[spec.parent.body] : undefined;
  if (!name || name.length > 512 || (spec.parent && (typeof parent !== 'string' || !/^\d{1,32}$/.test(parent))))
    return undefined;
  const from = context.claimedAt - skewMs,
    to = context.claimedAt + afterMs;
  const list = read_('/v1.3/' + spec.kind + '/get/', {
    advertiser_id: normalizeAccount(plan.gateway, plan.accountId),
    fields: [spec.id, spec.name, ...(spec.parent ? [spec.parent.row] : []), 'create_time'],
    filtering: {
      ...(spec.parent ? {[spec.parent.filter]: [parent]} : {}),
      creation_filter_start_time: written(from),
      creation_filter_end_time: written(to),
    },
    page_size: 100,
  });
  // The scope guard knows a TikTok read by the action it names (as the review's own reads of an edit's targets do).
  list.action = 'tiktok_' + spec.kind + '_get';
  return {
    reads: [list],
    match(responses) {
      const answer = object(object(responses[0]?.data).data),
        rows = (Array.isArray(answer.list) ? answer.list : []).filter(
          (r: unknown): r is JsonObject => !!r && typeof r === 'object' && !Array.isArray(r),
        ),
        pages = object(answer.page_info);
      const found: JsonObject[] = [],
        undated: JsonObject[] = [];
      for (const row of rows) {
        if (typeof row[spec.name] !== 'string' || (row[spec.name] as string).trim() !== name) continue;
        if (spec.parent && row[spec.parent.row] !== undefined && String(row[spec.parent.row]) !== parent) continue;
        const at = read(row.create_time),
          id = String(row[spec.id]);
        if (at !== undefined && at >= from && at <= to)
          found.push({index: found.length, id, name, created_time: row.create_time});
        else if (at === undefined || (at >= from - zoneMs && at <= to + zoneMs)) undated.push({id, name});
      }
      return {
        found,
        undated,
        expected: 1,
        // One page of the window holds everything it asked for; an answer that says nothing of its pages settles nothing.
        complete:
          Array.isArray(answer.list) &&
          typeof pages.total_page === 'number' &&
          pages.total_page <= 1 &&
          (typeof pages.total_number !== 'number' || pages.total_number <= rows.length),
      };
    },
    receipt: resources => ({code: 0, message: 'OK', data: spec.receipt(String(resources[0]!.id))}),
  };
}
