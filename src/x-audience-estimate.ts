import {MirrorError} from './errors.js';
import {stable, sha256} from './security.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';

const gateway = 'x_ads_native_action',
  origin = 'https://ads-api.x.com',
  native = /^[a-z0-9]{1,32}$/,
  userId = /^[1-9][0-9]{0,24}$/;
const types = new Set([
  'AGE',
  'DEVICE',
  'EVENT',
  'CAMPAIGN_ENGAGEMENT',
  'CAMPAIGN_ENGAGEMENT_LOOKALIKE',
  'CONVERSATION',
  'ENGAGEMENT_TYPE',
  'FOLLOWERS_OF_USER',
  'GENDER',
  'INTEREST',
  'LANGUAGE',
  'LIVE_TV_EVENT',
  'LOCATION',
  'NETWORK_ACTIVATION_DURATION',
  'NETWORK_OPERATOR',
  'PLATFORM',
  'PLATFORM_VERSION',
  'SIMILAR_TO_FOLLOWERS_OF_USER',
  'TV_SHOW',
  'USER_ENGAGEMENT',
  'USER_ENGAGEMENT_LOOKALIKE',
  'WIFI_ONLY',
  'BROAD_KEYWORD',
  'EXACT_KEYWORD',
  'PHRASE_KEYWORD',
  'UNORDERED_KEYWORD',
  'CUSTOM_AUDIENCE',
  'CUSTOM_AUDIENCE_EXPANDED',
  'APP_STORE_CATEGORY',
  'APP_STORE_CATEGORY_LOOKALIKE',
]);
const primary = new Set([
  'FOLLOWERS_OF_USER',
  'SIMILAR_TO_FOLLOWERS_OF_USER',
  'CUSTOM_AUDIENCE',
  'CUSTOM_AUDIENCE_EXPANDED',
  'INTEREST',
  'BROAD_KEYWORD',
  'EXACT_KEYWORD',
  'PHRASE_KEYWORD',
  'UNORDERED_KEYWORD',
  'TV_SHOW',
  'LIVE_TV_EVENT',
]);
const privateUser = new Set(['FOLLOWERS_OF_USER', 'USER_ENGAGEMENT', 'USER_ENGAGEMENT_LOOKALIKE']);
export const xAudienceCriteriaTypes = Object.freeze([...types].sort());
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && [...v].length <= max && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
function fail(message: string, code = 'INVALID_X_AUDIENCE_ESTIMATE'): never {
  throw new MirrorError(
    code,
    message,
    {},
    code === 'RESOURCE_SCOPE_REQUIRED' || code === 'ACCOUNT_SCOPE_MISMATCH'
      ? 403
      : code === 'X_AUDIENCE_RESPONSE_INVALID' || code === 'X_AUDIENCE_LIMIT'
        ? 502
        : 400,
  );
}
function invalid(): never {
  return fail(
    'X returned a malformed, partial or unscoped audience estimate. No zero or midpoint is substituted.',
    'X_AUDIENCE_RESPONSE_INVALID',
  );
}
export function xAudienceEstimateRoute(p: CompiledRequest): boolean {
  return (
    p.gateway === gateway &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === origin) &&
    /^\/12\/accounts\/[a-z0-9]{1,32}\/audience_estimate$/.test(p.path)
  );
}
export function validateXAudienceEstimate(p: CompiledRequest): void {
  if (!xAudienceEstimateRoute(p)) return;
  if (!p.accountId || p.path.split('/')[3] !== p.accountId)
    fail('The estimate must identify the selected X advertising account.', 'ACCOUNT_SCOPE_MISMATCH');
  if (
    Object.keys(p.headers).length ||
    Object.keys(p.query).some(k => k !== 'operator_type') ||
    (p.query.operator_type !== undefined && !['EQ', 'NE'].includes(p.query.operator_type))
  )
    fail(
      'Use only the native JSON criteria and optional EQ/NE operator_type query; headers and method overrides are not accepted.',
    );
  const b = p.body;
  if (
    !object(b) ||
    Object.keys(b).length !== 1 ||
    !Array.isArray(b.targeting_criteria) ||
    !b.targeting_criteria.length ||
    b.targeting_criteria.length > 200
  )
    fail("Supply targeting_criteria with 1–200 criteria. This is AMCP's request bound, not a claimed vendor maximum.");
  const seen = new Set<string>();
  let ages = 0,
    hasPrimary = false;
  for (const c of (b as JsonObject).targeting_criteria) {
    if (
      !object(c) ||
      Object.keys(c).some(k => !['targeting_type', 'targeting_value', 'operator_type'].includes(k)) ||
      !types.has(c.targeting_type) ||
      !text(c.targeting_value, 1024) ||
      (c.operator_type !== undefined && !['EQ', 'NE'].includes(c.operator_type))
    )
      fail(
        'Use a documented targeting_type, native string targeting_value and optional EQ/NE operator_type. APP_LIST/TAP exclusions and comparison operators need their own estimate contract.',
      );
    const key = c.targeting_type + ':' + c.targeting_value;
    if (seen.has(key)) fail('Do not duplicate or both include and exclude the same criterion.');
    seen.add(key);
    if (c.targeting_type === 'AGE' && ++ages > 1) fail('X supports one age bucket in a targeting set.');
    if (primary.has(c.targeting_type)) hasPrimary = true;
    if (
      (privateUser.has(c.targeting_type) || c.targeting_type === 'SIMILAR_TO_FOLLOWERS_OF_USER') &&
      !userId.test(c.targeting_value)
    )
      fail('Follower and engagement targeting require exact decimal user IDs as strings.');
    if (
      /^(?:CUSTOM_AUDIENCE(?:_EXPANDED)?|CAMPAIGN_ENGAGEMENT(?:_LOOKALIKE)?)$/.test(c.targeting_type) &&
      !native.test(c.targeting_value)
    )
      fail('Use an exact native custom-audience or campaign ID.');
  }
  if (!hasPrimary)
    fail(
      'X requires a primary criterion for audience estimates: followers, custom audiences, interests, keywords or TV. Discover or ask for the intended criterion; do not invent one.',
    );
  if (Buffer.byteLength(JSON.stringify(b)) > 128 * 1024) fail("The criteria exceed AMCP's 128 KiB request bound.");
  const refs = (b as JsonObject).targeting_criteria.filter((c: JsonObject) =>
    /^(?:CUSTOM_AUDIENCE|CAMPAIGN_ENGAGEMENT)/.test(c.targeting_type),
  );
  if (new Set(refs.map((c: JsonObject) => c.targeting_type.split('_')[0] + ':' + c.targeting_value)).size > 25)
    fail('An estimate can reference at most 25 distinct account-owned audiences/campaigns.');
}
export function xAudienceEstimatePlan(p: CompiledRequest): CompiledRequest {
  if (!xAudienceEstimateRoute(p)) return p;
  validateXAudienceEstimate(p);
  return {
    ...p,
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    warnings: [
      ...p.warnings,
      'X returns an estimated potential audience range, not forecast delivery, impressions, conversions or spend. Values can change. Account-owned references are checked at execution; unknown eligibility is not inferred from an estimate.',
    ],
  };
}
export function authorizeXAudienceEstimate(p: CompiledRequest, c: Connection, account: string): boolean {
  if (!xAudienceEstimateRoute(p)) return false;
  validateXAudienceEstimate(p);
  if (account !== p.accountId || !c.accounts.includes(account))
    fail('The current selected connection must grant this account.', 'ACCOUNT_SCOPE_MISMATCH');
  return true;
}
function envelope(raw: unknown, account: string, paginated = false): JsonObject {
  if (
    !object(raw) ||
    !object(raw.request) ||
    !object(raw.request.params) ||
    raw.request.params.account_id !== account ||
    (raw.errors !== undefined && (!Array.isArray(raw.errors) || raw.errors.length)) ||
    raw.error ||
    raw.partial_failure ||
    raw.partialFailure ||
    raw.operation_errors ||
    (raw.next_cursor !== undefined && raw.next_cursor !== null && (paginated ? !text(raw.next_cursor, 4096) : true))
  )
    invalid();
  return raw as JsonObject;
}
export function xAudienceEstimateResult(p: CompiledRequest, raw: unknown): JsonObject {
  const d = envelope(raw, p.accountId!),
    size = d.data?.audience_size;
  if (
    !object(d.data) ||
    Object.keys(d.data).some(k => k !== 'audience_size') ||
    !object(size) ||
    Object.keys(size).some(k => !['min', 'max'].includes(k)) ||
    !Number.isSafeInteger(size.min) ||
    !Number.isSafeInteger(size.max) ||
    size.min < 0 ||
    size.max < size.min
  )
    invalid();
  const echo = d.request.params.targeting_criteria;
  if (echo !== undefined && echo !== null && stable(echo) !== stable((p.body as JsonObject).targeting_criteria))
    invalid();
  return {request: {params: {account_id: p.accountId}}, data: {audience_size: {min: size.min, max: size.max}}};
}
/** Estimate only. Native account-scoped reads check private audience/campaign/user
 * references; no ownership grant or campaign mutation is inferred from output. */
export async function runXAudienceEstimate(p: CompiledRequest, send: (p: CompiledRequest) => Promise<unknown>) {
  validateXAudienceEstimate(p);
  const criteria = (p.body as JsonObject).targeting_criteria as JsonObject[],
    account = p.accountId!,
    started = performance.now(),
    refs = new Set<string>(),
    users = new Set<string>();
  let bytes = 0,
    reads = 0;
  const bounded = async (plan: CompiledRequest) => {
    if (++reads > 32 || performance.now() - started > 60000)
      fail('Audience estimation exceeded its request/deadline bound.', 'X_AUDIENCE_LIMIT');
    const raw = await send(plan);
    bytes += Buffer.byteLength(JSON.stringify(raw) ?? '');
    if (bytes > 2 * 1024 * 1024 || performance.now() - started > 60000)
      fail('Audience estimation exceeded its byte/deadline bound.', 'X_AUDIENCE_LIMIT');
    return raw;
  };
  const read = (path: string, query: JsonObject = {}): CompiledRequest => ({
    ...p,
    action: 'AMCP_X_AUDIENCE_REFERENCE',
    method: 'GET',
    path: '/12/accounts/' + account + '/' + path,
    body: undefined,
    query,
    headers: {},
    responseControls: undefined,
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
  });
  for (const c of criteria) {
    if (/^CUSTOM_AUDIENCE(?:_EXPANDED)?$/.test(c.targeting_type)) refs.add('custom_audiences/' + c.targeting_value);
    if (/^CAMPAIGN_ENGAGEMENT(?:_LOOKALIKE)?$/.test(c.targeting_type)) refs.add('campaigns/' + c.targeting_value);
    if (privateUser.has(c.targeting_type)) users.add(c.targeting_value);
  }
  for (const ref of refs) {
    const d = envelope(await bounded(read(ref)), account),
      r = d.data;
    if (
      !object(r) ||
      r.id !== ref.split('/')[1] ||
      r.deleted !== false ||
      (r.account_id !== undefined && r.account_id !== account)
    )
      invalid();
    if (ref.startsWith('custom_audiences/') && r.targetable !== true)
      fail(
        'The selected custom audience is not currently targetable. Inspect its status; do not treat unavailable audiences as zero reach.',
        'RESOURCE_SCOPE_REQUIRED',
      );
  }
  if (users.size) {
    let cursor: string | undefined;
    const tokens = new Set<string>(),
      found = new Set<string>(),
      ids = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const raw = envelope(
        await bounded(read('promotable_users', {count: 200, ...(cursor ? {cursor} : {})})),
        account,
        true,
      );
      if (!Array.isArray(raw.data) || raw.data.length > 200) invalid();
      for (const r of raw.data) {
        if (
          !object(r) ||
          !native.test(r.id) ||
          typeof r.id !== 'string' ||
          ids.has(r.id) ||
          !userId.test(r.user_id) ||
          typeof r.user_id !== 'string' ||
          typeof r.deleted !== 'boolean' ||
          !['FULL', 'RETWEETS_ONLY'].includes(r.promotable_user_type)
        )
          invalid();
        ids.add(r.id);
        if (!r.deleted && r.promotable_user_type === 'FULL') found.add(r.user_id);
      }
      if ([...users].every(u => found.has(u))) break;
      if (!raw.next_cursor) break;
      if (!text(raw.next_cursor, 4096) || tokens.has(raw.next_cursor) || !raw.data.length) invalid();
      tokens.add(raw.next_cursor);
      cursor = raw.next_cursor;
      if (page === 4)
        fail(
          'Promotable-user lookup is incomplete at its 1000-row bound. No estimate was requested.',
          'X_AUDIENCE_LIMIT',
        );
    }
    if ([...users].some(u => !found.has(u)))
      fail(
        'Follower/own-content engagement targeting requires each exact user to be FULL promotable in this account.',
        'RESOURCE_SCOPE_REQUIRED',
      );
  }
  const data = xAudienceEstimateResult(p, await bounded(p));
  return {
    data,
    pages: 1,
    truncated: false,
    estimate: {
      kind: 'potential_audience_range',
      account_id: account,
      criteria_count: criteria.length,
      criteria_fingerprint: sha256(stable({body: p.body, query: p.query})),
      generated_at: new Date().toISOString(),
      guaranteed_delivery: false,
      provider: 'X Ads API v12',
      reference_reads: reads - 1,
      interpretation:
        'Provider estimate of the potential audience for these criteria. Not additive across estimates and not a forecast of delivery, impressions, conversions or spend. Eligibility, approval and quota remain provider decisions.',
    },
  };
}
