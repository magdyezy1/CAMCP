import type {JsonObject} from './types.js';
import {bad, obj} from './workspace-core.js';

/**
 * How a blocked or failed plan step is amended (Snapchat S2). In the owner's live test on 2026-09-29 preflight
 * blocked two ad squads for a pixel the account does not own and listed the owned pixels, but gave no way forward;
 * the agent cancelled and re-created the plan. recover_step could already replace a step's arguments. Now every
 * blocked step carries the recover_step call, and when the refusal names a field, the field, its current value and
 * the values allowed. AMCP never chooses among them: the operator does, and the placeholder is refused.
 */
export const choicePlaceholder = '<choose one of allowed_values>';
/** `/payload/adsquads/0/pixel_id` as `arguments.payload.adsquads[0].pixel_id`, the way a person reads it. */
export function fieldLabel(path: string): string {
  return (
    'arguments' +
    segments(path)
      .map(s => (/^(0|[1-9][0-9]*)$/.test(s) ? '[' + s + ']' : '.' + s))
      .join('')
  );
}
function segments(path: string): string[] {
  return path
    .slice(1)
    .split('/')
    .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
/** Every place in a step's arguments where `key` holds one of `values`. */
function locate(args: unknown, key: string, values: Set<unknown>, path = ''): {path: string; current: unknown}[] {
  if (Array.isArray(args)) return args.flatMap((v, i) => locate(v, key, values, path + '/' + i));
  if (!obj(args) || Object.hasOwn(args, '$ref')) return [];
  return Object.entries(args).flatMap(([k, v]) =>
    k === key && values.has(v)
      ? [{path: path + '/' + escape(k), current: v}]
      : locate(v, key, values, path + '/' + escape(k)),
  );
}
/** The fields a refusal names in this step, with the values the operator may choose from. */
export function choices(step: JsonObject, error: JsonObject | undefined): JsonObject[] {
  const d = error?.details ?? {};
  if (error?.code === 'SNAPCHAT_PIXEL_NOT_OWNED' && Array.isArray(d.pixel_ids) && Array.isArray(d.owned_pixel_ids))
    return locate(step.arguments, 'pixel_id', new Set(d.pixel_ids)).map(({path, current}) => ({
      path,
      field: fieldLabel(path),
      current,
      allowed_values: d.owned_pixel_ids,
    }));
  return [];
}
/**
 * The call that amends a blocked or failed step. With named fields, the operator's choice goes into a patch;
 * otherwise the step's arguments are sent back corrected (unchanged arguments are refused, so following this call
 * never returns the same refusal).
 */
export function amendmentCall(runId: string, step: JsonObject, error: JsonObject | undefined): JsonObject {
  const fields = choices(step, error),
    call = {tool: 'amcp_campaign', arguments: {action: 'recover_step', id: runId, step_id: step.id, confirmed: true}};
  return fields.length
    ? {
        ...call,
        add_after_user_choice: {patch: fields.map(f => ({path: f.path, value: choicePlaceholder}))},
        choose: fields,
      }
    : {
        ...call,
        add_after_correction: {arguments: step.arguments},
        correct: 'Change what the error names in these arguments; the step is reviewed again before anything is sent.',
      };
}
/** A patch entry refers to one existing field of this step's arguments and never to a dependency reference. */
export function applyPatch(step: JsonObject, patch: unknown): JsonObject[] {
  if (!Array.isArray(patch) || !patch.length || patch.length > 20)
    bad('patch must be a list of 1-20 {path, value} changes to this step’s arguments.', 'INVALID_ARGUMENT', {
      field: 'patch',
    });
  const changes: JsonObject[] = [];
  patch.forEach((p: unknown, i: number) => {
    const where = 'patch[' + i + ']';
    if (!obj(p) || Object.keys(p).sort().join() !== 'path,value')
      bad(where + ' must be exactly {path, value}.', 'INVALID_ARGUMENT', {field: where});
    if (typeof p.path !== 'string' || !/^(\/[^/]*)+$/.test(p.path))
      bad(
        where + '.path must be a JSON pointer into this step’s arguments, such as "/payload/name".',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    if (p.value === choicePlaceholder)
      bad(where + '.value is still the placeholder: choose one of allowed_values with the user.', 'INVALID_ARGUMENT', {
        field: where + '.value',
      });
    if (JSON.stringify(p.value ?? null).includes('"$ref"'))
      bad(
        where + '.value contains a $ref. A patch sets a value; dependencies stay as the plan declared them.',
        'INVALID_ARGUMENT',
        {field: where + '.value'},
      );
    const keys = segments(p.path);
    let parent: any = step.arguments;
    for (const key of keys.slice(0, -1)) {
      if (obj(parent) && Object.hasOwn(parent, '$ref')) break;
      parent = Array.isArray(parent)
        ? /^(0|[1-9][0-9]*)$/.test(key)
          ? parent[Number(key)]
          : undefined
        : parent?.[key];
    }
    const last = keys.at(-1)!,
      exists =
        (Array.isArray(parent) && /^(0|[1-9][0-9]*)$/.test(last) && Number(last) < parent.length) ||
        (obj(parent) && !Object.hasOwn(parent, '$ref') && Object.hasOwn(parent, last));
    if (!exists)
      bad(
        where +
          '.path ' +
          p.path +
          ' is not in step ' +
          JSON.stringify(step.id) +
          '’s arguments. A patch changes a field the step already has; to add or restructure fields, send arguments.',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    if (obj(parent[last]) && Object.hasOwn(parent[last], '$ref'))
      bad(
        where + '.path ' + p.path + ' is a $ref to a predecessor’s verified result; a patch cannot replace it.',
        'INVALID_ARGUMENT',
        {field: where + '.path'},
      );
    changes.push({path: p.path, from: structuredClone(parent[last]), to: structuredClone(p.value)});
    parent[last] = structuredClone(p.value);
  });
  return changes;
}
