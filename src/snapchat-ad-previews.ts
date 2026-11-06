import {fail} from './family-kit.js';
import {listPageSize, object, text} from './ad-preview-kit.js';
import type {AdPreviewHooks, AdPreviewRequest, AdPreviewRow, AdPreviewSelection} from './provider-adapter.js';
import type {JsonObject} from './types.js';

/**
 * Snapchat's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/snapchat-adapter.ts):
 * the account's ads (a creative several ads share keeps one row per ad), each creative proved to belong to the account
 * by the account's own creative list before any preview is read (an ad's creative_id grants nothing), and the hosted
 * browser link built from the signed preview read's creative ID, expiry and signature.
 */
/**
 * A link's expiry parameter as milliseconds since the epoch: Snapchat's documentation names the parameter, not its format
 * (docs/AD-PREVIEWS.md), so epoch seconds (below 1e11, before the year 5138) and milliseconds (below 1e14) are read, and
 * any other text, finer units included, is not an expiry. NaN for a value that is none.
 */
const linkExpiryMs = (value: string | null) => {
  if (!value || !/^[0-9]{1,14}$/.test(value)) return NaN;
  const n = Number(value);
  return n < 1e11 ? n * 1000 : n < 1e14 ? n : NaN;
};

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, statuses, campaigns, adsets, base, read, matches, pageSelection, notListed, observed} =
    request;
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
        limit: listPageSize,
        ...(deleted ? {read_deleted_entities: true} : {sort: 'created_at-desc'}),
        ...(after ? {cursor: after} : {}),
      },
      data = await read({action: 'snapchat_ad_list', ...base, query}),
      ads = unwrap(data, 'ads', 'ad', listPageSize),
      unknown = [
        ...new Set<string>(
          ads
            .filter(
              row => campaigns.length && !row.campaign_id && nativeId(row.ad_squad_id) && !groups.has(row.ad_squad_id),
            )
            .map(row => row.ad_squad_id),
        ),
      ];
    if (unknown.length) {
      const metadata = await read({
        action: 'snapchat_adsquad_get_by_ids',
        ...base,
        payload: {entity_ids: unknown.map(id => ({id}))},
      });
      for (const row of unwrap(metadata, 'adsquads', 'adsquad', unknown.length)) {
        if (!unknown.includes(row.id) || !nativeId(row.campaign_id)) invalid();
        groups.set(row.id, row);
      }
    }
    const rows: AdPreviewRow[] = ads.map(row => {
        if (!nativeId(row.creative_id) || (row.ad_squad_id !== undefined && !nativeId(row.ad_squad_id))) invalid();
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
  let chosen: AdPreviewRow[],
    paging: JsonObject = {},
    parentIncomplete = false;
  if (wanted && (campaigns.length || adsets.length)) {
    const matchesById = new Map<string, AdPreviewRow>(),
      seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 9; page++) {
      const next = await adPage(after);
      for (const row of next.rows)
        if (wanted.includes(row.id) && matches(row, true) && !matchesById.has(row.id)) matchesById.set(row.id, row);
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
  // A creative the gateway observed in one of its own reads of the account's creative list in the last five minutes (the
  // observation its preview read needs, and no longer than the cursor lives) is not proven again. A named creative
  // always is: its name comes from that list. (V2-PRV-01 design note 3.)
  if (!wanted)
    for (const id of [...pending])
      if (observed('creatives/' + id)) {
        owned.set(id, {id});
        pending.delete(id);
      }
  let after: string | null = null,
    ownershipIncomplete = false;
  while (pending.size && scanned < 10) {
    scanned++;
    const query: JsonObject = {limit: 1000, sort: 'created_at-desc', ...(after ? {cursor: after} : {})},
      data = await read({
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
  return {
    rows: chosen,
    preview: async row => {
      if (!owned.has(row.id)) return {links: [], note: ownershipIncomplete ? boundedNote : 'Not in this account'};
      const response = await read({
          action: 'snapchat_creatives_creative_id_creative_preview_get',
          ...base,
          creative_id: row.id,
        }),
        // The provider's own JSON field: shown when no link is returned; the link's expiry is the one its signature covers.
        jsonExpiry = typeof response?.expires_at === 'string' ? Date.parse(response.expires_at) : NaN,
        links: string[] = [];
      let linkMs = NaN;
      // Snap's signed endpoint returns JSON. Its documented browser page takes only these three values.
      try {
        if (typeof response?.creative_preview_link !== 'string' || response.creative_preview_link.length > 8192)
          throw Error();
        const native = new URL(response.creative_preview_link),
          params = native.searchParams,
          signature = params.get('signature'),
          timestamp = params.get('expires_at');
        linkMs = linkExpiryMs(timestamp);
        if (
          native.origin !== 'https://adsapi.snapchat.com' ||
          native.username ||
          native.password ||
          native.hash ||
          native.pathname !== '/media/creative_preview' ||
          (response.creative_id !== undefined && response.creative_id !== row.id) ||
          ['creative_id', 'expires_at', 'signature'].some(key => params.getAll(key).length !== 1) ||
          params.get('creative_id') !== row.id ||
          !signature ||
          !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(signature) ||
          !timestamp ||
          !(linkMs > Date.now())
        )
          throw Error();
        const hosted = new URL('https://ad-preview.snapchat.com/');
        hosted.searchParams.set('creative_id', row.id);
        hosted.searchParams.set('expires_at', timestamp);
        hosted.searchParams.set('signature', signature);
        links.push(hosted.href);
      } catch {
        /* No usable link is returned for an unverified, expired or malformed capability. */
      }
      return {
        links,
        expires_at: links.length
          ? new Date(linkMs).toISOString()
          : Number.isFinite(jsonExpiry)
            ? response.expires_at
            : null,
        expires: 'Snapchat keeps this preview link for 90 days.',
        ...(!links.length ? {note: 'Snapchat returned an expired or invalid preview link.'} : {}),
      };
    },
    extra: {
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
  };
}

export const snapchatAdPreviews: AdPreviewHooks = Object.freeze({platform: 'snapchat', select});
