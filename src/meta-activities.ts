import {MirrorError} from './errors.js';
import {metaPrefix, metaRoute} from './meta-version.js';
import type {Action, CompiledRequest, JsonObject} from './types.js';

/**
 * The ad account's activity read, GET act_<id>/activities: the account's change history (r25-fr-meta-reads A5, the owner's friction
 * report of 2026-11-26: a search of the actions for "activities" found nothing, `amcp_workspace change_history` is Google Ads only,
 * and the owner could not confirm why two catalog campaigns dropped to almost no spend). The captured catalog has no such route and
 * is the naming denominator, so the read is one AMCP documents beyond it (CatalogHooks.supplemental, as the ad rule routes are)
 * and LIST_ACTIONS lists it after the captured ones (CatalogListing.extra).
 *
 * Its request and its rows are Meta's SDK model at 26.0.2, pinned in tests/fixtures/meta-activities-sdk-v26.json (from the two public
 * SDK files adaccount.py and adactivity.py, by tools/meta-activities-evidence.mjs); the tests hold the lists below to it. The SDK
 * states no permission, retention period or page maximum, so those are not claimed: the bounds here are AMCP's.
 *
 * Who made a change is personal data in this code base (PRV-07: Google's user_email is never requested, Reddit's members are
 * projected out; owner decision of 2026-11-27: off by default). The read never asks for `actor_id` or `actor_name`, refuses a filter
 * by user (`uid`), and returns only the fields below, said once whether Meta named a person. The events that change who may use the
 * account name that person in their object and details, so those are withheld as well. A change made by an automated rule or an app
 * is told by `application_name` and `tool`. Nothing is saved, and the rows are never ownership evidence (the page hook returns
 * before the scope guard observes it).
 */
const gateway = 'meta_native_action',
  name = 'meta_ad_account_id_activities_get';
/** The row fields AMCP asks for and returns: the SDK's AdActivity model without the two that name the person. */
export const metaActivityFields = [
  'application_id',
  'application_name',
  'date_time_in_timezone',
  'event_time',
  'event_type',
  'extra_data',
  'object_id',
  'object_name',
  'object_type',
  'tool',
  'translated_event_type',
];
const people = ['actor_id', 'actor_name'];
/** The query parameters the read takes, of the SDK's: not `uid` (a filter by person), `business_id`, `data_source` or `extra_oids`. */
export const metaActivityParams = ['since', 'until', 'limit', 'after', 'category', 'oid', 'add_children'];
/** The SDK's categories (AdActivity.Category). */
export const metaActivityCategories = [
  'ACCOUNT',
  'AD',
  'AD_KEYWORDS',
  'AD_SET',
  'AUDIENCE',
  'BID',
  'BUDGET',
  'CAMPAIGN',
  'DATE',
  'STATUS',
  'TARGETING',
];
/** The SDK's event types that change who may use the account: their object and details name the person. */
export const metaPeopleEvents = ['ad_account_add_user_to_role', 'ad_account_remove_user_from_role'];
const withheldFromPeopleEvents = ['object_id', 'object_name', 'extra_data'];
/** AMCP's bounds: a window of at most 31 days, 100 rows a page, 10 pages when aggregating. */
const maxDays = 31,
  maxLimit = 100,
  maxPages = 10,
  day = 86400000;

const route = metaPrefix + 'act_{ad_account_id}/activities';
export const metaActivityActions: Action[] = [
  {
    gateway,
    name,
    canonical_name: name,
    aliases: [],
    method: 'GET',
    path: route,
    read_only: true,
    destructive: false,
    required: ['ad_account_id'],
    path_parameters: ['ad_account_id'],
    evidence: 'VENDOR_DOCUMENTED_NOT_AMCP_VERIFIED',
    raw: {
      name,
      canonical_action: name,
      method: 'GET',
      path: route,
      category: 'Marketing API / reference/ad-account/activities',
      read_only: true,
      destructive: false,
      access_management: false,
      path_parameters: ['ad_account_id'],
      required_parameters: ['ad_account_id'],
      native_fields: [],
      description:
        'The ad account’s change history: what was changed (budgets, bids, status, targeting, creatives), when and with which tool. Put since and until (a window of at most 31 days; both required) in query, and limit (1-100), category, oid, add_children and after if needed. Who made a change is personal data and is never requested or returned.',
      source:
        'https://github.com/facebook/facebook-python-business-sdk/blob/26.0.2/facebook_business/adobjects/adaccount.py',
    },
  },
];

/**
 * Whether a compiled request reads an activity edge, by its path whichever way it was named (a catalog action, its short name or a
 * native request), for any account or node ID and with its slash encoded or not, so that no spelling of the route escapes the checks
 * and the projection below.
 */
export const metaActivitiesRead = (plan: Pick<CompiledRequest, 'gateway' | 'method' | 'path'>): boolean =>
  plan.gateway === gateway && plan.method === 'GET' && metaRoute('[^/]+?(?:/|%2[fF])activities/?$').test(plan.path);

/** A field list that names the activity edge: `activities`, `activities{...}` or `activities.limit(5){...}`, at any depth. */
const activityEdge = /(^|[^A-Za-z0-9_])activities([^A-Za-z0-9_]|$)/i;

const windowRefusal = (field: string) =>
  new MirrorError(
    'INVALID_ARGUMENT',
    'The account activity read needs a window: since and until, as dates or ISO datetimes, ending after they start and at most 31 days apart.',
    {field},
  );
const valueRefusal = (field: string) =>
  new MirrorError(
    'INVALID_ARGUMENT',
    'The account activity read does not take this parameter or value; details.allowed lists what it takes.',
    {field, allowed: field === 'fields' ? metaActivityFields : [...metaActivityParams, 'fields']},
  );
const personRefusal = (field: string) =>
  new MirrorError(
    'PERSONAL_DATA_READ_FORBIDDEN',
    'Personal data: who made a change is not shown, so the account activity read takes no uid and no actor field. Remove it.',
    {field, gateway, policy: 'personal_data'},
    403,
  );
const edgeRefusal = () =>
  new MirrorError(
    'PERSONAL_DATA_READ_FORBIDDEN',
    'Personal data: the change history is not read as a field of another object, because it would show who made each change. Read it with the account activity read in details.next_call.',
    {
      field: 'fields',
      gateway,
      policy: 'personal_data',
      next_call: {tool: gateway, arguments: {action: 'DESCRIBE_ACTION', target_action: name}},
    },
    403,
  );
const pageRefusal = () =>
  new MirrorError('INVALID_ARGUMENT', 'Aggregating the account activity read takes max_pages of at most 10.', {
    field: 'max_pages',
    maximum: maxPages,
  });

/** A calendar date that exists (February 30 is not one), written YYYY-MM-DD. */
const calendarDate = (text: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return !!m && new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).toISOString().slice(0, 10) === text;
};
/** A window end as Meta is sent it: a date is the start or the end of that day in UTC; a datetime is sent as written. */
function instant(value: unknown, end: boolean): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (calendarDate(value)) return value + (end ? 'T23:59:59Z' : 'T00:00:00Z');
  return calendarDate(value.slice(0, 10)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
const whole = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) ? (n as number) : undefined;
};

/**
 * The checks of the read before anything is sent (NativeReadSteps.prepare), and the request as sent: the allowed fields (never
 * the person), a page of 100 unless fewer are asked for, the window as ISO datetimes. Refuses what cannot be bounded or names a person.
 */
export function validateMetaActivities(plan: CompiledRequest, input: JsonObject): CompiledRequest {
  if (!metaActivitiesRead(plan)) return plan;
  const query: JsonObject = {...plan.query};
  for (const key of Object.keys(query)) {
    if (key === 'uid') throw personRefusal(key);
    if (key !== 'fields' && !metaActivityParams.includes(key)) throw valueRefusal(key);
  }
  if (query.fields !== undefined) {
    const asked = typeof query.fields === 'string' ? query.fields.split(',').map(f => f.trim()) : [];
    if (asked.some(f => people.includes(f))) throw personRefusal('fields');
    if (!asked.length || asked.some(f => !metaActivityFields.includes(f))) throw valueRefusal('fields');
    // event_type is asked for whatever else is: it is what says a row is about a person (projectMetaActivities).
    query.fields = [...new Set([...asked, 'event_type'])].join(',');
  }
  query.fields ??= metaActivityFields.join(',');
  const since = instant(query.since, false),
    until = instant(query.until, true);
  if (since === undefined) throw windowRefusal('since');
  if (until === undefined) throw windowRefusal('until');
  const span = Date.parse(until) - Date.parse(since);
  if (span < 0 || span > maxDays * day) throw windowRefusal('until');
  query.since = since;
  query.until = until;
  const limit = query.limit === undefined ? maxLimit : whole(query.limit);
  if (limit === undefined || limit < 1 || limit > maxLimit) throw valueRefusal('limit');
  query.limit = limit;
  if (query.category !== undefined && !metaActivityCategories.includes(String(query.category)))
    throw valueRefusal('category');
  if (query.oid !== undefined && !/^\d{1,32}$/.test(String(query.oid))) throw valueRefusal('oid');
  if (query.add_children !== undefined && ![true, false, 'true', 'false'].includes(query.add_children))
    throw valueRefusal('add_children');
  if (query.after !== undefined && !(typeof query.after === 'string' && /^[A-Za-z0-9+/=_-]{1,1024}$/.test(query.after)))
    throw valueRefusal('after');
  if ((input.aggregate_pages || input.paginate || input.allPages) && !(Number(input.max_pages ?? 25) <= maxPages))
    throw pageRefusal();
  return {...plan, query};
}

/**
 * The activity edge of any other Meta read (the review's S3): `fields: "activities{actor_name}"` on an ad account read was sent as written,
 * past the window, the allowed fields and the projection of the read above. A field list that names the edge is refused, with the read that
 * answers; a field that merely contains the word (`daily_spend_activities`) is not the edge.
 */
export function validateMetaActivityEdge(plan: CompiledRequest): void {
  if (plan.gateway !== gateway || metaActivitiesRead(plan)) return;
  const body = plan.body && typeof plan.body === 'object' && !Array.isArray(plan.body) ? (plan.body as JsonObject) : {};
  for (const fields of [plan.query?.fields, body.fields])
    if (fields !== undefined && activityEdge.test(typeof fields === 'string' ? fields : JSON.stringify(fields)))
      throw edgeRefusal();
}

/**
 * The page as it may leave the service (NativeReadSteps.page): the rows without who made each change, the cursor kept so the next
 * page can be read. Anything but the SDK's envelope could carry the people, so it is refused instead of passed on (fail closed).
 */
export function projectMetaActivities(data: unknown): JsonObject {
  const body = data as JsonObject;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Array.isArray(body.data) ||
    body.data.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))
  )
    throw new MirrorError(
      'UPSTREAM_RESPONSE_INVALID',
      'Meta returned an unrecognized change history; it was not shown.',
      {},
      502,
    );
  return {
    data: (body.data as JsonObject[]).map(row => {
      // A row that does not say what it is (no event_type, which the request always asks for) is treated as about a person: fail closed.
      const aboutPeople = typeof row.event_type !== 'string' || metaPeopleEvents.includes(row.event_type);
      return {
        ...Object.fromEntries(
          metaActivityFields
            .filter(field => row[field] !== undefined && !(aboutPeople && withheldFromPeopleEvents.includes(field)))
            .map(field => [field, row[field]]),
        ),
        changed_by: people.some(field => row[field] !== undefined && row[field] !== null)
          ? 'not_shown'
          : 'not_reported',
        ...(aboutPeople ? {withheld: 'people'} : {}),
      };
    }),
    ...(body.paging !== undefined ? {paging: body.paging} : {}),
    personal_data: {actor: 'removed'},
  };
}
