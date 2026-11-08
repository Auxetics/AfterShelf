import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseThread } from '../app/core/site.mjs';
import { ForumMetadata } from '../app/core/forum-metadata.mjs';
import { Store } from '../app/core/store.mjs';
import { initialState } from '../app/core/model.mjs';

const site=initialState().settings.site, url=site.origin+'/threads/music-story.12345/';
const phrases='{ "lightbox_close": "Close", "lightbox_next": "Next", "lightbox_error": "The requested content cannot be loaded." }';
const html=`<h1 class="p-title-value"><span class="label">Ren’Py</span><span class="label">Completed</span> Music Story [v0.1.5a] [Studio]</h1>
<div class="bbWrapper"><script type="application/json">${phrases}</script><img src="https://forum.example.test/logo.png"></div>
<article class="message--post"><div class="message-body">Quoted reply: Developer: Wrong Creator</div></article>
<article class="message--post message-threadStarterPost"><div class="message-body"><div class="bbWrapper">
<script type="application/json">${phrases}</script><style>.example {color:red}</style><template>Hidden widget text</template>
<blockquote>Developer: Quoted creator<br>Version: 99</blockquote><b>Overview:</b><br>A story about music and friendship.<br><br>
<b>Developer:</b> Studio<br><b>Engine:</b> Ren'Py<br><b>Version:</b> 0.1.5a<br>
<span class="bbImageWrapper js-lbImage" data-src="https://images.example.test/first.jpg?secret=signed"><img src="data:image/gif;base64,AA==" data-original="https://images.example.test/backup.png"></span>
</div><button>Unrelated controls</button></div></article>`;

test('starter post overview and fields exclude lightbox JSON, quoted replies and hidden widgets',()=>{
  const metadata=parseThread(html,url,site.origin);
  assert.equal(metadata.title,'Music Story');assert.equal(metadata.engine,'renpy');assert.equal(metadata.latestVersion,'0.1.5a');assert.equal(metadata.creator,'Studio');assert.equal(metadata.description,'A story about music and friendship.');
  assert.ok(metadata.tags.includes('Completed'));assert.ok(!metadata.description.includes('lightbox_'));assert.ok(!metadata.description.includes('Wrong Creator'));
  assert.equal(metadata.coverCandidates[0],'https://images.example.test/first.jpg?secret=signed');assert.ok(metadata.coverCandidates.includes('https://images.example.test/backup.png'));assert.ok(!metadata.coverCandidates.some(value=>value.includes('forum.example.test/logo')));
});
test('lazy srcsets and linked attachments resolve against the final canonical thread URL',async()=>{
  const canonical=site.origin+'/threads/canonical-title.12345/',requested=[];
  const text='<h1 class="p-title-value">Game [v1.0]</h1><div class="message-body"><picture><source data-srcset="small.webp 320w, large.webp 1024w"></picture><a href="/attachments/game-cover.999/">Cover</a><p>Real overview.</p></div>';
  const client=new ForumMetadata(site,async target=>{
    requested.push(target);
    if(target===url){const response=new Response(text);Object.defineProperty(response,'url',{value:canonical});return response;}
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/webp'}});
  },()=> 'data:image/png;base64,AQID');
  const metadata=await client.thread(url);assert.equal(metadata.threadUrl,canonical);assert.equal(requested[1],canonical+'large.webp');assert.equal(metadata.coverStatus,'cached');
  const parsed=parseThread(text,canonical,site.origin);assert.ok(parsed.coverCandidates.includes(site.origin+'/attachments/game-cover.999/'));
});
test('cover fallback tries another candidate with an origin-only referrer and drops signed image URLs',async()=>{
  const requested=[];
  const client=new ForumMetadata(site,async(target,options)=>{
    requested.push(target);
    if(target===url)return new Response(html);
    assert.equal(options.headers.Referer,site.origin+'/');
    if(target.includes('first.jpg'))return new Response('host refused',{status:403});
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
  },()=> 'data:image/png;base64,AQID');
  const metadata=await client.thread(url);assert.equal(requested.length,3);assert.equal(metadata.cover,'data:image/png;base64,AQID');assert.equal(metadata.coverStatus,'cached');assert.equal(metadata.coverError,'');assert.equal(metadata.coverCandidates,undefined);assert.equal(metadata.coverUrl,undefined);
  assert.ok(!JSON.stringify(metadata).includes('secret=signed'));
});
test('cover failures and missing image candidates retain clean metadata and report a visible reason',async()=>{
  const client=new ForumMetadata(site,async target=>target===url?new Response(html):new Response('denied',{status:403}));
  const result=await client.thread(url);assert.equal(result.coverStatus,'failed');assert.match(result.coverError,/HTTP 403/);assert.equal(result.description,'A story about music and friendship.');
  const missing=await client.withCover({title:'Example',threadId:'12345'});assert.equal(missing.coverStatus,'not-found');assert.match(missing.coverError,/No supported cover image/);
});
test('existing libraries discard cached lightbox JSON while preserving the installation and thread link',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lc-description-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=initialState();state.games.push({id:'local:game',description:phrases,threadId:'12345',installedVersion:'1.0',installation:{root:'/existing'}});
  await fs.writeFile(path.join(root,'library.json'),JSON.stringify(state));
  const store=new Store(root);await store.open();const game=store.data.games[0];assert.equal(game.description,'');assert.equal(game.metadataNeedsRefresh,true);assert.equal(game.installedVersion,'1.0');assert.equal(game.threadId,'12345');assert.equal(game.installation.root,'/existing');
});
