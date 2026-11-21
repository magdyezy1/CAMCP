import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, CreatedLookupContext, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {object} from './write-common.js';
import {agrees, lookupKey, type Echo} from './created-agreement.js';

/**
 * TikTok's part of the read-only reconciliation of an uncertain write (R2.5 M2, L1-07 created-lookup part, L5-05): the
 * lookup of a standard campaign, ad group or ad create, which `reconcile` answered `no_read_contract` for, and of an Upgraded
 * Smart+ one (R2.5 M4, below).
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
 *
 * The filter's zone is as unconfirmed as that of `create_time` (lead review S3-1): were TikTok to apply it in the advertiser's
 * zone, the created object would fall outside a UTC window and the list would be empty and whole. So TikTok is asked for the
 * window widened by 14 hours on each side, and the split is made here: inside the claim window is found, in the margin is a
 * doubt. The wider window holds more rows, so the list is followed page by page (`more`), whole only when every page was read.
 *
 * R2.5 M4 (package r25-m4-smartops, item 1): an Upgraded Smart+ campaign, ad group or ad create is looked up the same way, on its own
 * Smart+ list ("Get Upgraded Smart+ Campaigns", "... Ad Groups", "... Ads"), because after 2027-01-01 every new TikTok website build
 * runs on Smart+ (r25-m4-smartweb) and a lost answer there was `no_read_contract`, which held a plan step with no way on but TikTok's
 * UI. The provider facts are the captured DESCRIBE_ACTION of those reads (.mirror/CATALOG/tiktok_native_action.json): the campaign and
 * ad lists take the creation filter as the standard ones do, the ad group list takes `campaign_ids` and no creation filter at all, so
 * it lists the frozen campaign's ad groups and the match dates each row by its `create_time` alone; every list takes `fields`, `page`
 * and `page_size`. Which field names a Smart+ list takes in `fields` is not captured, so a Smart+ lookup sends none (a name TikTok
 * refused would fail every lookup) and reads whole rows, as the Smart+ families' own reads do. Every other rule above holds unchanged:
 * the skew, the window after the claim, the 14-hour widening, pages followed, whole only when complete, the echo check. Whether a Smart+
 * row carries `create_time`, and the zone and format of the Smart+ filters, are unverified until the live check M4 LV-25: until then a
 * row with no readable time is `undated`, and the widening covers a filter applied in another zone. A Smart+ ad is named at the top of
 * its body (`ad_name`), not in a creative; its ID is `smart_plus_ad_id`. Each Smart+ kind shares its standard twin's lookup key (the
 * kind, the parent and the name): the standard campaign list returns Smart+ campaigns too (the lead's read of 2026-11-21), so the two
 * creates of one name could not be told apart, and the guard against creating twice holds one back while the other is unresolved.
 */
interface Kind {
  kind: 'campaign' | 'adgroup' | 'ad';
  /** The list that holds what the create makes, and the action the scope guard knows it by. */
  list: {path: string; action: string};
  /** Whether that list takes the creation filter (the Smart+ ad group list does not), and whether it is narrowed to `fields`. */
  window: boolean;
  fields: boolean;
  id: string;
  name: string;
  /** The parent: its IDs filter, the body field that names it, and the field of a row that names it. */
  parent?: {filter: string; body: string; row: string};
  /** The record of the request that names the object and holds what TikTok echoes: the body, or the one creative of a standard ad. */
  record(body: JsonObject): JsonObject;
  /**
   * The fields TikTok echoes of the create (R2.5 M2, lead review S2-3): a same-name object of the same parent that differs in one of
   * them is another object, shown and never called this write's.
   */
  echoes: readonly Echo[];
  /**
   * What the route itself says of every object it creates, compared as an echo where a row names it (R2.5 M4): a Smart+ campaign is
   * an Upgraded Smart+ one, so a row of that name that says it is a manual or an older Smart+ campaign is another object, a doubt.
   */
  implied?: JsonObject;
  /** The `data` of the answer TikTok gives to the create, which a plan's later steps read the new ID from. */
  receipt(id: string): JsonObject;
}
const echo = (...names: string[]): Echo[] => names.map(name => [name, name]);
const whole = (body: JsonObject) => body,
  // A standard ad's name and fields are those of its one creative (a reviewed ad create has exactly one).
  creative = (body: JsonObject) => object(Array.isArray(body.creatives) ? body.creatives[0] : undefined);
const standard = (kind: Kind['kind']) => ({
  kind,
  list: {path: '/v1.3/' + kind + '/get/', action: 'tiktok_' + kind + '_get'},
  window: true,
  fields: true,
});
const smartPlus = (kind: Kind['kind'], window: boolean) => ({
  kind,
  list: {path: '/v1.3/smart_plus/' + kind + '/get/', action: 'tiktok_smart_plus_' + kind + '_get'},
  window,
  fields: false,
});
const kinds: Record<string, Kind> = {
  '/v1.3/campaign/create/': {
    ...standard('campaign'),
    id: 'campaign_id',
    name: 'campaign_name',
    record: whole,
    // R2.5 M4, r25-m4-smartops fix round (the lead's review, S2-1): the standard campaign list returns Upgraded Smart+ campaigns too, with
    // campaign_automation_type (MANUAL, SMART_PLUS, UPGRADED_SMART_PLUS: "Get campaigns", read 2026-11-20; the lead's live read of
    // 2026-11-21). A classic create is MANUAL, so a same-name row typed otherwise is another object, a doubt; a row that names no type is
    // compared as before. The field is asked for in `fields` with the echoes, because TikTok returns only the fields named there.
    echoes: echo('objective_type', 'budget_mode', 'budget', 'operation_status', 'campaign_automation_type'),
    implied: {campaign_automation_type: 'MANUAL'},
    receipt: id => ({campaign_id: id}),
  },
  '/v1.3/adgroup/create/': {
    ...standard('adgroup'),
    id: 'adgroup_id',
    name: 'adgroup_name',
    parent: {filter: 'campaign_ids', body: 'campaign_id', row: 'campaign_id'},
    record: whole,
    echoes: echo('budget_mode', 'budget', 'optimization_goal', 'billing_event', 'bid_type', 'operation_status'),
    receipt: id => ({adgroup_id: id}),
  },
  '/v1.3/ad/create/': {
    ...standard('ad'),
    id: 'ad_id',
    name: 'ad_name',
    parent: {filter: 'adgroup_ids', body: 'adgroup_id', row: 'adgroup_id'},
    record: creative,
    echoes: echo('ad_format', 'operation_status'),
    receipt: id => ({ad_ids: [id]}),
  },
  // R2.5 M4 (r25-m4-smartops, item 1): the Upgraded Smart+ creates, each on its own list (the module comment).
  '/v1.3/smart_plus/campaign/create/': {
    ...smartPlus('campaign', true),
    id: 'campaign_id',
    name: 'campaign_name',
    record: whole,
    echoes: echo('objective_type', 'budget_mode', 'operation_status', 'campaign_automation_type'),
    implied: {campaign_automation_type: 'UPGRADED_SMART_PLUS'},
    receipt: id => ({campaign_id: id}),
  },
  '/v1.3/smart_plus/adgroup/create/': {
    ...smartPlus('adgroup', false),
    id: 'adgroup_id',
    name: 'adgroup_name',
    parent: {filter: 'campaign_ids', body: 'campaign_id', row: 'campaign_id'},
    record: whole,
    echoes: echo('optimization_goal', 'billing_event', 'bid_type', 'operation_status'),
    receipt: id => ({adgroup_id: id}),
  },
  '/v1.3/smart_plus/ad/create/': {
    ...smartPlus('ad', true),
    id: 'smart_plus_ad_id',
    name: 'ad_name',
    parent: {filter: 'adgroup_ids', body: 'adgroup_id', row: 'adgroup_id'},
    record: whole,
    echoes: echo('operation_status'),
    receipt: id => ({smart_plus_ad_id: id}),
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

/**
 * A standard or Upgraded Smart+ TikTok campaign, ad group or ad create: the advertiser's list of its kind in the creation window (or,
 * for a Smart+ ad group, the frozen campaign's whole list), matched by name, parent and creation time.
 */
export function tiktokCreated(
  plan: CompiledRequest,
  read_: StateReadBuilder,
  context: CreatedLookupContext = {state: [], claimedAt: Date.now()},
): CreatedLookup | undefined {
  const spec = plan.method === 'POST' && Object.hasOwn(kinds, plan.path) ? kinds[plan.path] : undefined,
    body = object(plan.body);
  if (!spec || !plan.accountId) return undefined;
  // What the review froze, to compare with what TikTok echoes: the body, or for a standard ad the one creative it names, with what
  // the route implies of every object it creates.
  const record = spec.record(body),
    given = record[spec.name],
    name = typeof given === 'string' ? given.trim() : '',
    parent = spec.parent ? body[spec.parent.body] : undefined,
    requested = {...record, ...spec.implied};
  if (!name || name.length > 512 || (spec.parent && (typeof parent !== 'string' || !/^\d{1,32}$/.test(parent))))
    return undefined;
  const from = context.claimedAt - skewMs,
    to = context.claimedAt + afterMs;
  const list = read_(spec.list.path, {
    advertiser_id: normalizeAccount(plan.gateway, plan.accountId),
    ...(spec.fields
      ? {
          fields: [
            spec.id,
            spec.name,
            ...(spec.parent ? [spec.parent.row] : []),
            ...spec.echoes.map(([, listed]) => listed),
            'create_time',
          ],
        }
      : {}),
    // The window asked of TikTok is wider than the one matched here, by the longest zone offset on each side (lead review S3-1):
    // the documentation says UTC for the filter as well, and it is as unconfirmed as the zone of `create_time` in a response,
    // so an empty answer to the claim window alone would prove nothing. The wide answer is split in `match`. A list that takes no
    // creation filter (the Smart+ ad groups) is read whole under its parent, and `match` dates each row alone.
    filtering: {
      ...(spec.parent ? {[spec.parent.filter]: [parent]} : {}),
      ...(spec.window
        ? {creation_filter_start_time: written(from - zoneMs), creation_filter_end_time: written(to + zoneMs)}
        : {}),
    },
    page_size: 100,
  });
  // The scope guard knows a TikTok read by the action it names (as the review's own reads of an edit's targets do).
  list.action = spec.list.action;
  /** One answer's `data`: its rows and its page counts. */
  const dataOf = (response: {data?: unknown} | undefined) => object(object(response?.data).data);
  return {
    reads: [list],
    keys: [lookupKey(spec.kind, spec.parent ? parent : '', name)],
    // The next page, while the answers follow each other: the one just read says it is the page asked for, and a later one
    // exists. An answer that repeats a page, or names none, ends the reading and leaves the list not whole.
    more(responses) {
      const last = dataOf(responses.at(-1)),
        counts = object(last.page_info);
      return Array.isArray(last.list) &&
        typeof counts.total_page === 'number' &&
        counts.page === responses.length &&
        responses.length < counts.total_page
        ? [{...list, query: {...list.query, page: responses.length + 1}}]
        : [];
    },
    match(responses) {
      const answers = responses.map(dataOf),
        // Every row of every page, once: a page that is read twice does not count its objects twice.
        seen = new Set<string>(),
        rows = answers
          .flatMap(a => (Array.isArray(a.list) ? a.list : []))
          .filter((r: unknown): r is JsonObject => !!r && typeof r === 'object' && !Array.isArray(r))
          .filter(r => {
            const key = r[spec.id] === undefined ? undefined : String(r[spec.id]);
            if (key === undefined) return true;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        pages = object(answers.at(-1)?.page_info);
      const found: JsonObject[] = [],
        undated: JsonObject[] = [];
      for (const row of rows) {
        if (typeof row[spec.name] !== 'string' || (row[spec.name] as string).trim() !== name) continue;
        if (spec.parent && row[spec.parent.row] !== undefined && String(row[spec.parent.row]) !== parent) continue;
        const at = read(row.create_time),
          id = String(row[spec.id]);
        // Same name and parent, another object: it differs in a field the review froze. A name is no identity, so it is a doubt
        // (shown, never called created), not a match.
        if (!agrees(requested, row, spec.echoes)) {
          undated.push({id, name});
          continue;
        }
        if (at !== undefined && at >= from && at <= to)
          found.push({index: found.length, id, name, created_time: row.create_time});
        else if (at === undefined || (at >= from - zoneMs && at <= to + zoneMs)) undated.push({id, name});
      }
      return {
        found,
        undated,
        expected: 1,
        // Whole when every page the last answer counts was read, each following the one before, and the rows hold the total it
        // names; an answer that says nothing of its pages, or a list cut at the page cap, settles nothing.
        complete:
          answers.length > 0 &&
          answers.every((a, i) => Array.isArray(a.list) && object(a.page_info).page === i + 1) &&
          typeof pages.total_page === 'number' &&
          answers.length === Math.max(1, pages.total_page) &&
          (typeof pages.total_number !== 'number' || pages.total_number <= rows.length),
      };
    },
    receipt: resources => ({code: 0, message: 'OK', data: spec.receipt(String(resources[0]!.id))}),
  };
}
