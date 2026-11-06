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
 * TikTok's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/tiktok-adapter.ts):
 * `ad/get` with a `filtering` object (named IDs, parents, and a primary status of its own), paged by number, and each
 * ad's preview link from `POST creative/ads_preview/create/` (preview_type AD).
 */
/** Where TikTok's preview links live; a link elsewhere in a response (an ad's own copy, say) is not one. */
const linkHosts = /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|byteoversea\.com)$/;

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, statuses, campaigns, adsets, base, read, matches, pageSelection, notListed} = request;
  const primary =
    wanted || statuses.includes('all') || (statuses.includes('archived') && statuses.length > 1)
      ? 'STATUS_ALL'
      : statuses.includes('archived')
        ? 'STATUS_DELETE'
        : 'STATUS_NOT_DELETE';
  const pageOf = async (_after: string | null, page: number, named = false): Promise<AdPreviewPage> => {
    const size = named ? wanted!.length : listPageSize,
      response = await read({
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
    const rows: AdPreviewRow[] = data.list.map((row: JsonObject) => {
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
          ['AD_STATUS_DELETE', 'AD_STATUS_CAMPAIGN_DELETE', 'AD_STATUS_ADGROUP_DELETE'].includes(row.secondary_status)
            ? 'archived'
            : ({ENABLE: 'active', DISABLE: 'paused'} as Record<string, string>)[row.operation_status],
      };
    });
    return {rows, after: null, more: page < p.total_page, byNumber: true};
  };
  let rows: AdPreviewRow[],
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
  return {
    rows,
    preview: async row => {
      const r = await read({
          action: 'tiktok_ad_preview',
          ...base,
          payload: {advertiser_id: account, preview_type: 'AD', ad_id: row.id},
        }),
        link = r?.data?.preview_link;
      return {
        links: typeof link === 'string' ? previewLinksOn(linkHosts, link) : [],
        expires: 'TikTok keeps an ad preview link for 30 days.',
      };
    },
    extra: {...paging, ...notListed(missing)},
  };
}

export const tiktokAdPreviews: AdPreviewHooks = Object.freeze({platform: 'tiktok', linkHosts, select});
