import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {brotliCompressSync, constants, gzipSync} from 'node:zlib';
import type {NextFunction, Request, Response} from 'express';

const compressible = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt']);

/** Chooses Brotli or gzip from an Accept-Encoding header; undefined when neither is acceptable. */
export function assetEncoding(header: string | undefined): 'br' | 'gzip' | undefined {
  const accepted = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    if (name) accepted.set(name, q ? Number(q.slice(2)) : 1);
  }
  const weight = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0;
  if (weight('br') > 0) return 'br';
  if (weight('gzip') > 0) return 'gzip';
  return undefined;
}

/**
 * Serves compressed copies of the text assets under `directory`, keeping the static handler's revalidation: each
 * encoding has its own ETag, `Vary: Accept-Encoding` keeps caches apart, and a matching If-None-Match is a 304. Copies
 * are made once per file version (size and modification time). Requests it does not handle (other methods or files,
 * no acceptable encoding, anything outside the directory or under a dot segment) go on to `next` unchanged.
 */
export function compressedAssets(directory: string) {
  const root = path.resolve(directory);
  const cache = new Map<string, {version: string; body: Buffer; etag: string}>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const encoding = assetEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();
    let relative: string;
    try {
      relative = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const segments = relative.split('/').filter(Boolean);
    if (!segments.length || segments.some(s => s.startsWith('.') || s.includes('\\') || s.includes('\0')))
      return next();
    const file = path.join(root, ...segments);
    if (!file.startsWith(root + path.sep) || !compressible.has(path.extname(file).toLowerCase())) return next();
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();
    const key = file + ':' + encoding,
      version = stat.size + ':' + stat.mtimeMs;
    let entry = cache.get(key);
    if (entry?.version !== version) {
      const bytes = fs.readFileSync(file);
      const body =
        encoding === 'br'
          ? brotliCompressSync(bytes, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}})
          : gzipSync(bytes, {level: 9});
      entry = {
        version,
        body,
        etag: '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '-' + encoding + '"',
      };
      cache.set(key, entry);
    }
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', entry.etag);
    res.type(path.extname(file));
    const match = req.headers['if-none-match'];
    if (match && match.split(',').some(tag => tag.trim() === entry.etag)) return void res.status(304).end();
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', String(entry.body.length));
    if (req.method === 'HEAD') return void res.end();
    res.end(entry.body);
  };
}
