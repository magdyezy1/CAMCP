import {inBatches, type DetailParentReader, type DetailParentReads} from './report-source.js';
import type {JsonObject} from './types.js';
import type {MirrorError} from './errors.js';

const snapchatId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * RPT-07 (wave 4c round 6, w4c-arc6-reporting: moved from src/overview-parents.ts): Snapchat ads (campaign and ad
 * squad) of a source without a campaign read their parents by Snapchat's documented by-ID reads of the reported ads,
 * their ad squads and their campaigns in the source account; every campaign must name the source account.
 */
export const snapchatDetailParents: DetailParentReader = Object.freeze({
  bodyRefused(error: MirrorError) {
    const body = error.details.upstream;
    return (
      error.code === 'PLATFORM_ERROR' &&
      (error.details.http_status ?? error.status) === 200 &&
      error.details.provider_code === undefined &&
      obj(body) &&
      body.request_status === 'ERROR' &&
      !Object.hasOwn(body, 'error_code') &&
      !Object.hasOwn(body, 'error') &&
      !Object.hasOwn(body, 'errors')
    );
  },
  kind: (level: string, scoped: boolean, contract?: string) =>
    contract === 'overview-config-v4' && level === 'adset'
      ? 'snapchat_adsquad'
      : level === 'ad' && (!scoped || contract === 'overview-config-v4')
        ? 'snapchat_ad'
        : undefined,
  async read(
    kind: string,
    reading: string[],
    {account, read, record, shape, foreign, refused, name, reportingContract}: DetailParentReads,
  ) {
    const byIds = async (entities: 'ads' | 'adsquads' | 'campaigns', wantedIds: string[]) => {
      const rows: JsonObject[] = [],
        singular = {ads: 'ad', adsquads: 'adsquad', campaigns: 'campaign'}[entities];
      for (const batch of inBatches(wantedIds, 1000)) {
        const d = await read(
          'snapchat_' + singular + '_get_by_ids',
          '/v1/adaccounts/' + account + '/get_' + entities + '_by_ids',
          {},
          {entity_ids: batch.map(id => ({id}))},
        );
        if (d.request_status !== undefined && d.request_status !== 'SUCCESS')
          refused('Snapchat refused the parent read.');
        if (!Array.isArray(d[entities]) || d[entities].length > batch.length)
          shape('Snapchat returned malformed parent evidence.');
        const seen = new Set<string>();
        for (const entry of d[entities] as JsonObject[]) {
          if (!obj(entry)) shape('Snapchat returned malformed parent evidence.');
          // An entity Snapchat reports as not found stays unknown; it never borrows another record.
          if (entry.sub_request_status !== undefined && entry.sub_request_status !== 'SUCCESS') continue;
          const row = entry[singular];
          if (!obj(row) || !snapchatId(row.id) || !batch.includes(row.id) || seen.has(row.id))
            shape('Snapchat returned an unrequested or repeated parent record.');
          seen.add(row.id);
          rows.push(row);
        }
      }
      return rows;
    };
    if (kind === 'snapchat_adsquad') {
      const squads = await byIds('adsquads', reading),
        campaigns = new Map<string, JsonObject>();
      for (const squad of squads)
        if (!snapchatId(squad.campaign_id)) shape('Snapchat returned an ad squad without its campaign.');
      for (const campaign of await byIds('campaigns', [...new Set(squads.map(squad => String(squad.campaign_id)))])) {
        if (campaign.ad_account_id !== account) foreign('Snapchat returned a parent campaign of another ad account.');
        campaigns.set(campaign.id, campaign);
      }
      for (const squad of squads) {
        const campaign = campaigns.get(squad.campaign_id);
        if (!campaign) continue;
        record(squad.id, {campaign_id: campaign.id, campaign_name: name(campaign.name), entity_metadata: squad});
      }
      return;
    }
    const ads = await byIds('ads', reading);
    for (const ad of ads) if (!snapchatId(ad.ad_squad_id)) shape('Snapchat returned an ad without its ad squad.');
    const squads = new Map<string, JsonObject>();
    for (const squad of await byIds('adsquads', [...new Set(ads.map(ad => String(ad.ad_squad_id)))])) {
      if (!snapchatId(squad.campaign_id)) shape('Snapchat returned an ad squad without its campaign.');
      squads.set(String(squad.id), squad);
    }
    const campaigns = new Map<string, JsonObject>();
    for (const campaign of await byIds('campaigns', [
      ...new Set([...squads.values()].map(s => String(s.campaign_id))),
    ])) {
      if (campaign.ad_account_id !== account) foreign('Snapchat returned a parent campaign of another ad account.');
      campaigns.set(String(campaign.id), campaign);
    }
    for (const ad of ads) {
      const squad = squads.get(String(ad.ad_squad_id)),
        campaign = squad && campaigns.get(String(squad.campaign_id));
      // Without its ad squad and an owned campaign, the ad's parents stay unknown.
      if (!squad || !campaign) continue;
      record(String(ad.id), {
        ...(reportingContract === 'overview-config-v4'
          ? {optimization_goal: squad.optimization_goal ?? null, entity_metadata: ad}
          : {}),
        campaign_id: String(campaign.id),
        campaign_name: name(campaign.name),
        ...(typeof (campaign.objective_v2_properties?.objective_v2_type ?? campaign.objective) === 'string'
          ? {objective: campaign.objective_v2_properties?.objective_v2_type ?? campaign.objective}
          : {}),
        adset_id: String(squad.id),
        adset_name: name(squad.name),
      });
    }
  },
});
