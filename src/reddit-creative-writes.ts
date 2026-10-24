import {redditOutcome, redditSnapshots} from './reddit-writes.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {
  redditPostCreation,
  redditPromotedSource,
  redditAdPost,
  assertRedditPostCreation,
  validateRedditPromotion,
  redditPostCreationOutcome,
  authorizeRedditPostRead,
  verifyRedditPostCreation,
} from './reddit-post-creation.js';
// Reddit's own page step (a leaf): src/pagination.ts consults the provider hooks, which hold Reddit's write checks.
import {redditNextPage} from './reddit-paging.js';
import {stable} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

export const redditLeadFormSunset = '2026-09-21T00:00:00Z';
export const redditLeadFormSource = 'https://ads-api.reddit.com/docs/v3/history';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message: string): never => {
  throw new MirrorError('INVALID_REDDIT_MUTATION', message);
};
const failed = (message: string): never => {
  throw new MirrorError('STATE_TARGET_MISMATCH', message, {}, 502);
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const postId = (v: unknown): v is string => typeof v === 'string' && /^t3_[A-Za-z0-9]+$/.test(v);
const userId = (v: unknown): v is string => typeof v === 'string' && /^t2_[A-Za-z0-9]+$/.test(v);
export function redditCreativeKind(p: CompiledRequest): {kind: string; create: boolean; target?: string} | undefined {
  if (p.gateway !== 'reddit_native_action' || (p.origin && p.origin !== 'https://ads-api.reddit.com')) return;
  const creation = redditPostCreation(p);
  if (creation)
    return {kind: creation.structured ? 'structured_post_jobs' : 'posts', create: true, target: creation.profileId};
  if (p.method === 'POST' && /^\/api\/v3\/ad_accounts\/[^/]+\/lead_gen_forms$/.test(p.path))
    return {kind: 'lead_gen_forms', create: true};
  const update = /^\/api\/v3\/(posts|structured_posts)\/([^/]+)$/.exec(p.path);
  if (p.method === 'PATCH' && update) return {kind: update[1]!, create: false, target: update[2]!};
}
export function assertRedditCreativeAvailable(p: CompiledRequest): void {
  // Reddit gives a date, not an exact timezone. Conservatively stop at its start in UTC.
  if (redditCreativeKind(p)?.kind === 'lead_gen_forms' && Date.now() >= Date.parse(redditLeadFormSunset))
    throw new MirrorError(
      'PROVIDER_ACTION_UNSUPPORTED',
      'Reddit has withdrawn onsite lead-form creation. Use an external form with Pixel or Conversions API tracking; historical form reads remain available.',
      {source: redditLeadFormSource, sunset_at: redditLeadFormSunset},
    );
}
export function assertRedditCreative(p: CompiledRequest): void {
  const c = redditCreativeKind(p);
  if (!c) return;
  if (Object.keys(p.query).length || Object.keys(p.headers).length || p.specialTransport)
    invalid('Use the native Reddit JSON contract without query or header overrides.');
  const b = p.body;
  if (!object(b) || Object.keys(b).some(k => k !== 'data') || !object(b.data))
    return invalid('Use a native {data:{...}} request.');
  const d = b.data;
  if (redditPostCreation(p)) return assertRedditPostCreation(p, d);
  if (c.kind === 'lead_gen_forms') {
    if (Object.keys(d).some(k => !['ad_account_id', 'name', 'privacy_link', 'prompt', 'questions'].includes(k)))
      invalid('Lead forms accept only advertiser-defined fields.');
    if (d.ad_account_id !== undefined && d.ad_account_id !== p.accountId)
      invalid('The lead form must belong to the selected account.');
    for (const key of ['name', 'prompt'])
      if (typeof d[key] !== 'string' || !d[key].trim() || d[key].length > 10000 || /[\u0000]/.test(d[key]))
        invalid('Provide explicit nonempty lead-form ' + key + '.');
    let url: URL;
    try {
      url = new URL(d.privacy_link);
    } catch {
      return invalid('Provide an HTTPS privacy-policy URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || /[\r\n]/.test(d.privacy_link))
      invalid('The privacy-policy URL must use HTTPS without embedded credentials.');
    if (!Array.isArray(d.questions) || !d.questions.length || d.questions.length > 8)
      invalid('Choose explicit native questions, with at least one required.');
    const types = new Set<string>();
    for (const q of d.questions) {
      if (
        !object(q) ||
        Object.keys(q).some(k => !['type', 'required'].includes(k)) ||
        ![
          'EMAIL',
          'FIRST_NAME',
          'LAST_NAME',
          'PHONE_NUMBER',
          'POSTAL_CODE',
          'JOB_TITLE',
          'COMPANY',
          'COMPANY_EMAIL',
        ].includes(q.type) ||
        typeof q.required !== 'boolean' ||
        types.has(q.type)
      )
        invalid('Every lead question needs a unique native type and explicit required boolean.');
      types.add(q.type);
    }
    if (!d.questions.some((q: JsonObject) => q.required)) invalid('At least one lead-form question must be required.');
  } else if (!postId(c.target) || Object.keys(d).length !== 1 || typeof d.allow_comments !== 'boolean')
    invalid(
      'Post updates can only set an explicit allow_comments boolean on an exact t3_ post ID. Create a new post to change content.',
    );
}
const read = (p: CompiledRequest, path: string): CompiledRequest => ({
  ...p,
  action: 'AMCP_REDDIT_CREATIVE_READ',
  path,
  method: 'GET',
  query: {},
  headers: {},
  body: undefined,
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  responseControls: undefined,
  specialTransport: undefined,
  redditProfilesState: undefined,
});
export function redditCreativeSnapshots(p: CompiledRequest): CompiledRequest[] {
  const c = redditCreativeKind(p)!;
  const reads = [read(p, '/api/v3/ad_accounts/' + p.accountId)];
  if (!c.create) reads.push(read(p, p.path));
  if (!c.create || redditPostCreation(p))
    reads.push({...read(p, '/api/v3/ad_accounts/' + p.accountId + '/profiles'), redditProfilesState: true});
  const source = redditPromotedSource(p);
  if (source) reads.push(read(p, '/api/v3/posts/' + source));
  return reads;
}
/** Refresh provider account/profile association; cached ID discovery alone is insufficient. */
export async function readRedditProfiles(
  p: CompiledRequest,
  request: (r: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  if (!p.redditProfilesState) return request(p);
  let current: CompiledRequest | null = {...p, redditProfilesState: undefined},
    bytes = 0;
  const rows: JsonObject[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  for (let page = 0; page < 100 && current; page++) {
    const key = stable(current.query);
    if (cursors.has(key)) failed('Reddit profile pagination repeated a cursor.');
    cursors.add(key);
    const response = await request(current),
      d = response.data as JsonObject;
    if (
      response.status !== 200 ||
      !object(d) ||
      !Array.isArray(d.data) ||
      Object.keys(d).some(k => /error|fail/i.test(k) && d[k] != null) ||
      d.success === false ||
      d.has_more === true ||
      d.hasMore === true ||
      !object(d.pagination) ||
      (d.pagination.next_url !== null && typeof d.pagination.next_url !== 'string')
    )
      failed('The account profile collection is incomplete or failed.');
    bytes += Buffer.byteLength(JSON.stringify(d));
    if (bytes > 4 * 1024 * 1024) failed('Reddit profile discovery exceeded 4 MiB.');
    for (const value of d.data) {
      if (
        !object(value) ||
        !id(value.id) ||
        ids.has(value.id) ||
        !userId(value.reddit_user_id) ||
        typeof value.business_id !== 'string' ||
        !value.business_id ||
        (value.ad_account_id !== undefined && value.ad_account_id !== p.accountId)
      )
        failed('The account profile list has duplicate, foreign or incomplete identities.');
      ids.add(value.id);
      rows.push(value);
      if (rows.length > 1000) failed('Reddit profile discovery exceeded 1,000 profiles.');
    }
    current = redditNextPage(current, d, structuredClone(current));
  }
  if (current) failed('Reddit profile discovery exceeded 100 pages.');
  return {status: 200, headers: {}, data: {amcpRedditProfiles: rows.sort((a, b) => a.id.localeCompare(b.id, 'en'))}};
}
export function validateRedditProfiles(p: CompiledRequest, result: TransportResult): void {
  if (
    !p.redditProfilesState ||
    result.status !== 200 ||
    !Array.isArray((result.data as JsonObject)?.amcpRedditProfiles)
  )
    failed('The complete account profile snapshot is unavailable.');
}
export function validateRedditCreativePrerequisites(p: CompiledRequest, states: unknown[]): void {
  const c = redditCreativeKind(p),
    creation = redditPostCreation(p),
    adPost = redditAdPost(p);
  if ((!c && !adPost) || (c?.create && !creation)) return;
  const post = (states as JsonObject[]).map(s => s?.data).find(v => v?.id === (adPost ?? c?.target)),
    snapshot = (states as JsonObject[]).find(s => s?.amcpRedditProfiles),
    profiles = snapshot?.amcpRedditProfiles;
  if (
    !Array.isArray(profiles) ||
    (!creation && (!postId(post?.id) || !userId(post?.profile_id) || typeof post.allow_comments !== 'boolean'))
  )
    failed('The exact post author and comments configuration must be readable.');
  const matches = profiles.filter((v: JsonObject) =>
    creation ? v.id === creation.profileId : v.reddit_user_id === post.profile_id,
  );
  if (matches.length !== 1)
    throw new MirrorError(
      'RESOURCE_SCOPE_REQUIRED',
      'The post author is not an unambiguous current profile of the selected ad account.',
      {},
      403,
    );
  const profile = matches[0];
  if (profiles.filter((v: JsonObject) => v.reddit_user_id === profile.reddit_user_id).length !== 1)
    throw new MirrorError(
      'RESOURCE_SCOPE_REQUIRED',
      'The Reddit author has ambiguous account profile bindings.',
      {},
      403,
    );
  if (
    (p.scopeContext?.redditProfileId && p.scopeContext.redditProfileId !== profile.id) ||
    (p.scopeContext?.redditProfileUserId && p.scopeContext.redditProfileUserId !== profile.reddit_user_id)
  )
    throw new MirrorError('STATE_CHANGED', 'The post author or account profile changed after review.');
  p.scopeContext = {...p.scopeContext, redditProfileId: profile.id, redditProfileUserId: profile.reddit_user_id};
  validateRedditPromotion(p, states);
  // Discovery is complete; only the selected author's binding is configuration for this write.
  snapshot!.amcpRedditProfiles = matches;
}
export const redditCreativeServing = (p: CompiledRequest) =>
  redditCreativeKind(p)?.create === false || !!redditPromotedSource(p);
export function redditCreativeOutcome(p: CompiledRequest, result: TransportResult): boolean {
  if (redditPostCreation(p)) return redditPostCreationOutcome(p, result);
  const c = redditCreativeKind(p),
    d = (result.data as JsonObject)?.data,
    b = (p.body as JsonObject)?.data;
  if (!c || result.status !== (c.create ? 201 : 200) || !object(d) || !id(d.id)) return false;
  if (c.kind === 'lead_gen_forms')
    return (
      d.ad_account_id === p.accountId &&
      ['name', 'privacy_link', 'prompt', 'questions'].every(k => stable(d[k]) === stable(b[k]))
    );
  return (
    d.id === c.target && d.profile_id === p.scopeContext?.redditProfileUserId && d.allow_comments === b.allow_comments
  );
}
export function redditCreativeVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const c = redditCreativeKind(p)!,
    d = result.data.data;
  return [
    {
      read: read(p, '/api/v3/' + c.kind + '/' + d.id),
      expected: {
        ...(p.body as JsonObject).data,
        id: d.id,
        ...(c.kind === 'lead_gen_forms'
          ? {ad_account_id: p.accountId}
          : {profile_id: p.scopeContext!.redditProfileUserId}),
      },
      id: d.id,
    },
  ];
}

/** What a post, post update or lead form write changes, as prepare returns it for review. */
export function redditCreativeImpact(plan: CompiledRequest): JsonObject {
  if (redditPostCreation(plan))
    return {
      provider: 'reddit',
      scope: 'post_creation',
      may_affect_serving: !!redditPromotedSource(plan),
      effect: redditPromotedSource(plan)
        ? 'Creates promoted content and disables voting and comments on BOTH the original community post and its promoted copy. Preserve the original headline.'
        : 'Publishes content for the selected Reddit profile. Posts have no paused state; create the subsequent advertising entity as PAUSED.',
      verification:
        'The original job is polled read-only, then the exact post configuration and current account/profile author are checked before its ID can be reused. Media URLs are ingested and replaced by Reddit-hosted references; byte or visual identity, approval and serving are not certified. Voting state on the original post is not exposed by this read contract.',
      media:
        'Reddit fetches explicit public media URLs directly; AMCP never asks the LLM to download and relay them. Private Drive authorization/transfer is a separate unfinished bridge. Source URLs must remain available and unchanged until ingestion finishes.',
      recovery:
        'Retain the original review and job ID across restarts. Poll amcp_campaign verify; pending, failed or uncertain creation never triggers another POST. Verified post IDs are returned in verified_resources.',
    };
  return {
    provider: 'reddit',
    scope: redditCreativeKind(plan)!.kind,
    may_affect_serving: redditCreativeServing(plan),
    effect: redditCreativeServing(plan)
      ? 'Changes comments on the existing post wherever it is used. Content is immutable on these update routes.'
      : 'Creates an onsite lead form; no leads are collected by this operation and no ad is activated.',
    verification:
      'Exact selected-account form, or exact post and current account/profile author binding; read-back checks the requested fields.',
    recovery: 'Preserve the receipt and original idempotency key. Uncertain mutations cannot be resubmitted.',
    ...(redditCreativeKind(plan)!.kind === 'lead_gen_forms'
      ? {
          sunset_at: redditLeadFormSunset,
          source: redditLeadFormSource,
          warning:
            'Reddit withdraws onsite forms on 2026-09-21 and pauses existing ads using them on 2026-09-30. Use an external form with the appropriate measurement setup.',
        }
      : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const redditCreativeFamily: ReviewedFamily = {
  name: 'reddit_creatives',
  files: [
    'src/reddit-creative-writes.ts / src/reddit-post-creation.ts',
    ['tests/reddit-creative-writes.test.ts', 'tests/reddit-post-creation.test.ts'],
  ],
  kind: redditCreativeKind,
  available: plan => assertRedditCreativeAvailable(plan),
  scope: (c, write, plan) => {
    if (!write && redditPostCreation(plan!) && !c.scopes.includes('adsread'))
      throw new MirrorError('INSUFFICIENT_SCOPE', 'Reddit post verification requires adsread.');
  },
  authorize: (plan, connection, account, store) => authorizeRedditPostRead(plan, connection, store, account),
  snapshots: redditSnapshots,
  isRead: (read: CompiledRequest) => read.gateway === 'reddit_native_action' && !!read.redditProfilesState,
  reader: (read, next) => readRedditProfiles(read, next),
  validateState: validateRedditProfiles,
  snapshotState: (read, data, gateway) => gateway(),
  prerequisites: (plan, state) => validateRedditCreativePrerequisites(plan, state),
  impact: redditCreativeImpact,
  outcome: redditOutcome,
  created: (plan, data) =>
    redditPostCreation(plan)?.structured &&
    typeof data?.data?.id === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(data.data.id)
      ? ['structured_post_jobs/' + data.data.id]
      : [],
  verification: redditCreativeVerification,
  verify: (plan, v) =>
    redditPostCreation(plan)
      ? verifyRedditPostCreation(plan, v.result, v.reviewId, v.connection, v.store, read =>
          readRedditProfiles(
            read,
            v.guarded('Post verification must remain read-only.', {
              check: connection => {
                if (!connection.scopes.includes('adsread'))
                  throw new MirrorError('INSUFFICIENT_SCOPE', 'Reddit post verification requires adsread.');
              },
            }),
          ),
        )
      : undefined,
  pendingOnRetryableError: plan => !!redditPostCreation(plan),
  activates: plan => !!redditCreativeServing(plan),
};
