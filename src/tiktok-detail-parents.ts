import {inBatches, type DetailParentReader, type DetailParentReads} from './report-source.js';
import type {JsonObject} from './types.js';

const tiktokId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * RPT-07 (wave 4c round 6, w4c-arc6-reporting: moved from src/overview-parents.ts): TikTok ad groups (campaign) and
 * ads (campaign and ad group) read their parents from the advertiser's own ad group and ad reads filtered by the
 * reported IDs with primary_status STATUS_ALL, so a deleted entity with history keeps its parents; then the parents'
 * names. At most 100 IDs per request.
 */
export const tiktokDetailParents: DetailParentReader = Object.freeze({
  kind: (level: string) => (level === 'adset' ? 'tiktok_adgroup' : level === 'ad' ? 'tiktok_ad' : undefined),
  async read(
    kind: string,
    reading: string[],
    {account, read, record, shape, foreign, refused, name, reportingContract}: DetailParentReads,
  ) {
    const resultFields = reportingContract === 'overview-config-v4' ? ['optimization_goal', 'optimization_event'] : [];
    const list = async (entity: 'campaign' | 'adgroup' | 'ad', wantedIds: string[], fields: string[]) => {
      const rows: JsonObject[] = [];
      for (const batch of inBatches(wantedIds, 100)) {
        const d = await read('tiktok_' + entity + '_get', '/v1.3/' + entity + '/get/', {
          advertiser_id: account,
          filtering: {[entity + '_ids']: batch, primary_status: 'STATUS_ALL'},
          fields: ['advertiser_id', ...fields],
          page: 1,
          page_size: 100,
        });
        if (d.code !== 0) refused('TikTok refused the parent read.');
        const page = d.data;
        if (
          !obj(page) ||
          !Array.isArray(page.list) ||
          page.list.length > batch.length ||
          (page.page_info !== undefined &&
            (!obj(page.page_info) ||
              Number(page.page_info.total_number) > batch.length ||
              Number(page.page_info.total_page) > 1))
        )
          shape('TikTok returned malformed or incomplete parent evidence.');
        const seen = new Set<string>();
        for (const row of page.list as JsonObject[]) {
          const id = row?.[entity + '_id'];
          if (!obj(row) || !tiktokId(id) || !batch.includes(id) || seen.has(id))
            shape('TikTok returned an unrequested or repeated parent record.');
          if (row.advertiser_id !== undefined && row.advertiser_id !== account)
            foreign('TikTok returned a parent record of another advertiser.');
          seen.add(id);
          rows.push(row);
        }
      }
      return rows;
    };
    const child = kind === 'tiktok_ad' ? 'ad' : 'adgroup',
      children = await list(
        child,
        reading,
        child === 'ad' ? ['campaign_id', 'adgroup_id', 'ad_id'] : ['campaign_id', 'adgroup_id', ...resultFields],
      );
    for (const row of children)
      if (!tiktokId(row.campaign_id) || (child === 'ad' && !tiktokId(row.adgroup_id)))
        shape('TikTok returned a record without its exact native parents.');
    const groupIds = child === 'ad' ? [...new Set(children.map(row => String(row.adgroup_id)))] : [],
      groups = new Map<string, JsonObject>();
    for (const row of groupIds.length
      ? await list('adgroup', groupIds, ['campaign_id', 'adgroup_id', 'adgroup_name', ...resultFields])
      : [])
      groups.set(String(row.adgroup_id), row);
    const campaigns = new Map<string, JsonObject>();
    for (const row of await list(
      'campaign',
      [...new Set(children.map(row => String(row.campaign_id)))],
      ['campaign_id', 'campaign_name', 'objective_type'],
    ))
      campaigns.set(String(row.campaign_id), row);
    for (const row of children) {
      const group = groups.get(String(row.adgroup_id));
      // An ad whose ad group names another campaign is a changed hierarchy, never a choice between the two.
      if (child === 'ad' && group && group.campaign_id !== row.campaign_id)
        foreign('The detailed entity changed native parents during collection.');
      record(String(row[child + '_id']), {
        ...(reportingContract === 'overview-config-v4'
          ? {
              optimization_goal: (child === 'ad' ? group : row)?.optimization_goal ?? null,
              optimization_event: (child === 'ad' ? group : row)?.optimization_event ?? null,
            }
          : {}),
        campaign_id: String(row.campaign_id),
        campaign_name: name(campaigns.get(String(row.campaign_id))?.campaign_name),
        ...(typeof campaigns.get(String(row.campaign_id))?.objective_type === 'string'
          ? {objective: campaigns.get(String(row.campaign_id))!.objective_type}
          : {}),
        ...(child === 'ad' ? {adset_id: String(row.adgroup_id), adset_name: name(group?.adgroup_name)} : {}),
      });
    }
  },
});
