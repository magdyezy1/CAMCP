import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {removeTestDirectory} from './temp.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ScopeGuard} from '../src/scope.js';
import {CampaignRunner} from '../src/campaign-runner.js';
import {ReportWorker} from '../src/worker.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {redditPostRead, redditPublicUrl} from '../src/reddit-post-creation.js';
import type {CompiledRequest, JsonObject} from '../src/types.js';

const gateway = 'reddit_native_action',
  account = 'a2_111',
  actor = {tenantId: 'reddit-create', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const profile = {
  id: '123',
  reddit_user_id: 't2_abc',
  name: 'Example',
  business_id: '11111111-1111-4111-8111-111111111111',
};
const image = (n = 'image') => ({name: n, media: {type: 'URL', url: 'https://assets.example.com/' + n + '.jpg'}}),
  destination = {
    type: 'URL',
    url: 'https://example.com/landing',
    display_url: 'example.com',
    call_to_action: 'Learn More',
  };
const creatives: Record<string, JsonObject> = {
  TEXT: {
    type: 'TEXT',
    headline: 'Text headline',
    body: 'The chosen body',
    text_format: 'PLAIN_TEXT',
    enhancements: {user_generated_content: {enroll_status: 'OPT_OUT'}},
  },
  IMAGE: {
    type: 'IMAGE',
    headline: 'Image headline',
    image: {
      ...image(),
      crop: {top_left_coordinates: {x: 0, y: 3}, dimensions: {width: 100, height: 75}, type: 'MANUAL'},
    },
    destination,
  },
  VIDEO: {
    type: 'VIDEO',
    headline: 'Video headline',
    video: {media: {type: 'URL', url: 'https://assets.example.com/video.mp4'}, gifify: false},
    thumbnail: image('thumbnail'),
    destination,
    event: {type: 'REMINDER', start_time: '2027-01-01T12:00:00Z'},
  },
  CAROUSEL: {
    type: 'CAROUSEL',
    headline: 'Carousel headline',
    carousel: [
      {image: image('first'), destination, caption: 'First card'},
      {
        image: image('second'),
        destination: {...destination, url: 'https://example.com/second'},
        caption: 'Second card',
      },
    ],
  },
  PROMOTED_POST: {
    type: 'PROMOTED_POST',
    headline: 'Original headline',
    post: {type: 'PROMOTED_COMMUNITY_POST', post_id: 't3_original', destination},
  },
};
const data = (type: string): JsonObject => ({allow_comments: false, creative: structuredClone(creatives[type])});
const legacy = (type: string): JsonObject => ({
  allow_comments: false,
  type,
  headline: 'Legacy ' + type,
  ...(type === 'TEXT'
    ? {body: 'Legacy body', is_richtext: false}
    : {
        content: (type === 'CAROUSEL' ? ['first', 'second'] : ['image']).map(n => ({
          media_url: 'https://assets.example.com/' + n + '.jpg',
          destination_url: 'https://example.com/' + n,
          call_to_action: 'Learn More',
          caption: n,
        })),
        ...(type === 'VIDEO' ? {thumbnail_url: 'https://assets.example.com/thumbnail.jpg'} : {}),
      }),
});
function hosted(value: any, key = ''): any {
  return Array.isArray(value)
    ? value.map(v => hosted(v))
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hosted(v, k)]))
      : typeof value === 'string' &&
          (key === 'media_url' ||
            key === 'thumbnail_url' ||
            (key === 'url' && value.startsWith('https://assets.example.com/')))
        ? 'https://i.redd.it/' + value.split('/').at(-1)
        : value;
}
function fixture(options: {observed?: boolean; file?: string; existing?: boolean} = {}) {
  const key = Buffer.alloc(32, 68).toString('base64');
  let store = new Store(options.file ?? ':memory:', key);
  const registry = new Registry(),
    calls: JsonObject[] = [];
  const connection = {
    id: 'reddit',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    writeAccounts: [account],
    enabled: true,
    label: 'Synthetic',
    scopes: ['adsread', 'adsedit'],
    userAgent: 'server:amcp-tests:1 (synthetic)',
  };
  const auth = {accessToken: 'synthetic'};
  if (!options.existing) {
    store.putConnection(owner, connection, auth);
    if (options.observed !== false) store.rememberResource(connection, account, 'profiles/123');
    store.rememberResource(connection, account, 'posts/t3_original');
    store.rememberResource(connection, account, 'ad_groups/a2_group');
  }
  const records = new Map<string, JsonObject>([
    [
      '/api/v3/posts/t3_original',
      {
        id: 't3_original',
        profile_id: 't2_abc',
        headline: 'Original headline',
        type: 'TEXT',
        body: 'Original body',
        allow_comments: true,
        post_url: 'https://www.reddit.com/r/Example/comments/original/title/',
      },
    ],
    ['/api/v3/ad_groups/a2_group', {id: 'a2_group', ad_account_id: account, configured_status: 'PAUSED'}],
  ]);
  let profiles: JsonObject[] = [structuredClone(profile)],
    writes = 0,
    lose = false,
    foreign = false;
  let onRead: (path: string, d: JsonObject) => JsonObject = (_p, d) => d;
  const transport = new NativeTransport(
    async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? 'GET';
      calls.push({path, method});
      if (method === 'GET') {
        const d =
          path === '/api/v3/ad_accounts/' + account
            ? {data: {id: account, name: 'Synthetic'}}
            : path.endsWith('/profiles')
              ? {data: structuredClone(profiles), pagination: {next_url: null}}
              : {data: structuredClone(records.get(path))};
        assert.ok(d.data, 'Missing state ' + path);
        return Response.json(onRead(path, d));
      }
      assert.equal(method, 'POST');
      writes++;
      const d = JSON.parse(String(init?.body)).data,
        structured = path.endsWith('/structured_posts/jobs'),
        ad = path.endsWith('/ads');
      const post = hosted({
        ...d,
        id: 't3_created',
        profile_id: foreign ? 't2_other' : 't2_abc',
        created_at: '2026-09-19T12:00:00Z',
      });
      if (!ad) records.set('/api/v3/' + (structured ? 'structured_posts' : 'posts') + '/t3_created', post);
      if (structured)
        records.set('/api/v3/posts/t3_created', {
          id: post.id,
          profile_id: post.profile_id,
          allow_comments: post.allow_comments,
          type: d.creative.type,
          headline: d.creative.headline,
          body: d.creative.body,
          content: d.creative.carousel ?? [],
          created_at: post.created_at,
        });
      const original = d.creative?.post?.post_id;
      if (original) records.get('/api/v3/posts/' + original)!.allow_comments = false;
      const job = {
        id: 'job_12345678',
        status: 'PROCESSING',
        created_at: '2026-09-19T12:00:00Z',
        modified_at: '2026-09-19T12:00:00Z',
      };
      if (structured)
        records.set('/api/v3/structured_posts/jobs/' + job.id, {...job, post_id: null, error_message: null});
      const result = ad ? {...d, id: '300', type: 'UNSPECIFIED', ad_account_id: account} : structured ? job : post;
      if (ad) records.set('/api/v3/ads/300', result);
      if (lose) throw Error('Synthetic response lost after acceptance');
      return Response.json({data: result}, {status: 201});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  let service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (d: JsonObject, structured = true, params: JsonObject = {profile_id: '123'}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: 'reddit_post_ops',
          arguments: {
            action: structured ? 'CREATE_STRUCTURED_POST_JOB' : 'CREATE_POST',
            account_id: account,
            params,
            payload: {data: d},
          },
        },
      },
      actor,
    );
  const execute = (p: JsonObject) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
  const verify = (p: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  const succeed = () =>
    Object.assign(records.get('/api/v3/structured_posts/jobs/job_12345678')!, {
      status: 'SUCCESS',
      post_id: 't3_created',
    });
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    registry,
    connection,
    records,
    calls,
    prepare,
    execute,
    verify,
    succeed,
    writes: () => writes,
    profiles: (p: JsonObject[]) => {
      profiles = p;
    },
    onRead: (f: typeof onRead) => {
      onRead = f;
    },
    lose: () => {
      lose = true;
    },
    foreign: () => {
      foreign = true;
    },
    revoke: () => store.putConnection(owner, {...connection, accounts: [], writeAccounts: []}, auth),
    restart: () => {
      assert.ok(options.file);
      store.close();
      store = new Store(options.file!, key);
      service = new MirrorService(registry, store, transport, undefined, {
        allowWrites: true,
        requireBeforeState: true,
        maxBudgetChange: 0,
      });
    },
  };
}

for (const type of Object.keys(creatives))
  test(
    'structured ' + type + ' follows the original job and verifies transformed media before granting post scope',
    async () => {
      const x = fixture();
      try {
        const p = await x.prepare(data(type));
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(x.writes(), 0);
        const r = await x.execute(p);
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal(x.writes(), 1);
        assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), false);
        assert.equal((await x.verify(p)).data.status, 'pending');
        assert.equal((await x.execute(p)).data.replayed, true);
        x.succeed();
        const v = await x.verify(p);
        assert.equal(v.data.status, 'verified', JSON.stringify(v));
        assert.equal(v.data.verified_resources[0].id, 't3_created');
        assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), true);
        assert.equal(x.writes(), 1);
        const media = v.data.checks.at(-1).media_ingestion;
        if (['IMAGE', 'VIDEO', 'CAROUSEL'].includes(type)) {
          assert.ok(media.length);
          assert.ok(media.every((m: JsonObject) => m.byte_identity_verified === false));
        }
      } finally {
        x.store.close();
      }
    },
  );
for (const type of ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'])
  test('legacy ' + type + ' creation retains the same review and grants scope only after post read-back', async () => {
    const x = fixture();
    try {
      const p = await x.prepare(legacy(type), false);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await x.execute(p)).success, true);
      assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), false);
      assert.equal((await x.verify(p)).data.status, 'verified');
      assert.equal((await x.execute(p)).data.replayed, true);
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  });
test('post creation rejects unbound and revoked profiles, ambiguous authors and changed original content', async () => {
  for (const mode of ['unobserved', 'revoked', 'ambiguous', 'author', 'original'] as const) {
    const x = fixture({observed: mode !== 'unobserved'});
    try {
      const p = await x.prepare(data(mode === 'original' ? 'PROMOTED_POST' : 'TEXT'));
      if (mode === 'unobserved') {
        assert.equal(p.success, false);
        continue;
      }
      assert.equal(p.success, true, JSON.stringify(p));
      if (mode === 'revoked') x.profiles([]);
      if (mode === 'ambiguous') x.profiles([profile, {...profile, id: '124'}]);
      if (mode === 'author') x.profiles([{...profile, reddit_user_id: 't2_other'}]);
      if (mode === 'original') x.records.get('/api/v3/posts/t3_original')!.body = 'Changed original content';
      assert.equal((await x.execute(p)).success, false);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});
test('promoted posts freeze the original account-bound community content and retain owner policy', async () => {
  for (const mode of ['profile', 'foreign', 'headline', 'comments', 'policy'] as const) {
    const x = fixture();
    try {
      const d = data('PROMOTED_POST');
      if (mode === 'profile')
        x.records.get('/api/v3/posts/t3_original')!.post_url =
          'https://www.reddit.com/user/Example/comments/original/title/';
      if (mode === 'foreign') x.records.get('/api/v3/posts/t3_original')!.profile_id = 't2_other';
      if (mode === 'headline') d.creative.headline = 'Changed headline';
      if (mode === 'comments') d.allow_comments = true;
      if (mode === 'policy')
        saveSpendPolicy(x.store, owner, {
          gateway,
          account_id: account,
          confirmed: true,
          policy: {allow_activation: false},
        });
      assert.equal((await x.prepare(d)).success, false);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});
test('invalid media, masks, formats and mismatched destination domains fail before provider reads', async () => {
  const variants = [
    {...data('TEXT'), id: 'forged'},
    data('IMAGE'),
    data('VIDEO'),
    data('CAROUSEL'),
    data('VIDEO'),
    data('IMAGE'),
    data('TEXT'),
    data('IMAGE'),
  ];
  variants[1]!.creative.image.media.url = 'https://localhost/image';
  delete variants[2]!.creative.thumbnail;
  variants[3]!.creative.carousel.reverse();
  variants[3]!.creative.carousel.pop();
  variants[4]!.creative.event.type = 'invented';
  variants[5]!.creative.destination.display_url = 'different.example.com';
  variants[6]!.creative.text_format = 'RICH_TEXT_JSON';
  variants[7]!.creative.image.media.access_token = 'secret';
  for (const d of variants) {
    const x = fixture();
    try {
      assert.equal((await x.prepare(d)).success, false, JSON.stringify(d));
      assert.equal(x.calls.length, 0);
    } finally {
      x.store.close();
    }
  }
  for (const url of [
    'http://example.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://x.internal/a',
    'https://user:pass@example.com/a',
    'https://example.com/a?access_token=secret',
    'https://drive.google.com/file/d/file/view',
    'https://example.com:8443/a',
  ])
    assert.throws(() => redditPublicUrl(url, true));
});
test('read-back detects foreign authors, changed media, ordered carousel changes and ignored enhancement opt-out', async () => {
  for (const mode of ['author', 'media', 'order', 'enhancement', 'destination', 'crop'] as const) {
    const x = fixture();
    try {
      const p = await x.prepare(data(mode === 'enhancement' ? 'TEXT' : mode === 'order' ? 'CAROUSEL' : 'IMAGE'));
      assert.equal(p.success, true);
      await x.execute(p);
      x.succeed();
      const post = x.records.get('/api/v3/structured_posts/t3_created')!;
      if (mode === 'author') post.profile_id = 't2_other';
      if (mode === 'media') post.creative.image.media.url = 'https://untrusted.example.com/not-ingested.jpg';
      if (mode === 'order') post.creative.carousel.reverse();
      if (mode === 'enhancement') post.creative.enhancements.user_generated_content.enroll_status = 'OPT_IN';
      if (mode === 'destination') post.creative.destination.url = 'https://example.com/changed';
      if (mode === 'crop') post.creative.image.crop.dimensions.width = 99;
      const v = await x.verify(p);
      assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
      assert.ok(v.data.checks.at(-1).changed_fields.length);
      assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), false);
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  }
});
test('pending and failed post jobs never resubmit; malformed and substituted job receipts cannot grant scope', async () => {
  for (const mode of [
    'QUEUED',
    'PROCESSING',
    'CLIENT_ERROR',
    'SERVER_ERROR',
    'wrong-id',
    'missing-post',
    'ambiguous',
    'error200',
  ] as const) {
    const x = fixture();
    try {
      const p = await x.prepare(data('TEXT'));
      await x.execute(p);
      const job = x.records.get('/api/v3/structured_posts/jobs/job_12345678')!;
      if (['QUEUED', 'PROCESSING', 'CLIENT_ERROR', 'SERVER_ERROR'].includes(mode)) job.status = mode;
      else if (mode === 'wrong-id') job.id = 'another_job';
      else if (mode === 'missing-post') {
        job.status = 'SUCCESS';
        delete job.post_id;
      } else if (mode === 'ambiguous') job.post_id = 't3_unknown';
      else x.onRead((path, d) => (path.includes('/jobs/') ? {...d, error: {message: 'failure'}} : d));
      const v = await x.verify(p);
      assert.equal(
        v.data.status,
        ['QUEUED', 'PROCESSING'].includes(mode)
          ? 'pending'
          : ['CLIENT_ERROR', 'SERVER_ERROR'].includes(mode)
            ? 'failed'
            : 'unverified',
        JSON.stringify(v),
      );
      assert.equal((await x.execute(p)).data.replayed, true);
      assert.equal(x.writes(), 1);
      assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), false);
    } finally {
      x.store.close();
    }
  }
});
test('lost responses, concurrent executions and mid-verification revocation retain isolation and at-most-once submission', async () => {
  for (const mode of ['lost', 'concurrent', 'revoke', 'stale-profile'] as const) {
    const x = fixture();
    try {
      const p = await x.prepare(data('TEXT'));
      if (mode === 'lost') x.lose();
      if (mode === 'concurrent') await Promise.all([x.execute(p), x.execute(p)]);
      else await x.execute(p);
      if (mode === 'lost') {
        assert.equal((await x.execute(p)).error.code, 'WRITE_OUTCOME_UNCERTAIN');
        assert.equal((await x.verify(p)).success, false);
      } else {
        x.succeed();
        if (mode === 'revoke')
          x.onRead((path, d) => {
            if (path.includes('/jobs/')) x.revoke();
            return d;
          });
        if (mode === 'stale-profile') x.profiles([]);
        const v = await x.verify(p);
        assert.equal(v.data.status, mode === 'concurrent' ? 'verified' : 'unverified');
      }
      assert.equal(x.writes(), 1);
      if (mode !== 'concurrent') assert.equal(x.store.ownsResource(x.connection, account, 'posts/t3_created'), false);
    } finally {
      x.store.close();
    }
  }
});
test('async resolution survives restart and does not authorize guessed post IDs, other connections or accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amcp-reddit-job-')),
    x = fixture({file: join(dir, 'db.sqlite')});
  try {
    const p = await x.prepare(data('TEXT'));
    await x.execute(p);
    assert.equal((await x.verify(p)).data.status, 'pending');
    x.restart();
    assert.equal((await x.execute(p)).data.replayed, true);
    x.succeed();
    const plan = x.store.document(actor.tenantId, 'write_review', p.data.review_id).plan as CompiledRequest,
      guard = new ScopeGuard(x.registry, x.store);
    assert.throws(() =>
      guard.authorize(redditPostRead(plan, '/api/v3/structured_posts/t3_guessed', p.data.review_id), x.connection),
    );
    assert.throws(() =>
      guard.authorize(redditPostRead(plan, '/api/v3/structured_posts/jobs/job_12345678', p.data.review_id), {
        ...x.connection,
        id: 'other',
      }),
    );
    assert.throws(() =>
      guard.authorize(
        {
          ...redditPostRead(plan, '/api/v3/structured_posts/jobs/job_12345678', p.data.review_id),
          accountId: 'a2_other',
        },
        {...x.connection, accounts: [account, 'a2_other']},
      ),
    );
    assert.equal((await x.verify(p)).data.status, 'verified');
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
    removeTestDirectory(dir, 'amcp-reddit-job-');
  }
});

for (const type of ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'])
  test(type + ' campaign resolves a verified asynchronous post into a paused ad without another create', async () => {
    const x = fixture();
    try {
      const runner = new CampaignRunner(
        x.store,
        (name, input, a) => x.service.call(name, input, a),
        async (a, id) => {
          const v = await x.service.call('amcp_campaign', {action: 'verify', review_id: id}, a);
          assert.equal(v.success, true, JSON.stringify(v));
          return v.data;
        },
        async () => ({}),
        async () => ({status: 'ready', checks: []}),
      );
      const run = await runner.handle(
        {
          action: 'create',
          name: 'Post then paused ad',
          brief: 'Synthetic full chain',
          steps: [
            {
              id: 'post',
              kind: 'write',
              gateway,
              connection_id: 'reddit',
              account_id: account,
              arguments: {
                operation: 'reddit_post_ops',
                arguments: {
                  action: 'CREATE_STRUCTURED_POST_JOB',
                  params: {profile_id: '123'},
                  payload: {data: data(type)},
                },
              },
              depends_on: [],
            },
            {
              id: 'ad',
              kind: 'write',
              gateway,
              connection_id: 'reddit',
              account_id: account,
              arguments: {
                operation: 'reddit_campaign_ops',
                arguments: {
                  action: 'CREATE_AD',
                  payload: {
                    data: {
                      name: 'Paused ' + type,
                      configured_status: 'PAUSED',
                      ad_group_id: 'a2_group',
                      post_id: {$ref: 'post#/verified_resources/0/id'},
                      click_url: 'https://example.com/landing',
                    },
                  },
                },
              },
              depends_on: ['post'],
            },
          ],
        },
        actor,
      );
      const first = await runner.handle({action: 'prepare_next', id: run.id}, actor);
      assert.ok(first.review, JSON.stringify(first));
      const pending = await runner.handle(
        {
          action: 'execute_next',
          id: run.id,
          review_id: first.review.review_id,
          idempotency_key: first.review.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
        },
        actor,
      );
      assert.equal(pending.steps[0].status, 'verifying');
      assert.equal(pending.steps[1].status, 'pending');
      assert.equal(x.writes(), 1);
      x.succeed();
      const verified = await runner.handle(
        {
          action: type === 'TEXT' ? 'reconcile_step' : 'prepare_next',
          id: run.id,
          ...(type === 'TEXT' ? {step_id: 'post'} : {}),
        },
        actor,
      );
      assert.equal(verified.steps[0].status, 'verified');
      assert.equal(verified.steps[0].result.verified_resources[0].id, 't3_created');
      const next = await runner.handle({action: 'prepare_next', id: run.id}, actor);
      assert.equal(next.step_id, 'ad', JSON.stringify(next));
      assert.equal(next.review.request.body.data.post_id, 't3_created');
      assert.equal(next.review.request.body.data.configured_status, 'PAUSED');
      const complete = await runner.handle(
        {
          action: 'execute_next',
          id: run.id,
          review_id: next.review.review_id,
          idempotency_key: next.review.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
        },
        actor,
      );
      assert.equal(complete.state, 'complete', JSON.stringify(complete));
      assert.equal(x.writes(), 2);
    } finally {
      x.store.close();
    }
  });
for (const phase of ['ready', 'failed', 'limit', 'transient'])
  test('Reddit background polling preserves ' + phase + ' without repeating the post creation', async () => {
    const x = fixture();
    try {
      const p = await x.prepare(data('TEXT')),
        e = await x.execute(p),
        id = e.data.verification.job_id;
      const worker = new ReportWorker(
        x.store,
        async () => {
          throw Error('Not a report');
        },
        (tenant, kind, input) => x.service.verificationJob(tenant, kind, input),
      );
      if (phase === 'transient')
        x.onRead((path, d) => {
          if (path.includes('/jobs/')) throw Error('Synthetic network timeout');
          return d;
        });
      await worker.once();
      let job = x.store.job(actor.tenantId, id);
      assert.equal(job.state, 'queued');
      assert.equal(job.error.code, 'VERIFICATION_PENDING');
      assert.equal(x.writes(), 1);
      if (phase === 'transient') return;
      if (phase === 'ready') x.succeed();
      if (phase === 'failed') x.records.get('/api/v3/structured_posts/jobs/job_12345678')!.status = 'CLIENT_ERROR';
      x.store.db.prepare('UPDATE jobs SET available_at=0,attempts=? WHERE id=?').run(phase === 'limit' ? 11 : 1, id);
      await worker.once();
      job = x.store.job(actor.tenantId, id);
      assert.equal(job.state, phase === 'ready' ? 'complete' : 'failed');
      if (phase !== 'ready')
        assert.equal(job.error.code, phase === 'limit' ? 'VERIFICATION_POLL_LIMIT' : 'VERIFICATION_FAILED');
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  });
test('a verified post cannot be reused in an ad after its account profile is revoked', async () => {
  const x = fixture();
  try {
    const p = await x.prepare(data('TEXT'));
    await x.execute(p);
    x.succeed();
    assert.equal((await x.verify(p)).data.status, 'verified');
    x.profiles([]);
    const ad = await x.service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: 'reddit_campaign_ops',
          arguments: {
            action: 'CREATE_AD',
            account_id: account,
            payload: {
              data: {
                name: 'Paused',
                configured_status: 'PAUSED',
                ad_group_id: 'a2_group',
                post_id: 't3_created',
                click_url: 'https://example.com/landing',
              },
            },
          },
        },
      },
      actor,
    );
    assert.equal(ad.error.code, 'RESOURCE_SCOPE_REQUIRED');
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('deprecated enhancement booleans reconcile to explicit native enrollment but contradictions fail', async () => {
  for (const conflicting of [false, true]) {
    const x = fixture();
    try {
      const d = data('TEXT');
      d.creative.enhancements = {allow_user_generated_content: false};
      const p = await x.prepare(d);
      assert.equal(p.success, true, JSON.stringify(p));
      await x.execute(p);
      x.succeed();
      const post = x.records.get('/api/v3/structured_posts/t3_created')!;
      post.creative.enhancements = {
        user_generated_content: {enroll_status: 'OPT_OUT'},
        ...(conflicting ? {allow_user_generated_content: true} : {}),
      };
      assert.equal((await x.verify(p)).data.status, conflicting ? 'inconclusive' : 'verified');
    } finally {
      x.store.close();
    }
  }
});
test('post read capability rejects a changed job resolution and checks current scopes even for cached verification', async () => {
  const x = fixture();
  try {
    const p = await x.prepare(data('TEXT'));
    await x.execute(p);
    x.succeed();
    assert.equal((await x.verify(p)).data.status, 'verified');
    x.store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND kind='write_verification'").run(actor.tenantId);
    x.records.get('/api/v3/structured_posts/jobs/job_12345678')!.post_id = 't3_substituted';
    const count = x.calls.length,
      v = await x.verify(p);
    assert.equal(v.data.status, 'unverified');
    assert.ok(!x.calls.slice(count).some(c => c.path.endsWith('t3_substituted')));
    x.records.get('/api/v3/structured_posts/jobs/job_12345678')!.post_id = 't3_created';
    assert.equal((await x.verify(p)).data.status, 'verified');
    x.store.putConnection(owner, {...x.connection, scopes: ['adsedit']}, {accessToken: 'synthetic'});
    assert.equal((await x.verify(p)).error.code, 'INSUFFICIENT_SCOPE');
  } finally {
    x.store.close();
  }
});
