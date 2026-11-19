import type {JsonObject} from './types.js';
import {normalizeAccount} from './account-id.js';
import {MirrorError} from './errors.js';
import {providerOf} from './provider-adapters.js';

/**
 * What an agent needs to write the steps of an amcp_campaign plan (R2.5 T4, owner General 3, 2026-11-15). The shape of a
 * step was learned only by failing: the input schema says `steps` is an array of objects (tools/list keeps no room for
 * more), and the shape stood in the text of the refusal of an invalid step. A refused step is now answered with its own
 * correction, and amcp_campaign help create carries a worked example. Nothing here names a provider: what a step sends
 * is the provider's, so the parts an example cannot know are placeholders in angle brackets.
 */
const obj = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);

/** The shape of a step in one sentence, as the refusal of an invalid step has always ended (src/campaign-runner.ts). */
export const stepShape =
  '. Each step is {"id","kind":"write","gateway","connection_id","account_id","arguments":{"action","payload"},"depends_on":[earlier ids]}; later steps use results as {"$ref":"<step id>#/data/<JSON pointer>"}.';

/** The note of the steps argument in the help of create: the shape of a step, and where its worked example is. */
export const stepsNote =
  'create: 1–50 explicit steps, in order' +
  stepShape +
  ' A media step has no gateway: its arguments are the amcp_media prepare inputs and its platform names the gateway. help create returns a worked example (worked_example).';

/** The call that returns the worked example: where every refusal of create that a caller can correct points. */
export const createHelpCall = {tool: 'amcp_campaign', arguments: {action: 'help', topic: 'create'}};

/**
 * A worked example of a plan for amcp_campaign help create: a campaign, then an ad group that waits for it and takes its
 * new ID from its verified result. It names no provider, because a step sends what its provider documents (shared help may
 * name none): the parts only a workspace can know are placeholders in angle brackets, each declared with what it stands for.
 * With every placeholder given its real value it is a plan create accepts (tests/campaign-step-help.test.mjs runs it).
 */
export const planExample: JsonObject = {
  tool: 'amcp_campaign',
  arguments: {
    action: 'create',
    // Not a string the Arabic catalogue holds: a literal of src/ that is one reads as a server message to localize
    // (tools/locale-chunks.mjs), which moves it between chunks of web/locales/ar.
    name: 'Autumn launch',
    steps: [
      {
        id: 'campaign',
        kind: 'write',
        gateway: '<gateway>',
        connection_id: '<connection_id>',
        account_id: '<account_id>',
        description: 'Create the paused campaign',
        arguments: {action: '<campaign create action>', payload: {name: '<campaign name>'}},
      },
      {
        id: 'ad_group',
        kind: 'write',
        gateway: '<gateway>',
        connection_id: '<connection_id>',
        account_id: '<account_id>',
        description: 'Create the paused ad group under the new campaign',
        depends_on: ['campaign'],
        arguments: {
          action: '<ad group create action>',
          payload: {campaign_id: {$ref: 'campaign#/data/id'}, name: '<ad group name>'},
        },
      },
    ],
  },
  placeholders: {
    '<gateway>': 'The native gateway of the account; amcp_tool_help without arguments lists them.',
    '<connection_id>':
      'The connection that holds the login of that account; amcp_workspace capabilities lists it beside the account.',
    '<account_id>': 'The account the step writes to, written the way its gateway takes it.',
    '<campaign create action>':
      'The native action that creates a campaign; amcp_tool_help with the gateway lists its actions.',
    '<ad group create action>': 'The native action that creates an ad group, ad set or ad squad of that gateway.',
    '<campaign name>': 'The name of the campaign, in the native field its create action takes.',
    '<ad group name>': 'The name of the ad group, in the native field its create action takes.',
  },
  notes: [
    'A step is a native write (kind "write": the gateway, connection_id and account_id of the account, and the native tool input in arguments) or a media upload (kind "media": no gateway, the amcp_media prepare inputs in arguments).',
    'depends_on lists the ids of earlier steps. A later step takes a value from one of them as {"$ref":"<step id>#/data/<JSON pointer>"}: the pointer reads that step’s verified result, where data is the provider’s response (get with step_id shows it), so the pointer to a new ID is where that provider puts it.',
    'brief is optional and defaults to name. gateway, connection_id and account_id belong in each step; written once at the top level of create (R2.5 field fix, 2026-11-19), they fill the steps that leave them out (a media step takes the connection and the account, never a gateway), when no step names another value.',
    'create saves a draft plan and sends nothing to a provider: each step is its own reviewed write once the plan is approved (approve, then run; or prepare_next and execute_next one step at a time).',
  ],
};

/**
 * A value that may be repeated in a refusal has the shape of what its field holds, never just the look of a plain word
 * (R2.5 S4-7: a 40-character hex token pasted into connection_id was a plain identifier, and came back in the refusal,
 * which is logged and audited). A gateway is one the workspace's providers register, a connection is a UUID, and an
 * account has its provider's form: its own normalization of it, a short identifier that is no long run of hex digits (the
 * shape of a token). Anything else is a placeholder. Arguments are never repeated.
 */
const connectionShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  accountShape = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/;
const gatewayOf = (v: unknown): string | undefined => (typeof v === 'string' && providerOf(v) ? v : undefined);
const connectionOf = (v: unknown): string | undefined =>
  typeof v === 'string' && connectionShape.test(v) ? v : undefined;
const accountOf = (gateway: string | undefined, v: unknown): string | undefined => {
  if (typeof v !== 'string' || !accountShape.test(v)) return undefined;
  const form = gateway ? normalizeAccount(gateway, v) : v;
  return accountShape.test(form) && !/^[0-9a-f]{32,}$/i.test(form) ? v : undefined;
};

/**
 * The gateway a media step is under: its platform's, as the runner reads it when it looks up the step's connection (a media step has no
 * gateway of its own, and its `gateway` key is not read). Undefined for a step that is no media step or names no platform.
 */
const mediaGateway = (step: JsonObject): string | undefined =>
  step.kind === 'media' && obj(step.arguments) && typeof step.arguments.platform === 'string'
    ? step.arguments.platform + '_native_action'
    : undefined;

/**
 * The corrected minimal step for the kind of a refused step: what the caller sent that has the shape of its field (the
 * step's id, a registered gateway, a connection that is a UUID and an account of its provider's form, and the same given
 * at the top level of create, where each belongs inside the step), and for everything else a placeholder. A media step has
 * no gateway: its platform names it. Its arguments are the placeholders of its kind, never the caller's.
 */
export function correctedStep(step: unknown, top: JsonObject = {}): JsonObject {
  const s = obj(step) ? step : {},
    media = s.kind === 'media',
    topGateway = gatewayOf(top.gateway),
    // A gateway written inside the step's arguments is the caller's own too (R2.5 field fix, call shape, item 4). A media step is under
    // its platform's gateway.
    gateway =
      (media
        ? mediaGateway(s)
        : (gatewayOf(s.gateway) ?? gatewayOf(obj(s.arguments) ? s.arguments.gateway : undefined))) ?? topGateway,
    // What the top level of create gives a step is what create would fill into it: not a media step of another platform than the
    // gateway written beside the connection and the account, whose connection and account belong to that gateway's provider.
    given: JsonObject = media && topGateway !== undefined && mediaGateway(s) !== topGateway ? {} : top;
  return {
    id: typeof s.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,50}$/.test(s.id) ? s.id : 'step_1',
    kind: media ? 'media' : 'write',
    ...(media ? {} : {gateway: gateway ?? '<gateway>'}),
    connection_id: connectionOf(s.connection_id) ?? connectionOf(given.connection_id) ?? '<connection_id>',
    account_id: accountOf(gateway, s.account_id) ?? accountOf(gateway, given.account_id) ?? '<account_id>',
    arguments: media
      ? {platform: '<platform>', source_url: '<https link to the file>'}
      : {action: '<native action>', payload: {}},
  };
}

/** What create takes inside each step, and at its own top level as the default of the steps that leave it out. */
const stepFields = ['gateway', 'account_id', 'connection_id'];
/**
 * What create does with the gateway, the account and the connection a caller wrote once at its top level (R2.5 field fix, call
 * shape, the lead's decision of 2026-11-19, which reverses T4 for the unambiguous case only). Each is the default of the steps that
 * leave it out, and is written into them, so that the plan, its hash and the approval summary hold every step's own value, as for a
 * plan written in full: the gateway of the write steps only, and the connection and the account of a media step too (round 2, the lead's
 * answer to the open question), when its platform is the gateway written beside them or none is: a media step has no gateway of its own,
 * and the connection and the account written beside a gateway belong to that gateway's provider. A default is used only when its value has the shape of its field (a registered gateway, a connection
 * that is a UUID, an account of its provider's form: the shapes a refusal may repeat, R2.5 S4-7, so a token pasted into one is
 * neither used nor repeated) and no step names another value: a plan that names two accounts is a mix, in which a step that leaves
 * the account out could belong to either, so T4's refusal stays for it, and a media step that names another connection or account is a
 * step that does (its account is compared as its platform binds it). `steps` are the plan's own copies, filled in place. Returns the
 * top-level fields that were given and are not used, which a refusal tells the caller to move into each step (topLevelMoves).
 */
export function fillStepDefaults(steps: unknown[], top: JsonObject): string[] {
  const topGateway = gatewayOf(top.gateway),
    fill: JsonObject = {},
    unused: string[] = [];
  for (const field of stepFields) {
    if (top[field] === undefined) continue;
    const value =
      field === 'gateway'
        ? topGateway
        : field === 'connection_id'
          ? connectionOf(top.connection_id)
          : accountOf(topGateway, top.account_id);
    // The account is compared as its provider binds it (Meta without its act_ prefix, Google without dashes), under the gateway the step
    // is under: its own, or its platform's for a media step.
    const alike = (step: JsonObject) => {
      if (field !== 'account_id') return step[field] === value;
      const gateway = (step.kind === 'media' ? mediaGateway(step) : gatewayOf(step.gateway)) ?? topGateway ?? '';
      return (
        typeof step.account_id === 'string' &&
        normalizeAccount(gateway, step.account_id) === normalizeAccount(gateway, value as string)
      );
    };
    if (
      value === undefined ||
      steps.some(s => obj(s) && s[field] !== undefined && (field !== 'gateway' || s.kind !== 'media') && !alike(s))
    )
      unused.push(field);
    else fill[field] = value;
  }
  for (const s of steps) {
    if (!obj(s) || (s.kind !== 'write' && s.kind !== 'media')) continue;
    const media = s.kind === 'media';
    // A media step of another platform than the gateway written beside the connection and the account is left as it is: they belong to
    // that gateway's provider, so filling them in would only end in the refusal of the lookup of its connection.
    if (media && topGateway !== undefined && mediaGateway(s) !== topGateway) continue;
    for (const [field, value] of Object.entries(fill)) if (!media || field !== 'gateway') s[field] ??= value;
  }
  return unused;
}
/**
 * The fields of the top level of create that it did not use (fillStepDefaults), with the sentence that tells the caller to name them in
 * each step and where each one goes; undefined when there are none. Only the names are repeated, never their values. The sentence
 * is the refusal's `details.hint`, beside its message and not behind it: the message stays one sentence the website can show in
 * Arabic (R2.5 S3-3), and a sentence built from the names that were given has no single form to look up.
 */
export function topLevelMoves(names: string[]): {hint: string; move: JsonObject[]} | undefined {
  if (!names.length) return undefined;
  const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0];
  return {
    hint:
      'Move ' +
      list +
      ' into each step (' +
      names.map(k => 'steps[].' + k).join(', ') +
      '): at its top level create fills the steps that leave a field out only with a value that fits it, and only when no step names another.',
    move: names.map(k => ({from: k, to: 'steps[].' + k})),
  };
}

/**
 * The finding that a top-level value of create was not used, for a plan that is accepted all the same (round 2, S3-1): every step named
 * its own, either because a step contradicts the value or because the value does not fit its field (fillStepDefaults). It is a
 * `meta.argument_warnings` entry in the form of ARGUMENT_NOT_USED_BY_ACTION, which these three fields drew before create read them
 * (code, field, message, help_call). It names the field only, never the value. A plan that is refused for it says so in the hint of
 * the refusal instead (topLevelMoves).
 */
export const topLevelNotUsedWarning = (field: string): JsonObject => ({
  code: 'TOP_LEVEL_VALUE_NOT_USED',
  field,
  message:
    field +
    ' at the top level of create was not used: a step names another value, or it does not fit its field. Each step keeps its own.',
  help_call: createHelpCall,
});
/**
 * A call or a plan step that writes its `gateway` inside its `arguments`, read as if the gateway stood beside them (R2.5 field
 * fix, call shape, the lead's decision of 2026-11-19). amcp_write takes the gateway at its top level and a plan step takes it in the
 * step, and an agent that knew one shape wrote the other: it was refused by a sentence that named neither the fault nor the fix. Only
 * when the host names no gateway of its own (a host that does is the caller's call as it stands, so an action that ever took a
 * native `gateway` argument keeps it) and `arguments.gateway` is a gateway the caller's registry knows. The gateway leaves
 * `arguments`: everything that reads the host after this (the group check, the review that is frozen, its stored prepare input and
 * each call that prepares it again) sees the canonical shape. Undefined when nothing is lifted. Nothing here names a provider:
 * `registered` is the registry of whoever calls.
 */
export function liftedGateway(host: JsonObject, registered: (gateway: string) => boolean): JsonObject | undefined {
  const args = host.arguments;
  if (host.gateway !== undefined || !obj(args) || typeof args.gateway !== 'string' || !registered(args.gateway))
    return undefined;
  const {gateway, ...rest} = args;
  return {...host, gateway, arguments: rest};
}

/**
 * What a plan step carries beside its arguments that amcp_write does not take, in the one order every refusal names them: the
 * account, which amcp_write takes inside arguments, and the four keys that only a step of amcp_campaign create has.
 */
const writeCallStepKeys = ['account_id', 'id', 'kind', 'depends_on', 'description'];

/**
 * The refusal of an amcp_write prepare or inspect that carries the keys of a plan step (R2.5 field fix, call shape, 2026-11-19): the
 * call fell to the generic refusal of an unknown parameter, which names the key and not the shape. The one sentence says what the
 * first key is and where it goes; `details` carry that key (`field`), where every such key goes (`move`: account_id inside
 * arguments, the others as a step of amcp_campaign create), a hint that says it in a sentence, and the help that shows the shape
 * (`next_call`). Only the names of keys are repeated, never their values (R2.5 S4-7: a token pasted into a field came back in a
 * refusal that is logged and audited). Undefined when the call has none of them, and for an action that takes no arguments for
 * them to move into, which keeps the generic refusal.
 */
export function misplacedStepKeys(input: JsonObject): MirrorError | undefined {
  if (input.action !== 'prepare' && input.action !== 'inspect') return undefined;
  const present = writeCallStepKeys.filter(key => Object.hasOwn(input, key)),
    planOnly = present.filter(key => key !== 'account_id');
  if (!present.length) return undefined;
  const field = planOnly[0] ?? 'account_id',
    several = planOnly.length > 1,
    names = several ? planOnly.slice(0, -1).join(', ') + ' and ' + planOnly.at(-1) : planOnly[0],
    details = {
      field,
      move: present.map(key => ({
        from: key,
        to: key === 'account_id' ? 'arguments.account_id' : 'amcp_campaign create steps[].' + key,
      })),
      hint: planOnly.length
        ? 'amcp_write prepares one change: gateway and connection_id stand beside arguments, and the account goes inside arguments. ' +
          names +
          (several ? ' are fields' : ' is a field') +
          ' of a plan step: send the step to amcp_campaign create, or leave ' +
          (several ? 'them' : 'it') +
          ' out for one change.' +
          (present.includes('account_id') ? ' Move account_id into arguments too.' : '')
        : 'amcp_write takes the account inside arguments, beside the native action and its payload: move account_id there (a gateway that names its account with another key takes that key; amcp_tool_help with the gateway names it). amcp_campaign create is the call that takes it beside arguments, in each step.',
      next_call: {tool: 'amcp_write', arguments: {action: 'help', topic: 'prepare'}},
    };
  return planOnly.length
    ? new MirrorError(
        'INVALID_ARGUMENT',
        '{field} belongs to a plan step: send it as a step to amcp_campaign create.',
        details,
        400,
        false,
        {field},
      )
    : new MirrorError('INVALID_ARGUMENT', 'account_id goes inside arguments in amcp_write.', details);
}

/** Where amcp_write takes its gateway, in the words of the warning a lifted one draws. */
export const writeGatewaySite = 'amcp_write takes at its top level, beside arguments';

/**
 * The shape of each tool in one line, for the help of the other (R2.5 field fix, call shape, item 5): amcp_write takes its gateway
 * and its connection beside its arguments and the account inside them, and a plan step takes all three beside its arguments. The
 * account field of amcp_write is the one its gateway takes (round 2, S3-2): account_id for most, and a gateway that names it otherwise
 * or refuses account_id says so in amcp_tool_help, which the line sends the agent to without naming a provider. Help data, the
 * `other_tool_shape` of amcp_write prepare and of amcp_campaign create (src/tool-help.ts), never tools/list.
 */
export const planShapeLine =
  'amcp_campaign create takes gateway, connection_id and account_id in each step beside arguments ({action, payload}), or once at the top level of create for the steps that leave them out, when no step names another value; amcp_write takes gateway and connection_id at its top level and the account inside arguments.';
export const writeShapeLine =
  'amcp_write prepare takes gateway and connection_id at its top level and the account inside arguments, in the field its gateway takes ({action, account_id, payload} where it takes account_id; amcp_tool_help with the gateway, and with the operation for a delegated gateway, shows the field); a step of a plan takes all three beside arguments.';
/** Where a plan step takes its gateway, in the words of the warning a lifted one draws. */
export const stepGatewaySite = 'a plan step takes beside its arguments';

/**
 * The write steps of a plan that name their gateway inside their arguments (R2.5 field fix, call shape, item 4), lifted into the step
 * in place under the rule of liftedGateway, where a registered gateway is one the providers register, as correctedStep reads it.
 * `steps` are the plan's own copies. Returns one warning for each step lifted, naming where the caller wrote it
 * (`steps[i].arguments.gateway`). A media step is left as it was: it has no gateway, and its arguments are the amcp_media prepare inputs.
 */
export function liftStepGateways(steps: unknown[]): JsonObject[] {
  const warnings: JsonObject[] = [];
  steps.forEach((s, index) => {
    const step = obj(s) && s.kind === 'write' ? liftedGateway(s, name => providerOf(name) !== undefined) : undefined;
    if (!step) return;
    steps[index] = step;
    warnings.push(
      gatewayMovedWarning('steps[' + index + '].arguments.gateway', 'steps[' + index + '].gateway', stepGatewaySite),
    );
  });
  return warnings;
}

/**
 * The deprecation warning of a gateway that was lifted out of `arguments` (a `meta.argument_warnings` entry, in the style of
 * src/action-aliases.ts): where the caller wrote it, where it was read as written, and where the tool takes it. The old shape keeps
 * working; a later release may refuse it.
 */
export const gatewayMovedWarning = (field: string, to: string, site: string): JsonObject => ({
  code: 'GATEWAY_PLACEMENT_DEPRECATED',
  field,
  moved_to: to,
  message:
    field +
    ' was used as ' +
    to +
    ', which ' +
    site +
    '. Send it there: a later release may refuse it with INVALID_ARGUMENT.',
});
