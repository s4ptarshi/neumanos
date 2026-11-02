import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/webdav/[[path]]';

const ALLOWED_ORIGIN = 'https://app.super-productivity.com';
const EXPOSED_HEADERS =
  'etag, oc-etag, last-modified, content-length, content-type, dav';

type FetchRespond = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function makeContext(request: Request) {
  return {
    request,
    params: {},
    env: {},
    data: {},
    functionPath: '',
    waitUntil() {},
    passThroughOnException() {},
    next: async () => new Response(),
  } as unknown as Parameters<typeof onRequest>[0];
}

function stubFetch(respond: FetchRespond) {
  const fetchMock = vi.fn(respond);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('webdav relay', () => {
  it('answers OPTIONS locally', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/super-productivity/', {
          method: 'OPTIONS',
        }),
      ),
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-expose-headers')).toBe(EXPOSED_HEADERS);
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization, content-type, depth, destination, overwrite, if-match, if-none-match',
    );
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
  });

  it('forwards PROPFIND to the fixed upstream with allowed headers only', async () => {
    const fetchMock = stubFetch(
      () => new Response('<d:multistatus/>', { status: 207 }),
    );

    const request = new Request(
      'https://dash.example/webdav/super-productivity/sync-data.json',
      {
        method: 'PROPFIND',
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
          Depth: '1',
          'Content-Type': 'application/xml',
          Cookie: 'session=secret',
          Origin: 'https://app.super-productivity.com',
        },
        body: '<d:propfind/>',
      },
    );

    const response = await onRequest(makeContext(request));

    expect(response.status).toBe(207);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      'https://seafile.rlp.net/seafdav/super-productivity/sync-data.json',
    );
    expect(init?.method).toBe('PROPFIND');
    expect(init?.redirect).toBe('manual');

    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get('authorization')).toBe('Basic dXNlcjpwYXNz');
    expect(sentHeaders.get('depth')).toBe('1');
    expect(sentHeaders.get('content-type')).toBe('application/xml');
    expect(sentHeaders.has('cookie')).toBe(false);
    expect(sentHeaders.has('origin')).toBe(false);
  });

  it('passes a 207 response through with CORS headers and no cookies', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response('<d:multistatus/>', {
          status: 207,
          headers: {
            'content-type': 'application/xml',
            etag: '"abc"',
            'set-cookie': 'seafile=s1; Path=/',
            'access-control-allow-origin': '*',
          },
        }),
    );

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/super-productivity/', {
          method: 'PROPFIND',
        }),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(207);
    expect(await response.text()).toBe('<d:multistatus/>');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-expose-headers')).toBe(EXPOSED_HEADERS);
    expect(response.headers.get('content-type')).toBe('application/xml');
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('forwards PUT with If-Match and the request body', async () => {
    const payload = '{"tasks":[]}';
    let sentBody = '';
    const fetchMock = stubFetch(async (_input, init) => {
      sentBody = await new Response(init?.body ?? null).text();
      return new Response(null, { status: 201, headers: { etag: '"1"' } });
    });

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/a/b.json', {
          method: 'PUT',
          headers: { 'If-Match': '"0"', 'Content-Type': 'application/json' },
          body: payload,
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(sentBody).toBe(payload);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('if-match')).toBe('"0"');
  });

  it('rewrites Destination for MOVE to the upstream path', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 201 }));

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/a/b.json', {
          method: 'MOVE',
          headers: {
            Destination: 'https://dash.example/webdav/a/b.json',
            Overwrite: 'T',
          },
        }),
      ),
    );

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('https://seafile.rlp.net/seafdav/a/b.json');
    expect(new Headers(init?.headers).get('destination')).toBe(
      'https://seafile.rlp.net/seafdav/a/b.json',
    );
  });

  it('rejects Destination on another origin or outside /webdav', async () => {
    for (const destination of [
      'https://evil.example/webdav/a/b.json',
      'https://dash.example/elsewhere/a/b.json',
    ]) {
      const fetchMock = stubFetch(() => new Response(null, { status: 201 }));

      const response = await onRequest(
        makeContext(
          new Request('https://dash.example/webdav/a/b.json', {
            method: 'MOVE',
            headers: { Destination: destination },
          }),
        ),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('never reaches an upstream path outside /seafdav via dot segments', async () => {
    for (const rawUrl of [
      'https://dash.example/webdav/../admin',
      'https://dash.example/webdav/%2e%2e/admin',
    ]) {
      const fetchMock = stubFetch(() => new Response('{}', { status: 200 }));

      const response = await onRequest(makeContext(new Request(rawUrl)));

      expect([400, 404]).toContain(response.status);
      if (fetchMock.mock.calls.length > 0) {
        expect(String(fetchMock.mock.calls[0]![0])).toMatch(
          /^https:\/\/seafile\.rlp\.net\/seafdav(\/|$)/,
        );
      }
    }
  });

  it('rejects unsupported methods with 405 and CORS headers', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/a/b.json', { method: 'POST' }),
      ),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('allow')).toBe(
      'GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, OPTIONS',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 with CORS headers when fetch rejects', async () => {
    stubFetch(() => {
      throw new Error('connect failed for https://seafile.rlp.net/seafdav/a/b.json');
    });

    const response = await onRequest(
      makeContext(new Request('https://dash.example/webdav/a/b.json')),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-expose-headers')).toBe(EXPOSED_HEADERS);
    const text = await response.text();
    expect(text).toBe('Upstream unavailable');
    expect(text).not.toContain('seafile');
  });

  it('passes an upstream 401 through with CORS headers', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response('Unauthorized', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="Seafile"' },
        }),
    );

    const response = await onRequest(
      makeContext(new Request('https://dash.example/webdav/a/b.json')),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Seafile"');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('rewrites an upstream Location to the local /webdav prefix', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://seafile.rlp.net/seafdav/x/' },
        }),
    );

    const response = await onRequest(
      makeContext(new Request('https://dash.example/webdav/x')),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://dash.example/webdav/x/');
  });

  it('handles an upstream 204 without a body', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    const response = await onRequest(
      makeContext(
        new Request('https://dash.example/webdav/a/b.json', { method: 'DELETE' }),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });
});
