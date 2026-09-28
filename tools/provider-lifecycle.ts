import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {providerMaintenance} from '../src/contract-evidence.js';
import type {JsonObject} from '../src/types.js';
const artifact = '.mirror/VENDOR/lifecycle-pages.json';
const sources = new Set(
  Object.values(providerMaintenance).flatMap(m => [m.changelog, ...(m.lifecycle ? [m.lifecycle] : [])]),
);
export function lifecycleText(html: string): string {
  // Compare visible documentation, not scripts, styles, comments or rotating headers.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  return main
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function checkLifecycle(
  source: string,
  previous: JsonObject | undefined,
  fetcher: typeof fetch,
): Promise<JsonObject> {
  if (!sources.has(source)) throw Error('Lifecycle sources must be exact maintained official URLs.');
  try {
    const response = await fetcher(source, {
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {Accept: 'text/html,text/plain'},
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const reader = response.body?.getReader();
    if (!reader) throw Error('Empty documentation response');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        bytes += r.value.length;
        if (bytes > 4 * 1024 * 1024) {
          await reader.cancel();
          throw Error('Documentation exceeds 4 MiB');
        }
        chunks.push(r.value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = lifecycleText(Buffer.concat(chunks).toString('utf8'));
    if (text.length < 200 || /just a moment|verify you are human|enable javascript and cookies/i.test(text))
      throw Error('Documentation content unavailable or blocked');
    const sha256 = createHash('sha256').update(text).digest('hex');
    return {
      source,
      sha256,
      characters: text.length,
      status:
        previous?.sha256 === sha256 ? 'unchanged' : previous?.sha256 ? 'changed_requires_review' : 'baseline_required',
      checked_at: new Date().toISOString(),
      qualification:
        'Public documentation change only; inspect the official page and relevant version before changing a contract. No account qualification.',
    };
  } catch (e) {
    return {
      source,
      status: 'fetch_failed',
      ...(previous?.sha256
        ? {
            sha256: previous.sha256,
            characters: previous.characters,
            baseline_checked_at: previous.baseline_checked_at ?? previous.checked_at,
          }
        : {}),
      error: e instanceof Error ? e.message : 'Unavailable',
      checked_at: new Date().toISOString(),
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const previous = fs.existsSync(artifact) ? JSON.parse(fs.readFileSync(artifact, 'utf8')) : {pages: []};
  for (const page of previous.pages)
    if (
      (!sources.has(page.source) && !process.argv.includes('--refresh')) ||
      (page.sha256 && !/^[0-9a-f]{64}$/.test(page.sha256))
    )
      throw Error('Invalid lifecycle snapshot provenance.');
  if (!process.argv.includes('--live') && !process.argv.includes('--refresh'))
    console.log(
      JSON.stringify(
        {
          mode: 'offline',
          sources: [...sources],
          baselined: previous.pages.filter((p: JsonObject) => p.sha256).length,
          meaning: 'Integrity/configuration only; run the public maintenance workflow for remote changes.',
        },
        null,
        2,
      ),
    );
  else {
    const pages = [];
    for (const source of sources)
      pages.push(
        await checkLifecycle(
          source,
          previous.pages.find((p: JsonObject) => p.source === source),
          fetch,
        ),
      );
    if (process.argv.includes('--refresh'))
      fs.writeFileSync(artifact, JSON.stringify({formatVersion: 1, pages}, null, 2) + '\n');
    console.log(JSON.stringify({mode: 'public-documentation-watch', pages}, null, 2));
    if (!process.argv.includes('--refresh') && pages.some(p => p.status !== 'unchanged')) process.exitCode = 1;
  }
}
