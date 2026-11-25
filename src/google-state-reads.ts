/**
 * Google Ads' state reads of a reviewed mutation no family plans (ARC-01 phase B, wave 4c: its adapter's
 * `writes.snapshots`, moved verbatim from src/write-snapshots.ts, which asks it where it named Google Ads): the targets
 * of its updates and removals with the fields they change, the customer of a create, and each existing parent.
 */
import type {CompiledRequest, JsonObject} from './types.js';
import type {StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {googleAdsCustomers} from './google-version.js';
import {object, fail, snake} from './write-common.js';

/** The resources of the mutations above that have a name of their own (an ad group ad and a criterion have none: they are named by what they hold). */
const hasName = new Set(['asset', 'campaign', 'ad_group', 'campaign_budget', 'ad', 'asset_group']);

export function googleStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] {
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
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
    // The name of what the request edits is read with it (R2.5 r25-approval-fields, the owner's friction report B6): the review's summary line names the object.
    fields = new Set([resource + '.resource_name', ...(hasName.has(resource) ? [resource + '.name'] : [])]),
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
        search('SELECT ' + parent.fields + ' FROM ' + field + ' WHERE ' + field + ".resource_name IN ('" + name + "')"),
      );
    }
  if (!snapshots.length) fail('WRITE_CONTRACT_UNAVAILABLE', 'Each operation must contain create, update or remove.');
  return snapshots;
}
