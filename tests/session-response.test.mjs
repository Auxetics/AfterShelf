import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { sessionResponse } from '../app/core/session-response.mjs';
import { ForumMetadata } from '../app/core/forum-metadata.mjs';
import { initialState } from '../app/core/model.mjs';

function requestFixture(run) {
  let request, options;
  return {
    create(input) {
      options = input; request = new EventEmitter(); request.aborted = false;
      request.abort = () => { request.aborted = true; request.emit('abort'); };
      request.end = () => queueMicrotask(() => run(request));
      return request;
    },
    get request() { return request; }, get options() { return options; }
  };
}
function incoming(headers = {}) { const stream = new PassThrough(); stream.headers = headers; stream.statusCode = 200; return stream; }

test('session metadata requests preserve session identity and reject oversized headers or streamed bodies',async()=>{
  const session = {}, header = requestFixture(request => { request.emit('response', incoming({ 'content-length': '99999999' })); });
  await assert.rejects(sessionResponse(input => header.create(input), session, 'https://forum.test/thread'), /too large/);
  assert.equal(header.options.session, session); assert.equal(header.options.credentials, 'include'); assert.equal(header.request.aborted, true);
  const stream = requestFixture(request => { const response = incoming(); request.emit('response', response); response.end('over limit'); });
  await assert.rejects(sessionResponse(input => stream.create(input), session, 'https://forum.test/thread', { maxBytes: 4 }), /too large/);assert.equal(stream.request.aborted,true);
});
test('session metadata cancellation and interrupted bodies reject without completing a partial response',async()=>{
  const controller = new AbortController();
  const cancelled = requestFixture(request => { const response = incoming(); request.emit('response', response); response.write('partial'); controller.abort(); });
  await assert.rejects(sessionResponse(input => cancelled.create(input), {}, 'https://forum.test/thread', { signal: controller.signal }), { name: 'AbortError' });assert.equal(cancelled.request.aborted, true);
  const interrupted = requestFixture(request => { const response = incoming(); request.emit('response', response); response.write('partial'); response.destroy(); });
  await assert.rejects(sessionResponse(input => interrupted.create(input), {}, 'https://forum.test/thread'), /interrupted/);
});
test('a cancelled cover redirect is nonfatal after thread metadata has loaded',async()=>{
  const site = initialState().settings.site;
  const client = new ForumMetadata(site, async url => {
    if (url.startsWith(site.origin)) return new Response('<h1 class="p-title-value">Fixture Game [v2.0]</h1><div class="message-body"><img class="bbImage" src="https://images.example.test/cover.png"></div>');
    throw new Error('Redirect was cancelled');
  });
  const metadata = await client.thread(site.origin+'/threads/12345/');
  assert.equal(metadata.threadId,'12345');assert.equal(metadata.latestVersion,'2.0');assert.equal(metadata.cover,undefined);assert.match(metadata.coverError,/cover could not be downloaded/);
});
