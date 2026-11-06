import {MirrorError, nestedError} from './errors.js';
import {fail} from './family-kit.js';
import {adPreviewProviders} from './provider-hooks.js';
import {reportSourceError} from './report-errors.js';
import {fingerprint} from './workspace-core.js';
import {portfolioAuthority} from './portfolio-runner.js';
import {sealCursor, openCursor, cursorLifetimeMs} from './signed-cursor.js';
import {previewLinksOn} from './ad-preview-kit.js';
import type {AdPreviewPage, AdPreviewRequest, AdPreviewRow, ProviderHooks} from './provider-adapter.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

type Call = (tool: string, input: JsonObject, actor: Actor) => Promise<JsonObject>;
// V2-PRV-01: each platform's ads and previews are its own hooks' (src/<platform>-ad-previews.ts, registered as the
// `previews` hooks of its adapter); this tool keeps the cursor, the authority and login checks, the limits and the
// shape of the answer, and takes its platforms from the hooks registry.
/** The provider whose hooks serve a platform value of this tool (its `previews` hooks), or undefined. */
const previewProvider = (platform: unknown): ProviderHooks | undefined =>
  adPreviewProviders.find(provider => provider.previews!.platform === platform);

export const previewTool = {
  name: 'amcp_ad_previews',
  description:
    'Use this to get preview links for ads that already exist in an account instead of opening each platform; for new media use amcp_media, and for changes amcp_write. AMCP reads the account’s ads (or the ad_ids given; for Snapchat and LinkedIn, creatives) and then each one’s preview through the platform’s own read routes, with the connection’s account scope, ownership checks and audit. Meta (ad_format placement, default MOBILE_FEED_STANDARD), TikTok, Snapchat, LinkedIn and Reddit return links. A Google Ads preview is a shareable link created by a reviewed write: the result names the amcp_write call. X previews and Microsoft, DV360, Criteo and Apple Ads have no preview AMCP can read. Preview links open for anyone who has them and expire (TikTok after 30 days, Reddit at preview_expiry, others when the platform decides); AMCP returns them without storing them. Nothing in the account changes.',
  inputSchema: {
    type: 'object',
    required: [],
    anyOf: [{required: ['action'], properties: {action: {const: 'help'}}}, {required: ['platform', 'account_id']}],
    properties: {
      action: {type: 'string', enum: ['help']},
      topic: {type: 'string', maxLength: 300},
      platform: {
        type: 'string',
        enum: adPreviewProviders.map(provider => provider.previews!.platform),
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
      ad_format: {
        type: 'string',
        enum: adPreviewProviders.flatMap(provider => provider.previews!.formats ?? []),
        description: 'Meta only: the placement to preview.',
      },
    },
    additionalProperties: false,
  },
};

type Row = AdPreviewRow;

/**
 * The platform links in a preview response, wherever the platform put them: string values that are HTTPS URLs, and
 * the `src`/`href` of HTML (Meta and LinkedIn return iframe markup). Only HTTPS links on the platform's own hosts
 * count (its `linkHosts`); the markup itself is provider content and is never returned.
 */
export function previewLinks(platform: string, data: unknown): string[] {
  const hosts = previewProvider(platform)?.previews?.linkHosts;
  return hosts ? previewLinksOn(hosts, data) : [];
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
    if (input.action !== undefined) fail('INVALID_ARGUMENT', 'Unknown action of this AMCP tool.', {field: 'action'});
    for (const key of Object.keys(input))
      if (!Object.hasOwn(previewTool.inputSchema.properties, key))
        fail('INVALID_ARGUMENT', 'Unknown preview parameter.', {parameter: key});
    const {platform, account_id: account, connection_id: connection} = input;
    const provider = previewProvider(platform),
      // A platform that reads native data takes a cursor and is read under the login's authority.
      reads = !!provider?.previews?.select;
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
    // A platform may write the ads it names in another form (LinkedIn's creative URNs).
    if (wanted && provider?.previews?.normalize)
      wanted.splice(0, wanted.length, ...provider.previews.normalize('ad', wanted));
    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) fail('INVALID_ARGUMENT', 'limit is 1 to 10.');
    if (input.ad_format !== undefined && !provider?.previews?.formats?.includes(input.ad_format))
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
    if (provider?.previews?.normalize) {
      campaigns = provider.previews.normalize('campaign', campaigns);
      adsets = provider.previews.normalize('adset', adsets);
    }
    const invalidCursor = (): never =>
      fail('INVALID_CURSOR', 'The preview cursor is invalid or expired; list the previews again without it.');
    if (input.cursor !== undefined && (wanted || !reads)) invalidCursor();
    let authorization = '',
      permissions: string[] = [],
      selectedConnection = connection,
      current = () => {};
    if (reads) {
      try {
        const gateway = provider!.gateway,
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
      fetchPage: (after: string | null, page: number) => Promise<AdPreviewPage>,
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
        if (!next.byNumber && next.after === null)
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
    // A platform that reads native data is served by its `previews` hooks: its selection of ads, and how each one's
    // preview is read. This tool keeps the cursor, the login checks, the limits and the shape of the answer.
    if (provider?.previews?.select) {
      const gateway = provider.gateway,
        request: AdPreviewRequest = {
          account,
          wanted,
          statuses,
          campaigns,
          adsets,
          limit,
          format: input.ad_format,
          base,
          read: args => read(gateway, args),
          matches,
          pageSelection,
          notListed,
        },
        selected = await provider.previews.select(request);
      return result(await each(selected.rows, selected.preview), selected.extra);
    }
    // A platform AMCP reads no previews of explains why (and, for Google Ads, which reviewed write creates one).
    if (provider?.previews?.explain) return result([], provider.previews.explain({account, connection, wanted}));
    return fail('INVALID_ARGUMENT', 'Choose a platform from the schema.');
  }
}
