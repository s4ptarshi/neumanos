interface Env {
  GCAL_FEEDS?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOW = 'GET, HEAD';

const SUCCESS_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Cache-Control': 'private, max-age=300',
  'X-Content-Type-Options': 'nosniff',
};

function textResponse(status: number, body: string, allow?: string): Response {
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  if (allow !== undefined) {
    headers.set('Allow', allow);
  }
  return new Response(body, { status, headers });
}

function parseFeedMap(raw: string | undefined): Record<string, unknown> | null {
  if (raw === undefined) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function resolveFeed(feeds: Record<string, unknown>, name: string): URL | null {
  // hasOwn keeps inherited names such as constructor and __proto__ from matching.
  if (!Object.hasOwn(feeds, name)) {
    return null;
  }

  const value = feeds[name];
  if (typeof value !== 'string') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  return url.protocol === 'https:' ? url : null;
}

function isFeedName(name: string | string[]): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export const onRequest: PagesFunction<Env, 'name'> = async (context) => {
  const { request } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse(405, 'Method not allowed', ALLOW);
  }

  const name = context.params.name;
  if (!isFeedName(name)) {
    return textResponse(404, 'Unknown calendar');
  }

  const feeds = parseFeedMap(context.env?.GCAL_FEEDS);
  if (feeds === null) {
    return textResponse(500, 'Calendar feeds are not configured');
  }

  const feedUrl = resolveFeed(feeds, name);
  if (feedUrl === null) {
    return textResponse(404, 'Unknown calendar');
  }

  let upstream: Response;
  try {
    upstream = await fetch(feedUrl, {
      method: 'GET',
      headers: { accept: 'text/calendar' },
      redirect: 'follow',
      cf: {
        cacheTtlByStatus: { '200-299': 600, '400-599': 0 },
        cacheEverything: true,
      },
    });
  } catch {
    // The thrown message can contain the feed URL, so never surface it.
    return textResponse(502, 'Calendar upstream unavailable');
  }

  if (!upstream.ok) {
    return textResponse(502, `Calendar upstream error (${upstream.status})`);
  }

  const body = request.method === 'HEAD' ? null : upstream.body;
  return new Response(body, { status: 200, headers: new Headers(SUCCESS_HEADERS) });
};
