import {MirrorError} from './errors.js';
import {sha256, stable} from './security.js';
import {dataManagerKind} from './google-data-manager.js';
import {metaOfflineConversionKind} from './meta-offline-conversions.js';
import {hashPeople, type PersonalDataSpec} from './personal-data.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Offline-upload rehearsal as a local dry run (MSR-03 slice E). When `amcp_write inspect` checks an offline conversion
 * upload, the people are hashed in memory once more with the provider's time limits applied, the exact execution body
 * is built, and so is the provider's documented no-execution form of it. Neither is sent: a provider rehearsal still
 * transmits hashed personal data, so under owner decision P4 (2026-10-11) it is reviewed like an execution, and sending
 * one waits for a reviewed rehearsal path, designated test resources and write-class authorization. The result is
 * recorded as a rehearsal, creates no review and can never be executed.
 *
 * Which provider "test" paths are rehearsals, and which are production writes:
 * - Google Data Manager events:ingest documents validateOnly: "the request is validated but not executed".
 * - Meta's Conversions API test_event_code sends production events that are not dropped, so Meta has no rehearsal.
 */
interface RehearsalRoute {
  provider: string;
  /** The documented no-execution flag of the provider's request, or undefined when the provider has none. */
  flag?: string;
  note: string;
}
const routes: {kind: (p: CompiledRequest) => boolean; route: RehearsalRoute}[] = [
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
const hash = (value: unknown) => sha256(stable(value));

/** The rehearsal of an offline conversion upload, or undefined for any other request. Nothing is sent or saved. */
export function offlineUploadRehearsal(
  plan: CompiledRequest,
  spec: PersonalDataSpec,
  people: unknown,
  now = Date.now(),
): JsonObject | undefined {
  const route = routes.find(r => r.kind(plan))?.route;
  if (!route) return undefined;
  // The provider's time limits apply here, unlike the contract check, which skips them.
  let batch, timeWindow: JsonObject;
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
    request = (body: JsonObject) => ({method: plan.method, origin: plan.origin ?? null, path: plan.path, body});
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
          flag: {[route.flag!]: true},
          request_hash: hash(request(rehearsal)),
          // The only difference between the two bodies is the documented flag.
          differs_by: Object.keys(rehearsal).filter(k => stable(rehearsal[k]) !== stable(execution[k])),
          sent: false,
          note: route.note,
        }
      : {available: false, sent: false, note: route.note},
    meaning:
      'Local dry run of an offline upload: AMCP hashed the people in memory, applied the provider time limits and built the exact request without sending it. No review was created, nothing was sent or saved, and a rehearsal can never be executed.',
  };
}
