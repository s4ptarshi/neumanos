import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SuperProductivityWidget, getSpAppUrl } from '../SuperProductivityWidget';
import { getWidget, getWidgetComponent } from '../WidgetRegistry';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';

const URL_CASES: Array<[string, string, number, string]> = [
  [
    'Android Chrome',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
    5,
    'com.super-productivity.app://today',
  ],
  [
    'iPhone Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    5,
    'com.super-productivity.app://today',
  ],
  ['iPadOS (reports Macintosh)', MAC_UA, 5, 'com.super-productivity.app://today'],
  ['macOS desktop', MAC_UA, 0, 'superproductivity://today'],
  [
    'Linux Firefox',
    'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
    0,
    'superproductivity://today',
  ],
  [
    'Windows Edge',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    0,
    'superproductivity://today',
  ],
];

describe('getSpAppUrl', () => {
  it.each(URL_CASES)('%s gets the right scheme', (_label, ua, maxTouchPoints, expected) => {
    expect(getSpAppUrl(ua, maxTouchPoints)).toBe(expected);
  });
});

describe('SuperProductivityWidget', () => {
  it('embeds the web app in an iframe without sandboxing', () => {
    const { container } = render(<SuperProductivityWidget />);

    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', 'https://app.super-productivity.com');
    expect(iframe).toHaveAttribute('title', 'Super Productivity');
    expect(iframe).not.toHaveAttribute('sandbox');
  });

  it('links to the web app in a new tab', () => {
    render(<SuperProductivityWidget />);

    const link = screen.getByRole('link', { name: 'Open in new tab' });
    expect(link).toHaveAttribute('href', 'https://app.super-productivity.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  describe('native app fallback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('offers the web app when the page stays focused', () => {
      const navigate = vi.fn();
      render(<SuperProductivityWidget navigate={navigate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
      expect(navigate).toHaveBeenCalledWith('superproductivity://today');

      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(screen.getByText(/The app didn't open/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open the web app' })).toHaveAttribute(
        'href',
        'https://app.super-productivity.com'
      );
    });

    it('stays quiet when the window loses focus', () => {
      const navigate = vi.fn();
      render(<SuperProductivityWidget navigate={navigate} />);

      fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      expect(screen.queryByText(/The app didn't open/)).not.toBeInTheDocument();
    });
  });

  it('is registered with a loadable component', () => {
    expect(getWidget('superproductivity')?.name).toBe('Super Productivity');
    expect(getWidgetComponent('superproductivity')).toBeDefined();
  });
});
