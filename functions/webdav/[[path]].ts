const UPSTREAM_ORIGIN = 'https://seafile.rlp.net';
const UPSTREAM_PREFIX = '/seafdav';
const LOCAL_PREFIX = '/webdav';
const ALLOWED_ORIGIN = 'https://app.super-productivity.com';

const FORWARDED_METHODS = [
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'PROPFIND',
  'MKCOL',
  'MOVE',
  'COPY',
];

const FORWARDED_REQUEST_HEADERS = [
  'authorization',
  'content-type',
  'content-length',
  'depth',
  'overwrite',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'range',
  'accept',
  'accept-encoding',
];

const ALLOW = [...FORWARDED_METHODS, 'OPTIONS'].join(', ');
const ALLOWED_REQUEST_HEADERS =
  'authorization, content-type, depth, destination, overwrite, if-match, if-none-match';
const EXPOSED_RESPONSE_HEADERS =
  'etag, oc-etag, last-modified, content-length, content-type, dav';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function isLocalPath(pathname: string): boolean {
  return pathname === LOCAL_PREFIX || pathname.startsWith(`${LOCAL_PREFIX}/`);
}

function isUpstreamPath(pathname: string): boolean {
  return pathname === UPSTREAM_PREFIX || pathname.startsWith(`${UPSTREAM_PREFIX}/`);
}

function toUpstreamUrl(localUrl: URL): URL | null {
  if (!isLocalPath(localUrl.pathname)) {
    return null;
  }

  // pathname is already percent-encoded, so slice it without decoding.
  const upstream = new URL(
    UPSTREAM_ORIGIN +
      UPSTREAM_PREFIX +
      localUrl.pathname.slice(LOCAL_PREFIX.length) +
      localUrl.search,
  );

  if (upstream.origin !== UPSTREAM_ORIGIN || !isUpstreamPath(upstream.pathname)) {
    return null;
  }
  return upstream;
}

function toUpstreamDestination(destination: string, localUrl: URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(destination, localUrl);
  } catch {
    return null;
  }

  if (parsed.origin !== localUrl.origin) {
    return null;
  }

  const upstream = toUpstreamUrl(parsed);
  return upstream === null ? null : upstream.toString();
}

function toClientLocation(location: string, localUrl: URL): string | null {
  let upstream: URL;
  try {
    upstream = new URL(location, UPSTREAM_ORIGIN);
  } catch {
    return null;
  }

  if (upstream.origin !== UPSTREAM_ORIGIN || !isUpstreamPath(upstream.pathname)) {
    return null;
  }

  const localPath = LOCAL_PREFIX + upstream.pathname.slice(UPSTREAM_PREFIX.length);
  return `${localUrl.origin}${localPath}${upstream.search}${upstream.hash}`;
}

function applyCors(headers: Headers): void {
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Expose-Headers', EXPOSED_RESPONSE_HEADERS);
}

function corsResponse(
  status: number,
  body: string | null,
  configure?: (headers: Headers) => void,
): Response {
  const headers = new Headers();
  applyCors(headers);
  configure?.(headers);
  return new Response(body, { status, headers });
}

function toClientResponse(upstreamResponse: Response, localUrl: URL): Response {
  const headers = new Headers(upstreamResponse.headers);

  // Do not leak Seafile session cookies to the dashboard origin.
  headers.delete('set-cookie');
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('access-control-')) {
      headers.delete(name);
    }
  }

  const location = headers.get('location');
  if (location !== null) {
    const rewritten = toClientLocation(location, localUrl);
    if (rewritten !== null) {
      headers.set('Location', rewritten);
    }
  }

  applyCors(headers);

  const body = NULL_BODY_STATUSES.has(upstreamResponse.status)
    ? null
    : upstreamResponse.body;

  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export const onRequest: PagesFunction = async (context) => {
  const { request } = context;
  const localUrl = new URL(request.url);

  if (!isLocalPath(localUrl.pathname)) {
    return corsResponse(404, 'Not found');
  }

  // Seafile answers preflight with 401 and sends no CORS headers, so the
  // browser would never send the real request. Answer OPTIONS here instead.
  if (request.method === 'OPTIONS') {
    return corsResponse(204, null, (headers) => {
      headers.set('Access-Control-Allow-Methods', ALLOW);
      headers.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
      headers.set('Access-Control-Max-Age', '86400');
    });
  }

  if (!FORWARDED_METHODS.includes(request.method)) {
    return corsResponse(405, 'Method not allowed', (headers) => {
      headers.set('Allow', ALLOW);
    });
  }

  const upstreamUrl = toUpstreamUrl(localUrl);
  if (upstreamUrl === null) {
    return corsResponse(400, 'Bad request');
  }

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  if (request.method === 'MOVE' || request.method === 'COPY') {
    const destination = request.headers.get('Destination');
    if (destination !== null) {
      const rewritten = toUpstreamDestination(destination, localUrl);
      if (rewritten === null) {
        return corsResponse(400, 'Bad request');
      }
      headers.set('Destination', rewritten);
    }
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      redirect: 'manual',
    });
  } catch {
    // The thrown message can contain the upstream URL, so never surface it.
    return corsResponse(502, 'Upstream unavailable');
  }

  return toClientResponse(upstreamResponse, localUrl);
};
