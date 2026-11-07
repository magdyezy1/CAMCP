// V2-WEB-01 pinned web/mark.svg to the previous mark's hash, as an immutable input to the new palette. On 2026-11-07
// the owner replaced the logo with AMCP_Brand_Kit_v1 and asked for it to be implemented
// (docs/records/BRAND-KIT-V1-2026-11-07.md), so that one pin changes, on the owner's instruction (package `brand`).
// Every logo file the site serves is now pinned to the kit's bytes. A logo file is never edited, redrawn, traced,
// recoloured, cropped or re-exported; a later kit replaces these files whole, together with this table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// [served file, the kit file it is a copy of, its length in bytes, its sha256]
const logoFiles = [
  [
    'web/mark.svg',
    '02_App_Icon/AMCP_App_Icon_Dark.svg',
    1441,
    '54baa75856b1c2f48a97f0122985c53b362c7a513358c0f5eafe8cc19b0f5c98',
  ],
  [
    'web/logo-ink.svg',
    '01_Logos/AMCP_Transparent_Ink.svg',
    3576,
    '74caa9d34192c8fab0f9a2bcfc7ba09ad16456bdc8f220d8bbfe1146de93b03d',
  ],
  [
    'web/logo-white.svg',
    '01_Logos/AMCP_Transparent_White.svg',
    3576,
    '8cf547fe877996155a908d1fddb19b50a8057dd8f21c2d4b4399255be2127aff',
  ],
  [
    'web/favicon.ico',
    '02_App_Icon/favicon.ico',
    7546,
    '626be31cad7e7608a18523fe44832c919b25c0e9e0091964ba3c0c3f5ab575e0',
  ],
  [
    'web/apple-touch-icon.png',
    '02_App_Icon/apple-touch-icon.png',
    10897,
    '05e03305268d9a2f686aa3a4a5cf4f5f7467195840a9b922606bc1f8d4d16d32',
  ],
];

test('every logo file the site serves is byte-identical to the brand kit', () => {
  for (const [file, kit, length, hash] of logoFiles) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, length, file + ' is a copy of ' + kit);
    assert.equal(sha(bytes), hash, file + ' is a copy of ' + kit);
  }
});

test('Git stores the logo files without line-ending or text conversion, as a Windows checkout adds them', () => {
  const attributes = fs.readFileSync('.gitattributes', 'utf8');
  assert.match(attributes, /^\*\.ico binary$/m);
  assert.match(attributes, /^\*\.png binary$/m);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-brand-'));
  try {
    const git = (...args) => execFileSync('git', args, {cwd: directory, stdio: 'pipe', windowsHide: true});
    git('init', '-q');
    fs.copyFileSync('.gitattributes', path.join(directory, '.gitattributes'));
    for (const [file] of logoFiles) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive: true});
      fs.copyFileSync(file, path.join(directory, file));
    }
    git('-c', 'core.autocrlf=true', 'add', '--', ...logoFiles.map(([file]) => file));
    for (const [file, kit, length, hash] of logoFiles) {
      const blob = git('cat-file', 'blob', ':' + file);
      assert.equal(blob.length, length, file + ' as Git stores it is a copy of ' + kit);
      assert.equal(sha(blob), hash, file + ' as Git stores it is a copy of ' + kit);
    }
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
