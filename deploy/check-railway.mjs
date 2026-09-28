import fs from 'node:fs';
// A successful Docker build alone does not check Railway's builder restrictions.
const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
if (/^\s*VOLUME\s/im.test(dockerfile))
  throw Error('Railway rejects Dockerfile VOLUME instructions. Attach /data as a Railway service volume.');
console.log('Railway Dockerfile compatibility check passed.');
