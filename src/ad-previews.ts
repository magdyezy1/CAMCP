import {MirrorError, nestedError} from './errors.js';
import {fail} from './family-kit.js';
import {providerById} from './provider-adapters.js';
import {reportSourceError} from './report-errors.js';
import type {Actor, JsonObject} from './types.js';

type Call = (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>;
// ARC-01 (reporting): each platform's previews are read under its provider adapter's gateway (src/provider-adapters.ts).
const gatewayOf = (provider: string) => providerById(provider)!.gateway;

/**
 * Meta placements its ad preview read takes (`ad_format`), as recorded in the captured AMCP catalog's get_ad_preview
 * contract; MOBILE_FEED_STANDARD is that contract's default.
 */
export const metaPreviewFormats = [
  'MOBILE_FEED_STANDARD',
  'DESKTOP_FEED_STANDARD',
  'INSTAGRAM_STANDARD',
  'INSTAGRAM_STORY',
  'INSTAGRAM_REELS',
  'FACEBOOK_STORY_MOBILE',
  'AUDIENCE_NETWORK_OUTSTREAM_VIDEO',
];
/** Where each platform's preview links live; a link elsewhere in a response (an ad's own copy, say) is not one. */
const previewHosts: Record<string, RegExp> = {
  meta: /(^|\.)(facebook\.com|fb\.com|instagram\.com)$/,
  tiktok: /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|byteoversea\.com)$/,
  snapchat: /(^|\.)(snapchat\.com|snap\.com|sc-cdn\.net)$/,
  linkedin: /(^|\.)(linkedin\.com|licdn\.com)$/,
  reddit: /(^|\.)reddit\.com$/,
};
const noRoute: Record<string, string> = {
  microsoft_ads: 'Microsoft Advertising',
  dv360: 'Display & Video 360',
  criteo: 'Criteo',
  apple_ads: 'Apple Ads',
};
export const previewTool = {
  name: 'amcp_ad_previews',
  description:
    'Use this to get preview links for ads that already exist in an account instead of opening each platform; for new media use amcp_media, and for changes amcp_write. AMCP reads the account’s ads (or the ad_ids given; for Snapchat and LinkedIn, creatives) and then each one’s preview through the platform’s own read routes, with the connection’s account scope, ownership checks and audit. Meta (ad_format placement, default MOBILE_FEED_STANDARD), TikTok, Snapchat, LinkedIn and Reddit return links. A Google Ads preview is a shareable link created by a reviewed write: the result names the amcp_write call. X previews and Microsoft, DV360, Criteo and Apple Ads have no preview AMCP can read. Preview links open for anyone who has them and expire (TikTok after 30 days, Reddit at preview_expiry, others when the platform decides); AMCP returns them without storing them. Nothing in the account changes.',
  inputSchema: {
    type: 'object',
    required: ['platform', 'account_id'],
    properties: {
      platform: {
        type: 'string',
        enum: ['meta', 'tiktok', 'snapchat', 'linkedin', 'reddit', 'google_ads', 'x_ads', ...Object.keys(noRoute)],
      },
      account_id: {type: 'string'},
      connection_id: {type: 'string'},
      ad_ids: {
        type: 'array',
        items: {type: 'string'},
        minItems: 1,
        maxItems: 10,
        description:
          'The ads to preview (Snapchat and LinkedIn: creative IDs; Google Ads: asset group IDs or resource names, or adGroupAds resource names of video ads). By default, the first `limit` in the account.',
      },
      limit: {type: 'integer', minimum: 1, maximum: 10},
      ad_format: {type: 'string', enum: metaPreviewFormats, description: 'Meta only: the placement to preview.'},
    },
    additionalProperties: false,
  },
};

interface Row {
  id: string;
  name: string | null;
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The platform links in a preview response, wherever the platform put them: string values that are HTTPS URLs, and
 * the `src`/`href` of HTML (Meta and LinkedIn return iframe markup). Only HTTPS links on the platform's own hosts
 * count; the markup itself is provider content and is never returned.
 */
export function previewLinks(platform: string, data: unknown): string[] {
  const hosts = previewHosts[platform]!,
    found = new Set<string>();
  const consider = (candidate: string) => {
    let url: URL;
    try {
      url = new URL(candidate.replaceAll('&amp;', '&'));
    } catch {
      return;
    }
    if (url.protocol === 'https:' && !url.username && !url.password && hosts.test(url.hostname)) found.add(url.href);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || found.size >= 20) return;
    if (typeof v === 'string') {
      if (/^https:\/\/\S+$/.test(v)) consider(v);
      else if (v.includes('<')) for (const m of v.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) consider(m[1]!);
    } else if (Array.isArray(v)) for (const item of v.slice(0, 100)) walk(item, depth + 1);
    else if (object(v)) for (const item of Object.values(v)) walk(item, depth + 1);
  };
  walk(data, 0);
  return [...found];
}

/** amcp_ad_previews: preview links of existing ads through each platform's own read routes. */
export class AdPreviews {
  constructor(private call: Call) {}
  private async read(actor: Actor, gateway: string, input: JsonObject) {
    const r = await this.call(gateway, input, actor);
    if (r.success === false) {
      // V2-RPT-05: the provider's own refusal (status, request ID, message) survives into the per-ad diagnostic.
      const e = nestedError(r, {code: 'PREVIEW_READ_FAILED', message: 'The preview read failed.'});
      e.details.read = {tool: gateway, action: input.action ?? input.arguments?.action};
      throw e;
    }
    // A native read answers {success, action, data: <the platform's response>, pages, truncated}.
    return r.data?.data;
  }
  async handle(input: JsonObject, actor: Actor): Promise<JsonObject> {
    for (const key of Object.keys(input))
      if (!Object.hasOwn(previewTool.inputSchema.properties, key))
        fail('INVALID_ARGUMENT', 'Unknown preview parameter.', {parameter: key});
    const {platform, account_id: account, connection_id: connection} = input;
    if (typeof account !== 'string' || !account.trim()) fail('INVALID_ARGUMENT', 'Choose the advertising account.');
    if (connection !== undefined && typeof connection !== 'string')
      fail('INVALID_ARGUMENT', 'connection_id is a connection of this workspace.');
    const wanted: string[] | undefined = input.ad_ids;
    if (
      wanted !== undefined &&
      (!Array.isArray(wanted) ||
        !wanted.length ||
        wanted.length > 10 ||
        wanted.some(id => typeof id !== 'string' || !/^[\w:~./-]{1,200}$/.test(id)))
    )
      fail('INVALID_ARGUMENT', 'ad_ids lists 1 to 10 identifiers.');
    // LinkedIn creatives are named by URN; a bare number means the same creative.
    if (wanted && platform === 'linkedin')
      for (const [i, id] of wanted.entries()) if (/^\d+$/.test(id)) wanted[i] = 'urn:li:sponsoredCreative:' + id;
    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail('INVALID_ARGUMENT', 'limit is 1 to 10.');
    if (input.ad_format !== undefined && (platform !== 'meta' || !metaPreviewFormats.includes(input.ad_format)))
      fail('INVALID_ARGUMENT', 'ad_format is one of the Meta placements listed in the schema.');
    const base = {account_id: account, ...(connection ? {connection_id: connection} : {})},
      result = (previews: JsonObject[], extra: JsonObject = {}) => ({
        platform,
        account_id: account,
        previews,
        executed: false,
        meaning:
          'Preview links open for anyone who has them and expire; share them only with people who may see these ads. AMCP does not store them.',
        ...extra,
      });
    // The ads to preview: the ones asked for, found in the account's list, or the first `limit` of it.
    const pick = (rows: Row[]) => {
      if (!wanted) return {chosen: rows.slice(0, limit), missing: [] as string[]};
      const byId = new Map(rows.map(r => [r.id, r]));
      return {
        chosen: wanted.filter(id => byId.has(id)).map(id => byId.get(id)!),
        missing: wanted.filter(id => !byId.has(id)),
      };
    };
    const each = async (rows: Row[], preview: (row: Row) => Promise<JsonObject>) => {
      const out: JsonObject[] = [];
      for (const row of rows)
        try {
          out.push({ad_id: row.id, name: row.name, ...(await preview(row))});
        } catch (e) {
          if (!(e instanceof MirrorError)) throw e;
          // The full source diagnostic (V2-RPT-05); it still opens with `code` and `message`, so the change is additive.
          const error = reportSourceError(e, {platform, account_id: account, connection_id: connection});
          out.push({ad_id: row.id, name: row.name, links: [], error});
        }
      return out;
    };
    const notListed = (missing: string[], what: string) =>
      missing.length
        ? {
            not_found: missing,
            not_found_reason:
              'Not among the ' + what + ' this read returned for the account. Check the IDs, or page through the list.',
          }
        : {};
    switch (platform) {
      case 'meta': {
        const listed = await this.read(actor, gatewayOf('meta'), {
            action: 'meta_ad_list',
            ...base,
            query: {fields: 'id,name', limit: 100},
          }),
          rows: Row[] = (Array.isArray(listed?.data) ? listed.data : [])
            .filter((r: unknown) => object(r) && typeof r.id === 'string')
            .map((r: JsonObject) => ({id: r.id, name: text(r.name)})),
          {chosen, missing} = pick(rows),
          format = input.ad_format ?? 'MOBILE_FEED_STANDARD';
        return result(
          await each(chosen, async row => ({
            ad_format: format,
            links: previewLinks(
              'meta',
              await this.read(actor, gatewayOf('meta'), {
                action: 'meta_ad_id_previews_get',
                ...base,
                ad_id: row.id,
                query: {ad_format: format},
              }),
            ),
          })),
          notListed(missing, 'first 100 ads'),
        );
      }
      case 'tiktok': {
        // TikTok scopes both reads by advertiser_id, so named ads need no list; the list supplies names otherwise.
        const rows: Row[] = wanted
          ? wanted.map(id => ({id, name: null}))
          : ((
              await this.read(actor, gatewayOf('tiktok'), {
                action: 'tiktok_ad_list',
                ...base,
                query: {advertiser_id: account, page_size: 100},
              })
            )?.data?.list
              ?.filter((r: unknown) => object(r) && /^\d+$/.test(String(r.ad_id)))
              .map((r: JsonObject) => ({id: String(r.ad_id), name: text(r.ad_name)}))
              .slice(0, limit) ?? []);
        return result(
          await each(rows, async row => {
            const r = await this.read(actor, gatewayOf('tiktok'), {
                action: 'tiktok_ad_preview',
                ...base,
                payload: {advertiser_id: account, preview_type: 'AD', ad_id: row.id},
              }),
              link = r?.data?.preview_link;
            return {
              links: typeof link === 'string' ? previewLinks('tiktok', link) : [],
              expires: 'TikTok keeps an ad preview link for 30 days.',
            };
          }),
        );
      }
      case 'snapchat': {
        const listed = await this.read(actor, gatewayOf('snapchat'), {action: 'snapchat_creative_list', ...base}),
          rows: Row[] = (Array.isArray(listed?.creatives) ? listed.creatives : [])
            .map((w: JsonObject) => (object(w?.creative) ? w.creative : w))
            .filter((c: unknown) => object(c) && typeof c.id === 'string')
            .map((c: JsonObject) => ({id: c.id, name: text(c.name)})),
          {chosen, missing} = pick(rows);
        return result(
          await each(chosen, async row => ({
            links: previewLinks(
              'snapchat',
              await this.read(actor, gatewayOf('snapchat'), {
                action: 'snapchat_creatives_creative_id_creative_preview_get',
                ...base,
                creative_id: row.id,
              }),
            ),
          })),
          notListed(missing, 'creatives'),
        );
      }
      case 'linkedin': {
        const listed = await this.read(actor, gatewayOf('linkedin'), {
            action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
            ...base,
            restli_method: 'FINDER',
            query: {q: 'criteria', pageSize: 100},
          }),
          rows: Row[] = (Array.isArray(listed?.elements) ? listed.elements : [])
            .filter((c: unknown) => object(c) && /^urn:li:sponsoredCreative:\d+$/.test(String(c.id)))
            .map((c: JsonObject) => ({id: String(c.id), name: text(c.name)})),
          {chosen, missing} = pick(rows);
        return result(
          await each(chosen, async row => ({
            links: previewLinks(
              'linkedin',
              await this.read(actor, gatewayOf('linkedin'), {
                action: 'linkedin_rest_ad_previews_get',
                ...base,
                query: {q: 'creative', creative: row.id},
              }),
            ),
          })),
          notListed(missing, 'first 100 creatives'),
        );
      }
      case 'reddit': {
        const listed = await this.read(actor, gatewayOf('reddit'), {
            operation: 'reddit_campaign_ops',
            arguments: {action: 'LIST_ADS', ...base, params: wanted ? {id: wanted} : {'page.size': limit}},
          }),
          ads = (Array.isArray(listed?.data) ? listed.data : []).filter(
            (a: unknown) => object(a) && typeof a.id === 'string',
          ),
          {chosen, missing} = pick(ads.map((a: JsonObject) => ({id: a.id, name: text(a.name)}))),
          byId = new Map<string, JsonObject>(ads.map((a: JsonObject) => [a.id, a]));
        return result(
          chosen.map(row => {
            const ad = byId.get(row.id)!,
              live = typeof ad.preview_expiry === 'string' && Date.parse(ad.preview_expiry) > Date.now();
            return {
              ad_id: row.id,
              name: row.name,
              links: live && typeof ad.preview_url === 'string' ? previewLinks('reddit', ad.preview_url) : [],
              expires_at: ad.preview_expiry ?? null,
              ...(live
                ? {}
                : {
                    note: 'This ad has no live preview link: Reddit disables it when preview_expiry is empty or past. Setting a new preview_expiry is a reviewed ad change.',
                  }),
            };
          }),
          notListed(missing, 'ads'),
        );
      }
      case 'google_ads': {
        // Google creates a shareable preview (generateShareablePreviews), which AMCP reviews as a write. Since v25 an
        // asset group is named by its resource, and every preview states its type.
        const customer = 'customers/' + account.replaceAll('-', ''),
          targets = (wanted ?? []).map(id =>
            id.includes('/adGroupAds/')
              ? {adGroupAd: id, previewType: 'YOUTUBE_LIVE_PREVIEW'}
              : {assetGroup: /^\d+$/.test(id) ? customer + '/assetGroups/' + id : id, previewType: 'UI_PREVIEW'},
          );
        return result([], {
          preview_route: 'reviewed_write',
          explanation:
            'Google Ads creates shareable preview links with generateShareablePreviews, which AMCP reviews like any other write. Prepare it with the call below, review it, then execute it.',
          next_call: {
            tool: 'amcp_write',
            arguments: {
              action: 'prepare',
              gateway: gatewayOf('google'),
              ...(connection ? {connection_id: connection} : {}),
              arguments: {
                action: 'GENERATE_SHAREABLE_PREVIEWS',
                account_id: account,
                payload: {
                  operation: {
                    shareablePreviews: targets.length
                      ? targets
                      : [{assetGroup: customer + '/assetGroups/ASSET_GROUP_ID', previewType: 'UI_PREVIEW'}],
                  },
                },
              },
            },
          },
          ...(targets.length
            ? {}
            : {
                next_step:
                  'Replace ASSET_GROUP_ID with a Performance Max asset group ID, or pass adGroupAds resource names (customers/…/adGroupAds/…~…) of video ads in ad_ids.',
              }),
        });
      }
      case 'x_ads':
        return result([], {
          preview_route: 'not_qualified',
          explanation:
            'X has a Tweet preview read (x_accounts_account_id_tweet_previews_get), but its parameters are not pinned in AMCP’s evidence, so AMCP does not call it on its own. Open the promoted Tweet on X instead.',
        });
      default:
        if (noRoute[platform])
          return result([], {
            preview_route: 'none',
            explanation: noRoute[platform] + ' has no ad preview route in its API that AMCP can read.',
          });
        return fail('INVALID_ARGUMENT', 'Choose a platform from the schema.');
    }
  }
}
