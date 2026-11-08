import { session, net } from 'electron';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { ForumMetadata } from '../../app/core/forum-metadata.mjs';
import { initialState, newGame } from '../../app/core/model.mjs';
import { applyForumMetadata } from '../../app/core/metadata.mjs';
import { sessionResponse } from '../../app/core/session-response.mjs';
import { checkLibraryUpdates } from '../../app/core/update-checker.mjs';
import { Store } from '../../app/core/store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Actual Chromium requests against a loopback server, with generated cookies in
// a separate in-memory session. No forum account or live network is involved.
export async function checkMetadataRedirects() {
  let foreignRequests = 0, threadRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/foreign') foreignRequests++;
    if (!request.headers.cookie?.includes('lc_fixture_auth=present')) { response.writeHead(403); response.end('Missing fixture cookie'); return; }
    const requested = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
    if (requested.pathname === '/updates') { response.writeHead(302,{Location:'/updates-data'+requested.search});response.end();return; }
    if (requested.pathname === '/updates-data') { response.setHeader('Content-Type','application/json');response.end(JSON.stringify({msg:{data:requested.searchParams.get('page')==='1'?[{thread_id:12345,title:'Canonical Game',version:'2.0',date:'no reliable timestamp'}]:[]}}));return; }
    if (request.url === '/image-header-check') { response.end(request.headers.referer === `http://127.0.0.1:${server.address().port}/` ? 'referrer-ok' : 'referrer-missing'); return; }
    if (request.url === '/threads/12345/') { threadRequests++;response.writeHead(301, { Location: '/threads/canonical-game.12345/', 'Set-Cookie': 'lc_fixture_hop=canonical; Path=/' }); response.end(); }
    else if (request.url === '/threads/98765/') { response.writeHead(302, { Location: `http://localhost:${server.address().port}/foreign` }); response.end(); }
    else if (request.url === '/threads/22222/') { response.writeHead(302, { Location: '/threads/22222/' }); response.end(); }
    else if (request.url === '/threads/33333/') { response.writeHead(301, { Location: '/threads/canonical-game.12345/' }); response.end(); }
    else if (request.url === '/threads/canonical-game.12345/' && !request.headers.cookie.includes('lc_fixture_hop=canonical')) { response.writeHead(403); response.end('Redirect cookie missing'); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<h1 class="p-title-value"><span class="label">Ren’Py</span> Canonical Game [v2.0] [Fixture Creator]</h1><div class="message-body">Fixture description</div>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, ses = session.fromPartition('metadata-redirect-fixture');
  try {
    await ses.cookies.set({ url: origin, name: 'lc_fixture_auth', value: 'present', httpOnly: true });
    const client = new ForumMetadata({ ...initialState().settings.site, origin }, (url, options) => sessionResponse(requestOptions => net.request(requestOptions), ses, url, options));
    const metadata = await client.thread(origin + '/threads/12345/');
    const state = initialState(), game = newGame({ id: 'local:fixture', origin, threadId: '', title: 'Local game', installedVersion: '1.0', installation: { root: '/fixture/game', version: '1.0' } });
    state.games.push(game); applyForumMetadata(state, game.id, metadata);
    assert.equal(game.threadId, '12345'); assert.equal(game.threadUrl, origin + '/threads/canonical-game.12345/'); assert.equal(game.title, 'Canonical Game'); assert.equal(game.latestVersion, '2.0'); assert.equal(game.installedVersion, '1.0');
    console.log('PASS native thread redirect retains session cookies and links without changing the installed release');
    await assert.rejects(client.thread(origin + '/threads/98765/'), /not allowed/); assert.equal(foreignRequests, 0);
    console.log('PASS native cross-origin thread redirect is rejected before fetching its destination');
    await assert.rejects(client.thread(origin + '/threads/22222/'), /too many/);
    console.log('PASS native redirect loops stop at the request limit');
    await assert.rejects(client.thread(origin + '/threads/33333/'), /different thread/);
    console.log('PASS native redirect to a different thread requires another confirmed match');
    const imageResponse = await sessionResponse(requestOptions => net.request(requestOptions), ses, origin + '/image-header-check', { headers: { Referer: origin + '/' } });
    assert.equal(await imageResponse.text(), 'referrer-ok');
    console.log('PASS native metadata transport sends the configured origin-only image referrer');
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lc-native-updates-'));
    try {
      const store=new Store(directory);await store.open();
      const site={...initialState().settings.site,origin,latestPath:'/updates?page={page}&search=stale-filter'};
      await store.update(data=>{
        data.settings.site=site;data.games.push(newGame({id:'local:update',origin,threadId:'12345',threadUrl:origin+'/threads/12345/',title:'Old title',installedVersion:'1.0',latestVersion:'1.0',versionVerifiedAt:Date.now(),installation:{root:'/fixture/installed',version:'1.0'}}));
        data.checkpoints[origin]={revision:2,head:['legacy anchor'],at:Date.now()-1000};
      });
      const updateClient=new ForumMetadata(site,(url,options)=>sessionResponse(requestOptions=>net.request(requestOptions),ses,url,options));
      let result=await checkLibraryUpdates({store,client:updateClient});assert.equal(result.error,'');assert.equal(result.updates,1);assert.equal(result.verified,1);assert.equal(result.mode,'feed');assert.equal(store.data.games[0].latestVersion,'2.0');assert.equal(store.data.games[0].installedVersion,'1.0');
      const persisted=JSON.parse(await fs.readFile(path.join(directory,'library.json'),'utf8'));assert.equal(persisted.games[0].latestVersion,'2.0');assert.equal(persisted.checkpoints[origin].revision,2);
      const previousThreadRequests=threadRequests;result=await checkLibraryUpdates({store,client:updateClient});assert.equal(result.verified,0);assert.equal(threadRequests,previousThreadRequests);assert.equal(store.data.games[0].threadUrl,origin+'/threads/canonical-game.12345/');
      console.log('PASS native feed checks follow canonical thread redirects, persist versions/checkpoints and skip unchanged game threads');
      const previousCheckpoint=structuredClone(store.data.checkpoints[origin]),lastChecked=store.data.scan.lastChecked;
      await ses.cookies.remove(origin,'lc_fixture_auth');result=await checkLibraryUpdates({store,client:updateClient});assert.match(result.error,/HTTP 403/);assert.deepEqual(store.data.checkpoints[origin],previousCheckpoint);assert.equal(store.data.scan.lastChecked,lastChecked);assert.equal(store.data.games[0].latestVersion,'2.0');
      console.log('PASS native expired-login update failure preserves the last successful result and checkpoint');
    } finally { await fs.rm(directory,{recursive:true,force:true}); }
  } finally { await ses.clearStorageData(); await new Promise(resolve => server.close(resolve)); }
}
