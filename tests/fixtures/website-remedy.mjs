import assert from 'node:assert/strict';

/**
 * WEB-03: how the website shows a server remedy. A remedy written for people is shown in the interface language. One
 * written for an MCP client (tool, action and argument names, `details.*` paths, "send the call again") is never shown
 * to a person: the page's own wording for that refusal takes its place, and the server's exact text stays under
 * Technical details. The classifier is the page's own (`agentDirected` in web/app.js); tests/website-presentation
 * checks it against MCP vocabulary. `f` runs the real error formatter with the refusal as `error`.
 */
export function assertWebsiteRemedy(f, display, hint, translated = hint) {
  f.context.websiteRemedyHint = hint;
  // A refusal the page always words itself (websiteWording in web/app.js: an uncertain write, design review 2026-10)
  // replaces the server's remedy as well; tests/shared-recovery-localization.test.mjs checks its safety facts.
  const owned = f.run("typeof websiteOwnMessage === 'function' && websiteOwnMessage(error) !== ''");
  if (owned || f.run('agentDirected(websiteRemedyHint)')) {
    assert.ok(!display.includes(hint), 'A remedy written for an MCP client is shown: ' + hint);
    assert.ok(!display.includes(translated), 'A remedy written for an MCP client is shown: ' + hint);
    const own = f.run('websiteRemedy(error)');
    assert.ok(own && display.includes(own), 'No website remedy replaces: ' + hint);
    assert.equal(f.run('agentDirected(websiteRemedy(error))'), false);
  } else assert.ok(display.includes(translated), 'The remedy is not shown: ' + hint);
}
