import type {JsonObject} from './types.js';
import {fingerprint} from './workspace-core.js';

export const pmaxBrandImageFields = [
  'campaign_asset.campaign',
  'campaign_asset.asset',
  'campaign_asset.field_type',
  'campaign_asset.status',
  'campaign.id',
  'campaign.resource_name',
  'campaign.name',
  'campaign.status',
  'campaign.advertising_channel_type',
  'campaign.brand_guidelines_enabled',
];
export const pmaxBrandImageRoles = new Set(['LOGO', 'LANDSCAPE_LOGO']);
type Projection = {
  account: string;
  mediaId: string;
  id: (v: unknown) => v is string;
  only: (v: unknown, keys: string[]) => JsonObject;
  known: (resource: string, field: string, value: unknown) => string | null;
  invalid: (message: string) => never;
};
/** A selected campaign logo association does not establish ad/group identity or serving. */
export function projectPmaxBrandImageLinks(rows: JsonObject[], context: Projection) {
  const {account, mediaId, id, only, known, invalid} = context,
    identities = new Set<string>();
  return rows
    .map(raw => {
      const r = only(raw, ['campaignAsset', 'campaign']),
        v = only(r.campaignAsset, ['campaign', 'asset', 'fieldType', 'status']),
        c = only(r.campaign, [
          'id',
          'resourceName',
          'name',
          'status',
          'advertisingChannelType',
          'brandGuidelinesEnabled',
        ]);
      if (
        !id(c.id) ||
        c.resourceName !== 'customers/' + account + '/campaigns/' + c.id ||
        v.campaign !== c.resourceName ||
        v.asset !== mediaId ||
        (c.name != null &&
          (typeof c.name !== 'string' ||
            [...c.name].length < 1 ||
            [...c.name].length > 512 ||
            /[\u0000-\u001f\ud800-\udfff]/u.test(c.name)))
      )
        invalid('Google returned a foreign, inconsistent or malformed Performance Max campaign-logo identity.');
      const channel = known('Campaign', 'advertisingChannelType', c.advertisingChannelType),
        campaignStatus = known('Campaign', 'status', c.status),
        role = known('CampaignAsset', 'fieldType', v.fieldType),
        status = known('CampaignAsset', 'status', v.status),
        identity = fingerprint([c.resourceName, role]);
      if (channel !== 'PERFORMANCE_MAX' || c.brandGuidelinesEnabled !== true || campaignStatus === 'REMOVED')
        invalid(
          'Google did not return a current original-account Performance Max campaign with enabled brand guidelines.',
        );
      if (identities.has(identity)) invalid('Google returned a repeated Performance Max campaign-logo link.');
      identities.add(identity);
      return {
        campaign_id: c.id,
        campaign_resource_name: c.resourceName,
        name: c.name ?? c.id,
        field_type: role,
        media_id: v.asset,
        match_field: 'campaign_asset.asset',
        link_status: status,
        campaign_status: campaignStatus,
        brand_guidelines_enabled: true,
      };
    })
    .sort(
      (a, b) =>
        a.campaign_resource_name.localeCompare(b.campaign_resource_name) ||
        String(a.field_type).localeCompare(String(b.field_type)),
    );
}

export const pmaxBrandImageMeaning =
  'Current configured original-image campaign logo links in the selected Performance Max brand-guidelines view and original upload account. Brand guidelines must be explicitly enabled. Enabled and paused LOGO or LANDSCAPE_LOGO links remain separate native configurations; removed links are counted separately, and missing roles or statuses remain unknown. Campaign links are not individual ads or asset groups. This view excludes asset-group links, ad-image links, other associations and video. It does not prove serving, policy approval, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.';
