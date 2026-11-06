import type {Store} from './store.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {fail} from './family-kit.js';
import {object, text} from './ad-preview-kit.js';
import type {
  AdPreviewHooks,
  AdPreviewLink,
  AdPreviewPage,
  AdPreviewRequest,
  AdPreviewRow,
  AdPreviewSelection,
} from './provider-adapter.js';

/**
 * LinkedIn documents GET /rest/adPreviews?q=creative&creative=...&account=... (Ad Preview, read 2026-11-03).
 * The query must name the selected account, and the creative's scope also comes from
 * ownership: the account's creatives finder (GET /rest/adAccounts/{id}/creatives?q=criteria) lists that account's own
 * creatives, and each one it returns may be previewed through the same connection for five minutes.
 */
const creativeUrn = /^urn:li:sponsoredCreative:([1-9][0-9]{0,19})$/;
const decode = (v: unknown) => {
  try {
    return decodeURIComponent(String(v ?? ''));
  } catch {
    return '';
  }
};
const plainRead = (p: CompiledRequest) =>
  p.gateway === 'linkedin_native_action' &&
  p.method === 'GET' &&
  p.readOnly &&
  (p.body === undefined || p.body === null) &&
  !p.specialTransport &&
  (!p.origin || p.origin === 'https://api.linkedin.com');

/** A plain read of /rest/adPreviews: the requests authorizeLinkedInAdPreview decides (its read authorizer's claim). */
export const linkedinAdPreviewRead = (p: CompiledRequest) => plainRead(p) && decode(p.path) === '/rest/adPreviews';
export function authorizeLinkedInAdPreview(p: CompiledRequest, c: Connection, store: Store, selected: string): boolean {
  if (!linkedinAdPreviewRead(p)) return false;
  if (
    Object.keys(p.query).length !== 3 ||
    Object.keys(p.query).some(k => !['q', 'creative', 'account'].includes(k)) ||
    p.query.q !== 'creative' ||
    p.query.account !== 'urn:li:sponsoredAccount:' + selected
  )
    return false;
  const creative = creativeUrn.exec(decode(p.query.creative))?.[1];
  return !!creative && store.ownsResource(c, selected, 'creatives/' + creative);
}

/** Only the documented accurate-preview iframe's src, never links embedded elsewhere in provider HTML. */
export function linkedInPreviewLinks(elements: unknown, now: number): AdPreviewLink[] {
  if (!Array.isArray(elements) || elements.length > 100 || !Number.isFinite(now)) return [];
  const links: AdPreviewLink[] = [],
    seen = new Set<string>(),
    expires_at = new Date(now + 3 * 3600000).toISOString();
  for (const element of elements) {
    if (
      !element ||
      typeof element !== 'object' ||
      typeof element.preview !== 'string' ||
      element.preview.length > 16384
    )
      continue;
    const tag = /^\s*<iframe\b([^<>]*)>\s*<\/iframe\s*>\s*$/i.exec(element.preview);
    if (!tag) continue;
    const attributes = new Map<string, string>();
    let rest = tag[1]!,
      valid = true;
    while (rest.length) {
      const leading = /^\s+/.exec(rest);
      if (!leading) {
        valid = false;
        break;
      }
      rest = rest.slice(leading[0].length);
      if (!rest) break;
      const attr = /^([a-z][\w:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(rest);
      if (!attr || attributes.has(attr[1]!.toLowerCase())) {
        valid = false;
        break;
      }
      attributes.set(attr[1]!.toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
      rest = rest.slice(attr[0].length);
    }
    const src = attributes.get('src');
    if (!valid || attributes.has('srcdoc') || !src || /[\x00-\x20<>]/.test(src)) continue;
    let url: URL;
    try {
      url = new URL(src.replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))
    )
      continue;
    const placement = element.placement?.linkedin,
      value = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 200 ? v : null),
      link = {
        placement: value(placement?.placementName) ?? 'UNKNOWN',
        device: value(placement?.contentPresentationType),
        url: url.href,
        expires_at,
      },
      key = JSON.stringify([link.placement, link.device, link.url]);
    if (!seen.has(key)) {
      links.push(link);
      seen.add(key);
    }
  }
  return links;
}

export function observeLinkedInCreatives(
  p: CompiledRequest,
  c: Connection,
  store: Store,
  selected: string,
  data: unknown,
): void {
  if (!plainRead(p) || decode(p.path) !== '/rest/adAccounts/' + selected + '/creatives') return;
  const elements = (data as JsonObject)?.elements;
  if (p.query.q !== 'criteria' || !Array.isArray(elements)) return;
  if (
    elements.some(
      row =>
        row &&
        typeof row === 'object' &&
        (row as JsonObject).account !== undefined &&
        (row as JsonObject).account !== 'urn:li:sponsoredAccount:' + selected,
    )
  )
    throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Not in this account', {}, 403);
  for (const row of elements) {
    const creative = creativeUrn.exec(String((row as JsonObject)?.id ?? ''))?.[1];
    if (creative) store.rememberResource(c, selected, 'creatives/' + creative);
  }
}

/**
 * LinkedIn's part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/linkedin-adapter.ts):
 * the account's creatives from the creatives finder (`q=criteria`, `creatives=List(...)` for named URNs, `campaigns=List(...)`
 * for a native campaign filter), a creative's campaign group from `adCampaigns`, and each creative's preview from
 * `GET /rest/adPreviews` (above), whose request names the selected account.
 */
const invalidList = (): never =>
  fail('REPORT_SHAPE_CHANGED', 'The platform returned an invalid preview list or continuation.');

/** Creatives are named by URN (a bare number means the same creative); the parent filters are bare numeric IDs. */
function normalize(kind: 'ad' | 'campaign' | 'adset', values: string[]): string[] {
  if (kind === 'ad') return values.map(id => (/^\d+$/.test(id) ? 'urn:li:sponsoredCreative:' + id : id));
  const group = kind === 'campaign' ? 'sponsoredCampaignGroup' : 'sponsoredCampaign';
  return values.map(value => {
    if (!new RegExp('^(?:urn:li:' + group + ':)?[1-9][0-9]{0,31}$').test(value))
      fail(
        'INVALID_ARGUMENT',
        'LinkedIn preview filters use campaign group IDs in campaign_ids and campaign IDs in adset_ids.',
      );
    return value.split(':').at(-1)!;
  });
}

async function select(request: AdPreviewRequest): Promise<AdPreviewSelection> {
  const {account, wanted, campaigns, adsets, limit, base, read, matches, pageSelection, notListed} = request;
  const campaignGroups = new Map<string, string>();
  const pageOf = async (after: string | null, _page: number, named = false): Promise<AdPreviewPage> => {
    const size = named ? wanted!.length : limit,
      listed = await read({
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
      invalidList();
    const creatives = listed.elements as JsonObject[];
    for (const row of creatives) {
      if (!object(row) || typeof row.id !== 'string' || !/^urn:li:sponsoredCreative:[1-9][0-9]{0,31}$/.test(row.id))
        invalidList();
      if (row.account !== undefined && row.account !== 'urn:li:sponsoredAccount:' + account)
        fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
      if (
        row.campaign !== undefined &&
        (typeof row.campaign !== 'string' || !/^urn:li:sponsoredCampaign:[1-9][0-9]{0,31}$/.test(row.campaign))
      )
        invalidList();
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
      const metadata = await read({
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
        invalidList();
      for (const row of metadata.elements as JsonObject[]) {
        if (!object(row)) invalidList();
        const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 ? String(row.id) : row.id,
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
          invalidList();
        if (row.account !== 'urn:li:sponsoredAccount:' + account) fail('ACCOUNT_SCOPE_MISMATCH', 'Not in this account');
        campaignGroups.set(urn, row.campaignGroup.split(':').at(-1)!);
      }
    }
    const rows: AdPreviewRow[] = creatives.map(row => ({
        id: row.id,
        name: text(row.name),
        adset: typeof row.campaign === 'string' ? row.campaign.split(':').at(-1) : undefined,
        campaign: campaignGroups.get(row.campaign),
        status: (
          {ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived', CANCELED: 'archived'} as Record<string, string>
        )[row.intendedStatus],
      })),
      token = listed.metadata?.nextPageToken;
    return {rows, after: token ?? null, more: token !== undefined && token !== null};
  };
  let chosen: AdPreviewRow[],
    paging: JsonObject = {},
    missing: string[] = [];
  if (wanted) {
    const page = await pageOf(null, 1, true),
      found = new Map(page.rows.map(row => [row.id, row]));
    if (page.more || found.size !== page.rows.length || page.rows.some(row => !wanted.includes(row.id))) invalidList();
    chosen = wanted.flatMap(id => (found.has(id) && matches(found.get(id)!, true) ? [found.get(id)!] : []));
    missing = wanted.filter(id => !found.has(id));
  } else {
    const selected = await pageSelection(pageOf);
    chosen = selected.chosen;
    paging = selected.paging;
  }
  return {
    rows: chosen,
    preview: async row => {
      const response = await read({
          action: 'linkedin_rest_ad_previews_get',
          ...base,
          query: {q: 'creative', creative: row.id, account: 'urn:li:sponsoredAccount:' + account},
        }),
        now = Date.now(),
        placements = linkedInPreviewLinks(response?.elements, now),
        links = [...new Set(placements.map(link => link.url))],
        rejected =
          !Array.isArray(response?.elements) ||
          response.elements.length > 100 ||
          response.elements.some((element: unknown) => linkedInPreviewLinks([element], now).length === 0);
      return {
        links,
        link: links[0] ?? null,
        placements,
        expires_at: placements[0]?.expires_at ?? null,
        expires: 'LinkedIn keeps this preview for up to 3 hours.',
        ...(rejected ? {note: 'LinkedIn returned no safe iframe preview link for one or more placements.'} : {}),
      };
    },
    extra: {...paging, ...notListed(missing)},
  };
}

export const linkedinAdPreviews: AdPreviewHooks = Object.freeze({platform: 'linkedin', normalize, select});
