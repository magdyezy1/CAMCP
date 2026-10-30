import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {obj, type ToolCall} from './workspace-core.js';
import {pick, read, type Step} from './campaign-clone-core.js';

// LinkedIn's campaign clone, its adapter's `campaign.clone` (ARC-01 phase B, wave 4c: moved verbatim from
// src/campaign-clone.ts, which keeps the checks every clone passes and the spec's changes).
// LinkedIn: the writable fields of the campaign group, campaign and creative schemas (Microsoft Learn, "Create and
// manage campaign groups / campaigns / creatives", li-lms-2026-05, read 2026-09-29), less the account, parent, name
// and status, which the clone sets. A creative keeps its content as read: a sponsored post is reused by reference.
const linkedinGroupFields = [
  'runSchedule',
  'totalBudget',
  'dailyBudget',
  'objectiveType',
  'budgetOptimization',
  'buyingType',
  'beneficiaryReference',
  'billingReference',
  'billingParentReference',
];
const linkedinCampaignFields = [
  'associatedEntity',
  'audienceExpansionEnabled',
  'costType',
  'creativeSelection',
  'dailyBudget',
  'locale',
  'objectiveType',
  'offsiteDeliveryEnabled',
  'offsitePreferences',
  'runSchedule',
  'targetingCriteria',
  'totalBudget',
  'type',
  'unitCost',
  'optimizationTargetType',
  'format',
  'pacingStrategy',
  'connectedTelevisionOnly',
  'optimizationPreference',
  'politicalIntent',
];
const linkedinCreativeFields = ['content', 'name', 'leadgenCallToAction'];
const linkedinSystem = [
  'id',
  'account',
  'accountInfo',
  'backfilled',
  'servingStatuses',
  'status',
  'test',
  'allowedCampaignTypes',
  'campaignGroup',
  'campaignGroupInfo',
  'associatedEntityInfo',
  'version',
  'versionTag',
  'isTest',
  'name',
  'campaign',
  'intendedStatus',
  'isServing',
  'review',
  'createdAt',
  'createdBy',
  'lastModifiedAt',
  'lastModifiedBy',
  'servingHoldReasons',
  'changeAuditStamps',
];
export async function linkedinClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id),
    id = String(input.source.campaign_id);
  if (!/^[1-9][0-9]{0,19}$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric LinkedIn campaign group ID.', {
      field: 'source.campaign_id',
    });
  const base = {connection_id: input.connection_id, account_id: account},
    groupUrn = 'urn:li:sponsoredCampaignGroup:' + id;
  // The group is read under the selected account's path: LinkedIn answers 404 for a group the account does not hold.
  const group = await read(call, actor, 'linkedin_native_action', {
    ...base,
    action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_ad_campaign_groups_id_get',
    path_params: {ad_campaign_groups_id: id},
  }).catch(e => {
    if (e instanceof MirrorError && e.details.http_status === 404) return undefined;
    throw e;
  });
  if (!obj(group) || String(group.id) !== id)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign group ' + id + ' is not in this ad account.', {
      field: 'source.campaign_id',
    });
  const elements = (d: unknown) => (obj(d) && Array.isArray(d.elements) ? d.elements : []).filter(obj) as JsonObject[];
  const campaigns = elements(
    await read(call, actor, 'linkedin_native_action', {
      ...base,
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get',
      restli_method: 'FINDER',
      query: {q: 'search', search: {campaignGroup: {values: [groupUrn]}}, pageSize: 100},
      aggregate_pages: true,
    }),
  ).filter(c => c.campaignGroup === groupUrn);
  const urns = campaigns.map(c => 'urn:li:sponsoredCampaign:' + c.id);
  const creatives = urns.length
    ? elements(
        await read(call, actor, 'linkedin_native_action', {
          ...base,
          action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
          restli_method: 'FINDER',
          query: {q: 'criteria', campaigns: urns, pageSize: 100},
          aggregate_pages: true,
        }),
      ).filter(c => urns.includes(String(c.campaign)))
    : [];
  const step = (sid: string, action: string, payload: JsonObject, depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'linkedin_native_action',
    connection_id: input.connection_id,
    account_id: account,
    arguments: {action, payload},
    depends_on: depends,
  });
  const notCopied: JsonObject[] = [];
  const note = (entity: string, row: JsonObject, keys: string[]) => {
    const fields = Object.keys(row).filter(k => !keys.includes(k) && !linkedinSystem.includes(k));
    if (fields.length) notCopied.push({entity, fields});
  };
  // LinkedIn returns a new ID in x-restli-id (the receipt's created_id); children name their parent by URN.
  const steps: Step[] = [
    step('group', 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_post', {
      ...pick(group, linkedinGroupFields),
      account: 'urn:li:sponsoredAccount:' + account,
      name: input.name,
      status: 'PAUSED',
    }),
  ];
  note('group', group, linkedinGroupFields);
  campaigns.forEach((c, i) => {
    const sid = 'campaign_' + (i + 1);
    steps.push(
      step(
        sid,
        'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
        {
          ...pick(c, linkedinCampaignFields),
          account: 'urn:li:sponsoredAccount:' + account,
          campaignGroup: {$ref: 'group#/created_id', prefix: 'urn:li:sponsoredCampaignGroup:'},
          name: c.name,
          status: 'PAUSED',
        },
        ['group'],
      ),
    );
    note(sid, c, linkedinCampaignFields);
    const own = creatives.filter(cr => cr.campaign === 'urn:li:sponsoredCampaign:' + c.id);
    for (const cr of own.filter(cr => !obj(cr.content)))
      notCopied.push({entity: String(cr.id), fields: ['the whole creative: LinkedIn returned no content to reuse']});
    own
      .filter(cr => obj(cr.content))
      .forEach((cr, j) => {
        steps.push(
          step(
            sid + '_creative_' + (j + 1),
            'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
            {
              ...pick(cr, linkedinCreativeFields),
              campaign: {$ref: sid + '#/created_id', prefix: 'urn:li:sponsoredCampaign:'},
              intendedStatus: 'PAUSED',
            },
            [sid],
          ),
        );
        note(sid + '_creative_' + (j + 1), cr, linkedinCreativeFields);
      });
  });
  return {
    steps,
    notCopied,
    source: {campaign_id: id, campaigns: campaigns.length, creatives: creatives.length},
  };
}
