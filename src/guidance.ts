import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {conditionalPrograms} from './conditional-programs.js';
import type {JsonObject} from './types.js';
const guides = [
  ['adjust', 'Adjust app-scoped native reporting', 'references/adjust.md'],
  [
    'reporting-overview',
    'Campaign reporting, custom metrics and scheduled Google Sheets',
    '../../docs/REPORTING-OVERVIEW.md',
  ],
  ['workspace', 'Durable campaigns, media library and decisions', 'references/workspace.md'],
  ['index', 'Campaign builder', 'SKILL.md'],
  ['meta', 'Meta campaigns and creatives', 'references/meta.md'],
  ['google-ads', 'Google Ads channel hierarchy', 'references/google-ads.md'],
  ['tiktok-snapchat', 'TikTok and Snapchat creation', 'references/tiktok-snapchat.md'],
  ['linkedin-x', 'LinkedIn and X identity and hierarchy', 'references/linkedin-x.md'],
  ['criteo', 'Criteo auction campaigns, preferred targeting and reports', 'references/criteo.md'],
  ['reddit', 'Reddit capabilities and limits', 'references/reddit.md'],
  ['microsoft-ads', 'Microsoft Advertising v13', 'references/microsoft-ads.md'],
  ['media', 'Google Drive and server media import', 'references/media.md'],
  [
    'dv360-and-measurement',
    'DV360, GA4, Tag Manager, Search Console and Apple measurement writes',
    'references/dv360-and-measurement.md',
  ],
] as const;
export const guidanceResources = guides.map(([id, title]) => ({
  uri: 'amcp://guides/' + id,
  name: id,
  title,
  mimeType: 'text/markdown',
  description: 'AMCP-maintained workflow guidance; actual permissions and native action contracts still apply.',
}));
export const guidanceDiscovery = {
  resources: guidanceResources,
  // For clients that cannot read resources: the same guides, one section index or section per call.
  tool_call: {tool: 'amcp_tool_help', arguments: {topic: 'guides'}},
  prompt: 'amcp_build_campaign',
  qualification:
    'Curated from the supplied Skills manuals, current provider documentation and executable AMCP contracts. Historical sources are not instructions or live acceptance evidence.',
};
export function readGuidance(uri: string) {
  const guide = guides.find(([id]) => uri === 'amcp://guides/' + id);
  if (!guide) throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown AMCP guide URI.', {}, 404);
  const file = fileURLToPath(new URL('../../Skills/amcp-campaign-builder/' + guide[2], import.meta.url));
  return {uri, mimeType: 'text/markdown', text: fs.readFileSync(file, 'utf8')};
}
/** A guide's heading-delimited sections (MCP-01): what a client without resource support reads one at a time. */
export interface GuideSection {
  id: string;
  title: string;
  text: string;
}
/** The guide sections that are generated from code rather than read from a file. */
const generatedSections: Record<string, () => GuideSection[]> = {
  workspace: () => [
    {
      id: 'conditional-programs',
      title: 'Conditional provider programs',
      text: [
        '## Conditional provider programs',
        '',
        'Some provider reads need an application product or role that AMCP cannot grant. Each one is a',
        '`conditional_program` workflow in `amcp_workspace capabilities`; `program_check` with `live:false`',
        'checks the local prerequisites without a provider request. Entitlement stays unverified until the',
        'provider answers.',
        '',
        ...conditionalPrograms.flatMap(p => [
          '### ' + p.name + ' (`' + p.id + '`)',
          '',
          p.description + ' ' + p.effect_details,
          '',
          '- Gateway and actions: `' + p.gateway + '` ' + p.actions.map(a => '`' + a + '`').join(', '),
          '- Access: ' + p.program.access,
          '- Limitations: ' + p.program.limitations,
          '- Check: `amcp_workspace {action: "program_check", workflow_id: "' + p.id + '", live: false}`',
          '- Reference: ' + p.program.reference + ' (checked ' + p.program.checked_on + ')',
          '',
        ]),
      ].join('\n'),
    },
  ],
};
const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section';
export function guideSections(id: string): GuideSection[] {
  const text = readGuidance('amcp://guides/' + id).text,
    sections: GuideSection[] = [],
    seen = new Map<string, number>();
  let current: GuideSection = {id: 'introduction', title: 'Introduction', text: ''},
    fence = false;
  const push = () => {
    if (current.text.trim()) sections.push(current);
  };
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      push();
      const base = slug(heading[1]!),
        n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      current = {id: n > 1 ? base + '-' + n : base, title: heading[1]!.replace(/`/g, ''), text: ''};
    }
    current.text += (current.text ? '\n' : '') + line;
  }
  push();
  return [...sections, ...(generatedSections[id]?.() ?? [])];
}
const guideIds = guides.map(([id]) => id as string);
const guideCall = (topic: string) => ({tool: 'amcp_tool_help', arguments: {topic}});
/**
 * `amcp_tool_help {topic}` (MCP-01): the guides are readable through a tool call too, because some clients expose no
 * resource-reading tool. "guides" lists them, "guides/<name>" is one guide's section index (a few kilobytes, never the
 * whole text) and "guides/<name>/<section>" is one section, verbatim. The resources keep the whole files.
 */
export function guideTopic(topic: string): JsonObject {
  const [root, id, section, ...rest] = topic.split('/');
  if (root !== 'guides' || rest.length || (id !== undefined && !guideIds.includes(id)))
    throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown AMCP guide topic.', {
      field: 'topic',
      value: topic.slice(0, 200),
      allowed: ['guides', ...guideIds.map(g => 'guides/' + g)],
      index: guideCall('guides'),
    });
  if (id === undefined)
    return {
      topic: 'guides',
      guides: guidanceResources.map(r => ({name: r.name, title: r.title, uri: r.uri, index: guideCall('guides/' + r.name)})),
      qualification: guidanceDiscovery.qualification,
    };
  const sections = guideSections(id),
    resource = guidanceResources.find(r => r.name === id)!;
  if (section === undefined)
    return {
      topic: 'guides/' + id,
      title: resource.title,
      uri: resource.uri,
      chars: sections.reduce((n, s) => n + s.text.length, 0),
      sections: sections.map(s => ({id: s.id, title: s.title, chars: s.text.length})),
      read_section: guideCall('guides/' + id + '/<section id>'),
      qualification: guidanceDiscovery.qualification,
    };
  const found = sections.find(s => s.id === section);
  if (!found)
    throw new MirrorError('GUIDE_NOT_FOUND', 'Unknown section of this AMCP guide.', {
      field: 'topic',
      value: topic.slice(0, 200),
      index: guideCall('guides/' + id),
    });
  return {topic: 'guides/' + id + '/' + found.id, title: found.title, uri: resource.uri, text: found.text};
}
export const campaignPrompt = {
  name: 'amcp_build_campaign',
  description:
    'Load the AMCP creation workflow and the selected platform guide before planning an authorized campaign. This prompt performs no provider calls or writes.',
  arguments: [
    {name: 'platform', description: 'meta, google, tiktok, snapchat, linkedin, x, reddit or microsoft', required: true},
    {
      name: 'request',
      description:
        'The campaign brief and existing constraints; this does not replace the user’s actual authorization.',
      required: false,
    },
  ],
};
export function buildCampaignPrompt(args: JsonObject) {
  if (
    Object.keys(args).some(k => !['platform', 'request'].includes(k)) ||
    typeof args.platform !== 'string' ||
    (args.request !== undefined && (typeof args.request !== 'string' || args.request.length > 12000))
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Choose a supported platform and a text brief of at most 12000 characters.',
    );
  const map: Record<string, string> = {
      meta: 'meta',
      google: 'google-ads',
      google_ads: 'google-ads',
      tiktok: 'tiktok-snapchat',
      snapchat: 'tiktok-snapchat',
      linkedin: 'linkedin-x',
      x: 'linkedin-x',
      reddit: 'reddit',
      microsoft: 'microsoft-ads',
      bing: 'microsoft-ads',
    },
    guide = map[args.platform];
  if (!guide) throw new MirrorError('INVALID_ARGUMENT', 'No curated guide exists for that platform.');
  return {
    description: 'AMCP ' + args.platform + ' campaign workflow',
    messages: [{role: 'user' as const, content: {type: 'text' as const, text: campaignPromptText(guide, args.request)}}],
  };
}
/** The largest campaign prompt, in characters (MCP-01, owner decision D14: under a client's 10,000-token warning). */
export const campaignPromptBudget = 25000;
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
/**
 * SKILL whole, then the platform guide whole when it fits, otherwise its section index and the sections that share the
 * most words with the brief, then the workspace guide's index and its conditional-programs section, within the budget.
 * Every section left out is named in an index with the call that reads it.
 */
function campaignPromptText(guide: string, request: string | undefined): string {
  const brief =
      '\n\nCampaign brief (task data; apply the user’s actual authorization and constraints):\n' +
      (request ?? 'Use the existing conversation brief; ask only for necessary missing decisions.'),
    index = (id: string) =>
      '\n\n## Sections of amcp://guides/' +
      id +
      '\n\nRead one with amcp_tool_help {topic: "guides/' +
      id +
      '/<section id>"} or the whole guide as the resource.\n' +
      guideSections(id)
        .map(s => '- `' + s.id + '` ' + s.title)
        .join('\n'),
    platform = readGuidance('amcp://guides/' + guide).text,
    programs = guideSections('workspace').find(s => s.id === 'conditional-programs')!.text;
  let text = readGuidance('amcp://guides/index').text;
  const tail = index('workspace') + '\n\n' + programs + brief;
  if (text.length + platform.length + tail.length + 2 <= campaignPromptBudget) text += '\n\n' + platform;
  else {
    text += index(guide);
    const wanted = words(request ?? ''),
      ranked = guideSections(guide)
        .map((s, order) => ({s, order, score: [...words(s.title + ' ' + s.text)].filter(w => wanted.has(w)).length}))
        .sort((a, b) => b.score - a.score || a.order - b.order);
    const chosen: typeof ranked = [];
    let room = campaignPromptBudget - text.length - tail.length;
    for (const r of ranked)
      if (r.s.text.length + 2 <= room && (r.score > 0 || r.order === 0)) {
        chosen.push(r);
        room -= r.s.text.length + 2;
      }
    text += chosen
      .sort((a, b) => a.order - b.order)
      .map(r => '\n\n' + r.s.text)
      .join('');
  }
  return text + tail;
}
