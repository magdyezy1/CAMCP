import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {readGoogleConversionGraph, googleConversionGoalSnapshots} from './google-conversion-goals.js';
import {stable, sha256} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

type Send = (p: CompiledRequest) => Promise<TransportResult>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (message: string, code = 'INVALID_CONVERSION_ACTION'): never => {
  throw new MirrorError(code, message, {}, code === 'CONVERSION_ACTION_STATE_UNVERIFIED' ? 502 : 400);
};
const incomplete = (message: string): never => fail(message, 'CONVERSION_ACTION_STATE_UNVERIFIED');
const only = (v: JsonObject, fields: string[]) => {
  if (Object.keys(v).some(k => !fields.includes(k)))
    fail('An immutable, output-only or unqualified conversion-action field was supplied.');
};
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/[1-9]/.test(id) || !/^\d+$/.test(id) || p.path.split('/')[3] !== id)
    fail('Select the exact conversion customer.');
  return id!;
};
const resource = (p: CompiledRequest, v: unknown) => {
  if (typeof v !== 'string' || !new RegExp('^customers/' + account(p) + '/conversionActions/[1-9][0-9]*$').test(v))
    fail('Use an exact conversion action owned by the selected customer.');
  return v as string;
};
const named = (v: unknown): v is string =>
  typeof v === 'string' &&
  v === v.trim() &&
  v.length > 0 &&
  Buffer.byteLength(v, 'utf8') <= 100 &&
  !/[\u0000-\u001f\ud800-\udfff]/u.test(v);
export const googleConversionActionTypes = [
  'WEBPAGE',
  'CLICK_TO_CALL',
  'AD_CALL',
  'WEBSITE_CALL',
  'UPLOAD_CLICKS',
  'UPLOAD_CALLS',
];
export const googleConversionActionCategories = [
  'DEFAULT',
  'PAGE_VIEW',
  'PURCHASE',
  'SIGNUP',
  'DOWNLOAD',
  'ADD_TO_CART',
  'BEGIN_CHECKOUT',
  'SUBSCRIBE_PAID',
  'PHONE_CALL_LEAD',
  'IMPORTED_LEAD',
  'SUBMIT_LEAD_FORM',
  'BOOK_APPOINTMENT',
  'REQUEST_QUOTE',
  'GET_DIRECTIONS',
  'OUTBOUND_CLICK',
  'CONTACT',
  'ENGAGEMENT',
  'STORE_VISIT',
  'STORE_SALE',
  'QUALIFIED_LEAD',
  'CONVERTED_LEAD',
  'YOUTUBE_FOLLOW_ON_VIEWS',
];
const attribution = ['GOOGLE_ADS_LAST_CLICK', 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN'];
const nested: Record<string, string[]> = {
  valueSettings: ['defaultValue', 'defaultCurrencyCode', 'alwaysUseDefaultValue'],
  attributionModelSettings: ['attributionModel'],
};
const mutable = [
  'name',
  'category',
  'primaryForGoal',
  'countingType',
  'clickThroughLookbackWindowDays',
  'viewThroughLookbackWindowDays',
  'phoneCallDurationSeconds',
  ...Object.keys(nested),
];
const calls = (type: string) => type === 'AD_CALL' || type === 'WEBSITE_CALL';
function integer(v: unknown, min: number, max: number): string {
  if (!((typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v))))
    fail('Use exact decimal integers for day windows and call duration.');
  const n = BigInt(v as string | number);
  if (n < BigInt(min) || n > BigInt(max)) fail('The conversion window or call duration exceeds this qualified range.');
  return String(n);
}
export function googleConversionActionKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+\/conversionActions:mutate$/.test(p.path)
  );
}
function shape(row: JsonObject, creating: boolean) {
  only(row, [...mutable, ...(creating ? ['type', 'status'] : ['resourceName'])]);
  if (row.name !== undefined && !named(row.name)) fail('Conversion names need 1–100 UTF-8 bytes, already trimmed.');
  if (row.category !== undefined && !googleConversionActionCategories.includes(row.category))
    fail('Choose an explicit native conversion category.');
  if (row.primaryForGoal !== undefined && typeof row.primaryForGoal !== 'boolean')
    fail('primaryForGoal must be an explicit boolean.');
  if (row.countingType !== undefined && !['ONE_PER_CLICK', 'MANY_PER_CLICK'].includes(row.countingType))
    fail('Choose ONE_PER_CLICK or MANY_PER_CLICK.');
  for (const field of ['clickThroughLookbackWindowDays', 'viewThroughLookbackWindowDays', 'phoneCallDurationSeconds'])
    if (row[field] !== undefined)
      integer(
        row[field],
        field === 'phoneCallDurationSeconds' ? 0 : 1,
        field === 'phoneCallDurationSeconds' ? 10000 : field === 'clickThroughLookbackWindowDays' ? 60 : 30,
      );
  for (const [parent, fields] of Object.entries(nested))
    if (row[parent] !== undefined) {
      if (!object(row[parent]) || !Object.keys(row[parent]).length) fail('Use explicit mutable nested leaves.');
      only(row[parent], fields);
    }
  if (row.valueSettings) {
    const v = row.valueSettings;
    if (
      v.defaultValue !== undefined &&
      (typeof v.defaultValue !== 'number' ||
        !Number.isFinite(v.defaultValue) ||
        v.defaultValue < 0 ||
        v.defaultValue > 1e12)
    )
      fail('Conversion values are nonnegative currency units, not micros (local limit 1e12).');
    if (
      v.defaultCurrencyCode !== undefined &&
      (typeof v.defaultCurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(v.defaultCurrencyCode))
    )
      fail('Specify a three-letter uppercase conversion currency.');
    if (v.alwaysUseDefaultValue !== undefined && typeof v.alwaysUseDefaultValue !== 'boolean')
      fail('Choose whether to override event values explicitly.');
  }
  if (row.attributionModelSettings && !attribution.includes(row.attributionModelSettings.attributionModel))
    fail('Only Google last-click and data-driven attribution are qualified. Eligibility remains a provider check.');
  if (creating) {
    if (!googleConversionActionTypes.includes(row.type) || row.status !== 'ENABLED')
      fail(
        'Choose a qualified manual conversion type and ENABLED status. Imported/app/system types require their separate setup workflow.',
      );
    const required = [
      'name',
      'category',
      'primaryForGoal',
      'countingType',
      'clickThroughLookbackWindowDays',
      'valueSettings',
      'attributionModelSettings',
      calls(row.type) ? 'phoneCallDurationSeconds' : 'viewThroughLookbackWindowDays',
    ];
    if (required.some(k => row[k] === undefined) || nested.valueSettings!.some(k => row.valueSettings[k] === undefined))
      fail(
        'Provide the complete business definition: primary/secondary, category, counting, attribution, windows, value/currency behavior and call duration where applicable.',
      );
    typeRules(row, row.type, true);
  }
}
function typeRules(row: JsonObject, type: string, input: boolean) {
  if (!googleConversionActionTypes.includes(type))
    fail('This definition type needs a separately qualified provider workflow.');
  if (calls(type)) {
    if (row.viewThroughLookbackWindowDays !== undefined)
      fail('Google disallows view-through windows for AD_CALL and WEBSITE_CALL.');
    if (row.valueSettings?.alwaysUseDefaultValue === false)
      fail('Call-duration conversions require alwaysUseDefaultValue=true.');
  } else if (row.phoneCallDurationSeconds !== undefined)
    fail('Call duration is only qualified for AD_CALL and WEBSITE_CALL.');
  if (row.clickThroughLookbackWindowDays !== undefined)
    integer(row.clickThroughLookbackWindowDays, 1, input ? (calls(type) ? 60 : 30) : 90);
  if (row.viewThroughLookbackWindowDays !== undefined) integer(row.viewThroughLookbackWindowDays, 1, 30);
}
export function assertGoogleConversionAction(p: CompiledRequest) {
  if (!googleConversionActionKind(p)) return;
  account(p);
  const body = googleJson(p.body);
  if (!object(body)) fail('Use a native mutation envelope.');
  only(body, ['operations', 'partialFailure', 'validateOnly', 'responseContentType']);
  if (
    Object.keys(p.headers).length ||
    Object.keys(p.query).length ||
    !Array.isArray(body.operations) ||
    !body.operations.length ||
    body.operations.length > 25 ||
    (body.partialFailure !== undefined && body.partialFailure !== false) ||
    (body.validateOnly !== undefined && body.validateOnly !== false) ||
    (body.responseContentType !== undefined && body.responseContentType !== 'RESOURCE_NAME_ONLY')
  )
    fail('Review 1–25 atomic operations with resource-name receipts and no header/query overrides.');
  const seen = new Set<string>();
  for (const op of body.operations) {
    if (!object(op)) fail('Use native operation objects.');
    only(op, ['create', 'update', 'remove', 'updateMask']);
    if (['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
      fail('Select one create, update or remove per operation.');
    let key: string;
    if (op.create !== undefined || op.update !== undefined) {
      const row = op.create ?? op.update;
      if (!object(row)) fail('Create/update requires an object.');
      shape(row, op.create !== undefined);
      key = op.create ? 'name:' + row.name : resource(p, row.resourceName);
      if (op.update) {
        if (typeof op.updateMask !== 'string' || !op.updateMask) fail('Updates require an exact leaf field mask.');
        const mask = op.updateMask.split(','),
          leaves = Object.keys(row)
            .filter(k => k !== 'resourceName')
            .flatMap(k => (nested[k] ? Object.keys(row[k]).map(f => k + '.' + f) : [k]));
        if (!leaves.length || new Set(mask).size !== mask.length || stable([...mask].sort()) !== stable(leaves.sort()))
          fail(
            'The native mask must match every explicit mutable leaf. Nulls, whole-object masks, wildcards and implicit clearing are unsupported.',
          );
      }
    } else key = resource(p, op.remove);
    if (!op.update && op.updateMask !== undefined) fail('Only updates accept masks.');
    if (seen.has(key)) fail('A target or new name may occur only once per review.');
    seen.add(key);
  }
}
function normalize(row: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of [
    'resourceName',
    'id',
    'name',
    'status',
    'type',
    'category',
    'origin',
    'ownerCustomer',
    'primaryForGoal',
    'countingType',
    'appId',
  ])
    if (row[k] !== undefined) out[k] = row[k];
  for (const k of ['clickThroughLookbackWindowDays', 'viewThroughLookbackWindowDays', 'phoneCallDurationSeconds'])
    if (row[k] !== undefined)
      out[k] = integer(row[k], k === 'phoneCallDurationSeconds' ? 0 : 1, k === 'phoneCallDurationSeconds' ? 10000 : 90);
  for (const [k, fields] of Object.entries(nested))
    if (object(row[k]))
      out[k] = Object.fromEntries(fields.filter(f => row[k][f] !== undefined).map(f => [f, row[k][f]]));
  return out;
}
function target(p: CompiledRequest, row: JsonObject | undefined): JsonObject {
  if (
    !row ||
    row.ownerCustomer !== 'customers/' + account(p) ||
    row.status !== 'ENABLED' ||
    !googleConversionActionTypes.includes(row.type) ||
    row.appId
  )
    incomplete('The target must be an enabled, client-owned manual conversion definition.');
  resource(p, row!.resourceName);
  if (
    String(row!.id) !== row!.resourceName.split('/').at(-1) ||
    !named(row!.name) ||
    typeof row!.primaryForGoal !== 'boolean' ||
    !googleConversionActionCategories.includes(row!.category) ||
    !['ONE_PER_CLICK', 'MANY_PER_CLICK'].includes(row!.countingType) ||
    !attribution.includes(row!.attributionModelSettings?.attributionModel) ||
    !object(row!.valueSettings) ||
    typeof row!.valueSettings.defaultValue !== 'number' ||
    !Number.isFinite(row!.valueSettings.defaultValue) ||
    row!.valueSettings.defaultValue < 0 ||
    !/^[A-Z]{3}$/.test(row!.valueSettings.defaultCurrencyCode) ||
    typeof row!.valueSettings.alwaysUseDefaultValue !== 'boolean' ||
    row!.clickThroughLookbackWindowDays === undefined ||
    (calls(row!.type) ? row!.phoneCallDurationSeconds === undefined : row!.viewThroughLookbackWindowDays === undefined)
  )
    incomplete('The complete native conversion identity and business settings are required.');
  typeRules(row!, row!.type, false);
  return normalize(row!);
}
const pair = (r: JsonObject) => r.category + '/' + r.origin;
function desired(p: CompiledRequest, before: JsonObject, receipts?: JsonObject[]) {
  const definitions = structuredClone(before.conversionActions),
    touched = new Set<string>();
  for (const [i, op] of (googleJson(p.body).operations as JsonObject[]).entries()) {
    const id = op.remove ?? op.update?.resourceName ?? receipts?.[i]?.resourceName ?? 'new:' + i,
      old = op.create ? undefined : target(p, definitions[id]);
    if (op.remove) {
      if (
        Object.values(before.goals.customConversionGoals).some(
          (g: any) => g.status === 'ENABLED' && g.conversionActions.includes(id),
        )
      )
        fail('Detach this action from every enabled custom goal in separate reviewed changes before removal.');
      definitions[id] = {...old, status: 'REMOVED'};
    } else {
      const input = op.create ?? op.update;
      if (op.update) typeRules(input, old!.type, true);
      const row = {...old, ...input, resourceName: id};
      for (const k of Object.keys(nested)) if (input[k]) row[k] = {...old?.[k], ...input[k]};
      if (Object.entries(definitions).some(([key, value]: [string, any]) => key !== id && value.name === row.name))
        fail('Use a unique conversion name, including retained removed definitions.');
      if (op.update) {
        typeRules(row, row.type, false);
        if (input.category !== undefined && input.category !== old!.category) {
          const wanted = pair(row);
          if (
            !Object.values(before.goals.customerConversionGoals).some((g: any) => pair(g) === wanted) ||
            Object.keys(before.campaigns).some(
              c =>
                !Object.values(before.goals.campaignConversionGoals).some(
                  (g: any) => g.campaign === c && pair(g) === wanted,
                ),
            )
          )
            fail(
              'Before changing category, establish and review the destination standard goals. A new category needs a separately verified creation workflow.',
            );
        }
      }
      definitions[id] = normalize(row);
    }
    touched.add(id);
  }
  if (Object.keys(definitions).length > 2000) fail('Creation would exceed complete definition read-back capacity.');
  return {definitions, touched};
}
export const googleConversionActionSnapshots = googleConversionGoalSnapshots;
export async function readGoogleConversionActionState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const state = await readGoogleConversionGraph(p, send, true);
  for (const [id, row] of Object.entries(state.conversionActions) as [string, JsonObject][]) {
    state.conversionActions[id] = normalize(row);
    if (
      row.status === 'ENABLED' &&
      row.ownerCustomer === 'customers/' + account(p) &&
      googleConversionActionTypes.includes(row.type)
    ) {
      if (
        !Object.values(state.goals.customerConversionGoals).some((g: any) => pair(g) === pair(row)) ||
        Object.keys(state.campaigns).some(
          c =>
            !Object.values(state.goals.campaignConversionGoals).some(
              (g: any) => g.campaign === c && pair(g) === pair(row),
            ),
        )
      )
        incomplete(
          'An existing conversion definition is missing its automatic customer or campaign goal. Read the complete current graph before preparing.',
        );
    }
  }
  desired(p, state);
  return [state];
}
export function googleConversionActionOutcome(p: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  const ops = googleJson(p.body).operations,
    d = result.data;
  if (
    result.status !== 200 ||
    !object(d) ||
    Object.keys(d).some(k => k !== 'results') ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  const seen = new Set<string>();
  return d.results.every((row: unknown, i: number) => {
    try {
      if (!object(row) || Object.keys(row).some(k => k !== 'resourceName')) return false;
      const name = resource(p, row.resourceName),
        op = ops[i];
      if (
        seen.has(name) ||
        (op.create && Object.hasOwn((before[0] as JsonObject).conversionActions, name)) ||
        (!op.create && name !== (op.remove ?? op.update.resourceName))
      )
        return false;
      seen.add(name);
      return true;
    } catch {
      return false;
    }
  });
}
function goalProjection(goals: JsonObject) {
  const out: JsonObject = {};
  for (const [kind, rows] of Object.entries(goals) as [string, JsonObject][]) {
    out[kind] = {};
    for (const row of Object.values(rows) as JsonObject[]) {
      const key =
        kind === 'customerConversionGoals'
          ? pair(row)
          : kind === 'campaignConversionGoals'
            ? row.campaign + '/' + pair(row)
            : row.resourceName;
      const value = {...row};
      delete value.resourceName;
      out[kind][key] = value;
    }
  }
  return out;
}
export async function verifyGoogleConversionAction(
  p: CompiledRequest,
  result: JsonObject,
  before: unknown[],
  send: Send,
) {
  const prior = before[0] as JsonObject,
    actual = await readGoogleConversionGraph(p, send, true),
    {definitions, touched} = desired(p, prior, result.data.results),
    checks: JsonObject[] = [];
  const add = (id: string, e: unknown, a: unknown, scope: string) => {
    const expected = e ?? {},
      observed = a ?? {},
      fields = [...new Set([...Object.keys(expected), ...Object.keys(observed)])].filter(
        k => stable((expected as JsonObject)[k]) !== stable((observed as JsonObject)[k]),
      );
    checks.push({
      resource_id: id,
      status: fields.length ? 'inconclusive' : 'verified',
      verification_scope: scope,
      changed_fields: fields,
      expected_hash: sha256(stable(expected)),
      actual_hash: sha256(stable(observed)),
    });
  };
  const goals = goalProjection(prior.goals);
  for (const [i, op] of (googleJson(p.body).operations as JsonObject[]).entries()) {
    const id = result.data.results[i].resourceName,
      expected = definitions[id],
      observed = actual.conversionActions[id];
    if (op.remove) {
      add(id, {removed: true}, {removed: !observed || observed.status === 'REMOVED'}, 'conversion_definition');
      continue;
    }
    let value: JsonObject | undefined;
    try {
      value = target(p, observed);
    } catch {}
    if (op.create) {
      expected.id = id.split('/').at(-1);
      expected.ownerCustomer = 'customers/' + account(p);
      // The output-only origin is established by the exact owned native read,
      // never accepted from the caller or the mutation receipt.
      expected.origin = value?.origin;
      if (!value || !['WEBSITE', 'CALL_FROM_ADS'].includes(value.origin)) expected.origin = 'UNVERIFIED_MANUAL_ORIGIN';
      else {
        const key = pair(expected);
        goals.customerConversionGoals[key] ??= {category: expected.category, origin: expected.origin, biddable: true};
        for (const campaign of Object.keys(prior.campaigns)) {
          const keyFor = campaign + '/' + key;
          if (!goals.campaignConversionGoals[keyFor])
            goals.campaignConversionGoals[keyFor] = {
              campaign,
              category: expected.category,
              origin: expected.origin,
              biddable: !Object.values(goals.campaignConversionGoals).some(
                (g: any) => g.campaign === campaign && g.category === expected.category && g.biddable === false,
              ),
            };
        }
      }
    }
    add(id, expected, value, 'conversion_definition');
  }
  add('goal_graph', goals, goalProjection(actual.goals), 'automatic_standard_goals_and_existing_membership');
  for (const collection of ['customer', 'campaigns', 'budgets', 'strategies'] as const)
    add(collection, prior[collection], actual[collection], 'unchanged_bidding_dependencies');
  const untouched = (rows: JsonObject) =>
    Object.fromEntries(
      Object.entries(rows)
        .filter(([id]) => !touched.has(id))
        .map(([id, v]) => [id, normalize(v as JsonObject)]),
    );
  add(
    'other_definitions',
    untouched(prior.conversionActions),
    untouched(actual.conversionActions),
    'unchanged_conversion_definitions',
  );
  return {status: checks.every(c => c.status === 'verified') ? 'verified' : 'inconclusive', checks};
}
export function googleConversionActionServing(p: CompiledRequest): boolean {
  return (
    googleConversionActionKind(p) &&
    googleJson(p.body).operations.some(
      (o: JsonObject) =>
        o.remove || o.create || Object.keys(o.update ?? {}).some(k => !['resourceName', 'name'].includes(k)),
    )
  );
}
export const googleConversionActionImpact = {
  provider: 'google_ads',
  scope: 'client_owned_conversion_definitions',
  may_affect_serving: true,
  effect:
    'Changes counting, attribution and values used by reporting and bidding. A primary action may affect current and future campaigns immediately. Custom goals can bid on secondary actions. Creation automatically adds standard goals; new manual-origin customer goals are biddable, while campaign defaults also depend on existing goals for the same category.',
  units:
    'defaultValue uses the explicit conversion currency in whole currency units, not micros and not a campaign budget. Windows are days; call duration is seconds. No default business choices are inferred.',
  review:
    'The complete client goal, campaign, budget, portfolio and definition graph is frozen. Business-setting changes require spend confirmation and obey the owner activation policy; removal also obeys deletion policy. Rename-only operations do not change optimization.',
  limits:
    'Up to 25 atomic operations and 2000 definitions including removed history. Qualified manual types: WEBPAGE, CLICK_TO_CALL, AD_CALL, WEBSITE_CALL, UPLOAD_CLICKS and UPLOAD_CALLS. Own conversion customer with no current App campaigns; no manager sharing, imported GA4/app/system types, PII/event uploads, type changes or implicit masks. Qualified input click windows: 1–30 days, or 1–60 for AD_CALL/WEBSITE_CALL; view windows: 1–30. Provider eligibility and data-driven attribution approval remain native checks.',
  verification:
    'Checks the exact native definition and automatic goal creation while preserving existing dependencies. This does not install website tags, link call assets, enable offline upload access, ingest conversions or establish tracking accuracy.',
  recovery:
    'Keep the original review/key after partial, lost or inconclusive outcomes. Never automatically resubmit. Remove custom-goal membership before deletion; configure goal biddability in separately reviewed steps.',
};
