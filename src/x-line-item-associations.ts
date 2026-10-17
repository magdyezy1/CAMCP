import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, fail, stateReadOf} from './family-kit.js';

/**
 * Promoted accounts, media creatives and scheduled promoted Tweets of X Ads line items, Ads API v12 (Campaign Management
 * reference, "Promoted Accounts", "Media Creatives" and "Scheduled Promoted Tweets"; docs.x.com copy read on 2026-09-24 and
 * rechecked 2026-09-27). Each associates something with a line item and cannot be updated: POST creates the association
 * and DELETE removes it. Promoted accounts and media creatives are created ACTIVE, so they serve at once under an active
 * line item and campaign; a scheduled promoted Tweet serves once its scheduled Tweet is published.
 * - A promoted account associates a user (user_id) with a PROMOTED_ACCOUNT line item. X refuses other line items
 *   (INCOMPATIBLE_LINE_ITEM) and ineligible users, and ignores a user already promoted.
 * - A media creative associates an account media item with a line item, for in-stream (PREROLL) or Audience Platform image
 *   ads. landing_url is for image ads: it is ignored for preroll media and required when the line item objective is
 *   WEBSITE_CLICKS.
 * - A scheduled promoted Tweet associates a scheduled Tweet (scheduled_tweet_id) with a line item; it becomes a promoted
 *   Tweet when the Tweet is published.
 */
type Resource = 'promoted_accounts' | 'media_creatives' | 'scheduled_promoted_tweets';
type Kind = {resource: Resource; op: 'create' | 'delete'};
type State = {
  resource: Resource;
  lineItemId?: string;
  id?: string;
  userId?: string;
  mediaId?: string;
  scheduledTweetId?: string;
};
type Read = CompiledRequest & {xAssociationState?: State};
const gateway = 'x_ads_native_action',
  nativeId = /^[a-z0-9]{1,32}$/,
  snowflake = /^[1-9][0-9]{0,24}$/,
  removedStatuses = ['DELETED'];
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  return fail('INVALID_X_LINE_ITEM_ASSOCIATION', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
const labels: Record<Resource, string> = {
  promoted_accounts: 'promoted account',
  media_creatives: 'media creative',
  scheduled_promoted_tweets: 'scheduled promoted Tweet',
};
export function xAssociationKind(p: CompiledRequest): Kind | undefined {
  if (p.gateway !== gateway || p.specialTransport) return;
  const m =
    /^\/12\/accounts\/[a-z0-9]{1,32}\/(promoted_accounts|media_creatives|scheduled_promoted_tweets)(?:\/([a-z0-9]{1,32}))?$/.exec(
      p.path,
    );
  if (!m) return;
  if (p.method === 'POST' && !m[2]) return {resource: m[1] as Resource, op: 'create'};
  if (p.method === 'DELETE' && m[2]) return {resource: m[1] as Resource, op: 'delete'};
  return;
}
const account = (p: CompiledRequest) => p.path.split('/')[3]!,
  idOf = (p: CompiledRequest) => p.path.split('/')[5]!;
const body = (p: CompiledRequest): JsonObject => (object(p.body) ? p.body : {});
function landing(v: unknown): void {
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(v))
    invalid('landing_url is a website URL of at most 2048 characters without spaces or control characters.');
  let u: URL;
  try {
    u = new URL(v as string);
  } catch {
    return invalid('landing_url must be an absolute URL.');
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.'))
    invalid('landing_url must be an http or https website URL without credentials.');
}
export function assertXAssociation(p: CompiledRequest): void {
  const kind = xAssociationKind(p);
  if (!kind) return;
  if (account(p) !== p.accountId) fail('ACCOUNT_SCOPE_MISMATCH', 'The request must use the selected account.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers ?? {}).length)
    invalid('Line item associations take their parameters in the body, without query or header overrides.');
  const b = p.body === undefined ? {} : p.body;
  if (!object(b)) invalid('Provide the native parameters.');
  if (kind.op === 'delete') {
    if (Object.keys(b).length) invalid('Deleting a ' + labels[kind.resource] + ' takes no parameters.');
    return;
  }
  const allowed =
    kind.resource === 'promoted_accounts'
      ? ['line_item_id', 'user_id']
      : kind.resource === 'scheduled_promoted_tweets'
        ? ['line_item_id', 'scheduled_tweet_id']
        : ['line_item_id', 'account_media_id', 'landing_url'];
  const extra = Object.keys(b).filter(k => !allowed.includes(k));
  if (extra.length) invalid('Unqualified fields: ' + extra.join(', ') + '.');
  if (typeof b.line_item_id !== 'string' || !nativeId.test(b.line_item_id))
    invalid('line_item_id is the native ID of a line item of the selected account.');
  if (kind.resource === 'promoted_accounts') {
    if (typeof b.user_id !== 'string' || !snowflake.test(b.user_id))
      invalid('user_id is the numeric ID of the user to promote, as a string.');
    return;
  }
  if (kind.resource === 'scheduled_promoted_tweets') {
    if (typeof b.scheduled_tweet_id !== 'string' || !snowflake.test(b.scheduled_tweet_id))
      invalid('scheduled_tweet_id is the numeric ID of a scheduled Tweet of the account, as a string.');
    return;
  }
  if (typeof b.account_media_id !== 'string' || !nativeId.test(b.account_media_id))
    invalid('account_media_id is the native ID of an account media item of the selected account.');
  if (b.landing_url !== undefined) landing(b.landing_url);
}
function read(p: CompiledRequest, path: string, query: JsonObject = {}): Read {
  return stateReadOf<Read>(p, 'AMCP_X_ASSOCIATION_READ', '/12/accounts/' + account(p) + path, query, {
    xAssociationState: undefined,
  });
}
const stateRead = (p: CompiledRequest, state: State): Read => ({...read(p, ''), xAssociationState: state});
export function xAssociationSnapshots(p: CompiledRequest): Read[] {
  const kind = xAssociationKind(p)!,
    b = body(p);
  if (kind.op === 'delete') return [stateRead(p, {resource: kind.resource, id: idOf(p)})];
  return [
    stateRead(p, {
      resource: kind.resource,
      lineItemId: String(b.line_item_id),
      ...(kind.resource === 'promoted_accounts'
        ? {userId: String(b.user_id)}
        : kind.resource === 'scheduled_promoted_tweets'
          ? {scheduledTweetId: String(b.scheduled_tweet_id)}
          : {mediaId: String(b.account_media_id)}),
    }),
  ];
}
export function isXAssociationRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).xAssociationState;
}
const view = (r: Resource, row: JsonObject) => ({
  id: String(row.id),
  lineItemId: String(row.line_item_id),
  ...(r === 'promoted_accounts'
    ? {userId: String(row.user_id)}
    : r === 'scheduled_promoted_tweets'
      ? {scheduledTweetId: String(row.scheduled_tweet_id), tweetId: row.tweet_id == null ? null : String(row.tweet_id)}
      : {
          mediaId: String(row.account_media_id),
          landingUrl: row.landing_url ?? null,
          creativeType: row.creative_type ?? null,
        }),
  status: row.entity_status ?? null,
  deleted: row.deleted === true,
});
export async function readXAssociations(
  p: CompiledRequest,
  send: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).xAssociationState;
  if (!s) return send(p);
  let requests = 0;
  const get = async (q: Read) => {
    if (++requests > 10) unverified('Line item association reads exceeded their bound.');
    const r = await send(q),
      d = r.data;
    if (r.status !== 200 || !object(d) || (Array.isArray(d.errors) && d.errors.length))
      unverified('X returned a failed or unrecognized read.');
    return d as JsonObject;
  };
  const acct = await get(read(p, ''));
  if (!object(acct.data) || String(acct.data.id) !== account(p)) unverified('X returned another account.');
  let association: JsonObject | null = null,
    lineItemId = s.lineItemId;
  if (s.id) {
    const d = (await get(read(p, '/' + s.resource + '/' + s.id, {with_deleted: true}))).data;
    if (!object(d) || String(d.id) !== s.id || !nativeId.test(String(d.line_item_id)))
      fail(
        'STATE_TARGET_MISMATCH',
        labels[s.resource] + ' ' + s.id + ' is not in the selected account.',
        {id: s.id},
        409,
      );
    association = view(s.resource, d);
    lineItemId = String(d.line_item_id);
  }
  const l = (await get(read(p, '/line_items/' + lineItemId, {with_deleted: true}))).data;
  if (!object(l) || String(l.id) !== lineItemId)
    fail(
      'STATE_TARGET_MISMATCH',
      'Line item ' + lineItemId + ' is not a line item of the selected account.',
      {line_item_id: lineItemId!},
      409,
    );
  const campaignId = String(l.campaign_id ?? ''),
    c = nativeId.test(campaignId)
      ? (await get(read(p, '/campaigns/' + campaignId, {with_deleted: true}))).data
      : undefined;
  if (!object(c) || String(c.id) !== campaignId) unverified('Line item ' + lineItemId + ' names no readable campaign.');
  const listed = await get(read(p, '/' + s.resource, {line_item_ids: lineItemId, count: 1000}));
  if (!Array.isArray(listed.data) || listed.next_cursor)
    unverified('The ' + labels[s.resource] + 's of line item ' + lineItemId + ' are incomplete.');
  const existing: JsonObject = {};
  for (const row of listed.data as unknown[]) {
    if (
      !object(row) ||
      !nativeId.test(String(row.id)) ||
      String(row.line_item_id) !== lineItemId ||
      Object.hasOwn(existing, 'a' + row.id)
    )
      unverified('A ' + labels[s.resource] + ' row is foreign, malformed or repeated.');
    if (row.deleted !== true) {
      const v = view(s.resource, row);
      existing['a' + v.id] = v;
    }
  }
  let eligible: boolean | null = null,
    media: JsonObject | null = null,
    scheduled: JsonObject | null = null;
  if (s.userId) {
    const users = await get(read(p, '/promotable_users', {count: 1000}));
    if (!Array.isArray(users.data) || users.next_cursor)
      unverified('The promotable users of the account are incomplete.');
    eligible = (users.data as unknown[]).some(u => object(u) && String(u.user_id) === s.userId && u.deleted !== true);
  }
  if (s.mediaId) {
    const m = (await get(read(p, '/account_media/' + s.mediaId, {with_deleted: true}))).data;
    if (!object(m) || String(m.id) !== s.mediaId)
      fail(
        'STATE_TARGET_MISMATCH',
        'Account media ' + s.mediaId + ' is not in the selected account.',
        {account_media_id: s.mediaId},
        409,
      );
    media = {id: s.mediaId, creativeType: m.creative_type ?? null, deleted: m.deleted === true};
  }
  if (s.scheduledTweetId) {
    const t = (await get(read(p, '/scheduled_tweets/' + s.scheduledTweetId))).data;
    if (!object(t) || String(t.id ?? t.id_str) !== s.scheduledTweetId)
      fail(
        'STATE_TARGET_MISMATCH',
        'Scheduled Tweet ' + s.scheduledTweetId + ' is not a scheduled Tweet of the selected account.',
        {scheduled_tweet_id: s.scheduledTweetId},
        409,
      );
    scheduled = {
      id: s.scheduledTweetId,
      scheduledAt: t.scheduled_at ?? null,
      completedAt: t.completed_at ?? null,
      status: t.scheduled_status ?? null,
    };
  }
  return {
    status: 200,
    headers: {},
    data: {
      accountId: account(p),
      line: {
        id: lineItemId,
        campaignId,
        productType: l.product_type ?? null,
        objective: l.objective ?? null,
        status: l.entity_status ?? null,
        deleted: l.deleted === true,
      },
      campaign: {id: campaignId, status: c.entity_status ?? null, deleted: c.deleted === true},
      association,
      existing,
      eligible,
      media,
      scheduled,
    },
  };
}
export function validateXAssociationState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).xAssociationState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.line) ||
    !object(d.campaign) ||
    !object(d.existing) ||
    !!s.id !== object(d.association) ||
    !!s.mediaId !== object(d.media) ||
    !!s.scheduledTweetId !== object(d.scheduled) ||
    !!s.userId !== (typeof d.eligible === 'boolean')
  )
    unverified('Missing verified line item association state.');
}
export function xAssociationPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = xAssociationKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.line) || !object(s.existing)) unverified('Missing verified line item association state.');
  const label = labels[kind.resource];
  if (kind.op === 'delete') {
    const a = s.association;
    if (!object(a) || a.deleted === true) invalid('The ' + label + ' ' + idOf(p) + ' is deleted.');
    return;
  }
  if (s.line.deleted === true || removedStatuses.includes(s.line.status))
    invalid('Line item ' + s.line.id + ' is deleted.');
  if (object(s.campaign) && s.campaign.deleted === true) invalid('Campaign ' + s.campaign.id + ' is deleted.');
  const b = body(p);
  if (kind.resource === 'promoted_accounts') {
    if (s.line.productType !== 'PROMOTED_ACCOUNT')
      invalid(
        'Line item ' +
          s.line.id +
          ' is ' +
          String(s.line.productType) +
          '; promoted accounts need a PROMOTED_ACCOUNT line item.',
      );
    if (s.eligible !== true) invalid('User ' + String(b.user_id) + ' is not a promotable user of this account.');
    const same = Object.values(s.existing).find(a => object(a) && a.userId === b.user_id);
    if (object(same))
      fail(
        'CONFIGURATION_EXISTS',
        'User ' + String(b.user_id) + ' is already promoted by line item ' + s.line.id + ' as ' + String(same.id) + '.',
        {id: String(same.id)},
      );
    return;
  }
  if (kind.resource === 'scheduled_promoted_tweets') {
    if (!['PROMOTED_TWEETS', 'PROMOTED_ACCOUNT'].includes(String(s.line.productType)))
      invalid(
        'Line item ' +
          s.line.id +
          ' is ' +
          String(s.line.productType) +
          '; scheduled Tweets are promoted by PROMOTED_TWEETS or PROMOTED_ACCOUNT line items.',
      );
    if (object(s.scheduled) && s.scheduled.completedAt)
      invalid(
        'Scheduled Tweet ' +
          String(b.scheduled_tweet_id) +
          ' is already published; promote the published Tweet instead.',
      );
    const same = Object.values(s.existing).find(a => object(a) && a.scheduledTweetId === b.scheduled_tweet_id);
    if (object(same))
      fail(
        'CONFIGURATION_EXISTS',
        'Scheduled Tweet ' +
          String(b.scheduled_tweet_id) +
          ' is already promoted by line item ' +
          s.line.id +
          ' as ' +
          String(same.id) +
          '.',
        {id: String(same.id)},
      );
    return;
  }
  const media = s.media;
  if (!object(media) || media.deleted === true) invalid('Account media ' + String(b.account_media_id) + ' is deleted.');
  const preroll = /PREROLL/.test(String(media.creativeType));
  if (preroll && b.landing_url !== undefined)
    invalid('X ignores landing_url for preroll media; set the link with a preroll call to action instead.');
  if (!preroll && s.line.objective === 'WEBSITE_CLICKS' && b.landing_url === undefined)
    invalid('Line item ' + s.line.id + ' has the WEBSITE_CLICKS objective, so the media creative needs a landing_url.');
  const same = Object.values(s.existing).find(a => object(a) && a.mediaId === b.account_media_id);
  if (object(same))
    fail(
      'CONFIGURATION_EXISTS',
      'Account media ' +
        String(b.account_media_id) +
        ' is already a media creative of line item ' +
        s.line.id +
        ' (' +
        String(same.id) +
        ').',
      {id: String(same.id)},
    );
}
/** New associations are ACTIVE and serve at once under an active line item and campaign. */
export function xAssociationNeedsConfirmation(p: CompiledRequest): boolean {
  return xAssociationKind(p)?.op === 'create';
}
export function xAssociationImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = xAssociationKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {},
    b = body(p),
    line = object(s.line) ? s.line : null,
    campaign = object(s.campaign) ? s.campaign : null;
  const serving = kind.op === 'create' && line?.status === 'ACTIVE' && campaign?.status === 'ACTIVE';
  return {
    provider: 'x',
    scope: kind.resource,
    operation: kind.op,
    line_item: line,
    campaign,
    before: object(s.association) ? s.association : null,
    after:
      kind.op === 'delete'
        ? null
        : kind.resource === 'promoted_accounts'
          ? {userId: b.user_id}
          : kind.resource === 'scheduled_promoted_tweets'
            ? {
                scheduledTweetId: b.scheduled_tweet_id,
                scheduledAt: object(s.scheduled) ? s.scheduled.scheduledAt : null,
              }
            : {
                mediaId: b.account_media_id,
                landingUrl: b.landing_url ?? null,
                creativeType: object(s.media) ? s.media.creativeType : null,
              },
    may_affect_serving: kind.op === 'create' ? serving : true,
    effect:
      kind.op === 'create'
        ? kind.resource === 'scheduled_promoted_tweets'
          ? 'Promotes the scheduled Tweet once it is published' +
            (serving
              ? '; the line item and its campaign are active, so it serves from then on.'
              : ', while the line item and its campaign are active.')
          : 'Creates an ACTIVE ' +
            labels[kind.resource] +
            (serving
              ? ' that serves at once: the line item and its campaign are active.'
              : '; it serves once the line item and its campaign are active.')
        : 'Removes the ' + labels[kind.resource] + ' from the line item; it stops serving.',
    verification:
      kind.op === 'create'
        ? 'Reads the new ' +
          labels[kind.resource] +
          ' by ID and compares its line item and ' +
          (kind.resource === 'promoted_accounts'
            ? 'user'
            : kind.resource === 'scheduled_promoted_tweets'
              ? 'scheduled Tweet'
              : 'account media') +
          '.'
        : 'Reads the ' + labels[kind.resource] + ' again and checks that it is deleted.',
    source: 'https://docs.x.com/x-ads-api/campaign-management/reference',
  };
}
export function xAssociationOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const kind = xAssociationKind(p)!,
    d = r.data,
    t = object(d) && object(d.data) ? d.data : undefined,
    b = body(p);
  if (
    ![200, 201].includes(r.status) ||
    !t ||
    !nativeId.test(String(t.id)) ||
    (Array.isArray((d as JsonObject).errors) && (d as JsonObject).errors.length)
  )
    return false;
  if (kind.op === 'delete') return t.id === idOf(p) && t.deleted === true;
  return (
    t.line_item_id === b.line_item_id &&
    t.deleted !== true &&
    (kind.resource === 'promoted_accounts'
      ? String(t.user_id) === b.user_id
      : kind.resource === 'scheduled_promoted_tweets'
        ? String(t.scheduled_tweet_id) === b.scheduled_tweet_id
        : t.account_media_id === b.account_media_id)
  );
}
export function xAssociationVerification(
  p: CompiledRequest,
  result: JsonObject,
  _before: unknown[],
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = xAssociationKind(p)!,
    created = result.data?.data?.id,
    id = kind.op === 'create' ? created : idOf(p),
    b = body(p);
  if (typeof id !== 'string' || !nativeId.test(id))
    fail('VERIFICATION_UNSUPPORTED', 'The receipt names no ' + labels[kind.resource] + ' to verify.');
  const expected =
    kind.op === 'delete'
      ? {id, deleted: true}
      : {
          id,
          lineItemId: b.line_item_id,
          ...(kind.resource === 'promoted_accounts'
            ? {userId: b.user_id}
            : kind.resource === 'scheduled_promoted_tweets'
              ? {scheduledTweetId: b.scheduled_tweet_id}
              : {mediaId: b.account_media_id, ...(b.landing_url !== undefined ? {landingUrl: b.landing_url} : {})}),
          deleted: false,
        };
  return [
    {
      read: stateRead(p, {resource: kind.resource, id}),
      expected: {association: expected},
      id: labels[kind.resource] + ' ' + id,
    },
  ];
}
export function xAssociationObserved(_read: CompiledRequest, data: JsonObject): JsonObject {
  return {association: object(data.association) ? data.association : null};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const xAssociationFamily: ReviewedFamily = defineFamily({
  name: 'x_line_item_associations',
  files: ['src/x-line-item-associations.ts', ['tests/x-line-item-associations.test.mjs']],
  kind: xAssociationKind,
  assert: assertXAssociation,
  snapshots: xAssociationSnapshots,
  isRead: isXAssociationRead,
  reader: readXAssociations,
  validateState: validateXAssociationState,
  prerequisites: xAssociationPrerequisites,
  impact: xAssociationImpact,
  outcome: xAssociationOutcome,
  verification: xAssociationVerification,
  observed: xAssociationObserved,
  spendConfirmation: {
    needed: xAssociationNeedsConfirmation,
    message:
      'A new promoted account or media creative is ACTIVE and serves at once under an active line item and campaign. Review them and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: true,
  activates: xAssociationNeedsConfirmation,
});
