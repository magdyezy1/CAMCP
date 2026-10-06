import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {operationsWorkerHealth} from '../dist/src/operations-worker-health.js';

const source = readFileSync('web/owner-operations.js', 'utf8'),
  helper = source.slice(source.indexOf('function ownerWorkerHealth('), source.indexOf('const ownerCall =')),
  fixed = Date.UTC(2026, 9, 6, 8);
function fixture(locale = 'en') {
  const areas = [],
    pending = [],
    context = createContext({
      Intl,
      document: {
        addEventListener() {},
        createElement() {
          return {};
        },
      },
      renderSettings() {},
      date: value => (value === undefined ? 'unknown' : new Date(value).toISOString()),
      esc: value =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
      session: {authenticated: true, administrator: true, workspaceRole: 'owner'},
      location: {pathname: '/settings'},
      navigationGeneration: 7,
      content: {
        querySelector() {
          return null;
        },
        append(area) {
          areas.push(area);
        },
      },
      platforms: [],
      pretty: String,
      authBind() {},
      $() {
        return {addEventListener() {}};
      },
      api(path) {
        return new Promise(resolve => pending.push({path, resolve}));
      },
    }),
    run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(helper);
  const app = readFileSync('web/app.js', 'utf8');
  run(app.slice(app.indexOf('const identityKey ='), app.indexOf('function resetPrivateState()')));
  return {
    context,
    areas,
    pending,
    run,
    render: value => {
      context.value = value;
      return run('ownerWorkerHealth(value)');
    },
  };
}
function observations(count = 2) {
  const store = new Store(':memory:');
  try {
    for (let n = 0; n < count; n++)
      store.putDocument('__service_limits__', 'worker_heartbeat', 'PRIVATE-' + n, {
        at: fixed - (n % 2 ? 90001 : n),
        state: n % 2 ? 'working' : 'idle',
        private: 'UNUSED-PRIVATE-HEALTH',
      });
    return operationsWorkerHealth(store, fixed);
  } finally {
    store.close();
  }
}

test('English and Arabic owner health expose bounded native liveness, exact age boundaries and accessible scoped tables', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      html = f.render(observations());
    assert.match(html, locale === 'ar' ? /تم رصد عمليات الخلفية مؤخرًا/ : /Background processes recently observed/);
    assert.match(html, locale === 'ar' ? /لا تؤكد/ : /do not confirm workspace jobs/);
    assert.match(html, /role="region" tabindex="0"/);
    assert.match(html, /<caption>/);
    assert.match(html, /scope="row"/);
    assert.match(html, /scope="col"/);
    assert.match(html, /90\.001/);
    assert.doesNotMatch(html, /PRIVATE|worker_heartbeat|access_token/);
    const many = f.render(observations(1000));
    assert.equal((many.match(/scope="row"/g) ?? []).length, 100);
    assert.match(many, locale === 'ar' ? /الأعداد الإجمالية/ : /aggregate counts/);
    assert.doesNotMatch(many, /PRIVATE|UNUSED/);
  }
});

test('missing, legacy, inconsistent and malicious heartbeat values remain unavailable without being echoed', () => {
  const f = fixture(),
    original = observations();
  for (const edit of [
    () => undefined,
    () => ({status: 'active', observations: original.observations}),
    out => ({...out, status: '<img src=x onerror=HEALTH-PRIVATE>'}),
    out => ({...out, observed_records: 3}),
    out => ({...out, total_heartbeat_records: 999}),
    out => ({...out, active_records: 0}),
    out => ({...out, has_more: true}),
    out => ({...out, heartbeat_byte_limit: 513}),
    out => ({...out, at: Number.MAX_SAFE_INTEGER}),
    out => ({...out, observations: [{state: 'HEALTH-PRIVATE', age_ms: 0, stale: false}, out.observations[1]]}),
    out => ({...out, observations: [{...out.observations[0], age_ms: -1}, out.observations[1]]}),
    out => ({...out, observations: [...out.observations].reverse()}),
    out => ({...out, observations: [out.observations[0], {...out.observations[1], stale: false}]}),
  ]) {
    const html = f.render(edit(structuredClone(original)));
    assert.match(html, /observations are unavailable/);
    assert.doesNotMatch(html, /<table|<img|HEALTH-PRIVATE|Recently observed: /);
  }
  const safe = f.render({
    ...original,
    observations: original.observations.map(row => ({...row, private: '<img src=x onerror=HEALTH-PRIVATE>'})),
    private: 'HEALTH-PRIVATE',
  });
  assert.match(safe, /<table/);
  assert.doesNotMatch(safe, /HEALTH-PRIVATE|<img/);
});

test('valid absent, unavailable, uncertain and stale observations have distinct authored owner guidance', () => {
  const store = new Store(':memory:'),
    f = fixture();
  try {
    assert.match(f.render(operationsWorkerHealth(store, fixed)), /No process heartbeat has been observed/);
    store.putDocument('__service_limits__', 'worker_heartbeat', 'invalid', {at: fixed + 1, state: 'working'});
    assert.match(f.render(operationsWorkerHealth(store, fixed)), /Process observations unavailable/);
    store.putDocument('__service_limits__', 'worker_heartbeat', 'old', {at: fixed - 90001, state: 'working'});
    assert.match(f.render(operationsWorkerHealth(store, fixed)), /Process observations uncertain/);
    store.db.prepare("DELETE FROM documents WHERE id='invalid'").run();
    assert.match(f.render(operationsWorkerHealth(store, fixed)), /Only older process observations/);
  } finally {
    store.close();
  }
});

function resolveHealth(f, offset, worker = observations()) {
  const h = {
    backup: {status: 'unverified'},
    operations: {worker},
    connections: [],
    jobs: [],
    email: [],
    storage: {database_bytes: 0, report_rows: 0},
    limits: {},
    api_versions: {},
    policies: [],
  };
  for (const request of f.pending.slice(offset, offset + 2))
    request.resolve(
      request.path === '/api/account/options' ? {emailEnabled: false, providers: []} : {success: true, data: h},
    );
}
test('late owner health cannot replace a newer refresh or expose an old workspace after access or route changes', async () => {
  for (const change of ['refresh', 'identity', 'identity_mutated', 'role', 'route', 'route_generation']) {
    const f = fixture();
    f.run(source);
    const first = f.run('renderSettings()');
    assert.equal(f.pending.length, 2);
    if (change === 'refresh') {
      const second = f.run('renderSettings()');
      resolveHealth(f, 2);
      await second;
      assert.equal(f.areas.length, 1);
    } else if (change === 'identity') f.context.session = {...f.context.session};
    else if (change === 'identity_mutated') f.context.session.workspaceId = 'another-synthetic-workspace';
    else if (change === 'route_generation') f.context.navigationGeneration++;
    else if (change === 'role') {
      f.context.session.administrator = false;
      f.context.session.workspaceRole = 'viewer';
    } else f.context.location.pathname = '/commerce';
    resolveHealth(f, 0);
    await first;
    assert.equal(f.areas.length, change === 'refresh' ? 1 : 0);
    if (change === 'refresh') assert.match(f.areas[0].innerHTML, /owner-worker-health/);
  }
});
