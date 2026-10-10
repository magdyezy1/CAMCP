import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {MirrorError} from '../src/errors.js';
import {redact} from '../src/security.js';
import {prepareReadProbes} from '../src/read-verification.js';
import {readMetaPermissions} from '../src/meta-auth-diagnostic.js';
import {metaPrefix} from '../src/meta-version.js';
import type {JsonObject} from '../src/types.js';

const account = process.argv[3] ?? '111111111111111',
  connectionId = '11111111-2222-4333-8444-000000000001';
const actor = {tenantId: 'local', userId: 'meta-read-verifier', role: 'reader' as const};
const store = new Store(process.env.MIRROR_DB ?? '.runtime/mirror.sqlite', process.env.MIRROR_MASTER_KEY);
let secret = '';
const clean = (value: unknown) => {
  const text = JSON.stringify(redact(value), null, 2);
  return secret ? text.split(secret).join('[REDACTED]') : text;
};
try {
  if (!/^[1-9]\d{0,29}$/.test(account) || process.argv.length > 4)
    throw new MirrorError('INVALID_ACCOUNT_INPUT', 'Provide one Meta account ID as a digits-only string.');
  if (process.argv[2] === 'provision') {
    if (process.stdin.isTTY)
      throw new MirrorError(
        'PIPE_REQUIRED',
        'Provide the token through non-echoing standard input, never command arguments.',
      );
    process.stdout.write('Waiting for token on protected standard input.\n');
    const input = createInterface({input: process.stdin, terminal: false});
    for await (const line of input) {
      secret = line.trim();
      input.close();
      break;
    }
    if (!/^EAA[A-Za-z0-9]+$/.test(secret) || secret.length < 50 || secret.length > 8192)
      throw new MirrorError('INVALID_TOKEN_INPUT', 'Input is not a supported Meta token string.');
    const existing = store.listConnections(actor.tenantId).find(c => c.id === connectionId);
    const accounts = [...new Set([...(existing?.accounts ?? []), account])];
    store.putConnection(
      {...actor, role: 'admin'},
      {
        id: connectionId,
        tenantId: actor.tenantId,
        gateway: 'meta_native_action',
        accounts,
        label: 'Meta read verification',
        enabled: true,
        scopes: ['ads_read'],
      },
      {accessToken: secret},
    );
    store.appendAudit(actor.tenantId, 'admin/meta-provision', {
      event: 'connection_provisioned',
      connection_id: connectionId,
      gateway: 'meta_native_action',
      accounts: [account],
      credential_source: 'user_supplied',
      scope_verification: 'pending',
      token_exposure: 'user_was_advised_to_replace_after_verification',
    });
    process.stdout.write('Meta connection encrypted and provisioned. No vendor requests were made.\n');
  } else if (process.argv[2] === 'bind') {
    if (!process.argv[3])
      throw new MirrorError('ACCOUNT_REQUIRED', 'Supply the explicitly authorized account ID to bind locally.');
    const connection = store.resolveConnection(actor, 'meta_native_action', undefined, connectionId),
      credentials = store.credentials(actor.tenantId, connectionId);
    secret = credentials.accessToken ?? '';
    store.putConnection(
      {...actor, role: 'admin'},
      {...connection, accounts: [...new Set([...connection.accounts, account])]},
      credentials,
    );
    store.appendAudit(actor.tenantId, randomUUID(), {
      event: 'local_meta_account_binding',
      connection_id: connectionId,
      account_id: account,
      vendor_requests: 0,
    });
    process.stdout.write(
      clean({account_id: account, connection_id: connectionId, local_binding: true, vendor_requests: 0}) + '\n',
    );
  } else if (process.argv[2] === 'permissions') {
    const connection = store.resolveConnection(actor, 'meta_native_action', account, connectionId),
      credentials = store.credentials(actor.tenantId, connectionId);
    secret = credentials.accessToken ?? '';
    const transport = new NativeTransport((async (url, init) => {
      const target = new URL(String(url));
      if (
        target.origin !== 'https://graph.facebook.com' ||
        target.pathname !== metaPrefix + 'me/permissions' ||
        init?.method !== 'GET'
      )
        throw new MirrorError(
          'VERIFICATION_SCOPE_FORBIDDEN',
          'Credential diagnostics allow only the token owner permission GET.',
        );
      return fetch(url, init);
    }) as typeof fetch);
    const result = await readMetaPermissions(transport, connection, credentials),
      runId = randomUUID();
    const evidence = {
      run_id: runId,
      captured_at: new Date().toISOString(),
      evidence: 'LIVE_TOKEN_PERMISSION_DIAGNOSTIC',
      connection_id: connectionId,
      ...result,
    };
    const directory = path.join('.mirror/PRIVATE/live-meta', runId);
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'permissions.json'), clean(evidence) + '\n');
    store.appendAudit(actor.tenantId, runId, {
      event: 'meta_permission_diagnostic',
      ads_read_granted: result.ads_read_granted,
      complete: result.complete,
      account_access_verified: false,
    });
    process.stdout.write(clean({...evidence, summary: directory}) + '\n');
  } else if (process.argv[2] === 'verify') {
    secret = store.credentials(actor.tenantId, connectionId).accessToken ?? '';
    const requests: JsonObject[] = [];
    const transport = new NativeTransport((async (url, init) => {
      const target = new URL(String(url));
      const accountPath = metaPrefix + 'act_' + account;
      if (
        target.origin !== 'https://graph.facebook.com' ||
        init?.method !== 'GET' ||
        !(target.pathname === accountPath || target.pathname.startsWith(accountPath + '/'))
      )
        throw new MirrorError(
          'VERIFICATION_SCOPE_FORBIDDEN',
          'Live Meta verification is restricted to GET requests for the authorized account.',
        );
      const response = await fetch(url, init);
      requests.push({path: target.pathname, status: response.status, trace_id: response.headers.get('x-fb-trace-id')});
      return response;
    }) as typeof fetch);
    const service = new MirrorService(new Registry(), store, transport);
    const rawProbes = [
      {action: 'meta_ad_account_id_get', query: {fields: 'id,account_id,account_status,currency,timezone_name'}},
      {action: 'meta_campaign_list', query: {fields: 'id,status', limit: 2}},
      {action: 'meta_adset_list', query: {fields: 'id,campaign_id,status', limit: 2}},
      {action: 'meta_ad_list', query: {fields: 'id,adset_id,campaign_id,status', limit: 2}},
      {
        action: 'meta_insights_get',
        query: {
          fields: 'account_id,impressions,clicks,spend,date_start,date_stop',
          date_preset: 'last_7d',
          level: 'account',
          limit: 2,
        },
      },
    ];
    const probes = prepareReadProbes(
      service,
      rawProbes.map(p => ({
        gateway: 'meta_native_action',
        arguments: {...p, account_id: account, connection_id: connectionId},
      })),
    );
    const runId = randomUUID(),
      directory = path.join('.mirror/PRIVATE/live-meta', runId);
    fs.mkdirSync(directory, {recursive: true});
    const results = [];
    for (let index = 0; index < probes.length; index++) {
      const probe = probes[index]!,
        requestId = randomUUID();
      try {
        const result = (await service.runPlan(
          probe.plan,
          {...probe.input, dry_run: false},
          actor,
          requestId,
        )) as JsonObject;
        fs.writeFileSync(
          path.join(directory, String(index + 1) + '.json'),
          clean({requestId, request: probe.plan, response: result}) + '\n',
        );
        const data = result.data;
        const summary = {
          action: probe.plan.action,
          success: result.success === true,
          request_id: requestId,
          rows: Array.isArray(data?.data) ? data.data.length : null,
          ...(index === 0
            ? {
                account_id: data?.account_id,
                currency: data?.currency,
                timezone: data?.timezone_name,
                account_status: data?.account_status,
              }
            : {}),
        };
        results.push(summary);
        process.stdout.write(clean(summary) + '\n');
      } catch (error) {
        const e =
          error instanceof MirrorError
            ? {code: error.code, message: error.message, details: error.details}
            : {code: 'VERIFY_FAILED', message: 'Meta read verification failed.'};
        fs.writeFileSync(
          path.join(directory, String(index + 1) + '.json'),
          clean({requestId, request: probe.plan, error: e}) + '\n',
        );
        results.push({action: probe.plan.action, success: false, request_id: requestId, error: e});
        process.stdout.write(clean(results.at(-1)) + '\n');
        // Stop probing on an auth, permission or throttle refusal; the provider-error taxonomy names Meta's
        // documented codes (190, 10/200-299, throttles) instead of UPSTREAM_ERROR.
        if (
          e.code === 'AUTH_EXPIRED' ||
          e.code === 'REAUTHORIZATION_REQUIRED' ||
          e.code === 'PROVIDER_PERMISSION_MISSING' ||
          e.code === 'PLATFORM_RATE_LIMIT' ||
          e.code === 'INSUFFICIENT_SCOPE' ||
          e.code === 'UPSTREAM_ERROR' ||
          e.code === 'UPSTREAM_UNAVAILABLE'
        )
          break;
      }
    }
    const evidence = {
      run_id: runId,
      captured_at: new Date().toISOString(),
      evidence: 'LIVE_INDEPENDENT_MIRROR_READ',
      account_id: account,
      connection_id: connectionId,
      planned_probes: probes.length,
      completed_probes: results.length,
      passed_probes: results.filter(r => r.success).length,
      success: results.length === probes.length && results.every(r => r.success),
      vendor_writes: 0,
      production_ready: false,
      requests,
      results,
    };
    fs.writeFileSync(path.join(directory, 'summary.json'), clean(evidence) + '\n');
    process.stdout.write(
      clean({
        summary: directory,
        success: evidence.success,
        passed_probes: evidence.passed_probes,
        planned_probes: probes.length,
        requests: requests.length,
        vendor_writes: 0,
      }) + '\n',
    );
    if (!evidence.success) process.exitCode = 1;
  } else
    throw new MirrorError('USAGE', 'Use provision, bind, permissions or verify, optionally followed by an account ID.');
} catch (error) {
  process.stderr.write(
    clean(
      error instanceof MirrorError
        ? {code: error.code, message: error.message, details: error.details}
        : {code: 'META_SETUP_FAILED', message: 'Meta connection setup failed.'},
    ) + '\n',
  );
  process.exitCode = 1;
} finally {
  secret = '';
  store.close();
}
