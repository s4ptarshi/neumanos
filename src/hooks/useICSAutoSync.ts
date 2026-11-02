/**
 * useICSAutoSync Hook
 *
 * Refreshes ICS calendar subscriptions in the background. Starts once the
 * persisted calendar store has hydrated, then refreshes on app load, when the
 * tab becomes visible again, when the browser comes back online, and on a one
 * minute interval. Subscriptions that are not due are skipped by the service.
 */

import { useEffect } from 'react';
import { useCalendarStore } from '../stores/useCalendarStore';
import { syncDueSubscriptions } from '../services/icsSubscriptionSync';

export function useICSAutoSync(): void {
  useEffect(() => {
    let started = false;
    let intervalId: number | undefined;
    let unsubscribeHydration: (() => void) | undefined;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncDueSubscriptions({ force: true });
      }
    };

    const handleOnline = () => {
      void syncDueSubscriptions({ force: true });
    };

    const start = () => {
      if (started) return;
      started = true;

      void syncDueSubscriptions({ force: true });
      intervalId = window.setInterval(() => {
        void syncDueSubscriptions();
      }, 60_000);

      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('online', handleOnline);
    };

    if (useCalendarStore.persist.hasHydrated()) {
      start();
    } else {
      unsubscribeHydration = useCalendarStore.persist.onFinishHydration(start);
    }

    return () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      unsubscribeHydration?.();
    };
  }, []);
}
