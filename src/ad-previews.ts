import {MirrorError, nestedError} from './errors.js';
import {fail} from './family-kit.js';
import {providerById} from './provider-adapters.js';
import {providerHooks} from './provider-hooks.js';
import {reportSourceError} from './report-errors.js';
import {fingerprint} from './workspace-core.js';
import {portfolioAuthority} from './portfolio-runner.js';
import {sealCursor, openCursor, cursorLifetimeMs} from './signed-cursor.js';
import type {Store} from './store.js';
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
          'The ads to preview (Snapchat and LinkedIn: creative IDs; Google Ads: asset group IDs or resource names, or adGroupAds resource names of video ads). Named IDs ignore statuses. Without IDs, the first `limit` matching active ads.',
      },
      limit: {type: 'integer', minimum: 1, maximum: 10, default: 5},
      statuses: {
        type: 'array',
        items: {type: 'string', enum: ['active', 'paused', 'archived', 'all']},
        minItems: 1,
        maxItems: 4,
        default: ['active'],
      },
      campaign_ids: {
        type: 'array',
        items: {type: 'string', pattern: '^[\\w:~./-]{1,200}$'},
        minItems: 1,
        maxItems: 50,
        description: 'Campaign IDs; LinkedIn campaign group IDs, as in reporting.',
      },
      adset_ids: {
        type: 'array',
        items: {type: 'string', pattern: '^[\\w:~./-]{1,200}$'},
        minItems: 1,
        maxItems: 50,
        description: 'Ad set or ad group IDs; Snapchat ad squad IDs; LinkedIn native campaign IDs.',
      },
      cursor: {type: 'string', maxLength: 4096},
      ad_format: {type: 'string', enum: metaPreviewFormats, description: 'Meta only: the placement to preview.'},
    },
    additionalProperties: false,
  },
};

interface Row {
  id: string;
  name: string | null;
  status?: string;
  campaign?: string;
  adset?: string;
  key?: string;
  native?: JsonObject;
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
  constructor(
    private call: Call,
    private store: Store,
  ) {}
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
    const wanted: string[] | undefined = Array.isArray(input.ad_ids) ? [...input.ad_ids] : input.ad_ids;
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
    const statuses: string[] = input.statuses ?? ['active'];
    let campaigns: string[] = input.campaign_ids ?? [],
      adsets: string[] = input.adset_ids ?? [];
    if (
      !Array.isArray(statuses) ||
      statuses.length < 1 ||
      statuses.length > 4 ||
      statuses.some(status => !['active', 'paused', 'archived', 'all'].includes(status))
    )
      fail('INVALID_ARGUMENT', 'statuses lists active, paused, archived or all.');
    for (const [field, ids] of [
      ['campaign_ids', input.campaign_ids],
      ['adset_ids', input.adset_ids],
    ] as const)
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 50 ||
          ids.some(id => typeof id !== 'string' || !/^[\w:~./-]{1,200}$/.test(id)))
      )
        fail('INVALID_ARGUMENT', 'Preview campaign and ad set filters each list 1 to 50 identifiers.', {field});
    if (platform === 'linkedin') {
      const normalize = (values: string[], kind: string) =>
        values.map(value => {
          if (!new RegExp('^(?:urn:li:' + kind + ':)?[1-9][0-9]{0,31}$').test(value))
            fail(
              'INVALID_ARGUMENT',
              'LinkedIn preview filters use campaign group IDs in campaign_ids and campaign IDs in adset_ids.',
            );
          return value.split(':').at(-1)!;
        });
      campaigns = normalize(campaigns, 'sponsoredCampaignGroup');
      adsets = normalize(adsets, 'sponsoredCampaign');
    }
    const invalidCursor = (): never =>
      fail('INVALID_CURSOR', 'The preview cursor is invalid or expired; list the previews again without it.');
    if (
      input.cursor !== undefined &&
      (wanted || !['meta', 'tiktok', 'snapchat', 'linkedin', 'reddit'].includes(platform))
    )
      invalidCursor();
    let authorization = '',
      permissions: string[] = [],
      selectedConnection = connection,
      current = () => {};
    if (['meta', 'tiktok', 'snapchat', 'linkedin', 'reddit'].includes(platform)) {
      try {
        const gateway = gatewayOf(platform),
          login = this.store.resolveConnection(actor, gateway, account, connection),
          authority = portfolioAuthority(this.store, actor, gateway, account, login, {
            binds: 'login',
            permits: (active, first) => first.scopes.every(scope => active.scopes.includes(scope)),
            missingScope: () =>
              fail('INSUFFICIENT_SCOPE', 'The preview login lost permissions. List the previews again.'),
            changed: () => fail('CONNECTION_AUTHORITY_CHANGED', 'The preview login changed. List the previews again.'),
          });
        selectedConnection = login.id;
        authorization = authority.authorization;
        permissions = [...login.scopes].sort();
        current = () => {
          this.store.assertActorActive(actor);
          authority.current();
        };
        current();
      } catch (error) {
        if (input.cursor !== undefined) invalidCursor();
        throw error;
      }
    }
    const binding = fingerprint({
      tool: 'amcp_ad_previews',
      tenant: actor.tenantId,
      user: actor.userId,
      platform,
      account,
      connection: selectedConnection,
      statuses: [...new Set(statuses)].sort(),
      campaign_ids: [...new Set(campaigns)].sort(),
      adset_ids: [...new Set(adsets)].sort(),
      limit,
      authorization,
      permissions,
      ad_format: input.ad_format ?? null,
    });
    let cursor: JsonObject | undefined;
    if (input.cursor !== undefined)
      try {
        cursor = openCursor(input.cursor, {key: authorization, binding, maxLength: 4096});
        if (
          (cursor.after !== null &&
            (typeof cursor.after !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(cursor.after))) ||
          !Number.isSafeInteger(cursor.page) ||
          cursor.page < 1 ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > 1000 ||
          (cursor.offset > 0 && (typeof cursor.content !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.content)))
        )
          invalidCursor();
      } catch {
        invalidCursor();
      }
    const read = async (gateway: string, args: JsonObject) => {
      current();
      const data = await this.read(actor, gateway, args);
      current();
      return data;
    };
    const matches = (row: Row, named = false) =>
      (named || statuses.includes('all') || statuses.includes(row.status ?? '')) &&
      (!campaigns.length || campaigns.includes(row.campaign ?? '')) &&
      (!adsets.length || adsets.includes(row.adset ?? ''));
    const pageSelection = async (
      fetchPage: (after: string | null, page: number) => Promise<{rows: Row[]; after: string | null; more: boolean}>,
      maxScans = 10,
    ) => {
      let after = cursor?.after ?? null,
        page = cursor?.page ?? 1,
        offset = cursor?.offset ?? 0;
      const chosen: Row[] = [],
        seen = new Set<string>();
      const continuation = (position: number, content?: string) => {
        const next = sealCursor(
          {
            version: 1,
            binding,
            after,
            page,
            offset: position,
            ...(content ? {content} : {}),
            expires_at: Date.now() + cursorLifetimeMs,
          },
          authorization,
        );
        if (next.length > 4096)
          fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
        return {chosen, paging: {next_cursor: next, has_more: true}};
      };
      for (let scanned = 0; scanned < maxScans; scanned++) {
        const next = await fetchPage(after, page),
          content = fingerprint(next.rows.map(row => [row.key ?? row.id, row.status, row.campaign, row.adset]));
        if (next.rows.length > 1000 || new Set(next.rows.map(row => row.key ?? row.id)).size !== next.rows.length)
          fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
        if (offset > next.rows.length || (offset && cursor?.content !== content)) invalidCursor();
        for (let index = offset; index < next.rows.length; index++) {
          const row = next.rows[index]!;
          if (matches(row)) chosen.push(row);
          if (chosen.length === limit && index + 1 < next.rows.length) return continuation(index + 1, content);
        }
        if (!next.more) return {chosen, paging: {next_cursor: null, has_more: false}};
        if (platform !== 'tiktok' && next.after === null)
          fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
        if (
          next.after !== null &&
          (typeof next.after !== 'string' ||
            !/^[\x21-\x7e]{1,2048}$/.test(next.after) ||
            next.after === after ||
            seen.has(next.after))
        )
          fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
        if (next.after !== null) seen.add(next.after);
        after = next.after;
        page++;
        offset = 0;
        if (chosen.length === limit) return continuation(0);
      }
      return continuation(0);
    };
    const base = {account_id: account, ...(selectedConnection ? {connection_id: selectedConnection} : {})},
      result = (previews: JsonObject[], extra: JsonObject = {}) => {
        current();
        return {
          platform,
          account_id: account,
          previews,
          next_cursor: null,
          has_more: false,
          order: 'native',
          executed: false,
          meaning:
            'Preview links open for anyone who has them and expire; share them only with people who may see these ads. AMCP does not store them.',
          ...extra,
        };
      };
    const each = async (rows: Row[], preview: (row: Row) => Promise<JsonObject>) => {
      const out: JsonObject[] = [];
      for (const row of rows)
        try {
          out.push({
            ad_id: row.id,
            name: row.name,
            ...(row.key ? {source_ad_id: row.key} : {}),
            ...(await preview(row)),
          });
        } catch (e) {
          if (!(e instanceof MirrorError)) throw e;
          // The full source diagnostic (V2-RPT-05); it still opens with `code` and `message`, so the change is additive.
          const error = reportSourceError(e, {platform, account_id: account, connection_id: connection});
          out.push({ad_id: row.id, name: row.name, ...(row.key ? {source_ad_id: row.key} : {}), links: [], error});
        }
      return out;
    };
    const notListed = (missing: string[]) =>
      missing.length
        ? {
            not_found: missing,
            not_found_reason:
              campaigns.length || adsets.length
                ? 'No matching ad in this account for the selected campaign and ad set filters.'
                : 'Not in this account',
          }
        : {};
    switch (platform) {
      case 'meta': {
        const rows = (values: unknown): Row[] => {
          if (
            !Array.isArray(values) ||
            values.length > limit ||
            values.some(row => !object(row) || typeof row.id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(row.id))
          )
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          if (
            (values as JsonObject[]).some(
              row => row.account_id !== undefined && row.account_id !== account.replace(/^act_/, ''),
            )
          )
            fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
          return (values as JsonObject[]).map(row => ({
            id: row.id,
            name: text(row.name),
            status: (
              {
                ACTIVE: 'active',
                PAUSED: 'paused',
                CAMPAIGN_PAUSED: 'paused',
                ADSET_PAUSED: 'paused',
                ARCHIVED: 'archived',
                DELETED: 'archived',
              } as Record<string, string>
            )[row.effective_status],
            campaign: row.campaign_id,
            adset: row.adset_id,
          }));
        };
        let chosen: Row[],
          paging: JsonObject = {},
          missing: string[] = [];
        if (wanted) {
          chosen = [];
          for (const id of wanted)
            try {
              const identity = await read(gatewayOf('meta'), {
                action: 'meta_ad_id_get',
                ...base,
                ad_id: id,
                query: {fields: 'id,account_id'},
              });
              if (identity?.id !== id || identity.account_id !== account.replace(/^act_/, '')) {
                missing.push(id);
                continue;
              }
              const row = await read(gatewayOf('meta'), {
                action: 'meta_ad_id_get',
                ...base,
                ad_id: id,
                query: {
                  fields:
                    'id,name,account_id,effective_status' +
                    (campaigns.length || adsets.length ? ',campaign_id,adset_id' : ''),
                },
              });
              if (row?.id !== id || row.account_id !== account.replace(/^act_/, '')) {
                missing.push(id);
                continue;
              }
              const found = rows([row])[0]!;
              if (matches(found, true)) chosen.push(found);
            } catch (error) {
              if (
                !(error instanceof MirrorError) ||
                !['ACCOUNT_SCOPE_MISMATCH', 'NOT_FOUND', 'RESOURCE_SCOPE_REQUIRED'].includes(error.code)
              )
                throw error;
              missing.push(id);
            }
        } else {
          const selected = await pageSelection(async after => {
            const listed = await read(gatewayOf('meta'), {
              action: 'meta_ad_list',
              ...base,
              query: {
                fields: 'id,name,account_id,effective_status,campaign_id,adset_id',
                limit,
                ...(after ? {after} : {}),
              },
            });
            const more = listed?.paging?.next !== undefined;
            return {rows: rows(listed?.data), more, after: more ? listed.paging?.cursors?.after : null};
          });
          chosen = selected.chosen;
          paging = selected.paging;
        }
        const format = input.ad_format ?? 'MOBILE_FEED_STANDARD';
        return result(
          await each(chosen, async row => ({
            ad_format: format,
            links: previewLinks(
              'meta',
              await read(gatewayOf('meta'), {
                action: 'meta_ad_id_previews_get',
                ...base,
                ad_id: row.id,
                query: {ad_format: format},
              }),
            ),
          })),
          {...paging, ...(missing.length ? {not_found: missing, not_found_reason: 'Not in this account'} : {})},
        );
      }
      case 'tiktok': {
        const primary =
          wanted || statuses.includes('all') || (statuses.includes('archived') && statuses.length > 1)
            ? 'STATUS_ALL'
            : statuses.includes('archived')
              ? 'STATUS_DELETE'
              : 'STATUS_NOT_DELETE';
        const pageOf = async (_after: string | null, page: number, named = false) => {
          const size = named ? wanted!.length : limit,
            response = await read(gatewayOf('tiktok'), {
              action: 'tiktok_ad_list',
              ...base,
              query: {
                advertiser_id: account,
                fields: [
                  'advertiser_id',
                  'ad_id',
                  'ad_name',
                  'campaign_id',
                  'adgroup_id',
                  'operation_status',
                  'secondary_status',
                ],
                filtering: {
                  primary_status: primary,
                  ...(named ? {ad_ids: wanted} : {}),
                  ...(campaigns.length ? {campaign_ids: campaigns} : {}),
                  ...(adsets.length ? {adgroup_ids: adsets} : {}),
                },
                page,
                page_size: size,
              },
            }),
            data = response?.data,
            p = data?.page_info;
          if (
            !Array.isArray(data?.list) ||
            data.list.length > size ||
            !object(p) ||
            p.page !== page ||
            p.page_size !== size ||
            !Number.isSafeInteger(p.total_number) ||
            p.total_number < 0 ||
            !Number.isSafeInteger(p.total_page) ||
            p.total_page < 0 ||
            (p.total_number === 0
              ? page !== 1 || data.list.length !== 0 || ![0, 1].includes(p.total_page)
              : p.total_page !== Math.ceil(p.total_number / size) ||
                page > p.total_page ||
                data.list.length !== Math.min(size, p.total_number - (page - 1) * size))
          )
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          const rows: Row[] = data.list.map((row: JsonObject) => {
            if (!object(row) || typeof row.ad_id !== 'string' || !/^[1-9][0-9]{0,31}$/.test(row.ad_id))
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
            if (row.advertiser_id !== undefined && row.advertiser_id !== account)
              fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
            return {
              id: row.ad_id,
              name: text(row.ad_name),
              campaign: row.campaign_id,
              adset: row.adgroup_id,
              status:
                primary === 'STATUS_DELETE' ||
                ['AD_STATUS_DELETE', 'AD_STATUS_CAMPAIGN_DELETE', 'AD_STATUS_ADGROUP_DELETE'].includes(
                  row.secondary_status,
                )
                  ? 'archived'
                  : ({ENABLE: 'active', DISABLE: 'paused'} as Record<string, string>)[row.operation_status],
            };
          });
          return {rows, after: null, more: page < p.total_page};
        };
        let rows: Row[],
          paging: JsonObject = {},
          missing: string[] = [];
        if (wanted) {
          const page = await pageOf(null, 1, true);
          if (
            page.more ||
            new Set(page.rows.map(row => row.id)).size !== page.rows.length ||
            page.rows.some(row => !wanted.includes(row.id))
          )
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          const found = new Map(page.rows.map(row => [row.id, row]));
          rows = wanted.flatMap(id => (found.has(id) && matches(found.get(id)!, true) ? [found.get(id)!] : []));
          missing = wanted.filter(id => !found.has(id));
        } else {
          const selected = await pageSelection(pageOf);
          rows = selected.chosen;
          paging = selected.paging;
        }
        return result(
          await each(rows, async row => {
            const r = await read(gatewayOf('tiktok'), {
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
          {...paging, ...notListed(missing)},
        );
      }
      case 'snapchat': {
        const invalid = (): never =>
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.'),
          nativeId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id),
          boundedNote =
            'Creative ownership or matching parents could not be established within the ten-page account scan. Narrow the selection and try again.';
        let scanned = 0;
        const unwrap = (data: JsonObject, plural: string, singular: string, max: number): JsonObject[] => {
          if (
            !object(data) ||
            data.request_status !== 'SUCCESS' ||
            !Array.isArray(data[plural]) ||
            data[plural].length > max ||
            (data.paging !== undefined && !object(data.paging))
          )
            invalid();
          const rows = data[plural].map((item: unknown) => {
            if (
              !object(item) ||
              (item.sub_request_status !== undefined && item.sub_request_status !== 'SUCCESS') ||
              !object(item[singular])
            )
              invalid();
            const row = (item as JsonObject)[singular] as JsonObject;
            if (!nativeId(row.id)) invalid();
            if (row.ad_account_id !== undefined && row.ad_account_id !== account)
              fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
            return row;
          });
          if (new Set(rows.map((row: JsonObject) => row.id)).size !== rows.length) invalid();
          return rows;
        };
        // Only extract the native cursor from a same-account continuation; never follow an upstream URL.
        const continuation = (data: JsonObject, kind: string, query: JsonObject) => {
          if (data.paging?.next_link === undefined) return null;
          try {
            const url = new URL(data.paging.next_link),
              keys = new Set<string>();
            if (
              url.origin !== 'https://adsapi.snapchat.com' ||
              url.username ||
              url.password ||
              url.hash ||
              url.pathname !== '/v1/adaccounts/' + encodeURIComponent(account) + '/' + kind
            )
              throw Error();
            for (const [key, value] of url.searchParams) {
              if (keys.has(key) || (key !== 'cursor' && (query[key] === undefined || String(query[key]) !== value)))
                throw Error();
              keys.add(key);
            }
            const token = url.searchParams.get('cursor');
            if (!token || !/^[\x21-\x7e]{1,2048}$/.test(token)) throw Error();
            return token;
          } catch {
            return invalid();
          }
        };
        const groups = new Map<string, JsonObject>();
        const adPage = async (after: string | null) => {
          scanned++;
          // Snapchat forbids sort together with read_deleted_entities. State the order actually requested.
          const deleted = !!wanted || statuses.includes('all') || statuses.includes('archived'),
            query = {
              limit: 50,
              ...(deleted ? {read_deleted_entities: true} : {sort: 'created_at-desc'}),
              ...(after ? {cursor: after} : {}),
            },
            data = await read(gatewayOf('snapchat'), {action: 'snapchat_ad_list', ...base, query}),
            ads = unwrap(data, 'ads', 'ad', 50),
            unknown = [
              ...new Set<string>(
                ads
                  .filter(
                    row =>
                      campaigns.length && !row.campaign_id && nativeId(row.ad_squad_id) && !groups.has(row.ad_squad_id),
                  )
                  .map(row => row.ad_squad_id),
              ),
            ];
          if (unknown.length) {
            const metadata = await read(gatewayOf('snapchat'), {
              action: 'snapchat_adsquad_get_by_ids',
              ...base,
              payload: {entity_ids: unknown.map(id => ({id}))},
            });
            for (const row of unwrap(metadata, 'adsquads', 'adsquad', unknown.length)) {
              if (!unknown.includes(row.id) || !nativeId(row.campaign_id)) invalid();
              groups.set(row.id, row);
            }
          }
          const rows: Row[] = ads.map(row => {
              if (!nativeId(row.creative_id) || (row.ad_squad_id !== undefined && !nativeId(row.ad_squad_id)))
                invalid();
              return {
                id: row.creative_id,
                key: row.id,
                name: text(row.name),
                campaign: row.campaign_id ?? groups.get(row.ad_squad_id)?.campaign_id,
                adset: row.ad_squad_id,
                status:
                  row.deleted === true
                    ? 'archived'
                    : ({ACTIVE: 'active', PAUSED: 'paused'} as Record<string, string>)[row.status],
              };
            }),
            token = continuation(data, 'ads', query);
          return {rows, after: token, more: token !== null};
        };
        let chosen: Row[],
          paging: JsonObject = {},
          parentIncomplete = false;
        if (wanted && (campaigns.length || adsets.length)) {
          const matchesById = new Map<string, Row>(),
            seen = new Set<string>();
          let after: string | null = null;
          for (let page = 0; page < 9; page++) {
            const next = await adPage(after);
            for (const row of next.rows)
              if (wanted.includes(row.id) && matches(row, true) && !matchesById.has(row.id))
                matchesById.set(row.id, row);
            if (matchesById.size === new Set(wanted).size || !next.more) break;
            if (next.after === after || seen.has(next.after!)) invalid();
            seen.add(next.after!);
            after = next.after;
            parentIncomplete = page === 8;
          }
          chosen = wanted.flatMap(id => (matchesById.has(id) ? [{...matchesById.get(id)!, key: undefined}] : []));
        } else if (wanted) chosen = [...new Set(wanted)].map(id => ({id, name: null}));
        else {
          const selected = await pageSelection(adPage, 9);
          chosen = selected.chosen;
          paging = selected.paging;
        }
        // An ad's creative_id alone grants no ownership. Read the account's creative list before any preview.
        const owned = new Map<string, JsonObject>(),
          pending = new Set(chosen.map(row => row.id)),
          seen = new Set<string>();
        let after: string | null = null,
          ownershipIncomplete = false;
        while (pending.size && scanned < 10) {
          scanned++;
          const query: JsonObject = {limit: 1000, sort: 'created_at-desc', ...(after ? {cursor: after} : {})},
            data = await read(gatewayOf('snapchat'), {
              action: 'snapchat_creative_list',
              ...base,
              query,
              result_ids: [...pending],
              max_pages: 1,
            });
          for (const row of unwrap(data, 'creatives', 'creative', pending.size)) {
            if (!pending.has(row.id)) invalid();
            owned.set(row.id, row);
            pending.delete(row.id);
          }
          const next = continuation(data, 'creatives', query);
          if (!pending.size || next === null) break;
          if (next === after || seen.has(next)) invalid();
          seen.add(next);
          after = next;
          ownershipIncomplete = scanned === 10;
        }
        const missing = wanted ? wanted.filter(id => !chosen.some(row => row.id === id) || !owned.has(id)) : [];
        if (wanted)
          chosen = chosen
            .filter(row => owned.has(row.id))
            .map(row => ({...row, name: text(owned.get(row.id)!.name) ?? row.name}));
        return result(
          await each(chosen, async row =>
            owned.has(row.id)
              ? {
                  links: previewLinks(
                    'snapchat',
                    await read(gatewayOf('snapchat'), {
                      action: 'snapchat_creatives_creative_id_creative_preview_get',
                      ...base,
                      creative_id: row.id,
                    }),
                  ),
                }
              : {links: [], note: ownershipIncomplete ? boundedNote : 'Not in this account'},
          ),
          {
            ...paging,
            ...notListed(missing),
            order: !wanted && !statuses.includes('all') && !statuses.includes('archived') ? 'created_desc' : 'native',
            ...(parentIncomplete || ownershipIncomplete
              ? {
                  selection_incomplete: true,
                  selection_note: boundedNote,
                  ...(missing.length ? {not_found_reason: boundedNote} : {}),
                }
              : {}),
          },
        );
      }
      case 'linkedin': {
        const campaignGroups = new Map<string, string>();
        const pageOf = async (after: string | null, _page: number, named = false) => {
          const size = named ? wanted!.length : limit,
            listed = await read(gatewayOf('linkedin'), {
              action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_get',
              ...base,
              restli_method: 'FINDER',
              query: {
                q: 'criteria',
                pageSize: size,
                sortOrder: 'DESCENDING',
                ...(after ? {pageToken: after} : {}),
                ...(named ? {creatives: 'List(' + wanted!.join(',') + ')'} : {}),
                ...(adsets.length ? {campaigns: adsets.map(id => 'urn:li:sponsoredCampaign:' + id)} : {}),
              },
            });
          if (
            !Array.isArray(listed?.elements) ||
            listed.elements.length > size ||
            (listed.metadata !== undefined && !object(listed.metadata))
          )
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          const creatives = listed.elements as JsonObject[];
          for (const row of creatives) {
            if (
              !object(row) ||
              typeof row.id !== 'string' ||
              !/^urn:li:sponsoredCreative:[1-9][0-9]{0,31}$/.test(row.id)
            )
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
            if (row.account !== undefined && row.account !== 'urn:li:sponsoredAccount:' + account)
              fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
            if (
              row.campaign !== undefined &&
              (typeof row.campaign !== 'string' || !/^urn:li:sponsoredCampaign:[1-9][0-9]{0,31}$/.test(row.campaign))
            )
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          }
          const unknownParents = campaigns.length
            ? [
                ...new Set<string>(
                  creatives
                    .map(row => row.campaign)
                    .filter(
                      id =>
                        typeof id === 'string' &&
                        /^urn:li:sponsoredCampaign:[1-9][0-9]{0,31}$/.test(id) &&
                        !campaignGroups.has(id),
                    ),
                ),
              ]
            : [];
          if (unknownParents.length) {
            const metadata = await read(gatewayOf('linkedin'), {
              action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_get',
              ...base,
              restli_method: 'FINDER',
              query: {q: 'search', search: {id: {values: unknownParents}}, pageSize: 100},
            });
            if (
              !Array.isArray(metadata?.elements) ||
              metadata.elements.length > unknownParents.length ||
              metadata.metadata?.nextPageToken
            )
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
            for (const row of metadata.elements as JsonObject[]) {
              if (!object(row))
                fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
              const id =
                  typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 ? String(row.id) : row.id,
                urn = 'urn:li:sponsoredCampaign:' + id;
              if (
                !object(row) ||
                typeof id !== 'string' ||
                !/^[1-9][0-9]{0,31}$/.test(id) ||
                !unknownParents.includes(urn) ||
                campaignGroups.has(urn) ||
                typeof row.campaignGroup !== 'string' ||
                !/^urn:li:sponsoredCampaignGroup:[1-9][0-9]{0,31}$/.test(row.campaignGroup)
              )
                fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
              if (row.account !== 'urn:li:sponsoredAccount:' + account)
                fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
              campaignGroups.set(urn, row.campaignGroup.split(':').at(-1)!);
            }
          }
          const rows: Row[] = creatives.map(row => ({
              id: row.id,
              name: text(row.name),
              adset: typeof row.campaign === 'string' ? row.campaign.split(':').at(-1) : undefined,
              campaign: campaignGroups.get(row.campaign),
              status: (
                {ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived', CANCELED: 'archived'} as Record<
                  string,
                  string
                >
              )[row.intendedStatus],
            })),
            token = listed.metadata?.nextPageToken;
          return {rows, after: token ?? null, more: token !== undefined && token !== null};
        };
        let chosen: Row[],
          paging: JsonObject = {},
          missing: string[] = [];
        if (wanted) {
          const page = await pageOf(null, 1, true),
            found = new Map(page.rows.map(row => [row.id, row]));
          if (page.more || found.size !== page.rows.length || page.rows.some(row => !wanted.includes(row.id)))
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          chosen = wanted.flatMap(id => (found.has(id) && matches(found.get(id)!, true) ? [found.get(id)!] : []));
          missing = wanted.filter(id => !found.has(id));
        } else {
          const selected = await pageSelection(pageOf);
          chosen = selected.chosen;
          paging = selected.paging;
        }
        return result(
          await each(chosen, async row => {
            const response = await read(gatewayOf('linkedin'), {
                action: 'linkedin_rest_ad_previews_get',
                ...base,
                query: {q: 'creative', creative: row.id, account: 'urn:li:sponsoredAccount:' + account},
              }),
              parse = providerHooks(gatewayOf('linkedin'))!.adPreviewLinks!,
              now = Date.now(),
              placements = parse(response?.elements, now),
              links = [...new Set(placements.map(link => link.url))],
              rejected =
                !Array.isArray(response?.elements) ||
                response.elements.length > 100 ||
                response.elements.some((element: unknown) => parse([element], now).length === 0);
            return {
              links,
              link: links[0] ?? null,
              placements,
              expires_at: placements[0]?.expires_at ?? null,
              expires: 'LinkedIn keeps this preview for up to 3 hours.',
              ...(rejected ? {note: 'LinkedIn returned no safe iframe preview link for one or more placements.'} : {}),
            };
          }),
          {...paging, ...notListed(missing)},
        );
      }
      case 'reddit': {
        const pageOf = async (after: string | null, _page: number, named = false) => {
          const size = named ? wanted!.length : limit,
            params: JsonObject = {
              'page.size': size,
              ...(named ? {id: wanted} : {}),
              ...(after ? {'page.token': after} : {}),
            },
            listed = await read(gatewayOf('reddit'), {
              operation: 'reddit_campaign_ops',
              arguments: {action: 'LIST_ADS', ...base, params},
            });
          if (
            !Array.isArray(listed?.data) ||
            listed.data.length > size ||
            listed.data.some(
              (row: unknown) => !object(row) || typeof row.id !== 'string' || !/^[\w:~./-]{1,200}$/.test(row.id),
            )
          )
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          const ads = listed.data as JsonObject[],
            groups = new Map<string, JsonObject>(),
            groupIds = [
              ...new Set<string>(
                ads
                  .filter(row => campaigns.length && !row.campaign_id && typeof row.ad_group_id === 'string')
                  .map(row => row.ad_group_id),
              ),
            ];
          if (groupIds.length) {
            const metadata = await read(gatewayOf('reddit'), {
              operation: 'reddit_campaign_ops',
              arguments: {
                action: 'LIST_AD_GROUPS',
                ...base,
                params: {id: groupIds, 'page.size': groupIds.length},
              },
            });
            if (!Array.isArray(metadata?.data) || metadata.pagination?.next_url)
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
            for (const row of metadata.data as JsonObject[]) {
              if (!object(row) || !groupIds.includes(row.id) || groups.has(row.id))
                fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
              if (row.ad_account_id !== undefined && row.ad_account_id !== account)
                fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
              groups.set(row.id, row);
            }
          }
          const rows: Row[] = ads.map(row => {
            if (row.ad_account_id !== undefined && row.ad_account_id !== account)
              fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
            return {
              id: row.id,
              name: text(row.name),
              native: row,
              campaign: row.campaign_id ?? groups.get(row.ad_group_id)?.campaign_id,
              adset: row.ad_group_id,
              status: ({ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived'} as Record<string, string>)[
                row.configured_status
              ],
            };
          });
          const link = listed.pagination?.next_url;
          let token: string | null = null;
          if (link) {
            try {
              const url = new URL(link);
              if (
                url.origin !== 'https://ads-api.reddit.com' ||
                url.username ||
                url.password ||
                url.hash ||
                url.pathname !== '/api/v3/ad_accounts/' + encodeURIComponent(account) + '/ads'
              )
                throw Error();
              const keys = new Set<string>();
              for (const [key, value] of url.searchParams) {
                if (
                  keys.has(key) ||
                  (key !== 'page.token' && (params[key] === undefined || String(params[key]) !== value))
                )
                  throw Error();
                keys.add(key);
              }
              token = url.searchParams.get('page.token');
              if (!token || named) throw Error();
            } catch {
              fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
            }
          }
          return {rows, after: token, more: token !== null};
        };
        let chosen: Row[],
          missing: string[] = [],
          paging: JsonObject = {};
        if (wanted) {
          const page = await pageOf(null, 1, true),
            found = new Map(page.rows.map(row => [row.id, row]));
          if (found.size !== page.rows.length || page.rows.some(row => !wanted.includes(row.id)))
            fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');
          chosen = wanted.flatMap(id => (found.has(id) && matches(found.get(id)!, true) ? [found.get(id)!] : []));
          missing = wanted.filter(id => !found.has(id));
        } else {
          const selected = await pageSelection(pageOf);
          chosen = selected.chosen;
          paging = selected.paging;
        }
        return result(
          chosen.map(row => {
            const ad = row.native!,
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
          {...paging, ...notListed(missing)},
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
