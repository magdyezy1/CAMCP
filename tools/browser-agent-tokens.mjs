// WEB-03: the website words its messages for people. The server writes its refusals and run outcomes for MCP clients
// as well, naming the calls and flags an assistant sends ("execute_next with it continues the step", "details.next_call",
// "confirmed: true"); the page replaces them with its own wording and keeps the server's exact text under Technical
// details. This probe reads every message a person is shown in the rendered page (alerts, status regions, notices,
// errors and toasts) and reports any that names that vocabulary. The server's exact text under a Technical details
// or record details disclosure is excluded, as is anything hidden.

/** MCP-client vocabulary a message shown to a person never contains. */
export const agentTokenSource =
  '\\b(?:execute_next|next_call|prepare_next|recover_step|reconcile_step|add_after_user_approval)\\b|\\bconfirmed:\\s*true\\b|\\bdetails\\.[a-z_]+';
/** Where the website shows a message to a person. */
export const messageSurfaces =
  '[role=alert], [role=status], .notice, .error, .toast, #toast, .run-outcome, .workspace-form-feedback';
/** Disclosures that keep the server's exact text for support, never shown as the message itself. */
export const technicalDisclosures = 'details.error-technical, details.workspace-details';

/** Runs in the page: the visible text of each message surface that names MCP-client vocabulary. */
export function collectAgentTokenMessages({source, surfaces, technical}) {
  const pattern = new RegExp(source),
    seen = new Set(),
    hits = [];
  const visible = element =>
    typeof element.checkVisibility === 'function'
      ? element.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
      : element.getClientRects().length > 0;
  for (const surface of document.querySelectorAll(surfaces)) {
    // A surface inside another one is read once, with its outer surface.
    if ([...seen].some(outer => outer.contains(surface)) || !visible(surface)) continue;
    seen.add(surface);
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT),
      parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest(technical) || !visible(parent)) continue;
      parts.push(node.nodeValue);
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim(),
      match = pattern.exec(text);
    if (match)
      hits.push({
        surface:
          surface.tagName.toLowerCase() +
          (surface.id ? '#' + surface.id : '') +
          [...surface.classList].map(name => '.' + name).join(''),
        token: match[0],
        text: text.slice(0, 200),
      });
  }
  return hits;
}

/** The messages in `page` that name MCP-client vocabulary; an empty list means every message addresses a person. */
export async function agentTokenProbe(page) {
  return page.evaluate(collectAgentTokenMessages, {
    source: agentTokenSource,
    surfaces: messageSurfaces,
    technical: technicalDisclosures,
  });
}
