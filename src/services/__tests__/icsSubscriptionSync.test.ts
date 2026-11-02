/**
 * ICS Subscription Sync Service Tests
 *
 * Covers the scheduling rules (isSyncDue) and the fetch/parse/store path
 * (syncSubscription, syncDueSubscriptions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ICSSubscription } from '../../types';

// Mock logger so parser info logs stay out of test output
vi.mock('../logger', () => ({
  logger: {
    module: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { useCalendarStore } from '../../stores/useCalendarStore';
import {
  MIN_REFRESH_MS,
  isSyncDue,
  syncSubscription,
  syncDueSubscriptions,
  __resetICSSyncStateForTests,
} from '../icsSubscriptionSync';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//NeumanOS Test//EN',
  'BEGIN:VEVENT',
  'UID:test-event-1@example.com',
  'SUMMARY:Standup',
  'DTSTART:20261102T090000',
  'DTEND:20261102T091500',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function makeSub(overrides: Partial<ICSSubscription> = {}): ICSSubscription {
  return {
    id: 'sub-1',
    name: 'Work',
    url: '/api/calendar/work',
    color: '#06b6d4',
    autoSyncMinutes: 60,
    enabled: true,
    ...overrides,
  };
}

function makeResponse(body: string, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

describe('isSyncDue', () => {
  it('returns false for disabled subscriptions', () => {
    expect(isSyncDue(makeSub({ enabled: false }), NOW)).toBe(false);
  });

  it('returns false for manual-only subscriptions', () => {
    expect(isSyncDue(makeSub({ autoSyncMinutes: 0 }), NOW)).toBe(false);
    expect(isSyncDue(makeSub({ autoSyncMinutes: 0 }), NOW, { force: true })).toBe(false);
  });

  it('returns true when the subscription has never synced', () => {
    expect(isSyncDue(makeSub(), NOW)).toBe(true);
    expect(isSyncDue(makeSub(), NOW, { force: true })).toBe(true);
  });

  it('returns false before the interval has elapsed', () => {
    expect(isSyncDue(makeSub({ lastSyncedAt: minutesAgo(30) }), NOW)).toBe(false);
  });

  it('returns true once the interval has elapsed', () => {
    expect(isSyncDue(makeSub({ lastSyncedAt: minutesAgo(61) }), NOW)).toBe(true);
  });

  it('honours the minimum refresh gap when forced', () => {
    expect(isSyncDue(makeSub({ lastSyncedAt: minutesAgo(2) }), NOW, { force: true })).toBe(false);
    expect(isSyncDue(makeSub({ lastSyncedAt: minutesAgo(6) }), NOW, { force: true })).toBe(true);
  });

  it('blocks a due sync when the last attempt was under the minimum gap', () => {
    const sub = makeSub({ lastSyncedAt: minutesAgo(90) });
    expect(
      isSyncDue(sub, NOW, { lastAttemptAt: NOW - MIN_REFRESH_MS + 1 }),
    ).toBe(false);
  });

  it('allows a due sync when the last attempt was over the minimum gap', () => {
    const sub = makeSub({ lastSyncedAt: minutesAgo(90) });
    expect(
      isSyncDue(sub, NOW, { lastAttemptAt: NOW - MIN_REFRESH_MS }),
    ).toBe(true);
  });

  it('treats an unparseable lastSyncedAt as never synced', () => {
    const sub = makeSub({ lastSyncedAt: 'not-a-date' });
    expect(isSyncDue(sub, NOW)).toBe(true);
    expect(isSyncDue(sub, NOW, { force: true })).toBe(true);
  });
});

describe('syncSubscription', () => {
  beforeEach(() => {
    __resetICSSyncStateForTests();
    useCalendarStore.setState({ icsSubscriptions: [], events: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetICSSyncStateForTests();
  });

  it('fetches, parses, and stores events', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse(SAMPLE_ICS));

    const sub = makeSub();
    useCalendarStore.setState({ icsSubscriptions: [sub] });

    const result = await syncSubscription(sub);

    expect(result).toEqual({ ok: true, count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/calendar/work', { cache: 'no-store' });

    const state = useCalendarStore.getState();
    expect(state.events['2026-11-2']).toHaveLength(1);
    expect(state.events['2026-11-2'][0].title).toBe('Standup');
    expect(state.events['2026-11-2'][0].externalSource).toBe('sub-1');
    expect(state.icsSubscriptions[0].lastSyncedAt).toBeTruthy();
  });

  it('returns an error and leaves lastSyncedAt alone on HTTP 500', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse('nope', 500, 'Internal Server Error'));

    const lastSyncedAt = minutesAgo(30);
    useCalendarStore.setState({ icsSubscriptions: [makeSub({ lastSyncedAt })] });

    const result = await syncSubscription(makeSub({ lastSyncedAt }));

    expect(result).toEqual({ ok: false, error: 'HTTP 500 Internal Server Error' });
    expect(useCalendarStore.getState().icsSubscriptions[0].lastSyncedAt).toBe(lastSyncedAt);
    expect(useCalendarStore.getState().events).toEqual({});
  });

  it('returns an error instead of throwing when fetch rejects', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValue(new Error('Network down'));

    const sub = makeSub();
    useCalendarStore.setState({ icsSubscriptions: [sub] });

    await expect(syncSubscription(sub)).resolves.toEqual({ ok: false, error: 'Network down' });
  });

  it('returns a parse error for invalid ICS content', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse('not a calendar'));

    const sub = makeSub();
    useCalendarStore.setState({ icsSubscriptions: [sub] });

    await expect(syncSubscription(sub)).resolves.toEqual({
      ok: false,
      error: 'Invalid ICS file format',
    });
  });

  it('shares one request between concurrent calls for the same subscription', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse(SAMPLE_ICS));

    const sub = makeSub();
    useCalendarStore.setState({ icsSubscriptions: [sub] });

    const [first, second] = await Promise.all([
      syncSubscription(sub),
      syncSubscription(sub),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ ok: true, count: 1 });
    expect(second).toEqual({ ok: true, count: 1 });
  });
});

describe('syncDueSubscriptions', () => {
  beforeEach(() => {
    __resetICSSyncStateForTests();
    useCalendarStore.setState({ icsSubscriptions: [], events: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetICSSyncStateForTests();
  });

  it('syncs only subscriptions that are due', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse(SAMPLE_ICS));

    useCalendarStore.setState({
      icsSubscriptions: [
        makeSub({ id: 'sub-due', url: '/api/calendar/work', autoSyncMinutes: 60 }),
        makeSub({ id: 'sub-manual', url: '/api/calendar/manual', autoSyncMinutes: 0 }),
      ],
    });

    await syncDueSubscriptions({ now: NOW });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/calendar/work', { cache: 'no-store' });
  });

  it('does nothing when the browser is offline', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(makeResponse(SAMPLE_ICS));

    useCalendarStore.setState({
      icsSubscriptions: [makeSub({ id: 'sub-due', autoSyncMinutes: 60 })],
    });

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    await syncDueSubscriptions({ now: NOW });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
