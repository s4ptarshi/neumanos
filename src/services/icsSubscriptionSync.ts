/**
 * ICS Subscription Sync Service
 * Fetches subscribed ICS calendars, parses them, and stores the events.
 * Also decides when a subscription is due for an automatic refresh so the
 * background hook and the manual refresh action share one code path.
 */

import type { ICSSubscription } from '../types';
import { importFromICS } from './icsImportExport';
import { useCalendarStore } from '../stores/useCalendarStore';
import { logger } from './logger';

const log = logger.module('ICSSync');

export type ICSSyncResult = { ok: true; count: number } | { ok: false; error: string };

/** Minimum gap between network attempts for one subscription. */
export const MIN_REFRESH_MS = 5 * 60_000;

/** In-flight syncs keyed by subscription id, so concurrent callers share one request. */
const inFlight = new Map<string, Promise<ICSSyncResult>>();

/** Last network attempt time keyed by subscription id, used to throttle retries. */
const lastAttempts = new Map<string, number>();

/**
 * Decide whether a subscription should sync now.
 * Manual-only subscriptions (autoSyncMinutes <= 0) and disabled ones never do.
 *
 * `force` is used on app load, tab visible, and browser online events: it still
 * honours the minimum refresh gap so those events cannot hammer the network.
 */
export function isSyncDue(
  sub: ICSSubscription,
  now: number,
  opts: { force?: boolean; lastAttemptAt?: number } = {},
): boolean {
  if (!sub.enabled || sub.autoSyncMinutes <= 0) return false;

  if (opts.lastAttemptAt !== undefined && now - opts.lastAttemptAt < MIN_REFRESH_MS) {
    return false;
  }

  const parsedLastSync = sub.lastSyncedAt ? Date.parse(sub.lastSyncedAt) : Number.NaN;
  const neverSynced = !Number.isFinite(parsedLastSync);

  if (opts.force) {
    return neverSynced || now - parsedLastSync >= MIN_REFRESH_MS;
  }

  if (neverSynced) return true;
  return now - parsedLastSync >= sub.autoSyncMinutes * 60_000;
}

/**
 * Fetch, parse, and store one subscription. Never throws.
 * Repeated calls for the same subscription while one is in flight share it.
 */
export function syncSubscription(sub: ICSSubscription): Promise<ICSSyncResult> {
  const existing = inFlight.get(sub.id);
  if (existing) return existing;

  const promise = runSync(sub).finally(() => {
    inFlight.delete(sub.id);
  });
  inFlight.set(sub.id, promise);
  return promise;
}

async function runSync(sub: ICSSubscription): Promise<ICSSyncResult> {
  lastAttempts.set(sub.id, Date.now());

  try {
    const response = await fetch(sub.url, { cache: 'no-store' });

    if (!response.ok) {
      const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      log.debug('Subscription fetch failed', { id: sub.id, status });
      return { ok: false, error: status };
    }

    const icsData = await response.text();
    const result = importFromICS(icsData);

    if (!result.success || !result.events) {
      return { ok: false, error: result.error || 'Parse failed' };
    }

    const count = useCalendarStore.getState().syncICSSubscription(sub.id, result.events);
    return { ok: true, count };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.debug('Subscription sync failed', { id: sub.id, message });
    return { ok: false, error: message };
  }
}

/**
 * Sync every subscription that is due. Runs in parallel and ignores results,
 * because background refreshes are not user-initiated.
 */
export async function syncDueSubscriptions(
  opts: { force?: boolean; now?: number } = {},
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const now = opts.now ?? Date.now();
  const due = useCalendarStore.getState().icsSubscriptions.filter((sub) =>
    isSyncDue(sub, now, { force: opts.force, lastAttemptAt: lastAttempts.get(sub.id) }),
  );

  await Promise.allSettled(due.map((sub) => syncSubscription(sub)));
}

/** Clear module state between tests. */
export function __resetICSSyncStateForTests(): void {
  inFlight.clear();
  lastAttempts.clear();
}
