// The eight user journeys of the QA-04 baseline (R27 journey map), each with success, failure, unavailable-account and
// incomplete-evidence branches. A branch is a scripted person and client: it calls MCP tools and the website API the
// way the journey's surfaces do, follows the next calls AMCP offers, and reports whether the journey's goal was
// reached. The harness records every call; tools/mcp-eval.mjs turns the transcripts into metrics and compares them
// with the committed baseline. Nothing here is a model: these are deterministic regression baselines. Model-in-the-loop
// runs come from external clients (docs/review/MCP-EVALUATION-RECORD-TEMPLATE.md).
import {
  metaConnection,
  otherConnection,
  sheetsConnection,
  evaluationSheet,
  evaluationDestination,
  gtmConnection,
  offeredNextCall,
} from './harness.mjs';
import {sheetsGateway} from '../../dist/src/google-sheets.js';

export const branchNames = Object.freeze(['success', 'failure', 'unavailable_account', 'incomplete_evidence']);

const pausedCampaign = (account = '123', connection = metaConnection) => ({
  id: 'campaign',
  kind: 'write',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  description: 'Create the paused traffic campaign',
  arguments: {
    action: 'meta_campaign_create',
    payload: {
      name: 'Evaluation campaign',
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  },
});
const createPlan = (f, name, step = pausedCampaign()) =>
  f.call('amcp_campaign', {
    action: 'create',
    name,
    brief: 'A paused traffic campaign for the journey evaluation.',
    steps: [step],
  });
const readiness = (account, live = true, connection = metaConnection) => ({
  action: 'check',
  gateway: 'meta_native_action',
  connection_id: connection,
  account_id: account,
  live,
});
const capture = (account = '123', complete = true) => ({
  action: 'capture_preset',
  preset: 'meta_ad',
  account_id: account,
  connection_id: metaConnection,
  result_action_type: 'offsite_conversion.fb_pixel_purchase',
  attribution_windows: ['7d_click'],
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-01',
    source_name: 'Evaluation evidence',
    complete,
  },
});
const consentRequirements = (tags = ['001', '002']) => ({
  container_id: '55',
  workspace_id: '66',
  tag_ids: tags,
  required_types: ['ad_storage'],
});
const consentPreview = (account = '44', tags) => ({
  action: 'preview_consent_plan',
  gateway: 'gtm_native_action',
  connection_id: gtmConnection,
  account_id: account,
  requirements: consentRequirements(tags),
});

/**
 * Follows the next calls AMCP offers, as a client that trusts its guidance would. A call that executes or confirms
 * waits for the person's approval first. Stops when no next call is offered, when `stop` says the goal is reached, or
 * after `limit` calls.
 */
export async function follow(f, response, {limit = 6, stop = () => false} = {}) {
  let current = response;
  for (let index = 0; index < limit && !stop(current); index++) {
    const next = offeredNextCall(current);
    if (!next) break;
    if (next.arguments.confirmed === true || /^execute/.test(String(next.arguments.action ?? ''))) f.approve();
    current = await f.call(next.tool, next.arguments, {followed: true});
  }
  return current;
}

/**
 * Opens a website handoff the way the person following the link would, through the page's own API call, and checks
 * that the object it names is the one the client was working on.
 */
export async function openHandoff(f, path, expectedId) {
  if (typeof path !== 'string') return false;
  const url = new URL(path, 'http://handoff.invalid');
  const id = url.searchParams.get('id') ?? url.searchParams.get('report_id') ?? url.searchParams.get('asset_id');
  if (expectedId !== undefined && id !== expectedId) return false;
  let opened;
  if (url.pathname === '/campaigns') opened = await f.web.call('campaign', {action: 'get', id});
  else if (url.pathname === '/reports') opened = await f.web.call('reporting', {action: 'get', id});
  else if (url.pathname === '/reporting-overview') opened = await f.web.call('overview', {action: 'get', id});
  else if (url.pathname === '/media') opened = await f.web.call('media', {action: 'asset', asset_id: id});
  else if (url.pathname === '/operations') return (await f.web.call('workspace', {action: 'operations'})).success;
  else return false;
  return opened.success === true && [opened.data?.id, opened.data?.report_id, opened.data?.asset_id].includes(id);
}

const lastPath = f => f.transcript.findLast(entry => entry.website_path)?.website_path;

/** Seeds a verified plan that put asset-1 into ad 30, and returns the asset and plan identifiers (J3). */
function seedLinkedAsset(f, {account = '123', linked = true} = {}) {
  const scope = {gateway: 'meta_native_action', connection_id: metaConnection, account_id: account};
  f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-1', {
    ...scope,
    platform: 'meta',
    review_id: 'asset-1',
    name: 'Launch image',
    media_id: 'hash-1',
    sha256: 'a'.repeat(64),
  });
  f.store.putDocument(f.actor.tenantId, 'campaign_run', 'linked-plan', {
    user_id: f.actor.userId,
    name: 'Verified launch plan',
    steps: [
      ...(linked
        ? [
            {
              ...scope,
              id: 'image',
              kind: 'media',
              arguments: {platform: 'meta'},
              status: 'verified',
              review_id: 'asset-1',
              result: {media_id: 'hash-1'},
            },
          ]
        : []),
      {
        ...scope,
        id: 'creative',
        kind: 'write',
        arguments: {
          action: 'meta_creative_create',
          payload: linked ? {image_hash: {$ref: 'image#/image_hash'}} : {image_hash: 'other-hash'},
        },
        status: 'verified',
        result: {created_id: '20'},
      },
      {
        ...scope,
        id: 'ad',
        kind: 'write',
        arguments: {action: 'meta_ad_create', payload: {creative_id: {$ref: 'creative#/data/id'}}},
        status: 'verified',
        result: {created_id: '30'},
      },
    ],
  });
  return {asset: 'asset-1', plan: 'linked-plan'};
}

/** Prepare, approve and execute the next step of a plan, as the person reviewing it on any surface would (J2, J7). */
async function reviewAndExecute(f, id, {beforeExecute} = {}) {
  const prepared = await f.call('amcp_campaign', {action: 'prepare_next', id});
  if (!prepared.success) return prepared;
  await beforeExecute?.();
  return follow(f, prepared, {limit: 1});
}
const verified = (response, id) =>
  response?.success === true && response.data?.id === id && response.data.state === 'complete';

export const journeys = Object.freeze([
  {
    id: 'J1',
    title: 'first visit → sign in → connect → select → readiness',
    surfaces: ['web'],
    note: 'The OAuth round trip and asset sync are outside the synthetic fixture: the connection is seeded and connect/select count as person actions.',
    branches: {
      async success(f) {
        f.userAction(); // sign in
        await f.web.get('/api/session');
        f.userAction(); // connect Meta
        await f.web.get('/api/platforms');
        f.userAction(); // choose account 123
        const check = await f.web.call('workspace', readiness('123'));
        return {goal: check.success && check.data.ready === true};
      },
      async failure(f) {
        f.userAction();
        await f.web.get('/api/session');
        f.userAction();
        await f.web.get('/api/platforms');
        f.userAction();
        f.providers.state.outage = true;
        const check = await f.web.call('workspace', readiness('123'));
        return {goal: check.success && check.data.ready === true};
      },
      async unavailable_account(f) {
        f.userAction();
        await f.web.get('/api/session');
        f.userAction();
        await f.web.get('/api/platforms');
        f.userAction(); // choose account 456, which the provider refuses
        const check = await f.web.call('workspace', readiness('456'));
        return {goal: check.success && check.data.ready === true};
      },
      async incomplete_evidence(f) {
        f.userAction();
        await f.web.get('/api/session');
        f.userAction();
        await f.web.get('/api/platforms');
        f.userAction();
        // Saved evidence only: the provider read is unknown, so the person runs the live check.
        const saved = await f.web.call('workspace', readiness('123', false));
        if (saved.data?.ready === true) return {goal: true};
        f.userAction();
        const live = await f.web.call('workspace', readiness('123'));
        return {goal: live.success && live.data.ready === true};
      },
    },
  },
  {
    id: 'J2',
    title: 'brief → eligibility → structure → review → outcome',
    surfaces: ['mcp', 'web'],
    branches: {
      async success(f) {
        await f.call('amcp_workspace', {
          action: 'capabilities',
          workflow_id: 'recipe:meta_website_traffic',
          connection_id: metaConnection,
          account_id: '123',
        });
        const plan = await createPlan(f, 'Journey J2');
        const outcome = await reviewAndExecute(f, plan.data.id);
        const goal = verified(outcome, plan.data.id);
        return {goal, handoff: goal && (await openHandoff(f, lastPath(f), plan.data.id))};
      },
      async failure(f) {
        const plan = await createPlan(f, 'Journey J2');
        // The account changes between the review and the execution: the reviewed request is never sent.
        const outcome = await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.accountStatus = 2;
          },
        });
        return {goal: verified(outcome, plan.data.id)};
      },
      async unavailable_account(f) {
        // Account 456 has no write grant: the plan saves, its review is refused before any provider call.
        const plan = await createPlan(f, 'Journey J2', pausedCampaign('456'));
        const outcome = await reviewAndExecute(f, plan.data.id);
        return {goal: verified(outcome, plan.data.id)};
      },
      async incomplete_evidence(f) {
        const plan = await createPlan(f, 'Journey J2');
        // The provider applies the create and the response is lost: the outcome is unknown and never resent.
        const outcome = await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.lost = true;
          },
        });
        return {goal: verified(outcome, plan.data.id)};
      },
    },
  },
  {
    id: 'J3',
    title: 'creative source → variants → previews → lineage',
    surfaces: ['mcp', 'web'],
    note: 'Variant and preview rendering need media bytes and FFmpeg and are covered by the media tests; this journey measures source → asset → evidence → lineage.',
    branches: {
      async success(f) {
        const {asset, plan} = seedLinkedAsset(f);
        const library = await f.call('amcp_media', {action: 'library', search: 'launch'});
        await f.call('amcp_media', {action: 'asset', asset_id: library.data.assets[0].asset_id});
        const report = await f.call('amcp_reporting', capture());
        const lineage = await f.call('amcp_media', {
          action: 'asset_performance',
          asset_id: asset,
          plan_id: plan,
          report_id: report.data.id,
        });
        const goal = lineage.success && lineage.data.rows?.length > 0;
        return {goal, handoff: goal && (await openHandoff(f, '/media?asset_id=' + asset, asset))};
      },
      async failure(f) {
        const {asset} = seedLinkedAsset(f, {linked: false});
        await f.call('amcp_media', {action: 'library', search: 'launch'});
        const report = await f.call('amcp_reporting', capture());
        // The retained plan never used this asset, so no lineage can be joined.
        const lineage = await f.call('amcp_media', {
          action: 'asset_performance',
          asset_id: asset,
          plan_id: 'linked-plan',
          report_id: report.data.id,
        });
        return {goal: lineage.success && lineage.data.rows?.length > 0};
      },
      async unavailable_account(f) {
        const {asset, plan} = seedLinkedAsset(f, {account: '456'});
        await f.call('amcp_media', {action: 'library', search: 'launch'});
        // The provider refuses the evidence read for account 456.
        const report = await f.call('amcp_reporting', capture('456'));
        if (!report.success) return {goal: false};
        const lineage = await f.call('amcp_media', {
          action: 'asset_performance',
          asset_id: asset,
          plan_id: plan,
          report_id: report.data.id,
        });
        return {goal: lineage.success && lineage.data.rows?.length > 0};
      },
      async incomplete_evidence(f) {
        const {asset} = seedLinkedAsset(f);
        await f.call('amcp_media', {action: 'library', search: 'launch'});
        // No evidence has been captured yet: performance finds no report to join.
        const performance = await f.call('amcp_media', {action: 'asset_performance', asset_id: asset});
        return {goal: performance.success && performance.data.reports?.length > 0};
      },
    },
  },
  {
    id: 'J4',
    title: 'account/period → evidence → detail → recommendation',
    surfaces: ['mcp', 'web'],
    branches: {
      async success(f) {
        const report = await f.call('amcp_reporting', capture());
        await f.call('amcp_reporting', {action: 'get', id: report.data.id});
        const analysis = await f.call('amcp_reporting', {action: 'analyze', id: report.data.id});
        const goal = analysis.success && analysis.data.eligible_for_action === true;
        return {goal, handoff: goal && (await openHandoff(f, lastPath(f), report.data.id))};
      },
      async failure(f) {
        f.providers.state.outage = true;
        const report = await f.call('amcp_reporting', capture());
        return {goal: report.success === true};
      },
      async unavailable_account(f) {
        const report = await f.call('amcp_reporting', capture('456'));
        return {goal: report.success === true};
      },
      async incomplete_evidence(f) {
        // The reporting window is declared incomplete: the recommendation is a data-quality hold, not an action.
        const report = await f.call('amcp_reporting', capture('123', false));
        const analysis = await f.call('amcp_reporting', {action: 'analyze', id: report.data.id});
        return {goal: analysis.success && analysis.data.eligible_for_action === true};
      },
    },
  },
  {
    id: 'J5',
    title: 'snapshot → export or recurring delivery → receipt → safe retry',
    surfaces: ['mcp', 'worker', 'web'],
    branches: {
      async success(f) {
        const snapshot = f.snapshot();
        await f.call('amcp_reporting_overview', {action: 'get', id: snapshot});
        f.approve();
        const queued = await f.call('amcp_reporting_overview', {
          action: 'export',
          report_id: snapshot,
          destination_id: evaluationDestination,
          confirmed: true,
        });
        await f.work();
        const receipt = await f.call('amcp_reporting_overview', {action: 'export_status', id: queued.data.id});
        const goal = receipt.data?.outcome === 'complete' && f.providers.state.tab.report === snapshot;
        return {goal, handoff: goal && (await openHandoff(f, lastPath(f), snapshot))};
      },
      async failure(f) {
        const snapshot = f.snapshot();
        f.providers.state.sheetsRefusal = true;
        f.approve();
        const queued = await f.call('amcp_reporting_overview', {
          action: 'export',
          report_id: snapshot,
          destination_id: evaluationDestination,
          confirmed: true,
        });
        await f.work();
        const failed = await f.call('amcp_reporting_overview', {action: 'export_status', id: queued.data.id});
        if (failed.data?.retry_available !== true) return {goal: false};
        // The person restores the sheet's permission and retries the same export: a safe retry, not a new one. Retry
        // takes the delivery job's identifier, which the status names.
        f.providers.state.sheetsRefusal = false;
        f.approve();
        await f.call('amcp_reporting_overview', {action: 'retry', id: failed.data.job_id, confirmed: true});
        await f.work();
        const receipt = await f.call('amcp_reporting_overview', {action: 'export_status', id: queued.data.id});
        return {goal: receipt.data?.outcome === 'complete' && f.providers.state.tab.report === snapshot};
      },
      async unavailable_account(f) {
        const snapshot = f.snapshot();
        f.store.putConnection(
          f.admin,
          {
            id: sheetsConnection,
            tenantId: f.actor.tenantId,
            gateway: sheetsGateway,
            enabled: false,
            accounts: [evaluationSheet],
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            label: 'Evaluation Sheets login',
          },
          {accessToken: 'synthetic-sheets'},
        );
        f.approve();
        const queued = await f.call('amcp_reporting_overview', {
          action: 'export',
          report_id: snapshot,
          destination_id: evaluationDestination,
          confirmed: true,
        });
        return {goal: queued.success === true};
      },
      async incomplete_evidence(f) {
        // The tab already holds a newer snapshot: exporting an older one is superseded and writes nothing.
        const older = f.snapshot(),
          newer = f.snapshot();
        f.approve();
        await f.call('amcp_reporting_overview', {
          action: 'export',
          report_id: newer,
          destination_id: evaluationDestination,
          confirmed: true,
        });
        await f.work();
        f.approve();
        const queued = await f.call('amcp_reporting_overview', {
          action: 'export',
          report_id: older,
          destination_id: evaluationDestination,
          confirmed: true,
        });
        await f.work();
        const receipt = await f.call('amcp_reporting_overview', {action: 'export_status', id: queued.data.id});
        return {goal: receipt.data?.outcome === 'complete' && f.providers.state.tab.report === older};
      },
    },
  },
  {
    id: 'J6',
    title: 'measurement concern → configuration and evidence → repair',
    surfaces: ['mcp', 'web'],
    branches: {
      async success(f) {
        const preview = await f.call('amcp_workspace', consentPreview());
        f.approve();
        const draft = await f.call('amcp_workspace', {
          action: 'create_consent_plan',
          preview_id: preview.data.preview_id,
          preview_hash: preview.data.preview_hash,
          confirmed: true,
        });
        const opened = await follow(f, draft, {limit: 1});
        const goal = opened.success && opened.data?.state === 'draft';
        return {goal, handoff: goal && (await openHandoff(f, lastPath(f), draft.data.id))};
      },
      async failure(f) {
        const preview = await f.call('amcp_workspace', consentPreview());
        // The tag changes in Tag Manager after the preview: the repair draft is refused, nothing is saved.
        f.providers.state.gtm.tags.get('001').fingerprint = 'tag-001-changed';
        f.approve();
        const draft = await f.call('amcp_workspace', {
          action: 'create_consent_plan',
          preview_id: preview.data.preview_id,
          preview_hash: preview.data.preview_hash,
          confirmed: true,
        });
        return {goal: draft.success === true};
      },
      async unavailable_account(f) {
        const preview = await f.call('amcp_workspace', consentPreview('45'));
        return {goal: preview.success === true};
      },
      async incomplete_evidence(f) {
        // A selected tag no longer exists: no partial evidence becomes a repair.
        const preview = await f.call('amcp_workspace', consentPreview('44', ['001', '003']));
        return {goal: preview.success === true};
      },
    },
  },
  {
    id: 'J7',
    title: 'failure → cause → retained work → safe next action → resume',
    surfaces: ['mcp', 'web'],
    branches: {
      async success(f) {
        const plan = await createPlan(f, 'Journey J7');
        await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.accountStatus = 2;
          },
        });
        f.providers.state.accountStatus = 1;
        // Later: the person finds the plan that needs attention on Home, reads the cause and resumes it.
        const feed = await f.web.call('workspace', {action: 'operations', state: 'attention'});
        const item = feed.data?.operations?.find(entry => entry.id === plan.data.id);
        if (!item) return {goal: false};
        await f.call('amcp_campaign', {action: 'get', id: plan.data.id, step_id: 'campaign'});
        const resumed = await f.call('amcp_campaign', {action: 'prepare_next', id: plan.data.id});
        const outcome = await follow(f, resumed, {limit: 4, stop: response => verified(response, plan.data.id)});
        return {goal: verified(outcome, plan.data.id)};
      },
      async failure(f) {
        const plan = await createPlan(f, 'Journey J7');
        await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.lost = true;
          },
        });
        f.providers.state.lost = false;
        const feed = await f.web.call('workspace', {action: 'operations', state: 'attention'});
        const item = feed.data?.operations?.find(entry => entry.id === plan.data.id);
        if (!item) return {goal: false};
        // An uncertain create can only be inspected, never resent; resuming is not the safe next action.
        const detail = await f.call('amcp_campaign', {action: 'get', id: plan.data.id, step_id: 'campaign'});
        const outcome = await follow(f, detail, {limit: 2});
        return {goal: verified(outcome, plan.data.id)};
      },
      async unavailable_account(f) {
        const plan = await createPlan(f, 'Journey J7');
        await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.accountStatus = 2;
          },
        });
        f.providers.state.accountStatus = 1;
        // The account's write grant is removed before the person returns.
        f.store.putConnection(
          f.admin,
          {
            id: metaConnection,
            tenantId: f.actor.tenantId,
            gateway: 'meta_native_action',
            accounts: ['123', '456'],
            writeAccounts: [],
            enabled: true,
            label: 'Client A Meta',
            scopes: ['ads_management', 'ads_read'],
          },
          {accessToken: 'synthetic-a'},
        );
        const feed = await f.web.call('workspace', {action: 'operations', state: 'attention'});
        if (!feed.data?.operations?.some(entry => entry.id === plan.data.id)) return {goal: false};
        const resumed = await f.call('amcp_campaign', {action: 'prepare_next', id: plan.data.id});
        const outcome = await follow(f, resumed, {limit: 4, stop: response => verified(response, plan.data.id)});
        return {goal: verified(outcome, plan.data.id)};
      },
      async incomplete_evidence(f) {
        // The attention item is on a later page of the feed: the person pages until they find it.
        const other = await createPlan(f, 'Journey J7 other');
        const plan = await createPlan(f, 'Journey J7');
        await reviewAndExecute(f, plan.data.id, {
          beforeExecute: () => {
            f.providers.state.accountStatus = 2;
          },
        });
        f.providers.state.accountStatus = 1;
        let cursor, item;
        for (let page = 0; page < 4 && !item; page++) {
          const feed = await f.web.call('workspace', {action: 'operations', limit: 1, ...(cursor ? {cursor} : {})});
          item = feed.data?.operations?.find(entry => entry.id === plan.data.id && entry.category === 'attention');
          cursor = feed.data?.next_cursor;
          if (!cursor) break;
        }
        if (!item || other.data.id === plan.data.id) return {goal: false};
        const resumed = await f.call('amcp_campaign', {action: 'prepare_next', id: plan.data.id});
        const outcome = await follow(f, resumed, {limit: 4, stop: response => verified(response, plan.data.id)});
        return {goal: verified(outcome, plan.data.id)};
      },
    },
  },
  {
    id: 'J8',
    title: 'multi-client work → selection and ownership preserved across handoffs',
    surfaces: ['mcp', 'web'],
    branches: {
      async success(f) {
        const a = await createPlan(f, 'Client A plan'),
          b = await createPlan(f, 'Client B plan', pausedCampaign('789', otherConnection));
        // The client lists only Client A's work, then hands the person to that plan on the website.
        const feed = await f.call('amcp_workspace', {action: 'operations', connection_id: metaConnection});
        const ids = (feed.data?.operations ?? []).map(entry => entry.id);
        const scoped = ids.includes(a.data.id) && !ids.includes(b.data.id);
        const detail = await f.web.call('campaign', {action: 'get', id: a.data.id, detail: 'full'});
        const owned =
          detail.data?.steps?.[0]?.connection_id === metaConnection && detail.data?.steps?.[0]?.account_id === '123';
        const goal = scoped && owned;
        return {goal, handoff: goal && (await openHandoff(f, a.meta.workflow.website_path, a.data.id))};
      },
      async failure(f) {
        // Client B's account under Client A's connection: refused, never re-bound to the other client's login.
        const plan = await createPlan(f, 'Crossed plan', pausedCampaign('789', metaConnection));
        return {goal: plan.success === true};
      },
      async unavailable_account(f) {
        // Account 123 is in both clients' connections, but only Client A's may write to it.
        const plan = await createPlan(f, 'Read-only plan', pausedCampaign('123', otherConnection));
        const outcome = await reviewAndExecute(f, plan.data.id);
        return {goal: verified(outcome, plan.data.id)};
      },
      async incomplete_evidence(f) {
        const a = await createPlan(f, 'Client A plan'),
          b = await createPlan(f, 'Client B plan', pausedCampaign('789', otherConnection));
        // One item per page: the person pages through the feed; each item keeps its own client's account.
        const seen = new Map();
        let cursor;
        for (let page = 0; page < 4; page++) {
          const feed = await f.web.call('workspace', {action: 'operations', limit: 1, ...(cursor ? {cursor} : {})});
          for (const entry of feed.data?.operations ?? []) seen.set(entry.id, entry.accounts);
          cursor = feed.data?.next_cursor;
          if (!cursor) break;
        }
        return {
          goal:
            JSON.stringify(seen.get(a.data.id)) === JSON.stringify(['123']) &&
            JSON.stringify(seen.get(b.data.id)) === JSON.stringify(['789']),
        };
      },
    },
  },
]);
