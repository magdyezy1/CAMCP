// ACC-08: the owner-authorized recheck of the three externally blocked programs, LinkedIn Media Planning (forecast),
// LinkedIn Audience Insights and Display & Video 360 advertiser access. One run makes AMCP's own bounded program_check
// read once per named program (at most three requests each, as program_check allows) on the designated account, on an
// in-memory login, behind a guard that lets through only that program's host and documented read route. The record
// keeps, per program, AMCP's state and code, the HTTP status, the provider's literal codes (LinkedIn's code and
// serviceErrorCode, Google's error status and code), its message with every ID, address and URL replaced, the provider
// and AMCP request IDs, and the resolution AMCP showed: never a token, payload or account ID. ACC-08 closes only when
// forecastReaches, audienceInsights and advertisers.get are all observed under authorization.
// Usage (after `npm run build`; docs/acceptance/PROVIDER-PROGRAMS.md is the runbook):
//   node tools/acceptance/program-recheck.mjs template                a blank plan for the three programs
//   node tools/acceptance/program-recheck.mjs <plan.json>             dry run: validate and list each read; no request
//   node tools/acceptance/program-recheck.mjs <plan.json> --live      the live recheck, only with every flag below
//   node tools/acceptance/program-recheck.mjs check <record.json>     validate a run record before ledger.mjs add
// Live flags, as for every read acceptance (set through a secret-safe mechanism, never on the command line):
//   AMCP_ACCEPTANCE_LIVE=true, AMCP_ACCEPTANCE_AUTHORIZATION=<the plan's authorization_ref>,
//   AMCP_ACCEPTANCE_PLAN_SHA256=<hex of the approved plan file>, AMCP_ACCEPTANCE_RUN_ID=<id>,
//   AMCP_ACCEPTANCE_CREDENTIALS_JSON={"linkedin_native_action": {...}, "dv360_native_action": {...}}
// Without every flag the harness refuses before it reads a credential or sends anything.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readLiveRefusals, redactRoute, responseShape} from './read-acceptance.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
let loaded;
/** The built AMCP modules the harness runs; loaded on first use so `template` works before a build. */
async function dist() {
  if (loaded) return loaded;
  const load = file => import(pathToFileURL(path.join(root, 'dist/src', file)).href);
  const [store, catalog, service, transport, errors, taxonomy, ledger, contracts, programs] = await Promise.all([
    load('store.js'),
    load('catalog.js'),
    load('service.js'),
    load('transport.js'),
    load('errors.js'),
    load('provider-error-taxonomy.js'),
    load('acceptance-ledger.js'),
    load('provider-contracts.js'),
    load('conditional-programs.js'),
  ]);
  loaded = {
    ...store,
    ...catalog,
    ...service,
    ...transport,
    ...errors,
    ...taxonomy,
    ...ledger,
    ...contracts,
    ...programs,
  };
  return loaded;
}

/**
 * The three programs: the host and the one documented read route each may reach, the register approval its recheck
 * updates (src/provider-access.json) and the read its closure requires.
 */
export const recheckPrograms = {
  'program:linkedin_forecast': {
    gateway: 'linkedin_native_action',
    host: 'api.linkedin.com',
    method: 'POST',
    route: '/rest/mediaPlanning',
    path: /^\/rest\/mediaPlanning$/,
    actions: ['forecastReaches', 'forecastImpressions', 'forecastLeads'],
    register: {provider: 'linkedin', approval: 'media_planning_product'},
    closes_with: 'POST /rest/mediaPlanning?action=forecastReaches',
  },
  'program:linkedin_audience_insights': {
    gateway: 'linkedin_native_action',
    host: 'api.linkedin.com',
    method: 'POST',
    route: '/rest/targetingAudienceInsights',
    path: /^\/rest\/targetingAudienceInsights$/,
    actions: ['audienceInsights'],
    register: {provider: 'linkedin', approval: 'audience_insights_product'},
    closes_with: 'POST /rest/targetingAudienceInsights?action=audienceInsights',
  },
  'program:dv360_advertiser': {
    gateway: 'dv360_native_action',
    host: 'displayvideo.googleapis.com',
    method: 'GET',
    route: '/v4/advertisers/{id}',
    path: /^\/v4\/advertisers\/[1-9][0-9]{0,19}$/,
    actions: [],
    register: {provider: 'dv360', approval: 'user_profile'},
    closes_with: 'GET /v4/advertisers/{id} (advertisers.get)',
  },
};
/** The read a plan entry makes: the program's method and route, and the LinkedIn action it names. */
const readOf = entry => {
  const spec = recheckPrograms[entry.workflow_id],
    action = entry.workflow_id === 'program:linkedin_forecast' ? entry.requirements?.forecast : spec.actions[0];
  return spec.method + ' ' + spec.route + (action ? '?action=' + action : '');
};
/** The run's own in-memory logins; nothing is saved after the run. */
export const recheckConnections = {
  linkedin_native_action: '00000000-0000-4000-8000-00000000a801',
  dv360_native_action: '00000000-0000-4000-8000-00000000a802',
};
/** The read permissions each login records (program_check requires the Display & Video 360 scope). */
const recheckScopes = {
  linkedin_native_action: ['r_ads'],
  dv360_native_action: ['https://www.googleapis.com/auth/display-video'],
};
const label = /^[a-z][a-z0-9-]{1,39}$/,
  reference = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/,
  hex64 = /^[0-9a-f]{64}$/,
  digits = /^[1-9][0-9]{0,19}$/;
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const ownerLabel = value => typeof value === 'string' && label.test(value) && !/\d{6}/.test(value);
const linkedinUrn = account => 'urn:li:sponsoredAccount:' + account;
const date = offset => {
  const d = new Date(Date.now() + offset * 86400000);
  return {year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate()};
};

/** A blank plan for the three programs: every value the owner supplies is REPLACE; the requests are examples. */
export function recheckTemplate() {
  const account = 'REPLACE: the LinkedIn ad account ID',
    targeting = {include: {and: [{or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278']}}]}};
  return {
    ticket: 'ACC-08',
    authorization_ref: 'REPLACE: the reference of the owner’s written authorization of these reads',
    account_type: 'real',
    release: {revision: 'REPLACE', package_sha256: 'REPLACE'},
    programs: [
      {
        workflow_id: 'program:linkedin_forecast',
        account_label: 'linkedin-a',
        account_id: account,
        requirements: {
          forecast: 'forecastReaches',
          request: {
            sponsoredAccountUrn: 'REPLACE: urn:li:sponsoredAccount:<the account ID>',
            currencyCode: 'USD',
            objectiveType: 'BRAND_AWARENESS',
            targetBudgetMicros: 300000000,
            targetingCriteria: targeting,
            startDateOn: date(2),
            endDateOn: date(20),
          },
        },
      },
      {
        workflow_id: 'program:linkedin_audience_insights',
        account_label: 'linkedin-a',
        account_id: account,
        requirements: {
          request: {
            requestMetaData: {sponsoredAccountUrn: 'REPLACE: urn:li:sponsoredAccount:<the account ID>'},
            targetingCriteria: targeting,
            groupBy: 'urn:li:adTargetingFacet:jobFunctions',
            maxReturnCount: 5,
          },
        },
      },
      {
        workflow_id: 'program:dv360_advertiser',
        account_label: 'dv360-a',
        account_id: 'REPLACE: the Display & Video 360 advertiser ID',
      },
    ],
  };
}

/** Every problem with a plan; an empty list means it can run. */
export function validateRecheckPlan(plan) {
  if (!plain(plan)) return ['the plan is a JSON object'];
  const problems = [];
  if (plan.ticket !== 'ACC-08') problems.push('ticket is ACC-08');
  for (const key of Object.keys(plan))
    if (!['ticket', 'authorization_ref', 'account_type', 'release', 'programs'].includes(key))
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
  if (!Array.isArray(plan.programs) || !plan.programs.length || plan.programs.length > 3)
    return [...problems, 'programs lists 1 to 3 programs'];
  const seen = new Set();
  for (const [index, entry] of plan.programs.entries()) {
    const at = message => problems.push('programs[' + index + ']: ' + message),
      spec = recheckPrograms[entry?.workflow_id];
    if (!plain(entry) || !spec) {
      at('workflow_id is one of ' + Object.keys(recheckPrograms).join(', '));
      continue;
    }
    if (seen.has(entry.workflow_id)) at(entry.workflow_id + ' is rechecked once per run');
    seen.add(entry.workflow_id);
    for (const key of Object.keys(entry))
      if (!['workflow_id', 'account_label', 'account_id', 'requirements'].includes(key)) at('unknown field ' + key);
    if (!ownerLabel(entry.account_label)) at('account_label is an owner label such as linkedin-a, never an account ID');
    if (typeof entry.account_id !== 'string' || !digits.test(entry.account_id))
      at('account_id is the native numeric account or advertiser ID');
    const r = entry.requirements;
    if (entry.workflow_id === 'program:dv360_advertiser') {
      if (r !== undefined && !(plain(r) && !Object.keys(r).length)) at('the advertiser read takes no requirements');
      continue;
    }
    if (!plain(r) || !plain(r.request)) {
      at('requirements holds the native planning request');
      continue;
    }
    if (entry.workflow_id === 'program:linkedin_forecast') {
      if (Object.keys(r).some(k => !['forecast', 'request'].includes(k))) at('requirements is {forecast, request}');
      if (!spec.actions.includes(r.forecast)) at('forecast is ' + spec.actions.join(', '));
      // The request reads the plan's own account only.
      if (r.request.sponsoredAccountUrn !== linkedinUrn(entry.account_id))
        at('request.sponsoredAccountUrn names the plan account: urn:li:sponsoredAccount:<account_id>');
    } else {
      if (Object.keys(r).some(k => k !== 'request')) at('requirements is {request}');
      if (r.request.requestMetaData?.sponsoredAccountUrn !== linkedinUrn(entry.account_id))
        at('request.requestMetaData.sponsoredAccountUrn names the plan account: urn:li:sponsoredAccount:<account_id>');
    }
  }
  return problems;
}

/**
 * The egress guard of a recheck: only the named programs' hosts and documented read routes, POST only where the
 * program reads by POST, no redirect, port, user-info or method override, and at most three requests per program. It
 * keeps per request the status, the request ID, the provider's literal codes, its redacted message and the shape of the
 * response: never the body.
 */
export async function recheckGuard(fetcher, workflows, ids = []) {
  const d = await dist(),
    specs = workflows.map(w => recheckPrograms[w]),
    limit = 3 * specs.length,
    state = {requests: 0, refused: 0, log: []};
  const refuse = message => {
    state.refused++;
    throw new d.MirrorError('ACCEPTANCE_ROUTE_REFUSED', message, {}, 403);
  };
  const guarded = async (input, init = {}) => {
    const url = new URL(String(input)),
      method = String(init.method ?? 'GET').toUpperCase(),
      headers = new Headers(init.headers);
    if (url.protocol !== 'https:' || url.port || url.username || url.password)
      refuse('This recheck reaches only the programs’ provider hosts over HTTPS.');
    const spec = specs.find(s => s.host === url.hostname && s.path.test(url.pathname));
    if (!spec) refuse('This recheck reaches only ' + specs.map(s => s.closes_with).join(', ') + '.');
    for (const name of ['x-http-method-override', 'x-http-method', 'x-method-override'])
      if (headers.has(name)) refuse('This recheck sends no method override.');
    if (method !== spec.method) refuse('This recheck sends ' + spec.method + ' to this route only.');
    if (spec.actions.length && !spec.actions.includes(url.searchParams.get('action') ?? ''))
      refuse('This recheck calls only ' + spec.actions.join(', ') + ' on this route.');
    if (state.requests >= limit) refuse('This recheck is bounded to ' + limit + ' requests.');
    state.requests++;
    const response = await fetcher(input, {...init, redirect: 'error'});
    let body;
    try {
      body = await response.clone().json();
    } catch {
      body = undefined;
    }
    state.log.push({
      method,
      // LinkedIn's planning reads are POST actions; they change nothing (program_check's native_read contracts).
      ...(method === 'POST' ? {read_post: true} : {}),
      host: url.hostname,
      route:
        redactRoute(url.pathname, ids) +
        (url.searchParams.get('action') ? '?action=' + url.searchParams.get('action') : ''),
      status: response.status,
      provider_request_id: d.providerRequestId(spec.gateway, response.headers, body) ?? null,
      ...(response.ok ? {} : literalRefusal(spec.gateway, body, ids)),
      shape_sha256: body === undefined ? null : sha256(JSON.stringify(responseShape(body))),
    });
    return response;
  };
  return {fetch: guarded, state};
}
const token = v => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(v) ? v : undefined);
const integer = v => (Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined);
/**
 * A provider message with every ID, address, URL and URN value replaced, on one line of at most 300 characters. The
 * literal message is what ACC-08 asks the owner to keep with the provider's code; nothing in it may name an account.
 */
export function redactMessage(value, ids = []) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value;
  for (const id of [...ids].filter(v => typeof v === 'string' && v.length >= 2).sort((a, b) => b.length - a.length))
    text = text.split(id).join('{id}');
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '{url}')
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '{email}')
    .replace(/\b(urn:li:[A-Za-z]+:)[^\s,;)"']+/g, '$1{id}')
    .replace(/[0-9]{4,}/g, '{id}')
    .replace(/[A-Za-z0-9_-]{32,}/g, '{token}')
    .trim()
    .slice(0, 300);
}
/** The literal refusal of a provider: its codes as tokens (LinkedIn code and serviceErrorCode, Google status and code). */
function literalRefusal(gateway, body, ids) {
  const root = plain(body) ? body : {},
    error = plain(root.error) ? root.error : {},
    codes =
      gateway === 'linkedin_native_action'
        ? [token(root.code), integer(root.serviceErrorCode)]
        : [
            token(error.status),
            integer(error.code),
            ...(Array.isArray(error.details) ? error.details.slice(0, 5).map(x => token(x?.reason)) : []),
          ];
  return {
    provider_codes: [...new Set(codes.filter(Boolean))],
    provider_message: redactMessage(gateway === 'linkedin_native_action' ? root.message : error.message, ids),
  };
}

/** accepted (observed), refused (a refusal AMCP classifies as blocked) or inconclusive (anything else). */
const outcomeOf = (out, refused) =>
  refused || !out?.success
    ? 'inconclusive'
    : out.data.state === 'observed'
      ? 'accepted'
      : out.data.state === 'blocked'
        ? 'refused'
        : 'inconclusive';

/** An in-memory store holding only the plan's accounts, one login per gateway, and the read-only service over it. */
async function recheckService(plan, credentials, transportFetch, runId) {
  const d = await dist(),
    tenantId = 'acceptance-' + runId,
    owner = {tenantId, userId: 'acceptance-owner', role: 'admin'},
    reader = {tenantId, userId: 'acceptance-reader', role: 'reader'},
    store = new d.Store(':memory:', randomBytes(32).toString('base64'));
  const accounts = {};
  for (const entry of plan.programs)
    (accounts[recheckPrograms[entry.workflow_id].gateway] ??= new Set()).add(entry.account_id);
  for (const [gateway, set] of Object.entries(accounts)) {
    if (credentials && !plain(credentials[gateway]))
      throw Error(
        'AMCP_ACCEPTANCE_CREDENTIALS_JSON has no credentials for ' + gateway + '; their values are withheld.',
      );
    store.putConnection(
      owner,
      {
        id: recheckConnections[gateway],
        tenantId,
        gateway,
        accounts: [...set],
        enabled: true,
        label: 'ACC-08 program recheck',
        scopes: recheckScopes[gateway],
      },
      credentials?.[gateway] ?? {accessToken: 'dry-run-sends-nothing'},
    );
  }
  const service = new d.MirrorService(new d.Registry(), store, new d.NativeTransport(transportFetch));
  return {store, service, reader};
}
const checkInput = (entry, live) => ({
  action: 'program_check',
  workflow_id: entry.workflow_id,
  connection_id: recheckConnections[recheckPrograms[entry.workflow_id].gateway],
  account_id: entry.account_id,
  ...(entry.requirements ? {requirements: entry.requirements} : {}),
  live,
});

/**
 * The dry run: the plan validated and, per program, AMCP's own local inspection (program_check without live: its
 * blockers and the requirement paths a live check needs) and the one route it would read. Nothing is sent.
 */
export async function dryRunRecheck(plan, refusals = []) {
  const problems = validateRecheckPlan(plan);
  if (problems.length) return {mode: 'dry_run', status: 'invalid_plan', problems, provider_requests: 0};
  const {store, service, reader} = await recheckService(
    plan,
    null,
    async () => {
      throw Error('The dry run sends nothing.');
    },
    'dry-run',
  );
  try {
    const programs = [];
    for (const entry of plan.programs) {
      const spec = recheckPrograms[entry.workflow_id],
        out = await service.call('amcp_workspace', checkInput(entry, false), reader),
        data = out.success ? out.data : {};
      // Each argument path the live check requires must be in the plan.
      const missing = (data.required_inputs ?? [])
        .filter(p => p.startsWith('requirements.'))
        .filter(p => p.split('.').reduce((v, k) => (plain(v) ? v[k] : undefined), entry) === undefined);
      programs.push({
        workflow_id: entry.workflow_id,
        account_label: entry.account_label,
        read: readOf(entry),
        local_state: out.success ? data.state : 'refused',
        blockers: out.success ? (data.blockers ?? []) : [out.error?.code ?? 'REFUSED'],
        missing_requirements: missing,
        register: spec.register,
      });
    }
    const ready = programs.every(
      p => p.local_state === 'unverified' && !p.blockers.length && !p.missing_requirements.length,
    );
    return {
      mode: 'dry_run',
      status: ready ? 'valid' : 'blocked_locally',
      ticket: 'ACC-08',
      provider_requests: 0,
      programs,
      guard: [
        'only ' + [...new Set(plan.programs.map(p => recheckPrograms[p.workflow_id].host))].join(', '),
        'each program’s documented read route only; POST only for the LinkedIn planning reads; no method override, no redirect',
        'at most 3 requests per program',
        'an in-memory login holding only the plan’s accounts, with read permissions; nothing is saved',
      ],
      live_refusals: refusals,
      ready_for_live: ready && refusals.length === 0,
    };
  } finally {
    store.close();
  }
}

/**
 * The live recheck. It returns the record: per program AMCP's answer and the provider's literal refusal, the register
 * values to declare, whether ACC-08 is unblocked, and the acceptance ledger rows, references only.
 */
export async function runRecheck(plan, options) {
  const problems = validateRecheckPlan(plan);
  if (problems.length) throw Error('Invalid recheck plan: ' + problems.join('; '));
  const d = await dist(),
    now = options.now ?? Date.now,
    ids = plan.programs.flatMap(p => [p.account_id, linkedinUrn(p.account_id)]),
    guard = await recheckGuard(
      options.fetcher ?? fetch,
      plan.programs.map(p => p.workflow_id),
      ids,
    );
  const {store, service, reader} = await recheckService(plan, options.credentials ?? {}, guard.fetch, options.runId);
  try {
    const programs = [];
    for (const entry of plan.programs) {
      const spec = recheckPrograms[entry.workflow_id],
        from = guard.state.log.length,
        refused = guard.state.refused,
        out = await service.call('amcp_workspace', checkInput(entry, true), reader),
        log = guard.state.log.slice(from),
        data = out.success ? out.data : {},
        last = log.at(-1);
      programs.push({
        workflow_id: entry.workflow_id,
        account_label: entry.account_label,
        gateway: spec.gateway,
        action: d.conditionalProgram(entry.workflow_id).actions[0],
        closes_with: spec.closes_with,
        ...(entry.requirements?.forecast ? {forecast: entry.requirements.forecast} : {}),
        state: out.success ? data.state : 'refused_locally',
        outcome: outcomeOf(out, guard.state.refused - refused),
        amcp: {
          code: out.success ? (data.native_error?.code ?? null) : (out.error?.code ?? null),
          provider_code: data.native_error?.provider_code ?? null,
          amcp_request_id: data.native_error?.amcp_request_id ?? null,
          documented_refusal: !!data.provider_reported_prerequisite,
          owner_action: data.owner_action ? {kind: data.owner_action.kind, text: data.owner_action.text} : null,
        },
        provider: last
          ? {
              http_status: last.status,
              literal_codes: last.provider_codes ?? [],
              message: last.provider_message ?? null,
              request_id: last.provider_request_id,
            }
          : null,
        requests: log.map(({host, ...q}) => q),
      });
    }
    const checkedAt = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      day = checkedAt.slice(0, 10);
    // ACC-08 closes only when all three exact reads are observed under authorization.
    const closed = Object.keys(recheckPrograms).every(id => {
      const p = programs.find(x => x.workflow_id === id);
      return p?.outcome === 'accepted' && (id !== 'program:linkedin_forecast' || p.forecast === 'forecastReaches');
    });
    const ledger_rows = recheckLedgerRows(plan, programs, checkedAt, options.runId, d);
    const ledgerProblems = d.validateAcceptanceLedger({schema_version: 1, rows: ledger_rows});
    if (ledgerProblems.length) throw Error('The record would not pass the ledger: ' + ledgerProblems.join('; '));
    return {
      record_kind: 'acceptance_program_recheck',
      schema_version: 1,
      ticket: 'ACC-08',
      authorization_ref: plan.authorization_ref,
      release: plan.release,
      plan_sha256: options.planSha256,
      environment: 'native',
      account_type: plan.account_type ?? 'real',
      checked_at: checkedAt,
      status: closed ? 'unblocked' : 'blocked',
      provider_requests: guard.state.requests,
      // Every sent request that was neither a GET nor a documented read POST: the guard keeps this at 0.
      provider_mutations: guard.state.log.filter(r => r.method !== 'GET' && !r.read_post).length,
      refused_requests: guard.state.refused,
      programs,
      // What to declare in src/provider-access.json: the day and the literal answer. The status stays the owner's.
      register: programs.map(p => ({
        provider: recheckPrograms[p.workflow_id].register.provider,
        approval: recheckPrograms[p.workflow_id].register.approval,
        checked_on: day,
        value: registerValue(p),
      })),
      ledger_rows,
    };
  } finally {
    store.close();
  }
}
/** The register value of a recheck: at most 80 characters, codes only (the register refuses IDs and tokens). */
function registerValue(p) {
  if (p.outcome === 'accepted') return 'Observed on recheck';
  const codes = [p.provider?.http_status, ...(p.provider?.literal_codes ?? [])].filter(
    v => v !== undefined && v !== null,
  );
  return ('Recheck refused: ' + (codes.join(' ') || p.amcp.code || 'no provider answer')).slice(0, 80);
}
/** The acceptance ledger rows of a recheck: one per program read that reached its provider, references only. */
function recheckLedgerRows(plan, programs, checkedAt, runId, d) {
  const contracts = Object.fromEntries(
    d.providerContracts.map(c => [c.gateway, d.effectiveProviderContract(String(c.id))]),
  );
  return programs
    .filter(p => p.requests.length)
    .map((p, index) => {
      const contract = contracts[p.gateway],
        unique = list => [...new Set(list.filter(v => v !== null && v !== undefined))].slice(0, 20);
      const status_codes = unique(p.requests.map(r => r.status)),
        provider_request_ids = unique(p.requests.map(r => r.provider_request_id)),
        provider_codes = unique(p.requests.flatMap(r => r.provider_codes ?? [])),
        shapes = p.requests.map(r => r.shape_sha256).filter(Boolean);
      return {
        id: ('acc-08-' + runId + '-' + (index + 1)).toLowerCase().slice(0, 80),
        ticket: 'ACC-08',
        gateway: p.gateway,
        action: p.action,
        effect: 'read',
        contract_digest: String(contract.contract_digest),
        api_version: String(contract.api_version),
        account_type: plan.account_type ?? 'real',
        environment: 'native',
        scope: {account_label: p.account_label, accounts: 1},
        checked_at: checkedAt,
        release: plan.release,
        authorization_ref: plan.authorization_ref,
        evidence: {
          ...(status_codes.length ? {status_codes} : {}),
          ...(provider_request_ids.length ? {provider_request_ids} : {}),
          ...(provider_codes.length ? {provider_codes} : {}),
          ...(shapes.length ? {shape_sha256: sha256(JSON.stringify(shapes))} : {}),
        },
        outcome: p.outcome,
        note: 'ACC-08 recheck of ' + p.workflow_id + '.',
      };
    });
}

/** Text that must never be in a record: a bearer token, a Google access token, a JWT or an OAuth secret name. */
const secretText = text =>
  /bearer\s|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.|access_token|refresh_token|client_secret/i.test(text);
/** Every problem with a recheck record; an empty list means it may be added to the ledger. */
export async function validateRecheckRecord(record) {
  if (!plain(record) || record.record_kind !== 'acceptance_program_recheck' || record.ticket !== 'ACC-08')
    return ['the record is an ACC-08 acceptance_program_recheck record'];
  const problems = [];
  if (secretText(JSON.stringify(record))) problems.push('the record holds a token-like value; keep references only');
  if (!['blocked', 'unblocked'].includes(record.status)) problems.push('status is blocked or unblocked');
  if (record.provider_mutations !== 0) problems.push('provider_mutations is 0: a recheck changes nothing');
  if (!hex64.test(String(record.plan_sha256))) problems.push('plan_sha256 is the SHA-256 of the approved plan');
  for (const p of record.programs ?? []) {
    const name = String(p?.workflow_id);
    if (!recheckPrograms[name]) problems.push(name + ': not one of the three programs');
    if (!ownerLabel(p?.account_label)) problems.push(name + ': account_label is an owner label');
    if (!['accepted', 'refused', 'inconclusive'].includes(p?.outcome))
      problems.push(name + ': outcome is accepted, refused or inconclusive');
    const message = p?.provider?.message;
    if (message !== null && message !== undefined && (typeof message !== 'string' || message.length > 300))
      problems.push(name + ': the provider message is one line of at most 300 characters');
    // Routes and messages never carry a native ID: the harness replaces every run of four or more digits.
    for (const text of [message, ...(p?.requests ?? []).map(r => r.route)])
      if (typeof text === 'string' && /[0-9]{4,}/.test(text))
        problems.push(name + ': a route or message holds a native ID');
    for (const code of p?.provider?.literal_codes ?? [])
      if (typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code))
        problems.push(name + ': a provider code is a token');
  }
  if (record.status === 'unblocked') {
    const accepted = id => (record.programs ?? []).some(p => p.workflow_id === id && p.outcome === 'accepted');
    if (!Object.keys(recheckPrograms).every(accepted))
      problems.push('unblocked needs forecastReaches, audienceInsights and advertisers.get observed in this run');
  }
  for (const entry of record.register ?? []) {
    const value = entry?.value;
    if (typeof value !== 'string' || !value.trim() || value.length > 80 || /\d{6,}|@|[A-Za-z0-9_-]{24,}/.test(value))
      problems.push((entry?.approval ?? 'register') + ': the register value is a short line without IDs or tokens');
  }
  const d = await dist();
  problems.push(...d.validateAcceptanceLedger({schema_version: 1, rows: record.ledger_rows ?? []}));
  for (const row of record.ledger_rows ?? []) if (row.ticket !== 'ACC-08') problems.push(row.id + ': ticket is ACC-08');
  return problems;
}

async function main(argv) {
  const [first, second] = argv;
  if (first === 'template') {
    console.log(JSON.stringify(recheckTemplate(), null, 2));
    return;
  }
  if (first === 'check') {
    if (!second) throw Error('Name the run record: node tools/acceptance/program-recheck.mjs check <record.json>');
    const record = JSON.parse(fs.readFileSync(second, 'utf8')),
      problems = await validateRecheckRecord(record);
    console.log(
      JSON.stringify(
        {valid: !problems.length, problems, status: record.status, ledger_rows: record.ledger_rows?.length ?? 0},
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
      'Usage: node tools/acceptance/program-recheck.mjs template | <plan.json> [--live] | check <record.json>',
    );
  const bytes = fs.readFileSync(file),
    plan = JSON.parse(bytes.toString('utf8')),
    refusals = readLiveRefusals(process.env, bytes, plan);
  if (!argv.includes('--live')) {
    console.log(JSON.stringify(await dryRunRecheck(plan, refusals), null, 2));
    return;
  }
  const problems = validateRecheckPlan(plan);
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
  const record = await runRecheck(plan, {credentials, runId, planSha256: process.env.AMCP_ACCEPTANCE_PLAN_SHA256});
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'record.json'), JSON.stringify(record, null, 2) + '\n');
  // A blocked program is a recorded answer, not a failed run: the record is the evidence ACC-08 asks for.
  console.log(JSON.stringify({...record, record_file: path.join(directory, 'record.json')}, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.code ? e.code + ': ' + e.message : e.message);
    process.exitCode = 1;
  });
