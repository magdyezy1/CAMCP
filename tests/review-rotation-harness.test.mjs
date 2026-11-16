import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {familyFixture, baseline} from './helpers/family-conformance.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {accountPlan} from '../dist/src/account-metadata.js';
import {reviewVolatile} from '../dist/src/review-state.js';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1 item 5, L5-03, L1 O1): the rotation harness. The review check failed twice for
 * a field that changes by itself (the Google meter, the TikTok advertiser row) because no test ever varied it; the fixtures
 * of the conformance descriptors are static. Here every family descriptor (tests/family-descriptors/*, and the variants of
 * a family that serve a second request shape) is driven through the real review lifecycle with a provider whose answer to
 * every ACCOUNT or PARENT read rotates at each read, in the three ways of the White Friday report: a signed URL whose ticket
 * and expiry change, a balance that falls, and a bumped timestamp (named as the provider names its own). Then:
 *   - prepare and execute must pass with no STATE_CHANGED (0 on rotation);
 *   - a real change of the family's decisive field, with the rotation still going on, must still be STATE_CHANGED (or the
 *     family's own refusal of it), naming that field and none of the rotating ones (a material change always refuses).
 * Which reads are the account's and the parents' is read from the review itself: each read a create makes of its account
 * or its parent carries its role (CompiledRequest.stateRole), and the account of a provider is its account read
 * (src/account-metadata.ts accountPlan). A family that keeps its own state (X's creatives) names its parent reads below.
 *
 * The coverage is 100% of the descriptors: each is rotated, or is listed with why it is not. A new descriptor with no
 * account or parent read, or a provider that relies on narrowing the request, must be added to those lists, with a reason.
 * Nothing leaves the process; every value is synthetic.
 */
offerParkedProviders('criteo');

const directory = path.resolve('tests/family-descriptors'),
  descriptors = [];
for (const file of fs
  .readdirSync(directory)
  .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
  .sort())
  descriptors.push({file, ...(await import(pathToFileURL(path.join(directory, file)).href)).default});
for (const file of fs
  .readdirSync(path.join(directory, 'variants'))
  .filter(n => n.endsWith('.mjs'))
  .sort())
  descriptors.push({
    file: 'variants/' + file,
    variant: file.replace(/\.mjs$/, ''),
    ...(await import(pathToFileURL(path.join(directory, 'variants', file)).href)).default,
  });
const name = d => d.family + (d.variant ? ' (variant ' + d.variant + ')' : '');

// Providers whose account read is narrowed at the source, so the answer to it cannot carry what rotates: Meta asks for
// `fields=id,account_status,currency`, Google for the SELECT of customer.id, currency and time zone (a request that names
// what it wants; the lint of tests/review-meta-volatile-lint.test.mjs holds Meta to it). Their account reads are exempt.
const narrowedAtSource = {
  meta_native_action:
    'the account read asks for fields=id,account_status,currency, so rotating fields are not in the answer',
  google_ads_native_action:
    'the account read is a GAQL SELECT of customer.id, currency and time zone, so rotating fields are not in the answer',
};
// A family that keeps its own state reads its parents itself, with no stored read to carry a role: its parent reads.
const ownParentReads = {
  x_creatives: [/\/line_items\/line1$/, /\/campaigns\/campaign1$/],
};
// FOUND, NOT FIXED (r25-m1-hash): the families below read their provider's account and hash the whole row, so a balance
// that falls between review and execute refuses them. Microsoft's and Reddit's are outside the four providers whose account
// and parent reads M1 keeps to identity (TikTok, X, LinkedIn, DV360); keeping an account to its identity needs that
// provider's own account fields from its documentation, which this package did not have and did not guess (a field named
// wrong would drop real identity from the review). Each is held to the gap: it must still fail by that field, so one that
// gets fixed must leave this list, and a family of the four providers may never be on it. The list only shrinks.
const notYetRotationSafe = {
  microsoft_asset_links: 'the Account/Query answer is kept whole in its state',
  microsoft_location_targets: 'the Account/Query answer is kept whole in its state',
  microsoft_search: 'the Account/Query answer is kept whole in its state',
  reddit_classic: 'the ad_accounts answer is kept whole in its state',
  reddit_creatives: 'the ad_accounts answer is kept whole in its state',
};

/**
 * What changes at every read, by the role of the read: a signed URL and a bumped timestamp (under a name the provider's table
 * holds) for any, and a falling balance for the account only. A parent carries no balance: it is a campaign, an ad group or a
 * line item, and every field a parent has besides those two is a setting that only an edit changes (S2-1), so it stays still.
 * The signed URL is a link of the provider's: on a host its table declares as its own (S2-2). A provider that declares none
 * signs no link in a state a review keeps, and a link elsewhere is an advertiser's (a landing page), which is configuration.
 */
const stamp = gateway => reviewVolatile(gateway).find(n => /(?:_at|_time)$/.test(n)) ?? 'updated_at';
const linkHost = gateway => {
  const entry = reviewVolatile(gateway).find(n => n.startsWith('signed-host:'));
  return entry?.slice('signed-host:'.length).replace(/^\*\./, 'p16.');
};
const rotation = (gateway, n, role) => ({
  ...(linkHost(gateway)
    ? {
        license_url:
          'https://' +
          linkHost(gateway) +
          '/licence?ticket=t' +
          n +
          '&x-expires=' +
          (1700000000 + n) +
          '&x-signature=s' +
          n,
      }
    : {}),
  ...(role === 'account' ? {balance: 1000 - n * 3.25} : {}),
  [stamp(gateway)]: 1700000000 + n,
});
// The objects of an answer that describe the request or the page, not a record: a family refuses an envelope it does not know.
const envelope = new Set(['request', 'paging', 'metadata', 'page_info', 'pagination', 'params', 'links', 'errors']);
/** `json` with the rotation of `role` in every record of its first three levels (a record is a plain object; an envelope is not). */
function rotate(json, gateway, n, role, depth = 0, key = '') {
  if (Array.isArray(json)) return json.map(item => rotate(item, gateway, n, role, depth, key));
  if (!json || typeof json !== 'object' || envelope.has(key)) return json;
  const out = Object.fromEntries(
    Object.entries(json).map(([k, v]) => [k, depth < 3 ? rotate(v, gateway, n, role, depth + 1, k) : v]),
  );
  // A wrapper holds only objects (X's {data, request}); the record inside it is what rotates.
  const wrapper = Object.values(json).every(v => v && typeof v === 'object');
  return depth < 3 && !wrapper ? {...rotation(gateway, n, role), ...out} : out;
}
const rotatingKeys = gateway => Object.keys(rotation(gateway, 0, 'account'));

/** The descriptor with a provider whose answer to each read `roleOf` names ("METHOD path": its role) rotates at every read. */
function rotating(d, roleOf) {
  let n = 0;
  return {
    ...d,
    provider: async request => {
      const answer = await d.provider(request),
        role = roleOf(request);
      if (!answer || answer instanceof Response || !role) return answer;
      return {...answer, json: rotate(answer.json, d.gateway, ++n, role)};
    },
  };
}

/** Which of the descriptor's reads are its account's or a parent's: from the review its prepare stored. */
async function classify(d) {
  const f = familyFixture(d),
    seen = [];
  try {
    const prepared = await f.prepare();
    assert.equal(
      prepared.success,
      true,
      name(d) + ' prepares: ' + JSON.stringify(prepared.error ?? prepared).slice(0, 500),
    );
    const review = f.store.document('conformance-' + d.family, 'write_review', prepared.data.review_id);
    let account;
    try {
      account = accountPlan(d.gateway, d.account);
    } catch {
      // A provider with no account read of its own (the resource-specific readiness providers).
    }
    for (const read of review.reads ?? []) {
      const role =
        read.stateRole ??
        (account && read.method === account.method && read.path === account.path ? 'account' : undefined);
      if (role) seen.push({method: read.method, path: read.path, role});
    }
    return seen;
  } finally {
    f.close();
  }
}

const coverage = {rotated: [], narrowed: [], none: [], notYet: []};
for (const d of descriptors) {
  test(name(d) + ': a rotating account or parent read is no change, and a real change still is', async t => {
    const reads = await classify(d),
      own = ownParentReads[d.family] ?? [];
    // The role of the read a request makes: the stored review's, or the parent a family that keeps its own state names.
    const matches = request =>
      reads.find(r => r.method === request.method && r.path === request.path)?.role ??
      (request.method === 'GET' && own.some(re => re.test(request.path)) ? 'parent' : undefined);
    const exempt = narrowedAtSource[d.gateway] !== undefined && reads.every(r => r.role === 'account');
    if (!reads.length && !own.length) {
      coverage.none.push(name(d));
      return t.diagnostic?.('no account or parent read: reads only its target and what the write names');
    }
    if (exempt) {
      coverage.narrowed.push(name(d));
      return;
    }
    if (notYetRotationSafe[d.family] !== undefined) {
      coverage.notYet.push(name(d));
      assert.ok(
        !/^(?:tiktok|x|linkedin|dv360)_/.test(d.family),
        name(d) + ' is of a provider whose reads M1 keeps to identity',
      );
      // Held to the gap: rotation still refuses it, by the balance and by nothing else.
      const f = familyFixture(rotating(d, matches));
      try {
        const prepared = await f.prepare();
        assert.equal(prepared.success, true, name(d) + ' prepares');
        const refused = await f.execute(prepared.data);
        assertRefused(refused, 'STATE_CHANGED', {writes: f.sent.length});
        assert.ok(
          (refused.error.details?.changed_fields ?? []).every(p => p.includes('"balance"')),
          name(d) +
            ': ' +
            JSON.stringify(refused.error.details?.changed_fields) +
            ' is more than the balance: update the list',
        );
      } finally {
        f.close();
      }
      return;
    }
    coverage.rotated.push(name(d));
    // Prepare, then execute, with every read of an account or a parent rotating: no STATE_CHANGED (the baseline sends once).
    await baseline(rotating(d, matches));
    // A real change of the decisive field, with the rotation going on: refused, naming it and none of the rotating fields.
    const f = familyFixture(rotating(d, matches));
    try {
      const prepared = await f.prepare();
      assert.equal(prepared.success, true, name(d) + ' prepares');
      d.decisive.change(f.state);
      const refused = await f.execute(prepared.data);
      if (d.decisive.refusal) {
        assertRefused(refused, d.decisive.refusal.code, {writes: f.sent.length});
        return;
      }
      assertRefused(refused, 'STATE_CHANGED', {writes: f.sent.length});
      const changed = refused.error.details?.changed_fields ?? [];
      assert.ok(
        changed.some(p => d.decisive.field.test(p)),
        name(d) + ': ' + JSON.stringify(changed) + ' names ' + d.decisive.field,
      );
      for (const key of rotatingKeys(d.gateway))
        assert.equal(
          changed.some(p => p.includes('"' + key + '"')),
          false,
          name(d) + ': the rotating field ' + key + ' is named in ' + JSON.stringify(changed),
        );
    } finally {
      f.close();
    }
  });
}

test('coverage: every family descriptor is rotated or listed with why it is not (100%)', t => {
  const all = [...coverage.rotated, ...coverage.narrowed, ...coverage.none, ...coverage.notYet];
  assert.equal(all.length, descriptors.length, 'every descriptor ran its check');
  assert.deepEqual(all.sort(), descriptors.map(name).sort(), 'no descriptor is counted twice or missing');
  assert.deepEqual(
    coverage.notYet.map(n => n.replace(/ \(variant.*$/, '')).sort(),
    Object.keys(notYetRotationSafe).sort(),
  );
  t.diagnostic(
    'rotation coverage: ' +
      descriptors.length +
      ' descriptors; rotated ' +
      coverage.rotated.length +
      ', narrowed at the source ' +
      coverage.narrowed.length +
      ', no account or parent read ' +
      coverage.none.length +
      ', held to a documented gap ' +
      coverage.notYet.length,
  );
  // The rotation is exercised where it can be: at least the families of the four providers of M1 that read an account or a
  // parent (the count is what the harness found at its head; a family that loses its role falls out of it and fails here).
  const four = coverage.rotated.filter(n => /^(?:tiktok|x|linkedin|dv360)_/.test(n));
  assert.ok(four.length >= 48, 'rotated families of TikTok, X, LinkedIn and DV360: ' + four.length);
});
