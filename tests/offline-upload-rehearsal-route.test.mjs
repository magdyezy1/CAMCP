import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {MirrorError} from '../dist/src/errors.js';
import {sha256, stable} from '../dist/src/security.js';
import {hashPeople} from '../dist/src/personal-data.js';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {metaPrefix} from '../dist/src/meta-version.js';
import {dataManagerKind, googleOfflineConversionPeople} from '../dist/src/google-data-manager.js';
import {metaOfflineConversionKind, metaOfflineConversionPeople} from '../dist/src/meta-offline-conversions.js';
import {offlineUploadRehearsal} from '../dist/src/offline-upload-rehearsal.js';

// ARC-01 phase B, the offline-upload rehearsal (MSR-03 slice E): which provider request a conversion upload rehearses,
// its documented no-execution flag and what the review says of it are facts of the family's personal-data spec
// (`rehearsal`), so src/offline-upload-rehearsal.ts imports no provider module. It still rehearses by the request: the
// rehearsal of the family whose request it is, whatever spec the caller passes. Loading the catalog first evaluates the
// registry, as entry points do.
const registry = new Registry();

/** src/offline-upload-rehearsal.ts before the move: its routes and function, transcribed as they were written. */
const copiedRoutes = [
  {
    kind: p => dataManagerKind(p) === 'events',
    route: {
      provider: 'Google Data Manager events:ingest',
      flag: 'validateOnly',
      note: 'Google documents validateOnly on events:ingest: the request is validated but not executed. It still sends the hashed people, so AMCP does not send it.',
    },
  },
  {
    kind: metaOfflineConversionKind,
    route: {
      provider: 'Meta Conversions API events',
      note: 'Meta has no rehearsal for conversions: events sent with test_event_code are production events that are not dropped, so AMCP never offers it.',
    },
  },
];
const hash = value => sha256(stable(value));
function copiedRehearsal(plan, spec, people, now = Date.now()) {
  const route = copiedRoutes.find(r => r.kind(plan))?.route;
  if (!route) return undefined;
  let batch, timeWindow;
  try {
    batch = hashPeople(people, spec, 'add', now);
    timeWindow = {state: 'within_provider_limits'};
  } catch (error) {
    if (!(error instanceof MirrorError)) throw error;
    batch = hashPeople(people, spec, 'add', null);
    timeWindow = {state: 'refused', code: error.code, message: error.message, events: error.details.events ?? null};
  }
  const execution = spec.body(plan, batch.rows),
    rehearsal = route.flag ? {...execution, [route.flag]: true} : undefined,
    request = body => ({method: plan.method, origin: plan.origin ?? null, path: plan.path, body});
  return {
    record_kind: 'offline_upload_rehearsal',
    mode: 'local_dry_run',
    outcome: 'rehearsal',
    provider: route.provider,
    transmitted: false,
    network_requests: 0,
    provider_mutations: 0,
    review_created: false,
    executable: false,
    counts: batch.record.counts,
    ...(batch.record.summary ? {summary: batch.record.summary} : {}),
    time_window: timeWindow,
    execution_request_hash: hash(request(execution)),
    provider_rehearsal: rehearsal
      ? {
          available: true,
          flag: {[route.flag]: true},
          request_hash: hash(request(rehearsal)),
          differs_by: Object.keys(rehearsal).filter(k => stable(rehearsal[k]) !== stable(execution[k])),
          sent: false,
          note: route.note,
        }
      : {available: false, sent: false, note: route.note},
    meaning:
      'Local dry run of an offline upload: AMCP hashed the people in memory, applied the provider time limits and built the exact request without sending it. No review was created, nothing was sent or saved, and a rehearsal can never be executed.',
  };
}

const plan = (gateway, method, path, action, extra = {}) => ({
  gateway,
  action,
  method,
  path,
  query: {},
  body: {},
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  accountId: '1234567890',
  evidence: '',
  warnings: [],
  personalData: {schema: ['EMAIL'], direction: 'add', settings: {conversion_action_id: '800'}},
  ...extra,
});
const pathOf = r =>
  r.path.startsWith('https://')
    ? new URL(r.path.replace(/\{[^}]+\}/g, '123')).pathname
    : r.path.split('?')[0].replace(/\{[^}]+\}/g, '123');
const now = Date.UTC(2026, 9, 24, 12),
  seconds = Math.floor(now / 1000);
// Each conversion spec with people it accepts, and with an event older than its provider takes (a refused window).
const specs = [
  [
    googleOfflineConversionPeople,
    {
      schema: ['EMAIL'],
      rows: [
        {EMAIL: 'a@example.com', event_time: seconds - 3600, value: 250, currency: 'SAR', transaction_id: 'order-7'},
        {gclid: 'Cj0KCQiA1234567890abcdEFGH', event_time: seconds - 7200, event_source: 'WEB'},
      ],
    },
    {schema: ['EMAIL'], rows: [{EMAIL: 'a@example.com', event_time: seconds - 91 * 86400}]},
  ],
  [
    metaOfflineConversionPeople,
    {
      schema: ['EMAIL'],
      rows: [
        {
          EMAIL: 'a@example.com',
          event_name: 'Purchase',
          event_time: seconds - 60,
          action_source: 'email',
          value: 5,
          currency: 'SAR',
        },
      ],
    },
    {
      schema: ['EMAIL'],
      rows: [{EMAIL: 'a@example.com', event_name: 'Lead', event_time: seconds - 8 * 86400, action_source: 'email'}],
    },
  ],
];
/** A call's result or refusal, comparable before and after. */
const run = f => {
  try {
    return {result: f()};
  } catch (error) {
    return {refused: error instanceof MirrorError ? [error.code, error.message, error.status] : String(error)};
  }
};

test('every request rehearses as before: the same result or refusal for every ledger route, spec and people', () => {
  const rows = actionContracts(registry).filter(r => r.method && r.path);
  assert.ok(rows.length > 2000);
  const plans = [];
  for (const r of rows) {
    const action = r.operation ? r.operation + (r.action !== r.operation ? '/' + r.action : '') : r.action;
    plans.push(plan(r.gateway, r.method, pathOf(r), action, r.origin ? {origin: r.origin} : {}));
  }
  // The edges of both routes: another Data Manager request, another origin or method, a special transport, Meta's
  // other pixel action, a pixel path that is not its events and a request that is no conversion at all.
  const events = plans.find(p => dataManagerKind(p) === 'events'),
    pixel = metaPrefix + '123456/events',
    metaUpload = plan('meta_native_action', 'POST', pixel, 'meta_pixel_id_events_create');
  assert.ok(events, 'the ledger holds the Data Manager events route');
  plans.push(
    {...events, action: 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS', path: '/v1/audienceMembers:ingest'},
    {...events, origin: 'https://googleads.googleapis.com'},
    {...events, method: 'PUT'},
    {...events, specialTransport: 'upload'},
    metaUpload,
    plan('meta_native_action', 'POST', pixel, 'meta_pixel_events_create', {origin: 'https://graph.facebook.com'}),
    plan('meta_native_action', 'POST', pixel, 'meta_pixel_id_events_create', {origin: 'https://example.com'}),
    plan('meta_native_action', 'POST', metaPrefix + '123456/stats', 'meta_pixel_id_events_create'),
    plan('meta_native_action', 'POST', pixel, 'meta_custom_audience_users_create'),
    plan('tiktok_native_action', 'POST', '/v1.3/pixel/track/', 'tiktok_write'),
  );
  const routed = new Map();
  let compared = 0;
  for (const p of plans)
    for (const [spec, ...peoples] of specs)
      for (const people of peoples) {
        const expected = run(() => copiedRehearsal(p, spec, people, now));
        assert.deepEqual(
          run(() => offlineUploadRehearsal(p, spec, people, now)),
          expected,
          JSON.stringify([p.gateway, p.method, p.path, p.action, spec.platform]),
        );
        compared++;
        const provider = expected.result?.provider;
        if (provider) routed.set(provider, (routed.get(provider) ?? 0) + 1);
      }
  assert.ok(compared > 10000, String(compared));
  // Both routes were reached, with each spec (a foreign spec builds its own body on the route of the request).
  assert.deepEqual([...routed.keys()].sort(), ['Google Data Manager events:ingest', 'Meta Conversions API events']);
  // Meta's documented absence of a rehearsal, with its reason; Google's validateOnly form, built and never sent.
  const meta = offlineUploadRehearsal(metaUpload, ...specs[1].slice(0, 2), now);
  assert.deepEqual(meta.provider_rehearsal, {available: false, sent: false, note: copiedRoutes[1].route.note});
  const google = offlineUploadRehearsal(events, ...specs[0].slice(0, 2), now);
  assert.deepEqual(
    [google.provider_rehearsal.flag, google.provider_rehearsal.differs_by, google.provider_rehearsal.sent],
    [{validateOnly: true}, ['validateOnly'], false],
  );
});

test('the rehearsal is a fact of the conversion families only, frozen, and the module imports no provider module', () => {
  const declared = reviewedFamilies()
    .filter(f => f.personalData?.rehearsal)
    .map(f => [f.name, f.personalData.rehearsal.provider, f.personalData.rehearsal.flag ?? null])
    .sort();
  assert.deepEqual(declared, [
    ['google_offline_conversions', 'Google Data Manager events:ingest', 'validateOnly'],
    ['meta_offline_conversions', 'Meta Conversions API events', null],
  ]);
  for (const [spec] of specs) assert.ok(Object.isFrozen(spec.rehearsal), spec.platform);
  // The regression this guards: the shared rehearsal importing the providers' family modules again (it imported two).
  assert.doesNotMatch(fs.readFileSync('src/offline-upload-rehearsal.ts', 'utf8'), /from '\.\/(?:google|meta)-[^']+'/);
});
