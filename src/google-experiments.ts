import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';

/**
 * System-managed experiments, Google Ads API v23 (pinned Discovery document: ExperimentService.MutateExperiments,
 * ExperimentArmService.MutateExperimentArms, Experiment, ExperimentArm, ExperimentOperation, ExperimentArmOperation and the
 * ExperimentError and ExperimentArmError enums; the "System-managed experiments" guide; checked 2026-09-27).
 * - An experiment is created in SETUP with a name that is unique among the customer's experiments, a type, and a suffix
 *   that Google appends to the names of the treatment campaigns. AMCP writes the system-managed types SEARCH_CUSTOM,
 *   DISPLAY_CUSTOM, YOUTUBE_CUSTOM and HOTEL_CUSTOM; sync with the base campaign exists for search and display only.
 * - "All arms must be created in a single request": exactly one control arm naming one existing campaign, and treatment
 *   arms without campaigns, for which Google creates in-design campaigns that do not serve. Traffic splits sum to 100.
 * - Nothing serves until the experiment is scheduled. AMCP changes experiments and their arms only in SETUP; status
 *   changes go through the actions below.
 * - ScheduleExperiment turns the in-design campaigns into experiment campaigns that serve, a long-running operation; the
 *   experiment is INITIATED ("campaigns pending materialization") and then ENABLED. EndExperiment "immediately ends an
 *   experiment", moving its end date to the day of the request. PromoteExperiment applies the treatment changes to the
 *   base campaign, a long-running operation tracked by promote_status. GraduateExperiment turns the experiment campaign
 *   into an ordinary campaign with the one budget mapped to it. Failures of the long-running operations are listed by
 *   ListExperimentAsyncErrors.
 */
type Kind = 'experiments' | 'arms' | 'schedule' | 'end' | 'promote' | 'graduate';
type Context = {experiments: string[]; arms: string[]; campaigns: string[]; budgets?: string[]};
type Read = CompiledRequest & {googleExperimentState?: Context};
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const legacy: Record<string, [Kind, string]> = {
  CREATE_EXPERIMENT: ['experiments', 'create'],
  UPDATE_EXPERIMENT: ['experiments', 'update'],
  REMOVE_EXPERIMENT: ['experiments', 'remove'],
  CREATE_EXPERIMENT_ARM: ['arms', 'create'],
  UPDATE_EXPERIMENT_ARM: ['arms', 'update'],
  REMOVE_EXPERIMENT_ARM: ['arms', 'remove'],
  SCHEDULE_EXPERIMENT: ['schedule', ''],
  END_EXPERIMENT: ['end', ''],
  PROMOTE_EXPERIMENT: ['promote', ''],
  GRADUATE_EXPERIMENT: ['graduate', ''],
};
const lifecycle = ['schedule', 'end', 'promote', 'graduate'];
const promoted = ['COMPLETED', 'COMPLETED_WITH_WARNING'];
/** The campaign channel each system-managed type tests. */
const channels: Record<string, string> = {
  SEARCH_CUSTOM: 'SEARCH',
  DISPLAY_CUSTOM: 'DISPLAY',
  YOUTUBE_CUSTOM: 'VIDEO',
  HOTEL_CUSTOM: 'HOTEL',
};
const syncTypes = ['SEARCH_CUSTOM', 'DISPLAY_CUSTOM'];
const experimentFields = ['name', 'description', 'suffix', 'startDate', 'endDate'],
  armFields = ['name', 'trafficSplit'];
const maxOperations = 10,
  maxArms = 10;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_EXPERIMENT', message);
}
function unverified(message: string): never {
  return fail('EXPERIMENT_STATE_UNVERIFIED', message, {}, 502);
}
function mismatch(message: string, details: JsonObject = {}): never {
  return fail('STATE_TARGET_MISMATCH', message, details, 409);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleExperimentKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'google_ads_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  if (/^\/v\d+\/customers\/\d+\/experiments:mutate$/.test(p.path)) return 'experiments';
  if (/^\/v\d+\/customers\/\d+\/experimentArms:mutate$/.test(p.path)) return 'arms';
  const action = /^\/v\d+\/customers\/\d+\/experiments\/[^/:]+:(schedule|end|promote|graduate)Experiment$/.exec(p.path);
  return action ? (action[1] as Kind) : undefined;
}
/** The experiment a lifecycle action names in its path. */
const target = (p: CompiledRequest) => p.path.slice(5).replace(/:[a-zA-Z]+$/, '');
const experimentPattern = (p: CompiledRequest) =>
  new RegExp('^customers/' + account(p) + '/experiments/([1-9][0-9]*)$');
const armPattern = (p: CompiledRequest) =>
  new RegExp('^customers/' + account(p) + '/experimentArms/([1-9][0-9]*)~([1-9][0-9]*)$');
const campaignPattern = (p: CompiledRequest) => new RegExp('^customers/' + account(p) + '/campaigns/([1-9][0-9]*)$');
const budgetPattern = (p: CompiledRequest) =>
  new RegExp('^customers/' + account(p) + '/campaignBudgets/([1-9][0-9]*)$');
const operations = (p: CompiledRequest) => (googleJson(p.body).operations ?? []) as JsonObject[];
const maskOf = (v: unknown) =>
  typeof v === 'string'
    ? v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
const experimentKey = (r: string) => 'e' + r.split('/').at(-1)!;
const armKey = (r: string) => 'a' + r.split('/').at(-1)!.replace('~', '_');
function named(pattern: RegExp, v: unknown, label: string, what: string): string {
  if (typeof v !== 'string' || !pattern.test(v)) invalid(label + ' is ' + what + ' of the selected customer.');
  return v as string;
}
function text(v: unknown, label: string, max: number): void {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > max || /[\u0000\n\r]/.test(v))
    invalid(label + ' has 1–' + max + ' characters, without surrounding spaces, NUL, line feed or carriage return.');
}
function day(v: unknown, label: string): string {
  const ok =
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    new Date(Date.parse(v + 'T00:00:00Z')).toISOString().slice(0, 10) === v;
  if (!ok) invalid(label + ' is a date, YYYY-MM-DD.');
  return v as string;
}
/** A traffic split is a whole percentage, 1–99; JSON may carry it as a number or, like other int64 fields, a string. */
function split(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 99) invalid(label + ' is a whole percentage from 1 to 99.');
  return n;
}
function oneOf(op: unknown, at: string, verb: string | undefined, action: string): 'create' | 'update' | 'remove' {
  if (!object(op)) invalid(at + ' is an object.');
  const kinds = (['create', 'update', 'remove'] as const).filter(k => op[k] !== undefined);
  if (kinds.length !== 1 || Object.keys(op).some(k => ![...kinds, 'updateMask'].includes(k)))
    invalid(at + ' is exactly one of create, update (with updateMask) or remove.');
  if (verb && kinds[0] !== verb) invalid(at + ': ' + action + ' takes ' + verb + ' operations only.');
  if (kinds[0] !== 'update' && op.updateMask !== undefined) invalid(at + ': only an update takes updateMask.');
  return kinds[0]!;
}
function experimentOps(p: CompiledRequest, ops: JsonObject[], verb: string | undefined): void {
  const seen = new Set<string>(),
    names = new Set<string>();
  ops.forEach((op, i) => {
    const at = 'operations[' + i + ']',
      k = oneOf(op, at, verb, p.action);
    if (k === 'create') {
      const c = op.create;
      if (
        !object(c) ||
        Object.keys(c).some(
          f => !['name', 'type', 'suffix', 'status', 'description', 'startDate', 'endDate', 'syncEnabled'].includes(f),
        )
      )
        invalid(
          at +
            '.create takes name, type, suffix, status, description, startDate, endDate and syncEnabled; goals and output-only fields are not written.',
        );
      text(c.name, at + '.create.name', 1024);
      if (!Object.hasOwn(channels, c.type))
        invalid(at + '.create.type is one of ' + Object.keys(channels).join(', ') + ' (system-managed experiments).');
      text(c.suffix, at + '.create.suffix', 255);
      if (c.status !== 'SETUP')
        invalid(at + '.create.status is SETUP; the experiment starts through a reviewed schedule.');
      if (c.description !== undefined) text(c.description, at + '.create.description', 2048);
      const start = c.startDate === undefined ? undefined : day(c.startDate, at + '.create.startDate'),
        end = c.endDate === undefined ? undefined : day(c.endDate, at + '.create.endDate');
      if (start && end && end < start) invalid(at + ': the end date is before the start date.');
      if (c.syncEnabled !== undefined && typeof c.syncEnabled !== 'boolean')
        invalid(at + '.create.syncEnabled is a boolean.');
      if (c.syncEnabled === true && !syncTypes.includes(c.type))
        invalid(
          at + ': sync with the base campaign is available for ' + syncTypes.join(' and ') + ' experiments only.',
        );
      if (names.has(c.name)) invalid('Two operations use the experiment name "' + c.name + '".');
      names.add(c.name);
      return;
    }
    const r = named(
      experimentPattern(p),
      k === 'update' ? op.update?.resourceName : op.remove,
      at + (k === 'update' ? '.update.resourceName' : '.remove'),
      'customers/{customer}/experiments/{experiment}',
    );
    if (seen.has(r)) invalid('Each experiment appears once.');
    seen.add(r);
    if (k === 'remove') return;
    const u = op.update as JsonObject,
      mask = maskOf(op.updateMask);
    if (!mask.length || mask.some(f => !experimentFields.includes(f)) || new Set(mask).size !== mask.length)
      invalid(
        at +
          '.updateMask lists fields among ' +
          experimentFields.join(', ') +
          '; status changes go through schedule, end, promote and graduate.',
      );
    const extra = Object.keys(u).filter(f => f !== 'resourceName' && !mask.includes(f)),
      absent = mask.filter(f => u[f] === undefined);
    if (extra.length || absent.length)
      invalid(
        at +
          '.update carries exactly the fields in updateMask' +
          (extra.length ? '; not masked: ' + extra.join(', ') : '') +
          (absent.length ? '; missing: ' + absent.join(', ') : '') +
          '.',
      );
    if (mask.includes('name')) {
      text(u.name, at + '.update.name', 1024);
      if (names.has(u.name)) invalid('Two operations use the experiment name "' + u.name + '".');
      names.add(u.name);
    }
    if (mask.includes('description')) text(u.description, at + '.update.description', 2048);
    if (mask.includes('suffix')) text(u.suffix, at + '.update.suffix', 255);
    if (mask.includes('startDate')) day(u.startDate, at + '.update.startDate');
    if (mask.includes('endDate')) day(u.endDate, at + '.update.endDate');
  });
}
function armOps(p: CompiledRequest, ops: JsonObject[], verb: string | undefined): void {
  const kinds = ops.map((op, i) => oneOf(op, 'operations[' + i + ']', verb, p.action));
  if (kinds.includes('create') && kinds.some(k => k !== 'create'))
    invalid('Create the arms of an experiment in one request of creates only: all arms are created together.');
  if (kinds[0] === 'create') {
    let experiment: string | undefined,
      controls = 0,
      sum = 0;
    const names = new Set<string>();
    if (ops.length < 2 || ops.length > maxArms)
      invalid(
        'An experiment has one control arm and 1–' + (maxArms - 1) + ' treatment arms, all created in one request.',
      );
    ops.forEach((op, i) => {
      const at = 'operations[' + i + '].create',
        c = op.create;
      if (
        !object(c) ||
        Object.keys(c).some(f => !['experiment', 'name', 'control', 'trafficSplit', 'campaigns'].includes(f))
      )
        invalid(at + ' takes experiment, name, control, trafficSplit and campaigns.');
      const e = named(
        experimentPattern(p),
        c.experiment,
        at + '.experiment',
        'customers/{customer}/experiments/{experiment}',
      );
      if (experiment && e !== experiment) invalid('Create the arms of one experiment per request.');
      experiment = e;
      text(c.name, at + '.name', 1024);
      if (names.has(c.name)) invalid('Arm names are unique within an experiment.');
      names.add(c.name);
      if (typeof c.control !== 'boolean')
        invalid(at + '.control is true for the control arm and false for a treatment arm.');
      sum += split(c.trafficSplit, at + '.trafficSplit');
      if (c.control) {
        controls++;
        if (!Array.isArray(c.campaigns) || c.campaigns.length !== 1)
          invalid(at + '.campaigns names exactly one campaign, the base campaign of the experiment.');
        named(campaignPattern(p), c.campaigns[0], at + '.campaigns[0]', 'customers/{customer}/campaigns/{campaign}');
      } else if (c.campaigns !== undefined && !(Array.isArray(c.campaigns) && !c.campaigns.length))
        invalid(at + ': a treatment arm names no campaigns; Google creates its in-design campaign.');
    });
    if (controls !== 1) invalid('Exactly one arm is the control arm.');
    if (sum !== 100) invalid('The traffic splits of the arms sum to 100 (here ' + sum + ').');
    return;
  }
  const seen = new Set<string>();
  ops.forEach((op, i) => {
    const at = 'operations[' + i + ']',
      k = kinds[i]!;
    const r = named(
      armPattern(p),
      k === 'update' ? op.update?.resourceName : op.remove,
      at + (k === 'update' ? '.update.resourceName' : '.remove'),
      'customers/{customer}/experimentArms/{trial}~{arm}',
    );
    if (seen.has(r)) invalid('Each arm appears once.');
    seen.add(r);
    if (k === 'remove') return;
    const u = op.update as JsonObject,
      mask = maskOf(op.updateMask);
    if (!mask.length || mask.some(f => !armFields.includes(f)) || new Set(mask).size !== mask.length)
      invalid(
        at +
          '.updateMask lists name and/or trafficSplit; the control flag, campaigns and experiment of an arm do not change.',
      );
    const extra = Object.keys(u).filter(f => f !== 'resourceName' && !mask.includes(f)),
      absent = mask.filter(f => u[f] === undefined);
    if (extra.length || absent.length) invalid(at + '.update carries exactly the fields in updateMask.');
    if (mask.includes('name')) text(u.name, at + '.update.name', 1024);
    if (mask.includes('trafficSplit')) split(u.trafficSplit, at + '.update.trafficSplit');
  });
}
export function assertGoogleExperiments(p: CompiledRequest): void {
  const kind = googleExperimentKind(p);
  if (!kind) return;
  if (p.path.split('/')[3] !== account(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Experiment reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (lifecycle.includes(kind)) {
    named(experimentPattern(p), target(p), 'The experiment', 'customers/{customer}/experiments/{experiment}');
    const verb = legacy[p.action];
    if (verb && verb[0] !== kind) invalid(p.action + ' does not ' + kind + ' experiments.');
    if (b !== undefined && b !== null && !object(b)) invalid('Send an object body.');
    const body = object(b) ? b : {};
    if (body.validateOnly !== undefined && body.validateOnly !== false)
      invalid('validateOnly must be false; inspect the review instead.');
    if (kind !== 'graduate') {
      if (Object.keys(body).some(k => k !== 'validateOnly'))
        invalid('Scheduling, ending and promoting take no body besides validateOnly false.');
      return;
    }
    if (Object.keys(body).some(k => !['campaignBudgetMappings', 'validateOnly'].includes(k)))
      invalid('Graduation takes campaignBudgetMappings only.');
    const m = body.campaignBudgetMappings;
    if (
      !Array.isArray(m) ||
      m.length !== 1 ||
      !object(m[0]) ||
      Object.keys(m[0]).some(k => !['experimentCampaign', 'campaignBudget'].includes(k))
    )
      invalid(
        'campaignBudgetMappings is one {experimentCampaign, campaignBudget}: the experiment campaign that graduates and the new budget it keeps.',
      );
    named(
      campaignPattern(p),
      m[0].experimentCampaign,
      'campaignBudgetMappings[0].experimentCampaign',
      'customers/{customer}/campaigns/{campaign}',
    );
    named(
      budgetPattern(p),
      m[0].campaignBudget,
      'campaignBudgetMappings[0].campaignBudget',
      'customers/{customer}/campaignBudgets/{budget}',
    );
    return;
  }
  if (!object(b) || Object.keys(b).some(k => !['operations', 'partialFailure', 'validateOnly'].includes(k)))
    invalid('Send {operations} only.');
  if (b.partialFailure !== undefined && b.partialFailure !== false)
    invalid('partialFailure must be false: every operation is applied, or none.');
  if (b.validateOnly !== undefined && b.validateOnly !== false)
    invalid('validateOnly must be false; inspect the review instead.');
  if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxOperations)
    invalid('Send 1–' + maxOperations + ' operations.');
  const verb = legacy[p.action];
  if (verb && verb[0] !== kind)
    invalid(p.action + ' does not write ' + (kind === 'arms' ? 'experiment arms' : 'experiments') + '.');
  if (kind === 'experiments') experimentOps(p, b.operations as JsonObject[], verb?.[1]);
  else armOps(p, b.operations as JsonObject[], verb?.[1]);
}

const quote = (v: string[]) => v.map(n => "'" + n + "'").join(', ');
function read(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_GOOGLE_EXPERIMENT_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleExperimentState: undefined,
  };
}
const customerQuery = 'SELECT customer.id, customer.manager, customer.time_zone FROM customer LIMIT 1';
function context(p: CompiledRequest): Context {
  const kind = googleExperimentKind(p)!,
    experiments = new Set<string>(),
    arms = new Set<string>(),
    campaigns = new Set<string>();
  if (lifecycle.includes(kind)) {
    const m = kind === 'graduate' ? googleJson(p.body).campaignBudgetMappings[0] : undefined;
    return {
      experiments: [target(p)],
      arms: [],
      campaigns: m ? [String(m.experimentCampaign)] : [],
      ...(m ? {budgets: [String(m.campaignBudget)]} : {}),
    };
  }
  for (const op of operations(p)) {
    if (kind === 'experiments') {
      if (!op.create) experiments.add(String(op.update?.resourceName ?? op.remove));
      continue;
    }
    if (op.create) {
      experiments.add(String(op.create.experiment));
      if (op.create.control === true) campaigns.add(String(op.create.campaigns[0]));
    } else arms.add(String(op.update?.resourceName ?? op.remove));
  }
  return {experiments: [...experiments].sort(), arms: [...arms].sort(), campaigns: [...campaigns].sort()};
}
export function googleExperimentSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, customerQuery), googleExperimentState: context(p)}];
}
export function isGoogleExperimentRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleExperimentState;
}
const splitOf = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : null;
/**
 * The customer; every experiment that is not removed (names are unique among them); the arms named by the request, to
 * learn their experiments; every arm of each experiment involved; and each control campaign with its budget.
 */
export async function readGoogleExperiments(p: CompiledRequest, send: Send): Promise<TransportResult> {
  const c = (p as Read).googleExperimentState;
  if (!c) return send(p);
  let requests = 0,
    rows = 0;
  const search = async (query: string): Promise<JsonObject[]> => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 10 || ++requests > 30) unverified('Experiment state exceeded its page or request bound.');
      const plan = read(p, query);
      if (token) (plan.body as JsonObject).pageToken = token;
      const r = await send(plan),
        d = r.data;
      if (
        r.status !== 200 ||
        !object(d) ||
        (d.results !== undefined && !Array.isArray(d.results)) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        unverified('Google returned a failed or unrecognized search response.');
      const values = (d.results ?? []) as unknown[];
      rows += values.length;
      if (rows > 2000) unverified('Experiment state exceeded 2000 rows.');
      for (const v of values) {
        if (!object(v)) unverified('A search row is malformed.');
        out.push(v);
      }
      if (!d.nextPageToken) return out;
      if (tokens.has(d.nextPageToken) || !values.length) unverified('Search pagination is repeated or incomplete.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
  };
  const customer = await search(customerQuery),
    row = customer[0]?.customer;
  if (customer.length !== 1 || !object(row) || String(row.id) !== account(p))
    unverified('Verify the selected customer.');
  // The customer's date decides whether an experiment has ended; its time zone comes with the read.
  let today: string | null = null;
  if (typeof row.timeZone === 'string') {
    try {
      today = new Intl.DateTimeFormat('en-CA', {
        timeZone: row.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      unverified('The customer time zone is not recognized.');
    }
  }
  const experiments: JsonObject = {},
    arms: JsonObject = {},
    campaigns: JsonObject = {};
  for (const r of await search(
    "SELECT experiment.resource_name, experiment.experiment_id, experiment.name, experiment.description, experiment.suffix, experiment.type, experiment.status, experiment.start_date, experiment.end_date, experiment.sync_enabled, experiment.promote_status FROM experiment WHERE experiment.status != 'REMOVED'",
  )) {
    const v = object(r.experiment) ? r.experiment : {},
      name = String(v.resourceName);
    if (!experimentPattern(p).test(name) || Object.hasOwn(experiments, experimentKey(name)))
      unverified('An experiment row is foreign, malformed or repeated.');
    experiments[experimentKey(name)] = {
      resourceName: name,
      name: v.name ?? null,
      description: v.description ?? null,
      suffix: v.suffix ?? null,
      type: v.type ?? null,
      status: v.status ?? null,
      startDate: v.startDate ?? null,
      endDate: v.endDate ?? null,
      syncEnabled: v.syncEnabled === true,
      promoteStatus: v.promoteStatus ?? null,
      promoted: promoted.includes(String(v.promoteStatus)),
      ended: today !== null && typeof v.endDate === 'string' && v.endDate <= today,
    };
  }
  const involved = new Set(c.experiments);
  if (c.arms.length)
    for (const r of await search(
      'SELECT experiment_arm.resource_name, experiment_arm.experiment FROM experiment_arm WHERE experiment_arm.resource_name IN (' +
        quote(c.arms) +
        ')',
    )) {
      const v = object(r.experimentArm) ? r.experimentArm : {};
      if (!c.arms.includes(String(v.resourceName)) || !experimentPattern(p).test(String(v.experiment)))
        unverified('An experiment arm row is foreign or malformed.');
      involved.add(String(v.experiment));
    }
  if (involved.size)
    for (const r of await search(
      'SELECT experiment_arm.resource_name, experiment_arm.experiment, experiment_arm.name, experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns, experiment_arm.in_design_campaigns FROM experiment_arm WHERE experiment_arm.experiment IN (' +
        quote([...involved].sort()) +
        ')',
    )) {
      const v = object(r.experimentArm) ? r.experimentArm : {},
        name = String(v.resourceName);
      if (!armPattern(p).test(name) || !involved.has(String(v.experiment)) || Object.hasOwn(arms, armKey(name)))
        unverified('An experiment arm row is foreign, malformed or repeated.');
      arms[armKey(name)] = {
        resourceName: name,
        experiment: v.experiment,
        name: v.name ?? null,
        control: v.control === true,
        trafficSplit: splitOf(v.trafficSplit),
        campaigns: (Array.isArray(v.campaigns) ? v.campaigns.map(String) : []).sort(),
        inDesignCampaigns: (Array.isArray(v.inDesignCampaigns) ? v.inDesignCampaigns.map(String) : []).sort(),
      };
    }
  if (c.campaigns.length)
    for (const r of await search(
      'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.experiment_type, campaign.missing_eu_political_advertising_declaration, campaign.campaign_budget, campaign_budget.explicitly_shared, campaign_budget.period FROM campaign WHERE campaign.resource_name IN (' +
        quote(c.campaigns) +
        ')',
    )) {
      const v = object(r.campaign) ? r.campaign : {},
        b = object(r.campaignBudget) ? r.campaignBudget : {},
        id = String(v.resourceName).split('/').at(-1)!;
      if (!c.campaigns.includes(String(v.resourceName)) || Object.hasOwn(campaigns, 'c' + id))
        unverified('A campaign was foreign or repeated.');
      campaigns['c' + id] = {
        resourceName: v.resourceName,
        name: v.name ?? null,
        status: v.status ?? null,
        channel: v.advertisingChannelType ?? null,
        experimentType: v.experimentType ?? null,
        missingEuPoliticalDeclaration: v.missingEuPoliticalAdvertisingDeclaration === true,
        budgetShared: b.explicitlyShared === true,
        budgetPeriod: b.period ?? null,
        budget: v.campaignBudget ?? null,
      };
    }
  const budgets: JsonObject = {};
  if (c.budgets?.length)
    for (const r of await search(
      'SELECT campaign_budget.resource_name, campaign_budget.status, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.reference_count, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.resource_name IN (' +
        quote(c.budgets) +
        ')',
    )) {
      const v = object(r.campaignBudget) ? r.campaignBudget : {},
        id = String(v.resourceName).split('/').at(-1)!;
      if (!c.budgets.includes(String(v.resourceName)) || Object.hasOwn(budgets, 'b' + id))
        unverified('A campaign budget was foreign or repeated.');
      budgets['b' + id] = {
        resourceName: v.resourceName,
        status: v.status ?? null,
        shared: v.explicitlyShared === true,
        period: v.period ?? null,
        referenceCount: Number(v.referenceCount ?? 0),
        amountMicros: v.amountMicros ?? null,
      };
    }
  return {status: 200, headers: {}, data: {customer: {id: account(p), today}, experiments, arms, campaigns, budgets}};
}
export function validateGoogleExperimentState(p: CompiledRequest, r: TransportResult): void {
  const c = (p as Read).googleExperimentState,
    d = r.data;
  if (
    !c ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.experiments) ||
    !object(d.arms) ||
    !object(d.campaigns)
  )
    unverified('Complete experiment state is missing.');
}
type Arm = {
  resourceName: string;
  experiment: string;
  name: string | null;
  control: boolean;
  trafficSplit: number | null;
  campaigns: string[];
};
/** The arms of one experiment as the request leaves them. */
function finalArms(s: JsonObject, experiment: string, ops: JsonObject[]): Arm[] {
  const out = new Map<string, Arm>();
  for (const a of Object.values(s.arms as JsonObject))
    if (object(a) && a.experiment === experiment) out.set(String(a.resourceName), {...a} as Arm);
  for (const op of ops) {
    const r = String(op.update?.resourceName ?? op.remove ?? '');
    if (!out.has(r)) continue;
    if (op.remove !== undefined) {
      out.delete(r);
      continue;
    }
    const a = out.get(r)!,
      mask = maskOf(op.updateMask);
    if (mask.includes('name')) a.name = op.update.name;
    if (mask.includes('trafficSplit')) a.trafficSplit = splitOf(op.update.trafficSplit);
  }
  return [...out.values()];
}
export function googleExperimentPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = googleExperimentKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.experiments) || !object(s.arms) || !object(s.campaigns))
    unverified('Complete experiment state is missing.');
  const experiment = (r: string) => {
    const e = s.experiments[experimentKey(r)];
    if (!object(e))
      mismatch('Experiment ' + r + ' is not an experiment of the selected customer, or it is removed.', {
        experiment: r,
      });
    return e;
  };
  const setup = (e: JsonObject, what: string) => {
    if (e.status !== 'SETUP')
      invalid(
        'Experiment ' +
          String(e.resourceName) +
          ' is ' +
          String(e.status) +
          '; ' +
          what +
          ' only while it is in SETUP. A scheduled experiment is ended, promoted or graduated instead.',
      );
  };
  if (lifecycle.includes(kind)) {
    const r = target(p),
      e = experiment(r),
      arms = Object.values(s.arms).filter(a => object(a) && a.experiment === r) as JsonObject[];
    if (kind === 'schedule') {
      setup(e, 'it is scheduled');
      const treatments = arms.filter(a => !a.control),
        sum = arms.reduce((t, a) => t + Number(a.trafficSplit ?? 0), 0);
      if (arms.filter(a => a.control).length !== 1 || !treatments.length || sum !== 100)
        invalid(
          'Experiment ' +
            r +
            ' needs one control arm and at least one treatment arm with splits summing to 100 before it is scheduled.',
        );
      if (treatments.some(a => !(a.inDesignCampaigns as string[]).length))
        invalid('A treatment arm of experiment ' + r + ' has no in-design campaign yet.');
      return;
    }
    if (kind === 'end') {
      if (e.status !== 'ENABLED')
        invalid('Experiment ' + r + ' is ' + String(e.status) + '; only a running (ENABLED) experiment is ended.');
      if (e.ended === true) invalid('Experiment ' + r + ' already ended on ' + String(e.endDate) + '.');
      return;
    }
    if (!['ENABLED', 'HALTED'].includes(String(e.status)))
      invalid(
        'Experiment ' +
          r +
          ' is ' +
          String(e.status) +
          '; only a scheduled experiment (ENABLED or HALTED) is ' +
          (kind === 'promote' ? 'promoted' : 'graduated') +
          '.',
      );
    if (['IN_PROGRESS', ...promoted].includes(String(e.promoteStatus)))
      invalid('Experiment ' + r + ' is already being promoted or was promoted (' + String(e.promoteStatus) + ').');
    if (kind === 'promote') return;
    const m = googleJson(p.body).campaignBudgetMappings[0],
      campaign = String(m.experimentCampaign),
      id = campaign.split('/').at(-1)!;
    const trial = arms
      .filter(a => !a.control)
      .flatMap(a => [...(a.campaigns as string[]), ...(a.inDesignCampaigns as string[])]);
    if (!trial.includes(campaign))
      invalid('Campaign ' + id + ' is not the campaign of a treatment arm of experiment ' + r + '.');
    const c = s.campaigns['c' + id];
    if (!object(c)) mismatch('Campaign ' + id + ' is not a campaign of the selected customer.', {campaign});
    if (c.status === 'REMOVED') invalid('Campaign ' + id + ' is removed.');
    const b = (object(s.budgets) ? s.budgets : {})['b' + String(m.campaignBudget).split('/').at(-1)];
    if (!object(b))
      mismatch('Budget ' + String(m.campaignBudget) + ' is not a budget of the selected customer.', {
        campaign_budget: String(m.campaignBudget),
      });
    if (b.status !== 'ENABLED' || b.shared || b.period !== 'DAILY' || b.referenceCount !== 0)
      invalid(
        'The graduated campaign keeps budget ' +
          String(m.campaignBudget) +
          ', which must be an enabled daily budget that is not shared and not yet used by a campaign; create one first.',
      );
    return;
  }
  const ops = operations(p);
  if (kind === 'experiments') {
    const live = new Map<string, string>();
    for (const e of Object.values(s.experiments))
      if (object(e) && typeof e.name === 'string') live.set(e.name, String(e.resourceName));
    for (const op of ops) {
      if (op.create) {
        const clash = live.get(String(op.create.name));
        if (clash)
          fail(
            'CONFIGURATION_EXISTS',
            'An experiment named "' + String(op.create.name) + '" exists (' + clash + '); experiment names are unique.',
            {experiment: clash},
          );
        continue;
      }
      const r = String(op.update?.resourceName ?? op.remove),
        e = experiment(r);
      setup(e, op.remove !== undefined ? 'it can be removed' : 'it can be changed');
      if (op.update) {
        const mask = maskOf(op.updateMask);
        if (mask.every(f => e[f] === op.update[f])) invalid('Experiment ' + r + ' already has these values.');
        if (mask.includes('name')) {
          const clash = live.get(String(op.update.name));
          if (clash && clash !== r)
            fail(
              'CONFIGURATION_EXISTS',
              'Another experiment is named "' + String(op.update.name) + '" (' + clash + ').',
              {experiment: clash},
            );
        }
        const start = mask.includes('startDate') ? op.update.startDate : e.startDate,
          end = mask.includes('endDate') ? op.update.endDate : e.endDate;
        if (typeof start === 'string' && typeof end === 'string' && end < start)
          invalid('Experiment ' + r + ' would end before it starts.');
      }
    }
    return;
  }
  if (ops[0]?.create) {
    const r = String(ops[0].create.experiment),
      e = experiment(r);
    setup(e, 'its arms are created');
    if (Object.values(s.arms).some(a => object(a) && a.experiment === r))
      invalid(
        'Experiment ' + r + ' already has arms; all arms are created in one request. Remove them first to start over.',
      );
    const control = ops.find(op => op.create.control === true)!.create,
      id = String(control.campaigns[0]).split('/').at(-1)!,
      base = s.campaigns['c' + id];
    if (!object(base))
      mismatch('Campaign ' + id + ' is not a campaign of the selected customer.', {
        campaign: String(control.campaigns[0]),
      });
    if (base.status === 'REMOVED') invalid('Campaign ' + id + ' is removed.');
    if (base.experimentType !== 'BASE')
      invalid(
        'Campaign ' +
          id +
          ' is a ' +
          String(base.experimentType) +
          ' campaign; the control arm uses a normal (BASE) campaign.',
      );
    if (base.channel !== channels[String(e.type)])
      invalid(
        'A ' +
          String(e.type) +
          ' experiment tests a ' +
          channels[String(e.type)] +
          ' campaign; campaign ' +
          id +
          ' is ' +
          String(base.channel) +
          '.',
      );
    if (base.budgetShared || base.budgetPeriod !== 'DAILY')
      invalid(
        'Campaign ' +
          id +
          ' uses a ' +
          (base.budgetShared ? 'shared' : 'custom-period') +
          ' budget; an experiment control campaign needs its own daily budget.',
      );
    if (base.missingEuPoliticalDeclaration)
      invalid(
        'Campaign ' +
          id +
          ' has not declared whether it contains EU political advertising; experiments need that declaration.',
      );
    return;
  }
  const touched = new Map<string, JsonObject>();
  for (const op of ops) {
    const r = String(op.update?.resourceName ?? op.remove),
      a = s.arms[armKey(r)];
    if (!object(a)) mismatch('Experiment arm ' + r + ' is not an arm of the selected customer.', {experiment_arm: r});
    touched.set(String(a.experiment), experiment(String(a.experiment)));
    if (
      op.update &&
      maskOf(op.updateMask).every(f =>
        f === 'trafficSplit' ? a.trafficSplit === splitOf(op.update.trafficSplit) : a[f] === op.update[f],
      )
    )
      invalid('Experiment arm ' + r + ' already has these values.');
  }
  for (const [r, e] of touched) {
    setup(e, 'its arms change');
    const arms = finalArms(s, r, ops);
    if (!arms.length) continue;
    const names = new Set(arms.map(a => a.name)),
      sum = arms.reduce((t, a) => t + (a.trafficSplit ?? 0), 0);
    if (arms.filter(a => a.control).length !== 1 || arms.length < 2 || names.size !== arms.length || sum !== 100)
      invalid(
        'After this request the arms of experiment ' +
          r +
          ' must still be one control arm and at least one treatment arm with distinct names and traffic splits summing to 100 (here ' +
          sum +
          '), or no arms at all.',
      );
  }
}
/** Scheduling, promotion and graduation start or change serving; ending stops experiment campaigns. */
export function googleExperimentNeedsConfirmation(p: CompiledRequest): boolean {
  const kind = googleExperimentKind(p);
  return kind === 'schedule' || kind === 'promote' || kind === 'graduate';
}
const effects: Record<string, string> = {
  schedule:
    'Turns the in-design campaigns into experiment campaigns that take their traffic split of the base campaign from the start date. Scheduling runs asynchronously: the experiment is INITIATED, then ENABLED; failures are listed by ListExperimentAsyncErrors.',
  end: 'Ends the experiment today: its experiment campaigns stop serving and the base campaign takes all traffic again. Nothing is applied to the base campaign.',
  promote:
    'Applies every change of the treatment campaign to the base campaign and stops the experiment campaigns. Promotion runs asynchronously; promote_status becomes COMPLETED, or FAILED with errors listed by ListExperimentAsyncErrors.',
  graduate:
    'Turns the experiment campaign into an ordinary campaign that keeps serving on its own, with the mapped budget.',
};
const checks: Record<string, string> = {
  schedule: 'Reads the experiment again until it is ENABLED.',
  end: 'Reads the experiment again and expects its end date to be today or earlier in the customer time zone.',
  promote: 'Reads the experiment again until promote_status is COMPLETED (or COMPLETED_WITH_WARNING).',
  graduate: 'Reads the experiment again for GRADUATED and the graduated campaign for the mapped budget.',
};
export function googleExperimentImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = googleExperimentKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    experiments = object(s.experiments) ? s.experiments : {},
    arms = object(s.arms) ? s.arms : {};
  if (lifecycle.includes(kind)) {
    const r = target(p),
      e = experiments[experimentKey(r)],
      m = kind === 'graduate' ? googleJson(p.body).campaignBudgetMappings[0] : undefined,
      budgets = object(s.budgets) ? s.budgets : {};
    return {
      provider: 'google',
      scope: 'experiment',
      operation: kind,
      experiment: object(e) ? e : null,
      arms: Object.values(arms).filter(a => object(a) && a.experiment === r),
      ...(m ? {mapping: m, budget: budgets['b' + String(m.campaignBudget).split('/').at(-1)] ?? null} : {}),
      may_affect_serving: true,
      irreversible: kind !== 'end',
      effect: effects[kind],
      verification: checks[kind],
      source: 'https://developers.google.com/google-ads/api/docs/experiments/system-managed',
    };
  }
  const changes = operations(p).map(op => {
    if (op.create)
      return kind === 'experiments'
        ? {operation: 'create', experiment: op.create}
        : {operation: 'create', arm: {...op.create, trafficSplit: splitOf(op.create.trafficSplit)}};
    const r = String(op.update?.resourceName ?? op.remove),
      before = kind === 'experiments' ? experiments[experimentKey(r)] : arms[armKey(r)];
    return op.update
      ? {
          operation: 'update',
          resource: r,
          before: object(before) ? before : null,
          fields: Object.fromEntries(maskOf(op.updateMask).map(f => [f, op.update[f]])),
        }
      : {operation: 'remove', resource: r, before: object(before) ? before : null};
  });
  return {
    provider: 'google',
    scope: kind === 'experiments' ? 'experiment' : 'experiment_arm',
    operation: 'mutate',
    changes,
    may_affect_serving: false,
    effect:
      kind === 'experiments'
        ? 'Creates, edits or removes experiments in SETUP. Nothing serves until an experiment is scheduled, a separate reviewed action.'
        : 'Creates, edits or removes the arms of experiments in SETUP. Treatment arms get in-design campaigns that do not serve; change them with ordinary campaign requests before scheduling.',
    verification:
      'Reads every experiment and the arms of each experiment involved again and compares each field written; removed experiments and arms are gone.',
    source: 'https://developers.google.com/google-ads/api/docs/experiments/system-managed',
  };
}
export function googleExperimentOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = googleExperimentKind(p)!,
    d = r.data;
  if (lifecycle.includes(kind)) {
    if (r.status !== 200) return false;
    // Scheduling and promotion answer with a long-running operation; ending and graduation with an empty body.
    if (kind === 'schedule' || kind === 'promote')
      return object(d) && typeof d.name === 'string' && !!d.name && (d.error === undefined || d.error === null);
    return d == null || (object(d) && !Object.keys(d).length);
  }
  const ops = operations(p);
  if (
    r.status !== 200 ||
    !object(d) ||
    (d.partialFailureError !== undefined && d.partialFailureError !== null) ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  const pattern = kind === 'experiments' ? experimentPattern(p) : armPattern(p);
  return d.results.every((v: unknown, i: number) => {
    const op = ops[i]!;
    return (
      object(v) &&
      typeof v.resourceName === 'string' &&
      pattern.test(v.resourceName) &&
      (op.create !== undefined || v.resourceName === (op.update?.resourceName ?? op.remove))
    );
  });
}
export function googleExperimentVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = googleExperimentKind(p)!;
  if (lifecycle.includes(kind)) {
    const r = target(p),
      state: JsonObject =
        kind === 'schedule'
          ? {status: 'ENABLED'}
          : kind === 'end'
            ? {ended: true}
            : kind === 'promote'
              ? {promoted: true}
              : {status: 'GRADUATED'};
    const expected: JsonObject = {experiments: {[experimentKey(r)]: {present: true, ...state}}};
    if (kind === 'graduate') {
      const m = googleJson(p.body).campaignBudgetMappings[0];
      expected.campaigns = {
        ['c' + String(m.experimentCampaign).split('/').at(-1)]: {present: true, budget: m.campaignBudget},
      };
    }
    const probe: Read = {...read(p, customerQuery), googleExperimentState: context(p)};
    return [{read: probe, expected, id: r}];
  }
  const ops = operations(p),
    expected: JsonObject = {},
    names: string[] = [];
  ops.forEach((op, i) => {
    const name = String(result.data?.results?.[i]?.resourceName ?? '');
    if (!(kind === 'experiments' ? experimentPattern(p) : armPattern(p)).test(name))
      fail(
        'VERIFICATION_UNSUPPORTED',
        'The receipt names no ' + (kind === 'experiments' ? 'experiment' : 'experiment arm') + ' to verify.',
      );
    names.push(name);
    const key = kind === 'experiments' ? experimentKey(name) : armKey(name);
    if (op.remove !== undefined) {
      expected[key] = {present: false};
      return;
    }
    const fields = op.create ? Object.keys(op.create) : maskOf(op.updateMask),
      source = op.create ?? op.update,
      out: JsonObject = {present: true};
    for (const f of fields)
      out[f] =
        f === 'trafficSplit' ? splitOf(source[f]) : f === 'campaigns' ? [...(source[f] as string[])].sort() : source[f];
    expected[key] = out;
  });
  // Experiments are read whole; arms through their experiments, which the reader learns from the arms named here.
  const c = context(p),
    probe: Read = {
      ...read(p, customerQuery),
      googleExperimentState:
        kind === 'experiments'
          ? {...c, experiments: [...new Set([...c.experiments, ...names])].sort()}
          : {...c, arms: [...new Set([...c.arms, ...names])].sort()},
    };
  return [{read: probe, expected: {[kind]: expected}, id: names.join(',')}];
}
/** Every experiment and arm the read names, present with its fields or absent; the comparison checks the expected ones. */
export function googleExperimentObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const c = (read as Read).googleExperimentState,
    experiments = object(data.experiments) ? data.experiments : {},
    arms = object(data.arms) ? data.arms : {},
    campaigns = object(data.campaigns) ? data.campaigns : {};
  const view = (source: JsonObject, keys: string[]) =>
    Object.fromEntries(
      keys.map(k => {
        const v = source[k];
        return [k, object(v) ? {present: true, ...v} : {present: false}];
      }),
    );
  return {
    experiments: view(experiments, (c?.experiments ?? []).map(experimentKey)),
    arms: view(arms, (c?.arms ?? []).map(armKey)),
    campaigns: view(
      campaigns,
      (c?.campaigns ?? []).map(n => 'c' + n.split('/').at(-1)),
    ),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleExperimentFamily: ReviewedFamily = {
  name: 'google_experiments',
  files: [
    'src/google-experiments.ts',
    ['tests/google-experiments.test.mjs', 'tests/google-experiment-lifecycle.test.mjs'],
  ],
  kind: googleExperimentKind,
  assert: assertGoogleExperiments,
  scope: assertGoogleAdsScope,
  snapshots: googleExperimentSnapshots,
  isRead: isGoogleExperimentRead,
  reader: readGoogleExperiments,
  validateState: validateGoogleExperimentState,
  prerequisites: googleExperimentPrerequisites,
  impact: googleExperimentImpact,
  outcome: googleExperimentOutcome,
  verification: googleExperimentVerification,
  observed: googleExperimentObserved,
  spendConfirmation: {
    needed: googleExperimentNeedsConfirmation,
    message:
      'Scheduling, promoting or graduating an experiment starts or changes what its campaigns serve and spend. Review it and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleExperimentNeedsConfirmation,
};
