/** Existing creative dependencies of a Snapchat ad create or creative replacement. */
import type {CompiledRequest, JsonObject} from './types.js';
import {object, fail} from './write-common.js';

export function snapAdCreativePaths(plan: CompiledRequest): string[] {
  if (plan.gateway !== 'snapchat_native_action') return [];
  const create = plan.method === 'POST' && /^\/v1\/adsquads\/[^/]+\/ads$/.test(plan.path);
  const update = plan.method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/ads$/.test(plan.path);
  const patch = plan.method === 'PATCH' && /^\/v1\/adaccounts\/[^/]+\/ads\/[^/]+$/.test(plan.path);
  if (!create && !update && !patch) return [];
  const ids: unknown[] = [];
  if (patch) {
    if (!Array.isArray(plan.body)) fail('INVALID_PATCH', 'Use native JSON Patch operations.');
    for (const op of plan.body) {
      if (op?.path !== '/creative_id' || op.op === 'test') continue;
      if (!['add', 'replace'].includes(op.op))
        fail('INVALID_PATCH', 'An ad creative replacement requires an exact existing creative_id.');
      ids.push(op.value);
    }
  } else {
    const rows = object(plan.body).ads;
    if (!Array.isArray(rows) || !rows.length || rows.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native ad records.');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        fail('INVALID_ARGUMENT', 'Each ad must be a native object.');
      if (create || Object.hasOwn(row, 'creative_id')) ids.push(row.creative_id);
    }
  }
  for (const id of ids)
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(id))
      fail('INVALID_PARAMETER', 'Each ad creative reference must be an exact existing Snapchat creative ID.');
  return [...new Set(ids as string[])].map(id => '/v1/creatives/' + id);
}

/** Only an already-required ad creative read may name an attached form; it does not establish form ownership. */
export function snapAdLeadFormFollowUps(
  plan: CompiledRequest,
  read: CompiledRequest,
  data: unknown,
): CompiledRequest[] {
  if (!snapAdCreativePaths(plan).includes(read.path)) return [];
  const creative = object(data).creatives?.[0]?.creative ?? object(data).creatives?.[0];
  if (creative?.type !== 'LEAD_GENERATION') return [];
  const id = creative.lead_generation_form_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id))
    fail('CAMPAIGN_PREREQUISITE_REQUIRED', 'An existing Snapchat lead creative must name its exact lead form.');
  return [{...read, path: '/v1/lead_generation_forms/' + id, query: {}}];
}

/** A website ad's reused creative must still have the website shape at its actual native review. */
export function snapAdCreativePrerequisites(plan: CompiledRequest, state: unknown[]): void {
  if (!snapAdCreativePaths(plan).length) return;
  const records = state.flatMap(value => object(value).creatives ?? []).map((row: JsonObject) => row.creative ?? row),
    forms = state
      .flatMap(value => object(value).lead_generation_forms ?? [])
      .map((row: JsonObject) => row.lead_generation_form ?? row),
    ads = state.flatMap(value => object(value).ads ?? []).map((row: JsonObject) => row.ad ?? row);
  const changes =
    plan.method === 'PATCH'
      ? (plan.body as JsonObject[])
          .filter(op => op.path === '/creative_id' && ['add', 'replace'].includes(op.op))
          .map(op => ({
            creative_id: op.value,
            type:
              (plan.body as JsonObject[]).findLast(p => p.path === '/type' && ['add', 'replace'].includes(p.op))
                ?.value ?? ads[0]?.type,
          }))
      : object(plan.body).ads;
  for (const ad of changes) {
    if (ad.creative_id === undefined) continue;
    const type = ad.type ?? ads.find((before: JsonObject) => before.id === ad.id)?.type;
    const creative = records.find((row: JsonObject) => row.id === ad.creative_id);
    if (type === 'LEAD_GENERATION') {
      if (creative?.type !== 'LEAD_GENERATION')
        fail('CAMPAIGN_PREREQUISITE_REQUIRED', 'A Snapchat lead ad requires an existing LEAD_GENERATION creative.');
      const form = forms.find((row: JsonObject) => row.id === creative.lead_generation_form_id);
      if (!form || form.ad_account_id !== plan.accountId)
        fail(
          'CAMPAIGN_PREREQUISITE_REQUIRED',
          'Inspect the exact account-owned form attached to the existing Snapchat lead creative.',
        );
      if (!Array.isArray(form.form_fields) || !form.form_fields.length)
        fail('INCOMPLETE_STATE', 'The existing lead form must return its question definition for review.');
      continue;
    }
    if (type !== 'REMOTE_WEBPAGE') continue;
    if (creative?.type !== 'WEB_VIEW')
      fail('CAMPAIGN_PREREQUISITE_REQUIRED', 'A Snapchat website ad requires an existing WEB_VIEW creative.');
    try {
      const url = new URL(creative.web_view_properties?.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid destination');
    } catch {
      fail(
        'DESTINATION_REQUIRED',
        'Inspect an existing website creative with a full HTTPS destination without credentials.',
      );
    }
  }
}
