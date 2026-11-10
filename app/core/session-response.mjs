// Electron fetch rejects manual redirects instead of exposing their responses.
// Use ClientRequest so each hop can be checked synchronously before following,
// while Chromium retains the session's cookies, proxy and certificate handling.
export function sessionResponse(createRequest, session, url, { signal, onRedirect, headers, maxBytes = 15_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let request, settled = false, finalUrl = url, redirects = 0;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const fail = error => { if (settled) return; settled = true; cleanup(); reject(error); request?.abort(); };
    const abort = () => fail(signal.reason || new DOMException('Request cancelled.', 'AbortError'));
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Only web metadata requests are supported.');
      request = createRequest({ url, method: 'GET', session, credentials: 'include', redirect: 'manual', ...(headers ? { headers } : {}) });
      request.on('error', fail);
      request.on('abort', () => fail(new Error('Metadata request was cancelled.')));
      request.on('redirect', (_status, _method, destination) => {
        try {
          if (++redirects > 5) throw new Error('The metadata request redirected too many times.');
          if (typeof onRedirect !== 'function') throw new Error('The metadata redirect could not be validated.');
          onRedirect(destination);
          finalUrl = destination;
          request.followRedirect();
        } catch (error) { fail(error); }
      });
      request.on('response', incoming => {
        let length = 0, ended = false; const chunks = [];
        incoming.on('error', fail);
        incoming.on('aborted', () => fail(new Error('Metadata response was interrupted.')));
        incoming.on('close', () => { if (!ended) fail(new Error('Metadata response was interrupted.')); });
        if (Number(incoming.headers['content-length']) > maxBytes) { fail(new Error('The metadata response was too large.')); return; }
        incoming.on('data', chunk => { if (settled) return; length += chunk.length; if (length > maxBytes) { fail(new Error('The metadata response was too large.')); return; } chunks.push(Buffer.from(chunk)); });
        incoming.on('end', () => {
          ended = true; if (settled) return;
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) if (value != null) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
            const response = new Response([204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers });
            Object.defineProperty(response, 'url', { value: finalUrl });
            settled = true; cleanup(); resolve(response);
          } catch (error) { fail(error); }
        });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else request.end();
    } catch (error) { fail(error); }
  });
}
