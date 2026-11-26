// CON-01: provider calls are fenced on the connection's login revision, not on the token bytes. AMCP's own token
// refresh renews the same login and must not be reported as a login change; a real replacement, scope loss or
// account-grant change must still be refused. Every test here failed on the byte fingerprint fence.
// always-run: walks src/ and server/ for the writes to the connections table
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {CredentialProvider} from '../dist/src/auth.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';
import {errorResult, MirrorError} from '../dist/src/errors.js';
import {loginStamp, sameLogin} from '../dist/src/connection-authority.js';

const registry = new Registry(),
  key = Buffer.alloc(32, 71).toString('base64'),
  owner = {tenantId: 'login-revision', userId: 'owner', role: 'admin'},
  id = '7d1c3b8e-1f0a-4c55-9a51-2b0b2f6a0c11',
  policy = {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0.2};
const meta = {
  id,
  tenantId: owner.tenantId,
  gateway: 'meta_native_action',
  label: 'Synthetic Meta',
  enabled: true,
  accounts: ['123'],
  writeAccounts: ['123'],
  scopes: ['ads_management'],
};
const revision = (store, connectionId = id) =>
  store.listConnections(owner.tenantId).find(c => c.id === connectionId)?.loginRevision ?? 0;
/** What another worker's ordinary refresh does: the same login with a new access token. */
const concurrentRefresh = (store, connection = meta) => {
  const current = store.connectionCredentials(connection);
  store.completeCredentialRefresh(connection, current, {...current, accessToken: 'refreshed-by-another-worker'});
};

test('the store classifies every credential write: only AMCP refresh and unchanged credentials keep the login revision', () => {
  const store = new Store(':memory:', key);
  try {
    store.putConnection(owner, meta, {accessToken: 'first'});
    const created = store.listConnections(owner.tenantId)[0];
    assert.equal(revision(store), 0);
    assert.match(created.loginId, /^[0-9a-f-]{36}$/);
    const held = store.credentials(owner.tenantId, id);
    // Re-provisioning identical credentials and metadata-only edits are the same login.
    store.putConnection(owner, {...meta, label: 'Renamed'}, {accessToken: 'first'});
    store.updateConnection(owner, {...meta, accounts: ['123', '456'], loginRevision: 99, loginId: 'caller-chosen'});
    assert.equal(revision(store), 0, 'callers never choose the revision');
    assert.equal(store.listConnections(owner.tenantId)[0].loginId, created.loginId);
    assert.equal(store.credentials(owner.tenantId, id).accessToken, 'first', 'metadata edits never touch credentials');
    // AMCP's own refresh keeps the login.
    store.completeCredentialRefresh(meta, store.credentials(owner.tenantId, id), {accessToken: 'refreshed'});
    assert.equal(revision(store), 0);
    assert.equal(sameLogin(held, store.credentials(owner.tenantId, id)), true);
    assert.equal(loginStamp(held), loginStamp(store.credentials(owner.tenantId, id)));
    // Every other credential write with different credentials is a new login.
    store.replaceCredentials(owner.tenantId, id, {accessToken: 'refreshed'});
    assert.equal(revision(store), 0, 'unchanged bytes are not a new login');
    store.replaceCredentials(owner.tenantId, id, {accessToken: 'directly-replaced'});
    assert.equal(revision(store), 1);
    assert.equal(sameLogin(held, store.credentials(owner.tenantId, id)), false);
    store.putConnection(owner, meta, {accessToken: 'reauthorized'});
    assert.equal(revision(store), 2);
    store.putConnection(owner, {...meta, gateway: 'linkedin_native_action'}, {accessToken: 'reauthorized'});
    assert.equal(revision(store), 3, 're-pointing the gateway is a new login');
    // A removed and re-created connection id is a different login even at revision 0.
    const before = store.credentials(owner.tenantId, id);
    store.db.prepare('DELETE FROM connections WHERE tenant_id=? AND id=?').run(owner.tenantId, id);
    store.putConnection(owner, meta, {accessToken: 'recreated'});
    assert.equal(revision(store), 0);
    assert.notEqual(store.listConnections(owner.tenantId)[0].loginId, created.loginId);
    assert.notEqual(loginStamp(before), loginStamp(store.credentials(owner.tenantId, id)));
  } finally {
    store.close();
  }
});

test('every code path that writes the connections table is classified for the login revision', () => {
  // A new write path fails here until someone decides whether it replaces a login (bump) or not.
  const classified = {
    'src/store.ts': {
      putConnection: 'provisioning; bumps when credentials or gateway change',
      updateConnection: 'metadata only; keeps revision and credentials',
      sealCredentials: 'replace bumps on different credentials; refresh and re-seal keep it',
    },
    // ARC-04 stage D moved the website's two connection writes from createWebsite into its store-layer repository.
    'server/website-repository.ts': {label: 'json_set of $.label only', default: 'isDefault flag inside a transaction'},
    // The local disconnect (src/connection-disconnect.ts) deletes the login through the store layer (ARC-02).
    'src/connection-repository.ts': {delete: 'removes the login (deleteConnectionRow)'},
  };
  const write = /(?:INSERT INTO|UPDATE|DELETE FROM)\s+connections\b/g,
    found = {};
  const walk = dir =>
    fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p.replaceAll(path.sep, '/')] : [];
    });
  for (const file of [...walk('src'), ...walk('server')]) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!write.test(line)) return;
      write.lastIndex = 0;
      if (file === 'src/store.ts') {
        let j = i;
        while (j >= 0 && !/^ {2}(?:private |async )*([A-Za-z]+)\(/.test(lines[j])) j--;
        const name = /^ {2}(?:private |async )*([A-Za-z]+)\(/.exec(lines[j])[1];
        (found[file] ??= new Set()).add(name);
      } else (found[file] ??= []).push(line.trim());
    });
  }
  assert.deepEqual([...found['src/store.ts']].sort(), Object.keys(classified['src/store.ts']).sort());
  assert.deepEqual(Object.keys(found).sort(), Object.keys(classified).sort(), JSON.stringify(found));
  assert.equal(found['server/website-repository.ts'].length, 2);
  assert.ok(found['server/website-repository.ts'].some(l => l.includes("json_set(data,'$.label'")));
  assert.equal(found['src/connection-repository.ts'].length, 1);
  assert.ok(found['src/connection-repository.ts'][0].includes('DELETE FROM connections WHERE tenant_id=? AND id=?'));
});

function nativeFixture(change) {
  const store = new Store(':memory:', key);
  store.putConnection(owner, meta, {accessToken: 'synthetic'});
  const tokens = [];
  let calls = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (_url, init) => {
        tokens.push(new Headers(init?.headers).get('authorization'));
        if (++calls === 1) {
          change(store);
          return Response.json({}, {status: 503});
        }
        return Response.json({data: []});
      },
      async () => {},
    ),
  );
  return {
    store,
    tokens,
    count: () => calls,
    call: () =>
      service.call(
        'meta_native_action',
        {action: 'meta_ad_account_id_campaigns_get', account_id: '123', connection_id: id, dry_run: false},
        owner,
      ),
  };
}

test('a concurrent refresh by another caller does not abort a native read retry', async () => {
  const f = nativeFixture(store => concurrentRefresh(store));
  try {
    const r = await f.call();
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(f.count(), 2);
  } finally {
    f.store.close();
  }
});

test('a real login replacement, scope loss or account removal during a native read is still refused', async () => {
  for (const [mode, change, code] of [
    ['login', s => s.putConnection(owner, meta, {accessToken: 'replacement'}), 'CONNECTION_AUTHORITY_CHANGED'],
    ['scope', s => s.updateConnection(owner, {...meta, scopes: []}), 'INSUFFICIENT_SCOPE'],
    ['account', s => s.updateConnection(owner, {...meta, accounts: ['456'], writeAccounts: []}), undefined],
  ]) {
    const f = nativeFixture(change);
    try {
      const r = await f.call();
      assert.equal(r.success, false, mode);
      if (code) assert.equal(r.error.code, code, mode + ' ' + JSON.stringify(r));
      assert.equal(f.count(), 1, mode + ': no second attempt after the authority changed');
      assert.equal(JSON.stringify(f.tokens).includes('replacement'), false);
    } finally {
      f.store.close();
    }
  }
});

test('AMCP_AUTHORITY_FENCE=fingerprint restores the previous byte fence as a rollback', async t => {
  const previous = process.env.AMCP_AUTHORITY_FENCE;
  process.env.AMCP_AUTHORITY_FENCE = 'fingerprint';
  t.after(() =>
    previous === undefined ? delete process.env.AMCP_AUTHORITY_FENCE : (process.env.AMCP_AUTHORITY_FENCE = previous),
  );
  const f = nativeFixture(store => concurrentRefresh(store));
  try {
    const r = await f.call();
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'CONNECTION_AUTHORITY_CHANGED');
  } finally {
    f.store.close();
  }
});

const googleAccount = '123',
  google = {
    id: 'eeeeeeee-2222-4222-8222-222222222222',
    tenantId: owner.tenantId,
    gateway: 'google_ads_native_action',
    enabled: true,
    label: 'Synthetic Google',
    accounts: [googleAccount],
    scopes: ['https://www.googleapis.com/auth/adwords'],
  };
const campaignRow = id => ({
  customer: {id: googleAccount, resourceName: 'customers/' + googleAccount, currencyCode: 'USD', timeZone: 'UTC'},
  campaign: {
    id,
    name: 'Campaign ' + id,
    status: 'PAUSED',
    resourceName: `customers/${googleAccount}/campaigns/${id}`,
    campaignBudget: 'customers/123/campaignBudgets/20',
  },
  campaignBudget: {resourceName: 'customers/123/campaignBudgets/20', amountMicros: '1000000'},
});
function portfolioFixture(t, {expiresIn, onRead} = {}) {
  const store = new Store(':memory:', key);
  t.after(() => store.close());
  store.putConnection(owner, google, {
    accessToken: 'synthetic-before-refresh',
    refreshToken: 'synthetic-refresh',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    developerToken: 'synthetic',
    ...(expiresIn === undefined ? {} : {expiresAt: Date.now() + expiresIn}),
  });
  const sent = [];
  let refreshes = 0,
    reads = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (_url, init) => {
        sent.push(new Headers(init?.headers).get('authorization'));
        reads++;
        onRead?.(store, reads);
        const query = JSON.parse(init.body).query;
        return Response.json({
          results: query.includes('campaign.id > ') ? [campaignRow('3')] : [campaignRow('1'), campaignRow('2')],
        });
      },
      async () => {},
    ),
  );
  service.credentials = new CredentialProvider(store, async url => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    refreshes++;
    return Response.json({access_token: 'synthetic-refreshed', expires_in: 3600, token_type: 'Bearer'});
  });
  return {
    store,
    sent,
    refreshes: () => refreshes,
    call: (cursor, limit = 1) =>
      service.call(
        'amcp_workspace',
        {
          action: 'portfolio',
          gateway: 'google_ads_native_action',
          account_id: googleAccount,
          connection_id: google.id,
          limit,
          requirements: {entity: 'campaign'},
          ...(cursor ? {cursor} : {}),
        },
        owner,
      ),
  };
}

test('a portfolio read whose token expires within the refresh window succeeds after exactly one refresh', async t => {
  // Previously: REAUTHORIZATION_REQUIRED "The Google login or permissions changed. Restart inventory." after 1 refresh.
  const f = portfolioFixture(t, {expiresIn: 60000});
  const r = await f.call();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(f.refreshes(), 1);
  assert.ok(f.sent.every(h => h === 'Bearer synthetic-refreshed'));
  assert.equal(revision(f.store, google.id), 0);
  // An already expired token (an unattended schedule) takes the same path.
  f.store.replaceCredentials(owner.tenantId, google.id, {
    ...f.store.credentials(owner.tenantId, google.id),
    expiresAt: Date.now() - 1000,
  });
  assert.equal((await f.call()).success, true);
  assert.equal(f.refreshes(), 2);
});

test('a concurrent refresh during a paginated portfolio read does not interrupt it', async t => {
  const f = portfolioFixture(t, {onRead: (store, n) => n === 1 && concurrentRefresh(store, google)});
  const first = await f.call(undefined, 1);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.ok(first.data.next_cursor);
  const second = await f.call(first.data.next_cursor, 1);
  assert.equal(second.success, true, JSON.stringify(second));
});

test('a login replacement or account-grant change mid-portfolio is still refused with an accurate code', async t => {
  for (const [mode, change] of [
    ['login', s => s.putConnection(owner, google, {accessToken: 'replacement', developerToken: 'synthetic'})],
    ['scope', s => s.updateConnection(owner, {...google, scopes: []})],
  ]) {
    const f = portfolioFixture(t, {onRead: (store, n) => n === 1 && change(store)});
    const r = await f.call(undefined, 2);
    assert.equal(r.success, false, mode);
    assert.equal(r.error.code, 'CONNECTION_AUTHORITY_CHANGED', mode + ' ' + JSON.stringify(r));
    assert.doesNotMatch(r.error.next_action, /Reconnect/);
  }
});

test('discovery is not aborted by a concurrent refresh, but a replaced login still stops it', async () => {
  for (const mode of ['refresh', 'replace']) {
    const store = new Store(':memory:', key);
    try {
      store.putConnection(owner, {...meta, accounts: [], writeAccounts: [], enabled: false}, {accessToken: 'one'});
      const c = store.listConnections(owner.tenantId)[0];
      let graph = 0;
      const discovery = new AssetDiscovery(store, async input => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/me/adaccounts')) {
          if (++graph === 1) {
            if (mode === 'refresh') concurrentRefresh(store, c);
            else store.putConnection(owner, c, {accessToken: 'replacement'});
          }
          return Response.json({data: [{id: 'act_123', account_id: '123', name: 'A', currency: 'USD'}]});
        }
        return Response.json({id: 'u', name: 'Synthetic login'});
      });
      const result = await discovery.sync(c).then(
        r => r,
        e => ({error: e}),
      );
      if (mode === 'refresh') {
        assert.equal(result.error, undefined, String(result.error?.message));
        assert.equal(result.groups[0].complete, true, JSON.stringify(result.groups));
        result.assertCurrent();
      } else {
        const failed = result.error ?? result.groups[0];
        assert.ok(result.error ? result.error.code === 'CONNECTION_CHANGED' : !failed.complete, JSON.stringify(failed));
      }
    } finally {
      store.close();
    }
  }
});

test('review preparation is not aborted by a concurrent refresh during its account read', async () => {
  const store = new Store(':memory:', key);
  try {
    store.putConnection(owner, meta, {accessToken: 'synthetic'});
    let calls = 0;
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(
        async () => {
          if (++calls === 1) concurrentRefresh(store);
          return Response.json({id: 'act_123', account_id: '123', currency: 'USD', account_status: 1});
        },
        async () => {},
      ),
      undefined,
      policy,
    );
    const r = await service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway: 'meta_native_action',
        connection_id: id,
        arguments: {
          action: 'meta_campaign_create',
          account_id: '123',
          payload: {
            name: 'Synthetic paused draft',
            status: 'PAUSED',
            objective: 'OUTCOME_TRAFFIC',
            special_ad_categories: [],
            // From Graph API v24.0 a campaign without its own budget states the choice (CMP-01).
            is_adset_budget_sharing_enabled: false,
          },
        },
      },
      owner,
    );
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(store.documents(owner.tenantId, 'write_review').length, 1);
  } finally {
    store.close();
  }
});

test('the authority-change remedy never sends the user to reconnect, while credential failures still do', () => {
  const changed = errorResult(new MirrorError('CONNECTION_AUTHORITY_CHANGED', 'Synthetic.', {}, 409), 'r', 0),
    expired = errorResult(new MirrorError('REAUTHORIZATION_REQUIRED', 'Synthetic.', {}, 401), 'r', 0);
  assert.match(changed.error.next_action, /current login/);
  assert.doesNotMatch(changed.error.next_action, /Reconnect/);
  assert.match(changed.error.remedy.action, /Do not reconnect/);
  assert.match(expired.error.next_action, /Reconnect/);
});
