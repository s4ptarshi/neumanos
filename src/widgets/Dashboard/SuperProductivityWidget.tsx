/**
 * Super Productivity Widget
 *
 * Embeds the Super Productivity web app in an iframe and offers a button that
 * opens the native desktop or mobile app through its URL scheme.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BaseWidget } from './BaseWidget';
import type { WidgetComponentProps } from './WidgetRegistry';

// getSpAppUrl and navigateTo are exported for tests, so fast refresh cannot treat
// this module as components-only.
/* eslint-disable react-refresh/only-export-components */

export const SP_WEB_URL = 'https://app.super-productivity.com';

/** How long to wait for the page to leave before assuming the app did not open. */
const APP_LAUNCH_TIMEOUT_MS = 1500;

/**
 * Returns the native app deep link for the current platform.
 *
 * iPadOS reports a Macintosh user agent, so large touch screens are treated as
 * iPads before falling back to the desktop scheme.
 */
export function getSpAppUrl(ua: string, maxTouchPoints: number): string {
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);

  if (isAndroid || isIOS) {
    return 'com.super-productivity.app://today';
  }

  return 'superproductivity://today';
}

/** Navigates to a URL. The widget takes it as an optional prop so tests can swap it. */
export function navigateTo(url: string): void {
  window.location.href = url;
}

interface SuperProductivityWidgetProps extends WidgetComponentProps {
  /** Overrides native app navigation (used by tests). */
  navigate?: (url: string) => void;
}

export const SuperProductivityWidget: React.FC<SuperProductivityWidgetProps> = ({
  navigate = navigateTo,
}) => {
  const [showFallback, setShowFallback] = useState(false);
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLaunchTimer = useCallback(() => {
    if (launchTimer.current !== null) {
      clearTimeout(launchTimer.current);
      launchTimer.current = null;
    }
  }, []);

  useEffect(() => {
    // Leaving the page means the native app probably opened, so drop the check.
    const handleLeave = () => clearLaunchTimer();

    document.addEventListener('visibilitychange', handleLeave);
    window.addEventListener('blur', handleLeave);

    return () => {
      document.removeEventListener('visibilitychange', handleLeave);
      window.removeEventListener('blur', handleLeave);
      clearLaunchTimer();
    };
  }, [clearLaunchTimer]);

  const handleOpenApp = () => {
    clearLaunchTimer();
    setShowFallback(false);

    navigate(getSpAppUrl(navigator.userAgent, navigator.maxTouchPoints));

    launchTimer.current = setTimeout(() => {
      launchTimer.current = null;
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        setShowFallback(true);
      }
    }, APP_LAUNCH_TIMEOUT_MS);
  };

  return (
    <BaseWidget title="Super Productivity" icon="✅">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenApp}
            className="inline-flex min-h-[40px] items-center justify-center px-4 py-2 bg-accent-blue text-white text-sm font-medium rounded-button hover:bg-accent-blue-hover transition-all duration-standard ease-smooth"
          >
            Open app
          </button>
          <a
            href={SP_WEB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[40px] items-center justify-center px-4 py-2 bg-surface-light-elevated dark:bg-surface-dark text-text-light-primary dark:text-text-dark-primary text-sm font-medium rounded-button hover:bg-border-light dark:hover:bg-surface-dark-elevated transition-all duration-standard ease-smooth"
          >
            Open in new tab
          </a>
        </div>

        {showFallback && (
          <p role="status" className="text-xs text-text-light-secondary dark:text-text-dark-secondary shrink-0">
            The app didn&apos;t open.{' '}
            <a
              href={SP_WEB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline"
            >
              Open the web app
            </a>
          </p>
        )}

        {/*
          No sandbox: Super Productivity needs scripts, storage, and same-origin
          access to its own IndexedDB. No credentialless: it would wipe that
          storage on every reload.
        */}
        <iframe
          src={SP_WEB_URL}
          title="Super Productivity"
          loading="lazy"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write; fullscreen"
          className="w-full h-[560px] border-0 rounded-lg bg-white"
        />
      </div>
    </BaseWidget>
  );
};
