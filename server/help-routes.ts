import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Request, Response} from 'express';
import type {WebsiteSite} from './website-site.js';

/** The Help page's address: a workspace page of the route registry (web/routes.js), for signed-in members only. */
export const helpPath = '/help';
/** The owner guide as escaped HTML, one fragment per language, generated at build time by tools/help-pages.mjs. */
const guideFile = fileURLToPath(new URL('../../generated/help-guide.json', import.meta.url));
let guide: {en: string; ar: string} | undefined;
function guideFragments() {
  if (guide) return guide;
  const data = JSON.parse(fs.readFileSync(guideFile, 'utf8')),
    en = data?.languages?.en?.html,
    ar = data?.languages?.ar?.html;
  if (data?.generator !== 'tools/help-pages.mjs' || typeof en !== 'string' || typeof ar !== 'string')
    throw Error('HELP_GUIDE_UNAVAILABLE: generated/help-guide.json is not the guide tools/help-pages.mjs writes');
  guide = {en, ar};
  return guide;
}

/**
 * The members-only Help page (DOC-03; owner instruction of 2026-10-24: "DOCS AND HELP ARE MEMBERS ONLY"). /help answers
 * with the workspace shell, like every workspace page; for a signed-in member it also carries the owner guide, built
 * from docs/owner/ and docs/owner/ar/ at build time, in a hidden element that web/help.js shows in the interface
 * language. A visitor who is not signed in, a test account (whose scope has no Help page) and a member who must first
 * set up two-step verification get the shell alone, and the shell sends them on (sign-in, Home or Account). The answer
 * depends on the session cookie, so it is never stored by a cache. The guide is in no public file, sitemap or robots
 * entry, and the page adds nothing to the strict CSP: the fragments hold no script or style.
 */
export function helpRoutes({router, web, publicAssets}: WebsiteSite) {
  const member = (req: Request) => {
    try {
      const session = web.session(req);
      return !!session && session.actor.testAccount !== true && session.actor.mfaEnrollmentRequired !== true;
    } catch {
      return false;
    }
  };
  router.get(helpPath, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.vary('Cookie');
    const shell = publicAssets.html('index.html');
    if (!shell.includes('</main>')) throw Error('HELP_SHELL_UNAVAILABLE: web/index.html has no </main>');
    let content = '<div id="help-guide" class="help-guide" data-help-unavailable hidden></div>';
    if (member(req)) {
      const {en, ar} = guideFragments();
      content = '<div id="help-guide" class="help-guide" hidden>' + en + ar + '</div>';
    }
    // A function replacement: nothing in the guide is read as a replacement pattern.
    res.type('html').send(shell.replace('</main>', () => content + '</main>'));
  });
}
