import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureDownloadGame, importArchive } from '../app/core/downloads.mjs';
import { archiveTitle, isArchiveName } from '../app/core/archive-names.mjs';
import { initialState, newGame, canInstallArchive } from '../app/core/model.mjs';
import { discoverGames } from '../app/core/discovery.mjs';

const thread={origin:'https://f95zone.to',threadId:'12345',threadUrl:'https://f95zone.to/threads/example.12345/',title:'Example Game',engine:'renpy',latestVersion:'1.2'};
async function fixture(t) { const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lc-downloads-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }

test('a download from a new thread creates a first-install entry without claiming installation',()=>{
  const state=initialState(), game=ensureDownloadGame(state,{gameId:'unregistered',thread});
  assert.equal(state.games.length,1);assert.equal(game.title,'Example Game');assert.equal(game.engine,'renpy');assert.equal(game.latestVersion,'1.2');assert.equal(game.installedVersion,'');assert.equal(game.installation,null);
  assert.equal(ensureDownloadGame(state,{thread:{...thread,threadUrl:'https://f95zone.to/threads/renamed.12345/'}}),game);assert.equal(state.games.length,1);
});
test('thread identity reuses linked local installations and duplicate titles do not merge',()=>{
  const state=initialState();const existing=newGame({...thread,id:'local:linked',installation:{root:'/old/game',launch:'/old/game/run'},installedVersion:'1.0'});state.games.push(existing);
  assert.equal(ensureDownloadGame(state,{thread}),existing);assert.equal(state.games.length,1);assert.equal(existing.installation.root,'/old/game');
  const other=ensureDownloadGame(state,{gameId:existing.id,thread:{...thread,threadUrl:'https://f95zone.to/threads/example.98765/',threadId:'98765'}});
  assert.notEqual(other.id,existing.id);assert.equal(state.games.length,2);assert.equal(other.installation,null);
});
test('unattributed downloads can create games in an empty library without a forum URL',()=>{
  const state=initialState();assert.equal(ensureDownloadGame(state,{}),null);
  const game=ensureDownloadGame(state,{create:{title:'New Game',engine:'godot',version:'2'}});
  assert.ok(game.id.startsWith('download:'));assert.equal(game.threadUrl,'');assert.equal(game.engine,'godot');assert.equal(game.latestVersion,'2');assert.equal(game.installedVersion,'');assert.equal(game.installation,null);
  assert.equal(ensureDownloadGame(state,{gameId:game.id}),game);
  assert.throws(()=>ensureDownloadGame(state,{create:{title:''}}),/title/);
});
test('new-game association with an existing thread preserves the existing installation',()=>{
  const state=initialState(), existing=newGame({...thread,installation:{root:'/old'},installedVersion:'1.0'});state.games.push(existing);
  assert.equal(ensureDownloadGame(state,{create:{...thread,title:'User label'}}),existing);assert.equal(state.games.length,1);assert.equal(existing.installedVersion,'1.0');
  assert.throws(()=>ensureDownloadGame(state,{create:{...thread,threadUrl:'https://other.test/threads/other.12345/'}}),/different site/);
});
test('folder scan discovers fresh archives and repairs existing unassigned downloads without duplication',async t=>{
  const root=await fixture(t), state=initialState();
  const first=path.join(root,'First_Game.zip'), second=path.join(root,'Second_Game.7z');
  await fs.writeFile(first,'first compressed fixture');await fs.writeFile(second,'second compressed fixture');
  state.downloads.push({id:'download-existing',path:first,filename:path.basename(first),status:'downloaded',gameId:null,version:'1.0',archiveRemoved:false});
  const scan=await discoverGames(root,{downloads:state.downloads});assert.equal(scan.candidates.length,2);assert.ok(scan.candidates.every(item=>item.kind==='archive'));
  for(const candidate of scan.candidates)importArchive(state,candidate);
  assert.equal(state.games.length,2);assert.equal(state.downloads.length,2);assert.ok(state.games.every(game=>!game.installation&&!game.installedVersion));assert.ok(state.downloads.every(canInstallArchive));
  assert.equal(state.downloads.find(job=>job.id==='download-existing').version,'1.0');
  for(const candidate of scan.candidates)assert.equal(importArchive(state,candidate).added,false);
  assert.equal(state.games.length,2);assert.equal(state.downloads.length,2);
  assert.equal((await discoverGames(root,{downloads:state.downloads})).candidates.length,0);
  assert.equal(await fs.readFile(first,'utf8'),'first compressed fixture');assert.equal(await fs.readFile(second,'utf8'),'second compressed fixture');
});
test('archive discovery excludes incomplete downloads, symlinks and secondary multipart members',async t=>{
  const root=await fixture(t), outside=await fixture(t);await fs.writeFile(path.join(outside,'outside.zip'),'other');await fs.symlink(path.join(outside,'outside.zip'),path.join(root,'linked.zip'));
  const downloads=[];for(const status of ['downloading','failed','cancelled','installing','installed']) { const file=path.join(root,status+'.zip');await fs.writeFile(file,'partial');downloads.push({id:status,status,path:file}); }
  await fs.writeFile(path.join(root,'incomplete.zip.crdownload'),'partial');await fs.writeFile(path.join(root,'parts.part1.rar'),'first');await fs.writeFile(path.join(root,'parts.part2.rar'),'second');
  const scan=await discoverGames(root,{downloads});assert.deepEqual(scan.candidates.map(item=>item.filename),['parts.part1.rar']);
  const state=initialState();state.downloads.push({id:'downloading',path:'/partial.zip',status:'downloading'});assert.throws(()=>importArchive(state,{path:'/partial.zip',title:'Partial'}),/not completed/);assert.equal(state.games.length,0);
});
test('archive import uses retained thread context when available',()=>{
  const state=initialState();state.downloads.push({id:'existing',path:'/game.zip',status:'downloaded',thread,gameId:null});
  const result=importArchive(state,{downloadId:'existing',path:'/game.zip',title:'Ambiguous filename',engine:'custom'});
  assert.equal(state.games[0].threadId,'12345');assert.equal(state.games[0].engine,'renpy');assert.equal(state.games[0].title,'Example Game');assert.equal(result.job.gameId,state.games[0].id);
});
test('archive display names are suggestions and supported archive names exclude partial suffixes',()=>{
  assert.equal(archiveTitle('A_Game.part1.rar'),'A Game');assert.equal(archiveTitle('Story.tar.gz'),'Story');assert.equal(archiveTitle('Game.7z.001'),'Game');
  assert.equal(isArchiveName('Game.7z.001'),true);assert.equal(isArchiveName('Game.7z.002'),false);assert.equal(isArchiveName('Game.zip.part'),false);
});
