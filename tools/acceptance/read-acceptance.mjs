// ACC-06: the owner-authorized read-only acceptance runs: the four measurement reads, TikTok's core reads, the Reddit
// conversion value unit and X's publisher-network placement. One run is one part, on assets the owner designated and
// authorized in writing. It runs AMCP's own read paths (the workspace measurement actions, the read-probe runner, the
// Reddit campaign report, X's synchronous stats read) on an in-memory login that holds only the plan's accounts, behind a
// guard that lets through only the part's provider hosts, GET requests and the documented read POSTs. It records status
// codes, provider request IDs and response-shape digests: never an account ID, token, payload or metric value.
// Usage (after `npm run build`; docs/acceptance/READ-ACCEPTANCE.md is the runbook):
//   node tools/acceptance/read-acceptance.mjs template <part>        a blank plan: measurement, tiktok,
//                                                                    reddit_value_unit or x_publisher_network
//   node tools/acceptance/read-acceptance.mjs <plan.json>            dry run: validate and list every read; no request
//   node tools/acceptance/read-acceptance.mjs <plan.json> --live     the live run, only with every flag below
//   node tools/acceptance/read-acceptance.mjs check <record.json>    validate a run record before ledger.mjs add
// Live flags, set in the environment through a secret-safe mechanism, never on the command line:
//   AMCP_ACCEPTANCE_LIVE=true                    the explicit live switch
//   AMCP_ACCEPTANCE_AUTHORIZATION=<ref>          equal to the plan's authorization_ref
//   AMCP_ACCEPTANCE_PLAN_SHA256=<hex>            SHA-256 of the exact plan file the owner approved
//   AMCP_ACCEPTANCE_RUN_ID=<id>                  names the run directory .runtime/acceptance/<id>/
//   AMCP_ACCEPTANCE_CREDENTIALS_JSON=<json>      {"<gateway>": {credential fields}} for each gateway the part reads
// Without every flag the harness refuses before it reads a credential or sends anything.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
let loaded;
/** The built AMCP modules the harness runs; loaded on first use so `template` works before a build. */
async function dist() {
  if (loaded) return loaded;
  const load = file => import(pathToFileURL(path.join(root, 'dist/src', file)).href);
  const [store, catalog, service, transport, errors, taxonomy, verification, native, metrics, ledger, contracts, x] =
    await Promise.all([
      load('store.js'),
      load('catalog.js'),
      load('service.js'),
      load('transport.js'),
      load('errors.js'),
      load('provider-error-taxonomy.js'),
      load('read-verification.js'),
      load('report-native.js'),
      load('report-metrics.js'),
      load('acceptance-ledger.js'),
      load('provider-contracts.js'),
      load('x-report-jobs.js'),
    ]);
  loaded = {
    ...store,
    ...catalog,
    ...service,
    ...transport,
    ...errors,
    ...taxonomy,
    ...verification,
    ...native,
    ...metrics,
    ...ledger,
    ...contracts,
    ...x,
  };
  return loaded;
}

/** The four parts of ACC-06: the gateways each reads, the only hosts its guard lets through and its request ceiling. */
export const readParts = {
  measurement: {
    gateways: ['gtm_native_action', 'ga4_native_action', 'linkedin_native_action'],
    hosts: [
      'tagmanager.googleapis.com',
      'analyticsdata.googleapis.com',
      'analyticsadmin.googleapis.com',
      'api.linkedin.com',
    ],
    limit: 150,
  },
  tiktok: {gateways: ['tiktok_native_action'], hosts: ['business-api.tiktok.com'], limit: 12},
  reddit_value_unit: {gateways: ['reddit_native_action'], hosts: ['ads-api.reddit.com'], limit: 8},
  x_publisher_network: {gateways: ['x_ads_native_action'], hosts: ['ads-api.x.com'], limit: 4},
};
/** The run's own in-memory logins, one per gateway; nothing is saved after the run. */
export const acceptanceConnections = {
  gtm_native_action: '00000000-0000-4000-8000-00000000a601',
  ga4_native_action: '00000000-0000-4000-8000-00000000a602',
  linkedin_native_action: '00000000-0000-4000-8000-00000000a603',
  tiktok_native_action: '00000000-0000-4000-8000-00000000a604',
  reddit_native_action: '00000000-0000-4000-8000-00000000a605',
  x_ads_native_action: '00000000-0000-4000-8000-00000000a606',
};
/** The read-only permissions AMCP requests for each provider (src/provider-grants.ts); a run records no write grant. */
const readScopes = {
  gtm_native_action: ['https://www.googleapis.com/auth/tagmanager.readonly'],
  ga4_native_action: ['https://www.googleapis.com/auth/analytics.readonly'],
  linkedin_native_action: ['r_ads', 'r_ads_reporting'],
  tiktok_native_action: [],
  reddit_native_action: ['adsread'],
  x_ads_native_action: [],
};
const hostGateways = {
  'tagmanager.googleapis.com': 'gtm_native_action',
  'analyticsdata.googleapis.com': 'ga4_native_action',
  'analyticsadmin.googleapis.com': 'ga4_native_action',
  'api.linkedin.com': 'linkedin_native_action',
  'business-api.tiktok.com': 'tiktok_native_action',
  'ads-api.reddit.com': 'reddit_native_action',
  'ads-api.x.com': 'x_ads_native_action',
};
/** The User-Agent of AMCP's Reddit logins (server/platform-oauth.ts): AMCP_REDDIT_USER_AGENT, or AMCP's default. */
const redditUserAgent = env => {
  const value = env.AMCP_REDDIT_USER_AGENT?.trim() || 'AMCP/0.1.0 (advertising campaign management)';
  if (/[\r\n]/.test(value)) throw Error('AMCP_REDDIT_USER_AGENT must not contain line breaks.');
  return value;
};
/** The documented reads that use POST. Every other request of a run must be a GET. */
const readPosts = [
  {host: 'analyticsdata.googleapis.com', path: /^\/v1beta\/properties\/[0-9]{1,20}:(?:runRealtimeReport|runReport)$/},
  {host: 'ads-api.reddit.com', path: /^\/api\/v3\/ad_accounts\/[A-Za-z0-9_]{1,64}\/reports$/},
];
/** Each measurement action, the gateway it reads and the action-ledger row its acceptance applies to. */
export const measurementReads = {
  measurement_audit: {gateway: 'gtm_native_action', operation: 'gtm_audit_ops', action: 'gtm_audit_ops'},
  measurement_events: {gateway: 'ga4_native_action', operation: 'ga4_data_report', action: 'realtime'},
  measurement_event_identity: {gateway: 'ga4_native_action', operation: 'ga4_run_report', action: 'ga4_run_report'},
  measurement_conversions: {gateway: 'linkedin_native_action', action: 'linkedin_rest_conversions_get'},
};
/** The six TikTok reads of ACC-06, each one page of at most a few rows. */
export const tiktokReads = [
  {id: 'advertiser_info', action: 'tiktok_advertiser_info_get', params: id => ({advertiser_ids: [id]})},
  {id: 'campaigns', action: 'tiktok_campaign_get', params: () => ({page_size: 1})},
  {id: 'adgroups', action: 'tiktok_adgroup_get', params: () => ({page_size: 1})},
  {id: 'ads', action: 'tiktok_ad_get', params: () => ({page_size: 1})},
  {
    id: 'report',
    action: 'tiktok_report_integrated_get',
    params: (_id, plan) => ({
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: ['campaign_id'],
      metrics: ['spend', 'impressions'],
      start_date: plan.report.since,
      end_date: plan.report.until,
      page_size: 10,
    }),
  },
  {id: 'identities', action: 'tiktok_identity_get', params: () => ({page_size: 1})},
];
const refusalCodes = new Set([
  'PROVIDER_ACCESS_DENIED',
  'INSUFFICIENT_SCOPE',
  'PROVIDER_PERMISSION_MISSING',
  'AUTH_EXPIRED',
  'REAUTHORIZATION_REQUIRED',
]);
const label = /^[a-z][a-z0-9-]{1,39}$/,
  reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/,
  day = /^\d{4}-\d{2}-\d{2}$/,
  hex64 = /^[0-9a-f]{64}$/,
  digits = /^[0-9]{1,20}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const dayMs = 86400000,
  dateOf = text => (day.test(String(text)) ? Date.parse(text + 'T00:00:00Z') : NaN),
  nextDay = text => new Date(dateOf(text) + dayMs).toISOString().slice(0, 10);
const allowedKeys = {
  measurement: ['reads'],
  tiktok: ['account_label', 'account_id', 'report'],
  reddit_value_unit: ['account_label', 'account_id', 'week', 'manual'],
  x_publisher_network: ['account_label', 'account_id', 'window'],
};

/** A blank plan for one part: every value the owner supplies is REPLACE. */
export function readTemplate(part) {
  if (!readParts[part]) throw Error('Name a part: ' + Object.keys(readParts).join(', ') + '.');
  const base = {
    ticket: 'ACC-06',
    part,
    authorization_ref: 'REPLACE: the reference of the owner’s written authorization of these reads',
    account_type: 'real',
    release: {revision: 'REPLACE', package_sha256: 'REPLACE'},
  };
  if (part === 'measurement')
    return {
      ...base,
      reads: [
        {
          action: 'measurement_audit',
          account_label: 'gtm-test-a',
          account_id: 'REPLACE: the Tag Manager account ID',
          requirements: {container_id: 'REPLACE', workspace_id: 'REPLACE'},
        },
        {
          action: 'measurement_events',
          account_label: 'ga4-test-a',
          account_id: 'REPLACE: the GA4 property ID',
          requirements: {event_names: ['page_view'], minutes: 30},
        },
        {
          action: 'measurement_event_identity',
          account_label: 'ga4-test-a',
          account_id: 'REPLACE: the GA4 property ID',
          requirements: {
            event_name: 'REPLACE',
            test_id: 'amcp-test-REPLACE',
            date_from: 'REPLACE: YYYY-MM-DD',
            date_to: 'REPLACE: YYYY-MM-DD',
          },
        },
        {
          action: 'measurement_conversions',
          account_label: 'linkedin-a',
          account_id: 'REPLACE: the LinkedIn ad account ID',
        },
      ],
    };
  if (part === 'tiktok')
    return {
      ...base,
      account_label: 'tiktok-read-a',
      account_id: 'REPLACE: the TikTok advertiser ID',
      report: {since: 'REPLACE: YYYY-MM-DD', until: 'REPLACE: YYYY-MM-DD, at most 7 days, before today'},
    };
  if (part === 'reddit_value_unit')
    return {
      ...base,
      account_label: 'reddit-read-a',
      account_id: 'REPLACE: the Reddit ad account ID',
      week: {since: 'REPLACE: YYYY-MM-DD', until: 'REPLACE: the 7th day, before today'},
      manual: {
        ui_conversion_value: 'REPLACE: the purchase conversion value Reddit Ads Manager shows for this week',
        currency: 'REPLACE: the account currency, such as USD',
        read_on: 'REPLACE: the day the owner read it, YYYY-MM-DD',
      },
    };
  return {
    ...base,
    account_label: 'x-read-a',
    account_id: 'REPLACE: the X Ads account ID',
    window: {since: 'REPLACE: YYYY-MM-DD', until: 'REPLACE: YYYY-MM-DD, at most 7 days, before today'},
  };
}

/** Every problem with a closed date range of at most `days` days that ends before `today`. */
function range(value, days, name, today, exact = false) {
  if (!plain(value) || Object.keys(value).some(k => !['since', 'until'].includes(k)))
    return [name + ' is {since, until}'];
  const since = dateOf(value.since),
    until = dateOf(value.until);
  if (!Number.isFinite(since) || !Number.isFinite(until)) return [name + ' uses real days, YYYY-MM-DD'];
  if (
    new Date(since).toISOString().slice(0, 10) !== value.since ||
    new Date(until).toISOString().slice(0, 10) !== value.until
  )
    return [name + ' uses real days, YYYY-MM-DD'];
  const span = (until - since) / dayMs + 1;
  if (span < 1 || span > days || (exact && span !== days))
    return [name + (exact ? ' is exactly ' + days + ' days' : ' is 1 to ' + days + ' days')];
  if (value.until >= today) return [name + ' is closed: it ends before today (UTC)'];
  return [];
}
const accountId = {
  gtm_native_action: digits,
  ga4_native_action: digits,
  linkedin_native_action: digits,
  tiktok_native_action: digits,
  reddit_native_action: /^[A-Za-z0-9_]{1,64}$/,
  x_ads_native_action: /^[a-z0-9]{1,32}$/,
};
const ownerLabel = (value, name) =>
  typeof value === 'string' && label.test(value) && !/\d{6}/.test(value)
    ? []
    : [name + ' is an owner label such as tiktok-read-a, never an account ID'];

/** Every problem with a plan; an empty list means it can run. `today` (UTC, YYYY-MM-DD) bounds the closed ranges. */
export function validateReadPlan(plan, today = new Date().toISOString().slice(0, 10)) {
  if (!plain(plan)) return ['the plan is a JSON object'];
  const problems = [],
    part = plan.part;
  if (plan.ticket !== 'ACC-06') problems.push('ticket is ACC-06');
  if (!readParts[part]) return [...problems, 'part is one of ' + Object.keys(readParts).join(', ')];
  for (const key of Object.keys(plan))
    if (![...['ticket', 'part', 'authorization_ref', 'account_type', 'release'], ...allowedKeys[part]].includes(key))
      problems.push('unknown field ' + key);
  if (typeof plan.authorization_ref !== 'string' || !reference.test(plan.authorization_ref))
    problems.push("authorization_ref names the owner's written authorization of these reads");
  if (plan.account_type !== undefined && !['real', 'test'].includes(plan.account_type))
    problems.push('account_type is real or test');
  if (
    !plain(plan.release) ||
    !/^[0-9a-f]{7,40}$/.test(String(plan.release.revision)) ||
    !hex64.test(String(plan.release.package_sha256))
  )
    problems.push('release is the /versionz revision and package_sha256 the run is recorded against');
  if (part === 'measurement') {
    const reads = plan.reads;
    if (!Array.isArray(reads) || !reads.length || reads.length > 4)
      return [...problems, 'reads lists 1 to 4 measurement reads'];
    const seen = new Set();
    for (const [index, read] of reads.entries()) {
      const at = message => problems.push('reads[' + index + ']: ' + message),
        spec = measurementReads[read?.action];
      if (!plain(read) || !spec) {
        at('action is one of ' + Object.keys(measurementReads).join(', '));
        continue;
      }
      if (seen.has(read.action)) at(read.action + ' is read once per run');
      seen.add(read.action);
      for (const key of Object.keys(read))
        if (!['action', 'account_label', 'account_id', 'requirements'].includes(key)) at('unknown field ' + key);
      ownerLabel(read.account_label, 'account_label').forEach(at);
      if (typeof read.account_id !== 'string' || !accountId[spec.gateway].test(read.account_id))
        at('account_id is the native ' + spec.gateway.replace('_native_action', '') + ' ID');
      const r = read.requirements;
      if (read.action === 'measurement_conversions') {
        if (r !== undefined) at('measurement_conversions takes no requirements');
        continue;
      }
      if (!plain(r)) {
        at('requirements holds the inputs ' + read.action + ' names');
        continue;
      }
      if (read.action === 'measurement_audit') {
        if (Object.keys(r).some(k => !['container_id', 'workspace_id'].includes(k)))
          at('requirements is {container_id, workspace_id}');
        if (!digits.test(String(r.container_id)) || !digits.test(String(r.workspace_id)))
          at('container_id and workspace_id are the native Tag Manager IDs');
      }
      if (read.action === 'measurement_events') {
        if (Object.keys(r).some(k => !['event_names', 'minutes', 'stream_id'].includes(k)))
          at('requirements is {event_names, minutes?, stream_id?}');
        if (
          !Array.isArray(r.event_names) ||
          !r.event_names.length ||
          r.event_names.length > 20 ||
          !r.event_names.every(n => typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(n))
        )
          at('event_names lists 1 to 20 exact GA4 event names');
        if (r.minutes !== undefined && !(Number.isSafeInteger(r.minutes) && r.minutes >= 1 && r.minutes <= 30))
          at('minutes is 1 to 30');
        if (r.stream_id !== undefined && !digits.test(String(r.stream_id))) at('stream_id is a numeric stream ID');
      }
      if (read.action === 'measurement_event_identity') {
        const allowed = ['event_name', 'test_id', 'date_from', 'date_to', 'stream_id', 'expected_count'];
        if (Object.keys(r).some(k => !allowed.includes(k)))
          at('requirements has only the fields the identity read takes');
        if (typeof r.event_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(r.event_name))
          at('event_name is an exact GA4 event name');
        // A synthetic test identifier only: P4 allows the amcp_test_id dimension on properties marked as test properties.
        if (typeof r.test_id !== 'string' || !/^amcp-test-[A-Za-z0-9-]{8,64}$/.test(r.test_id))
          at('test_id is a synthetic amcp-test- identifier');
        range({since: r.date_from, until: r.date_to}, 7, 'date_from to date_to', today).forEach(at);
      }
    }
    return problems;
  }
  ownerLabel(plan.account_label, 'account_label').forEach(m => problems.push(m));
  const gateway = readParts[part].gateways[0];
  if (typeof plan.account_id !== 'string' || !accountId[gateway].test(plan.account_id))
    problems.push('account_id is the native ' + gateway.replace('_native_action', '') + ' account ID');
  if (part === 'tiktok') problems.push(...range(plan.report, 7, 'report', today));
  if (part === 'x_publisher_network') problems.push(...range(plan.window, 7, 'window', today));
  if (part === 'reddit_value_unit') {
    problems.push(...range(plan.week, 7, 'week', today, true));
    const m = plan.manual;
    if (!plain(m) || Object.keys(m).some(k => !['ui_conversion_value', 'currency', 'read_on'].includes(k)))
      problems.push('manual is {ui_conversion_value, currency, read_on}');
    else {
      if (
        typeof m.ui_conversion_value !== 'string' ||
        !/^[0-9]{1,15}(?:\.[0-9]{1,6})?$/.test(m.ui_conversion_value) ||
        !(Number(m.ui_conversion_value) > 0)
      )
        problems.push(
          'manual.ui_conversion_value is the positive value Reddit Ads Manager shows for the week, as a decimal string',
        );
      if (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency))
        problems.push('manual.currency is the account currency');
      if (
        !Number.isFinite(dateOf(m.read_on)) ||
        (plain(plan.week) && m.read_on <= plan.week.until) ||
        m.read_on > today
      )
        problems.push(
          'manual.read_on is the day the owner read Reddit Ads Manager, after the week and not in the future',
        );
    }
  }
  return problems;
}

/** The live switches a run needs; each missing or different one is a refusal, checked before anything is read. */
export function readLiveRefusals(env, planBytes, plan) {
  const refusals = [];
  if (env.AMCP_ACCEPTANCE_LIVE !== 'true') refusals.push('AMCP_ACCEPTANCE_LIVE=true is not set');
  if (!env.AMCP_ACCEPTANCE_AUTHORIZATION || env.AMCP_ACCEPTANCE_AUTHORIZATION !== plan?.authorization_ref)
    refusals.push("AMCP_ACCEPTANCE_AUTHORIZATION does not equal the plan's authorization_ref");
  if (env.AMCP_ACCEPTANCE_PLAN_SHA256 !== sha256(planBytes))
    refusals.push('AMCP_ACCEPTANCE_PLAN_SHA256 does not match the plan file the owner approved');
  if (!env.AMCP_ACCEPTANCE_RUN_ID || !/^[A-Za-z0-9_-]{1,80}$/.test(env.AMCP_ACCEPTANCE_RUN_ID))
    refusals.push('AMCP_ACCEPTANCE_RUN_ID is not a run ID');
  if (!env.AMCP_ACCEPTANCE_CREDENTIALS_JSON) refusals.push('AMCP_ACCEPTANCE_CREDENTIALS_JSON is not set');
  return refusals;
}

/** The gateways and native IDs a plan reads; the IDs stay in the plan and are redacted from every record. */
export function planScope(plan) {
  if (plan.part === 'measurement') {
    const gateways = {};
    for (const read of plan.reads) (gateways[measurementReads[read.action].gateway] ??= new Set()).add(read.account_id);
    const ids = plan.reads.flatMap(r => [
      r.account_id,
      ...Object.values(r.requirements ?? {}).filter(v => typeof v === 'string'),
    ]);
    return {gateways: Object.fromEntries(Object.entries(gateways).map(([g, s]) => [g, [...s]])), ids};
  }
  return {gateways: {[readParts[plan.part].gateways[0]]: [plan.account_id]}, ids: [plan.account_id]};
}

/**
 * The shape of a JSON value: its keys and value types, never its values. Arrays keep the distinct shapes of their first
 * 50 items, so the digest of a response does not change with its row count.
 */
export function responseShape(value, depth = 0) {
  if (depth > 12) return 'deep';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const shapes = [...new Set(value.slice(0, 50).map(v => JSON.stringify(responseShape(v, depth + 1))))].sort();
    return {array: shapes.map(s => JSON.parse(s))};
  }
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(k => [k, responseShape(value[k], depth + 1)]),
    );
  return typeof value;
}
/** A request path with every native ID replaced: the record names the route, never the account. */
export function redactRoute(pathname, ids = []) {
  let route = pathname;
  for (const id of [...ids].filter(v => typeof v === 'string' && v.length >= 2).sort((a, b) => b.length - a.length))
    route = route.split(id).join('{id}');
  return route.replace(/[0-9]{4,}/g, '{id}').slice(0, 200);
}

/**
 * The egress guard every request of a run goes through. It refuses (ACCEPTANCE_ROUTE_REFUSED, before anything is sent)
 * another host, a redirect, a port or user-info, a method other than GET outside the documented read POSTs, a
 * method-override header and any request past the part's ceiling. For each request it keeps the status, the provider's
 * request ID and closed-set code, and the response-shape digest: never the body.
 */
export async function readGuard(fetcher, part, ids = []) {
  const d = await dist(),
    hosts = new Set(readParts[part].hosts),
    limit = readParts[part].limit,
    state = {requests: 0, refused: 0, log: []};
  const refuse = message => {
    state.refused++;
    throw new d.MirrorError('ACCEPTANCE_ROUTE_REFUSED', message, {}, 403);
  };
  const guarded = async (input, init = {}) => {
    const url = new URL(String(input)),
      method = String(init.method ?? 'GET').toUpperCase(),
      headers = new Headers(init.headers);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.has(url.hostname))
      refuse('This acceptance read reaches only ' + [...hosts].join(', ') + '.');
    for (const name of ['x-http-method-override', 'x-http-method', 'x-method-override'])
      if (headers.has(name) && headers.get(name).toUpperCase() !== 'GET')
        refuse('This acceptance read sends no method override.');
    const readPost = method === 'POST' && readPosts.some(r => r.host === url.hostname && r.path.test(url.pathname));
    if (method !== 'GET' && !readPost)
      refuse('This acceptance read sends GET requests and documented read POSTs only.');
    if (state.requests >= limit) refuse('This acceptance read is bounded to ' + limit + ' requests.');
    state.requests++;
    const response = await fetcher(input, {...init, redirect: 'error'});
    let body;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    const gateway = hostGateways[url.hostname],
      envelope = gateway === 'tiktok_native_action' && plain(body) && body.code !== undefined ? body.code : undefined,
      code = !response.ok
        ? d.providerErrorCode(gateway, body)
        : envelope !== undefined && Number(envelope) !== 0
          ? envelope
          : undefined;
    state.log.push({
      method,
      ...(readPost ? {read_post: true} : {}),
      host: url.hostname,
      route: redactRoute(url.pathname, ids),
      status: response.status,
      provider_request_id:
        d.providerRequestId(gateway, response.headers, body) ??
        d.providerReference(response.headers.get('x-transaction-id')) ??
        d.providerReference(response.headers.get('x-tt-logid')) ??
        (plain(body) ? (d.providerReference(body.request_id) ?? null) : null),
      provider_code: code !== undefined && /^[A-Z0-9_]{1,64}$/.test(String(code)) ? String(code) : null,
      shape_sha256: body === undefined ? null : sha256(JSON.stringify(responseShape(body))),
    });
    return response;
  };
  return {fetch: guarded, state};
}

/** What a run's requests for one read show: status codes, request IDs, codes and one digest of their shapes. */
function evidenceOf(log) {
  const unique = list => [...new Set(list.filter(v => v !== null && v !== undefined))];
  return {
    status_codes: unique(log.map(r => r.status)).slice(0, 20),
    provider_request_ids: unique(log.map(r => r.provider_request_id)).slice(0, 20),
    provider_codes: unique(log.map(r => r.provider_code)).slice(0, 20),
    shape_sha256: log.some(r => r.shape_sha256) ? sha256(JSON.stringify(log.map(r => r.shape_sha256))) : null,
  };
}
/** accepted, refused or inconclusive, from AMCP's answer and what the provider returned. */
function outcomeOf(success, errorCode, log, refused) {
  if (refused) return 'inconclusive';
  if (success && log.length && log.every(r => r.status >= 200 && r.status < 300 && !r.provider_code)) return 'accepted';
  if (refusalCodes.has(errorCode) || log.some(r => [401, 403].includes(r.status))) return 'refused';
  return 'inconclusive';
}

/** The dry run: the plan validated and every read it would make, by route and owner label. Nothing is sent. */
export async function dryRunReads(plan, refusals = [], today) {
  const problems = validateReadPlan(plan, today);
  if (problems.length) return {mode: 'dry_run', status: 'invalid_plan', problems, provider_requests: 0};
  const reads = [];
  if (plan.part === 'measurement')
    for (const read of plan.reads) {
      const spec = measurementReads[read.action];
      reads.push({
        id: read.action,
        account_label: read.account_label,
        gateway: spec.gateway,
        ledger_action: [spec.operation, spec.action].filter(Boolean).join('/'),
        requirements: Object.keys(read.requirements ?? {}),
      });
    }
  if (plan.part === 'tiktok') {
    // Compiled against the registry exactly as the live run will, with a transport that cannot send.
    const d = await dist(),
      store = new d.Store(':memory:'),
      service = new d.MirrorService(
        new d.Registry(),
        store,
        new d.NativeTransport(async () => {
          throw Error('The dry run sends nothing.');
        }),
      );
    try {
      for (const r of tiktokReads) {
        const [probe] = d.prepareReadProbes(service, [tiktokProbe(r, plan)]);
        reads.push({
          id: r.id,
          account_label: plan.account_label,
          gateway: 'tiktok_native_action',
          ledger_action: r.action,
          method: probe.plan.method,
          route: probe.plan.path,
        });
      }
    } finally {
      store.close();
    }
  }
  if (plan.part === 'reddit_value_unit')
    reads.push(
      {id: 'account', method: 'GET', route: '/api/v3/ad_accounts/{id}'},
      {
        id: 'report',
        method: 'POST',
        route: '/api/v3/ad_accounts/{id}/reports',
        ledger_action: 'reddit_reporting_ops/GET_INSIGHTS',
      },
      {id: 'campaigns', method: 'GET', route: '/api/v3/ad_accounts/{id}/campaigns'},
    );
  if (plan.part === 'x_publisher_network')
    reads.push(
      {
        id: 'active_entities',
        method: 'GET',
        route: '/12/stats/accounts/{id}/active_entities',
        ledger_action: 'x_stats_accounts_account_id_active_entities_get',
      },
      {
        id: 'publisher_network',
        method: 'GET',
        route: '/12/stats/accounts/{id}',
        query: 'placement=PUBLISHER_NETWORK, granularity=TOTAL, up to 20 active campaigns',
        ledger_action: 'x_stats_accounts_account_id_get',
      },
    );
  return {
    mode: 'dry_run',
    status: 'valid',
    ticket: 'ACC-06',
    part: plan.part,
    provider_requests: 0,
    reads,
    guard: [
      'only ' + readParts[plan.part].hosts.join(', '),
      'GET requests and the documented read POSTs only; no method override, no redirect',
      'at most ' + readParts[plan.part].limit + ' requests',
      'an in-memory login holding only the plan’s accounts, with read permissions; nothing is saved',
    ],
    live_refusals: refusals,
    ready_for_live: refusals.length === 0,
  };
}
const tiktokProbe = (r, plan) => ({
  gateway: 'tiktok_native_action',
  arguments: {
    action: r.action,
    account_id: plan.account_id,
    connection_id: acceptanceConnections.tiktok_native_action,
    params: r.params(plan.account_id, plan),
  },
});

/**
 * The live run of one part. It returns the record: accepted, refused or inconclusive per read, the part's result
 * (Reddit's value ratio, X's publisher-network answer) and the acceptance ledger rows, references only.
 */
export async function runReadAcceptance(plan, options) {
  const problems = validateReadPlan(plan, options.today);
  if (problems.length) throw Error('Invalid acceptance plan: ' + problems.join('; '));
  const d = await dist(),
    now = options.now ?? Date.now,
    scope = planScope(plan),
    guard = await readGuard(options.fetcher ?? fetch, plan.part, scope.ids),
    tenantId = 'acceptance-' + options.runId,
    owner = {tenantId, userId: 'acceptance-owner', role: 'admin'},
    reader = {tenantId, userId: 'acceptance-reader', role: 'reader'},
    store = new d.Store(':memory:', randomBytes(32).toString('base64'));
  try {
    for (const [gateway, accounts] of Object.entries(scope.gateways)) {
      if (!plain(options.credentials?.[gateway]))
        throw Error(
          'AMCP_ACCEPTANCE_CREDENTIALS_JSON has no credentials for ' + gateway + '; their values are withheld.',
        );
      store.putConnection(
        owner,
        {
          id: acceptanceConnections[gateway],
          tenantId,
          gateway,
          accounts,
          enabled: true,
          label: 'ACC-06 acceptance read',
          scopes: readScopes[gateway],
          // Reddit requires a descriptive application User-Agent: the same one the website's Reddit logins send.
          ...(gateway === 'reddit_native_action' ? {userAgent: redditUserAgent(options.env ?? process.env)} : {}),
        },
        options.credentials[gateway],
      );
    }
    // A read-only service: it refuses every write before review, beside the guard.
    const service = new d.MirrorService(new d.Registry(), store, new d.NativeTransport(guard.fetch));
    const reads = [],
      record = (entry, from, refusedBefore, success, errorCode) => {
        const log = guard.state.log.slice(from);
        reads.push({
          ...entry,
          outcome: outcomeOf(success, errorCode, log, guard.state.refused - refusedBefore),
          error_code: success ? null : (errorCode ?? null),
          ...evidenceOf(log),
          requests: log,
        });
        return reads.at(-1);
      };
    let result = {};
    if (plan.part === 'measurement')
      for (const read of plan.reads) {
        const spec = measurementReads[read.action],
          from = guard.state.log.length,
          refused = guard.state.refused;
        const out = await service.call(
          'amcp_workspace',
          {
            action: read.action,
            gateway: spec.gateway,
            account_id: read.account_id,
            connection_id: acceptanceConnections[spec.gateway],
            ...(read.requirements ? {requirements: read.requirements} : {}),
          },
          reader,
        );
        // AMCP's own write counters must read zero beside the guard's count.
        const writes = out.success
          ? Number(out.data?.provider_mutations ?? 0) + Number(out.data?.advertising_writes ?? 0)
          : 0;
        const entry = record(
          {
            id: read.action,
            account_label: read.account_label,
            gateway: spec.gateway,
            operation: spec.operation ?? null,
            action: spec.action,
          },
          from,
          refused,
          out.success && writes === 0,
          out.success ? (writes ? 'PROVIDER_MUTATION_REPORTED' : null) : out.error?.code,
        );
        entry.amcp_reported_writes = writes;
      }
    if (plan.part === 'tiktok') {
      const prepared = d.prepareReadProbes(
        service,
        tiktokReads.map(r => tiktokProbe(r, plan)),
      );
      for (const [index, probe] of prepared.entries()) {
        const from = guard.state.log.length,
          refused = guard.state.refused,
          out = await d.verifyReads(service, [probe], reader, true),
          row = out.results[0];
        record(
          {
            id: tiktokReads[index].id,
            account_label: plan.account_label,
            gateway: 'tiktok_native_action',
            operation: null,
            action: tiktokReads[index].action,
          },
          from,
          refused,
          row.success === true,
          row.error?.code,
        );
      }
    }
    if (plan.part === 'reddit_value_unit') result = await redditValueUnit(plan, service, reader, guard, record, d);
    if (plan.part === 'x_publisher_network')
      result = await xPublisherNetworkProbe(plan, service, reader, guard, record, d);
    const checkedAt = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      outcome =
        plan.part === 'reddit_value_unit' || plan.part === 'x_publisher_network'
          ? result.outcome
          : reads.every(r => r.outcome === 'accepted')
            ? 'accepted'
            : reads.some(r => r.outcome === 'refused')
              ? 'refused'
              : 'inconclusive';
    const ledger_rows = ledgerRows(plan, reads, result, checkedAt, options.runId, d);
    const ledgerProblems = d.validateAcceptanceLedger({schema_version: 1, rows: ledger_rows});
    if (ledgerProblems.length) throw Error('The record would not pass the ledger: ' + ledgerProblems.join('; '));
    return {
      record_kind: 'acceptance_read_run',
      schema_version: 1,
      ticket: 'ACC-06',
      part: plan.part,
      authorization_ref: plan.authorization_ref,
      release: plan.release,
      plan_sha256: options.planSha256,
      environment: 'native',
      account_type: plan.account_type ?? 'real',
      checked_at: checkedAt,
      outcome,
      provider_requests: guard.state.requests,
      // Every request that was sent and was neither a GET nor a documented read POST: the guard keeps this at 0.
      provider_mutations: guard.state.log.filter(r => r.method !== 'GET' && !r.read_post).length,
      refused_requests: guard.state.refused,
      reads: reads.map(({requests, ...r}) => ({...r, requests: requests.map(({host, ...q}) => q)})),
      result,
      ledger_rows,
    };
  } finally {
    store.close();
  }
}

/** Reddit: AMCP's own campaign report for the closed week, compared with the value the owner read in Reddit's UI. */
async function redditValueUnit(plan, service, reader, guard, record, d) {
  const from = guard.state.log.length,
    refused = guard.state.refused;
  let report, error;
  try {
    report = await new d.NativeCampaignReports(service).collect(
      {
        platform: 'reddit',
        account_id: plan.account_id,
        connection_id: acceptanceConnections.reddit_native_action,
        native_metrics: ['CONVERSION_PURCHASE_TOTAL_VALUE', 'CONVERSION_PURCHASE_TOTAL_ITEMS'],
      },
      plan.week,
      reader,
    );
  } catch (e) {
    error = e;
  }
  const read = record(
    {
      id: 'report',
      account_label: plan.account_label,
      gateway: 'reddit_native_action',
      operation: 'reddit_reporting_ops',
      action: 'GET_INSIGHTS',
    },
    from,
    refused,
    !!report,
    error?.code ?? (error ? 'REPORT_FAILED' : null),
  );
  if (!report) return {outcome: read.outcome, value_unit: 'not_read'};
  const total = values => {
    const numbers = values.filter(v => typeof v === 'number' && Number.isFinite(v));
    return numbers.length ? numbers.reduce((a, b) => a + b, 0) : null;
  };
  const amcp = total(report.rows.map(r => r.metrics.conversion_value)),
    raw = total(
      report.rows.map(r =>
        d.metricNumber(r.native?.CONVERSION_PURCHASE_TOTAL_VALUE ?? r.native?.conversion_purchase_total_value),
      ),
    ),
    ui = Number(plan.manual.ui_conversion_value),
    tolerance = Math.max(0.01, 0.005 * report.rows.length),
    implied = raw === null ? null : raw / ui,
    power = implied && implied > 0 ? 10 ** Math.round(Math.log10(implied)) : null;
  const within = amcp !== null && Math.abs(amcp - ui) <= tolerance,
    currency = report.currency === plan.manual.currency,
    complete = report.complete === true;
  // Ratios and divisors only: the totals stay in AMCP and in the owner's notes.
  const result = {
    value_unit: within ? 'matches_ui' : 'differs_from_ui',
    ratio: amcp === null ? null : Number((amcp / ui).toFixed(6)),
    current_divisor: d.redditConversionValueDivisor,
    implied_divisor: power !== null && Math.abs(implied / power - 1) <= 0.01 ? power : null,
    within_rounding: within,
    currency_matches: currency,
    report_complete: complete,
    campaigns: report.rows.length,
  };
  return {
    ...result,
    outcome:
      read.outcome === 'accepted' ? (within && currency && complete ? 'accepted' : 'inconclusive') : read.outcome,
  };
}

/** X: the active campaigns of the window, then one stats read with placement=PUBLISHER_NETWORK for up to 20 of them. */
async function xPublisherNetworkProbe(plan, service, reader, guard, record, d) {
  const account = plan.account_id,
    start = d.xAnalyticsTime(dateOf(plan.window.since)),
    end = d.xAnalyticsTime(dateOf(nextDay(plan.window.until)));
  // The same read plan AMCP's X report builds (report-native.ts), so the probe uses AMCP's signing and account scope.
  const readPlan = (pathname, query) => ({
    gateway: 'x_ads_native_action',
    accountId: account,
    action: 'AMCP_CAMPAIGN_REPORT',
    method: 'GET',
    path: pathname,
    query,
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    evidence: 'ACC-06 X publisher-network probe, bounded account scope',
    warnings: [],
  });
  const run = async (id, action, p) => {
    const from = guard.state.log.length,
      refused = guard.state.refused;
    let out, error;
    try {
      out = await service.runPlan(
        p,
        {connection_id: acceptanceConnections.x_ads_native_action, aggregate_pages: false},
        reader,
      );
    } catch (e) {
      error = e;
    }
    const success = out?.success === true && !out.dry_run;
    return {
      read: record(
        {id, account_label: plan.account_label, gateway: 'x_ads_native_action', operation: null, action},
        from,
        refused,
        success,
        error?.code ?? (success ? null : 'UPSTREAM_ERROR'),
      ),
      data: success ? out.data : undefined,
      error,
    };
  };
  const active = await run(
    'active_entities',
    'x_stats_accounts_account_id_active_entities_get',
    readPlan('/12/stats/accounts/' + account + '/active_entities', {
      entity: 'CAMPAIGN',
      start_time: start,
      end_time: end,
    }),
  );
  const entities = Array.isArray(active.data?.data)
    ? active.data.data.filter(e => plain(e) && /^[A-Za-z0-9]{1,32}$/.test(String(e.entity_id)))
    : null;
  if (!entities)
    return {outcome: active.read.outcome === 'refused' ? 'refused' : 'inconclusive', publisher_network: 'not_probed'};
  if (!entities.length)
    return {
      outcome: 'inconclusive',
      publisher_network: 'not_probed',
      reason: 'X reported no active campaign in this window; choose a window with activity.',
    };
  const named = e => [...(Array.isArray(e.placements) ? e.placements : []), e.placement].includes('PUBLISHER_NETWORK');
  const selected = [...entities.filter(named), ...entities.filter(e => !named(e))]
    .slice(0, 20)
    .map(e => String(e.entity_id));
  const probe = await run(
    'publisher_network',
    'x_stats_accounts_account_id_get',
    readPlan('/12/stats/accounts/' + account, {
      entity: 'CAMPAIGN',
      entity_ids: selected.join(','),
      start_time: start,
      end_time: end,
      granularity: 'TOTAL',
      metric_groups: 'ENGAGEMENT,BILLING',
      placement: 'PUBLISHER_NETWORK',
    }),
  );
  const listed = entities.filter(named).length;
  if (Array.isArray(probe.data?.data)) {
    const nonzero = value =>
      Array.isArray(value)
        ? value.some(nonzero)
        : plain(value)
          ? Object.values(value).some(nonzero)
          : typeof value === 'number'
            ? value !== 0
            : typeof value === 'string' && /^-?[0-9.]+$/.test(value) && Number(value) !== 0;
    return {
      outcome: 'accepted',
      publisher_network: 'data_returned',
      nonzero_activity: probe.data.data.some(row => nonzero(row?.id_data)),
      campaigns_probed: selected.length,
      campaigns_listing_publisher_network: listed,
      branch:
        'include_placement: add PUBLISHER_NETWORK to xReportPlacements, coordinated with the RPT-03 request budget',
    };
  }
  const status = probe.read.status_codes.find(s => s >= 400) ?? null;
  if (status && status >= 400 && status < 500 && status !== 401 && status !== 403)
    return {
      outcome: 'accepted',
      publisher_network: 'refused_by_x',
      http_status: status,
      provider_codes: probe.read.provider_codes,
      campaigns_probed: selected.length,
      campaigns_listing_publisher_network: listed,
      branch: 'refuse_or_warn: refuse or warn on PUBLISHER_NETWORK line items with a clear message',
    };
  return {
    outcome: probe.read.outcome === 'refused' ? 'refused' : 'inconclusive',
    publisher_network: 'no_answer',
    http_status: status,
  };
}

/** The acceptance ledger rows of a run: one per read that reached its provider, references only. */
function ledgerRows(plan, reads, result, checkedAt, runId, d) {
  const contracts = Object.fromEntries(
    d.providerContracts.map(c => [c.gateway, d.effectiveProviderContract(String(c.id))]),
  );
  return (
    reads
      .filter(r => r.requests.length)
      // A probe X refused for its placement says nothing about the route AMCP uses: it is in the result, not the ledger.
      .filter(r => !(r.id === 'publisher_network' && result.publisher_network !== 'data_returned'))
      .map((r, index) => {
        const outcome =
          r.id === 'report' && plan.part === 'reddit_value_unit' && r.outcome === 'accepted'
            ? result.outcome
            : r.outcome;
        const contract = contracts[r.gateway];
        return {
          id: ('acc-06-' + runId + '-' + (index + 1)).toLowerCase().slice(0, 80),
          ticket: 'ACC-06',
          gateway: r.gateway,
          ...(r.operation ? {operation: r.operation} : {}),
          action: r.action,
          effect: 'read',
          contract_digest: String(contract.contract_digest),
          api_version: String(contract.api_version),
          account_type: plan.account_type ?? 'real',
          environment: 'native',
          scope: {account_label: r.account_label, accounts: 1},
          checked_at: checkedAt,
          release: plan.release,
          authorization_ref: plan.authorization_ref,
          evidence: {
            ...(r.status_codes.length ? {status_codes: r.status_codes} : {}),
            ...(r.provider_request_ids.length ? {provider_request_ids: r.provider_request_ids} : {}),
            ...(r.provider_codes.length ? {provider_codes: r.provider_codes} : {}),
            ...(r.shape_sha256 ? {shape_sha256: r.shape_sha256} : {}),
          },
          outcome,
          note:
            plan.part === 'reddit_value_unit'
              ? 'Closed-week Reddit report against Reddit Ads Manager: ratio ' +
                result.ratio +
                ', divisor ' +
                result.current_divisor +
                '.'
              : 'ACC-06 ' + plan.part + ' read ' + r.id + '.',
        };
      })
  );
}

/** Text that must never be in a record: a bearer token, a Google access token, a JWT or a long opaque secret. */
const secretText = text =>
  /bearer\s|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.|access_token|refresh_token|client_secret/i.test(text);
/** Every problem with a run record; an empty list means it may be added to the ledger. */
export async function validateReadRecord(record) {
  const problems = [];
  if (!plain(record) || record.record_kind !== 'acceptance_read_run' || record.ticket !== 'ACC-06')
    return ['the record is an ACC-06 acceptance_read_run record'];
  if (!readParts[record.part]) problems.push('part is an ACC-06 part');
  if (secretText(JSON.stringify(record))) problems.push('the record holds a token-like value; keep references only');
  // Routes, labels and notes never carry a native ID: the harness redacts every run of four or more digits.
  for (const read of record.reads ?? []) {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(String(read.account_label)) || /\d{6}/.test(read.account_label))
      problems.push(read.id + ': account_label is an owner label');
    for (const request of read.requests ?? [])
      if (/[0-9]{4,}/.test(String(request.route))) problems.push(read.id + ': a route holds a native ID');
  }
  if (record.provider_mutations !== 0) problems.push('provider_mutations is 0: an acceptance read changes nothing');
  if (!['accepted', 'refused', 'inconclusive'].includes(record.outcome))
    problems.push('outcome is accepted, refused or inconclusive');
  if (!hex64.test(String(record.plan_sha256))) problems.push('plan_sha256 is the SHA-256 of the approved plan');
  const d = await dist();
  problems.push(...d.validateAcceptanceLedger({schema_version: 1, rows: record.ledger_rows ?? []}));
  for (const row of record.ledger_rows ?? []) if (row.ticket !== 'ACC-06') problems.push(row.id + ': ticket is ACC-06');
  return problems;
}

async function main(argv) {
  const [first, second] = argv;
  if (first === 'template') {
    console.log(JSON.stringify(readTemplate(second), null, 2));
    return;
  }
  if (first === 'check') {
    if (!second) throw Error('Name the run record: node tools/acceptance/read-acceptance.mjs check <record.json>');
    const record = JSON.parse(fs.readFileSync(second, 'utf8')),
      problems = await validateReadRecord(record);
    console.log(
      JSON.stringify(
        {valid: !problems.length, problems, outcome: record.outcome, ledger_rows: record.ledger_rows?.length ?? 0},
        null,
        2,
      ),
    );
    if (problems.length) process.exitCode = 1;
    return;
  }
  const file = argv.find(a => !a.startsWith('--'));
  if (!file || argv.some(a => a.startsWith('--') && a !== '--live'))
    throw Error(
      'Usage: node tools/acceptance/read-acceptance.mjs template <part> | <plan.json> [--live] | check <record.json>',
    );
  const bytes = fs.readFileSync(file),
    plan = JSON.parse(bytes.toString('utf8')),
    refusals = readLiveRefusals(process.env, bytes, plan);
  if (!argv.includes('--live')) {
    console.log(JSON.stringify(await dryRunReads(plan, refusals), null, 2));
    return;
  }
  const problems = validateReadPlan(plan);
  if (problems.length || refusals.length) {
    console.log(JSON.stringify({mode: 'live', status: 'refused', problems, refusals, provider_requests: 0}, null, 2));
    process.exitCode = 1;
    return;
  }
  let credentials;
  try {
    credentials = JSON.parse(process.env.AMCP_ACCEPTANCE_CREDENTIALS_JSON);
  } catch {
    throw Error('AMCP_ACCEPTANCE_CREDENTIALS_JSON is not valid JSON; its value is withheld.');
  }
  const runId = process.env.AMCP_ACCEPTANCE_RUN_ID,
    directory = path.resolve(root, '.runtime/acceptance', runId);
  const record = await runReadAcceptance(plan, {
    credentials,
    runId,
    planSha256: process.env.AMCP_ACCEPTANCE_PLAN_SHA256,
  });
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({...record, record_file: path.join(directory, 'record.json')}, null, 2));
  if (record.outcome !== 'accepted') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.code ? e.code + ': ' + e.message : e.message);
    process.exitCode = 1;
  });
