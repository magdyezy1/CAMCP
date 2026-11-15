// A synthetic TikTok advertiser for the T1 tests (Round 2.5, package r25-m0-t1). Every value here is invented.
//
// Without `fields`, TikTok's advertiser info answer carries more than the identity of the account: a signed licence link
// whose `ticket=` changes on every read, a balance that moves with spend, the creation time and the advertiser's contact
// record (the White Friday report, T1). With `fields` it returns exactly the fields named (the lead's live read of the
// owner's test advertiser, 2026-11-15). `advertiserAnswer` answers both ways, so a test can also prove the review
// stays stable when TikTok ignores `fields`.
import assert from 'node:assert/strict';

/** The seven fields a review keeps of the advertiser row (Q15, owner 2026-11-15), written out by hand. */
export const identityFields = ['advertiser_id', 'name', 'status', 'role', 'currency', 'timezone', 'country'];

/** Contact and registration values that must never reach a review's `before_state`. */
export const contactValues = {
  email: 'synthetic.contact@example.test',
  phone_number: '+10005550101',
  cellphone_number: '+10005550102',
  contacter: 'Synthetic Contact Person',
  address: '1 Synthetic Street, Testville',
  company: 'Synthetic Trading Company Ltd',
};

/** The provider state of one synthetic advertiser; `reads` counts the advertiser info answers given so far. */
export function advertiserWorld(changes = {}) {
  return {
    id: '9000000000000000001',
    name: 'Synthetic Advertiser | Test Market',
    status: 'STATUS_ENABLE',
    role: 'ROLE_ADVERTISER',
    currency: 'USD',
    timezone: 'Asia/Riyadh',
    country: 'SA',
    // False: nothing rotates between reads (the control every flow must pass with and without the fix).
    rotating: true,
    // True: TikTok narrows its answer to `fields`.
    honourFields: true,
    reads: 0,
    // The advertiser info requests received, as URLs.
    seen: [],
    ...changes,
  };
}

/**
 * The whole row TikTok returns without `fields`; on read `n` the ticket differs and the balance has fallen. A world may
 * add more noise of its own per read with `extra(n)`, a field set to undefined being left out of the row.
 */
export function fullAdvertiserRow(world, n = world.reads) {
  const k = world.rotating ? n : 1,
    row = {
      advertiser_id: world.id,
      name: world.name,
      status: world.status,
      role: world.role,
      currency: world.currency,
      timezone: world.timezone,
      country: world.country,
      license_url: 'https://ads.tiktok.com/pssresource/internal/download?ticket=synthetic-ticket-' + k,
      balance: 1000 - k * 3.25,
      create_time: 1700000000 + k,
      ...contactValues,
      ...world.extra?.(k),
    };
  for (const [name, field] of Object.entries(row)) if (field === undefined) delete row[name];
  return row;
}

/** One answer of advertiser info to the request `url`: the whole row, or only the named fields when TikTok honours them. */
export function advertiserAnswer(world, url) {
  world.reads++;
  world.seen.push(url);
  const row = fullAdvertiserRow(world),
    wanted = url.searchParams.get('fields');
  if (!world.honourFields || wanted === null) return row;
  return Object.fromEntries(
    JSON.parse(wanted)
      .filter(name => Object.hasOwn(row, name))
      .map(name => [name, row[name]]),
  );
}

/** TikTok's answer envelope. */
export const answer = data => ({code: 0, message: 'OK', request_id: 'synthetic-request', data});

/** A review never carries the advertiser's contact record, licence link, balance or creation time (L1-02). */
export function assertNoAdvertiserDetail(value, what) {
  const text = JSON.stringify(value);
  for (const secret of [...Object.values(contactValues), 'ticket=', '"license_url"', '"balance"', '"create_time"'])
    assert.equal(text.includes(secret), false, what + ' carries ' + secret);
}
