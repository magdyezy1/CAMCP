import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {bad, obj, type ToolCall} from './workspace-core.js';
import {providerById} from './provider-adapters.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import type {CampaignClone} from './provider-adapter.js';

/**
 * A campaign plan built from an existing campaign (the owner's item 10, 2026-09-29: "clone this campaign with changes,
 * run from a spec" would have made a rebuild one command). The source is read through the ordinary account-scoped
 * native reads; the result is an ordinary draft plan, reviewed step by step or approved once. Only fields AMCP
 * already sends on create are copied (never guessed); every other field the source has is listed as not copied.
 * The new campaign starts PAUSED; its children keep their own status, which the paused campaign covers (the owner's
 * item 6 on Google, and decision 2 on Snapchat: paused-parents.ts). Each provider's clone builder is its adapter's
 * `campaign.clone` (ARC-01 phase B, wave 4c: Snapchat's, Google Search's, TikTok's and LinkedIn's moved verbatim to
 * src/<provider>-campaign-clone.ts); this module keeps the checks every clone passes and the spec's changes.
 */
type Step = JsonObject;
/** The providers whose campaigns AMCP clones, in the order the refusal names them, by provider ID. */
const cloneProviders = ['snapchat', 'google', 'tiktok', 'linkedin'];
const cloneGateways = cloneProviders.map(id => providerById(id)?.gateway as string);
// A load-time check, like the recipe catalog's: exactly the listed providers declare a clone, each once.
if (
  new Set(cloneGateways).size !== cloneProviders.length ||
  cloneGateways.some(gateway => !providerHooks(gateway)?.campaign?.clone) ||
  registeredProviderHooks.some(hooks => hooks.campaign?.clone && !cloneGateways.includes(hooks.gateway))
)
  throw new Error('The campaign clone must list every provider that declares a clone once.');
/** Checked before any connection is resolved, so an unsupported platform is named as such. */
export function assertCloneGateway(gateway: unknown) {
  if (!cloneGateways.includes(gateway as string))
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Snapchat, Google Search, TikTok and LinkedIn campaigns. Meta copies campaigns natively (meta copies); other platforms take explicit steps.',
      {field: 'gateway', supported: cloneGateways},
    );
}
/** The keys of a clone's source that some provider's clone declares as selection keys (Google Search's ad_group_ids, languages). */
const selectionKeys = () => new Set(registeredProviderHooks.flatMap(hooks => hooks.campaign?.clone?.selection ?? []));
/** A value of a selection key as text, for the identity of a request: a number or text as it reads, anything else as JSON. */
const asText = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : (JSON.stringify(value) ?? 'undefined');
/** Digits compare as numbers without being converted (a long run of them costs one comparison of lengths). */
const digitsFirst = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
/**
 * The selection a clone's source names, in a normal form, or undefined when it names none (field fix r25-field-gclone, round 3;
 * the lead's review S2-1 and S4-7). It is every key some provider declares (as assertSourceSelection reads them) that has a value
 * other than null, and a list becomes its elements as text without repeats: IDs in the order of their value, anything else in text
 * order. So [30, 20], ["20", "30"] and ["30", "20", "30"] are one selection. It never throws, whatever the source holds: it names
 * a request, it does not check one. The identity of a keyed clone takes it in only when it exists (src/campaign-runner.ts), so a
 * request that names none keeps the identity it always had.
 */
export function cloneSelection(source: unknown): JsonObject | undefined {
  if (!obj(source)) return undefined;
  const declared = selectionKeys(),
    named = Object.keys(source)
      .filter(key => declared.has(key) && source[key] !== null && source[key] !== undefined)
      .sort();
  if (!named.length) return undefined;
  return Object.fromEntries(
    named.map(key => {
      const value = source[key];
      if (!Array.isArray(value)) return [key, value];
      const texts = [...new Set(value.map(asText))];
      return [key, texts.sort(texts.every(text => /^[0-9]+$/.test(text)) ? digitsFirst : undefined)];
    }),
  );
}
/** The source without the keys that name a selection: what stays of it in the identity once the selection is named in its own words. */
export function sourceWithoutSelection(source: JsonObject): JsonObject {
  const declared = selectionKeys();
  return Object.fromEntries(Object.entries(source).filter(([key]) => !declared.has(key)));
}
/**
 * A clone's source may choose what to copy only through the keys its provider declares (`campaign.clone.selection`: Google
 * Search's ad_group_ids and languages; field fix r25-field-gclone, owner 2026-11-19: "copy only the ad groups named"). A key
 * that some provider declares and this one does not is refused, naming the keys this one takes: a clone that ignored it would
 * copy the whole campaign and say nothing. A key no provider declares is ignored, as before, so no documented call changes.
 * A null value is no choice, as it is for the provider that takes the key.
 */
function assertSourceSelection(source: JsonObject, clone: CampaignClone) {
  const declared = selectionKeys(),
    supported = ['campaign_id', ...(clone.selection ?? [])],
    unsupported = Object.keys(source).filter(
      key => source[key] !== null && source[key] !== undefined && declared.has(key) && !supported.includes(key),
    );
  if (unsupported.length)
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'A clone on this platform copies the whole campaign; source takes only the keys in details.supported.',
      {field: 'source.' + unsupported[0], unsupported, supported},
    );
}
/**
 * The report-only findings of a clone's source (field fix r25-field-gclone, round 2; the lead, 2026-11-20). Where a provider's
 * clone takes selection keys (Google Search's ad_group_ids and languages), any other key of source is far more likely a typo of
 * one (ad_group_id) than a key to ignore, and ignoring it would copy the whole campaign without a word. Each such key draws one
 * entry in the form of meta.argument_warnings (src/first-party-contracts.ts, actionArgumentCheck), naming the key and the keys
 * the clone reads and never a value; the call is not refused, so a call that worked before still works. A provider that declares
 * no selection keys is as before: its unknown keys are ignored in silence. A key is text the caller chose, and it can be a token,
 * so it is named only when it is a plain name (a letter, then letters, digits and underscores, 64 characters at most) that holds
 * no run of 32 or more hex digits, as the codebase already masks such a run in an identifier it repeats (the lead's review,
 * 2026-11-20, S4-2); any other key is shown as `<a key>`. At most 20 keys are named.
 */
export function cloneSourceWarnings(input: JsonObject): JsonObject[] {
  if (input.action !== 'clone' || !obj(input.source)) return [];
  const clone = typeof input.gateway === 'string' ? providerHooks(input.gateway)?.campaign?.clone : undefined;
  if (!clone?.selection?.length) return [];
  const accepted = ['campaign_id', ...clone.selection];
  return Object.keys(input.source)
    .filter(key => !accepted.includes(key))
    .slice(0, 20)
    .map(key => {
      const shown = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !/[0-9a-fA-F]{32}/.test(key) ? key : '<a key>';
      return {
        code: 'ARGUMENT_NOT_USED_BY_ACTION',
        field: 'source.' + shown,
        message:
          'source.' +
          shown +
          ' is not a key this clone reads, so it is ignored. source takes ' +
          accepted.join(', ') +
          '.',
        accepted,
        help_call: {tool: 'amcp_campaign', arguments: {action: 'help', topic: 'clone'}},
      };
    });
}
export async function clonePlan(call: ToolCall, actor: Actor, input: JsonObject) {
  if (
    !obj(input.source) ||
    (typeof input.source.campaign_id !== 'string' && typeof input.source.campaign_id !== 'number')
  )
    throw new MirrorError('INVALID_ARGUMENT', 'Name the campaign to clone as source: {campaign_id}.', {
      field: 'source',
    });
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    throw new MirrorError('INVALID_ARGUMENT', 'Give the new campaign a name of 1–100 characters.', {field: 'name'});
  // The gateway's provider builds the steps (its adapter's `campaign.clone`); a gateway without one is refused.
  const clone = cloneGateways.includes(input.gateway) ? providerHooks(input.gateway)?.campaign?.clone : undefined;
  if (clone) assertSourceSelection(input.source, clone);
  const cloned = clone ? await clone.build(call, actor, input) : undefined;
  if (!cloned) return assertCloneGateway(input.gateway) as never;
  // Steps whose uncopied fields are the same are listed once.
  const groups = new Map<string, JsonObject>();
  for (const n of cloned.notCopied) {
    const key = JSON.stringify(n.fields);
    const g = groups.get(key) ?? {fields: n.fields, steps: []};
    g.steps.push(n.entity);
    groups.set(key, g);
  }
  return {...cloned, notCopied: [...groups.values()]};
}
const isRef = (v: unknown) => obj(v) && Object.hasOwn(v, '$ref');
/**
 * The spec's changes. set: [{step_id, path, value}] sets one field of a step's arguments, by JSON pointer, including
 * a field the source did not have (such as placement_v2) when its parent exists; never the action or a $ref.
 * drop: [step_id] leaves a step out, with every step that depends on it. Nothing here is sent anywhere: each step
 * is still reviewed with every check before it is written.
 */
export function applyCloneChanges(steps: Step[], changes: unknown) {
  if (changes === undefined) return {steps, set: [] as JsonObject[], dropped: [] as string[]};
  if (!obj(changes) || Object.keys(changes).some(k => !['set', 'drop'].includes(k)))
    bad('changes is {set: [{step_id, path, value}], drop: [step_id]}.', 'INVALID_ARGUMENT', {field: 'changes'});
  const ids = steps.map(s => s.id as string),
    drop: unknown = changes.drop ?? [];
  if (!Array.isArray(drop) || drop.some(d => !ids.includes(d)))
    bad('changes.drop lists step IDs of this clone.', 'INVALID_ARGUMENT', {field: 'changes.drop', allowed: ids});
  const gone = new Set<string>(drop as string[]);
  // Steps are in dependency order, so one pass reaches every dependant.
  for (const s of steps) if ((s.depends_on as string[]).some(d => gone.has(d))) gone.add(s.id);
  const kept = steps.filter(s => !gone.has(s.id));
  if (!kept.length) bad('changes.drop leaves nothing to create.', 'INVALID_ARGUMENT', {field: 'changes.drop'});
  const set: unknown = changes.set ?? [];
  if (!Array.isArray(set) || set.length > 50)
    bad('changes.set is a list of at most 50 {step_id, path, value}.', 'INVALID_ARGUMENT', {field: 'changes.set'});
  const applied = (set as unknown[]).map((c, i) => {
    const where = 'changes.set[' + i + ']';
    if (!obj(c) || Object.keys(c).sort().join() !== 'path,step_id,value')
      bad(where + ' must be exactly {step_id, path, value}.', 'INVALID_ARGUMENT', {field: where});
    const step = kept.find(s => s.id === c.step_id);
    if (!step)
      bad(where + '.step_id ' + JSON.stringify(c.step_id) + ' is not a step of this clone.', 'INVALID_ARGUMENT', {
        field: where + '.step_id',
        allowed: kept.map(s => s.id),
      });
    const keys =
      typeof c.path === 'string' && /^(\/[^/]+)+$/.test(c.path)
        ? c.path
            .slice(1)
            .split('/')
            .map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
        : [];
    if (!keys.length || keys[0] === 'action' || keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)))
      bad(
        where +
          '.path must be a JSON pointer into the step’s arguments other than its action, such as "/payload/operations/0/create/amount_micros".',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    if (JSON.stringify(c.value ?? null).includes('"$ref"'))
      bad(where + '.value contains a $ref. Dependencies stay as the clone declares them.', 'INVALID_ARGUMENT', {
        field: where + '.value',
      });
    let parent: any = step.arguments;
    for (const k of keys.slice(0, -1)) {
      if (isRef(parent)) break;
      parent = Array.isArray(parent) ? (/^(0|[1-9][0-9]*)$/.test(k) ? parent[Number(k)] : undefined) : parent?.[k];
    }
    const last = keys.at(-1)!;
    if (isRef(parent) || JSON.stringify(parent?.[last] ?? null).includes('"$ref"'))
      bad(
        where + '.path ' + c.path + ' is, or holds, a $ref to a predecessor’s verified result; it cannot be set.',
        'INVALID_ARGUMENT',
        {
          field: where + '.path',
        },
      );
    const fits = Array.isArray(parent) ? /^(0|[1-9][0-9]*)$/.test(last) && Number(last) < parent.length : obj(parent);
    if (!fits)
      bad(
        where +
          '.path ' +
          c.path +
          ' does not lead into step ' +
          JSON.stringify(step.id) +
          '’s arguments: its parent must exist.',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    const added = !Array.isArray(parent) && !Object.hasOwn(parent, last);
    parent[last] = structuredClone(c.value);
    return {step_id: step.id, path: c.path, ...(added ? {added: true} : {})};
  });
  return {steps: kept, set: applied, dropped: steps.filter(s => gone.has(s.id)).map(s => s.id as string)};
}
