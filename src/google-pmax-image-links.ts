import type {JsonObject} from './types.js';
import {fingerprint} from './workspace-core.js';

export const pmaxImageFields = [
  'asset_group_asset.asset_group',
  'asset_group_asset.asset',
  'asset_group_asset.field_type',
  'asset_group_asset.status',
  'asset_group.id',
  'asset_group.resource_name',
  'asset_group.name',
  'asset_group.campaign',
  'asset_group.status',
  'campaign.id',
  'campaign.resource_name',
  'campaign.status',
  'campaign.advertising_channel_type',
];
type Projection = {
  account: string;
  mediaId: string;
  id: (v: unknown) => v is string;
  only: (v: unknown, keys: string[]) => JsonObject;
  known: (resource: string, field: string, value: unknown) => string | null;
  invalid: (message: string) => never;
};
/** A configured asset-group association is not an ad identity or a serving/performance verdict. */
export function projectPmaxImageLinks(rows: JsonObject[], context: Projection) {
  const {account, mediaId, id, only, known, invalid} = context,
    identities = new Set<string>();
  return rows
    .map(raw => {
      const r = only(raw, ['assetGroupAsset', 'assetGroup', 'campaign']),
        v = only(r.assetGroupAsset, ['assetGroup', 'asset', 'fieldType', 'status']),
        g = only(r.assetGroup, ['id', 'resourceName', 'name', 'campaign', 'status']),
        c = only(r.campaign, ['id', 'resourceName', 'status', 'advertisingChannelType']);
      if (
        !id(c.id) ||
        !id(g.id) ||
        c.resourceName !== 'customers/' + account + '/campaigns/' + c.id ||
        g.resourceName !== 'customers/' + account + '/assetGroups/' + g.id ||
        g.campaign !== c.resourceName ||
        v.assetGroup !== g.resourceName ||
        v.asset !== mediaId ||
        (g.name != null &&
          (typeof g.name !== 'string' ||
            [...g.name].length < 1 ||
            [...g.name].length > 128 ||
            /[\u0000-\u001f\ud800-\udfff]/u.test(g.name)))
      )
        invalid('Google returned a foreign, inconsistent or malformed Performance Max image-link identity.');
      const channel = known('Campaign', 'advertisingChannelType', c.advertisingChannelType),
        groupStatus = known('AssetGroup', 'status', g.status),
        campaignStatus = known('Campaign', 'status', c.status),
        role = known('AssetGroupAsset', 'fieldType', v.fieldType),
        status = known('AssetGroupAsset', 'status', v.status),
        identity = fingerprint([g.resourceName, role]);
      if (channel !== 'PERFORMANCE_MAX' || groupStatus === 'REMOVED' || campaignStatus === 'REMOVED')
        invalid('Google did not return a current original-account Performance Max image-link hierarchy.');
      if (identities.has(identity)) invalid('Google returned a repeated Performance Max asset-group image link.');
      identities.add(identity);
      return {
        asset_group_id: g.id,
        asset_group_resource_name: g.resourceName,
        name: g.name ?? g.id,
        campaign_id: c.id,
        field_type: role,
        media_id: v.asset,
        match_field: 'asset_group_asset.asset',
        link_status: status,
        asset_group_status: groupStatus,
        campaign_status: campaignStatus,
      };
    })
    .sort(
      (a, b) =>
        a.asset_group_resource_name.localeCompare(b.asset_group_resource_name) ||
        String(a.field_type).localeCompare(String(b.field_type)),
    );
}

export const pmaxImageMeaning =
  'Current configured image links in the selected Performance Max asset-group view and original upload account. Enabled and paused links remain separate native configurations; removed links are counted separately, and missing roles or statuses remain unknown. Asset groups are not individual ads. This view excludes campaign-level brand-guideline logos, Responsive Display, other associations and video. It does not prove serving, policy approval, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.';
