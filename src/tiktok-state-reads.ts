/**
 * TikTok's state reads of a reviewed campaign, ad group or ad write no family plans (ARC-01 phase B, wave 4c: its
 * adapter's `writes.snapshots`, moved verbatim from src/write-snapshots.ts, which asks it where it named TikTok): a
 * create reads the advertiser and its exact parent, an edit reads its exact targets, and either reads the custom
 * conversion and CTA portfolios it references.
 */
import type {CompiledRequest} from './types.js';
import type {StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {object, fail} from './write-common.js';
import {tiktokAdgroupConversionRead} from './tiktok-adgroup-conversions.js';
import {tiktokAdvertiserRead} from './tiktok-advertiser-state.js';
import {tiktokCtaPortfolioReads} from './tiktok-cta-portfolios.js';

export function tiktokStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] {
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
  const match = /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
  if (!match) fail('WRITE_CONTRACT_UNAVAILABLE', 'This TikTok action has no implemented state-read contract.');
  if (match[2] === 'create') {
    const reads = [tiktokAdvertiserRead(base, id)],
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
