import {auditCampaign, type CampaignAuditCheck} from './campaign-audit.js';
import {providerById} from './provider-adapters.js';
import {bad, fingerprint, obj, read, type ToolCall} from './workspace-core.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

/**
 * launch_check (CMP-07): the rule-based post-launch check of a guided Meta or Snapchat recipe launch, which the generic
 * workflow audit cannot serve (it refuses Meta and Snapchat as native-only platforms). It feeds the pure auditCampaign
 * (campaign-audit.ts) from current native reads of the plan's own verified campaign, its ad set or ad squad and the
 * account, plus, when given, a retained campaign × day capture of that campaign (amcp_reporting capture_preset).
 *
 * Every read is a native read through the gateway's scope checks; nothing is saved and nothing is changed. Missing
 * evidence stays unknown: without a report, delivery is unknown; a paused campaign is unknown, never a false alarm;
 * a window without impressions is "none reported", which early data and reporting delay do not turn into a fault.
 * The launches it checks are named by adapter ID; each one's reads go to that adapter's gateway (ARC-01 phase B).
 */
export const launchCheckPlatforms = ['meta', 'snapchat'];
const checks: CampaignAuditCheck[] = ['budget', 'schedule', 'bid_strategy', 'creative_fatigue', 'targeting'];

async function native(call: ToolCall, actor: Actor, gateway: string, input: JsonObject) {
  const out = await call(gateway, input, actor);
  if (!out.success) bad(out.error?.message ?? 'The native read failed.', out.error?.code ?? 'LAUNCH_CHECK_FAILED');
  if (out.data?.truncated) bad('The native read was incomplete.', 'LAUNCH_CHECK_INCOMPLETE');
  return {data: out.data?.data, source: {action: input.action, response_hash: fingerprint(out.data?.data ?? null)}};
}
const verifiedResult = (run: JsonObject, id: string) =>
  run.steps.find((s: JsonObject) => s.id === id && s.status === 'verified')?.result;

/** The retained campaign × day capture of this campaign, as the audit's normalized report. */
function retainedReport(store: Store, actor: Actor, id: string, scope: JsonObject, campaignId: string) {
  const report = read(store, actor, 'decision_report', id);
  store.resolveConnection(actor, report.gateway, report.account_id, report.connection_id);
  if (report.gateway !== scope.gateway || String(report.account_id) !== String(scope.account_id))
    bad('The report is not a capture of this launch’s account.', 'LAUNCH_CHECK_REPORT_MISMATCH', {
      report_id: id,
    });
  const semantics = report.semantics ?? {};
  if (!Array.isArray(report.rows) || report.grain !== 'campaign × day')
    bad('Use a campaign-level daily capture (capture_preset) of this account.', 'LAUNCH_CHECK_REPORT_MISMATCH', {
      report_id: id,
    });
  const rows = report.rows
    .filter((r: JsonObject) => String(r.entity_id) === campaignId)
    .map((r: JsonObject) => ({
      entity_id: campaignId,
      date: r.date ?? null,
      impressions: r.impressions ?? null,
      clicks: r.clicks ?? null,
      spend: r.spend ?? null,
      conversions: r.conversions ?? null,
      conversion_value: r.conversion_value ?? null,
      frequency: r.frequency ?? null,
      currency: semantics.currency ?? null,
    }));
  return {
    complete: semantics.complete === true,
    report: {
      normalized: true,
      level: 'campaign',
      granularity: 'day',
      date_range: {since: semantics.date_from, until: semantics.date_to},
      rows,
    },
  };
}

export async function launchCheck(
  store: Store,
  call: ToolCall,
  readPlan: (id: string, actor: Actor) => Promise<JsonObject>,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  if (typeof input.id !== 'string') bad('Name the completed launch plan: id.');
  // amcp_campaign get: the plan under its own owner, collaborator and account-access checks.
  const got = await readPlan(input.id, actor);
  if (!got.success) bad(got.error?.message ?? 'The plan could not be read.', got.error?.code ?? 'NOT_FOUND');
  const run = got.data,
    platform = run?.recipe?.platform;
  if (!launchCheckPlatforms.includes(platform))
    bad(
      'Launch checks cover guided Meta and Snapchat launches. For a Google campaign use the campaign audit workflow; other launches keep their native reads.',
      'LAUNCH_CHECK_UNSUPPORTED',
      {
        platform: platform ?? null,
        ...(platform === 'google'
          ? {next_call: {tool: 'amcp_native_action', arguments: {operation: 'audit_campaign'}}}
          : {}),
      },
    );
  const write = run.steps.find((s: JsonObject) => s.kind === 'write'),
    gateway = providerById(platform)!.gateway,
    scope = {account_id: String(write.account_id), connection_id: write.connection_id};
  const campaignResult = verifiedResult(run, 'campaign'),
    campaignId = platform === 'meta' ? campaignResult?.data?.id : campaignResult?.data?.campaigns?.[0]?.campaign?.id,
    childResult = verifiedResult(run, platform === 'meta' ? 'adset' : 'squad'),
    childId = platform === 'meta' ? childResult?.data?.id : childResult?.data?.adsquads?.[0]?.adsquad?.id;
  if (typeof campaignId !== 'string' || !campaignId)
    bad('A launch check needs the plan’s campaign to be created and verified first.', 'LAUNCH_CHECK_NOT_READY', {
      state: run.state ?? null,
      next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}},
    });
  const sources: JsonObject[] = [];
  let campaign: JsonObject, child: JsonObject | undefined, account: JsonObject;
  if (platform === 'meta') {
    const c = await native(call, actor, gateway, {
      action: 'meta_campaign_get',
      ...scope,
      path_params: {campaign_id: campaignId},
      query: {fields: 'id,name,status,effective_status,objective,start_time,stop_time,daily_budget,bid_strategy'},
    });
    campaign = c.data;
    sources.push(c.source);
    if (typeof childId === 'string') {
      const a = await native(call, actor, gateway, {
        action: 'meta_ad_set_id_get',
        ...scope,
        path_params: {ad_set_id: childId},
        query: {fields: 'id,campaign_id,status,start_time,end_time,daily_budget,bid_strategy,optimization_goal'},
      });
      child = a.data;
      sources.push(a.source);
    }
    const acct = await native(call, actor, gateway, {
      action: 'meta_ad_account_id_get',
      ...scope,
      path_params: {ad_account_id: scope.account_id},
      query: {fields: 'account_id,currency,timezone_name'},
    });
    account = acct.data;
    sources.push(acct.source);
    if (!obj(campaign) || String(campaign.id) !== campaignId)
      bad('Meta did not return this launch’s campaign.', 'STATE_TARGET_MISMATCH');
    if (child && (!obj(child) || String(child.id) !== childId || String(child.campaign_id) !== campaignId))
      bad('Meta returned an ad set outside this launch’s campaign.', 'STATE_TARGET_MISMATCH');
    if (!obj(account) || (account.account_id !== undefined && String(account.account_id) !== scope.account_id))
      bad('Meta returned another ad account.', 'STATE_TARGET_MISMATCH');
  } else {
    const c = await native(call, actor, gateway, {
      action: 'snapchat_campaign_get',
      ...scope,
      path_params: {campaign_id: campaignId},
    });
    campaign = c.data?.campaigns?.[0]?.campaign;
    sources.push(c.source);
    if (typeof childId === 'string') {
      const a = await native(call, actor, gateway, {
        action: 'snapchat_adsquad_get',
        ...scope,
        path_params: {ad_squad_id: childId},
      });
      child = a.data?.adsquads?.[0]?.adsquad;
      sources.push(a.source);
    }
    const acct = await native(call, actor, gateway, {
      action: 'snapchat_account_get',
      ...scope,
      path_params: {ad_account_id: scope.account_id},
    });
    account = acct.data?.adaccounts?.[0]?.adaccount;
    sources.push(acct.source);
    if (!obj(campaign) || campaign.id !== campaignId || campaign.ad_account_id !== scope.account_id)
      bad('Snapchat did not return this launch’s campaign in this account.', 'STATE_TARGET_MISMATCH');
    if (child && (!obj(child) || child.id !== childId || child.campaign_id !== campaignId))
      bad('Snapchat returned an ad squad outside this launch’s campaign.', 'STATE_TARGET_MISMATCH');
    if (!obj(account) || account.id !== scope.account_id)
      bad('Snapchat returned another ad account.', 'STATE_TARGET_MISMATCH');
  }
  // The audit's one campaign row: each field named with the native read it came from.
  const meta = platform === 'meta',
    budgetSource = child?.daily_budget !== undefined ? child : campaign,
    projection: JsonObject = {
      id: campaignId,
      status: campaign.status ?? null,
      currency: account.currency ?? null,
      daily_budget: meta ? (budgetSource?.daily_budget ?? null) : (child?.daily_budget_micro ?? null),
      start_time: meta ? (child?.start_time ?? campaign.start_time ?? null) : (campaign.start_time ?? null),
      end_time: meta ? (child?.end_time ?? campaign.stop_time ?? null) : (campaign.end_time ?? null),
      bid_strategy: meta ? (child?.bid_strategy ?? campaign.bid_strategy ?? null) : (child?.bid_strategy ?? null),
    },
    fieldSources = {
      status: 'campaign',
      currency: 'account',
      daily_budget: meta ? (budgetSource === child ? 'ad_set' : 'campaign') : 'ad_squad',
      start_time: meta ? (child?.start_time !== undefined ? 'ad_set' : 'campaign') : 'campaign',
      end_time: meta ? (child?.end_time !== undefined ? 'ad_set' : 'campaign') : 'campaign',
      bid_strategy: meta && child?.bid_strategy === undefined ? 'campaign' : meta ? 'ad_set' : 'ad_squad',
    };
  // Meta writes offsets as +0300; the audit reads ISO offsets (+03:00). The instant is unchanged.
  for (const k of ['start_time', 'end_time'])
    if (typeof projection[k] === 'string')
      projection[k] = projection[k].replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2})$/, '$1$2:$3');
  for (const [k, v] of Object.entries(projection)) if (v === null) delete projection[k];
  const retained =
    input.reference_id === undefined
      ? undefined
      : retainedReport(store, actor, String(input.reference_id), {gateway, ...scope}, campaignId);
  const audit = auditCampaign({
    platform,
    account_id: scope.account_id,
    campaign_id: campaignId,
    campaign: projection,
    ...(retained ? {report: retained.report} : {}),
    checks,
    as_of: new Date().toISOString().slice(0, 10),
  });
  const status = String(campaign.status ?? ''),
    paused = /^PAUSED$/i.test(status),
    impressions = (retained?.report.rows ?? []).reduce(
      (n: number, r: JsonObject) => n + (Number.isFinite(Number(r.impressions)) ? Number(r.impressions) : 0),
      0,
    );
  const delivery = paused
    ? {
        status: 'unknown',
        reason: 'campaign_paused',
        meaning: 'The campaign is paused as configured, so no delivery is expected and none is inferred.',
      }
    : !retained
      ? {
          status: 'unknown',
          reason: 'no_report',
          meaning: 'No performance capture was supplied; capture the campaign × day report to see delivery.',
          next_call: {tool: 'amcp_reporting', arguments: {action: 'capture_presets', ...scope}},
        }
      : impressions > 0
        ? {status: 'observed', reason: 'impressions_reported', impressions}
        : {
            status: 'unknown',
            reason: 'none_reported',
            meaning:
              'The capture reports no impressions for this campaign. Early data, reporting delay and review can explain this; it is not proof the campaign cannot serve.',
          };
  return {
    record_kind: 'launch_check',
    plan_id: run.id,
    recipe_id: run.recipe.id,
    platform,
    gateway,
    ...scope,
    campaign_id: campaignId,
    child_id: typeof childId === 'string' ? childId : null,
    campaign: projection,
    field_sources: fieldSources,
    delivery,
    audit,
    report_id: input.reference_id ?? null,
    report_complete: retained ? retained.complete : null,
    sources,
    network_requests: sources.length,
    meaning:
      'Rule checks of the launch as currently configured, from native reads of its own campaign, ad set or ad squad and account. Unknown findings name the evidence that was missing; nothing is saved and nothing is changed.',
  };
}
