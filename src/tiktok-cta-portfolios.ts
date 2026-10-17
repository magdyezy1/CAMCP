import {normalizeAccount} from './account-id.js';
import {responseData, assertNoMethodOverride, object} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Dynamic call-to-action portfolios, per API for Business v1.3 "Create a portfolio", "Get a portfolio by ID", "Get
 * recommended CTAs" and "CTA recommendations" (checked 2026-09-26). A CTA portfolio holds groups of auto-optimized
 * CTAs returned by /creative/cta/recommend/ for this advertiser; manual ads use it through call_to_action_id, and
 * TikTok ignores call_to_action when both are sent. Cards, stickers, showcase, gesture and superlike portfolios are
 * outside this contract. A portfolio has no update endpoint, and the portfolio list omits CTA portfolios.
 */
export const tiktokPortfolioCreatePath = '/v1.3/creative/portfolio/create/';
export const tiktokPortfolioGetPath = '/v1.3/creative/portfolio/get/';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,31}$/.test(v);
const maxGroups = 20,
  maxIds = 20;

export const tiktokCtaPortfolioKind = (p: CompiledRequest) =>
  p.gateway === 'tiktok_native_action' && p.method === 'POST' && p.path === tiktokPortfolioCreatePath;

function invalid(field: string, message: string): never {
  throw new MirrorError('INVALID_TIKTOK_CTA_PORTFOLIO', message, {field});
}
/** CTA text as a comparison key: the documented create input reads "Learn More" and the documented read-back "learn_more". */
const ctaKey = (v: unknown) =>
  typeof v === 'string'
    ? v
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '_')
    : null;
const order = (a: unknown, b: unknown) => {
  const x = JSON.stringify(a),
    y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
/** CTA groups as sets: text keys, each with its sorted CTA IDs. Idempotent, so saved review state compares stably. */
const groupsOf = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map(g =>
      obj(g)
        ? {
            asset_content: ctaKey(g.asset_content),
            asset_ids: Array.isArray(g.asset_ids) ? g.asset_ids.map(String).sort() : [],
          }
        : {asset_content: null, asset_ids: []},
    )
    .sort(order);

/** Validates the request before review; nothing here reads or contacts TikTok. */
export function assertTiktokCtaPortfolio(plan: CompiledRequest, body: JsonObject): void {
  const extra = Object.keys(body).find(
    k => !['advertiser_id', 'creative_portfolio_type', 'portfolio_content'].includes(k),
  );
  if (extra)
    invalid(extra, '"' + extra + '" belongs to a portfolio type outside the qualified CTA portfolio contract.');
  if (body.advertiser_id !== undefined && String(body.advertiser_id) !== plan.accountId)
    invalid('advertiser_id', 'advertiser_id must equal the selected advertiser.');
  if (body.creative_portfolio_type !== 'CTA')
    invalid(
      'creative_portfolio_type',
      'Set creative_portfolio_type to CTA; card, sticker, showcase, gesture and superlike portfolios are not qualified.',
    );
  const groups = body.portfolio_content;
  if (!Array.isArray(groups) || !groups.length || groups.length > maxGroups)
    invalid(
      'portfolio_content',
      'portfolio_content must list 1-' + maxGroups + ' CTA groups returned by /creative/cta/recommend/.',
    );
  const texts = new Set<string>(),
    ids = new Set<string>();
  groups.forEach((g: unknown, i: number) => {
    const at = 'portfolio_content[' + i + ']';
    if (!obj(g)) invalid(at, 'Each CTA group is an object with asset_content and asset_ids.');
    const key = Object.keys(g).find(k => !['asset_content', 'asset_ids'].includes(k));
    if (key) invalid(at + '.' + key, 'A CTA group has only asset_content and asset_ids.');
    if (
      typeof g.asset_content !== 'string' ||
      !g.asset_content.trim() ||
      [...g.asset_content].length > 100 ||
      /[\x00-\x1f]/.test(g.asset_content)
    )
      invalid(at + '.asset_content', 'asset_content is the CTA text returned with the IDs, for example "Learn more".');
    const text = ctaKey(g.asset_content)!;
    if (texts.has(text)) invalid(at + '.asset_content', 'Each CTA text appears once.');
    texts.add(text);
    if (
      !Array.isArray(g.asset_ids) ||
      !g.asset_ids.length ||
      g.asset_ids.length > maxIds ||
      !g.asset_ids.every(numeric)
    )
      invalid(
        at + '.asset_ids',
        'asset_ids must be 1-' + maxIds + ' CTA IDs as numeric strings, as /creative/cta/recommend/ returns them.',
      );
    for (const id of g.asset_ids) {
      if (ids.has(id)) invalid(at + '.asset_ids', 'CTA ID ' + id + ' appears more than once.');
      ids.add(id);
    }
  });
}

/** The CTA portfolios that manual ad creatives name, after refusing call_to_action beside them (TikTok would ignore it). */
export function tiktokCtaReferences(plan: CompiledRequest): string[] {
  if (
    plan.gateway !== 'tiktok_native_action' ||
    plan.method !== 'POST' ||
    !['/v1.3/ad/create/', '/v1.3/ad/update/'].includes(plan.path) ||
    !obj(plan.body) ||
    !Array.isArray(plan.body.creatives)
  )
    return [];
  const out = new Set<string>();
  plan.body.creatives.forEach((c: unknown, i: number) => {
    if (!obj(c) || c.call_to_action_id === undefined) return;
    if (!numeric(c.call_to_action_id))
      invalid(
        'creatives[' + i + '].call_to_action_id',
        'call_to_action_id must be the numeric ID of a CTA portfolio in this advertiser.',
      );
    if (c.call_to_action !== undefined)
      invalid(
        'creatives[' + i + '].call_to_action',
        'Send call_to_action or call_to_action_id, not both; TikTok ignores call_to_action when call_to_action_id is set.',
      );
    out.add(c.call_to_action_id);
  });
  return [...out];
}
export function tiktokCtaPortfolioReads(plan: CompiledRequest) {
  return tiktokCtaReferences(plan).map(id => ({
    path: tiktokPortfolioGetPath,
    query: {advertiser_id: plan.accountId, creative_portfolio_id: id},
    action: 'tiktok_creative_portfolio_get',
  }));
}
export function validateTiktokCtaPortfolioState(
  read: CompiledRequest,
  data: JsonObject,
  sameIds: (actual: unknown[], expected: unknown[]) => void,
): boolean {
  if (read.gateway !== 'tiktok_native_action' || read.path !== tiktokPortfolioGetPath) return false;
  if (data.code !== 0 || !obj(data.data))
    throw new MirrorError(
      'STATE_READ_FAILED',
      'TikTok portfolio state must confirm success and contain the portfolio.',
    );
  if (data.data.creative_portfolio_id !== undefined)
    sameIds([data.data.creative_portfolio_id], [read.query.creative_portfolio_id]);
  return true;
}
/** Review state of a portfolio read. The documented read-back may omit the ID and type, so the ID comes from the read. */
export function tiktokCtaPortfolioState(read: CompiledRequest, data: JsonObject): JsonObject {
  return {
    creative_portfolio_id: String(read.query.creative_portfolio_id),
    creative_portfolio_type: data.creative_portfolio_type ?? null,
    portfolio_content: groupsOf(data.portfolio_content),
  };
}
/** A named portfolio was returned in the state read and holds CTAs. */
export function tiktokCtaPortfolioCheck(id: string, values: unknown[], field: string): void {
  const p = values
    .map(v => (obj(v) && obj(v.data) ? v.data : undefined))
    .find(d => d?.creative_portfolio_id === id && Object.hasOwn(d, 'portfolio_content'));
  if (!p || !Array.isArray(p.portfolio_content) || !p.portfolio_content.length)
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'CTA portfolio ' + id + ' was not returned for the selected advertiser.',
      {call_to_action_id: id},
    );
  const cta =
    (p.creative_portfolio_type === null || p.creative_portfolio_type === 'CTA') &&
    p.portfolio_content.every(
      (g: JsonObject) => typeof g?.asset_content === 'string' && Array.isArray(g.asset_ids) && g.asset_ids.length > 0,
    );
  if (!cta)
    invalid(
      field,
      'Portfolio ' +
        id +
        ' is ' +
        (p.creative_portfolio_type ? 'a ' + p.creative_portfolio_type : 'not a CTA') +
        ' portfolio; call_to_action_id needs a CTA portfolio.',
    );
}
/** Checked against the state read before review and again before execution: each named portfolio exists here and holds CTAs. */
export function tiktokCtaPortfolioPrerequisites(plan: CompiledRequest, values: unknown[]): void {
  for (const id of tiktokCtaReferences(plan)) tiktokCtaPortfolioCheck(id, values, 'call_to_action_id');
}
export function tiktokCtaPortfolioImpact(plan: CompiledRequest): JsonObject {
  const groups = (plan.body as JsonObject).portfolio_content as JsonObject[];
  return {
    provider: 'tiktok',
    scope: 'cta_portfolios',
    may_affect_serving: false,
    effect:
      'Creates a dynamic CTA portfolio. Nothing changes in delivery until an ad sets call_to_action_id to its ID; the portfolio cannot be edited afterwards.',
    portfolio: {
      creative_portfolio_type: 'CTA',
      groups: groups.map(g => ({asset_content: g.asset_content, cta_ids: (g.asset_ids as string[]).length})),
    },
    source: 'https://business-api.tiktok.com/portal/docs/create-a-portfolio/v1.3',
  };
}
export const tiktokCtaPortfolioId = (d: JsonObject) =>
  obj(d.data) && numeric(d.data.creative_portfolio_id) ? d.data.creative_portfolio_id : undefined;
/** What verification compares: a CTA type (the documented read-back may omit it) and the CTA groups as sets. */
export function tiktokCtaPortfolioProjection(v: unknown): JsonObject {
  const d = obj(v) ? v : {};
  return {
    cta_portfolio:
      d.creative_portfolio_type === undefined ||
      d.creative_portfolio_type === null ||
      d.creative_portfolio_type === 'CTA',
    portfolio_content: groupsOf(d.portfolio_content),
  };
}
export function tiktokCtaPortfolioVerification(plan: CompiledRequest, result: JsonObject) {
  const id = tiktokCtaPortfolioId(obj(result.data) ? result.data : {});
  if (!id) throw new MirrorError('VERIFICATION_UNSUPPORTED', 'The creation receipt has no portfolio ID.');
  return [
    {
      path: tiktokPortfolioGetPath,
      query: {advertiser_id: plan.accountId, creative_portfolio_id: id},
      expected: tiktokCtaPortfolioProjection(plan.body),
      id,
    },
  ];
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokCtaPortfolioFamily: ReviewedFamily = {
  name: 'tiktok_cta_portfolios',
  files: ['src/tiktok-cta-portfolios.ts', ['tests/tiktok-cta-portfolios.test.mjs']],
  kind: tiktokCtaPortfolioKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertTiktokCtaPortfolio(plan, object(plan.body));
  },
  snapshots: (plan, stateRead) => {
    const id = normalizeAccount(plan.gateway, plan.accountId!);
    return [stateRead('/v1.3/advertiser/info/', {advertiser_ids: [id]})];
  },
  impact: plan => tiktokCtaPortfolioImpact(plan),
  outcome: (plan, result) => {
    const d = responseData(result);
    return d.code === 0 && !!tiktokCtaPortfolioId(d);
  },
  verification: (plan, result, before, verificationRead) =>
    tiktokCtaPortfolioVerification(plan, result).map(v => ({
      ...v,
      read: {...verificationRead(v.path, v.query), action: 'tiktok_creative_portfolio_get'},
    })),
};
