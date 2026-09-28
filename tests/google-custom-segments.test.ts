import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {segmentFields, assertGoogleSegmentRecord, googleSegmentCanonical} from '../src/google-custom-segments.js';
import {actionContracts} from '../src/action-contracts.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject} from '../src/types.js';

const gateway = 'google_ads_native_action',
  registry = new Registry(),
  actor = {tenantId: 'segments', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 59).toString('base64');
const member = {memberType: 'KEYWORD', keyword: 'family homes'},
  urlMember = {memberType: 'URL', url: 'https://example.com/homes'},
  appMember = {memberType: 'APP', app: 'com.example.homes'},
  placeMember = {memberType: 'PLACE_CATEGORY', placeCategory: '1000'};
const interestMember = {memberType: 'KEYWORD', parameter: 'family homes'},
  interestUrl = {memberType: 'URL', parameter: 'https://example.com/homes'};
const rpc = (interest = false) =>
  interest
    ? 'google_ads_v23_custom_interest_mutate_custom_interests'
    : 'google_ads_v23_custom_audience_mutate_custom_audiences';
const resource = (interest = false, id = '500') =>
  'customers/123/' + (interest ? 'customInterests' : 'customAudiences') + '/' + id;
const make = (interest = false) =>
  structuredClone({
    name: 'Approved property audience',
    type: interest ? 'CUSTOM_AFFINITY' : 'AUTO',
    description: 'Business-approved research',
    members: interest ? [interestMember, interestUrl] : [member, urlMember, appMember, placeMember],
  });
const evidence = JSON.parse(readFileSync('tests/fixtures/google-segment-fields-v23.json', 'utf8')).resources;
test('custom-segment fields are qualified against complete official v23 selectable field tables', () => {
  for (const r of ['custom_audience', 'custom_interest']) {
    assert.equal(Object.keys(evidence[r].fields).length, 7);
    for (const f of ['resource_name', ...segmentFields]) assert.equal(evidence[r].fields[f].selectable, true);
    assert.equal(evidence[r].fields.members.repeated, true);
    assert.match(evidence[r].source_text_sha256, /^[a-f0-9]{64}$/);
  }
});
test('custom-segment member input validates native variants, keyword width and immutable type', () => {
  assertGoogleSegmentRecord('customAudiences', make(), true);
  assertGoogleSegmentRecord('customInterests', make(true), true);
  for (const item of [
    {memberType: 'KEYWORD', keyword: '漢'.repeat(41)},
    {memberType: 'KEYWORD', keyword: Array(11).fill('x').join(' ')},
    {memberType: 'URL', url: 'https://name:password@example.com'},
    {memberType: 'APP', app: 'https://example.com'},
    {memberType: 'PLACE_CATEGORY', placeCategory: '9223372036854775808'},
    {memberType: 'KEYWORD', keyword: 'x', url: 'https://example.com'},
  ])
    assert.throws(() => assertGoogleSegmentRecord('customAudiences', {members: [item]}, false));
  assert.throws(() => assertGoogleSegmentRecord('customAudiences', {type: 'SEARCH'}, false));
  assert.throws(() => assertGoogleSegmentRecord('customAudiences', {...make(), type: 'INTEREST'}, true));
  assertGoogleSegmentRecord('customAudiences', {members: [{memberType: 'KEYWORD', keyword: '漢'.repeat(40)}]}, false);
});
test('segment projection sorts only complete member sets and preserves unknown configuration', () => {
  const v = {resourceName: resource(), members: [{...urlMember, extra: ['b', 'a']}, member]};
  const first = googleSegmentCanonical('custom_audience', v, true),
    second = googleSegmentCanonical(
      'custom_audience',
      {...v, members: [member, {...urlMember, extra: ['b', 'a']}]},
      true,
    );
  assert.deepEqual(first, second);
  assert.deepEqual(first.members.find((m: JsonObject) => m.memberType === 'URL').extra, ['b', 'a']);
  assert.notDeepEqual(
    first,
    googleSegmentCanonical('custom_audience', {...v, members: [member, {...urlMember, extra: ['a', 'b']}]}, true),
  );
  assert.deepEqual(googleSegmentCanonical('custom_audience', {resourceName: resource()}, true).members, []);
  assert.throws(() => googleSegmentCanonical('custom_audience', {members: [member, member]}, true));
});
function fixture(interest = false, file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    records = new Map<string, JsonObject>(),
    c: Connection = {
      id: 'c',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      scopes: ['https://www.googleapis.com/auth/adwords'],
      label: 'Synthetic',
    },
    kind = interest ? 'custom_interest' : 'custom_audience',
    entity = interest ? 'customInterest' : 'customAudience';
  if (!store.listConnections(actor.tenantId).length) store.putConnection(owner, c, {accessToken: 'synthetic'});
  let mode = 'success',
    reads = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        b = JSON.parse(String(init!.body));
      calls.push({url: u.href, body: b});
      assert.equal(u.origin, 'https://googleads.googleapis.com');
      if (u.pathname.endsWith('/googleAds:search')) {
        reads++;
        if (mode === 'revoke') store.putConnection(owner, {...c, writeAccounts: []}, {accessToken: 'synthetic'});
        if (mode === 'scope_revoke') store.putConnection(owner, {...c, scopes: []}, {accessToken: 'synthetic'});
        if (mode === 'error') return Response.json({error: {code: 403, message: 'Synthetic'}});
        if (/ FROM customer /.test(b.query))
          return Response.json({
            results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}],
            queryResourceConsumption: String(reads),
          });
        assert.match(b.query, new RegExp(' FROM ' + kind + ' '));
        for (const field of b.query.match(/^SELECT (.+) FROM/)[1].split(', '))
          assert.equal(evidence[kind].fields[field.slice(kind.length + 1)]?.selectable, true, field);
        const ids = [...b.query.matchAll(/'(customers\/[^']+)'/g)].map(m => m[1]);
        let values = ids.flatMap(target => (records.has(target) ? [structuredClone(records.get(target)!)] : []));
        if (mode === 'foreign')
          values = values.map(v => ({...v, resourceName: v.resourceName.replace('/123/', '/999/')}));
        if (mode === 'duplicate') values = [...values, ...values];
        if (mode === 'missing') values = [];
        if (mode === 'large' && values[0])
          values[0].members = Array.from({length: 1001}, (_, i) => ({
            memberType: 'KEYWORD',
            [interest ? 'parameter' : 'keyword']: String(i),
          }));
        for (const v of values) {
          if (v.description === '') delete v.description;
          if (v.members?.length === 0) delete v.members;
          else v.members?.reverse();
        }
        return Response.json({
          ...(values.length ? {results: values.map(v => ({[entity]: v}))} : {}),
          queryResourceConsumption: String(reads),
          ...(mode === 'partial_read' ? {nextPageToken: 'unread'} : {}),
        });
      }
      assert.equal(u.pathname, '/v23/customers/123/' + (interest ? 'customInterests' : 'customAudiences') + ':mutate');
      const results = b.operations.map((op: JsonObject, i: number) => {
        const name = op.remove ?? op.update?.resourceName ?? resource(interest, String(500 + i));
        if (mode !== 'ignored') {
          if (op.remove) records.delete(name);
          else if (op.create) records.set(name, {...op.create, resourceName: name, status: 'ENABLED'});
          else {
            const next = {...records.get(name), ...op.update};
            if (next.status === 'REMOVED' && mode === 'absent_after_delete') records.delete(name);
            else records.set(name, next);
          }
        }
        return {resourceName: mode === 'foreign_receipt' ? name.replace('/123/', '/999/') : name};
      });
      if (mode === 'lost') throw Error('Synthetic response lost after mutation');
      if (mode === 'partial')
        return Response.json({results, partialFailureError: {code: 3, message: 'Synthetic partial'}});
      if (mode === 'empty') return Response.json({});
      return Response.json({results});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    prepare = (operations: JsonObject[], extra: JsonObject = {}) =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway,
          arguments: {action: rpc(interest), account_id: '123', payload: {operations}, ...extra},
        },
        actor,
      ),
    execute = (r: JsonObject, extra: JsonObject = {}) =>
      service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: r.data.review_id,
          idempotency_key: r.data.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
          ...extra,
        },
        actor,
      ),
    verify = (r: JsonObject) => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {
    store,
    c,
    service,
    records,
    calls,
    prepare,
    execute,
    verify,
    setMode: (v: string) => (mode = v),
    writes: () => calls.filter(c => !c.url.endsWith('/googleAds:search')).length,
    seed: () =>
      records.set(resource(interest), {...make(interest), resourceName: resource(interest), status: 'ENABLED'}),
  };
}
for (const interest of [false, true])
  test(
    'Google ' + (interest ? 'custom interest' : 'custom audience') + ' create, replace, clear, delete and replay',
    async () => {
      const f = fixture(interest);
      try {
        const c = await f.prepare([{create: make(interest)}]);
        assert.equal(c.success, true, JSON.stringify(c));
        assert.equal((await f.execute(c)).data.success, true);
        assert.equal((await f.verify(c)).data.status, 'verified');
        const members = interest
            ? [{memberType: 'KEYWORD', parameter: 'luxury homes'}]
            : [{memberType: 'KEYWORD', keyword: 'luxury homes'}],
          u = await f.prepare([
            {update: {resourceName: resource(interest), members, description: ''}, updateMask: 'members,description'},
          ]);
        assert.equal(u.success, true, JSON.stringify(u));
        assert.equal((await f.execute(u)).data.success, true);
        assert.equal((await f.verify(u)).data.status, 'verified');
        const clear = await f.prepare([
          {update: {resourceName: resource(interest), members: []}, updateMask: 'members'},
        ]);
        assert.equal(clear.success, true, JSON.stringify(clear));
        await f.execute(clear);
        assert.equal((await f.verify(clear)).data.status, 'verified');
        const d = await f.prepare([
          interest
            ? {update: {resourceName: resource(true), status: 'REMOVED'}, updateMask: 'status'}
            : {remove: resource()},
        ]);
        assert.equal(d.success, true, JSON.stringify(d));
        if (interest) f.setMode('absent_after_delete');
        assert.equal((await f.execute(d)).data.success, true);
        assert.equal((await f.verify(d)).data.status, 'verified');
        await f.execute(d);
        assert.equal(f.writes(), 4);
      } finally {
        f.store.close();
      }
    },
  );
test('segment review ignores member order and Google query telemetry but detects member and unknown-field edits', async () => {
  const f = fixture();
  try {
    f.seed();
    const r = await f.prepare([{update: {resourceName: resource(), name: 'Rename'}, updateMask: 'name'}]);
    assert.equal(r.success, true);
    f.records.get(resource())!.members.reverse();
    assert.equal((await f.execute(r)).data.success, true);
    const next = await f.prepare([{update: {resourceName: resource(), name: 'Again'}, updateMask: 'name'}]);
    f.records.get(resource())!.members[0].futureConfiguration = 'changed';
    const out = await f.execute(next);
    assert.equal(out.error.code, 'STATE_CHANGED');
    assert.match(JSON.stringify(out.error.details.changed_fields), /futureConfiguration/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('segment masks, native removal semantics, cross-account IDs and output fields fail before egress', async () => {
  for (const interest of [false, true]) {
    const f = fixture(interest);
    try {
      for (const op of [
        {create: {...make(interest), resourceName: resource(interest)}},
        {update: {resourceName: resource(interest), type: interest ? 'CUSTOM_INTENT' : 'SEARCH'}, updateMask: 'type'},
        {update: {resourceName: resource(interest), members: []}, updateMask: '*'},
        {update: {resourceName: resource(interest).replace('/123/', '/999/'), name: 'Other'}, updateMask: 'name'},
        {create: {...make(interest), members: [...make(interest).members, make(interest).members[0]]}},
        ...(interest ? [{remove: resource(true)}] : [{create: {...make(), status: 'ENABLED'}}]),
      ])
        assert.equal((await f.prepare([op])).success, false, JSON.stringify(op));
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});
test('segment malformed, partial, foreign, absent and oversized state cannot authorize a write', async () => {
  for (const mode of ['error', 'foreign', 'duplicate', 'missing', 'large', 'partial_read']) {
    const f = fixture();
    try {
      f.seed();
      f.setMode(mode);
      assert.equal(
        (await f.prepare([{update: {resourceName: resource(), name: 'Name'}, updateMask: 'name'}])).success,
        false,
        mode,
      );
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('segment updates and deletions obey current scopes, grants, confirmation and owner policies', async () => {
  for (const mode of ['scope', 'grant', 'revoke', 'scope_revoke', 'activation', 'deletion', 'confirmation']) {
    const f = fixture(mode === 'deletion');
    try {
      f.seed();
      const r = await f.prepare([
        {
          update: {
            resourceName: resource(mode === 'deletion'),
            ...(mode === 'deletion' ? {status: 'REMOVED'} : {name: 'New'}),
          },
          updateMask: mode === 'deletion' ? 'status' : 'name',
        },
      ]);
      assert.equal(r.success, true, JSON.stringify(r));
      if (mode === 'scope') f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
      if (mode === 'grant') f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
      if (mode === 'activation' || mode === 'deletion')
        saveSpendPolicy(f.store, owner, {
          gateway,
          account_id: '123',
          policy: {[mode === 'deletion' ? 'allow_deletion' : 'allow_activation']: false},
          confirmed: true,
        });
      if (mode === 'revoke' || mode === 'scope_revoke') f.setMode(mode);
      assert.equal(
        (await f.execute(r, mode === 'confirmation' ? {spend_change_confirmed: false} : {})).success,
        false,
        mode,
      );
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('unattached segment creation respects an activation prohibition while preserving native enabled status', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_activation: false}, confirmed: true});
    const r = await f.prepare([{create: make()}]);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});
test('segment partial, foreign and lost receipts remain once-only', async () => {
  for (const mode of ['partial', 'foreign_receipt', 'lost', 'empty']) {
    const f = fixture();
    try {
      const r = await f.prepare([{create: make()}]);
      f.setMode(mode);
      const result = await f.execute(r);
      assert.ok(!result.success || !result.data.success, mode);
      await f.execute(r);
      assert.equal(f.writes(), 1);
      assert.notEqual((await f.verify(r)).data?.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});
test('a successful ignored segment replacement never passes read-back', async () => {
  const f = fixture();
  try {
    f.seed();
    const r = await f.prepare([{update: {resourceName: resource(), members: []}, updateMask: 'members'}]);
    f.setMode('ignored');
    assert.equal((await f.execute(r)).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'inconclusive');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('segment durable claims survive concurrent execution and process-store reopen', async () => {
  for (const lost of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'amcp-segments-'));
    let f = fixture(false, join(directory, 'store.sqlite'));
    try {
      const r = await f.prepare([{create: make()}]);
      if (lost) f.setMode('lost');
      await Promise.all([f.execute(r), f.execute(r)]);
      assert.equal(f.writes(), 1);
      f.store.close();
      f = fixture(false, join(directory, 'store.sqlite'));
      const out = await f.execute(r);
      assert.equal(f.writes(), 0);
      if (lost) assert.equal(out.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(out.data.success, true);
    } finally {
      f.store.close();
      removeTestDirectory(directory, 'amcp-segments-');
    }
  }
});
test('segment cached verification rechecks scope and native gateway cannot bypass review', async () => {
  const f = fixture();
  try {
    const r = await f.prepare([{create: make()}]);
    await f.execute(r);
    assert.equal((await f.verify(r)).data.status, 'verified');
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.verify(r)).error.code, 'INSUFFICIENT_SCOPE');
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic'});
    const direct = await f.service.call(
      gateway,
      {
        action: rpc(),
        account_id: '123',
        payload: {operations: [{create: make()}]},
        dry_run: false,
        confirmed: true,
        idempotency_key: '12345678-1234-4234-9234-123456789abc',
      },
      actor,
    );
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('both segment RPCs have explicit configuration-family entries without changing the catalog denominator', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && [rpc(), rpc(true)].includes(r.action));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.family === 'google_configuration' && r.status === 'reviewed_write_family'));
});

test('native enabled interest creation and budget keywords do not activate ads or change a budget', async () => {
  for (const interest of [false, true]) {
    const f = fixture(interest);
    try {
      saveSpendPolicy(f.store, owner, {
        gateway,
        account_id: '123',
        policy: {allow_activation: false, max_budget_native: 0, max_daily_increase_native: 0},
        confirmed: true,
      });
      const r = await f.prepare([
        {
          create: {
            ...make(interest),
            ...(interest ? {status: 'ENABLED'} : {}),
            members: [{memberType: 'KEYWORD', [interest ? 'parameter' : 'keyword']: 'budget family homes'}],
          },
        },
      ]);
      assert.equal(r.success, true, JSON.stringify(r));
      const out = await f.execute(r, {spend_change_confirmed: false});
      assert.equal(out.data?.success, true, JSON.stringify(out));
      assert.equal((await f.verify(r)).data.status, 'verified');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('segment native envelopes reject partialFailure and invented response content controls', async () => {
  for (const interest of [false, true]) {
    const f = fixture(interest);
    try {
      for (const extra of [{partialFailure: false}, {responseContentType: 'RESOURCE_NAME_ONLY'}]) {
        const r = await f.prepare([], {payload: {operations: [{create: make(interest)}], ...extra}});
        assert.equal(r.error.code, 'INVALID_VENDOR_BODY');
        assert.equal(f.calls.length, 0);
      }
    } finally {
      f.store.close();
    }
  }
});

test('segment scalar changes still conflict and omitted or unknown types cannot establish configuration', async () => {
  for (const scenario of ['status', 'type', 'missing_type']) {
    const f = fixture();
    try {
      f.seed();
      const r = await f.prepare([{update: {resourceName: resource(), name: 'Reviewed'}, updateMask: 'name'}]);
      assert.equal(r.success, true);
      if (scenario === 'status') f.records.get(resource())!.status = 'REMOVED';
      if (scenario === 'type') f.records.get(resource())!.type = 'UNKNOWN';
      if (scenario === 'missing_type') delete f.records.get(resource())!.type;
      assert.equal((await f.execute(r)).success, false);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('an unattached create cannot conceal a segment update in a mixed batch', async () => {
  const f = fixture(true);
  try {
    f.seed();
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', policy: {allow_activation: false}, confirmed: true});
    const r = await f.prepare([
      {create: make(true)},
      {update: {resourceName: resource(true), name: 'Updated consumer definition'}, updateMask: 'name'},
    ]);
    assert.equal(r.error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('another connection with the same segment account cannot replace the reviewed connection or grant', async () => {
  const f = fixture();
  try {
    f.seed();
    const r = await f.prepare([{update: {resourceName: resource(), name: 'Name'}, updateMask: 'name'}]);
    assert.equal(r.success, true);
    f.store.putConnection(
      owner,
      {...f.c, id: 'other', label: 'Other synthetic identity'},
      {accessToken: 'other synthetic'},
    );
    f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
    assert.equal((await f.execute(r)).success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
