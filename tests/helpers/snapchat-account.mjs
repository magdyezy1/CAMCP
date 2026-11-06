import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularSource, granularConfig} from '../fixtures/overview-granularity-data.mjs';
import {
  snapchatEvidenceAccount,
  snapchatEvidenceCampaign,
  snapchatEvidenceEntity,
  snapchatEvidenceId,
  snapchatEvidenceResponse,
} from '../fixtures/snapchat-evidence-data.mjs';

// A synthetic Snapchat ad account of any size, answering like Snapchat's documented routes do: the campaign list in native
// cursor pages, a campaign's stats for the window requested, the by-ID reads of ad squads, ads and campaigns. Nothing leaves
// the process.
const riyadh = 3 * 3600000; // Asia/Riyadh has no daylight saving time
const localDate = ms => new Date(ms + riyadh).toISOString().slice(0, 10);
export const sampleRange = {since: '2026-09-01', until: '2026-09-02'};
export const campaignOf = i => snapchatEvidenceId(10000 + i);
export const squadOf = (i, k = 0) => snapchatEvidenceId(100000 + i * 100 + k);
export const adOf = (i, k = 0) => snapchatEvidenceId(2000000 + i * 100 + k);
const indexOf = (id, base) => {
  const n = Number(id.slice(-12)) - base;
  return {campaign: Math.floor(n / 100), k: n % 100};
};

export function snapchatAccount({
  campaigns: count,
  squads = 1,
  page = 100,
  deleted = () => false,
  status = () => 'ACTIVE',
  squadStatus = () => 'ACTIVE',
  unpaced = true,
} = {}) {
  const f = overviewGranularityFixture({unpaced}),
    list = Array.from({length: count}, (_, i) => ({
      id: campaignOf(i),
      ad_account_id: snapchatEvidenceAccount,
      name: 'Campaign ' + i,
      status: status(i),
      objective: 'TRAFFIC',
      deleted: deleted(i),
    })),
    byId = new Map(list.map(campaign => [campaign.id, campaign]));
  f.parents((_platform, _url, body) => {
    for (const entry of body.adsquads ?? []) {
      const {campaign, k} = indexOf(entry.adsquad.id, 100000);
      Object.assign(entry.adsquad, {
        campaign_id: campaignOf(campaign),
        name: 'Squad ' + campaign + '-' + k,
        status: squadStatus(campaign),
        deleted: deleted(campaign),
        optimization_goal: 'SWIPES',
      });
    }
    for (const entry of body.campaigns ?? []) {
      const campaign = byId.get(entry.campaign.id);
      if (campaign) Object.assign(entry.campaign, campaign);
    }
    for (const entry of body.ads ?? []) {
      const {campaign, k} = indexOf(entry.ad.id, 2000000);
      Object.assign(entry.ad, {ad_squad_id: squadOf(campaign, k), name: 'Ad ' + campaign + '-' + k, status: 'ACTIVE'});
    }
    return body;
  });
  /** The stats answer for the window of `url`: one day entry per day, whatever the window's length. */
  const stats = (url, parent, entities) => {
    const start = Date.parse(url.searchParams.get('start_time')),
      end = Date.parse(url.searchParams.get('end_time')),
      sem = {currency: 'USD', timezone: 'Asia/Riyadh', date_from: localDate(start), date_to: localDate(end - 86400000)},
      template = new URL(url);
    // The shared response builder answers a campaign's stats under its own parent; the account route is answered as it is.
    if (parent) template.pathname = '/v1/campaigns/' + snapchatEvidenceCampaign + '/stats';
    const level = url.searchParams.get('breakdown'),
      body = snapchatEvidenceResponse(
        template.href,
        entities.map(id => snapchatEvidenceEntity(level, id, sem)),
        sem,
      );
    if (parent) body.timeseries_stats[0].timeseries_stat.id = parent;
    return Response.json(body);
  };
  f.hook(url => {
    if (url.hostname !== 'adsapi.snapchat.com') throw Error('Unexpected synthetic host');
    if (url.pathname === '/v1/adaccounts/' + snapchatEvidenceAccount + '/campaigns') {
      const offset = Number(url.searchParams.get('cursor') ?? 0),
        next = new URL(url);
      next.searchParams.set('cursor', String(offset + page));
      return Response.json({
        request_status: 'SUCCESS',
        campaigns: list.slice(offset, offset + page).map(campaign => ({sub_request_status: 'SUCCESS', campaign})),
        paging: offset + page < count ? {next_link: next.href} : {},
      });
    }
    if (
      url.pathname === '/v1/adaccounts/' + snapchatEvidenceAccount + '/stats' &&
      url.searchParams.get('breakdown') === 'ad'
    ) {
      const ads = list.flatMap((_, i) => Array.from({length: squads}, (_, k) => adOf(i, k)));
      return stats(url, undefined, ads);
    }
    const match = /^\/v1\/campaigns\/([^/]+)(\/stats)?$/.exec(url.pathname);
    if (!match) return;
    const campaign = byId.get(match[1]);
    assert(campaign, 'a request for a campaign that is not in the account');
    if (!match[2])
      return Response.json({request_status: 'SUCCESS', campaigns: [{sub_request_status: 'SUCCESS', campaign}]});
    const i = Number(campaign.name.slice('Campaign '.length));
    return stats(
      url,
      campaign.id,
      Array.from({length: squads}, (_, k) => squadOf(i, k)),
    );
  });
  const source = (changes = {}) => {
    const level = changes.levels?.[0] ?? 'adset',
      {campaign_id, ...rest} = granularSource('snapchat', level);
    return {...rest, levels: [level], delivered_only: false, ...changes};
  };
  const config = ({grain = 'total', range = sampleRange, ...changes} = {}) => ({
    ...granularConfig(source(changes), grain),
    date_range: range,
    contract_version: 'overview-config-v4',
  });
  return {
    f,
    campaigns: list,
    config,
    source,
    /** How many requests so far went to a path. */
    count: pattern => f.requests.filter(request => pattern.test(request.url.pathname)).length,
    /** Queues the report, works it once and reads it back. */
    async run(options = {}) {
      const queued = await f.overview.handle({action: 'run', config: config(options), confirmed: true}, f.actor);
      assert.equal(await f.worker.once(), true);
      const report = await f.overview.handle(
        {action: 'get', id: queued.id, limit: 500, include: {native: true}},
        f.actor,
      );
      return {queued, report};
    },
    /** Every row of a report, read in pages of 500. */
    async rows(id) {
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        const page = await f.overview.handle({action: 'get', id, limit: 500, offset}, f.actor);
        rows.push(...page.rows);
        if (!page.has_more) return rows;
      }
    },
    close: () => f.close(),
  };
}
