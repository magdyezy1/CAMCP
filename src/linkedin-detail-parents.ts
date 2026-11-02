import {linkedInCampaignMetadata} from './linkedin-reporting.js';
import {linkedinVersion} from './linkedin-version.js';
import {MirrorError} from './errors.js';
import {inBatches, type DetailParentReader, type DetailParentReads} from './report-source.js';
import type {JsonObject} from './types.js';

const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,31})$/,
  campaignUrn = /^urn:li:sponsoredCampaign:([1-9][0-9]{0,31})$/;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Picked, account-owned creative metadata for the native detail source and the legacy parent reader. */
export async function linkedInCreativeMetadata(
  account: string,
  reading: string[],
  read: (query: JsonObject) => Promise<JsonObject>,
): Promise<JsonObject[]> {
  const owner = 'urn:li:sponsoredAccount:' + account,
    creatives: JsonObject[] = [];
  for (const batch of inBatches([...new Set(reading)], 100)) {
    for (const urn of batch)
      if (!creativeUrn.test(urn))
        throw new MirrorError('REPORT_SHAPE_CHANGED', 'LinkedIn did not report a native creative URN.', {}, 502);
    const d = await read({q: 'criteria', creatives: batch, pageSize: 100});
    if (
      !Array.isArray(d.elements) ||
      d.elements.length > batch.length ||
      (d.metadata !== undefined && (!obj(d.metadata) || d.metadata.nextPageToken)) ||
      d.paging?.links?.some?.((link: JsonObject) => link?.rel === 'next')
    )
      throw new MirrorError(
        'REPORT_SHAPE_CHANGED',
        'LinkedIn returned malformed or incomplete creative parents.',
        {},
        502,
      );
    const seen = new Set<string>();
    for (const row of d.elements as JsonObject[]) {
      if (!obj(row) || typeof row.id !== 'string' || !batch.includes(row.id) || seen.has(row.id))
        throw new MirrorError(
          'REPORT_SHAPE_CHANGED',
          'LinkedIn returned an unrequested or repeated creative.',
          {},
          502,
        );
      if (row.account !== owner)
        throw new MirrorError(
          'REPORT_ACCOUNT_MISMATCH',
          'LinkedIn returned a creative of another advertising account.',
          {},
          502,
        );
      if (typeof row.campaign !== 'string' || !campaignUrn.test(row.campaign))
        throw new MirrorError(
          'REPORT_SHAPE_CHANGED',
          'LinkedIn returned a creative without its exact campaign.',
          {},
          502,
        );
      seen.add(row.id);
      creatives.push({
        id: row.id,
        campaign: row.campaign,
        name: typeof row.name === 'string' && row.name.trim() && row.name.length <= 1000 ? row.name : null,
      });
    }
  }
  return creatives;
}

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
  async read(_kind: string, reading: string[], {account, read, record, name}: DetailParentReads) {
    const creatives = await linkedInCreativeMetadata(account, reading, query =>
      read(
        'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
        '/rest/adAccounts/' + account + '/creatives',
        query,
      ),
    );
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
