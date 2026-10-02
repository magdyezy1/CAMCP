import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {googleEvidenceCustomer, googleEvidenceRow, googleEvidenceResponse} from './fixtures/google-evidence-data.mjs';

const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};
async function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 109).toString('base64'));
  t.after(() => store.close());
  const key = store.createKey({tenantId: 'search-exclusions', userId: 'operator', role: 'operator'}),
    actor = store.authenticate(key),
    connection = {
      id: 'ffffffff-1111-4111-8111-111111111114',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  const terms = ["free engineer's book", 'وظائف مجانية', 'known conversions', 'unknown conversions'];
  const sourceRows = terms.map((term, i) => ({
    ...googleEvidenceRow('search_term_view', '1', '2', term),
    metrics: {
      costMicros: '9007199254740993',
      clicks: i === 3 ? '1' : '40',
      impressions: '100',
      ...(i === 3 ? {} : {conversions: i === 2 ? 2 : 0}),
    },
  }));
  const parents = [
    {
      customer: googleEvidenceCustomer(),
      campaign: {
        id: '1',
        resourceName: 'customers/123/campaigns/1',
        name: 'Search',
        status: 'ENABLED',
        advertisingChannelType: 'SEARCH',
      },
      adGroup: {
        id: '2',
        resourceName: 'customers/123/adGroups/2',
        campaign: 'customers/123/campaigns/1',
        name: 'Group',
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
      },
    },
  ];
  let criteria = [],
    hook = () => {},
    responsePatch = x => x;
  const requests = [];
  let writes = 0,
    allowSyntheticWrites = false;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({url: String(url), body});
      if (!String(url).endsWith('/googleAds:search')) {
        if (allowSyntheticWrites && String(url).endsWith('/adGroupCriteria:mutate')) {
          writes++;
          return Response.json({
            results: body.operations.map(op => {
              const c = op.create;
              assert.equal(c.negative, true);
              assert.equal(c.keyword.matchType, 'EXACT');
              const resourceName = 'customers/123/adGroupCriteria/2~' + (criteria.length + 10);
              criteria.push({
                adGroup: {id: '2', resourceName: 'customers/123/adGroups/2'},
                adGroupCriterion: {...c, resourceName, status: 'ENABLED', type: 'KEYWORD'},
              });
              return {resourceName};
            }),
          });
        }
        writes++;
        throw Error('Unexpected mutation');
      }
      const kind = / FROM (\w+)/.exec(body.query)?.[1];
      let data;
      if (kind === 'ad_group') data = {results: parents, totalResultsCount: String(parents.length)};
      else if (kind === 'ad_group_criterion') {
        const names = [...body.query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        const rows = names.length
          ? criteria
              .filter(r => names.includes(r.adGroupCriterion.resourceName))
              .map(r => ({adGroupCriterion: r.adGroupCriterion}))
          : criteria;
        data = {results: rows, totalResultsCount: String(rows.length)};
      } else data = googleEvidenceResponse(body, sourceRows);
      if (['ad_group', 'ad_group_criterion'].includes(kind)) {
        await hook(kind);
        data = responsePatch(data, kind);
      }
      return Response.json(data);
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = (tool, args) => service.call(tool, args, actor),
    day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const saved = ok(
    await call('amcp_reporting', {
      action: 'capture_preset',
      preset: 'google_search_terms',
      account_id: '123',
      connection_id: connection.id,
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        date_from: day,
        date_to: day,
        attribution: 'Declared 30-day click',
        source_name: 'Synthetic search terms',
        complete: true,
      },
    }),
  );
  requests.length = 0;
  const options = {minimum_clicks: 30, maximum_age_days: 7};
  const selected = [sourceRows[0].searchTermView.resourceName, sourceRows[1].searchTermView.resourceName];
  return {
    store,
    actor,
    key,
    connection,
    service,
    call,
    saved,
    options,
    selected,
    parents,
    requests,
    counts: () => ({requests: requests.length, writes}),
    allowSyntheticWrites: () => {
      allowSyntheticWrites = true;
    },
    candidates: extra =>
      call('amcp_reporting', {action: 'search_exclusion_candidates', id: saved.id, options, ...extra}),
    preview: extra =>
      call('amcp_reporting', {action: 'preview_search_exclusions', id: saved.id, ids: selected, options, ...extra}),
    create: (p, extra) =>
      call('amcp_reporting', {
        action: 'create_search_exclusion_plan',
        id: saved.id,
        preview_id: p.preview_id,
        preview_hash: p.preview_hash,
        confirmed: true,
        ...extra,
      }),
    criteria: value => {
      criteria = value;
    },
    hook: fn => {
      hook = fn;
    },
    response: fn => {
      responsePatch = fn;
    },
    changeReport: fn => {
      const report = store.document(actor.tenantId, 'decision_report', saved.id);
      fn(report);
      store.putDocument(actor.tenantId, 'decision_report', saved.id, report);
    },
  };
}

test('search exclusion candidates use exact scoped retained terms and unknown conversions never become zero', async t => {
  const f = await fixture(t),
    first = ok(await f.candidates({limit: 1}));
  assert.equal(first.report_id, f.saved.id);
  assert.equal(first.candidate_count, 2);
  assert.equal(first.next_offset, 1);
  assert.equal(first.candidates[0].search_term, "free engineer's book");
  assert.equal(first.candidates[0].observed_spend, '9007199254.740993');
  assert.equal(first.candidates[0].campaign_id, '1');
  assert.equal(first.candidates[0].ad_group_id, '2');
  assert.equal(first.candidates[0].match_type, 'EXACT');
  assert.equal(ok(await f.candidates({offset: 1, limit: 1})).candidates[0].search_term, 'وظائف مجانية');
  assert.deepEqual(f.counts(), {requests: 0, writes: 0});
});

test('search exclusions preview current parents and create one unapproved exact draft bound atomically to the source', async t => {
  const f = await fixture(t),
    p = ok(await f.preview());
  assert.equal(p.targets.length, 2);
  assert.equal(p.targets[0].search_term, "free engineer's book");
  assert.equal(p.advertising_writes, 0);
  assert.equal(p.source_hash, f.saved.source_hash);
  assert.equal(p.native_reads.length, 3);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  assert.doesNotMatch(f.requests[1].body.query, /engineer|keyword.text IN/);
  assert.match(f.requests[1].body.query, /ad_group.id IN \(2\)/);
  const created = ok(await f.create(p)),
    replay = ok(await f.create(p));
  assert.equal(replay.id, created.id);
  const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  assert.equal(run.state, 'draft');
  assert.equal(run.search_exclusions.report_id, f.saved.id);
  assert.equal(run.search_exclusions.preview_id, p.preview_id);
  assert.equal(run.steps.length, 2);
  assert.deepEqual(run.steps[0].arguments.payload.operations[0].create, {
    ad_group: 'customers/123/adGroups/2',
    negative: true,
    keyword: {text: "free engineer's book", match_type: 'EXACT'},
  });
  assert.equal(run.steps[0].arguments.payload.partial_failure, false);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 1);
  assert.equal(f.counts().writes, 0);
});

test('search exclusion selection rejects altered, duplicated, foreign, stale and incomplete evidence before native reads', async t => {
  for (const change of [
    f =>
      f.changeReport(r => {
        r.semantics.complete = false;
      }),
    f =>
      f.changeReport(r => {
        r.semantics.attribution = 'unknown';
      }),
    f =>
      f.changeReport(r => {
        r.captured_at = Date.now() - 8 * 86400000;
      }),
    f =>
      f.changeReport(r => {
        r.rows[0].entity_id = 'customers/999/searchTermViews/1~2~evil';
      }),
    f =>
      f.changeReport(r => {
        r.rows[0].search_term = 'different';
      }),
    f =>
      f.changeReport(r => {
        r.source_collection = undefined;
      }),
  ]) {
    const f = await fixture(t);
    change(f);
    const result = await f.preview();
    assert.equal(result.success, false);
    assert.equal(result.data, undefined);
    assert.deepEqual(f.counts(), {requests: 0, writes: 0});
  }
  const f = await fixture(t);
  for (const ids of [[], [f.selected[0], f.selected[0]], ['foreign'], [f.saved.rows[2].entity_id]])
    assert.equal((await f.preview({ids})).success, false);
  assert.deepEqual(f.counts(), {requests: 0, writes: 0});
});

test('search exclusion preview refuses changed hierarchy, incompatible channels, exact keyword conflicts and incomplete native reads', async t => {
  for (const change of [
    f => {
      f.parents[0].campaign.advertisingChannelType = 'PERFORMANCE_MAX';
    },
    f => {
      f.parents[0].adGroup.campaign = 'customers/123/campaigns/999';
    },
    f => {
      f.parents[0].customer.currencyCode = 'EUR';
    },
    f => {
      f.parents[0].adGroup.status = 'REMOVED';
    },
    f => f.response(data => ({...data, nextPageToken: 'partial'})),
    f => f.response(data => ({...data, totalResultsCount: '9'})),
    ...[true, false].map(
      negative => f =>
        f.criteria([
          {
            adGroup: {id: '2', resourceName: 'customers/123/adGroups/2'},
            adGroupCriterion: {
              resourceName: 'customers/123/adGroupCriteria/2~3',
              adGroup: 'customers/123/adGroups/2',
              status: 'ENABLED',
              negative,
              type: 'KEYWORD',
              keyword: {text: "FREE engineer's book", matchType: 'EXACT'},
            },
          },
        ]),
    ),
  ]) {
    const f = await fixture(t);
    change(f);
    const out = await f.preview();
    assert.equal(out.success, false);
    assert.equal(out.data, undefined);
    assert.equal(f.store.documents(f.actor.tenantId, 'search_exclusion_preview').length, 0);
    assert.equal(f.counts().writes, 0);
  }
});

test('search exclusion confirmation binds source, native state, session, expiry and explicit approval', async t => {
  for (const change of [
    f =>
      f.changeReport(r => {
        r.source_hash = 'changed';
      }),
    f => {
      f.parents[0].adGroup.status = 'PAUSED';
    },
    f => f.store.revokeKey(f.key),
    (f, p) => {
      const saved = f.store.document(f.actor.tenantId, 'search_exclusion_preview', p.preview_id);
      f.store.putDocument(f.actor.tenantId, 'search_exclusion_preview', p.preview_id, {
        ...saved,
        expires_at: Date.now() - 1,
      });
    },
  ]) {
    const f = await fixture(t),
      p = ok(await f.preview());
    change(f, p);
    assert.equal((await f.create(p)).success, false);
    assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
    assert.equal(f.counts().writes, 0);
  }
  const f = await fixture(t),
    p = ok(await f.preview());
  assert.equal((await f.create(p, {confirmed: false})).success, false);
  assert.equal((await f.create(p, {preview_hash: 'changed'})).success, false);
});

test('search exclusion preview stops after in-flight actor, credential or account withdrawal without saving a plan', async t => {
  for (const kind of ['actor', 'credentials', 'account']) {
    const f = await fixture(t);
    f.hook(() => {
      if (kind === 'actor') f.store.revokeKey(f.key);
      else
        f.store.putConnection(
          {...f.actor, role: 'admin'},
          {...f.connection, ...(kind === 'account' ? {accounts: []} : {})},
          {accessToken: kind === 'credentials' ? 'replaced' : 'synthetic', developerToken: 'synthetic'},
        );
    });
    const out = await f.preview();
    assert.equal(out.success, false);
    assert.equal(out.data, undefined);
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.documents(f.actor.tenantId, 'search_exclusion_preview').length, 0);
  }
});

test('unsent source-bound exclusions refuse changed reports or edited arguments before campaign preparation', async t => {
  for (const kind of ['source', 'arguments']) {
    const f = await fixture(t),
      p = ok(await f.preview()),
      created = ok(await f.create(p));
    if (kind === 'source')
      f.changeReport(r => {
        r.source_hash = 'changed';
      });
    else {
      const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
      run.steps[0].arguments.payload.operations[0].create.keyword.match_type = 'BROAD';
      f.store.putDocument(f.actor.tenantId, 'campaign_run', created.id, run);
    }
    f.requests.length = 0;
    const response = await f.call('amcp_campaign', {action: 'prepare_next', id: created.id});
    assert.equal(response.success, false);
    assert.equal(f.counts().writes, 0);
    assert.equal(f.requests.length, 0);
  }
});

test('separately reviewed search exclusions execute and verify once, retaining source evidence through original receipts', async t => {
  const f = await fixture(t),
    p = ok(await f.preview()),
    created = ok(await f.create(p));
  f.allowSyntheticWrites();
  for (let i = 0; i < 2; i++) {
    const prepared = ok(await f.call('amcp_campaign', {action: 'prepare_next', id: created.id}));
    assert.ok(prepared.review?.review_id, JSON.stringify(prepared));
    const denied = ok(
      await f.call('amcp_campaign', {
        action: 'execute_next',
        id: created.id,
        review_id: prepared.review.review_id,
        idempotency_key: prepared.review.review_id,
        confirmed: true,
      }),
    );
    assert.equal(denied.current.error.code, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(f.counts().writes, i);
    const result = ok(
      await f.call('amcp_campaign', {
        action: 'execute_next',
        id: created.id,
        review_id: prepared.review.review_id,
        idempotency_key: prepared.review.review_id,
        confirmed: true,
        spend_change_confirmed: true,
      }),
    );
    assert.equal(result.current.status, 'verified', JSON.stringify(result));
    assert.equal(result.current.error, undefined, 'successful reviewed retry must clear the earlier refusal');
  }
  const run = f.store.document(f.actor.tenantId, 'campaign_run', created.id);
  assert.equal(run.state, 'complete');
  assert.equal(run.search_exclusions.source_hash, f.saved.source_hash);
  assert.equal(f.counts().writes, 2);
  const replay = ok(
    await f.call('amcp_campaign', {
      action: 'execute_next',
      id: created.id,
      review_id: run.steps[1].review_id,
      confirmed: true,
    }),
  );
  assert.equal(replay.state, 'complete');
  assert.equal(f.counts().writes, 2);
});

test('source-bound exclusion execution rechecks evidence after native review and sends nothing when it changed', async t => {
  const f = await fixture(t),
    p = ok(await f.preview()),
    created = ok(await f.create(p));
  const prepared = ok(await f.call('amcp_campaign', {action: 'prepare_next', id: created.id}));
  assert.ok(prepared.review?.review_id, JSON.stringify(prepared));
  f.changeReport(r => {
    r.source_hash = 'changed';
  });
  const out = await f.call('amcp_campaign', {
    action: 'execute_next',
    id: created.id,
    review_id: prepared.review.review_id,
    confirmed: true,
  });
  assert.equal(out.success, false);
  assert.equal(f.counts().writes, 0);
});

test('search exclusion reads accept 1000 current exact keywords and refuse 1001 without retaining a preview', async t => {
  const f = await fixture(t),
    rows = Array.from({length: 1000}, (_, i) => ({
      adGroup: {id: '2', resourceName: 'customers/123/adGroups/2'},
      adGroupCriterion: {
        resourceName: 'customers/123/adGroupCriteria/2~' + (i + 1),
        adGroup: 'customers/123/adGroups/2',
        status: 'ENABLED',
        negative: true,
        type: 'KEYWORD',
        keyword: {text: 'unrelated ' + i, matchType: 'EXACT'},
      },
    }));
  f.criteria(rows);
  const p = ok(await f.preview());
  assert.equal(p.targets.length, 2);
  rows.push({
    ...rows[0],
    adGroupCriterion: {...rows[0].adGroupCriterion, resourceName: 'customers/123/adGroupCriteria/2~1001'},
  });
  assert.equal((await f.preview()).success, false);
  assert.equal(f.store.documents(f.actor.tenantId, 'search_exclusion_preview').length, 1);
  assert.equal(f.counts().writes, 0);
});

test('search exclusion saved drafts keep authority and exact binding across sessions and at initial persistence', async t => {
  const f = await fixture(t),
    p = ok(await f.preview()),
    other = f.store.authenticate(
      f.store.createKey({tenantId: f.actor.tenantId, userId: f.actor.userId, role: 'operator'}),
    );
  const args = {
    action: 'create_search_exclusion_plan',
    id: f.saved.id,
    preview_id: p.preview_id,
    preview_hash: p.preview_hash,
    confirmed: true,
  };
  assert.equal((await f.service.call('amcp_reporting', args, other)).success, false);
  const reader = f.store.authenticate(
    f.store.createKey({tenantId: f.actor.tenantId, userId: 'reader', role: 'reader'}),
  );
  assert.equal(
    (
      await f.service.call(
        'amcp_reporting',
        {action: 'search_exclusion_candidates', id: f.saved.id, options: f.options},
        reader,
      )
    ).success,
    true,
  );
  assert.equal(
    (
      await f.service.call(
        'amcp_reporting',
        {action: 'preview_search_exclusions', id: f.saved.id, ids: f.selected, options: f.options},
        reader,
      )
    ).success,
    false,
  );
  const original = f.store.putDocument.bind(f.store);
  let boundAtWrite = false;
  f.store.putDocument = (tenant, kind, id, document) => {
    if (kind === 'campaign_run') {
      assert.equal(document.search_exclusions.preview_id, p.preview_id);
      boundAtWrite = true;
    }
    return original(tenant, kind, id, document);
  };
  const created = ok(await f.create(p));
  assert.ok(created.id);
  assert.equal(boundAtWrite, true);
});

test('search exclusion preview rejects a report changed during native reads and preserves unknown or unsupported terms', async t => {
  const f = await fixture(t);
  f.hook(kind => {
    if (kind === 'ad_group_criterion')
      f.changeReport(r => {
        r.source_hash = 'changed';
      });
  });
  const result = await f.preview();
  assert.equal(result.success, false);
  assert.equal(result.data, undefined);
  assert.equal(f.store.documents(f.actor.tenantId, 'search_exclusion_preview').length, 0);
  const second = await fixture(t);
  second.changeReport(r => {
    r.rows[0].clicks = '9007199254740993';
    r.rows[1].conversions = null;
  });
  const candidates = ok(await second.candidates());
  assert.equal(candidates.candidate_count, 1);
  assert.equal(candidates.candidates[0].observed_clicks, '9007199254740993');
  assert.equal(
    second.store.document(second.actor.tenantId, 'decision_report', second.saved.id).rows[1].conversions,
    null,
  );
});
