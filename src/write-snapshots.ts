/** Snapshot plan stage: the reads that record the state a reviewed write depends on. */
import {snapLeadDependencyPaths} from './snapchat-lead-forms.js';
import {snapSegmentDependencyPaths} from './snapchat-segments.js';
import {snapAdCreativePaths} from './snapchat-ad-creatives.js';
import {tiktokAdgroupConversionRead} from './tiktok-adgroup-conversions.js';
import {tiktokCtaPortfolioReads} from './tiktok-cta-portfolios.js';
import {metaCreativeCreate, metaCreativeIdentityReads} from './meta-creative-state.js';
import {Registry} from './catalog.js';
import {normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {xTargetingKind, xTargetingSnapshots} from './x-targeting-writes.js';
import {familyOf} from './reviewed-families.js';
import {googleAdsCustomers} from './google-version.js';
import {object, fail, snake} from './write-common.js';

/** A state read of the account or resources a reviewed write depends on, made by the write's own connection. */
/** A read-only request of `path` for the plan's account and connection, as every state read is built. */
export const stateRead = (
  plan: CompiledRequest,
  path: string,
  query: JsonObject = {},
  body?: JsonObject,
  method = 'GET',
): CompiledRequest =>
  applyExecutionRisk({
    ...plan,
    action: 'AMCP_STATE_READ',
    method,
    path,
    query,
    body,
    headers:
      plan.gateway === 'linkedin_native_action'
        ? Object.fromEntries(
            Object.entries(plan.headers).filter(([k]) => ['LinkedIn-Version', 'X-Restli-Protocol-Version'].includes(k)),
          )
        : {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    specialTransport: undefined,
  });

/** Reads are explicitly derived from the target, never supplied by the caller as proof. */
export function snapshotPlans(plan: CompiledRequest, registry: Registry): CompiledRequest[] {
  const base = (path: string, query: JsonObject = {}, body?: JsonObject, method = 'GET'): CompiledRequest =>
    stateRead(plan, path, query, body, method);
  const family = familyOf(plan);
  if (family?.snapshots) return family.snapshots(plan, base);
  if (xTargetingKind(plan)) return xTargetingSnapshots(plan);
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
  if (plan.gateway === 'google_ads_native_action') {
    const kind = plan.path.match(/\/([^/]+):mutate$/)?.[1],
      map: Record<string, string> = {
        assets: 'asset',
        campaigns: 'campaign',
        adGroups: 'ad_group',
        adGroupAds: 'ad_group_ad',
        campaignBudgets: 'campaign_budget',
        ads: 'ad',
        assetGroups: 'asset_group',
        campaignCriteria: 'campaign_criterion',
        adGroupCriteria: 'ad_group_criterion',
      };
    if (!kind || !map[kind])
      fail('WRITE_CONTRACT_UNAVAILABLE', 'This Google mutation has no implemented state-read contract.');
    const resource = map[kind]!,
      snapshots: CompiledRequest[] = [],
      fields = new Set([resource + '.resource_name']),
      names: string[] = [];
    for (const op of body.operations) {
      const record = object(op.update),
        name = op.remove ?? record.resource_name ?? record.resourceName;
      if (name !== undefined) {
        if (typeof name !== 'string' || !new RegExp('^customers/' + id + '/' + kind + '/[0-9~_-]+$').test(name))
          fail('ACCOUNT_SCOPE_MISMATCH', 'Google mutation resource does not match the selected customer/type.');
        names.push(name);
      }
      if (op.update) {
        const mask = op.update_mask ?? op.updateMask;
        if (typeof mask !== 'string' || !mask) fail('MISSING_UPDATE_MASK', 'Updates require an explicit field mask.');
        for (const f of mask.split(',')) {
          if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(f)) fail('INVALID_UPDATE_MASK', 'Invalid field mask.');
          fields.add(resource + '.' + snake(f));
        }
      }
      if (op.remove) {
        const deletionFields: Record<string, string[]> = {
          asset: ['name', 'type'],
          campaign: ['name', 'status', 'campaign_budget', 'advertising_channel_type'],
          ad_group: ['name', 'status', 'campaign', 'cpc_bid_micros'],
          ad_group_ad: ['status', 'ad.id', 'ad.final_urls'],
          campaign_budget: ['name', 'amount_micros', 'delivery_method'],
          ad: ['name', 'final_urls'],
          asset_group: ['name', 'status', 'campaign'],
        };
        for (const f of deletionFields[resource] ?? []) fields.add(resource + '.' + f);
      }
    }
    const search = (query: string) => base(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST');
    if (names.length)
      snapshots.push(
        search(
          'SELECT ' +
            [...fields].join(', ') +
            ' FROM ' +
            resource +
            ' WHERE ' +
            resource +
            '.resource_name IN (' +
            names.map(n => "'" + n + "'").join(', ') +
            ')',
        ),
      );
    if (body.operations.some((op: JsonObject) => op.create))
      snapshots.push(search('SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'));
    const parents: Record<string, {kind: string; fields: string}> = {
      campaign_budget: {
        kind: 'campaignBudgets',
        fields: 'campaign_budget.resource_name, campaign_budget.amount_micros',
      },
      campaign: {kind: 'campaigns', fields: 'campaign.resource_name, campaign.status, campaign.campaign_budget'},
      // The campaign's status too: a new ad may start ENABLED only under a paused ad group or campaign.
      ad_group: {
        kind: 'adGroups',
        fields: 'ad_group.resource_name, ad_group.status, ad_group.campaign, campaign.status',
      },
    };
    const seen = new Set<string>();
    for (const op of body.operations)
      for (const [field, parent] of Object.entries(parents)) {
        const record = object(op.create ?? op.update),
          name = record[field] ?? record[field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
        if (name === undefined || seen.has(name)) continue;
        if (typeof name !== 'string' || !new RegExp('^customers/' + id + '/' + parent.kind + '/[0-9]+$').test(name))
          fail(
            'INVALID_PARENT_RESOURCE',
            'Parent resources must exist in the selected customer. Create temporary resources in a separate review.',
          );
        seen.add(name);
        snapshots.push(
          search(
            'SELECT ' + parent.fields + ' FROM ' + field + ' WHERE ' + field + ".resource_name IN ('" + name + "')",
          ),
        );
      }
    if (!snapshots.length) fail('WRITE_CONTRACT_UNAVAILABLE', 'Each operation must contain create, update or remove.');
    return snapshots;
  }
  if (plan.gateway === 'tiktok_native_action') {
    const match = /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
    if (!match) fail('WRITE_CONTRACT_UNAVAILABLE', 'This TikTok action has no implemented state-read contract.');
    if (match[2] === 'create') {
      const reads = [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
        parent = match[1] === 'adgroup' ? 'campaign' : match[1] === 'ad' ? 'adgroup' : undefined;
      if (parent) {
        const parentId = body[parent + '_id'];
        if (typeof parentId !== 'string' || !/^\d+$/.test(parentId))
          fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
        const read = base('/v1.3/' + parent + '/get/', {
          advertiser_id: id,
          filtering: {[parent + '_ids']: [parentId]},
          page_size: 100,
        });
        read.action = 'tiktok_' + parent + '_get';
        reads.push(read);
      }
      const conversion = tiktokAdgroupConversionRead(plan);
      if (conversion) {
        const read = base(conversion.path, conversion.query);
        read.action = conversion.action;
        reads.push(read);
      }
      for (const r of tiktokCtaPortfolioReads(plan)) {
        const read = base(r.path, r.query);
        read.action = r.action;
        reads.push(read);
      }
      return reads;
    }
    const kind = match[1]!,
      ids = body[kind + '_ids'] ?? (body[kind + '_id'] ? [body[kind + '_id']] : undefined);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 25 ||
      ids.some(v => typeof v !== 'string' || !/^\d+$/.test(v))
    )
      fail('MISSING_PARAMETER', 'Supply 1–25 exact ' + kind + ' IDs.');
    const read = base('/v1.3/' + kind + '/get/', {
      advertiser_id: id,
      filtering: {[kind + '_ids']: ids},
      page_size: 100,
    });
    read.action = 'tiktok_' + kind + '_get';
    return [
      read,
      ...tiktokCtaPortfolioReads(plan).map(r => {
        const portfolio = base(r.path, r.query);
        portfolio.action = r.action;
        return portfolio;
      }),
    ];
  }
  if (plan.gateway === 'meta_native_action') {
    const create = /^\/v[^/]+\/act_[^/]+\//.test(plan.path) && plan.method === 'POST';
    if (create) {
      const reads = [base(plan.path.match(/^\/v[^/]+\/act_[^/]+/)![0], {fields: 'id,account_status,currency'})];
      const parent = plan.path.endsWith('/adsets')
        ? body.campaign_id
        : plan.path.endsWith('/ads')
          ? body.adset_id
          : undefined;
      if (plan.path.endsWith('/adsets') || plan.path.endsWith('/ads')) {
        if (typeof parent !== 'string' || !/^\d+$/.test(parent))
          fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
        // An ad set names its campaign, which covers an active ad under a serving ad set (paused-parents.ts). A new
        // ad set reads its campaign's special ad categories (metaAdSetAudienceChoice).
        reads.push(
          base(plan.path.split('/').slice(0, 2).join('/') + '/' + parent, {
            fields: plan.path.endsWith('/ads') ? 'id,name,status,campaign_id' : 'id,name,status,special_ad_categories',
          }),
        );
      }
      if (metaCreativeCreate(plan)) reads.push(...metaCreativeIdentityReads(plan));
      return reads;
    }
    if (/^\/v[^/]+\/\d+$/.test(plan.path)) {
      const fields = new Set(['id', 'name', 'status']);
      for (const k of Object.keys(body))
        if (/^[a-z_]+$/.test(k) && !['execution_options', 'fields'].includes(k)) fields.add(k);
      return [base(plan.path, {fields: [...fields].join(',')})];
    }
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PUT') {
    const kind = plan.path.split('/').at(-1)!,
      rows = body[kind];
    if (!Array.isArray(rows) || !rows.length || rows.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native update records.');
    if (new Set(rows.map(row => row?.id)).size !== rows.length)
      fail('INVALID_ARGUMENT', 'Each updated Snapchat resource ID must be unique.');
    return [
      ...rows.map(row => {
        if (typeof row?.id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(row.id))
          fail('MISSING_PARAMETER', 'Each update record requires its exact ID.');
        return base('/v1/' + kind + '/' + row.id);
      }),
      ...snapAdCreativePaths(plan).map(path => base(path)),
    ];
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH') {
    const match = /\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/([^/]+)$/.exec(plan.path)!;
    return [base('/v1/' + match[1] + '/' + match[2]), ...snapAdCreativePaths(plan).map(path => base(path))];
  }
  const catalog = registry.catalogs.get(plan.gateway);
  const samePath = [
    ...(catalog?.actions ?? []),
    ...registry.data.supplemental.filter(a => a.gateway === plan.gateway),
  ].some(
    a =>
      a.method === 'GET' &&
      a.path &&
      new RegExp(
        '^' +
          a.path
            .split('?')[0]!
            .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
            .replace(/\{[^}]+\}/g, '[^/]+') +
          '$',
      ).test(plan.path),
  );
  const accountPaths: Record<string, RegExp> = {
    snapchat_native_action: /^\/v1\/adaccounts\/[^/]+/,
    x_ads_native_action: /^\/12\/accounts\/[^/]+/,
    linkedin_native_action: /^\/rest\/adAccounts\/[^/]+/,
    dv360_native_action: /^\/v\d+\/advertisers\/[^/]+/,
  };
  const account = accountPaths[plan.gateway]?.exec(plan.path)?.[0];
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'POST' && !account)
    return [base(plan.path.slice(0, plan.path.lastIndexOf('/'))), ...snapAdCreativePaths(plan).map(path => base(path))];
  // Account creates also read owned dependencies: a lead form's banner media, a lead creative's form, a lookalike's seed.
  if (
    plan.gateway === 'snapchat_native_action' &&
    plan.method === 'POST' &&
    account &&
    plan.path.slice(account.length).split('/').filter(Boolean).length === 1
  )
    return [
      base(account),
      ...[...snapLeadDependencyPaths(plan), ...snapSegmentDependencyPaths(plan)].map(path => base(path)),
    ];
  // On collection creates, snapshot the account. On edits/deletes, the catalog must expose a matching GET.
  if (plan.method === 'POST' && account && plan.path.slice(account.length).split('/').filter(Boolean).length === 1)
    return [base(account)];
  if (samePath && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(plan.method)) return [base(plan.path)];
  fail(
    'WRITE_CONTRACT_UNAVAILABLE',
    'This operation lacks an implemented target-state read. It remains available as a local dry run.',
  );
}
