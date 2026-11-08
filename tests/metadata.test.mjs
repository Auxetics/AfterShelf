import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readLocalMetadata, applyLocalMetadata, applyForumMetadata } from '../app/core/metadata.mjs';
import { ForumMetadata, searchUrl } from '../app/core/forum-metadata.mjs';
import { initialState, newGame, hasUpdate } from '../app/core/model.mjs';
import { parseThread, imageReference } from '../app/core/site.mjs';
import { dismissDownloads } from '../app/core/downloads.mjs';

const site=initialState().settings.site;
async function fixture(t) { const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'lc-metadata-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
async function file(root,relative,text) { const target=path.join(root,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);return target; }
const threadHtml='<h1 class="p-title-value"><span class="label">Ren’Py</span> Example [v2.0] [Creator]</h1><div class="message-body">Developer: Creator<br>Version: 2.0<br>Story description<img class="bbImage" data-src="https://images.example.test/cover.png?token=private"></div>';
const ref={origin:site.origin,threadId:'12345',threadUrl:site.origin+'/threads/example.12345/'};

test('RenPy source release overrides bundle version without using SDK/script version or executing expressions',async t=>{
  const root=await fixture(t), bundle=path.join(root,'Game.app');
  await file(bundle,'Contents/Info.plist','<plist><dict><key>CFBundleDisplayName</key><string>Example &amp; Friends</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>2026.1101.221349</string></dict></plist>');
  await file(bundle,'Contents/Resources/autorun/game/options.rpy','define config.name = _("Example Game")\ndefine config.version = "0.1.5a"\n');
  await file(bundle,'Contents/Resources/autorun/game/script_version.txt','(8, 4, 1)');
  const result=await readLocalMetadata(bundle,'renpy');assert.equal(result.version,'0.1.5a');assert.equal(result.title,'Example Game');assert.match(result.versionSource,/config.version/);
  await file(bundle,'Contents/Resources/autorun/game/options.rpy','define config.version = "99" + unknown_function()');
  assert.equal((await readLocalMetadata(bundle,'renpy')).version,'1.0');
});
test('compiled-only RenPy apps retain the exact bundle release and build timestamps are not releases',async t=>{
  const root=await fixture(t), bundle=path.join(root,'Game.app');
  const plist=version=>`<plist><dict><key>CFBundleDisplayName</key><string>The Game</string>${version?'<key>CFBundleShortVersionString</key><string>'+version+'</string>':''}<key>CFBundleVersion</key><string>2026.0801.195638</string></dict></plist>`;
  await file(bundle,'Contents/Info.plist',plist('01551'));await file(bundle,'Contents/Resources/autorun/game/options.rpyc','not deserialized');
  let result=await readLocalMetadata(bundle,'renpy');assert.equal(result.version,'01551');assert.match(result.versionSource,/CFBundleShortVersionString/);
  await file(bundle,'Contents/Info.plist',plist(''));result=await readLocalMetadata(bundle,'renpy');assert.equal(result.version,'');assert.equal(hasUpdate({installedVersion:'Unspecified',latestVersion:'2.0'}),false);
});
test('local metadata does not follow links or replace manual installed-version choices',async t=>{
  const root=await fixture(t), outside=await fixture(t);await file(outside,'options.rpy','define config.version = "9.0"');await fs.mkdir(path.join(root,'game'));await fs.symlink(path.join(outside,'options.rpy'),path.join(root,'game/options.rpy'));
  const result=await readLocalMetadata(root,'renpy');assert.equal(result.version,'');assert.ok(result.warnings.length);
  const game={installation:{version:'1.0'},installedVersion:'1.0',installedVersionSource:'manual'};
  applyLocalMetadata(game,{version:'2.0',versionSource:'config.version'});assert.equal(game.installedVersion,'1.0');
  game.installedVersionSource='config.version';applyLocalMetadata(game,{version:'2.0',versionSource:'config.version'});assert.equal(game.installedVersion,'2.0');
});
test('linking forum details preserves installed release, local identity and saves while merging pending duplicates',()=>{
  const state=initialState(), game=newGame({...ref,id:'local:stable',title:'Local',engine:'renpy',installation:{root:'/installed',launch:'/installed/Game.app',version:'1.0'},installedVersion:'1.0',saveOverrides:['/saves']});
  state.games.push(game,newGame({...ref,title:'Pending'}));state.downloads.push({id:'download',gameId:state.games[1].id,status:'downloaded'});
  applyForumMetadata(state,game.id,{...ref,title:'Forum title',engine:'custom',latestVersion:'2.0',cover:'data:image/png;base64,AA==',installation:{root:'/evil'}});
  assert.equal(state.games.length,1);assert.equal(game.id,'local:stable');assert.equal(game.engine,'renpy');assert.equal(game.installedVersion,'1.0');assert.equal(game.installation.root,'/installed');assert.deepEqual(game.saveOverrides,['/saves']);assert.equal(state.downloads[0].gameId,game.id);assert.equal(hasUpdate(game),true);
});
test('linking refuses to overwrite a different installed game',()=>{
  const state=initialState(), first=newGame({...ref,id:'local:first',installation:{root:'/first'}}), second=newGame({...ref,id:'local:second',installation:{root:'/second'}});state.games.push(first,second);
  const before=structuredClone(state);assert.throws(()=>applyForumMetadata(state,first.id,ref),/another installed game/);assert.deepEqual(state,before);
});
test('forum search uses title filtering and returns distinct candidate thread IDs for review',async()=>{
  const urls=[], client=new ForumMetadata(site,async url=>{urls.push(url);return Response.json({msg:{data:[{thread_id:7,title:'Other Game',version:'3',creator:'One'},{thread_id:8,title:'The Example',version:'2',creator:'Two'},{thread_id:9,title:'The Example',version:'1',creator:'Three'}]}});});
  const results=await client.search('The Example');assert.equal(new URL(urls[0]).searchParams.get('search'),'example');assert.equal(new URL(urls[0]).searchParams.has('title'),false);assert.equal(results.length,2);assert.deepEqual(results.map(row=>row.threadId),['8','9']);assert.equal(results[0].latestVersion,'2');assert.equal(results[0].threadUrl,site.origin+'/threads/8/');
  assert.throws(()=>searchUrl({...site,latestPath:'https://other.test/feed'},'Game'),/configured forum/);
});
test('Guitar Crush search uses the endpoint search field rather than receiving its unfiltered listing',async()=>{
  let requested='';
  const client=new ForumMetadata(site,async url=>{
    const params=new URL(url).searchParams;requested=params.get('search');
    return Response.json({data:requested==='guitar crush'?[{id:1,title:'Guitar Crush',version:'0.1.5a'}]:[{id:2,title:'Unrelated popular game'}]});
  });
  const rows=await client.search('Guitar Crush');assert.equal(requested,'guitar crush');assert.equal(rows.length,1);assert.equal(rows[0].threadId,'1');assert.equal(rows[0].exact,true);
});
test('unrelated feed rows never become title matches even if the server ignores the filter',async()=>{
  let requests=0;
  const ignored=Array.from({length:100},(_,i)=>({id:i+1,title:i%2?'Summer Crush':'Guitar Lessons'}));
  const client=new ForumMetadata(site,async()=>{requests++;return Response.json({data:ignored});});
  assert.deepEqual(await client.search('Guitar Crush'),[]);assert.equal(requests,2,'repeated unfiltered pages do not keep paginating');
});
test('title matching keeps complete query terms, punctuation and compact names while ranking exact titles first',async()=>{
  const client=new ForumMetadata(site,async()=>Response.json({data:[
    {id:1,title:'Crush'},{id:2,title:'Guitar Lessons'},{id:3,title:'My Guitar Crush Deluxe'},{id:4,title:'Guitar-Crush [v0.1.5a] [Creator]'},{id:5,title:'GuitarCrush'},{id:6,title:'Summer Crush'},
  ]}));
  const rows=await client.search('Guitar Crush');assert.deepEqual(rows.map(row=>row.threadId),['4','5','3']);assert.ok(rows.slice(0,2).every(row=>row.exact));
  const url=new URL(searchUrl({...site,latestPath:site.latestPath+'&title=old&creator=wrong'},'Guitar Crush'));assert.equal(url.searchParams.get('search'),'guitar crush');assert.equal(url.searchParams.has('creator'),false);assert.equal(url.searchParams.has('title'),false);
});
test('thread refresh parses details and caches a supported cover without storing its signed URL',async()=>{
  const urls=[], client=new ForumMetadata(site,async url=>{urls.push(url);return url.startsWith(site.origin)?new Response(threadHtml):new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});}, buffer=>{assert.equal(buffer.length,3);return 'data:image/png;base64,AQID';});
  const result=await client.thread(ref.threadUrl);assert.equal(result.title,'Example');assert.equal(result.latestVersion,'2.0');assert.equal(result.creator,'Creator');assert.equal(result.cover,'data:image/png;base64,AQID');assert.equal(result.coverUrl,undefined);assert.equal(urls.length,2);assert.equal(result.installedVersion,undefined);
});
test('cover failures preserve thread metadata; login pages and unsafe redirects report useful errors',async()=>{
  const client=new ForumMetadata(site,async url=>url.startsWith(site.origin)?new Response(threadHtml):new Response('not image',{headers:{'content-type':'text/html'}}));
  const result=await client.thread(ref.threadUrl);assert.equal(result.latestVersion,'2.0');assert.match(result.coverError,/cover/);
  const login=new ForumMetadata(site,async()=>new Response('<title>Just a moment</title>'));await assert.rejects(login.thread(ref.threadUrl),/sign in/);
  const redirect=new ForumMetadata(site,async()=>new Response(null,{status:302,headers:{location:'https://other.test/login'}}));await assert.rejects(redirect.thread(ref.threadUrl),/not allowed/);
  const oversized=new ForumMetadata(site,async()=>new Response('too large',{headers:{'content-length':'99999999'}}));await assert.rejects(oversized.thread(ref.threadUrl),/too large/);
});
test('cover references reject local schemes, credentials and IP literals; body image precedes social logo',()=>{
  for(const url of ['', 'file:///tmp/image.png','data:image/svg+xml,<svg/>','https://127.0.0.1/a','https://localhost/a','https://[::1]/a','https://name:password@example.test/a'])assert.equal(imageReference(url,site.origin),'');
  const result=parseThread('<meta property="og:image" content="https://forum.example.test/logo.png">'+threadHtml,ref.threadUrl,site.origin);assert.ok(result.coverUrl.startsWith('https://images.example.test/'));
});
test('dismissing downloads clears records while preserving archives, installations and active work',async t=>{
  const root=await fixture(t), archive=await file(root,'game.zip','keep archive'), state=initialState();
  state.games.push({id:'game',installation:{root:'/existing'}});state.downloads.push({id:'done',status:'downloaded',path:archive},{id:'installed',status:'installed'},{id:'active',status:'downloading'});
  const before=structuredClone(state);assert.throws(()=>dismissDownloads(state,['done','active']),/active/);assert.deepEqual(state,before);
  assert.equal(dismissDownloads(state,['done','installed']),2);assert.equal(state.downloads[0].id,'active');assert.equal(state.games[0].installation.root,'/existing');assert.equal(await fs.readFile(archive,'utf8'),'keep archive');
});
