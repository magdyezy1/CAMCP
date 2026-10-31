import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {browserWorkflowSite} from './fixtures/browser-workflow-sites.mjs';
import {createPublicAssets} from '../dist/server/public-assets.js';

test('both full static privacy policies are public without login, content scripts, cookies or provider reads', async () => {
  const site = await browserWorkflowSite('empty');
  try {
    for (const [query, locale] of [
      ['', 'en'],
      ['?lang=en', 'en'],
      ['?lang=ar', 'ar'],
      ['?lang=fr', 'en'],
      ['?lang=en&lang=ar', 'en'],
      ['?lang=../../private', 'en'],
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(site.origin + '/privacy' + query, {method, redirect: 'manual'}),
          body = await response.text();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('location'), null);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('content-language'), locale);
        assert.match(response.headers.get('content-type'), /^text\/html/);
        if (method === 'HEAD') {
          assert.equal(body, '');
          continue;
        }
        const publicAssets = createPublicAssets('web'),
          name = locale === 'ar' ? 'privacy-ar.html' : 'privacy.html';
        assert.equal(body, publicAssets.html(name));
        assert.equal(body.replace(/\/assets\/v\/[0-9a-f]{64}\//g, '/assets/'), fs.readFileSync('web/' + name, 'utf8'));
        assert.doesNotMatch(body, /<iframe\b/i);
        assert.deepEqual(
          [...body.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]),
          ['<script src="/assets/v/' + publicAssets.version + '/theme.js">'],
        );
        assert.match(body, locale === 'ar' ? /<html lang="ar" dir="rtl">/ : /<html lang="en" dir="ltr">/);
        // Updated for the retention periods and self-service deletion of owner decision P3 (SEC-07).
        assert.match(body, /datetime="2026-10-30"/);
        assert.match(body, /<a href="\/privacy\?lang=en"/);
        assert.match(body, /<a href="\/privacy\?lang=ar"/);
      }
    }
    assert.deepEqual(site.counts(), {nativeReads: 0, refused: 0, writes: 0, syntheticWrites: 0});
  } finally {
    await site.close();
  }
});

test('static privacy translations retain every section, technical scope, destination and policy structure', () => {
  const en = fs.readFileSync('web/privacy.html', 'utf8'),
    ar = fs.readFileSync('web/privacy-ar.html', 'utf8'),
    article = html => html.match(/<article>[\s\S]*?<\/article>/)[0],
    // Same-site legal links carry their page's language (WEB-05: the Arabic policy linked the English pages);
    // the destinations must still match.
    tags = html => [...article(html).matchAll(/<[^>]+>/g)].map(m => m[0].replace(/\?lang=(?:en|ar)"/, '?lang="')),
    sections = html => [...html.matchAll(/<section id="([^"]+)"/g)].map(m => m[1]),
    scopes = html => [...html.matchAll(/<code>(.*?)<\/code>/g)].map(m => m[1]);
  assert.deepEqual(sections(ar), [
    'data',
    'google',
    'use',
    'protection',
    'sharing',
    'retention',
    'choices',
    'contact',
    'meta',
    'authorities',
  ]);
  assert.deepEqual(sections(ar), sections(en));
  assert.deepEqual(scopes(ar), scopes(en));
  assert.deepEqual(
    tags(ar),
    tags(en),
    'Every paragraph, list, emphasis and linked destination has a translated counterpart',
  );
  for (const anchor of ar.matchAll(/href="#([^"]+)"/g)) assert.ok(ar.includes('id="' + anchor[1] + '"'));
  for (const native of [
    'SHA-256',
    'AES-256-GCM',
    'scrypt',
    'Secure',
    'HttpOnly',
    'SameSite',
    'S256 PKCE',
    'Railway',
    'Cloudflare',
    'privacy@amcp.shop',
  ])
    assert.ok(ar.includes(native));
});

test('each complete policy has a same-language canonical and reciprocal canonical language references', () => {
  for (const language of ['en', 'ar']) {
    const html = fs.readFileSync(language === 'ar' ? 'web/privacy-ar.html' : 'web/privacy.html', 'utf8');
    const canonical = language === 'ar' ? 'https://amcp.shop/privacy?lang=ar' : 'https://amcp.shop/privacy';
    assert.ok(html.includes('<link rel="canonical" href="' + canonical + '">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="en" href="https://amcp.shop/privacy">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="ar" href="https://amcp.shop/privacy?lang=ar">'));
  }
});
