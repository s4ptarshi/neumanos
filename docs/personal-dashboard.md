# Personal dashboard setup

This fork adds three things to NeumanOS: a Google Calendar proxy, a WebDAV relay for Super Productivity sync, and a Super Productivity widget. It runs on Cloudflare Pages with Pages Functions.

## Deploy

```bash
npm run build
npx wrangler pages deploy --branch main
```

`wrangler.toml` sets the project name (`dashboard`) and the output folder (`dist`). Functions live in `functions/`.

## Google Calendar proxy

`GET /api/calendar/<name>` fetches one Google iCal feed on the server and returns it as `text/calendar`. Google sends no CORS headers, so the browser can't fetch the feed directly.

The feeds come from the `GCAL_FEEDS` secret, a JSON object that maps short names to secret iCal URLs:

```json
{"work":"https://calendar.google.com/calendar/ical/<id>/private-<key>/basic.ics"}
```

Set it with `npx wrangler pages secret put GCAL_FEEDS`, or in the Cloudflare dashboard. Never commit it. For local testing, put it in `.dev.vars` (ignored by git).

Unknown names return 404. Only `https` URLs are fetched. Feeds are cached at the edge for about 10 minutes.

In NeumanOS, go to Settings, then Calendar Management, then Subscribe to URL, and add `https://<site>/api/calendar/<name>` for each calendar. Subscriptions with an auto-sync interval above 0 refresh on app load, when the tab becomes visible again, and on their interval. Each one refetches at most every 5 minutes.

## WebDAV relay

`/webdav/<path>` is forwarded to `https://seafile.rlp.net/seafdav/<path>`. Seafile sends no CORS headers, so the Super Productivity web app can't sync to it from a browser. The relay answers CORS preflight itself and only allows `https://app.super-productivity.com`. Seafile's Basic auth still protects every request, and the relay doesn't log it.

Super Productivity setup inside the dashboard widget:

- Base URL: `https://<site>/webdav/`
- Username: your Seafile login name
- Password: the WebDAV access code from Seafile settings (not your login password)
- Sync folder: the folder path after `/seafdav/`
- Turn on encryption

The desktop app is not affected by CORS. Point it at `https://seafile.rlp.net/seafdav/` directly.

To switch WebDAV servers, change `UPSTREAM_ORIGIN` and `UPSTREAM_PREFIX` in `functions/webdav/[[path]].ts`.

## Super Productivity widget

The widget embeds `https://app.super-productivity.com`. "Open app" tries `com.super-productivity.app://today` on iOS, iPadOS and Android, and `superproductivity://today` on desktops. If the app doesn't open, the widget shows a link to the web app.

The iframe needs `frame-src https://app.super-productivity.com` in `public/_headers`. The `Cross-Origin-Embedder-Policy` header was removed so the iframe can load in Chrome and Firefox. Phantom Shell needs that header, so it no longer works.

## Cloudflare Access

Put the whole site behind Cloudflare Access, with a bypass for `/webdav/*`. The embedded Super Productivity app calls the relay from another site, and browsers won't send the Access cookie with those requests.
