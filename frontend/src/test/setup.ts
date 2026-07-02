import '@testing-library/jest-dom/vitest';
import { vi, afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '../i18n';

// Tests assert against the English UI; pin the language deterministically so
// the configured default (zh) doesn't leak in via .env.
beforeEach(() => {
  i18n.changeLanguage('en');
});

afterEach(() => cleanup());

// AntD relies on matchMedia / ResizeObserver, absent in jsdom.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = ResizeObserverMock;

if (!window.matchMedia) {
  // no-op
}
