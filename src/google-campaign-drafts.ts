import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';

/**
 * Campaign drafts, Google Ads API v23 (pinned Discovery document: CampaignDraftService MutateCampaignDrafts and
 * PromoteCampaignDraft, CampaignDraftOperation, CampaignDraft, CampaignDraftErrorEnum, Campaign.experiment_type; the
 * "Campaign drafts" guide; checked 2026-09-27). A draft copies a base campaign into a draft campaign that "cannot serve
 * ads", where changes are staged with the usual campaign requests. Promotion applies every change of the draft campaign to
 * the base campaign asynchronously (a long-running operation; the draft status moves from PROMOTING to PROMOTED or
 * PROMOTE_FAILED). Drafts are created, renamed or removed; a name is unique among the drafts of its base campaign, and removed
 * or promoted drafts cannot change status again.
 */
type Kind = 'mutate' | 'promote';
type Context = {campaigns: string[]; drafts: string[]};
type Read = CompiledRequest & {googleDraftState?: Context};
type Send = (p: CompiledRequest) => Promise<TransportResult>;
const legacy: Record<string, string> = {
  CREATE_CAMPAIGN_DRAFT: 'create',
  UPDATE_CAMPAIGN_DRAFT: 'update',
  REMOVE_CAMPAIGN_DRAFT: 'remove',
};
const maxOperations = 10;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_CAMPAIGN_DRAFT', message);
}
function unverified(message: string): never {
  return fail('CAMPAIGN_DRAFT_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleDraftKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'google_ads_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  if (/^\/v\d+\/customers\/\d+\/campaignDrafts:mutate$/.test(p.path)) return 'mutate';
  if (/^\/v\d+\/customers\/\d+\/campaignDrafts\/[^/:]+:promote$/.test(p.path)) return 'promote';
  return;
}
const draftPattern = (p: CompiledRequest) =>
  new RegExp('^customers/' + account(p) + '/campaignDrafts/([1-9][0-9]*)~([1-9][0-9]*)$');
const campaignName = (p: CompiledRequest, id: string) => 'customers/' + account(p) + '/campaigns/' + id;
const operations = (p: CompiledRequest) => (googleJson(p.body).operations ?? []) as JsonObject[];
const promoted = (p: CompiledRequest) =>
  p.path
    .split('/')
    .slice(1)
    .join('/')
    .replace(/^v\d+\//, '')
    .replace(/:promote$/, '');
function draftName(p: CompiledRequest, v: unknown, label: string): string {
  if (typeof v !== 'string' || !draftPattern(p).test(v))
    invalid(label + ' is customers/{customer}/campaignDrafts/{base campaign ID}~{draft ID} of the selected customer.');
  return v as string;
}
function nameValue(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim() || [...v].length > 255 || /[\u0000\n\r]/.test(v))
    invalid(label + ' has 1–255 characters, without surrounding spaces, NUL, line feed or carriage return.');
  return v as string;
}
export function assertGoogleDrafts(p: CompiledRequest): void {
  const kind = googleDraftKind(p);
  if (!kind) return;
  if (p.path.split('/')[3] !== account(p))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('Campaign draft reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (kind === 'promote') {
    draftName(p, promoted(p), 'The promoted draft');
    if (
      b !== undefined &&
      b !== null &&
      (!object(b) ||
        Object.keys(b).some(k => k !== 'validateOnly') ||
        (b.validateOnly !== undefined && b.validateOnly !== false))
    )
      invalid('Promotion takes no body besides validateOnly false.');
    if (p.action in legacy) invalid('Use a promotion action to promote a draft.');
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
  const verb = legacy[p.action],
    seen = new Set<string>(),
    names = new Map<string, Set<string>>();
  (b.operations as unknown[]).forEach((op, i) => {
    const at = 'operations[' + i + ']';
    if (!object(op)) invalid(at + ' is an object.');
    const kinds = ['create', 'update', 'remove'].filter(k => op[k] !== undefined);
    if (kinds.length !== 1 || Object.keys(op).some(k => ![...kinds, 'updateMask'].includes(k)))
      invalid(at + ' is exactly one of create, update (with updateMask) or remove.');
    if (verb && kinds[0] !== verb) invalid(at + ': ' + p.action + ' takes ' + verb + ' operations only.');
    let base: string, name: string | undefined;
    if (op.create !== undefined) {
      const c = op.create;
      if (!object(c) || Object.keys(c).some(k => !['baseCampaign', 'name'].includes(k)))
        invalid(at + '.create is {baseCampaign, name}.');
      if (
        typeof c.baseCampaign !== 'string' ||
        !new RegExp('^customers/' + account(p) + '/campaigns/[1-9][0-9]*$').test(c.baseCampaign)
      )
        invalid(at + '.create.baseCampaign is a campaign resource name of the selected customer.');
      base = c.baseCampaign.split('/').at(-1)!;
      name = nameValue(c.name, at + '.create.name');
      if (op.updateMask !== undefined) invalid(at + ': creation takes no updateMask.');
    } else if (op.update !== undefined) {
      const u = op.update;
      if (!object(u) || Object.keys(u).some(k => !['resourceName', 'name'].includes(k)))
        invalid(at + '.update is {resourceName, name}; only the name of a draft changes.');
      const r = draftName(p, u.resourceName, at + '.update.resourceName');
      if (op.updateMask !== 'name') invalid(at + '.updateMask is name.');
      if (seen.has(r)) invalid('Each draft appears once.');
      seen.add(r);
      base = draftPattern(p).exec(r)![1]!;
      name = nameValue(u.name, at + '.update.name');
    } else {
      const r = draftName(p, op.remove, at + '.remove');
      if (op.updateMask !== undefined) invalid(at + ': removal takes no updateMask.');
      if (seen.has(r)) invalid('Each draft appears once.');
      seen.add(r);
      base = draftPattern(p).exec(r)![1]!;
    }
    if (name !== undefined) {
      const set = names.get(base) ?? new Set<string>();
      if (set.has(name)) invalid('Two operations give drafts of campaign ' + base + ' the same name.');
      set.add(name);
      names.set(base, set);
    }
  });
}
const quote = (v: string[]) => v.map(n => "'" + n + "'").join(', ');
function read(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_CAMPAIGN_DRAFT_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleDraftState: undefined,
  };
}
const customerQuery = 'SELECT customer.id, customer.manager FROM customer LIMIT 1';
function context(p: CompiledRequest): Context {
  const kind = googleDraftKind(p)!,
    campaigns = new Set<string>(),
    drafts = new Set<string>();
  if (kind === 'promote') {
    const r = promoted(p);
    drafts.add(r);
    campaigns.add(draftPattern(p).exec(r)![1]!);
  } else
    for (const op of operations(p)) {
      if (op.create) campaigns.add(String(op.create.baseCampaign).split('/').at(-1)!);
      else {
        const r = String(op.update?.resourceName ?? op.remove);
        drafts.add(r);
        campaigns.add(draftPattern(p).exec(r)![1]!);
      }
    }
  return {campaigns: [...campaigns].sort(), drafts: [...drafts].sort()};
}
export function googleDraftSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, customerQuery), googleDraftState: context(p)}];
}
export function isGoogleDraftRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleDraftState;
}
/** The customer, each base campaign, and every draft of those campaigns; drafts are keyed "d" + base ID + "_" + draft ID. */
const draftKey = (r: string) => 'd' + r.split('/').at(-1)!.replace('~', '_');
export async function readGoogleDrafts(p: CompiledRequest, send: Send): Promise<TransportResult> {
  const c = (p as Read).googleDraftState;
  if (!c) return send(p);
  let requests = 0,
    rows = 0;
  const search = async (query: string): Promise<JsonObject[]> => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 10 || ++requests > 20) unverified('Campaign draft state exceeded its page or request bound.');
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
      if (rows > 2000) unverified('Campaign draft state exceeded 2000 rows.');
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
  const names = c.campaigns.map(id => campaignName(p, id)),
    campaigns: JsonObject = {},
    drafts: JsonObject = {};
  for (const r of await search(
    'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.experiment_type FROM campaign WHERE campaign.resource_name IN (' +
      quote(names) +
      ')',
  )) {
    const v = object(r.campaign) ? r.campaign : {},
      id = String(v.resourceName).split('/').at(-1)!;
    if (!names.includes(String(v.resourceName)) || Object.hasOwn(campaigns, 'c' + id))
      unverified('A campaign was foreign or repeated.');
    campaigns['c' + id] = {
      id,
      name: v.name ?? null,
      status: v.status ?? null,
      channel: v.advertisingChannelType ?? null,
      experimentType: v.experimentType ?? null,
    };
  }
  for (const r of await search(
    'SELECT campaign_draft.resource_name, campaign_draft.draft_id, campaign_draft.base_campaign, campaign_draft.name, campaign_draft.draft_campaign, campaign_draft.status, campaign_draft.has_experiment_running FROM campaign_draft WHERE campaign_draft.base_campaign IN (' +
      quote(names) +
      ')',
  )) {
    const v = object(r.campaignDraft) ? r.campaignDraft : {},
      name = String(v.resourceName),
      m = draftPattern(p).exec(name);
    if (
      !m ||
      !names.includes(String(v.baseCampaign)) ||
      campaignName(p, m[1]!) !== v.baseCampaign ||
      Object.hasOwn(drafts, draftKey(name))
    )
      unverified('A campaign draft row is foreign, malformed or repeated.');
    drafts[draftKey(name)] = {
      resourceName: name,
      baseCampaign: v.baseCampaign,
      name: v.name ?? null,
      status: v.status ?? null,
      draftCampaign: v.draftCampaign ?? null,
      experimentRunning: v.hasExperimentRunning === true,
    };
  }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, campaigns, drafts}};
}
export function validateGoogleDraftState(p: CompiledRequest, r: TransportResult): void {
  const c = (p as Read).googleDraftState,
    d = r.data;
  if (
    !c ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.campaigns) ||
    !object(d.drafts)
  )
    unverified('Complete campaign draft state is missing.');
}
function liveNames(s: JsonObject, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of Object.values(s.drafts as JsonObject)) {
    if (object(d) && d.status !== 'REMOVED' && d.baseCampaign === base && typeof d.name === 'string')
      out.set(d.name, String(d.resourceName));
  }
  return out;
}
export function googleDraftPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = googleDraftKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.campaigns) || !object(s.drafts)) unverified('Complete campaign draft state is missing.');
  const draft = (r: string) => {
    const d = s.drafts[draftKey(r)];
    if (!object(d))
      fail(
        'STATE_TARGET_MISMATCH',
        'Campaign draft ' + r + ' is not a draft of the selected customer.',
        {campaign_draft: r},
        409,
      );
    return d;
  };
  if (kind === 'promote') {
    const r = promoted(p),
      d = draft(r);
    if (d.status !== 'PROPOSED')
      invalid('Campaign draft ' + r + ' is ' + String(d.status) + '; only a proposed draft is promoted.');
    if (d.experimentRunning)
      invalid('An experiment based on draft ' + r + ' is serving; end it before promoting the draft.');
    const base = s.campaigns['c' + draftPattern(p).exec(r)![1]];
    if (!object(base) || base.status === 'REMOVED') invalid('The base campaign of draft ' + r + ' is removed.');
    return;
  }
  for (const op of operations(p)) {
    if (op.create) {
      const id = String(op.create.baseCampaign).split('/').at(-1)!,
        base = s.campaigns['c' + id];
      if (!object(base))
        fail(
          'STATE_TARGET_MISMATCH',
          'Campaign ' + id + ' is not a campaign of the selected customer.',
          {campaign: String(op.create.baseCampaign)},
          409,
        );
      if (base.status === 'REMOVED') invalid('Campaign ' + id + ' is removed.');
      if (base.experimentType !== 'BASE')
        invalid(
          'Campaign ' +
            id +
            ' is a ' +
            String(base.experimentType) +
            ' campaign; drafts start from a normal (BASE) campaign.',
        );
      const clash = liveNames(s, String(op.create.baseCampaign)).get(String(op.create.name));
      if (clash)
        fail(
          'CONFIGURATION_EXISTS',
          'Campaign ' + id + ' already has a draft named "' + String(op.create.name) + '" (' + clash + ').',
          {campaign_draft: clash},
        );
      continue;
    }
    const r = String(op.update?.resourceName ?? op.remove),
      d = draft(r);
    if (['REMOVED', 'PROMOTED', 'PROMOTING', 'PROMOTE_FAILED'].includes(String(d.status)))
      invalid(
        'Campaign draft ' +
          r +
          ' is ' +
          String(d.status) +
          ' and cannot be ' +
          (op.update ? 'renamed' : 'removed') +
          '.',
      );
    if (op.update) {
      if (d.name === op.update.name) invalid('Campaign draft ' + r + ' already has this name.');
      const clash = liveNames(s, String(d.baseCampaign)).get(String(op.update.name));
      if (clash && clash !== r)
        fail(
          'CONFIGURATION_EXISTS',
          'Another draft of this campaign is named "' + String(op.update.name) + '" (' + clash + ').',
          {campaign_draft: clash},
        );
    } else if (d.experimentRunning)
      invalid('An experiment based on draft ' + r + ' is serving; end it before removing the draft.');
  }
}
/** Promotion applies every staged change of the draft campaign to the base campaign, which may be serving. */
export function googleDraftNeedsConfirmation(p: CompiledRequest): boolean {
  return googleDraftKind(p) === 'promote';
}
export function googleDraftImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = googleDraftKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    campaigns = object(s.campaigns) ? s.campaigns : {},
    drafts = object(s.drafts) ? s.drafts : {};
  if (kind === 'promote') {
    const r = promoted(p),
      d = drafts[draftKey(r)],
      base = campaigns['c' + draftPattern(p).exec(r)![1]];
    return {
      provider: 'google',
      scope: 'campaign_draft',
      operation: 'promote',
      draft: object(d) ? d : null,
      base_campaign: object(base) ? base : null,
      may_affect_serving: true,
      irreversible: true,
      effect:
        'Applies every change staged in the draft campaign to the base campaign' +
        (object(base) && base.status === 'ENABLED' ? ', which is enabled and serving' : '') +
        '. Promotion runs asynchronously; the draft becomes PROMOTED, or PROMOTE_FAILED with errors listed by ListCampaignDraftAsyncErrors.',
      verification:
        'Reads the draft again until its status is PROMOTED; while PROMOTING the check stays open, and PROMOTE_FAILED fails it.',
      source: 'https://developers.google.com/google-ads/api/docs/experiments/campaign-drafts',
    };
  }
  const changes = operations(p).map(op =>
    op.create
      ? {operation: 'create', base_campaign: op.create.baseCampaign, name: op.create.name}
      : op.update
        ? {
            operation: 'rename',
            campaign_draft: op.update.resourceName,
            from: object(drafts[draftKey(String(op.update.resourceName))])
              ? drafts[draftKey(String(op.update.resourceName))].name
              : null,
            to: op.update.name,
          }
        : {operation: 'remove', campaign_draft: op.remove},
  );
  return {
    provider: 'google',
    scope: 'campaign_draft',
    operation: 'mutate',
    changes,
    may_affect_serving: false,
    effect:
      'Creates, renames or removes campaign drafts. A draft campaign cannot serve ads; its changes reach the base campaign only through a reviewed promotion.',
    verification:
      'Reads the drafts of each base campaign again: new drafts proposed under their names, renamed drafts, removed drafts.',
    source: 'https://developers.google.com/google-ads/api/docs/experiments/campaign-drafts',
  };
}
export function googleDraftOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = googleDraftKind(p)!,
    d = r.data;
  if (r.status !== 200 || !object(d)) return false;
  if (kind === 'promote') return typeof d.name === 'string' && !!d.name && (d.error === undefined || d.error === null);
  const ops = operations(p);
  if (
    (d.partialFailureError !== undefined && d.partialFailureError !== null) ||
    !Array.isArray(d.results) ||
    d.results.length !== ops.length
  )
    return false;
  return d.results.every((v: unknown, i: number) => {
    const op = ops[i]!;
    if (!object(v) || typeof v.resourceName !== 'string') return false;
    if (op.create) {
      const m = draftPattern(p).exec(v.resourceName);
      return !!m && campaignName(p, m[1]!) === op.create.baseCampaign;
    }
    return v.resourceName === (op.update?.resourceName ?? op.remove);
  });
}
export function googleDraftVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = googleDraftKind(p)!,
    read = googleDraftSnapshots(p)[0]!,
    expected: JsonObject = {};
  if (kind === 'promote') {
    const r = promoted(p);
    expected[draftKey(r)] = {status: 'PROMOTED'};
  } else
    operations(p).forEach((op, i) => {
      const name = String(result.data?.results?.[i]?.resourceName ?? '');
      if (!draftPattern(p).test(name))
        fail('VERIFICATION_UNSUPPORTED', 'The receipt names no campaign draft to verify.');
      expected[draftKey(name)] = op.create
        ? {present: true, name: op.create.name, baseCampaign: op.create.baseCampaign, status: 'PROPOSED'}
        : op.update
          ? {present: true, name: op.update.name}
          : {present: true, status: 'REMOVED'};
    });
  // Created drafts are read through their base campaigns; the reader lists every draft of each base campaign.
  const probe: Read = {
    ...read,
    googleDraftState: {
      campaigns: read.googleDraftState!.campaigns,
      drafts: [...new Set([...read.googleDraftState!.drafts, ...Object.keys(expected)])].sort(),
    },
  };
  return [
    {
      read: probe,
      expected: {drafts: expected},
      id: read.googleDraftState!.campaigns.map(id => campaignName(p, id)).join(','),
    },
  ];
}
export function googleDraftObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const c = (read as Read).googleDraftState,
    drafts = object(data.drafts) ? data.drafts : {},
    out: JsonObject = {};
  for (const key of c?.drafts ?? []) {
    const k = key.startsWith('d') ? key : draftKey(key),
      d = drafts[k];
    out[k] = object(d)
      ? {present: true, name: d.name, baseCampaign: d.baseCampaign, status: d.status}
      : {present: false};
  }
  return {drafts: out};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleDraftFamily: ReviewedFamily = {
  name: 'google_campaign_drafts',
  files: ['src/google-campaign-drafts.ts', ['tests/google-campaign-drafts.test.mjs']],
  kind: googleDraftKind,
  assert: assertGoogleDrafts,
  scope: assertGoogleAdsScope,
  snapshots: googleDraftSnapshots,
  isRead: isGoogleDraftRead,
  reader: readGoogleDrafts,
  validateState: validateGoogleDraftState,
  prerequisites: googleDraftPrerequisites,
  impact: googleDraftImpact,
  outcome: googleDraftOutcome,
  verification: googleDraftVerification,
  observed: googleDraftObserved,
  spendConfirmation: {
    needed: googleDraftNeedsConfirmation,
    message:
      'Promoting a campaign draft applies every change staged in the draft campaign to the base campaign, which may be serving. Review them and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: googleDraftNeedsConfirmation,
};
