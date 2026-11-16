import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {defineFamily, failWithStatus, readOf, type StatusRefusal} from './family-kit.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import type {Store} from './store.js';
import {writeClaim} from './job-repository.js';

const object = (v: any): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const fail: StatusRefusal = failWithStatus(403);
export const linkedinPostId = (id: unknown): id is string =>
  typeof id === 'string' && /^urn:li:(?:ugcPost|share):\d+$/.test(id);
export function linkedinDSC(plan: CompiledRequest) {
  return plan.gateway === 'linkedin_native_action' && plan.path === '/rest/posts' && plan.method === 'POST';
}
export function assertLinkedInDSC(plan: CompiledRequest): void {
  const b = plan.body as JsonObject;
  const bad = (message: string): never => {
    throw new MirrorError('INVALID_LINKEDIN_DSC', message);
  };
  const keys = (v: any, allowed: string[]) => {
    if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) bad('Unsupported DSC field or object shape.');
  };
  keys(b, [
    'author',
    'commentary',
    'visibility',
    'distribution',
    'content',
    'lifecycleState',
    'isReshareDisabledByAuthor',
    'adContext',
    'contentLandingPage',
    'contentCallToActionLabel',
  ]);
  if (!/^\d+$/.test(plan.accountId ?? '') || !/^urn:li:organization:\d+$/.test(b.author ?? ''))
    bad(
      'Select an account and explicit organization author. Person/organic posts are outside the reviewed DSC contract.',
    );
  if (typeof b.commentary !== 'string' || !b.commentary.trim() || b.commentary.length > 3000)
    bad('Provide DSC commentary of 1–3000 characters.');
  keys(b.distribution, ['feedDistribution', 'targetEntities', 'thirdPartyDistributionChannels']);
  if (
    b.visibility !== 'PUBLIC' ||
    b.lifecycleState !== 'PUBLISHED' ||
    b.distribution.feedDistribution !== 'NONE' ||
    b.isReshareDisabledByAuthor !== true
  )
    bad(
      'DSC posts require PUBLISHED, PUBLIC, feedDistribution NONE and isReshareDisabledByAuthor true. They have no paused state; create the later ad creative as PAUSED.',
    );
  for (const key of ['targetEntities', 'thirdPartyDistributionChannels'])
    if (b.distribution[key] !== undefined && (!Array.isArray(b.distribution[key]) || b.distribution[key].length))
      bad('Additional distribution is outside the reviewed non-feed DSC contract.');
  keys(b.adContext, ['dscAdAccount', 'dscStatus']);
  if (b.adContext.dscAdAccount !== 'urn:li:sponsoredAccount:' + plan.accountId || b.adContext.dscStatus !== 'ACTIVE')
    bad('adContext must identify exactly the selected sponsored account and ACTIVE content availability.');
  keys(b.content, ['media']);
  keys(b.content.media, ['id', 'title', 'altText']);
  if (!/^urn:li:(?:image|video):[A-Za-z0-9_-]+$/.test(b.content.media.id ?? ''))
    bad('Use one provider-ready image/video URN. Other post formats are not qualified.');
  for (const key of ['title', 'altText'])
    if (
      b.content.media[key] !== undefined &&
      (typeof b.content.media[key] !== 'string' || b.content.media[key].length > 1000)
    )
      bad('Media title/altText must be text of at most 1000 characters.');
  if (b.contentLandingPage !== undefined) {
    let url: URL;
    try {
      url = new URL(b.contentLandingPage);
    } catch {
      return bad('Use a complete HTTPS landing-page URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      bad('Use an HTTPS landing-page URL without embedded credentials.');
  }
  if (
    b.contentCallToActionLabel !== undefined &&
    (!b.contentLandingPage ||
      ![
        'APPLY',
        'DOWNLOAD',
        'VIEW_QUOTE',
        'LEARN_MORE',
        'SIGN_UP',
        'SUBSCRIBE',
        'REGISTER',
        'JOIN',
        'ATTEND',
        'REQUEST_DEMO',
      ].includes(b.contentCallToActionLabel))
  )
    bad('Select a documented call-to-action label and provide contentLandingPage.');
}
export function assertLinkedInOrganization(connection: Connection, account: string, author: string) {
  const path = '/rest/organizations/' + author.split(':').at(-1);
  if (
    !/^urn:li:organization:\d+$/.test(author) ||
    !connection.resourceBindings?.some(
      b => b.accountId === account && b.pathPrefix === path && Object.keys(b.query ?? {}).length === 0,
    )
  )
    fail(
      'LINKEDIN_ORGANIZATION_BINDING_REQUIRED',
      'An administrator must bind this exact organization to the selected account and connection. Account access does not establish Page access.',
    );
}
export function assertLinkedInDSCGrant(plan: CompiledRequest, c: Connection, write = true) {
  assertLinkedInDSC(plan);
  assertLinkedInOrganization(c, plan.accountId!, (plan.body as JsonObject).author);
  const scopes = write ? ['w_organization_social', 'r_organization_social'] : ['r_organization_social'];
  if (scopes.some(s => !c.scopes.includes(s)))
    fail(
      'INSUFFICIENT_SCOPE',
      'AMCP DSC creation requires w_organization_social and r_organization_social for authoring and mandatory read-back. Check token grants, app product access and Page role separately; reconnect after grants change.',
    );
}
function document(store: Store, tenant: string, kind: string, id: string): JsonObject | undefined {
  try {
    return store.document(tenant, kind, id);
  } catch (e) {
    if (e instanceof MirrorError && e.code === 'NOT_FOUND') return undefined;
    throw e;
  }
}
function mediaBound(store: Store, c: Connection, id: string, urn: string) {
  const path = '/rest/' + (urn.startsWith('urn:li:video:') ? 'videos' : 'images') + '/' + urn;
  if (
    c.resourceBindings?.some(
      b => b.accountId === id && decodeURIComponent(b.pathPrefix) === path && Object.keys(b.query ?? {}).length === 0,
    )
  )
    return true;
  return store
    .documents(c.tenantId, 'workspace_asset')
    .some(
      a =>
        a.connection_id === c.id &&
        a.account_id === id &&
        a.platform === 'linkedin' &&
        a.media_id === urn &&
        a.status_source === 'provider' &&
        a.ready === true,
    );
}
const specialMedia = /^\/rest\/(?:images|videos)\/(urn:li:(?:image|video):[A-Za-z0-9_-]+)$/,
  specialPost = /^\/rest\/posts\/(urn:li:(?:ugcPost|share):\d+)$/;
/**
 * The requests authorizeLinkedInSpecial decides (its read authorizer's claim): a DSC creation, and GET reads of one
 * image, video or post.
 */
export function linkedinSpecialRequest(plan: CompiledRequest): boolean {
  if (plan.gateway !== 'linkedin_native_action') return false;
  if (linkedinDSC(plan)) return true;
  let path: string;
  try {
    path = decodeURIComponent(plan.path);
  } catch {
    return false;
  }
  return plan.method === 'GET' && plan.readOnly && (specialMedia.test(path) || specialPost.test(path));
}
/** Internal verification context grants one read of the returned ID, never ownership.
 * Native request inputs cannot supply scopeContext. Ownership follows an exact read. */
export function authorizeLinkedInSpecial(plan: CompiledRequest, c: Connection, store: Store, id: string): boolean {
  if (plan.gateway !== 'linkedin_native_action') return false;
  if (linkedinDSC(plan)) {
    assertLinkedInDSCGrant(plan, c);
    if (!mediaBound(store, c, id, (plan.body as JsonObject).content.media.id))
      fail(
        'LINKEDIN_MEDIA_BINDING_REQUIRED',
        'Import and verify this media with the selected connection/account, or provision an exact media binding before DSC preparation.',
      );
    return true;
  }
  const path = decodeURIComponent(plan.path),
    media = specialMedia.exec(path);
  if (media && plan.method === 'GET' && plan.readOnly) {
    if (mediaBound(store, c, id, media[1]!)) return true;
    fail(
      'LINKEDIN_MEDIA_BINDING_REQUIRED',
      'This media has no verified receipt or exact administrator binding in the selected connection/account.',
    );
  }
  const post = specialPost.exec(path);
  if (post && plan.method === 'GET' && plan.readOnly) {
    const retained = document(store, c.tenantId, 'linkedin_post', c.id + '/' + post[1]);
    if (retained?.account_id === id) {
      assertLinkedInOrganization(c, id, retained.author);
      if (!c.scopes.includes('r_organization_social'))
        fail('INSUFFICIENT_SCOPE', 'Reading this organization post requires r_organization_social.');
      return true;
    }
    const reviewId = plan.scopeContext?.linkedinPostReviewId;
    if (reviewId) {
      const review = document(store, c.tenantId, 'write_review', reviewId),
        row = writeClaim(store, c.tenantId, reviewId);
      if (
        review?.connection_id === c.id &&
        review.plan?.accountId === id &&
        linkedinDSC(review.plan) &&
        row?.state === 'complete'
      ) {
        const result = JSON.parse(row.result);
        if (result.success === true && result.status === 201 && result.headers?.['x-restli-id'] === post[1]) {
          assertLinkedInDSCGrant(review.plan, c, false);
          return true;
        }
      }
    }
    fail('RESOURCE_SCOPE_REQUIRED', 'Read this newly created DSC through its completed review before reusing it.');
  }
  return false;
}
export function linkedinDSCReads(plan: CompiledRequest): CompiledRequest[] {
  const media = (plan.body as JsonObject).content.media.id;
  const base = (path: string): CompiledRequest =>
    readOf(plan, {
      action: 'AMCP_DSC_STATE_READ',
      path,
      query: {},
      headers: Object.fromEntries(
        Object.entries(plan.headers).filter(([k]) => ['LinkedIn-Version', 'X-Restli-Protocol-Version'].includes(k)),
      ),
      clears: [],
    });
  return [
    // The account the post is made under (R2.5 M1, the ACCOUNT role): a review keeps its identity.
    {...base('/rest/adAccounts/' + plan.accountId), stateRole: 'account'},
    base('/rest/' + (media.startsWith('urn:li:video:') ? 'videos' : 'images') + '/' + encodeURIComponent(media)),
  ];
}
export function linkedinMediaProjection(plan: CompiledRequest, data: JsonObject): JsonObject {
  const b = plan.body as JsonObject;
  if (
    data.id !== b.content.media.id ||
    data.owner !== b.author ||
    data.status !== 'AVAILABLE' ||
    (data.mediaLibraryMetadata?.associatedAccount !== undefined &&
      data.mediaLibraryMetadata.associatedAccount !== b.adContext.dscAdAccount)
  )
    fail(
      'LINKEDIN_MEDIA_NOT_READY',
      'The exact media must be AVAILABLE, owned by the DSC author and accessible in the selected account. AMCP currently qualifies matching owner/author only.',
    );
  return {
    id: data.id,
    owner: data.owner,
    status: data.status,
    associatedAccount: data.mediaLibraryMetadata?.associatedAccount ?? null,
  };
}
export function rememberLinkedInPost(store: Store, c: Connection, plan: CompiledRequest, id: string) {
  assertLinkedInDSCGrant(plan, c, false);
  store.putDocument(c.tenantId, 'linkedin_post', c.id + '/' + id, {
    account_id: plan.accountId,
    connection_id: c.id,
    author: (plan.body as JsonObject).author,
    post_id: id,
    verified_at: Date.now(),
  });
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const linkedinDSCFamily: ReviewedFamily = defineFamily({
  name: 'linkedin_dsc',
  files: ['src/linkedin-posts.ts', ['tests/linkedin-posts.test.ts']],
  kind: linkedinDSC,
  assert: plan => {
    assertNoMethodOverride(plan);
    if (Object.keys(plan.query).length)
      throw new MirrorError(
        'WRITE_CONTRACT_UNAVAILABLE',
        'DSC creation does not accept query actions or method overrides.',
      );
    assertLinkedInDSC(plan);
  },
  scope: (c, write, plan) => {
    if (!write) assertLinkedInDSCGrant(plan!, c, false);
  },
  snapshots: linkedinDSCReads,
  snapshotValue: (plan, read, data) =>
    /^\/rest\/(images|videos)\//.test(read.path) ? linkedinMediaProjection(plan, data) : undefined,
  outcome: (plan, result) => result.status === 201 && linkedinPostId(result.headers['x-restli-id']),
  bindVerificationRead: (plan, read, reviewId) => {
    read.scopeContext = {linkedinPostReviewId: reviewId};
    read.query = {viewContext: 'AUTHOR'};
  },
  afterReadBack: (plan, check, verification) => {
    if (check.consistent)
      rememberLinkedInPost(
        verification.store,
        verification.current(),
        plan,
        verification.result.headers['x-restli-id'],
      );
  },
});
