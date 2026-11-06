import {MirrorError} from './errors.js';
import {appleDetail} from './overview-native-detail.js';
import {detailParentsUnavailableWarning, optionalReadRefused, type ReportCollection} from './report-source.js';
import {appleQueryBounds, appleQueryPages, appleSafeId, type AppleList} from './apple-report-pages.js';
import type {JsonObject} from './types.js';

const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The provider requests of one period at the ad group or ad level (the fewest, as every list is its first page): the ad
 * account, the campaign report that finds the campaigns with activity (none when the scope names them), one report for
 * each campaign, and the parents of the rows (ad groups and campaigns, or ads, ad groups and campaigns).
 */
export const appleDetailRequests = (level: string, scopedCampaigns: number) =>
  1 + (scopedCampaigns ? 0 : 1) + (scopedCampaigns || 1) + (level === 'ad' ? 3 : 2);

const foreign = (message: string): never => {
  throw new MirrorError('REPORT_ACCOUNT_MISMATCH', message, {}, 502);
};

/**
 * The ad group and ad levels (RPT-07, Task 13). Apple's ad group and ad reports need the campaign ID in their filters, so
 * each campaign with activity in the window (found by the campaign report, or named by the scope) is read as a report of its
 * own, every report to its last page; the parents of the rows come from the account's own entity queries, in batches of
 * IDs, each to its last page. Whatever exceeds a bound (src/apple-report-pages.ts) refuses; nothing is shortened.
 */
export async function collectAppleDetail(c: ReportCollection) {
  const detail = c.detail === 'ad' ? 'ad' : 'adset',
    entity = detail === 'ad' ? 'ads' : 'adgroups',
    list: AppleList = detail === 'ad' ? 'ads' : 'ad groups',
    timeRange = {start: c.range.since, end: c.range.until, timeZone: 'UTC'},
    scope: unknown = c.source.campaign_ids,
    scoped = Array.isArray(scope) && scope.length > 0;
  let reportPages = 0,
    parentPages = 0;
  let campaigns: string[];
  if (scoped)
    campaigns = [
      ...new Set((scope as unknown[]).filter((id): id is string => typeof id === 'string' && appleSafeId(id))),
    ];
  else {
    const found = await appleQueryPages(c, {
      kind: 'report',
      list: 'campaigns',
      path: '/v1/reports/apps/campaigns/query',
      action: 'apple_ads_v1_reports_apps_campaigns',
      stage: 'campaign_population',
      body: {timeRange},
    });
    reportPages += found.pages;
    campaigns = [...new Set(found.rows.map(row => String(row.metadata?.id ?? '')))];
    if (campaigns.some(id => !appleSafeId(id)))
      throw new MirrorError(
        'REPORT_ID_MISSING',
        'The provider report did not include a safe campaign/resource identifier.',
        {},
        502,
      );
  }
  if (campaigns.length > appleQueryBounds.campaigns)
    throw new MirrorError(
      'REPORT_COLLECTION_LIMIT',
      'Apple reports are read one campaign at a time, and this report covers {count} campaigns; the most a report reads is {limit}. Choose fewer campaigns by campaign ID, or narrow the date range.',
      {},
      422,
      false,
      {count: campaigns.length, limit: appleQueryBounds.campaigns},
    );
  const raw: JsonObject[] = [];
  for (const campaign of campaigns) {
    const read = await appleQueryPages(
      c,
      {
        kind: 'report',
        list,
        path: '/v1/reports/apps/' + entity + '/query',
        action: 'apple_ads_v1_reports_apps_' + entity,
        stage: 'detail_report',
        body: {timeRange, filters: [{field: 'campaignId', operator: 'EQUALS', value: campaign}]},
      },
      appleQueryBounds.rows - raw.length,
    );
    reportPages += read.pages;
    for (const row of read.rows) {
      const metadata = row.metadata;
      if (object(metadata) && metadata.adAccountId !== undefined && String(metadata.adAccountId) !== c.account)
        foreign('Apple returned a report row of another advertising account.');
      if (object(metadata) && metadata.campaignId !== undefined && String(metadata.campaignId) !== campaign)
        foreign('Apple returned a report row of another campaign than the one requested.');
    }
    raw.push(...read.rows);
  }
  c.raw = raw;
  const distinct = (rows: JsonObject[], key: string) =>
      [...new Set(rows.map(row => String(row[key] ?? '')))].filter(appleSafeId),
    ids = distinct(
      raw.map(row => row.metadata ?? {}),
      'id',
    );
  const parents = async (kind: 'campaigns' | 'adgroups' | 'ads', wanted: string[]) => {
    const found: JsonObject[] = [],
      seen = new Set<string>(),
      names: Record<string, AppleList> = {campaigns: 'campaigns', adgroups: 'ad groups', ads: 'ads'};
    for (let at = 0; at < wanted.length; at += appleQueryBounds.ids_per_query) {
      const batch = wanted.slice(at, at + appleQueryBounds.ids_per_query),
        requested = new Set(batch),
        read = await appleQueryPages(c, {
          kind: 'entities',
          list: names[kind]!,
          path: '/v1/' + kind + '/query',
          action: 'apple_ads_v1_' + kind + '_query',
          stage: 'detail_parents',
          body: {filters: [{field: 'id', operator: 'IN', value: batch.map(Number)}]},
        });
      parentPages += read.pages;
      for (const record of read.rows) {
        const id = String(record.id ?? '');
        if (!requested.has(id) || seen.has(id))
          throw new MirrorError(
            'REPORT_SHAPE_CHANGED',
            'Apple returned an unrequested or repeated parent record.',
            {},
            502,
          );
        seen.add(id);
        found.push(record);
      }
    }
    return found;
  };
  let lists = {campaigns: [] as JsonObject[], adGroups: [] as JsonObject[], ads: [] as JsonObject[]};
  try {
    const ads = detail === 'ad' ? await parents('ads', ids) : [],
      adGroups = await parents('adgroups', detail === 'ad' ? distinct(ads, 'adGroupId') : ids),
      campaignRecords = await parents('campaigns', [
        ...new Set([...distinct(adGroups, 'campaignId'), ...distinct(ads, 'campaignId')]),
      ]);
    lists = {campaigns: campaignRecords, adGroups, ads};
  } catch (e) {
    // Only a provider refusal of these reads keeps the rows with unknown parents (as for other detail levels).
    if (!optionalReadRefused(e)) throw e;
    c.warnings.push(detailParentsUnavailableWarning);
  }
  c.resultDefinition = 'Apple total attributed installs (tap + view); totalMetrics';
  c.detailRows = appleDetail(
    detail,
    c.raw,
    lists,
    c.currency,
    c.detailRounding,
    c.source.reporting_contract === 'overview-config-v4' ? {account: c.account} : undefined,
  );
  c.context.native_population = {
    basis: scoped ? 'scope' : 'campaign_report',
    campaigns_observed: campaigns.length,
    rows: raw.length,
    report_pages: reportPages,
    parent_pages: parentPages,
    complete: true,
    bounds: {...appleQueryBounds},
  };
}
