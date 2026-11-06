import {MirrorError} from './errors.js';
import {fail} from './family-kit.js';
import {listPageSize, object, previewLinksOn, text} from './ad-preview-kit.js';
import {metaAbsent} from './meta-catalogs.js';
import type {AdPreviewHooks, AdPreviewRequest, AdPreviewRow, AdPreviewSelection} from './provider-adapter.js';
import type {JsonObject} from './types.js';

/**
 * Meta's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/meta-adapter.ts):
 * the account's ads read with Graph's `after` cursor, or named ads proved to belong to the account by an exact
 * two-field identity read before any broader read, and each ad's preview from `GET /{ad_id}/previews`.
 */

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
/** Where Meta's preview links live; a link elsewhere in a response (an ad's own copy, say) is not one. */
const linkHosts = /(^|\.)(facebook\.com|fb\.com|instagram\.com)$/;

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, base, campaigns, adsets, read, matches, pageSelection} = request;
  const rows = (values: unknown): AdPreviewRow[] => {
    if (
      !Array.isArray(values) ||
      values.length > listPageSize ||
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
  let chosen: AdPreviewRow[],
    paging: JsonObject = {},
    missing: string[] = [];
  if (wanted) {
    chosen = [];
    for (const id of wanted)
      try {
        const identity = await read({
          action: 'meta_ad_id_get',
          ...base,
          ad_id: id,
          query: {fields: 'id,account_id'},
        });
        if (identity?.id !== id || identity.account_id !== account.replace(/^act_/, '')) {
          missing.push(id);
          continue;
        }
        const row = await read({
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
        // A foreign ad (the observer's refusal) and an ad Meta says does not exist or cannot be loaded (code 100, subcode
        // 33) read the same: not in this account. Whether an ad exists elsewhere is not the caller's to learn (F-L3-03).
        if (
          !(error instanceof MirrorError) ||
          !(
            ['ACCOUNT_SCOPE_MISMATCH', 'NOT_FOUND', 'RESOURCE_SCOPE_REQUIRED'].includes(error.code) || metaAbsent(error)
          )
        )
          throw error;
        missing.push(id);
      }
  } else {
    const selected = await pageSelection(async after => {
      const listed = await read({
        action: 'meta_ad_list',
        ...base,
        query: {
          fields: 'id,name,account_id,effective_status,campaign_id,adset_id',
          limit: listPageSize,
          ...(after ? {after} : {}),
        },
      });
      const more = listed?.paging?.next !== undefined;
      return {rows: rows(listed?.data), more, after: more ? listed.paging?.cursors?.after : null};
    });
    chosen = selected.chosen;
    paging = selected.paging;
  }
  const format = request.format ?? metaPreviewFormats[0]!;
  return {
    rows: chosen,
    preview: async row => ({
      ad_format: format,
      links: previewLinksOn(
        linkHosts,
        await read({action: 'meta_ad_id_previews_get', ...base, ad_id: row.id, query: {ad_format: format}}),
      ),
    }),
    extra: {...paging, ...(missing.length ? {not_found: missing, not_found_reason: 'Not in this account'} : {})},
  };
}

export const metaAdPreviews: AdPreviewHooks = Object.freeze({
  platform: 'meta',
  linkHosts,
  formats: metaPreviewFormats,
  select,
});
