import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const mapping = JSON.parse(fs.readFileSync('src/google-legacy-mapping.json', 'utf8'));
const queue = Object.entries(mapping.googleProto.sources),
  root = path.resolve('.mirror/VENDOR/google-proto');
let verified = 0;
async function worker() {
  while (queue.length) {
    const [name, source] = queue.shift();
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw Error('Unsafe source path');
    let content;
    if (fs.existsSync(file)) content = fs.readFileSync(file);
    else {
      const response = await fetch(source.url, {signal: AbortSignal.timeout(30000)});
      if (!response.ok) throw Error(name + ' HTTP ' + response.status);
      content = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(content).digest('hex') !== source.sha256)
      throw Error('Pinned source hash changed: ' + name);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, content);
    }
    verified++;
  }
}
await Promise.all(Array.from({length: 8}, worker));
console.log('Verified ' + verified + ' pinned official Google v23 source files.');
