import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {obj, type ToolCall} from './workspace-core.js';
import {pick, read, unpicked, type Step} from './campaign-clone-core.js';

// Snapchat's campaign clone, its adapter's `campaign.clone` (ARC-01 phase B, wave 4c: moved verbatim from
// src/campaign-clone.ts, which keeps the checks every clone passes and the spec's changes).
// Snapchat: fields the repository's fixtures and families send on create.
const snapCampaignFields = [
  'name',
  'ad_account_id',
  'start_time',
  'end_time',
  'buy_model',
  'objective_v2_properties',
  'daily_budget_micro',
  'lifetime_spend_cap_micro',
];
const snapSquadFields = [
  'name',
  'type',
  'status',
  'targeting',
  'billing_event',
  'bid_strategy',
  'bid_micro',
  'daily_budget_micro',
  'lifetime_budget_micro',
  'optimization_goal',
  'pixel_id',
  'start_time',
  'end_time',
  'delivery_constraint',
  'pacing_type',
  'child_ad_type',
];
const snapAdFields = ['name', 'type', 'creative_id'];
const snapSystem = [
  'id',
  'created_at',
  'updated_at',
  'status',
  'campaign_id',
  'ad_squad_id',
  'ad_account_id',
  'delivery_status',
  'creation_state',
  'review_status',
  'review_status_reasons',
  'effective_status',
  'placement',
];
// A child keeps ACTIVE or PAUSED; any other state (a deleted one, say) is created PAUSED.
const snapStatus = (row: JsonObject) => (row.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED');
export async function snapchatClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const base = {connection_id: input.connection_id, account_id: input.account_id},
    id = String(input.source.campaign_id);
  const rows = (d: unknown, kind: string) =>
    ((obj(d) && Array.isArray(d[kind]) ? d[kind] : []) as JsonObject[])
      .map(w => w?.[kind.slice(0, -1)] ?? w)
      .filter(obj);
  const campaign = rows(
    await read(call, actor, 'snapchat_native_action', {...base, action: 'snapchat_campaign_list', result_ids: [id]}),
    'campaigns',
  )[0];
  if (!campaign)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this ad account’s campaign list.', {
      field: 'source.campaign_id',
    });
  const squads = rows(
      await read(call, actor, 'snapchat_native_action', {
        ...base,
        action: 'snapchat_adsquad_list',
        aggregate_pages: true,
      }),
      'adsquads',
    ).filter(s => s.campaign_id === id),
    squadIds = new Set(squads.map(s => s.id)),
    ads = rows(
      await read(call, actor, 'snapchat_native_action', {...base, action: 'snapchat_ad_list', aggregate_pages: true}),
      'ads',
    ).filter(a => squadIds.has(a.ad_squad_id));
  const step = (sid: string, args: JsonObject, depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'snapchat_native_action',
    connection_id: input.connection_id,
    account_id: input.account_id,
    arguments: args,
    depends_on: depends,
  });
  const campaignRef = {$ref: 'campaign#/data/campaigns/0/campaign/id'};
  const steps: Step[] = [
    step('campaign', {
      action: 'snapchat_campaign_create',
      payload: {
        campaigns: [
          {...pick(campaign, snapCampaignFields), ad_account_id: input.account_id, name: input.name, status: 'PAUSED'},
        ],
      },
    }),
  ];
  const notCopied: JsonObject[] = [];
  const note = (entity: string, fields: string[]) => {
    if (fields.length) notCopied.push({entity, fields});
  };
  note('campaign', unpicked(campaign, snapCampaignFields, snapSystem));
  squads.forEach((s, i) => {
    const sid = 'squad_' + (i + 1);
    steps.push(
      step(
        sid,
        {
          action: 'snapchat_adsquad_create',
          path_params: {campaign_id: campaignRef},
          payload: {adsquads: [{...pick(s, snapSquadFields), campaign_id: campaignRef, status: snapStatus(s)}]},
        },
        ['campaign'],
      ),
    );
    // Snapchat never returns placement_v2 on GET: the clone uses Snapchat's default unless changes set it.
    note(sid, [...unpicked(s, snapSquadFields, snapSystem), 'placement_v2 (never readable)']);
    const squadRef = {$ref: sid + '#/data/adsquads/0/adsquad/id'},
      own = ads.filter(a => a.ad_squad_id === s.id);
    if (!own.length) return;
    // One step for the squad's ads: a list longer than 25 is reviewed in parts behind one approval.
    steps.push(
      step(
        sid + '_ads',
        {
          action: 'snapchat_ad_create',
          path_params: {ad_squad_id: squadRef},
          payload: {ads: own.map(a => ({...pick(a, snapAdFields), ad_squad_id: squadRef, status: snapStatus(a)}))},
        },
        [sid],
      ),
    );
    note(sid + '_ads', [...new Set(own.flatMap(a => unpicked(a, snapAdFields, snapSystem)))]);
  });
  return {steps, notCopied, source: {campaign_id: id, ad_squads: squads.length, ads: ads.length}};
}
