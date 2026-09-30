import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {scrubPeople, withoutPeople, hashPeople, normalizeEmail, confirmations} from '../dist/src/personal-data.js';

const email = 'synthetic.person@example.com';
const hash = createHash('sha256').update(email).digest('hex');
const actions = new Set(['meta_native_action meta_custom_audience_id_users_create']);

test('personal-data error audits withhold misplaced raw people throughout native arguments', () => {
  for (const nested of [false, true]) {
    const native = {
      action: 'meta_custom_audience_id_users_create',
      payload: {data: [['+201001234567', 'Synthetic Person', email, hash]]},
    };
    const input = {gateway: 'meta_native_action', arguments: nested ? {arguments: native} : native};
    const result = withoutPeople('amcp_write', input, actions);
    assert.deepEqual(result.arguments, {withheld: 'personal data'});
    assert.deepEqual(input.arguments, nested ? {arguments: native} : native, 'caller input is unchanged');
  }
});

test('people beside an invalid action still withhold misplaced arguments and retain only the row count', () => {
  const input = {people: {schema: 'EMAIL', rows: [email]}, arguments: {payload: {phone: '+201001234567'}}};
  assert.deepEqual(withoutPeople('amcp_write', input, actions), {
    people: {withheld: 'personal data', rows: 1},
    arguments: {withheld: 'personal data'},
  });
  const ordinary = {arguments: {action: 'rename', payload: {name: 'Budget review'}}};
  assert.equal(withoutPeople('amcp_write', ordinary, actions), ordinary);
  assert.equal(withoutPeople('amcp_tool_help', ordinary, actions), ordinary);
});

test('provider echoes cannot retain identifying object keys, including nested arrays and errors', () => {
  const input = {num_received: 2, nested: [{[email]: {value: hash}, [hash]: email, detail: email}]};
  const result = scrubPeople(input);
  assert.deepEqual(result, {num_received: 2, nested: [{detail: '[personal data]'}]});
  assert.ok(Object.hasOwn(input.nested[0], email), 'scrubbing does not mutate the provider response');
});

test('invalid people field names are not echoed into the returned error or its audit', () => {
  const spec = {platform: 'Synthetic', keys: {EMAIL: normalizeEmail}, maxRows: 10};
  assert.throws(
    () => hashPeople({schema: 'EMAIL', rows: [email], [email]: true}, spec, 'add'),
    error =>
      error.code === 'PERSONAL_DATA_INVALID' &&
      !JSON.stringify({message: error.message, details: error.details}).includes(email),
  );
});

test('invalid confirmation field names are not echoed into the returned error or its audit', () => {
  assert.throws(
    () => confirmations({[email]: true}, 'add', 'Synthetic'),
    error =>
      error.code === 'INVALID_ARGUMENT' &&
      !JSON.stringify({message: error.message, details: error.details}).includes(email),
  );
});
