import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {bad, obj, type ToolCall} from './workspace-core.js';

/**
 * A campaign plan built from an existing campaign (the owner's item 10, 2026-09-29: "clone this campaign with changes,
 * run from a spec" would have made a rebuild one command). The source is read through the ordinary account-scoped
 * native reads; the result is an ordinary draft plan, reviewed step by step or approved once. Only fields AMCP
 * already sends on create are copied (never guessed); every other field the source has is listed as not copied.
 * The new campaign starts PAUSED. Google children keep their own status, which the paused campaign covers (the
 * owner's item 6); Snapchat creates every entity PAUSED, so its ad squads and ads start PAUSED too.
 */
type Step = JsonObject;
const pick = (o: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined && o[k] !== null).map(k => [k, o[k]]));
const unpicked = (o: JsonObject, keys: string[], skip: string[]) =>
  Object.keys(o).filter(k => !keys.includes(k) && !skip.includes(k));
async function read(call: ToolCall, actor: Actor, gateway: string, input: JsonObject): Promise<unknown> {
  const out = await call(gateway, input, actor);
  if (!out.success)
    throw new MirrorError(out.error.code, 'Reading the source failed: ' + out.error.message, out.error.details);
  if (out.data?.truncated)
    throw new MirrorError(
      'CLONE_SOURCE_TOO_LARGE',
      'The source did not fit in the pages AMCP reads; clone a smaller campaign.',
    );
  return out.data?.data;
}
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
async function snapchatClone(call: ToolCall, actor: Actor, input: JsonObject) {
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
          payload: {adsquads: [{...pick(s, snapSquadFields), campaign_id: campaignRef, status: 'PAUSED'}]},
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
          payload: {ads: own.map(a => ({...pick(a, snapAdFields), ad_squad_id: squadRef, status: 'PAUSED'}))},
        },
        [sid],
      ),
    );
    note(sid + '_ads', [...new Set(own.flatMap(a => unpicked(a, snapAdFields, snapSystem)))]);
  });
  return {steps, notCopied, source: {campaign_id: id, ad_squads: squads.length, ads: ads.length}};
}
// Google Search: the shapes the Google Search recipe creates (campaign-recipes.ts).
const googleBidding: Record<string, string> = {
  MANUAL_CPC: 'manualCpc',
  MAXIMIZE_CONVERSIONS: 'maximizeConversions',
  MAXIMIZE_CONVERSION_VALUE: 'maximizeConversionValue',
  TARGET_SPEND: 'targetSpend',
};
// An ad text asset's other fields (performance label, policy summary) are Google's output (google-ads-v25.json).
const textFields = ['text', 'pinnedField'];
const snakeKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : obj(v)
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
async function googleClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id).replace(/-/g, ''),
    id = String(input.source.campaign_id);
  if (!/^\d+$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric Google campaign ID.', {
      field: 'source.campaign_id',
    });
  const campaignName = 'customers/' + account + '/campaigns/' + id;
  const search = async (query: string) => {
    const d = await read(call, actor, 'google_ads_native_action', {
      action: 'google_ads_v23_google_ads_search',
      connection_id: input.connection_id,
      account_id: input.account_id,
      payload: {query},
      aggregate_pages: true,
    });
    return (obj(d) && Array.isArray(d.results) ? d.results : []) as JsonObject[];
  };
  const where = " WHERE campaign.resource_name = '" + campaignName + "'";
  const [source] = await search(
    'SELECT campaign.resource_name, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.contains_eu_political_advertising, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared FROM campaign' +
      where,
  );
  const c = source?.campaign as JsonObject | undefined;
  if (!c)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this customer.', {
      field: 'source.campaign_id',
    });
  if (c.advertisingChannelType !== 'SEARCH')
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Google Search campaigns; this one is ' + c.advertisingChannelType + '.',
      {
        field: 'source.campaign_id',
      },
    );
  const bidding = googleBidding[String(c.biddingStrategyType)];
  if (!bidding)
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones manual CPC, maximize conversions, maximize conversion value and maximize clicks bidding; this campaign uses ' +
        c.biddingStrategyType +
        '.',
      {field: 'source.campaign_id', supported: Object.keys(googleBidding)},
    );
  const budget = (source!.campaignBudget ?? {}) as JsonObject;
  const criteria = await search(
    'SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion' +
      where +
      " AND campaign_criterion.status != 'REMOVED'",
  );
  const groups = await search(
    'SELECT ad_group.resource_name, ad_group.name, ad_group.type, ad_group.cpc_bid_micros, ad_group.status FROM ad_group' +
      where +
      " AND ad_group.status != 'REMOVED'",
  );
  const keywords = await search(
    'SELECT ad_group_criterion.ad_group, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status FROM ad_group_criterion' +
      where +
      " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'",
  );
  const ads = await search(
    'SELECT ad_group_ad.ad_group, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad' +
      where +
      " AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'",
  );
  const response = '/data/results/0/resourceName',
    ref = (sid: string) => ({$ref: sid + '#' + response});
  const step = (sid: string, action: string, operations: JsonObject[], depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: input.connection_id,
    account_id: input.account_id,
    arguments: {action, payload: {operations}},
    depends_on: depends,
  });
  const network = snakeKeys(c.networkSettings ?? {}) as JsonObject,
    strategy = snakeKeys((c as JsonObject)[bidding] ?? {}) as JsonObject;
  const steps: Step[] = [
    step('budget', 'google_ads_v23_campaign_budget_mutate_campaign_budgets', [
      {
        create: {
          name: input.name + ' budget',
          amount_micros: budget.amountMicros,
          delivery_method: budget.deliveryMethod ?? 'STANDARD',
          explicitly_shared: false,
        },
      },
    ]),
    step(
      'campaign',
      'google_ads_v23_campaign_mutate_campaigns',
      [
        {
          create: {
            name: input.name,
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: ref('budget'),
            [bidding.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())]: strategy,
            network_settings: network,
            contains_eu_political_advertising: c.containsEuPoliticalAdvertising,
          },
        },
      ],
      ['budget'],
    ),
  ];
  const notCopied: JsonObject[] = [],
    skipped = new Set<string>();
  if (budget.explicitlyShared)
    notCopied.push({entity: 'budget', fields: ['explicitly_shared (the copy has its own budget of the same amount)']});
  const targeting = criteria.flatMap((r): JsonObject[] => {
    const k = r.campaignCriterion as JsonObject;
    if (k.type === 'LOCATION')
      return [
        {
          create: {
            campaign: ref('campaign'),
            location: {geo_target_constant: k.location?.geoTargetConstant},
            ...(k.negative ? {negative: true} : {}),
          },
        },
      ];
    if (k.type === 'LANGUAGE')
      return [{create: {campaign: ref('campaign'), language: {language_constant: k.language?.languageConstant}}}];
    if (k.type === 'KEYWORD' && k.negative)
      return [
        {
          create: {
            campaign: ref('campaign'),
            negative: true,
            keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          },
        },
      ];
    skipped.add(String(k.type) + (k.negative ? ' (negative)' : '') + ' criteria');
    return [];
  });
  if (skipped.size) notCopied.push({entity: 'targeting', fields: [...skipped]});
  if (targeting.length)
    steps.push(
      step('targeting', 'google_ads_v23_campaign_criterion_mutate_campaign_criteria', targeting, ['campaign']),
    );
  groups.forEach((g, i) => {
    const group = g.adGroup as JsonObject,
      sid = 'adgroup_' + (i + 1);
    steps.push(
      step(
        sid,
        'google_ads_v23_ad_group_mutate_ad_groups',
        [
          {
            create: {
              name: group.name,
              campaign: ref('campaign'),
              status: group.status,
              type: group.type,
              ...(group.cpcBidMicros !== undefined ? {cpc_bid_micros: String(group.cpcBidMicros)} : {}),
            },
          },
        ],
        ['campaign'],
      ),
    );
    const kws = keywords
      .map(k => k.adGroupCriterion as JsonObject)
      .filter(k => k.adGroup === group.resourceName)
      .map(k => ({
        create: {
          ad_group: ref(sid),
          ...(k.negative ? {negative: true} : {status: k.status}),
          keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          ...(k.cpcBidMicros !== undefined && !k.negative ? {cpc_bid_micros: String(k.cpcBidMicros)} : {}),
        },
      }));
    if (kws.length)
      steps.push(step(sid + '_keywords', 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria', kws, [sid]));
    const rsas = ads
      .map(a => a.adGroupAd as JsonObject)
      .filter(a => a.adGroup === group.resourceName)
      .map(a => ({
        create: {
          ad_group: ref(sid),
          status: a.status,
          ad: {
            responsive_search_ad: {
              ...pick(a.ad?.responsiveSearchAd ?? {}, ['path1', 'path2']),
              ...Object.fromEntries(
                (['headlines', 'descriptions'] as const).map(k => [
                  k,
                  ((a.ad?.responsiveSearchAd?.[k] ?? []) as JsonObject[]).map(t => snakeKeys(pick(t, textFields))),
                ]),
              ),
            },
            final_urls: a.ad?.finalUrls ?? [],
          },
        },
      }));
    if (rsas.length) steps.push(step(sid + '_ads', 'google_ads_v23_ad_group_ad_mutate_ad_group_ads', rsas, [sid]));
  });
  return {
    steps,
    notCopied,
    source: {campaign_id: id, ad_groups: groups.length, keywords: keywords.length, ads: ads.length},
  };
}
/** The steps of a plan that recreates the source campaign under the new name. */
const cloneGateways = ['snapchat_native_action', 'google_ads_native_action'];
/** Checked before any connection is resolved, so an unsupported platform is named as such. */
export function assertCloneGateway(gateway: unknown) {
  if (!cloneGateways.includes(gateway as string))
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Snapchat and Google Search campaigns. Meta copies campaigns natively (meta copies); other platforms take explicit steps.',
      {field: 'gateway', supported: cloneGateways},
    );
}
export async function clonePlan(call: ToolCall, actor: Actor, input: JsonObject) {
  if (
    !obj(input.source) ||
    (typeof input.source.campaign_id !== 'string' && typeof input.source.campaign_id !== 'number')
  )
    throw new MirrorError('INVALID_ARGUMENT', 'Name the campaign to clone as source: {campaign_id}.', {
      field: 'source',
    });
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    throw new MirrorError('INVALID_ARGUMENT', 'Give the new campaign a name of 1–100 characters.', {field: 'name'});
  const cloned =
    input.gateway === 'snapchat_native_action'
      ? await snapchatClone(call, actor, input)
      : input.gateway === 'google_ads_native_action'
        ? await googleClone(call, actor, input)
        : undefined;
  if (!cloned) return assertCloneGateway(input.gateway) as never;
  // Steps whose uncopied fields are the same are listed once.
  const groups = new Map<string, JsonObject>();
  for (const n of cloned.notCopied) {
    const key = JSON.stringify(n.fields);
    const g = groups.get(key) ?? {fields: n.fields, steps: []};
    g.steps.push(n.entity);
    groups.set(key, g);
  }
  return {...cloned, notCopied: [...groups.values()]};
}
const isRef = (v: unknown) => obj(v) && Object.hasOwn(v, '$ref');
/**
 * The spec's changes. set: [{step_id, path, value}] sets one field of a step's arguments, by JSON pointer, including
 * a field the source did not have (such as placement_v2) when its parent exists; never the action or a $ref.
 * drop: [step_id] leaves a step out, with every step that depends on it. Nothing here is sent anywhere: each step
 * is still reviewed with every check before it is written.
 */
export function applyCloneChanges(steps: Step[], changes: unknown) {
  if (changes === undefined) return {steps, set: [] as JsonObject[], dropped: [] as string[]};
  if (!obj(changes) || Object.keys(changes).some(k => !['set', 'drop'].includes(k)))
    bad('changes is {set: [{step_id, path, value}], drop: [step_id]}.', 'INVALID_ARGUMENT', {field: 'changes'});
  const ids = steps.map(s => s.id as string),
    drop: unknown = changes.drop ?? [];
  if (!Array.isArray(drop) || drop.some(d => !ids.includes(d)))
    bad('changes.drop lists step IDs of this clone.', 'INVALID_ARGUMENT', {field: 'changes.drop', allowed: ids});
  const gone = new Set<string>(drop as string[]);
  // Steps are in dependency order, so one pass reaches every dependant.
  for (const s of steps) if ((s.depends_on as string[]).some(d => gone.has(d))) gone.add(s.id);
  const kept = steps.filter(s => !gone.has(s.id));
  if (!kept.length) bad('changes.drop leaves nothing to create.', 'INVALID_ARGUMENT', {field: 'changes.drop'});
  const set: unknown = changes.set ?? [];
  if (!Array.isArray(set) || set.length > 50)
    bad('changes.set is a list of at most 50 {step_id, path, value}.', 'INVALID_ARGUMENT', {field: 'changes.set'});
  const applied = (set as unknown[]).map((c, i) => {
    const where = 'changes.set[' + i + ']';
    if (!obj(c) || Object.keys(c).sort().join() !== 'path,step_id,value')
      bad(where + ' must be exactly {step_id, path, value}.', 'INVALID_ARGUMENT', {field: where});
    const step = kept.find(s => s.id === c.step_id);
    if (!step)
      bad(where + '.step_id ' + JSON.stringify(c.step_id) + ' is not a step of this clone.', 'INVALID_ARGUMENT', {
        field: where + '.step_id',
        allowed: kept.map(s => s.id),
      });
    const keys =
      typeof c.path === 'string' && /^(\/[^/]+)+$/.test(c.path)
        ? c.path
            .slice(1)
            .split('/')
            .map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
        : [];
    if (!keys.length || keys[0] === 'action' || keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)))
      bad(
        where +
          '.path must be a JSON pointer into the step’s arguments other than its action, such as "/payload/operations/0/create/amount_micros".',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    if (JSON.stringify(c.value ?? null).includes('"$ref"'))
      bad(where + '.value contains a $ref. Dependencies stay as the clone declares them.', 'INVALID_ARGUMENT', {
        field: where + '.value',
      });
    let parent: any = step.arguments;
    for (const k of keys.slice(0, -1)) {
      if (isRef(parent)) break;
      parent = Array.isArray(parent) ? (/^(0|[1-9][0-9]*)$/.test(k) ? parent[Number(k)] : undefined) : parent?.[k];
    }
    const last = keys.at(-1)!;
    if (isRef(parent) || JSON.stringify(parent?.[last] ?? null).includes('"$ref"'))
      bad(
        where + '.path ' + c.path + ' is, or holds, a $ref to a predecessor’s verified result; it cannot be set.',
        'INVALID_ARGUMENT',
        {
          field: where + '.path',
        },
      );
    const fits = Array.isArray(parent) ? /^(0|[1-9][0-9]*)$/.test(last) && Number(last) < parent.length : obj(parent);
    if (!fits)
      bad(
        where +
          '.path ' +
          c.path +
          ' does not lead into step ' +
          JSON.stringify(step.id) +
          '’s arguments: its parent must exist.',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    const added = !Array.isArray(parent) && !Object.hasOwn(parent, last);
    parent[last] = structuredClone(c.value);
    return {step_id: step.id, path: c.path, ...(added ? {added: true} : {})};
  });
  return {steps: kept, set: applied, dropped: steps.filter(s => gone.has(s.id)).map(s => s.id as string)};
}
