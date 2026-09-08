import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import type {JsonObject} from '../src/types.js';
test('normalized baseline Meta, Snapchat and TikTok previews match compiled HTTP method, path, query and body',()=>{
 const r=new Registry(),compiler=new Compiler(r),options={mode:'strict' as const,flags:{}};
 for(const f of JSON.parse(fs.readFileSync('tests/fixtures/amcp-september-previews.json','utf8')) as JsonObject[]){r.validate(f.gateway,f.input,options);const p=compiler.compile(f.gateway,f.input,options);assert.deepEqual({method:p.method,path:p.path,query:p.query,body:p.body},f.expected,f.gateway);}
});
