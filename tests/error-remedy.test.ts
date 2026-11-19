import test from 'node:test';
import assert from 'node:assert/strict';
import {MirrorError, errorResult, providerHttpErrorCode} from '../src/errors.js';

test('remedies distinguish local contracts and grants from provider denial without inventing a missing scope', () => {
  for (const [code, category] of [
    ['WRITE_CONTRACT_UNAVAILABLE', 'contract'],
    ['VENDOR_SCHEMA_UNAVAILABLE', 'contract'],
    ['SANDBOX_ROUTE_UNQUALIFIED', 'contract'],
    ['WRITE_ACCOUNT_FORBIDDEN', 'grant'],
    ['RESOURCE_SCOPE_REQUIRED', 'grant'],
    ['LINKEDIN_ORGANIZATION_BINDING_REQUIRED', 'grant'],
    ['LINKEDIN_MEDIA_BINDING_REQUIRED', 'grant'],
    ['STATE_CHANGED', 'state'],
    ['WRITE_OUTCOME_UNCERTAIN', 'state'],
    ['WRITE_PARTIAL_OR_FAILED', 'provider'],
    ['REAUTHORIZATION_REQUIRED', 'provider'],
  ]) {
    const r = errorResult(new MirrorError(code!, 'Fixture'), 'req', 1);
    assert.equal(r.error.category, category);
    assert.equal(r.error.remedy.mutation_retry_safe, false);
    assert.ok(r.error.next_action);
  }
  const upstream = {status: 403, message: 'Access denied'},
    code = providerHttpErrorCode(403, upstream),
    r = errorResult(new MirrorError(code, 'Provider denied', {upstream, http_status: 403}), 'req', 2);
  assert.equal(code, 'PROVIDER_ACCESS_DENIED');
  assert.equal(r.error.category, 'provider');
  assert.deepEqual(r.error.details?.upstream, upstream);
  assert.ok(!r.error.remedy.action.includes('w_organization_social'));
  assert.ok(r.meta.untrusted_provider_content);
  assert.equal(
    errorResult(new MirrorError('INSUFFICIENT_SCOPE', 'Local scopes missing'), 'req', 0).error.category,
    'grant',
  );
  assert.equal(
    errorResult(new MirrorError('INSUFFICIENT_SCOPE', 'Provider scope error', {upstream}), 'req', 0).error.category,
    'provider',
  );
});

test('frequent refusals name their own next step instead of a generic "prepare again"', () => {
  const expect: [string, string, RegExp][] = [
    ['STATE_NOT_FOUND', 'state', /belongs to this account/],
    ['STATE_TARGET_MISMATCH', 'state', /different object/],
    ['INCOMPLETE_STATE', 'state', /never authorizes a write/],
    ['STATE_READ_FAILED', 'state', /Retry the same call/],
    ['STATE_TOO_LARGE', 'state', /Narrow/],
    ['POLICY_BUDGET_LIMIT', 'policy', /No confirmation flag overrides it/],
    ['POLICY_ACTIVATION_FORBIDDEN', 'policy', /ask the owner/],
    ['WRITES_PAUSED', 'policy', /after the owner resumes/],
    ['CONFIGURATION_EXISTS', 'state', /update of it instead of another create/],
    ['PAUSED_CREATION_REQUIRED', 'request', /separate change/],
    ['CONNECTION_REQUIRED', 'grant', /Connections page/],
    ['AMBIGUOUS_CONNECTION', 'request', /connection_id/],
    ['PROVIDER_WRITE_SCOPE_REQUIRED', 'grant', /write scope/],
    ['ENCRYPTION_REQUIRED', 'deployment', /MIRROR_MASTER_KEY/],
    ['LIVE_WRITES_DISABLED', 'deployment', /operator/],
    ['TOKEN_REFRESH_FAILED', 'provider', /Reconnect/],
    ['MEDIA_RESPONSE_INVALID', 'provider', /do not resubmit/],
    ['REPORT_SHAPE_CHANGED', 'provider', /do not resubmit/],
    ['MEDIA_UPLOAD_INCOMPLETE', 'request', /parts the details name/],
    ['MEDIA_PARTS_BUSY', 'state', /same part again/],
    ['MEDIA_UPLOAD_COMPLETING', 'state', /complete the upload again/],
    ['UPLOAD_DEADLINE_TOO_CLOSE', 'state', /Nothing was sent/],
    ['MEDIA_SOURCE_NOT_FOUND', 'state', /30 minutes/],
    ['MEDIA_LINK_BLOCKED', 'request', /public HTTPS link/],
    ['MEDIA_CHANGED', 'state', /nothing was uploaded/],
    ['INVALID_ARGUMENT', 'request', /argument the message names/],
    ['MISSING_PARAMETER', 'request', /argument the message names/],
  ];
  for (const [code, category, action] of expect) {
    const r = errorResult(new MirrorError(code, 'Fixture'), 'req', 1);
    assert.equal(r.error.category, category, code);
    assert.match(r.error.remedy.action!, action, code);
    assert.equal(r.error.remedy.mutation_retry_safe, false, code);
    if (code.startsWith('STATE_') || code.startsWith('POLICY_'))
      assert.doesNotMatch(r.error.remedy.action!, /prepare again/i, code);
  }
});

// r25-media-drive-large (item 2, 2026-11-19): a refused public Drive download names why, and each reason its own next step.
test('a refused public Drive download names its own next step by reason, and one with no reason keeps the family remedy', () => {
  const remedy = (details: Record<string, unknown>) =>
    errorResult(new MirrorError('DRIVE_FILE_UNAVAILABLE', 'Fixture', details), 'req', 1).error;
  const expect: [string, string, RegExp][] = [
    ['not_shared', 'request', /anyone with the link.*Drive connection.*drive_connection_id/],
    ['download_quota', 'state', /later.*drive_connection_id/],
    ['flagged', 'request', /never bypasses.*different file/],
  ];
  const family = remedy({}).remedy.action;
  for (const [reason, category, action] of expect) {
    const e = remedy({reason});
    assert.equal(e.category, category, reason);
    assert.match(e.remedy.action!, action, reason);
    assert.equal(e.remedy.mutation_retry_safe, false, reason);
    assert.notEqual(e.remedy.action, family, reason);
  }
  // An unrecognized page, or a refusal that carries no reason (a Drive 500), keeps what it always said.
  assert.equal(remedy({reason: 'unrecognized_page'}).remedy.action, family);
  assert.equal(remedy({http_status: 500}).remedy.action, family);
  assert.match(family, /shared with this connection/);
  // The reasons are Drive's: another code that carries the same word is not given a Drive remedy.
  assert.notEqual(
    errorResult(new MirrorError('MEDIA_DOWNLOAD_FAILED', 'Fixture', {reason: 'not_shared'}), 'req', 1).error.remedy
      .action,
    remedy({reason: 'not_shared'}).remedy.action,
  );
});
test('code families that fell to the generic remedy now name their own next step (F-28)', () => {
  const generic = errorResult(new MirrorError('ZZZ_UNLISTED_PROBE', 'Fixture'), 'req', 1).error.remedy.action;
  const expect: [string, string, RegExp][] = [
    ['META_LABEL_STATE_UNVERIFIED', 'state', /could not read the current state/],
    ['CRITEO_STATE_UNVERIFIED', 'state', /could not read the current state/],
    ['ADJUST_REPORT_LIMIT', 'request', /Narrow/],
    ['X_CREATIVE_DISCOVERY_LIMIT', 'request', /Narrow/],
    ['RECIPE_INPUT_REQUIRED', 'request', /recipe_context/],
    ['DESTINATION_REQUIRED', 'request', /recipe_context/],
    ['MEDIA_NOT_READY', 'state', /amcp_media status/],
    ['MEDIA_DOWNLOAD_FAILED', 'request', /shared with this connection/],
    ['DRIVE_FILE_UNAVAILABLE', 'request', /shared with this connection/],
    ['MEDIA_STAGING_INVALID', 'request', /prepare the media again/],
    ['MEDIA_DIMENSIONS_UNSUPPORTED', 'request', /inspect_eligibility/],
    ['GOOGLE_GOAL_EXISTS', 'state', /update the existing one/],
    ['ASSET_LINK_EXISTS', 'state', /update the existing one/],
    ['GOOGLE_GOAL_NOT_FOUND', 'state', /account’s own list/],
    ['NOT_FOUND', 'state', /account’s own list/],
    ['AUDIENCE_IN_USE', 'state', /its own reviewed change/],
    ['GOOGLE_GOAL_TYPE_MISMATCH', 'state', /current state/],
    ['INCOMPLETE_REPORT', 'report', /never presented as complete/],
    ['REPORT_DOWNLOAD_FAILED', 'report', /never presented as complete/],
    ['UNSAFE_PAGINATION_LINK', 'provider', /stopped reading/],
    ['PAGINATION_LOOP', 'provider', /stopped reading/],
    ['STALE_JOB_LEASE', 'state', /status/],
    ['X_REPORT_DOWNLOAD_BUSY', 'state', /status/],
    ['BACKUP_INTEGRITY_FAILED', 'deployment', /backup/],
    ['UNAPPROVED_REPORT_URL', 'provider', /did not follow it/],
    ['X_REPORT_LOGIN_CHANGED', 'state', /current login/],
    ['SPREADSHEET_SCOPE_REQUIRED', 'grant', /Reconnect/],
    ['PARENT_SERVING', 'request', /paused/],
    ['PLAN_CHANGED', 'state', /approve/],
    ['UPSTREAM_UNAVAILABLE', 'provider', /never resubmit/i],
    ['AUDIT_REPORT_REQUIRED', 'request', /Supply/],
    ['MEDIA_PLATFORM_UNSUPPORTED', 'request', /inspect_eligibility|supported/],
  ];
  for (const [code, category, action] of expect) {
    const r = errorResult(new MirrorError(code, 'Fixture'), 'req', 1);
    assert.equal(r.error.category, category, code);
    assert.match(r.error.remedy.action!, action, code);
    assert.notEqual(r.error.remedy.action, generic, code);
    assert.equal(r.error.remedy.mutation_retry_safe, false, code);
  }
});
