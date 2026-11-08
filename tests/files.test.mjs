import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archivePath, isInside } from '../app/core/files.mjs';
import { savePlan, transferSaves, externalCandidates } from '../app/core/saves.mjs';
import { Store, redact } from '../app/core/store.mjs';

async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-test-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
test('ZIP entry validation rejects traversal, Windows paths and device names', () => {
  for (const name of ['../outside', 'game/../../outside', '/absolute', 'C:/outside', 'game\\escape', 'game/NUL.txt', 'game/file:stream']) assert.throws(()=>archivePath('/tmp/staging',name), name);
  assert.equal(archivePath('/tmp/staging','game/saves/slot.save'),path.join(path.resolve('/tmp/staging'),'game','saves','slot.save'));
  assert.equal(isInside('/games/title','/games/title-other'),false);
});
test('RenPy update transfers saves and persistent state without old program files', async t=>{
  const root=await fixture(t), old=path.join(root,'old'), fresh=path.join(root,'new');
  await fs.mkdir(path.join(old,'game','saves'),{recursive:true});await fs.mkdir(path.join(fresh,'game'),{recursive:true});
  await fs.writeFile(path.join(old,'game','saves','slot.save'),'progress');await fs.writeFile(path.join(old,'game','saves','persistent'),'unlocks');
  await fs.writeFile(path.join(old,'game','script.rpy'),'OLD PROGRAM');await fs.writeFile(path.join(fresh,'game','script.rpy'),'NEW PROGRAM');
  const plan=await savePlan(old,'renpy');assert.equal(plan.local.length,2);
  assert.equal(await transferSaves(plan,old,fresh),2);
  assert.equal(await fs.readFile(path.join(fresh,'game','script.rpy'),'utf8'),'NEW PROGRAM');
  assert.equal(await fs.readFile(path.join(fresh,'game','saves','persistent'),'utf8'),'unlocks');
  assert.equal(await fs.readFile(path.join(old,'game','saves','slot.save'),'utf8'),'progress');
  await assert.rejects(transferSaves(plan,old,path.join(old,'inside')),/separate folder/);
});
test('no local saves follows external rules and metadata cannot escape expected locations', async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'game'));
  assert.equal((await savePlan(root,'renpy')).status,'expected-external/no-local-data');
  assert.deepEqual(externalCandidates('renpy',{identity:'../../another-game'}),[]);
  assert.deepEqual(externalCandidates('unity',{company:'x/../../',product:'y'}),[]);
});
test('save transfer does not follow symbolic links', async t=>{
  const root=await fixture(t), old=path.join(root,'old'), fresh=path.join(root,'new'), outside=path.join(root,'outside');
  await fs.mkdir(path.join(old,'game'),{recursive:true});await fs.mkdir(fresh);await fs.mkdir(outside);
  await fs.symlink(outside,path.join(old,'game','saves'));
  await assert.rejects(savePlan(old,'renpy'),/Symbolic links/);
});
test('cancelled transfer cannot delete originals or mark a job complete', async t=>{
  const root=await fixture(t), old=path.join(root,'old'), fresh=path.join(root,'new');
  await fs.mkdir(path.join(old,'save'),{recursive:true});await fs.mkdir(fresh);await fs.writeFile(path.join(old,'save','slot'),'original');
  const controller=new AbortController();controller.abort();
  await assert.rejects(transferSaves({local:[{source:path.join(old,'save','slot'),relative:'save/slot'}]},old,fresh,controller.signal));
  assert.equal(await fs.readFile(path.join(old,'save','slot'),'utf8'),'original');
});
test('library persists changes and restores completed archives as installable after interrupted updates', async t=>{
  const root=await fixture(t), first=new Store(root);await first.open();
  await first.update(state=>state.downloads.push({id:'job',status:'installing',path:'/archive.zip'}));
  const second=new Store(root);await second.open();assert.equal(second.data.downloads[0].status,'downloaded');
  assert.match(second.data.downloads[0].error,/not confirmed/);
});
test('diagnostics redact session tokens, signed URLs and home paths', ()=>{
  const output=redact('https://f95zone.to/dl/123/?k=SECRET&t=TOKEN\nCookie: xf_user=PRIVATE\n/Users/example/games/test');
  for(const secret of ['SECRET','TOKEN','PRIVATE','/Users/kyle'])assert.ok(!output.includes(secret));
});
