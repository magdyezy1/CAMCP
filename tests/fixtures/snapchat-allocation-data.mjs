import {allocationReport} from './allocation-data.mjs';
import {
  snapchatEvidenceInput as input,
  snapchatEvidenceId as id,
  snapchatEvidenceCampaign as campaign,
} from './snapchat-evidence-data.mjs';
export const snapchatAllocationIds = [id(10), id(20)];
export function snapchatAllocationData() {
  const report = allocationReport(),
    ids = snapchatAllocationIds;
  Object.assign(report, {
    gateway: 'snapchat_native_action',
    preset: 'snapchat_adsquad',
    grain: 'ad squad × day',
    account_id: input.account_id,
    connection_id: input.connection_id,
  });
  report.rows.forEach(r => (r.entity_id = r.entity_id === '10' ? ids[0] : ids[1]));
  report.source_request = {
    action: 'snapchat_campaign_stats_get',
    path_params: {campaign_id: campaign},
    query: {breakdown: 'adsquad'},
  };
  report.native_account_evidence = {
    parent_campaign: {id: campaign, account_id: input.account_id, checks: [{source_hash: 'synthetic-parent'}]},
  };
  const account = {id: input.account_id, currency: 'USD', timezone: 'UTC'},
    parent = {
      id: campaign,
      ad_account_id: input.account_id,
      name: 'Parent',
      status: 'PAUSED',
      buy_model: 'AUCTION',
      pacing_level: 'AD_SQUAD',
    };
  const squads = ids.map((id, i) => ({
    id,
    campaign_id: campaign,
    ad_account_id: input.account_id,
    name: i === 0 ? 'Efficient' : 'Established',
    status: 'PAUSED',
    type: 'SNAP_ADS',
    billing_event: 'IMPRESSION',
    optimization_goal: 'PIXEL_PURCHASE',
    delivery_constraint: 'DAILY_BUDGET',
    daily_budget_micro: 200000000,
    lifetime_budget_micro: 0,
    bid_strategy: 'AUTO_BID',
    auto_bid: true,
    target_bid: false,
    targeting: {geos: [{country_code: 'us'}]},
    placement_v2: {config: 'AUTOMATIC'},
  }));
  const options = {
    budget: '200',
    allocations: ids.map((entity_id, i) => ({entity_id, minimum: '50', maximum: i === 0 ? '125' : '150'})),
    efficiency_low: 0.8,
    efficiency_high: 1.2,
    minimum_conversions: 10,
    maximum_age_days: 7,
  };
  const wrap = (group, rows) => ({
    request_status: 'SUCCESS',
    [group]: rows.map(row => ({sub_request_status: 'SUCCESS', [group.slice(0, -1)]: row})),
  });
  const response = url => {
    const path = new URL(url).pathname;
    if (path === '/v1/adaccounts/' + account.id) return wrap('adaccounts', [account]);
    if (path === '/v1/adaccounts/' + account.id + '/campaigns') return wrap('campaigns', [parent]);
    if (path === '/v1/campaigns/' + campaign) return wrap('campaigns', [parent]);
    if (path === '/v1/adaccounts/' + account.id + '/adsquads') return wrap('adsquads', squads);
    const squad = squads.find(s => path === '/v1/adsquads/' + s.id);
    if (squad) return wrap('adsquads', [squad]);
    throw Error('Unexpected synthetic request: ' + path);
  };
  return {report, options, account, parent, squads, response, wrap};
}
