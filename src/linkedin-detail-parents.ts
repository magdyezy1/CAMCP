import {linkedInCampaignMetadata} from './linkedin-reporting.js';
import {linkedinVersion} from './linkedin-version.js';
import {inBatches, type DetailParentReader, type DetailParentReads} from './report-source.js';
import type {JsonObject} from './types.js';

const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,31})$/,
  campaignUrn = /^urn:li:sponsoredCampaign:([1-9][0-9]{0,31})$/;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * RPT-07 (wave 4c round 6, w4c-arc6-reporting: moved from src/overview-parents.ts with LinkedIn's version read):
 * LinkedIn creatives (campaign) read their parents from the account's creatives criteria finder filtered by the
 * reported creative URNs (100 per page; every creative must name the source account), then the campaigns' current
 * names.
 */
export const linkedinDetailParents: DetailParentReader = Object.freeze({
  kind: (level: string) => (level === 'ad' ? 'linkedin_creative' : undefined),
  headers: () => ({
    'LinkedIn-Version': linkedinVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
    'X-RestLi-Method': 'FINDER',
  }),
  async read(_kind: string, reading: string[], {account, read, record, shape, foreign, name}: DetailParentReads) {
    const owner = 'urn:li:sponsoredAccount:' + account,
      creatives: JsonObject[] = [];
    for (const batch of inBatches(reading, 100)) {
      for (const urn of batch) if (!creativeUrn.test(urn)) shape('LinkedIn did not report a native creative URN.');
      const d = await read(
        'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
        '/rest/adAccounts/' + account + '/creatives',
        {q: 'criteria', creatives: batch, pageSize: 100},
      );
      if (
        !Array.isArray(d.elements) ||
        d.elements.length > batch.length ||
        (d.metadata !== undefined && (!obj(d.metadata) || d.metadata.nextPageToken)) ||
        d.paging?.links?.some?.((link: JsonObject) => link?.rel === 'next')
      )
        shape('LinkedIn returned malformed or incomplete creative parents.');
      const seen = new Set<string>();
      for (const row of d.elements as JsonObject[]) {
        if (!obj(row) || typeof row.id !== 'string' || !batch.includes(row.id) || seen.has(row.id))
          shape('LinkedIn returned an unrequested or repeated creative.');
        if (row.account !== owner) foreign('LinkedIn returned a creative of another advertising account.');
        if (typeof row.campaign !== 'string' || !campaignUrn.test(row.campaign))
          shape('LinkedIn returned a creative without its exact campaign.');
        seen.add(row.id);
        creatives.push(row);
      }
    }
    const named = creatives.length
      ? await linkedInCampaignMetadata(
          account,
          creatives.map(row => String(row.campaign)),
          query =>
            read(
              'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get',
              '/rest/adAccounts/' + account + '/adCampaigns',
              query,
            ),
        )
      : {campaigns: {} as Record<string, JsonObject>};
    for (const row of creatives)
      record(String(row.id), {
        campaign_id: campaignUrn.exec(String(row.campaign))![1]!,
        campaign_name: name(named.campaigns[String(row.campaign)]?.name),
      });
  },
});
