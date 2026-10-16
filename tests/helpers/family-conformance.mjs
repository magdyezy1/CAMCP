// Behavioral conformance of reviewed write families (QA-02). A descriptor (tests/family-descriptors/*.mjs) states one
// valid request of a family, a synthetic provider that holds the target's state, and the decisive field: the field of
// the target that the write overwrites or depends on, chosen from the provider's documented resource, not from the
// family's projection code. The runner drives the real review lifecycle (MirrorService, NativeTransport, the store)
// against that provider and proves, for every described family:
//   - the request reviews and executes once (the baseline the other checks are measured against);
//   - a change of the decisive field between review and execute is refused as STATE_CHANGED naming that field (or,
//     where a family prerequisite forbids the changed value, such as a status transition or a resource now in use, by
//     the family's own refusal naming it), with nothing sent;
//   - a state read the provider answers with another page is refused before review, with nothing sent;
//   - a partial or failed provider answer is never reported as success and is never sent again.
// Nothing leaves the process: the provider is a function of the descriptor's own synthetic state.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {saveSpendPolicy} from '../../dist/src/spend-policy.js';
import {assertRefused} from './assert-refused.mjs';

const key = Buffer.alloc(32, 97).toString('base64'),
  registry = new Registry();
/**
 * The descriptor's fields:
 *   family, gateway, account                  the ledger family name, its gateway and the synthetic account
 *   request                                   amcp_write prepare `arguments` without account_id
 *   seed()                                    a fresh synthetic provider state
 *   provider({method, url, path, body, state, mode})
 *                                             answers one request from `state`; `mode.paginate` asks state reads
 *                                             for another page, `mode.partial` asks the write for a partial or
 *                                             failed answer, `mode.uncertain` (with uncertainCodes) for an
 *                                             uncertain one (a 5xx); returns {json, status?} or a Response
 *   isWrite({method, path})                   true for the provider mutation the request sends
 *   decisive: {change(state), field: RegExp}  the change between review and execute, and the changed_fields path
 *   decisive.refusal: {code, message: RegExp} optional: where a family prerequisite forbids the changed value (a
 *                                             status transition, a resource a live campaign now uses), the family's
 *                                             own refusal of it, raised while the state is read again at execute
 *                                             (before the comparison); its message names the changed value
 *   connection, credentials, policy, spendPolicy, execute, owned, role
 *                                             optional overrides of the synthetic login, the deployment policy, the
 *                                             owner's spending policy for the account, execute's extra fields, the
 *                                             resource IDs the account already showed AMCP, and 'admin' for a family
 *                                             whose writes need an administrator
 *   prepareFields                             optional: amcp_write prepare fields beside `arguments` (people and
 *                                             personal_data for a family that sends data about people)
 *   paginatedCodes, partialCodes              optional: the refusal codes a family names for those cases
 *   uncertainCodes                            optional: the codes of the first answer to an uncertain write
 *                                             (`mode.uncertain`); its replay must be WRITE_OUTCOME_UNCERTAIN
 *   prime({call, connectionId})               optional: reads a caller makes before preparing (discovery)
 *   setup({store, owner, actor, login})       optional: anything else the account already holds
 */
export function familyFixture(d) {
  const store = new Store(':memory:', key),
    actor = {tenantId: 'conformance-' + d.family, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    connectionId =
      '0f0f0f0f-0f0f-4f0f-8f0f-' +
      String(Math.abs(hash(d.family)))
        .padStart(12, '0')
        .slice(0, 12);
  store.putConnection(
    owner,
    {
      id: connectionId,
      tenantId: actor.tenantId,
      gateway: d.gateway,
      accounts: [d.account],
      writeAccounts: [d.account],
      enabled: true,
      label: 'Synthetic ' + d.family,
      scopes: [],
      ...d.connection,
    },
    d.credentials ?? {accessToken: 'synthetic'},
  );
  const state = d.seed(),
    mode = {paginate: false, partial: false, uncertain: false},
    sent = [],
    requests = [];
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = (init.method ?? 'GET').toUpperCase(),
      body = parseBody(init.body),
      request = {method, url, path: url.pathname, body, state, mode};
    requests.push(method + ' ' + url.pathname);
    if (d.isWrite(request)) sent.push(request);
    const answer = await d.provider(request);
    if (answer instanceof Response) return answer;
    if (!answer) throw new Error('Unexpected synthetic ' + d.family + ' request: ' + method + ' ' + url.pathname);
    return Response.json(answer.json, {status: answer.status ?? 200});
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
    ...d.policy,
  });
  if (d.spendPolicy)
    saveSpendPolicy(store, owner, {gateway: d.gateway, account_id: d.account, confirmed: true, policy: d.spendPolicy});
  // Resources the account already showed AMCP (ownership a family's writes rely on), as an earlier read records it.
  const login = {id: connectionId, tenantId: actor.tenantId, gateway: d.gateway};
  for (const id of d.owned ?? []) store.rememberResource(login, d.account, id);
  d.setup?.({store, owner, actor, login});
  const call = (tool, input) => service.call(tool, input, d.role === 'admin' ? owner : actor);
  // Reads a caller makes before preparing (a discovery that records which objects the account owns).
  let primed;
  const prime = () => (primed ??= Promise.resolve(d.prime?.({call, connectionId})));
  const prepare = async () => (
    await prime(),
    call('amcp_write', {
      action: 'prepare',
      gateway: d.gateway,
      connection_id: connectionId,
      // A delegated operation (Criteo, Business Profile) nests its own arguments: the descriptor gives them whole.
      arguments: structuredClone(d.arguments ?? {account_id: d.account, ...d.request}),
      // Fields a review takes beside its arguments (the people and the personal-data confirmations of an upload).
      ...structuredClone(d.prepareFields ?? {}),
    })
  );
  const execute = review =>
    call('amcp_write', {
      action: 'execute',
      review_id: review.review_id,
      idempotency_key: review.idempotency_key ?? review.review_id,
      confirmed: true,
      spend_change_confirmed: true,
      ...d.execute,
    });
  return {store, state, mode, sent, requests, prepare, execute, close: () => store.close()};
}
/** A JSON body as an object, a form body as its fields, any other body as text. */
function parseBody(body) {
  if (typeof body !== 'string' || !body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(body) ? Object.fromEntries(new URLSearchParams(body)) : body;
  }
}
function hash(text) {
  let h = 7;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
const prepared = async f => {
  const p = await f.prepare();
  assert.equal(p.success, true, 'the descriptor request reviews: ' + JSON.stringify(p.error ?? p).slice(0, 600));
  assert.equal(f.sent.length, 0, 'prepare sends nothing');
  return p.data;
};

/** The request reviews and executes once; a replay sends nothing again. */
export async function baseline(d) {
  const f = familyFixture(d);
  try {
    const review = await prepared(f);
    const done = await f.execute(review);
    assert.equal(done.success, true, 'the reviewed request executes: ' + JSON.stringify(done).slice(0, 600));
    assert.equal(f.sent.length, 1);
    const replay = await f.execute(review);
    assert.equal(replay.data?.replayed, true, JSON.stringify(replay).slice(0, 400));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
}
/** A change of the decisive field between review and execute is STATE_CHANGED naming it, and nothing is sent. */
export async function decisiveChange(d) {
  const f = familyFixture(d);
  try {
    const review = await prepared(f);
    d.decisive.change(f.state);
    const refused = await f.execute(review);
    if (d.decisive.refusal) {
      // The family's prerequisite refuses the changed value as the state is read again, before the comparison.
      assertRefused(refused, d.decisive.refusal.code, {writes: f.sent.length});
      assert.match(refused.error.message, d.decisive.refusal.message, 'the refusal names the changed value');
      return;
    }
    assertRefused(refused, 'STATE_CHANGED', {writes: f.sent.length});
    const changed = refused.error.details?.changed_fields ?? [];
    assert.ok(
      changed.some(path => d.decisive.field.test(path)),
      'changed_fields ' + JSON.stringify(changed) + ' names the decisive field ' + d.decisive.field,
    );
  } finally {
    f.close();
  }
}
/** A state read answered with another page is refused before review; nothing is sent. */
export async function paginatedSnapshot(d) {
  const f = familyFixture(d);
  try {
    f.mode.paginate = true;
    assertRefused(await f.prepare(), d.paginatedCodes ?? ['INCOMPLETE_STATE'], {writes: f.sent.length});
  } finally {
    f.close();
  }
}
/** A partial or failed answer is never success, and executing the review again sends nothing more. */
export async function partialOutcome(d) {
  const f = familyFixture(d);
  try {
    const review = await prepared(f);
    f.mode.partial = true;
    // A provider-reported failure (PLATFORM_ERROR), a partial or unconfirmed answer, or an uncertain one.
    const codes = d.partialCodes ?? ['WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN', 'PLATFORM_ERROR'];
    const failed = out =>
      out.success === false
        ? assertRefused(out, codes)
        : assert.ok(
            out.data?.success === false && out.data?.outcome !== 'succeeded',
            'a partial answer is not success: ' + JSON.stringify(out).slice(0, 600),
          );
    failed(await f.execute(review));
    assert.equal(f.sent.length, 1);
    failed(await f.execute(review));
    assert.equal(f.sent.length, 1, 'never sent again');
  } finally {
    f.close();
  }
  if (d.uncertainCodes) await uncertainOutcome(d);
}
/**
 * An uncertain answer (a 5xx: the write may have applied) where a resend would do harm: never success, never marked
 * safe to retry, and executing the review again is WRITE_OUTCOME_UNCERTAIN without a second request.
 */
async function uncertainOutcome(d) {
  const f = familyFixture(d);
  try {
    const review = await prepared(f);
    f.mode.uncertain = true;
    const first = await f.execute(review);
    assertRefused(first, d.uncertainCodes);
    assert.notEqual(first.error?.remedy?.mutation_retry_safe, true, 'an uncertain write is never safe to retry');
    assert.equal(f.sent.length, 1);
    assertRefused(await f.execute(review), ['WRITE_OUTCOME_UNCERTAIN']);
    assert.equal(f.sent.length, 1, 'an uncertain write is never sent again');
  } finally {
    f.close();
  }
}
export const conformanceChecks = {baseline, decisiveChange, paginatedSnapshot, partialOutcome};
