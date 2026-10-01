import {bad, fingerprint, noSecrets, obj, pointer, validate} from './workspace-core.js';
import type {JsonObject} from './types.js';

/** Templates are deterministic substitution, never executable code or an authorization grant. */
export function expandTemplate(value: any, variables: JsonObject): any {
  if (typeof value === 'string')
    return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, key) => {
      const found = pointer(variables, '/' + key.split('.').join('/'));
      if (typeof found !== 'string' && typeof found !== 'number') bad('Template variables must be scalar.');
      return String(found);
    });
  if (Array.isArray(value)) return value.map(v => expandTemplate(v, variables));
  return obj(value)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandTemplate(v, variables)]))
    : value;
}
export function validatePlaybook(p: JsonObject) {
  noSecrets(p);
  for (const key of ['utm', 'defaults', 'templates', 'variables', 'conversion_mappings'])
    if (p[key] !== undefined && !obj(p[key])) bad(key + ' must be a named object.', 'INVALID_PROFILE');
  if (p.naming !== undefined && typeof p.naming !== 'string' && !obj(p.naming))
    bad('Use a naming template or named templates.', 'INVALID_PROFILE');
  for (const [key, value] of Object.entries(p.utm ?? {}))
    if (
      !['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'].includes(key) ||
      typeof value !== 'string' ||
      value.length > 2048
    )
      bad('Use supported UTM names and string templates up to 2,048 characters.', 'INVALID_PROFILE');
  if (Object.keys(p.templates ?? {}).length > 50) bad('Keep at most 50 named campaign templates.', 'INVALID_PROFILE');
  for (const steps of Object.values(p.templates ?? {}))
    if (!Array.isArray(steps) || !steps.length || steps.length > 50 || steps.some(s => !obj(s)))
      bad('Each template needs 1–50 explicit campaign steps.', 'INVALID_PROFILE');
  if (
    p.defaults?.recipes !== undefined &&
    (!obj(p.defaults.recipes) || Object.values(p.defaults.recipes).some(v => !obj(v)))
  )
    bad('Recipe defaults are objects keyed by recipe ID.', 'INVALID_PROFILE');
}
export function previewPlaybook(profile: JsonObject, input: JsonObject): JsonObject {
  validate(input, ['variables', 'destination_url', 'template']);
  if (input.variables !== undefined && !obj(input.variables)) bad('Preview variables must be a named object.');
  const variables = {...(profile.variables ?? {}), ...(input.variables ?? {}), profile};
  noSecrets(variables);
  const resolved = expandTemplate({naming: profile.naming ?? '', utm: profile.utm ?? {}}, variables);
  let destination: string | null = null;
  if (input.destination_url) {
    let url: URL;
    try {
      url = new URL(input.destination_url);
    } catch {
      return bad('Use an absolute HTTPS landing page URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      bad('Use an HTTPS landing page without embedded credentials.');
    for (const [key, value] of Object.entries(resolved.utm)) if (value !== '') url.searchParams.set(key, String(value));
    destination = url.toString();
  }
  const steps = input.template ? profile.templates?.[input.template] : undefined;
  if (input.template && !steps) bad('Choose a saved template from this profile.');
  return {
    version: 1,
    profile: {id: profile.id ?? null, revision: profile.revision ?? null, name: profile.name},
    ...resolved,
    destination_url: destination,
    ...(steps ? {steps: expandTemplate(steps, variables)} : {}),
    bindings: profile.bindings ?? [],
    defaults: profile.defaults ?? {},
    conversion_mappings: profile.conversion_mappings ?? {},
    fingerprint: fingerprint({profile, variables, template: input.template ?? null, destination_url: destination}),
    network_requests: 0,
    meaning:
      'Preview only. Defaults are copied into a new draft; existing plans and schedules keep their recorded profile revision. Account bindings do not grant access.',
  };
}
