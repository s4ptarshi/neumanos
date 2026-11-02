import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../functions/api/calendar/[name]';

const FEED_URL = 'https://feeds.example/calendar/work/basic.ics';
const OTHER_FEED_URL = 'https://feeds.example/calendar/other/basic.ics';
const CALENDAR = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

interface FetchInit extends RequestInit {
  cf?: {
    cacheEverything?: boolean;
    cacheTtlByStatus?: Record<string, number>;
  };
}

type FetchRespond = (
  input: RequestInfo | URL,
  init?: FetchInit,
) => Response | Promise<Response>;

interface ContextOptions {
  env?: Record<string, unknown>;
  params?: Record<string, string | string[]>;
}

function makeContext(request: Request, options: ContextOptions = {}) {
  return {
    request,
    params: options.params ?? { name: 'work' },
    env:
      options.env ??
      { GCAL_FEEDS: JSON.stringify({ work: FEED_URL, other: OTHER_FEED_URL }) },
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

function makeRequest(method = 'GET') {
  return new Request('https://dash.example/api/calendar/work', { method });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('calendar proxy', () => {
  it('proxies a known feed and replaces the upstream headers', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(CALENDAR, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'NID=secret; Path=/',
            'x-upstream': 'leak',
          },
        }),
    );

    const response = await onRequest(makeContext(makeRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(FEED_URL);
    expect(init?.method).toBe('GET');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CALENDAR);
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('x-upstream')).toBe(false);
  });

  it('returns 404 for an unknown feed name', async () => {
    const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

    const response = await onRequest(
      makeContext(makeRequest(), { params: { name: 'missing' } }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Unknown calendar');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not resolve inherited object names', async () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

      const response = await onRequest(
        makeContext(makeRequest(), { params: { name } }),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Unknown calendar');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid or repeated name params', async () => {
    const names: Array<string | string[]> = ['../x', 'a b', '', ['work']];

    for (const name of names) {
      const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

      const response = await onRequest(
        makeContext(makeRequest(), { params: { name } }),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Unknown calendar');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('returns 500 when the feed map is missing or malformed', async () => {
    const envs: Array<Record<string, unknown>> = [
      {},
      { GCAL_FEEDS: '{not json' },
      { GCAL_FEEDS: '{"work": "https://feeds.example/calendar/work/basic.ics"' },
      { GCAL_FEEDS: JSON.stringify([FEED_URL]) },
    ];

    for (const env of envs) {
      const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

      const response = await onRequest(makeContext(makeRequest(), { env }));

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toBe('Calendar feeds are not configured');
      expect(text).not.toContain('feeds.example');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('returns 404 for a non-https or invalid mapped value', async () => {
    const values = [
      'http://feeds.example/calendar/work/basic.ics',
      'javascript:alert(1)',
      'not a url',
      42,
    ];

    for (const value of values) {
      const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));
      const env = { GCAL_FEEDS: JSON.stringify({ work: value }) };

      const response = await onRequest(makeContext(makeRequest(), { env }));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Unknown calendar');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('returns 502 for an upstream error without leaking the feed URL', async () => {
    stubFetch(() => new Response('Forbidden', { status: 403 }));

    const response = await onRequest(makeContext(makeRequest()));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe('Calendar upstream error (403)');
    expect(text).not.toContain(FEED_URL);
    expect(text).not.toContain('feeds.example');
  });

  it('returns 502 when the upstream fetch rejects', async () => {
    stubFetch(() => {
      throw new Error(`connect failed for ${FEED_URL}`);
    });

    const response = await onRequest(makeContext(makeRequest()));

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toBe('Calendar upstream unavailable');
    expect(text).not.toContain('feeds.example');
  });

  it('rejects unsupported methods with 405 and an Allow header', async () => {
    const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

    const response = await onRequest(makeContext(makeRequest('POST')));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers HEAD with headers and no body', async () => {
    const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

    const response = await onRequest(makeContext(makeRequest('HEAD')));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  });

  it('asks the edge to cache successful upstream responses for 600 seconds', async () => {
    const fetchMock = stubFetch(() => new Response(CALENDAR, { status: 200 }));

    await onRequest(makeContext(makeRequest()));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.cf?.cacheTtlByStatus?.['200-299']).toBe(600);
    expect(init?.cf?.cacheEverything).toBe(true);
  });
});
