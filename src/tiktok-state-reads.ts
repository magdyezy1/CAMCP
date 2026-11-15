/**
 * TikTok's state reads of a reviewed campaign, ad group or ad write no family plans (ARC-01 phase B, wave 4c: its
 * adapter's `writes.snapshots`, moved verbatim from src/write-snapshots.ts, which asks it where it named TikTok): a
 * create reads the advertiser and its exact parent, an edit reads its exact targets, and either reads the custom
 * conversion and CTA portfolios it references.
 */
import type {CompiledRequest, DeclaredOperation} from './types.js';
import type {StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {object, fail} from './write-common.js';
import {tiktokAdgroupConversionRead} from './tiktok-adgroup-conversions.js';
import {tiktokCtaPortfolioReads} from './tiktok-cta-portfolios.js';

/**
 * What a TikTok write does for the review's summary beyond the verb its path ends in (R2.5 S2-2, S3-2): the verb create is
 * read from the path, and so are update and delete, but a negative keyword is added with …/negative_keyword/add/, a create
 * the path rules did not know, and an ad create makes one ad for each of the creatives it lists (a Smart+ ad holds its
 * creatives in one ad, so its creative_list counts nothing).
 */
export function tiktokOperation(plan: CompiledRequest): DeclaredOperation | undefined {
  if (plan.method !== 'POST') return undefined;
  if (/\/negative_keyword\/add\/$/.test(plan.path)) return {operation: 'create', entity: 'negative keyword'};
  if (plan.path === '/v1.3/ad/create/') {
    const creatives = object(plan.body).creatives;
    return {operation: 'create', count: Array.isArray(creatives) ? creatives.length : undefined};
  }
  return undefined;
}

export function tiktokStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] {
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
  const match = /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
  if (!match) fail('WRITE_CONTRACT_UNAVAILABLE', 'This TikTok action has no implemented state-read contract.');
  if (match[2] === 'create') {
    const reads = [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
      parent = match[1] === 'adgroup' ? 'campaign' : match[1] === 'ad' ? 'adgroup' : undefined;
    if (parent) {
      const parentId = body[parent + '_id'];
      if (typeof parentId !== 'string' || !/^\d+$/.test(parentId))
        fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
      const read = base('/v1.3/' + parent + '/get/', {
        advertiser_id: id,
        filtering: {[parent + '_ids']: [parentId]},
        page_size: 100,
      });
      read.action = 'tiktok_' + parent + '_get';
      reads.push(read);
    }
    const conversion = tiktokAdgroupConversionRead(plan);
    if (conversion) {
      const read = base(conversion.path, conversion.query);
      read.action = conversion.action;
      reads.push(read);
    }
    for (const r of tiktokCtaPortfolioReads(plan)) {
      const read = base(r.path, r.query);
      read.action = r.action;
      reads.push(read);
    }
    return reads;
  }
  const kind = match[1]!,
    ids = body[kind + '_ids'] ?? (body[kind + '_id'] ? [body[kind + '_id']] : undefined);
  if (!Array.isArray(ids) || !ids.length || ids.length > 25 || ids.some(v => typeof v !== 'string' || !/^\d+$/.test(v)))
    fail('MISSING_PARAMETER', 'Supply 1–25 exact ' + kind + ' IDs.');
  const read = base('/v1.3/' + kind + '/get/', {
    advertiser_id: id,
    filtering: {[kind + '_ids']: ids},
    page_size: 100,
  });
  read.action = 'tiktok_' + kind + '_get';
  return [
    read,
    ...tiktokCtaPortfolioReads(plan).map(r => {
      const portfolio = base(r.path, r.query);
      portfolio.action = r.action;
      return portfolio;
    }),
  ];
}
