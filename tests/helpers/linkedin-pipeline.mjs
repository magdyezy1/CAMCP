import {MirrorError} from '../../dist/src/errors.js';
import {NativeCampaignReports} from '../../dist/src/report-native.js';
import {objectiveReportFixture} from './objective-report.mjs';
import {linkedinLevelAccount} from '../fixtures/linkedin-levels-docs.mjs';
import {linkedinConversionRulesPage} from '../fixtures/linkedin-conversion-rules-docs.mjs';

const nativeDate = day => {
  const [year, month, date] = day.split('-').map(Number);
  return {year, month, day: date};
};
const requestedRange = query => {
  const days = [...query.dateRange.matchAll(/year:(\d+),month:(\d+),day:(\d+)/g)].map(
    m => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
  );
  return {since: days[0], until: days[1]};
};
const ofIds = (records, urns) => urns.map(urn => records[urn.split(':').at(-1)]).filter(Boolean);

/**
 * The real overview pipeline (queue, worker, window rule, LinkedIn collector) over a synthetic LinkedIn that answers
 * from the reporting and account-structure shapes of tests/fixtures/linkedin-levels-docs.mjs.
 * `analytics(pivot, range)` returns the analytics elements of one request, without their date range; `groups`,
 * `campaigns` and `creatives` are the metadata records by numeric ID, and `conversions` the account's conversion rules
 * (the account finder's pages; none by default, as for an account without rules). A request whose path ends with one
 * of `refused` is refused with HTTP 403, as LinkedIn does for a login without the permission. Beside the fixture's
 * login `login` (which has no recorded permissions) the account has a second login, `linkedinConnection`, that holds the
 * permissions LinkedIn reporting and its conversion rules need; its ID is a UUID, as every connection ID is.
 */
export const linkedinConnection = 'aaaaaaaa-1111-4111-8111-111111111111';
export function linkedinPipeline(
  t,
  {analytics, groups = {}, campaigns = {}, creatives = {}, conversions = [], refused = []},
) {
  const f = objectiveReportFixture(t, {platform: 'linkedin'}),
    requests = [];
  f.store.putConnection(
    f.actor,
    {
      id: linkedinConnection,
      tenantId: f.actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: ['r_ads', 'r_ads_reporting'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  f.service.runPlan = async plan => {
    requests.push(structuredClone(plan));
    if (refused.some(suffix => plan.path.endsWith(suffix)))
      throw new MirrorError('UPSTREAM_ERROR', 'Synthetic LinkedIn refusal.', {http_status: 403}, 403);
    let data;
    if (plan.path === '/rest/adAccounts/100') data = linkedinLevelAccount;
    else if (plan.path === '/rest/conversions')
      data = linkedinConversionRulesPage(conversions, plan.query.start ?? 0, plan.query.count ?? 100);
    else if (plan.path === '/rest/adAnalytics') {
      const range = requestedRange(plan.query);
      data = {
        elements: analytics(plan.query.pivot, range).map(element => ({
          dateRange: {start: nativeDate(range.since), end: nativeDate(range.until)},
          ...element,
        })),
      };
    } else if (plan.path.endsWith('/adCampaignGroups'))
      data = {elements: ofIds(groups, plan.query.search.id.values), metadata: {}};
    else if (plan.path.endsWith('/adCampaigns'))
      data = {elements: ofIds(campaigns, plan.query.search.id.values), metadata: {}};
    else if (plan.path.endsWith('/creatives')) data = {elements: ofIds(creatives, plan.query.creatives), metadata: {}};
    else throw new Error('Unexpected synthetic LinkedIn path ' + plan.path);
    return {success: true, data: structuredClone(data)};
  };
  f.overview.native = new NativeCampaignReports(f.service);
  return {
    ...f,
    requests,
    /** The date range of every analytics request, in LinkedIn's own notation. */
    analyticsRanges: () => requests.filter(r => r.path === '/rest/adAnalytics').map(r => r.query.dateRange),
  };
}
