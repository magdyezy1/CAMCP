import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import type {Actor, JsonObject} from './types.js';
import {inspectGoogleRecipeGoals} from './google-goal-inspection.js';
import {readinessBinding} from './readiness.js';
import {storedLogin} from './connection-authority.js';
import {writePause} from './owner-operations.js';
import {normalizeAccount} from './account-id.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, validate} from './workspace-core.js';

const gateway = 'google_ads_native_action';

/**
 * Google Ads conversion goals as measurement evidence (MSR-02). One bounded configuration inspection, reusing the
 * recipe-eligibility read with value settings and last-reported activity: two complete passes per collection, manager
 * and shared-conversion customers refused rather than guessed. A current() fence binds the actor, the login's
 * readiness and stored credential, and the owner write pause for the whole read, as recipe eligibility does.
 * Configuration is never proof of delivery; nothing is saved and no provider mutation is possible.
 */
export async function measurementGoogleGoals(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
): Promise<JsonObject> {
  if (input.gateway !== gateway)
    bad('Google Ads conversion goals use gateway google_ads_native_action.', 'MEASUREMENT_GOALS_UNQUALIFIED');
  const requirements = input.requirements ?? {};
  validate(requirements, ['currency']);
  if (
    requirements.currency !== undefined &&
    (typeof requirements.currency !== 'string' || !/^[A-Z]{3}$/.test(requirements.currency))
  )
    bad('Use the account currency as a three-letter ISO code, or omit it to report the observed currency.');
  const account = normalizeAccount(gateway, input.account_id);
  if (typeof input.account_id !== 'string' || !/^\d{1,32}$/.test(account))
    bad('Choose the exact numeric Google Ads customer ID.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id),
    binding = readinessBinding(connection),
    login = storedLogin(store, connection),
    pause = fingerprint(writePause(store, actor.tenantId));
  const current = () => {
    store.assertActorActive(actor);
    const now = store.resolveConnection(actor, gateway, account, connection.id);
    if (
      readinessBinding(now) !== binding ||
      storedLogin(store, now) !== login ||
      fingerprint(writePause(store, actor.tenantId)) !== pause
    )
      throw new MirrorError(
        'STATE_CHANGED',
        'Account access, the login or workspace controls changed during the read. Read the conversion goals again.',
      );
  };
  current();
  const inspection = await inspectGoogleRecipeGoals(
    store,
    registry,
    transport,
    credentials,
    actor,
    {
      gateway,
      connection_id: connection.id,
      account_id: account,
      ...(requirements.currency ? {currency: requirements.currency} : {currency_source: 'observed'}),
      include_value_settings: true,
      include_activity: true,
    },
    current,
  );
  current();
  if (inspection.provider_mutations !== 0)
    throw new MirrorError('STATE_READ_FAILED', 'Conversion goal evidence requires a read-only result.');
  const {record_kind: _kind, scope: _scope, ...evidence} = inspection;
  return {
    record_kind: 'measurement_google_goals',
    scope: {
      gateway,
      connection_id: connection.id,
      account_id: account,
      currency: inspection.customer?.currency ?? requirements.currency ?? null,
      currency_source: requirements.currency ? 'declared' : 'observed',
    },
    ...evidence,
    complete: inspection.complete === true,
    checks: {
      event_delivery: 'unverified',
      deduplication: 'unverified',
      consent: 'unverified',
      attribution: 'unverified',
    },
    provider_mutations: 0,
    snapshot_saved: false,
    meaning:
      inspection.complete === true
        ? 'Current Google Ads conversion configuration from two matching bounded reads. Configuration is not proof that conversions are delivered, deduplicated, consented or attributed. Nothing was saved.'
        : 'The conversion configuration could not be completely inspected; no partial goal or primary-action evidence is reported as ready. Nothing was saved.',
  };
}
