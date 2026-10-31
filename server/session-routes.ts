import express from 'express';
import {accessSetView} from '../src/access-sets.js';
import {MirrorError} from '../src/errors.js';
import {downloadsAllowed, saveExportPolicy} from '../src/export-policy.js';
import {handler, type WebsiteSite} from './website-site.js';

/** The website session: who is signed in, the workspace and test doors, sign-out, and the export policy (SEC-05). */
export function sessionRoutes({
  router,
  store,
  web,
  accounts,
  social,
  allowWrites,
  providerJobs,
  connections: views,
}: WebsiteSite) {
  const {workingClientChoices} = views;
  router.get(
    '/api/session',
    handler((req, res) => {
      const session = web.session(req);
      res.json({
        authenticated: !!session,
        configured: web.configured,
        testConfigured: web.testConfigured,
        csrf: session?.csrf ?? null,
        ...(session ? accounts.profile(session) : {name: null}),
        // Whether this person may download report files (SEC-05); the download routes enforce it.
        ...(session ? {downloadsAllowed: downloadsAllowed(store, session.actor)} : {}),
        // The client access set this member is limited to (SEC-08), or null for the whole workspace.
        ...(session ? {accessSet: accessSetView(store, session.actor)} : {}),
        // The working client's choices (SEC-08), so no page waits for another request to narrow its pickers.
        ...(session ? {workingClients: workingClientChoices(session.actor)} : {}),
        origin: web.origin,
        readOnly: !allowWrites,
        writesEnabled: allowWrites,
        // RPT-06: the deployment owner's switch for provider report and export jobs (AMCP_PROVIDER_JOBS). Provider jobs
        // stay outside a test account's scope (docs/TEST-ACCOUNTS.md), so its pages do not offer them.
        providerJobs: providerJobs && !session?.actor.testAccount,
      });
    }),
  );
  // The workspace owner decides whether viewers may download report files (SEC-05, account_settings/exports).
  router.post(
    '/api/export-policy',
    express.json({limit: '4kb'}),
    handler((req, res) => {
      const s = web.requireMutation(req);
      res.json(saveExportPolicy(store, s.actor, req.body && typeof req.body === 'object' ? req.body : {}));
    }),
  );
  router.post(
    '/api/session',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      web.requireOrigin(req);
      if (typeof req.body?.password !== 'string')
        throw new MirrorError('INVALID_LOGIN', 'Enter your workspace password.', {}, 400);
      const old = web.session(req),
        session = await web.signIn(req.body.password, web.limitAddress(req));
      if (old) web.signOut(old.id);
      res.setHeader('Set-Cookie', web.cookie(session.id));
      res.json({authenticated: true, csrf: session.csrf, name: 'Workspace administrator'});
    }),
  );
  router.post(
    '/api/session/test',
    express.json({limit: '4kb'}),
    handler(async (req, res) => {
      web.requireOrigin(req);
      if (typeof req.body?.password !== 'string')
        throw new MirrorError('INVALID_LOGIN', 'Enter the test password.', {}, 400);
      const old = web.session(req),
        session = await web.signInTest(req.body.password, web.limitAddress(req));
      if (old) web.signOut(old.id);
      res.setHeader('Set-Cookie', web.cookie(session.id));
      res.json({authenticated: true, csrf: session.csrf, name: 'Test reviewer'});
    }),
  );
  router.delete(
    '/api/session',
    handler((req, res) => {
      const session = web.requireMutation(req);
      web.signOut(session.id);
      res.setHeader('Set-Cookie', [web.cookie('', 0), social.cookie('', 0)]);
      res.json({success: true});
    }),
  );
}
