import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';
import {
  snapchatEvidenceAccount,
  snapchatEvidenceCampaign,
  snapchatEvidenceId,
  snapchatEvidenceEntity,
  snapchatEvidenceResponse,
} from './fixtures/snapchat-evidence-data.mjs';

// Primary shapes: Snapchat Campaigns account collection and Measurement campaign adsquad/day breakdown.
// All native HTTP responses and account identities are synthetic; no live account or submitted lead is read.
function fixture(t, {empty = false, population = value => value, failSecond = false, observe = () => {}} = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const parents = [snapchatEvidenceCampaign, snapchatEvidenceId(401)],
    squads = [snapchatEvidenceId(301), snapchatEvidenceId(302)],
    campaigns = parents.map((id, index) => ({
      id,
      ad_account_id: snapchatEvidenceAccount,
      name: 'Synthetic campaign ' + index,
      status: index ? 'PAUSED' : 'ACTIVE',
      objective: index ? 'WEB_CONVERSION' : 'TRAFFIC',
      deleted: index === 1,
    })),
    sem = {currency: 'USD', timezone: 'Asia/Riyadh', date_from: '2026-09-01', date_to: '2026-09-02'};
  let refusingSecond = failSecond;
  f.parents((_platform, _url, body) => {
    if (body.adsquads)
      for (const entry of body.adsquads) {
        const index = squads.indexOf(entry.adsquad.id);
        assert(index >= 0);
        Object.assign(entry.adsquad, {
          campaign_id: parents[index],
          status: index ? 'PAUSED' : 'ACTIVE',
          deleted: index === 1,
          optimization_goal: index ? 'PIXEL_PURCHASE' : 'SWIPES',
        });
      }
    if (body.campaigns)
      for (const entry of body.campaigns)
        Object.assign(
          entry.campaign,
          campaigns.find(c => c.id === entry.campaign.id),
        );
    return body;
  });
  f.hook(url => {
    if (url.hostname !== 'adsapi.snapchat.com') throw Error('Unexpected synthetic host');
    observe(url, f);
    if (url.pathname === '/v1/adaccounts/' + snapchatEvidenceAccount + '/campaigns') {
      const second = url.searchParams.get('cursor') === 'second',
        next = new URL(url);
      next.searchParams.set('cursor', 'second');
      const body = {
        request_status: 'SUCCESS',
        campaigns: empty ? [] : [{sub_request_status: 'SUCCESS', campaign: campaigns[second ? 1 : 0]}],
        paging: !empty && !second ? {next_link: next.href} : {},
      };
      return Response.json(population(body, url));
    }
    const parent = /^\/v1\/campaigns\/([^/]+)(\/stats)?$/.exec(url.pathname);
    if (!parent) return;
    const index = parents.indexOf(parent[1]);
    assert(index >= 0);
    if (!parent[2])
      return Response.json({
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'SUCCESS', campaign: campaigns[index]}],
      });
    if (refusingSecond && index === 1) {
      return Response.json(
        {
          request_status: 'ERROR',
          error_code: 'E1000',
          display_message: 'Synthetic temporary failure',
          request_id: 'snap-population-retry',
        },
        {status: 503},
      );
    }
    const template = new URL(url);
    template.pathname = '/v1/campaigns/' + snapchatEvidenceCampaign + '/stats';
    const body = snapchatEvidenceResponse(template.href, [snapchatEvidenceEntity('adsquad', squads[index], sem)], sem);
    body.timeseries_stats[0].timeseries_stat.id = parents[index];
    return Response.json(body);
  });
  const {campaign_id, ...source} = granularSource('snapchat', 'adset');
  const config = {
    ...granularConfig({...source, levels: ['adset'], delivered_only: false}),
    contract_version: 'overview-config-v4',
  };
  const run = async (changes = {}) => {
    const queued = await f.overview.handle({action: 'run', config: {...config, ...changes}, confirmed: true}, f.actor);
    assert.equal(await f.worker.once(), true);
    return f.overview.handle({action: 'get', id: queued.id, include: {native: true, lineage: true}}, f.actor);
  };
  return {
    ...f,
    parents,
    squads,
    campaigns,
    config,
    run,
    recover: () => {
      refusingSecond = false;
    },
  };
}

test('v4 Snapchat ad squads collect every paged account campaign with exact owned parents and native goal results', async t => {
  const f = fixture(t),
    report = await f.run();
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.rows.map(row => row.parent_ids.campaign_id).sort(), [...f.parents].sort());
  const rows = new Map(report.rows.map(row => [row.entity_id, row]));
  assert.equal(rows.get(f.squads[0]).result.value, '60');
  assert.equal(rows.get(f.squads[1]).result.value, '4');
  assert.equal(rows.get(f.squads[1]).status, 'archived');
  assert.equal(rows.get(f.squads[1]).native.status_evidence.deleted, true);
  assert.equal(rows.get(f.squads[0]).metrics.spend, '20.246912');
  // F-L7-16: the report states what a source reads at most, so a refusal at a bound means what it says.
  assert.deepEqual(report.sources[0].quality.population.bounds, {
    campaign_pages: 100,
    campaign_page_size: 100,
    native_daily_rows: 10000,
    days_per_read: 31,
  });
  const lists = f.requests.filter(r => r.url.pathname.endsWith('/campaigns'));
  assert(lists.some(r => r.url.searchParams.get('cursor') === 'second'));
  for (const request of lists) {
    assert.equal(request.url.searchParams.get('read_deleted_entities'), 'true');
    assert.equal(request.url.searchParams.has('sort'), false);
  }
  assert(
    !f.requests.some(r => r.url.pathname.includes('/adaccounts/') && r.url.searchParams.get('breakdown') === 'adsquad'),
  );
});

test('v4 Snapchat campaign scope avoids unrelated stats after complete parent population proof', async t => {
  const f = fixture(t),
    report = await f.run({sources: [{...f.config.sources[0], campaign_ids: [f.parents[1]]}]});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.deepEqual(
    report.rows.map(row => row.entity_id),
    [f.squads[1]],
  );
  const stats = f.requests.filter(r => r.url.pathname.endsWith('/stats'));
  assert(stats.length > 0);
  assert(stats.every(r => r.url.pathname === '/v1/campaigns/' + f.parents[1] + '/stats'));
});

for (const declaration of [true, null])
  test('an empty Snapchat population verifies the account and preserves declaration ' + declaration, async t => {
    const f = fixture(t, {empty: true}),
      report = await f.run({
        sources: [
          {
            ...f.config.sources[0],
            report_options: {...f.config.sources[0].report_options, complete_window: declaration},
          },
        ],
      });
    assert.equal(report.state, declaration ? 'complete' : 'partial', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 0);
    assert.equal(report.sources[0].quality.population.campaigns_observed, 0);
    assert.equal(report.sources[0].quality.reporting_window_declared_complete, declaration);
    assert.equal(f.requests.filter(r => r.url.pathname === '/v1/adaccounts/' + snapchatEvidenceAccount).length, 2);
    assert(!f.requests.some(r => r.url.pathname.endsWith('/stats')));
  });

for (const [name, mutate, code, message] of [
  [
    'foreign campaign',
    body => {
      body.campaigns[0].campaign.ad_account_id = '99999999-9999-4999-8999-999999999999';
      return body;
    },
    'REPORT_ACCOUNT_MISMATCH',
  ],
  [
    'repeated campaign',
    (body, url) => {
      if (url.searchParams.has('cursor')) body.campaigns[0].campaign.id = snapchatEvidenceCampaign;
      return body;
    },
    'REPORT_ACCOUNT_MISMATCH',
  ],
  // F-L7-14: the link has the right route and a cursor, so only its host is wrong; the host check alone must refuse it.
  [
    'foreign cursor host',
    body => {
      const link = new URL(body.paging.next_link);
      link.hostname = 'foreign.invalid';
      body.paging.next_link = link.href;
      return body;
    },
    'REPORT_INCOMPLETE',
  ],
  [
    'foreign cursor route',
    body => {
      const link = new URL(body.paging.next_link);
      link.pathname = '/v1/adaccounts/99999999-9999-4999-8999-999999999999/campaigns';
      body.paging.next_link = link.href;
      return body;
    },
    'REPORT_INCOMPLETE',
  ],
  [
    'changed cursor settings',
    body => {
      body.paging.next_link = body.paging.next_link.replace(
        'read_deleted_entities=true',
        'read_deleted_entities=false',
      );
      return body;
    },
    'REPORT_INCOMPLETE',
  ],
  // F-L7-12: Snapchat's spelling of a setting in its links is not pinned (the live check records it), so a setting written
  // in another case is refused rather than followed.
  [
    'a setting written in another case',
    body => {
      body.paging.next_link = body.paging.next_link.replace('read_deleted_entities=true', 'read_deleted_entities=True');
      return body;
    },
    'REPORT_INCOMPLETE',
  ],
  [
    'empty continued page',
    body => {
      body.campaigns = [];
      return body;
    },
    'REPORT_INCOMPLETE',
    /empty page with a continuation while listing the campaigns/,
  ],
  [
    'repeating cursor',
    (body, url) => {
      if (url.searchParams.has('cursor')) body.paging = {next_link: url.href};
      return body;
    },
    'REPORT_INCOMPLETE',
    /repeated a continuation cursor while listing the campaigns/,
  ],
  [
    'malformed campaign collection',
    body => {
      body.campaigns = {};
      return body;
    },
    'REPORT_SHAPE_CHANGED',
  ],
])
  test('Snapchat population refuses ' + name + ' before any stats request', async t => {
    const f = fixture(t, {population: mutate}),
      report = await f.run();
    assert.equal(report.state, 'failed', JSON.stringify(report.sources));
    assert.equal(report.sources[0].error.code, code);
    if (message) assert.match(report.sources[0].error.message, message);
    assert.equal(report.rows.length, 0);
    assert(!f.requests.some(r => r.url.pathname.endsWith('/stats')));
  });

test('Snapchat continuation stops at its hundredth parent page without claiming a complete population', async t => {
  const f = fixture(t, {
      population: (body, url) => {
        const index = Number(url.searchParams.get('cursor') ?? 0),
          next = new URL(url);
        body.campaigns[0].campaign.id = snapchatEvidenceId(2000 + index);
        next.searchParams.set('cursor', String(index + 1));
        body.paging = {next_link: next.href};
        return body;
      },
    }),
    report = await f.run();
  assert.equal(report.state, 'failed', JSON.stringify(report.sources));
  assert.equal(report.sources[0].error.code, 'REPORT_INCOMPLETE');
  // F-L7-16: it names the bound it reached, not a list of three possible conditions.
  assert.match(report.sources[0].error.message, /over more than 100 pages, the most a report reads/);
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/campaigns')).length, 100);
  assert(!f.requests.some(r => r.url.pathname.endsWith('/stats')));
});

// F-L7-12: the link is never followed, only its cursor is reused on the fixed route, so a link that omits settings or
// spells its host in capitals is not a different request.
for (const [name, rewrite] of [
  [
    'carries only a cursor and a limit',
    link => {
      link.searchParams.delete('read_deleted_entities');
    },
  ],
  [
    'writes its host in capitals',
    link => {
      link.href = link.href.replace('adsapi.snapchat.com', 'ADSAPI.SNAPCHAT.COM');
    },
  ],
])
  test('a Snapchat next_link that ' + name + ' is followed on the fixed route', async t => {
    const f = fixture(t, {
        population: body => {
          if (body.paging.next_link) {
            const link = new URL(body.paging.next_link);
            rewrite(link);
            body.paging.next_link = link.href;
          }
          return body;
        },
      }),
      report = await f.run();
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 2);
    const lists = f.requests.filter(r => r.url.pathname.endsWith('/campaigns'));
    assert.equal(lists.length, 2);
    for (const request of lists) {
      assert.equal(request.url.host, 'adsapi.snapchat.com');
      assert.equal(request.url.searchParams.get('read_deleted_entities'), 'true', 'AMCP’s own setting, not the link’s');
      assert.equal(request.url.searchParams.get('limit'), '100');
    }
  });

test('a retry reuses complete Snapchat parent captures and the frozen account population', async t => {
  const f = fixture(t, {failSecond: true}),
    first = await f.run();
  assert.equal(first.job.state, 'queued', JSON.stringify(first.job));
  assert.ok(first.job.error?.code, JSON.stringify(first.job));
  const stats = parent => f.requests.filter(r => r.url.pathname === '/v1/campaigns/' + parent + '/stats').length;
  assert.equal(stats(f.parents[0]), 1);
  f.recover();
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run();
  assert.equal(await f.worker.once(), true);
  const report = await f.overview.handle(
    {action: 'get', id: first.id, include: {native: true, lineage: true}},
    f.actor,
  );
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  assert.equal(report.rows.length, 2);
  assert.equal(stats(f.parents[0]), 1, 'The completed first parent is never recollected');
  assert.equal(report.sources[0].quality.population.campaigns_collected, 2);
});

test('removing Snapchat authority between population pages refuses the rest of the report', async t => {
  let revoked = false;
  const f = fixture(t, {
      observe: (url, f) => {
        if (!revoked && url.pathname.endsWith('/campaigns') && url.searchParams.has('cursor')) {
          revoked = true;
          const source = granularSource('snapchat'),
            connection = f.store.resolveConnection(
              f.actor,
              'snapchat_native_action',
              source.account_id,
              source.connection_id,
            );
          f.store.putConnection(f.actor, {...connection, scopes: []}, {accessToken: 'synthetic'});
        }
      },
    }),
    report = await f.run();
  assert.equal(report.state, 'failed', JSON.stringify(report.sources));
  assert(
    ['INSUFFICIENT_SCOPE', 'CONNECTION_AUTHORITY_CHANGED'].includes(report.sources[0].error.code),
    JSON.stringify(report.sources[0].error),
  );
  assert(!f.requests.some(r => r.url.pathname.endsWith('/stats')));
});
