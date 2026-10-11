import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, fingerprint, noSecrets, obj, validate, writer, type ToolCall} from './workspace-core.js';
import {gtmConsentEvidence, gtmNonStandardConsentTypes} from './gtm-consent-evidence.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import {validateDiscoveryBody} from './discovery-body.js';
import {storedLogin} from './connection-authority.js';

const gateway = 'gtm_native_action',
  workflow = 'gtm-consent-add-v1';
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid = (message: string): never => bad(message, 'CONSENT_EVIDENCE_CHANGED');
const tagFields = [
  'path',
  'accountId',
  'containerId',
  'workspaceId',
  'tagId',
  'name',
  'type',
  'liveOnly',
  'priority',
  'notes',
  'scheduleStartMs',
  'scheduleEndMs',
  'parameter',
  'fingerprint',
  'firingTriggerId',
  'blockingTriggerId',
  'setupTag',
  'teardownTag',
  'parentFolderId',
  'tagFiringOption',
  'tagManagerUrl',
  'paused',
  'monitoringMetadata',
  'monitoringMetadataTagNameKey',
  'consentSettings',
];

function selection(input: JsonObject) {
  if (input.gateway !== gateway || !id(input.account_id) || !id(input.connection_id))
    bad('Choose the exact Tag Manager account and login.');
  const r = input.requirements ?? {};
  validate(r, ['container_id', 'workspace_id', 'tag_ids', 'required_types', 'custom_types_acknowledged']);
  if (!id(r.container_id) || !id(r.workspace_id)) bad('Choose the exact container and workspace.');
  if (
    !Array.isArray(r.tag_ids) ||
    r.tag_ids.length < 1 ||
    r.tag_ids.length > 10 ||
    r.tag_ids.some((v: unknown) => !id(v)) ||
    new Set(r.tag_ids).size !== r.tag_ids.length
  )
    bad('Choose 1–10 distinct exact tag IDs.');
  if (
    !Array.isArray(r.required_types) ||
    r.required_types.length < 1 ||
    r.required_types.length > 20 ||
    r.required_types.some((v: unknown) => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(v)) ||
    new Set(r.required_types).size !== r.required_types.length
  )
    bad('Choose 1–20 distinct literal additional-consent types. Variables and duplicate types are refused.');
  // MSR-01: a type Google does not document (a typo such as analytic_storage) is never granted at runtime, so the
  // tag would stop firing once published. Each preview must acknowledge every non-standard type it adds.
  const custom = gtmNonStandardConsentTypes(r.required_types);
  if (r.custom_types_acknowledged !== undefined && typeof r.custom_types_acknowledged !== 'boolean')
    bad('custom_types_acknowledged is an explicit boolean.');
  if (custom.length && r.custom_types_acknowledged !== true)
    bad(
      'Some consent types are not documented Google consent types. Check their spelling, or acknowledge that your consent platform grants them.',
      'CONSENT_CUSTOM_TYPES_UNACKNOWLEDGED',
      {custom_types: custom},
    );
  return {
    gateway,
    account_id: input.account_id,
    connection_id: input.connection_id,
    container_id: r.container_id,
    workspace_id: r.workspace_id,
    workspace_path: `accounts/${input.account_id}/containers/${r.container_id}/workspaces/${r.workspace_id}`,
    tag_ids: r.tag_ids,
    required_types: r.required_types,
    ...(custom.length ? {custom_types: custom, custom_types_acknowledged: true} : {}),
  };
}

function authorization(store: Store, actor: Actor, scope: JsonObject) {
  store.assertActorActive(actor);
  const c = store.resolveConnection(actor, gateway, scope.account_id, scope.connection_id);
  if (
    !c.scopes.some(s =>
      [
        'https://www.googleapis.com/auth/tagmanager.readonly',
        'https://www.googleapis.com/auth/tagmanager.edit.containers',
      ].includes(s),
    )
  )
    bad('This login requires Tag Manager read permission.', 'INSUFFICIENT_SCOPE');
  return fingerprint({
    login: storedLogin(store, c),
    accounts: [...c.accounts].sort(),
    scopes: [...c.scopes].sort(),
    enabled: c.enabled,
  });
}

/** Bracketed selected native objects only. No tag list, event read, preview authorization, update or publish. */
async function collect(store: Store, call: ToolCall, actor: Actor, scope: JsonObject, ids: string[]) {
  const signature = authorization(store, actor, scope),
    references: JsonObject[] = [];
  let counters: JsonObject = {};
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({workflow, scope, ids}),
    v => {
      counters = v;
    },
    {requests: 48, rows: 24, bytes: 2 * 1024 * 1024, elapsed_ms: 60000},
  );
  const current = () => {
    if (authorization(store, actor, scope) !== signature)
      bad('The selected login or read access changed. Read a new consent preview.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  const read = async (action: string, path: string) => {
    current();
    const args = {
        operation: 'gtm_ops',
        arguments: {action, account_id: scope.account_id, connection_id: scope.connection_id, path},
      },
      requested_at = Date.now();
    const result = await call(gateway, args, actor);
    current();
    if (!result.success)
      bad(
        result.error?.message ?? 'Current tag configuration could not be read.',
        result.error?.code ?? 'CONSENT_READ_FAILED',
      );
    const d = result.data?.data;
    if (
      !obj(d) ||
      d.path !== path ||
      d.error !== undefined ||
      d.truncated ||
      d.partial === true ||
      ['nextPageToken', 'next_page_token', 'next_cursor', 'paging'].some(k => d[k] !== undefined)
    )
      invalid('Retain the exact complete native workspace and tag resources.');
    const parts = path.split('/');
    for (const [key, value] of Object.entries({
      accountId: scope.account_id,
      containerId: scope.container_id,
      workspaceId: scope.workspace_id,
      ...(action === 'GET_TAG' ? {tagId: parts.at(-1)} : {}),
    }))
      if (d[key] !== undefined && d[key] !== value) invalid('Tag Manager returned conflicting resource identities.');
    if (
      typeof d.fingerprint !== 'string' ||
      !d.fingerprint ||
      d.fingerprint.length > 512 ||
      /[\x00-\x1f\x7f]/.test(d.fingerprint)
    )
      invalid('Retain a current native fingerprint for every selected workspace and tag.');
    references.push({source_request: args, source_hash: fingerprint(d), requested_at, captured_at: Date.now()});
    budget.rows('read-' + references.length, 1);
    return d;
  };
  try {
    return await budget.run(async () => {
      const workspace = await read('GET_WORKSPACE', scope.workspace_path),
        tags: JsonObject[] = [];
      for (const tagId of ids) {
        const tag = await read('GET_TAG', scope.workspace_path + '/tags/' + tagId);
        validate(tag, tagFields, 65536, 'native tag field');
        noSecrets(tag);
        if (
          tag.tagId !== tagId ||
          typeof tag.name !== 'string' ||
          tag.name.length > 500 ||
          typeof tag.type !== 'string' ||
          !tag.type ||
          tag.type.length > 100
        )
          invalid('Retain the exact original tag ID, name and type.');
        tags.push(tag);
      }
      for (const tag of tags)
        if (fingerprint(await read('GET_TAG', tag.path)) !== fingerprint(tag))
          invalid('A selected tag changed during observation. Read a new preview.');
      if (fingerprint(await read('GET_WORKSPACE', scope.workspace_path)) !== fingerprint(workspace))
        invalid('The workspace changed during observation. Read a new preview.');
      current();
      budget.check();
      return {
        workspace,
        tags,
        authorization_signature: signature,
        source_hash: fingerprint({workspace, tags}),
        source_references: references,
        network_requests: counters.requests ?? 0,
      };
    });
  } catch (error) {
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      bad(
        'Consent evidence reached its read, row, byte or time limit. Choose fewer tags and read a new preview.',
        'CONSENT_EVIDENCE_LIMIT',
        {dimension: error.details.dimension},
      );
    throw error;
  } finally {
    budget.close();
  }
}

function nativeArguments(scope: JsonObject, tag: JsonObject, payload: JsonObject) {
  return {
    operation: 'gtm_ops',
    arguments: {
      action: 'UPDATE_TAG',
      account_id: scope.account_id,
      connection_id: scope.connection_id,
      path: tag.path,
      fingerprint: tag.fingerprint,
      payload,
    },
  };
}
/** Non-standard types this step adds; existing required types were not chosen in this preview (MSR-01). */
export const consentStepCustomTypes = (scope: JsonObject, target: JsonObject): string[] =>
  (scope.custom_types ?? []).filter((type: string) => !target.before_required_types.includes(type));
function draft(binding: JsonObject, previewId: string) {
  const custom: string[] = binding.scope.custom_types ?? [];
  return {
    action: 'create',
    name: 'Tag consent draft',
    idempotency_key: 'gtm-consent-' + previewId,
    consent_preview_id: previewId,
    consent_preview_hash: fingerprint(binding),
    confirmed: true,
    brief:
      'Workspace ' +
      binding.scope.workspace_path +
      '. Add the explicitly selected additional-consent types: ' +
      binding.scope.required_types.join(', ') +
      '. Preserve other tag configuration and existing required types. These are unapproved workspace updates; no container version is created or published. Each step still needs native review, execution confirmation and read-back.' +
      (custom.length
        ? ' Non-standard consent types acknowledged by the requester: ' +
          custom.join(', ') +
          '. A consent platform must grant them or the tag will not fire.'
        : ''),
    steps: binding.targets
      .filter((t: JsonObject) => t.state === 'change')
      .map((t: JsonObject, i: number) => ({
        id: 'consent-' + (i + 1),
        kind: 'write',
        gateway,
        account_id: binding.scope.account_id,
        connection_id: binding.scope.connection_id,
        depends_on: [],
        description:
          'Tag ' +
          t.tag_id +
          ': require additional consent ' +
          t.proposed_required_types.join(', ') +
          (consentStepCustomTypes(binding.scope, t).length
            ? '. Non-standard types acknowledged: ' + consentStepCustomTypes(binding.scope, t).join(', ')
            : ''),
        arguments: t.native_arguments,
      })),
  };
}
function previewCurrent(store: Store, actor: Actor, p: JsonObject, input: JsonObject) {
  if (
    ['gateway', 'account_id', 'connection_id'].some(
      key => input[key] !== undefined && input[key] !== p.binding.scope[key],
    ) ||
    input.requirements !== undefined
  )
    bad(
      'Save the original preview ID and hash. Changed scope or requirements need a new preview.',
      'CONSENT_PREVIEW_CHANGED',
    );
  if (
    p.user_id !== actor.userId ||
    p.actor_role !== actor.role ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.preview_hash !== input.preview_hash ||
    p.preview_hash !== fingerprint(p.binding)
  )
    bad("Choose this session's exact consent preview.", 'CONSENT_PREVIEW_CHANGED');
  if (authorization(store, actor, p.binding.scope) !== p.binding.authorization_signature)
    bad('The selected login or read access changed. Read a new consent preview.', 'CONSENT_PREVIEW_CHANGED');
}

export async function previewConsentPlan(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  const scope = selection(input),
    observed = await collect(store, call, actor, scope, scope.tag_ids),
    consent = gtmConsentEvidence(observed.workspace, observed.tags);
  const targets = observed.tags.map((tag: JsonObject, i: number) => {
    const before = consent.rows[i];
    if (
      before.setting === 'unknown' ||
      (tag.consentSettings &&
        Object.keys(tag.consentSettings).some(k => !['consentStatus', 'consentType'].includes(k))) ||
      (before.setting !== 'needed' && tag.consentSettings?.consentType !== undefined)
    )
      invalid('A selected tag has unqualified consent settings. Inspect its original native configuration separately.');
    const types = [
        ...before.required_types,
        ...scope.required_types.filter((v: string) => !before.required_types.includes(v)),
      ],
      state = before.setting === 'needed' && types.length === before.required_types.length ? 'unchanged' : 'change',
      nativeFingerprint = tag.fingerprint,
      body = Object.fromEntries(
        Object.entries(tag).filter(
          ([key]) =>
            !['path', 'accountId', 'containerId', 'workspaceId', 'tagId', 'fingerprint', 'tagManagerUrl'].includes(key),
        ),
      );
    if (types.length > 20)
      bad('Keep at most 20 literal required types per tag in this guided draft.', 'CONSENT_EVIDENCE_LIMIT');
    const originalType = tag.consentSettings?.consentType;
    if (originalType?.key !== undefined && (typeof originalType.key !== 'string' || originalType.key.length > 100))
      invalid('Retain a bounded literal consent parameter key.');
    const payload = {
        ...body,
        consentSettings: {
          consentStatus: 'needed',
          consentType: {
            ...(tag.consentSettings?.consentType?.key !== undefined ? {key: tag.consentSettings.consentType.key} : {}),
            type: 'list',
            list: [
              ...(before.setting === 'needed' ? structuredClone(originalType.list) : []),
              ...scope.required_types
                .filter((value: string) => !before.required_types.includes(value))
                .map((value: string) => ({type: 'template', value})),
            ],
          },
        },
      },
      native_arguments = nativeArguments(scope, tag, payload);
    validateDiscoveryBody('Tag', pinnedJson('.mirror/VENDOR/gtm-v2.json').document.schemas, payload);
    return {
      tag_id: tag.tagId,
      path: tag.path,
      name: tag.name,
      type: tag.type,
      before_setting: before.setting,
      before_required_types: before.required_types,
      proposed_required_types: types,
      state,
      native_fingerprint: nativeFingerprint,
      original_hash: fingerprint(tag),
      argument_hash: fingerprint(native_arguments),
      native_arguments,
    };
  });
  if (!targets.some(t => t.state === 'change'))
    bad('The selected tags already require these additional-consent types. No draft is needed.', 'CONSENT_UNCHANGED');
  if (Buffer.byteLength(JSON.stringify(targets)) > 196608)
    bad('Choose fewer or smaller tags for this draft.', 'CONSENT_EVIDENCE_LIMIT');
  const binding = {
    workflow,
    scope,
    targets,
    source_hash: observed.source_hash,
    source_references: observed.source_references,
    authorization_signature: observed.authorization_signature,
  };
  if (authorization(store, actor, scope) !== observed.authorization_signature)
    bad('Read access changed. Read a new consent preview.', 'CONSENT_PREVIEW_CHANGED');
  return store.transaction(() => {
    if (authorization(store, actor, scope) !== observed.authorization_signature)
      bad('Read access changed. Read a new consent preview.', 'CONSENT_PREVIEW_CHANGED');
    store.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='gtm_consent_preview' AND json_extract(data,'$.expires_at')<=?",
      )
      .run(actor.tenantId, Date.now());
    const count = store.db
      .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='gtm_consent_preview'")
      .get(actor.tenantId) as {n: number};
    if (count.n >= 100) bad('At most 100 current consent previews may be retained.', 'CONSENT_PREVIEW_LIMIT');
    const preview_id = randomUUID(),
      preview_hash = fingerprint(binding),
      expires_at = Date.now() + 600000;
    store.putDocument(actor.tenantId, 'gtm_consent_preview', preview_id, {
      binding,
      preview_hash,
      expires_at,
      user_id: actor.userId,
      actor_role: actor.role,
      session_id: store.sessionIdentity(actor) ?? null,
    });
    return {
      record_kind: 'gtm_consent_preview',
      preview_id,
      preview_hash,
      expires_at,
      scope,
      targets: targets.map(({native_arguments, argument_hash, ...metadata}) => metadata),
      source_hash: observed.source_hash,
      source_references: observed.source_references,
      network_requests: observed.network_requests,
      provider_mutations: 0,
      publishing: false,
      meaning:
        'Preview of explicit additional-consent settings in the selected workspace. Existing required types are preserved. This does not establish built-in checks, runtime consent, event delivery or compliance. Saving creates an unapproved draft; publishing remains separate.',
    };
  });
}

/** Synchronous exact binding within the campaign creator's transaction; no unbound guided draft after a crash. */
export function consentCreationBinding(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]) {
  if (input.consent_preview_id === undefined && input.consent_preview_hash === undefined) return undefined;
  const p = store.document(actor.tenantId, 'gtm_consent_preview', String(input.consent_preview_id));
  previewCurrent(store, actor, p, {preview_hash: input.consent_preview_hash});
  if (input.confirmed !== true || p.expires_at <= Date.now())
    bad('Use this current confirmed consent preview.', 'CONSENT_PREVIEW_CHANGED');
  const expected = draft(p.binding, p.id),
    clean = (s: JsonObject) =>
      Object.fromEntries(
        ['id', 'kind', 'gateway', 'account_id', 'connection_id', 'depends_on', 'description', 'arguments'].map(k => [
          k,
          s[k],
        ]),
      );
  if (
    input.name !== expected.name ||
    input.brief !== expected.brief ||
    input.idempotency_key !== expected.idempotency_key ||
    fingerprint(steps.map(clean)) !== fingerprint(expected.steps.map(clean))
  )
    bad('The draft differs from the exact consent preview.', 'CONSENT_PLAN_CHANGED');
  const {authorization_signature, ...binding} = p.binding;
  return {
    ...binding,
    preview_id: p.id,
    targets: binding.targets.map(({native_arguments, ...metadata}: JsonObject) => metadata),
  };
}

export async function createConsentPlan(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true)
    bad('Confirm the exact preview before saving its unapproved draft.', 'CONFIRMATION_REQUIRED');
  const p = store.document(actor.tenantId, 'gtm_consent_preview', String(input.preview_id));
  previewCurrent(store, actor, p, input);
  const result = (planId: string) => {
    store.resolveConnection(actor, gateway, p.binding.scope.account_id, p.binding.scope.connection_id);
    return {
      record_kind: 'gtm_consent_plan',
      id: planId,
      state: store.document(actor.tenantId, 'campaign_run', planId).state,
      website_path: '/campaigns?id=' + encodeURIComponent(planId),
      next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: planId}},
      provider_mutations: 0,
      publishing: false,
      approval_required: true,
    };
  };
  if (p.plan_id) return result(p.plan_id);
  if (p.expires_at <= Date.now()) bad('The consent preview expired. Read a new preview.', 'CONSENT_PREVIEW_EXPIRED');
  const key = 'gtm-consent-plan:' + actor.tenantId + ':' + p.id,
    owner = randomUUID();
  if (!store.acquireLock(key, owner, 90000))
    bad('This consent draft is already being saved. Inspect or retry its original preview.', 'CONSENT_PLAN_BUSY');
  try {
    const b = p.binding,
      observed = await collect(store, call, actor, b.scope, b.scope.tag_ids);
    previewCurrent(store, actor, p, input);
    if (observed.source_hash !== b.source_hash)
      invalid('Selected tag or workspace configuration changed since preview. Read a new preview.');
    if (p.expires_at <= Date.now() || !store.renewLock(key, owner, 90000))
      bad('Draft creation lost its current preview.', 'CONSENT_PREVIEW_EXPIRED');
    const created = await call('amcp_campaign', draft(b, p.id), actor);
    if (!created.success)
      bad(created.error?.message ?? 'Consent draft could not be saved.', created.error?.code ?? 'CONSENT_PLAN_FAILED');
    const run = store.document(actor.tenantId, 'campaign_run', created.data.id);
    if (run.gtm_consent?.preview_id !== p.id)
      bad('The draft is missing its original consent binding.', 'CONSENT_PLAN_CHANGED');
    store.putDocument(actor.tenantId, 'gtm_consent_preview', p.id, {...p, plan_id: run.id});
    store.appendAudit(actor.tenantId, 'gtm-consent/' + p.id, {
      event: 'gtm_consent_draft_created',
      plan_id: run.id,
      preview_id: p.id,
      workspace_path: b.scope.workspace_path,
      changed_tags: run.steps.length,
    });
    return result(run.id);
  } finally {
    store.releaseLock(key, owner);
  }
}

/** Only unsent source-bound steps. Accepted/uncertain effects retain their original native receipt recovery. */
export async function assertConsentStep(store: Store, call: ToolCall, actor: Actor, run: JsonObject, step: JsonObject) {
  const b = run.gtm_consent;
  if (!b || step.status === 'executing') return;
  const target = b.targets.filter((t: JsonObject) => t.state === 'change')[
    run.steps.findIndex((s: JsonObject) => s.id === step.id)
  ];
  if (
    b.workflow !== workflow ||
    !target ||
    fingerprint(step.arguments) !== target.argument_hash ||
    step.gateway !== gateway ||
    step.account_id !== b.scope.account_id ||
    step.connection_id !== b.scope.connection_id ||
    step.id !== 'consent-' + (b.targets.filter((t: JsonObject) => t.state === 'change').indexOf(target) + 1)
  )
    bad('This step no longer matches its original consent proposal. Read a new preview.', 'CONSENT_PLAN_CHANGED');
  const observed = await collect(store, call, actor, b.scope, [target.tag_id]);
  if (fingerprint(observed.tags[0]) !== target.original_hash)
    invalid('The original tag changed after this draft. Read a new preview; no update was submitted.');
  const latest = store.document(actor.tenantId, 'campaign_run', run.id);
  if (latest.revision !== run.revision || latest.state === 'cancelled')
    bad('The draft changed during the tag check. Refresh it before continuing.', 'REVISION_CONFLICT');
}
