import express from 'express';
import {randomUUID} from 'node:crypto';
import {disconnectLocalConnection} from '../src/connection-disconnect.js';
import {clearRefreshFailure} from '../src/connection-health.js';
import {MirrorError} from '../src/errors.js';
import {providerOf} from '../src/provider-adapters.js';
import {reportJobAccounts, saveReportJobAccess} from '../src/provider-jobs.js';
import {providerLogin} from '../src/provider-logins.js';
import {disconnectWithProviderRevocation} from '../src/provider-revocation.js';
import {approvalView, approveReview} from '../src/write-approval.js';
import type {AssetGroup} from './asset-discovery.js';
import {authorizationRevision, reauthorizationEnabled} from './connection-reauthorization.js';
import {platforms, selectableKinds} from './platform-oauth.js';
import {saveWebsiteAssets, writeDefaultFlag} from './website-repository.js';
import {commerceGateway, handler, type WebsiteSite} from './website-site.js';

/**
 * A login's management: its view, renewal in place (CON-02), credential retry, asset sync and selection, report-job
 * and write access (with recent proof of identity for every grant, SEC-06), the default login, its name and its
 * removal (CON-05); and the website approval of one reviewed change (WRT-09). The routes register in this order; the
 * asset selection and the write-access change are their own steps (ARC-04: no route module function near 400 lines).
 */
export function connectionRoutes(site: WebsiteSite) {
  const {router, store, web, options, providerJobs, oauth, webAccounts, connections: views} = site;
  const {connection, readDocument, writeLabel, publicConnection, actorConnection, visibleConnection, sync} = views;
  router.get(
    '/api/connections/:id',
    handler((req, res) => {
      const s = web.requireSession(req);
      res.json(visibleConnection(s.actor, actorConnection(s.actor, String(req.params.id))));
    }),
  );
  router.post(
    '/api/connections/:id/reauthorize',
    handler(async (req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id)),
        p = platforms.find(p => p.gateway === c.gateway);
      // Every browser-OAuth login renews in place (CON-02); AMCP_REAUTHORIZATION_DISABLED turns a platform off again.
      if (!p || p.authType || !reauthorizationEnabled(p, options.authEnv ?? process.env))
        throw new MirrorError(
          'REAUTHORIZATION_UNAVAILABLE',
          'Reauthorization in place is not available for this connection. Use Connect another for this platform.',
          {},
          400,
        );
      res.json(
        await oauth.start(s, p.id, {
          connectionId: c.id,
          revision: authorizationRevision(store, s.actor.tenantId, c.id),
        }),
      );
    }),
  );
  router.post(
    '/api/connections/:id/credential-retry',
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id));
      // An administrator's explicit Retry after a recorded renewal failure; the next request may refresh again.
      const cleared = clearRefreshFailure(store, c);
      if (cleared)
        store.appendAudit(s.actor.tenantId, randomUUID(), {
          event: 'website_credential_retry',
          connection_id: c.id,
          vendor_writes: 0,
        });
      res.json({...publicConnection(s.actor.tenantId, connection(s.actor.tenantId, c.id)), retry: cleared});
    }),
  );
  router.post(
    '/api/connections/:id/sync',
    express.json({limit: '8kb'}),
    handler(async (req, res) => {
      const s = web.requireAdminMutation(req),
        c = connection(s.actor.tenantId, String(req.params.id));
      if (c.gateway === commerceGateway)
        throw new MirrorError(
          'SOURCE_READ_ONLY',
          'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
        );
      const kinds = req.body?.kinds;
      if (
        kinds !== undefined &&
        (!Array.isArray(kinds) || kinds.length > 8 || kinds.some((k: unknown) => typeof k !== 'string'))
      )
        throw new MirrorError('INVALID_ARGUMENT', 'Select valid asset types.');
      res.json(
        await sync(
          s.actor.tenantId,
          c,
          () => {
            web.requireAdminMutation(req);
          },
          kinds,
        ),
      );
    }),
  );
  router.patch('/api/connections/:id/assets', express.json({limit: '256kb'}), selectAssets(site));
  // RPT-06: the accounts on which AI clients and members, readers included, may create provider report and export jobs
  // while the deployment owner's switch (AMCP_PROVIDER_JOBS) is on. A workspace administrator decides; removing a grant
  // always works, adding one needs the switch, explicit confirmation and recent proof of identity (as write access does).
  router.patch(
    '/api/connections/:id/report-job-access',
    express.json({limit: '256kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id)),
        accounts = req.body?.accounts,
        previous = reportJobAccounts(store, c);
      if (Array.isArray(accounts) && accounts.some(id => !previous.includes(id))) webAccounts.fresh(s);
      saveReportJobAccess(store, s.actor, c, req.body ?? {}, providerJobs);
      res.json(publicConnection(tenant, connection(tenant, c.id)));
    }),
  );
  // WRT-09 (owner decisions P1 and P5): a signed-in person approves one exact reviewed change on the website,
  // outside any AI client. Only these routes mint an approval: a session with CSRF and recent sign-in, never an MCP
  // tool.
  router.get(
    '/api/write-approvals/:id',
    handler((req, res) => {
      const s = web.requireSession(req);
      res.setHeader('Cache-Control', 'no-store');
      res.json(approvalView(store, s.actor, String(req.params.id)));
    }),
  );
  router.post(
    '/api/write-approvals/:id',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req);
      webAccounts.fresh(s);
      res.setHeader('Cache-Control', 'no-store');
      res.json(approveReview(store, s.actor, String(req.params.id), req.body ?? {}));
    }),
  );
  router.patch('/api/connections/:id/write-access', express.json({limit: '256kb'}), changeWriteAccess(site));
  router.post(
    '/api/connections/:id/default',
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id));
      // Resolution ignores a disabled login, so a disabled default would be silently ignored (CON-05).
      if (!c.enabled)
        throw new MirrorError(
          'CONNECTION_DISABLED',
          'Choose assets for this login before making it the default.',
          {connection_id: c.id},
          409,
        );
      const previous = store
        .listConnections(tenant)
        .filter(x => x.gateway === c.gateway && x.isDefault === true && x.id !== c.id)
        .map(x => x.id);
      store.transaction(() => {
        for (const existing of store.listConnections(tenant).filter(x => x.gateway === c.gateway))
          writeDefaultFlag(store, tenant, existing, existing.id === c.id);
      });
      store.appendAudit(tenant, randomUUID(), {
        event: 'website_default_connection',
        connection_id: c.id,
        previous_default: previous[0] ?? null,
      });
      res.json({success: true});
    }),
  );
  // An administrator names a login (CON-05). Only the label changes, so the login revision, grants and readiness stay;
  // later syncs keep the name. The audit records the rename, not the name, which may name a person.
  router.patch(
    '/api/connections/:id/label',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id)),
        label = typeof req.body?.label === 'string' ? req.body.label.replace(/\s+/g, ' ').trim() : '';
      if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label))
        throw new MirrorError('INVALID_ARGUMENT', 'Use a login name of 1 to 80 characters.');
      store.transaction(() => {
        writeLabel(tenant, c.id, label);
        const {id: _id, revision: _revision, ...record} = readDocument(tenant, 'website_connection', c.id, {});
        store.putDocument(tenant, 'website_connection', c.id, {...record, labelCustom: true});
      });
      store.appendAudit(tenant, randomUUID(), {
        event: 'website_connection_renamed',
        connection_id: c.id,
        gateway: c.gateway,
        vendor_writes: 0,
      });
      res.json(publicConnection(tenant, connection(tenant, c.id)));
    }),
  );
  router.delete(
    '/api/connections/:id',
    express.json({limit: '1kb'}),
    handler(async (req, res) => {
      const s = web.requireAdminMutation(req),
        tenant = s.actor.tenantId,
        c = connection(tenant, String(req.params.id)),
        revoke = req.body?.revoke_at_provider;
      if (revoke !== undefined && typeof revoke !== 'boolean')
        throw new MirrorError('INVALID_ARGUMENT', 'revoke_at_provider is true or false.');
      // CON-05 sub-item 10: an explicitly confirmed provider-side revocation, only where the owner turned it on.
      if (revoke) {
        const receipt = await disconnectWithProviderRevocation(store, s.actor, c.gateway, c.id, {
          fetcher: options.fetcher,
          env: options.authEnv ?? process.env,
          recheck: () => web.requireAdminMutation(req),
        });
        res.json({success: true, provider_revocation: receipt.provider_revocation ?? null});
        return;
      }
      disconnectLocalConnection(store, s.actor, c.gateway, c.id, 'website');
      res.json({success: true});
    }),
  );
}

/**
 * PATCH /api/connections/:id/assets: an administrator's selection of a login's synced assets, the write grants it
 * keeps or adds (each added grant with explicit consent and recent proof of identity) and the accounts' manager routes.
 */
function selectAssets({store, web, allowWrites, webAccounts, connections: views}: WebsiteSite) {
  const {connection, savedAssets, publicConnection} = views;
  return handler((req, res) => {
    const s = web.requireAdminMutation(req),
      tenant = s.actor.tenantId,
      c = connection(tenant, String(req.params.id)),
      assets = savedAssets(tenant, c),
      selected = req.body?.selected;
    if (c.gateway === commerceGateway)
      throw new MirrorError(
        'SOURCE_READ_ONLY',
        'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
      );
    if (
      !Array.isArray(selected) ||
      selected.length > 10000 ||
      selected.some(k => typeof k !== 'string') ||
      new Set(selected).size !== selected.length
    )
      throw new MirrorError('INVALID_ASSET_SELECTION', 'Select valid, unique assets.');
    const known = new Set((assets.groups ?? []).flatMap((g: AssetGroup) => g.assets.map(a => g.kind + ':' + a.id)));
    if (selected.some(k => !known.has(k)))
      throw new MirrorError('UNKNOWN_ASSET', 'Sync assets before selecting them.', {}, 409);
    const kinds = selectableKinds(c.gateway),
      kindOf = (k: string) => kinds.find(kind => k.startsWith(kind + ':'));
    if (selected.some(k => !kindOf(k)))
      throw new MirrorError(
        'INVALID_ASSET_SELECTION',
        'Select the platform’s primary accounts, properties or sites for MCP access. Other tabs show related inventory.',
      );
    const accounts = selected.map(k => k.slice(kindOf(k)!.length + 1));
    if (new Set(accounts).size !== accounts.length)
      throw new MirrorError('INVALID_ASSET_SELECTION', 'Select valid, unique assets.');
    if (req.body?.write_access !== undefined && typeof req.body.write_access !== 'boolean')
      throw new MirrorError('INVALID_WRITE_ACCOUNTS', 'write_access must be a boolean.');
    const sourceOnly = platforms.find(p => p.gateway === c.gateway)?.reviewedWrites === false;
    if (sourceOnly && req.body.write_access === true)
      throw new MirrorError('SOURCE_READ_ONLY', 'Drive is a read-only media source.');
    const defaultWriteAccess = sourceOnly ? false : (req.body.write_access ?? c.defaultWriteAccess === true);
    if (req.body.write_access === true && !allowWrites)
      throw new MirrorError('WRITES_DISABLED', 'Reviewed writes are disabled in this deployment.', {}, 403);
    const writeAccounts = sourceOnly
      ? []
      : defaultWriteAccess && allowWrites
        ? accounts
        : req.body.write_access === false
          ? []
          : (c.writeAccounts ?? []).filter(id => accounts.includes(id));
    // Every write grant a selection adds needs the same explicit consent as the write-access panel, including accounts
    // added to an existing login later (owner decision D19, CON-05). Read-only selections and removals need none.
    const previousWrites = (c.writeAccounts ?? []).filter(id => c.accounts.includes(id)),
      writeAdded = writeAccounts.filter(id => !previousWrites.includes(id)),
      writeRemoved = previousWrites.filter(id => !writeAccounts.includes(id));
    if (writeAdded.length && req.body?.confirmed !== true)
      throw new MirrorError(
        'WRITE_ACCESS_CONFIRMATION_REQUIRED',
        'This selection enables write access for more resources. Confirm that operator connectors may change them.',
        {added: writeAdded.slice(0, 200), added_count: writeAdded.length},
        400,
      );
    // How each selected account is reached, on a login whose provider keeps it: its adapter's account model names the
    // field (Microsoft's parent customers, Google Ads' manager routes) and its login steps read the routes from the
    // discovered accounts. Any other field stays as saved.
    const routes = providerOf(c.gateway)?.account?.routes,
      routed = () =>
        providerLogin(c.gateway)!.routes!(
          (assets.groups as AssetGroup[]).flatMap(g => g.assets).filter(a => a.kind === 'ad_accounts'),
          accounts,
        );
    const accountCustomers = routes === 'accountCustomers' ? routed() : c.accountCustomers;
    const accountLoginCustomers = routes === 'accountLoginCustomers' ? routed() : c.accountLoginCustomers;
    // A selection that adds write access needs recent proof of identity (SEC-06); keeping or removing it never does.
    if (writeAccounts.some(id => !(c.writeAccounts ?? []).includes(id))) webAccounts.fresh(s);
    store.transaction(() => {
      store.updateConnection(s.actor, {
        ...c,
        accounts,
        accountCustomers,
        accountLoginCustomers,
        writeAccounts,
        defaultWriteAccess,
        enabled: accounts.length > 0,
      });
      saveWebsiteAssets(store, tenant, c.id, {...assets, selected});
    });
    store.appendAudit(tenant, randomUUID(), {
      event: 'website_asset_selection',
      connection_id: c.id,
      selected_accounts: accounts,
      selected_assets: selected.length,
      write_added: writeAdded,
      write_removed: writeRemoved,
      ...(writeAdded.length ? {write_confirmed: true} : {}),
      vendor_writes: 0,
    });
    res.json(publicConnection(tenant, connection(tenant, c.id)));
  });
}

/**
 * PATCH /api/connections/:id/write-access: an administrator's write grants on a login's selected resources, each added
 * grant with explicit consent and recent proof of identity; removing one never needs either.
 */
function changeWriteAccess({store, web, allowWrites, webAccounts, connections: views}: WebsiteSite) {
  const {connection, publicConnection} = views;
  return handler((req, res) => {
    const s = web.requireAdminMutation(req),
      tenant = s.actor.tenantId,
      c = connection(tenant, String(req.params.id)),
      accounts = req.body?.accounts;
    if (c.gateway === commerceGateway)
      throw new MirrorError(
        'SOURCE_READ_ONLY',
        'WooCommerce connections are read-only catalog sources. Manage them in Commerce.',
      );
    if (s.actor.role !== 'admin')
      throw new MirrorError('FORBIDDEN', 'Only the workspace administrator can change write access.', {}, 403);
    if (
      !Array.isArray(accounts) ||
      accounts.length > 10000 ||
      accounts.some(id => typeof id !== 'string') ||
      new Set(accounts).size !== accounts.length
    )
      throw new MirrorError('INVALID_WRITE_ACCOUNTS', 'Select valid, unique resources for write access.');
    if (accounts.length && platforms.find(p => p.gateway === c.gateway)?.reviewedWrites === false)
      throw new MirrorError('SOURCE_READ_ONLY', 'Drive is a read-only media source.');
    if (accounts.length && (!allowWrites || !c.enabled))
      throw new MirrorError(
        'WRITES_DISABLED',
        'Enable deployment write support and select resources before granting write access.',
        {},
        403,
      );
    if (accounts.some(id => !c.accounts.includes(id)))
      throw new MirrorError(
        'WRITE_ACCOUNT_NOT_SELECTED',
        'Write access is limited to this login’s selected resources.',
        {},
        403,
      );
    if (accounts.length && req.body?.confirmed !== true)
      throw new MirrorError(
        'WRITE_ACCESS_CONFIRMATION_REQUIRED',
        'Explicitly confirm that operator connectors may change these resources.',
        {},
        400,
      );
    // Adding write access needs recent proof of identity (SEC-06); removing it never does.
    if (accounts.some(id => !(c.writeAccounts ?? []).includes(id))) webAccounts.fresh(s);
    store.updateConnection(s.actor, {...c, writeAccounts: accounts, defaultWriteAccess: false});
    store.appendAudit(tenant, randomUUID(), {
      event: 'website_write_access_changed',
      connection_id: c.id,
      write_accounts: accounts,
      previous_write_accounts: c.writeAccounts ?? [],
      vendor_writes: 0,
    });
    res.json(publicConnection(tenant, connection(tenant, c.id)));
  });
}
