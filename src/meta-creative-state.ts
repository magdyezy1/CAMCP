import {MirrorError} from './errors.js';
import {fetchMetaExistingPosts} from './meta-existing-posts.js';
import {sha256, stable} from './security.js';
import type {Store} from './store.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, CompiledRequest, Connection, JsonObject} from './types.js';
import {loginStamp} from './connection-authority.js';

const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const numeric = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,39}$/.test(v);
export const metaCreativeCreate = (p: CompiledRequest) =>
  p.gateway === 'meta_native_action' && p.method === 'POST' && /^\/v[^/]+\/act_[0-9]+\/adcreatives$/.test(p.path);
export function metaCreativeIdentityReads(p: CompiledRequest) {
  const b = p.body as JsonObject,
    s = b.object_story_spec ?? {},
    ig = b.instagram_user_id ?? s.instagram_user_id ?? s.instagram_actor_id;
  return ['promote_pages', ...(ig ? ['instagram_accounts'] : [])].map(edge => ({
    ...p,
    method: 'GET',
    path: p.path.replace(/adcreatives$/, edge),
    body: undefined,
    query: {fields: edge === 'promote_pages' && ig ? 'id,instagram_business_account' : 'id', limit: 100},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    action: 'AMCP_META_CREATIVE_IDENTITY_READ',
  }));
}

/** Re-check creative identities on prepare and execute. Fixed advertiser edges
 * establish the Page/IG binding; existing content reuses the private Page-token
 * reader. No Graph scope exception or persistent ownership grant is introduced. */
export async function metaCreativeState(
  p: CompiledRequest,
  store: Store,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  authorize: () => Connection,
): Promise<JsonObject> {
  const b = p.body as JsonObject,
    s = b.object_story_spec ?? {},
    ig = b.instagram_user_id ?? s.instagram_user_id ?? s.instagram_actor_id;
  let page = s.page_id ?? b.object_story_id?.split('_')[0],
    credentialHash: string | undefined;
  const required = [
    'ads_management',
    ...(b.object_story_id || b.source_instagram_media_id
      ? ['pages_show_list', 'pages_read_engagement', ...(b.source_instagram_media_id ? ['instagram_basic'] : [])]
      : []),
  ];
  const access = () => {
    const c = authorize(),
      missing = required.filter(scope => !c.scopes.includes(scope));
    if (missing.length)
      throw new MirrorError(
        'INSUFFICIENT_SCOPE',
        'Creative review needs recorded advertising permission and the read permissions for its existing content. Reconnect with the required approved scopes.',
        {required_scopes: missing},
        403,
      );
    if (credentialHash && loginStamp(store.credentials(actor.tenantId, c.id)) !== credentialHash)
      throw new MirrorError(
        'CONNECTION_AUTHORITY_CHANGED',
        'The selected Meta login changed during creative checks. Prepare again with the current login.',
        {},
        409,
      );
    return c;
  };
  const auth = await credentials.get(access());
  credentialHash = loginStamp(auth);
  const connection = access();
  const fail = (message: string, code = 'META_CREATIVE_STATE_UNVERIFIED'): never => {
    throw new MirrorError(code, message);
  };
  const started = performance.now();
  let bytes = 0,
    requests = 0;
  const entries = metaCreativeIdentityReads(p);
  const list = async (read: CompiledRequest) => {
    const rows: JsonObject[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>();
    let after: string | undefined;
    for (let n = 0; n < 25; n++) {
      if (++requests > 50 || performance.now() - started > 60000)
        fail('Creative identity discovery exceeded its bounded request/time limit.');
      const response = await transport.request(
        {...read, query: {...read.query, ...(after ? {after} : {})}},
        access(),
        auth,
        undefined,
        {
          beforeAttempt: () => {
            access();
          },
        },
      );
      access();
      const data = response.data,
        size = Buffer.byteLength(JSON.stringify(data) ?? '');
      bytes += size;
      if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
        fail('Creative identity discovery exceeded its byte/time limit.');
      if (
        response.status !== 200 ||
        !object(data) ||
        Object.keys(data).some(k => !['data', 'paging'].includes(k)) ||
        !Array.isArray(data.data) ||
        data.data.length > 100
      )
        fail('Meta did not return a complete identity collection.');
      const d = data as JsonObject;
      for (const row of d.data) {
        if (!object(row) || !numeric(row.id) || ids.has(row.id))
          fail('Meta returned malformed or duplicate identity records.');
        ids.add(row.id);
        rows.push(row);
      }
      if (rows.length > 1000) fail('Creative identity discovery exceeded 1000 identities.');
      const paging = d.paging;
      if (
        paging !== undefined &&
        (!object(paging) ||
          Object.keys(paging).some(k => !['cursors', 'next', 'previous'].includes(k)) ||
          ['next', 'previous'].some(k => paging[k] !== undefined && (typeof paging[k] !== 'string' || !paging[k])) ||
          (paging.cursors !== undefined &&
            (!object(paging.cursors) ||
              Object.keys(paging.cursors).some(k => !['before', 'after'].includes(k)) ||
              Object.values(paging.cursors).some(
                v => typeof v !== 'string' || !v || v.length > 4096 || /[\u0000-\u001f]/.test(v),
              ))))
      )
        fail('Meta returned unrecognized identity pagination.');
      if (!paging?.next) return rows;
      after = paging.cursors?.after;
      if (!after || !d.data.length || cursors.has(after)) fail('Meta identity pagination is incomplete or repeated.');
      cursors.add(after!);
    }
    return fail('Creative identity discovery exceeded 25 pages.');
  };
  const pages = await list(entries[0]!);
  if (!page && ig) {
    const linked = pages.filter(row => row.instagram_business_account?.id === ig);
    if (linked.length !== 1)
      fail(
        'The advertiser did not return one Page linked to the selected Instagram identity. Discover or reconnect its professional Instagram/Page link.',
        'META_CREATIVE_IDENTITY_REQUIRED',
      );
    page = linked[0]!.id;
  }
  const selected = pages.find(row => row.id === page);
  if (!selected)
    fail(
      'The selected advertiser and login cannot promote the supplied Facebook Page.',
      'META_CREATIVE_IDENTITY_REQUIRED',
    );
  if (ig) {
    const identities = await list(entries[1]!);
    if (!identities.some(row => row.id === ig) || selected!.instagram_business_account?.id !== ig)
      fail(
        'The supplied Instagram identity must belong to the advertiser and the selected Page.',
        'META_CREATIVE_IDENTITY_REQUIRED',
      );
  }
  const identity = {page_id: page, ...(ig ? {instagram_user_id: ig} : {})};
  if (!b.object_story_id && !b.source_instagram_media_id) return identity;
  const result = await fetchMetaExistingPosts(
    store,
    transport,
    credentials,
    {
      action: b.source_instagram_media_id ? 'GET_IG_MEDIA' : 'GET_POST_BY_ID',
      account_id: p.accountId,
      connection_id: connection.id,
      page_id: page,
      ...(b.source_instagram_media_id ? {instagram_user_id: ig} : {}),
      post_id: b.source_instagram_media_id ?? b.object_story_id,
      dry_run: false,
    },
    actor,
    'creative-prerequisite/' +
      sha256(stable({account: p.accountId, identity, post: b.source_instagram_media_id ?? b.object_story_id})),
    access,
  );
  access();
  if (!result.complete || result.posts.length !== 1) fail('Meta did not verify the exact existing creative content.');
  // Counters, request metadata, tokens and unrelated identities never enter the hash.
  return {...identity, content: result.posts[0]};
}
