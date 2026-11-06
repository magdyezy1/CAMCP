import {fail} from './family-kit.js';
import {listPageSize, object, previewLinksOn, text} from './ad-preview-kit.js';
import type {
  AdPreviewHooks,
  AdPreviewPage,
  AdPreviewRequest,
  AdPreviewRow,
  AdPreviewSelection,
} from './provider-adapter.js';
import type {JsonObject} from './types.js';

/**
 * Reddit's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/reddit-adapter.ts):
 * `LIST_ADS` of the account (`id` for named ads, `page.token` to continue), an ad group's campaign from `LIST_AD_GROUPS`,
 * and no further read: the ad's own `preview_url` is its preview while `preview_expiry` is ahead.
 */
/** Where Reddit's preview links live; a link elsewhere in a response (an ad's own copy, say) is not one. */
const linkHosts = /(^|\.)reddit\.com$/;

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, campaigns, base, read, matches, pageSelection, notListed} = request;
  const pageOf = async (after: string | null, _page: number, named = false): Promise<AdPreviewPage> => {
    const size = named ? wanted!.length : listPageSize,
      params: JsonObject = {
        'page.size': size,
        ...(named ? {id: wanted} : {}),
        ...(after ? {'page.token': after} : {}),
      },
      listed = await read({
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
      const metadata = await read({
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
    const rows: AdPreviewRow[] = ads.map(row => {
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
          if (keys.has(key) || (key !== 'page.token' && (params[key] === undefined || String(params[key]) !== value)))
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
  let chosen: AdPreviewRow[],
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
  return {
    rows: chosen,
    // The ad's own record is the preview: no further read.
    preview: async row => {
      const ad = row.native!,
        live = typeof ad.preview_expiry === 'string' && Date.parse(ad.preview_expiry) > Date.now();
      return {
        links: live && typeof ad.preview_url === 'string' ? previewLinksOn(linkHosts, ad.preview_url) : [],
        expires_at: ad.preview_expiry ?? null,
        ...(live
          ? {}
          : {
              note: 'This ad has no live preview link: Reddit disables it when preview_expiry is empty or past. Setting a new preview_expiry is a reviewed ad change.',
            }),
      };
    },
    extra: {...paging, ...notListed(missing)},
  };
}

export const redditAdPreviews: AdPreviewHooks = Object.freeze({platform: 'reddit', linkHosts, select});
