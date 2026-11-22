// always-run: lists the family descriptors for the review rotation
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {familyFixture, baseline} from './helpers/family-conformance.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {accountPlan} from '../dist/src/account-metadata.js';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1 item 5, L5-03, L1 O1; lead review S3-5): the rotation harness. The review check
 * failed twice for a field that changes by itself (the Google meter, the TikTok advertiser row) because no test ever varied it;
 * the fixtures of the conformance descriptors are static. Here every family descriptor (tests/family-descriptors/*, and the
 * variants of a family that serve a second request shape) is driven through the real review lifecycle with a provider whose
 * answer to every ACCOUNT, PARENT or REFERENCE read rotates at each read, and then:
 *   - prepare and execute must pass with no STATE_CHANGED (0 on rotation);
 *   - a real change of the family's decisive field, with the rotation still going on, must still be STATE_CHANGED (or the
 *     family's own refusal of it), naming that field and none of the rotating ones (a material change always refuses).
 *
 * What rotates is not taken from the code under test. `documented` below is what each provider's own documentation shows
 * changing by itself in an account, a parent and a reference row (the vendor documents in .mirror/VENDOR and the APIs'
 * references), written by hand: a name that the code's table for that provider fails to drop fails the harness, and a table
 * cannot hide a name from it by leaving it out.
 *
 * Which reads are the account's, the parents' and the references' is not taken from the role the code stamps either (a read
 * nobody marked would be invisible). An account is the provider's own account read (src/account-metadata.ts accountPlan) or a
 * read stamped `account`; a parent or a reference is a read the code stamps with that role, or one that `parentReads` and
 * `referenceReads` name from the provider's own object hierarchy (a campaign holds ad groups, an ad group holds ads, a line item
 * holds promotions). The coverage is reported by READ: how many account, parent and reference reads were rotated, how many of
 * the parents and references carry no role (a count of its own, pinned, that only shrinks), and which descriptors rotate
 * nothing and why (the provider narrows its request, or the write reads only what it changes).
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

// ---- Provider facts: written by hand, not read back from the code under test ----------------------------------------------

// Providers whose state reads are narrowed at the source, so the answer to them cannot carry what rotates: Meta asks for
// `fields=`, Google for a GAQL SELECT of named fields (a request that names what it wants; the lint of
// tests/review-meta-volatile-lint.test.mjs holds Meta to it). Every role read of these providers is exempt.
const narrowedAtSource = {
  meta_native_action: 'state reads ask for named fields (fields=...), so rotating fields are not in the answer',
  google_ads_native_action: 'state reads are a GAQL SELECT of named fields, so rotating fields are not in the answer',
};
const when = n => '2026-11-16T10:0' + (n % 10) + ':00Z';
/**
 * What each provider's documentation shows changing by itself, by the kind of row, as a function of the number of the read.
 * TikTok: the advertiser row carries a balance that moves with spend and a signed licence link; campaign and ad group rows a
 * `modify_time` and a computed `secondary_status`. X: `updated_at`, and a line item's and campaign's computed `servable`,
 * `reasons_not_servable` and `effective_status`. LinkedIn: audit stamps, a version tag and the derived serving state. DV360:
 * `updateTime`. Snapchat: `updated_at` and `delivery_status`. Microsoft's AdvertiserAccount: a row version (`TimeStamp`), the
 * user who last modified it, its modification time and its financial status. Reddit: `modified_at`, a campaign's computed
 * `effective_status` and `delivery_status`, and a funding instrument's meter (`billable_amount`) and computed servable state.
 * Apple: `modificationTime`. A provider not listed documents nothing that rotates in the rows a review keeps.
 */
const documented = {
  tiktok_native_action: {
    account: n => ({
      balance: 1000 - n * 3.25,
      license_url:
        'https://ads.tiktok.com/pssresource/internal/download?ticket=t' + n + '&x-expires=' + (1700000000 + n),
    }),
    parent: n => ({
      modify_time: '2026-11-1' + (n % 9) + ' 10:00:00',
      secondary_status: n % 2 ? 'CAMPAIGN_STATUS_DELIVERY_OK' : 'CAMPAIGN_STATUS_BUDGET_EXCEED',
    }),
  },
  x_ads_native_action: {
    account: n => ({updated_at: when(n)}),
    parent: n => ({
      updated_at: when(n),
      servable: n % 2 === 0,
      reasons_not_servable: n % 2 ? ['PAUSED_BY_ADVERTISER'] : [],
      effective_status: n % 2 ? 'PAUSED' : 'RUNNING',
    }),
  },
  linkedin_native_action: {
    account: n => ({changeAuditStamps: {lastModified: {time: 1700000000 + n}}, version: {versionTag: String(n)}}),
    parent: n => ({
      changeAuditStamps: {lastModified: {time: 1700000000 + n}},
      version: {versionTag: String(n)},
      servingStatuses: n % 2 ? ['RUNNABLE'] : ['STOPPED'],
    }),
  },
  dv360_native_action: {account: n => ({updateTime: when(n)}), parent: n => ({updateTime: when(n)})},
  snapchat_native_action: {
    account: n => ({updated_at: when(n)}),
    parent: n => ({updated_at: when(n), delivery_status: n % 2 ? ['READY'] : ['PAUSED']}),
  },
  microsoft_ads_native_action: {
    account: n => ({
      TimeStamp: 'AAAAAAAA' + n,
      LastModifiedByUserId: 5000 + n,
      LastModifiedTime: when(n),
      AccountFinancialStatus: n % 2 ? 'ClearFinancialStatus' : 'PendingFinancialStatus',
    }),
    parent: n => ({LastModifiedTime: when(n)}),
  },
  reddit_native_action: {
    account: n => ({modified_at: when(n)}),
    parent: n => ({
      modified_at: when(n),
      effective_status: n % 2 ? 'ACTIVE' : 'PAUSED',
      delivery_status: n % 2 ? 'DELIVERING' : 'NOT_DELIVERING',
    }),
    reference: n => ({
      billable_amount: 120000 + n * 1000,
      is_servable: n % 2 === 0,
      reasons_not_servable: n % 2 ? ['CREDIT_LIMIT_REACHED'] : [],
    }),
  },
  apple_ads_native_action: {account: n => ({modificationTime: when(n)}), parent: n => ({modificationTime: when(n)})},
};
/**
 * The reads of a family that are the PARENT of what its write creates or changes, from the provider's own object hierarchy
 * ("METHOD path" of the read): the Smart+ ad group an ad is created in, the Smart+ campaign an ad group is created in, the ad
 * group negative keywords go to, the campaign a location criterion is added to and the campaign an ad extension is associated
 * with, and the line item and the campaign a promotion goes under (a family that keeps its own state, so its state has no
 * stored read for the campaign). They are named here so a parent read the code never marked with a role is still seen, rotated
 * and counted.
 */
const parentReads = {
  tiktok_smart_plus_ads: ['GET /v1.3/smart_plus/adgroup/get/'],
  tiktok_smart_plus_adgroups: ['GET /v1.3/smart_plus/campaign/get/'],
  tiktok_negative_keywords: ['GET /v1.3/adgroup/get/'],
  microsoft_location_targets: ['POST /CampaignManagement/v13/Campaigns/QueryByIds'],
  microsoft_asset_links: ['POST /CampaignManagement/v13/Campaigns/QueryByIds'],
  x_creatives: ['GET /12/accounts/acct1/line_items/line1', 'GET /12/accounts/acct1/campaigns/campaign1'],
};
/** The parent reads a family makes inside its own state, which its stored review has no read for (X's campaign of a promotion). */
const readInsideState = {x_creatives: ['GET /12/accounts/acct1/campaigns/campaign1']};
/** The reads of a family that are a REFERENCE: an object the write names and does not change (a Reddit funding instrument). */
const referenceReads = {
  reddit_classic: ['GET /api/v3/ad_accounts/a2_111/funding_instruments'],
};
// A parent or a reference read that carries no role in the stored review, as "family: METHOD path". The roles are metadata for
// the review's ordering (a parent is read whole whatever its role), so none of these is unprotected, but each is a read the
// code does not name. The list only shrinks: stamp a role where the read is built, or say here why it is not one. (The Smart+
// ad group of an ad and the Smart+ campaign of an ad group, the first two the review found, now carry theirs.)
const unmarked = [
  'microsoft_asset_links: POST /CampaignManagement/v13/Campaigns/QueryByIds',
  'microsoft_location_targets: POST /CampaignManagement/v13/Campaigns/QueryByIds',
  'tiktok_negative_keywords: GET /v1.3/adgroup/get/',
  'x_creatives: GET /12/accounts/acct1/campaigns/campaign1',
  'x_creatives: GET /12/accounts/acct1/line_items/line1',
];

/** The fields of one read that the provider documents as changing by itself in a row of this kind. */
const rowRotation = (gateway, n, role) => documented[gateway]?.[role]?.(n) ?? {};
const keysOf = value =>
  value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];
/** Every name the provider's documented rotation uses, in any role. */
const rotatingKeys = gateway => [
  ...new Set(['account', 'parent', 'reference'].flatMap(role => keysOf(rowRotation(gateway, 0, role)))),
];
// The objects of an answer that describe the request or the page, not a record: a family refuses an envelope it does not know.
const envelope = new Set(['request', 'paging', 'metadata', 'page_info', 'pagination', 'params', 'links', 'errors']);
/** `json` with the rotation of `role` in every record of its first three levels (a record is a plain object; an envelope is not). */
function rotate(json, gateway, n, role, depth = 0, key = '') {
  if (Array.isArray(json)) return json.map(item => rotate(item, gateway, n, role, depth, key));
  if (!json || typeof json !== 'object' || envelope.has(key)) return json;
  const out = Object.fromEntries(
    Object.entries(json).map(([k, v]) => [k, depth < 3 ? rotate(v, gateway, n, role, depth + 1, k) : v]),
  );
  // A wrapper holds only objects (X's {data, request}); the record inside it is what rotates. What the provider documents as
  // changing by itself replaces the value the descriptor seeded.
  const wrapper = Object.values(json).every(v => v && typeof v === 'object');
  return depth < 3 && !wrapper ? {...out, ...rowRotation(gateway, n, role)} : out;
}

/** The descriptor with a provider whose answer to each read `roleOf` names (a request: its role) rotates at every read. */
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

/**
 * Which of the descriptor's reads are an account's, a parent's or a reference: from the review its prepare stored (the role the
 * code stamped, or the provider's own account read) and from the provider facts above. `stamped` says whether the code gave the
 * read a role. A read the facts name that the review did not store (a family that reads it inside its own state) is listed too.
 */
async function classify(d) {
  const f = familyFixture(d);
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
    const parents = parentReads[d.family] ?? [],
      references = referenceReads[d.family] ?? [],
      seen = [];
    for (const read of review.reads ?? []) {
      const key = read.method + ' ' + read.path,
        role =
          read.stateRole ??
          (account && read.method === account.method && read.path === account.path ? 'account' : undefined) ??
          (parents.includes(key) ? 'parent' : undefined) ??
          (references.includes(key) ? 'reference' : undefined);
      if (role) seen.push({key, role, stamped: read.stateRole !== undefined});
    }
    // What a family reads inside its own state, with no stored read for it.
    for (const key of readInsideState[d.family] ?? [])
      if (!seen.some(r => r.key === key)) seen.push({key, role: 'parent', stamped: false});
    return seen;
  } finally {
    f.close();
  }
}

// Every read the harness met, by family: the coverage is reported by read, not by descriptor.
const coverage = {rotated: [], narrowed: [], none: [], reads: []};
for (const d of descriptors) {
  test(name(d) + ': a rotating account, parent or reference read is no change, and a real change still is', async t => {
    const reads = await classify(d),
      roleOf = request => reads.find(r => r.key === request.method + ' ' + request.path)?.role;
    if (!reads.length) {
      coverage.none.push(name(d));
      return t.diagnostic?.('no account, parent or reference read: reads only its target and what the write names');
    }
    const narrowed = narrowedAtSource[d.gateway] !== undefined;
    // `rotates`: the provider documents something that changes by itself in a row of this kind, so the read really rotates.
    for (const r of reads)
      coverage.reads.push({
        family: d.family,
        ...r,
        narrowed,
        rotates: Object.keys(rowRotation(d.gateway, 0, r.role)).length > 0,
      });
    if (narrowed) {
      coverage.narrowed.push(name(d));
      return;
    }
    coverage.rotated.push(name(d));
    // Prepare, then execute, with every read of an account, a parent or a reference rotating: no STATE_CHANGED (the baseline
    // sends once).
    await baseline(rotating(d, roleOf));
    // A real change of the decisive field, with the rotation going on: refused, naming it and none of the rotating fields.
    const f = familyFixture(rotating(d, roleOf));
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

test('coverage: every descriptor is rotated or listed with why it is not, and the reads rotated are counted by role (S3-5)', t => {
  const all = [...coverage.rotated, ...coverage.narrowed, ...coverage.none];
  assert.equal(all.length, descriptors.length, 'every descriptor ran its check');
  assert.deepEqual(all.sort(), descriptors.map(name).sort(), 'no descriptor is counted twice or missing');
  const seen = coverage.reads.filter(r => !r.narrowed),
    // A read rotates where its provider documents something that changes by itself in a row of its kind; the others are met and
    // answered as they are (counted apart: nothing of them is known to rotate).
    rotated = seen.filter(r => r.rotates),
    by = role => rotated.filter(r => r.role === role),
    stamped = list => list.filter(r => r.stamped).length,
    // The parents and references the code gave no role, by the provider facts above: a count of their own.
    withoutRole = seen.filter(r => r.role !== 'account' && !r.stamped).map(r => r.family + ': ' + r.key);
  t.diagnostic(
    'rotation coverage: ' +
      descriptors.length +
      ' descriptors; rotated ' +
      coverage.rotated.length +
      ', narrowed at the source ' +
      coverage.narrowed.length +
      ', no account, parent or reference read ' +
      coverage.none.length +
      '. Reads rotated: ' +
      by('account').length +
      ' accounts (' +
      stamped(by('account')) +
      ' stamped), ' +
      by('parent').length +
      ' parents (' +
      stamped(by('parent')) +
      ' stamped), ' +
      by('reference').length +
      ' references (' +
      stamped(by('reference')) +
      ' stamped); parent and reference reads seen without a role: ' +
      new Set(withoutRole).size +
      '; reads met where the provider documents nothing that rotates: ' +
      (seen.length - rotated.length),
  );
  assert.deepEqual(
    [...new Set(withoutRole)].sort(),
    [...unmarked].sort(),
    'the parent and reference reads without a role are the pinned list',
  );
  // The rotation is exercised where it can be: these floors are what the harness found at its head, so a family that loses its
  // account read, or a provider that stops being rotated, falls out of them and fails here.
  assert.ok(by('account').length >= 63, 'account reads rotated: ' + by('account').length);
  assert.ok(by('parent').length >= 7, 'parent reads rotated: ' + by('parent').length);
  assert.ok(by('reference').length >= 1, 'reference reads rotated: ' + by('reference').length);
  // Microsoft's and Reddit's families were held to a documented gap in the first pass (their account row was hashed whole);
  // their accounts are kept to their identity now (S3-3), and every one of them is rotated.
  for (const family of [
    'microsoft_asset_links',
    'microsoft_location_targets',
    'microsoft_search',
    'reddit_classic',
    'reddit_creatives',
  ])
    assert.ok(
      coverage.rotated.some(n => n.startsWith(family)),
      family + ' is rotated',
    );
  // The four providers of M1 (TikTok, X, LinkedIn, DV360): the families that read an account or a parent are rotated.
  const four = coverage.rotated.filter(n => /^(?:tiktok|x|linkedin|dv360)_/.test(n));
  assert.ok(four.length >= 48, 'rotated families of TikTok, X, LinkedIn and DV360: ' + four.length);
});
