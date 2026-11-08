import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractZip } from '../app/core/archive.mjs';

import { zipFixture } from './fixtures/zip.mjs';

async function fixture(t, entries) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lc-zip-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const archive=path.join(root,'game.zip');await fs.writeFile(archive,zipFixture(entries));return {root,archive,dest:path.join(root,'extracted')};
}
test('ZIP extraction handles a wrapper folder, preserves launch permissions, and retains archive',async t=>{
  const {archive,dest}=await fixture(t,[['NewGame/game/script.rpy','new code'],['NewGame/launch.sh','#!/bin/sh',0o100755]]);
  const output=await extractZip(archive,dest);assert.equal(output,path.join(dest,'NewGame'));
  assert.equal(await fs.readFile(path.join(output,'game','script.rpy'),'utf8'),'new code');
  assert.ok((await fs.stat(path.join(output,'launch.sh'))).mode&0o111);
  assert.ok((await fs.stat(archive)).isFile());
});
test('ZIP path traversal cannot write outside its extraction directory',async t=>{
  const {archive,dest,root}=await fixture(t,[['../escaped.txt','malicious']]);
  await assert.rejects(extractZip(archive,dest));
  await assert.rejects(fs.access(path.join(root,'escaped.txt')));
});
test('ZIP symbolic links are rejected instead of writing through them',async t=>{
  const {archive,dest}=await fixture(t,[['game/link','/somewhere',0o120777]]);
  await assert.rejects(extractZip(archive,dest),/symbolic links/);
});
test('cancelled extraction preserves the compressed download',async t=>{
  const {archive,dest}=await fixture(t,[['game/file','hello']]);const controller=new AbortController();controller.abort();
  await assert.rejects(extractZip(archive,dest,{signal:controller.signal}),/cancelled/);
  assert.ok((await fs.stat(archive)).isFile());
});
