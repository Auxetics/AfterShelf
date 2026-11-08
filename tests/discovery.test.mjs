import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverGames, localGame } from '../app/core/discovery.mjs';
import { initialState, offerInstallation } from '../app/core/model.mjs';
import { Store } from '../app/core/store.mjs';

async function fixture(t) { const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lc-discovery-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
async function file(root,relative,content='fixture') { const target=path.join(root,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content);return target; }

test('read-only discovery finds multiple games without importing their assets as games',async t=>{
  const root=await fixture(t);
  await file(root,'First-Game/launch.sh');await file(root,'First-Game/renpy/__init__.py');await file(root,'First-Game/game/saves/slot.save','progress');await file(root,'First-Game/game/assets/demo.html');
  await file(root,'Second-Game/www/js/rpg_core.js');await file(root,'Second-Game/Game.exe');await file(root,'.library/staging/Unfinished/Game.exe');
  const result=await discoverGames(root,{platform:'darwin'});
  assert.equal(result.candidates.length,2);assert.deepEqual(new Set(result.candidates.map(item=>item.engine)),new Set(['renpy','rpgmv']));
  assert.equal(await fs.readFile(path.join(root,'First-Game/game/saves/slot.save'),'utf8'),'progress');
  assert.equal(await fs.readFile(path.join(root,'Second-Game/Game.exe'),'utf8'),'fixture');
  assert.equal(result.candidates.find(item=>item.engine==='renpy').launch,path.join(root,'First-Game/launch.sh'));
});
test('macOS app bundles are one game, with a launchable package target',async t=>{
  const root=await fixture(t), bundle=path.join(root,'MyGame.app');
  await file(bundle,'Contents/Info.plist','<plist><key>CFBundleDisplayName</key><string>My Game</string></plist>');
  await file(bundle,'Contents/Resources/autorun/renpy/__init__.py');await file(bundle,'Contents/Resources/autorun/game/script.rpy');
  const result=await discoverGames(root,{platform:'darwin'});
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].engine,'renpy');assert.equal(result.candidates[0].launch,bundle);assert.equal(result.candidates[0].title,'My Game');
});
test('loose HTML and executable files in the chosen collection cannot hide extracted app bundles',async t=>{
  const root=await fixture(t);
  await file(root,'Unrelated utility.exe');await file(root,'Unrelated page.html','<title>Not a game</title>');
  for(const name of ['First.app','Second.app']) {
    await file(root,`${name}/Contents/Info.plist`,`<plist><key>CFBundleDisplayName</key><string>${name.slice(0,-4)}</string></plist>`);
    await file(root,`${name}/Contents/Resources/autorun/renpy/__init__.py`);
    await file(root,`${name}/Contents/Resources/autorun/game/saves/slot.save`,'existing progress');
  }
  const result=await discoverGames(root,{platform:'darwin'});
  assert.equal(result.candidates.length,2);assert.ok(result.candidates.every(item=>item.root!==root&&item.engine==='renpy'&&item.launch===item.root));
  assert.deepEqual(new Set(result.candidates.map(item=>path.basename(item.root))),new Set(['First.app','Second.app']));
  for(const item of result.candidates)assert.equal(await fs.readFile(path.join(item.root,'Contents/Resources/autorun/game/saves/slot.save'),'utf8'),'existing progress');
});
test('wrapper documentation cannot mask its app bundle and selecting the bundle itself still works',async t=>{
  const root=await fixture(t), bundle=path.join(root,'Extracted-release','Game.APP');
  await file(root,'Extracted-release/readme.html','<title>Instructions</title>');await file(root,'Extracted-release/helper.exe');
  await file(bundle,'Contents/Info.plist','<plist/>');await file(bundle,'Contents/Resources/autorun/renpy/__init__.py');
  const result=await discoverGames(root,{platform:'darwin'});assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].root,bundle);assert.equal(result.candidates[0].engine,'renpy');assert.equal(result.candidates[0].launch,bundle);
  const direct=await discoverGames(bundle,{platform:'darwin'});assert.equal(direct.candidates.length,1);assert.equal(direct.candidates[0].launch,bundle);
});
test('existing installations and directory symlinks are skipped',async t=>{
  const root=await fixture(t), outside=await fixture(t);await file(root,'Existing/Game.exe');await file(outside,'Linked/Game.exe');await fs.symlink(outside,path.join(root,'Shortcut'));
  const result=await discoverGames(root,{platform:'win32',existing:[path.join(root,'Existing')]});assert.equal(result.candidates.length,0);
});
test('cancelled and bounded scans do not claim to inspect everything',async t=>{
  const root=await fixture(t);for(let i=0;i<5;i++)await fs.mkdir(path.join(root,`folder${i}`));
  const result=await discoverGames(root,{maxDirectories:2});assert.equal(result.inspected,2);assert.match(result.warnings.join(' '),/Stopped/);
  const controller=new AbortController();controller.abort();await assert.rejects(discoverGames(root,{signal:controller.signal}),{name:'AbortError'});
});
test('HTML story format detection stays local and imported games do not invent a forum match',async t=>{
  const root=await fixture(t);await file(root,'Story/index.html','<tw-storydata format="SugarCube" name="Story"></tw-storydata>');
  const result=await discoverGames(root,{platform:'darwin'}), candidate=result.candidates[0];assert.equal(candidate.engine,'sugarcube');
  const game=localGame(candidate,'https://f95zone.to');assert.ok(game.id.startsWith('local:'));assert.equal(game.threadUrl,'');assert.equal(game.threadId,'');assert.equal(game.installation.managed,false);assert.equal(game.installation.root,candidate.root);
  assert.equal((await discoverGames(root,{platform:'darwin'})).candidates[0].id,candidate.id);
});
test('first run defaults to download-only and setup status persists without resetting the library',async t=>{
  const root=await fixture(t), store=new Store(root);await store.open();
  assert.equal(store.data.settings.setupCompleted,false);assert.equal(store.data.settings.downloadMode,'download-only');
  await store.update(state=>{state.settings.setupCompleted=true;state.settings.gamesRoot='/chosen/games';state.settings.downloadMode='assisted';state.games.push({id:'preserved'});});
  const reopened=new Store(root);await reopened.open();assert.equal(reopened.data.settings.setupCompleted,true);assert.equal(reopened.data.settings.downloadMode,'assisted');assert.equal(reopened.data.games[0].id,'preserved');
});
test('pre-setup libraries receive safe new defaults while retaining their folder and games',async t=>{
  const root=await fixture(t), old=initialState();delete old.settings.setupCompleted;delete old.settings.downloadMode;
  old.settings.gamesRoot='/existing/games';old.games=[{id:'existing'}];await fs.writeFile(path.join(root,'library.json'),JSON.stringify(old));
  const store=new Store(root);await store.open();assert.equal(store.data.settings.gamesRoot,'/existing/games');assert.equal(store.data.settings.setupCompleted,false);assert.equal(store.data.settings.downloadMode,'download-only');assert.equal(store.data.games.length,1);
});
test('installation offers require setup opt-in and a complete, associated download',()=>{
  const settings=initialState().settings, job={status:'downloaded',path:'/game.zip',gameId:'game'};
  assert.equal(offerInstallation(settings,job),false);settings.setupCompleted=true;assert.equal(offerInstallation(settings,job),false);
  settings.downloadMode='assisted';assert.equal(offerInstallation(settings,job),true);
  assert.equal(offerInstallation(settings,{...job,status:'failed'}),false);assert.equal(offerInstallation(settings,{...job,gameId:null}),false);
});
